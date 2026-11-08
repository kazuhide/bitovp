// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "frame_conformer.hpp"
#include <cuda_runtime.h>
#include <algorithm>
#include <array>
#include <stdexcept>

namespace bitovp::gpu {
namespace {
void check(cudaError_t code, const char *op) {
    if (code != cudaSuccess) throw std::runtime_error(std::string(op) + ": " + cudaGetErrorString(code));
}
struct DeviceScope {
    int previous;
    explicit DeviceScope(int device) {
        check(cudaGetDevice(&previous), "read conformer device");
        check(cudaSetDevice(device), "select conformer device");
    }
    ~DeviceScope() { cudaSetDevice(previous); }
};
template <class Source, class Destination>
__global__ void deinterleave(const Source *y, std::size_t y_stride,
    const Source *uv, std::size_t uv_stride, Destination *oy,
    Destination *ou, Destination *ov, unsigned width, unsigned height,
    unsigned source_shift, unsigned output_shift) {
    const std::size_t index = blockIdx.x * blockDim.x + threadIdx.x;
    const std::size_t step = std::size_t(blockDim.x) * gridDim.x;
    for (std::size_t i = index; i < std::size_t(width) * height; i += step)
        oy[i] = Destination((unsigned(y[(i / width) * y_stride + i % width]) >> source_shift) << output_shift);
    const unsigned cw = (width + 1) / 2, ch = (height + 1) / 2;
    for (std::size_t i = index; i < std::size_t(cw) * ch; i += step) {
        const auto offset = (i / cw) * uv_stride + (i % cw) * 2;
        ou[i] = Destination((unsigned(uv[offset]) >> source_shift) << output_shift);
        ov[i] = Destination((unsigned(uv[offset + 1]) >> source_shift) << output_shift);
    }
}
}
struct CudaFrameConformer::Impl {
    unsigned width, height, bits;
    int device;
    std::array<void *, 3> output{};
    cudaStream_t stream = nullptr;
    cudaEvent_t producer_ready = nullptr;
    Impl(unsigned w, unsigned h, unsigned b, int d) : width(w), height(h), bits(b), device(d) {
        if (!w || !h || w > 16384 || h > 16384 || (b != 8 && b != 10) || d < 0)
            throw std::invalid_argument("Invalid CUDA conformer geometry, precision or device");
        DeviceScope scope(device);
        try {
            check(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking), "create conformer stream");
            check(cudaEventCreateWithFlags(&producer_ready, cudaEventDisableTiming), "create decoder fence");
            for (unsigned p = 0; p < 3; ++p)
                check(cudaMalloc(&output[p], std::size_t(p ? (w + 1) / 2 : w) *
                    (p ? (h + 1) / 2 : h) * (b == 8 ? 1 : 2)), "allocate resident comparison plane");
        } catch (...) { close(); throw; }
    }
    void close() {
        if (stream) cudaStreamSynchronize(stream);
        for (auto pointer : output) if (pointer) cudaFree(pointer);
        if (producer_ready) cudaEventDestroy(producer_ready);
        if (stream) cudaStreamDestroy(stream);
    }
    ~Impl() {
        int previous = -1;
        cudaGetDevice(&previous);
        cudaSetDevice(device);
        close();
        if (previous >= 0) cudaSetDevice(previous);
    }
};
CudaFrameConformer::CudaFrameConformer(unsigned w, unsigned h, unsigned b, int d)
    : impl_(std::make_unique<Impl>(w, h, b, d)) {}
CudaFrameConformer::~CudaFrameConformer() = default;
Picture CudaFrameConformer::convert(const void *y, std::size_t y_pitch,
    const void *uv, std::size_t uv_pitch, unsigned source_bits, void *producer_stream) {
    auto &s = *impl_;
    if (!y || !uv || (source_bits != 8 && source_bits != 10) || source_bits > s.bits ||
        y_pitch < std::size_t(s.width) * (source_bits == 8 ? 1 : 2) ||
        uv_pitch < std::size_t((s.width + 1) / 2) * 2 * (source_bits == 8 ? 1 : 2) ||
        y_pitch % (source_bits == 8 ? 1 : 2) || uv_pitch % (source_bits == 8 ? 1 : 2))
        throw std::invalid_argument("Resident conversion requires NV12/P010 without precision loss");
    DeviceScope scope(s.device);
    // The FFmpeg decoder and this runtime use the same primary CUDA context.
    // A fence transfers ordering; no frame is copied back to host memory.
    check(cudaEventRecord(s.producer_ready, static_cast<cudaStream_t>(producer_stream)), "record decoder fence");
    check(cudaStreamWaitEvent(s.stream, s.producer_ready), "wait for decoder surface");
    const unsigned blocks = unsigned(std::min<std::size_t>((std::size_t(s.width) * s.height + 255) / 256, 4096));
    if (source_bits == 8 && s.bits == 8)
        deinterleave<<<blocks, 256, 0, s.stream>>>(static_cast<const std::uint8_t *>(y), y_pitch,
            static_cast<const std::uint8_t *>(uv), uv_pitch, static_cast<std::uint8_t *>(s.output[0]),
            static_cast<std::uint8_t *>(s.output[1]), static_cast<std::uint8_t *>(s.output[2]), s.width, s.height, 0, 0);
    else if (source_bits == 8)
        deinterleave<<<blocks, 256, 0, s.stream>>>(static_cast<const std::uint8_t *>(y), y_pitch,
            static_cast<const std::uint8_t *>(uv), uv_pitch, static_cast<std::uint16_t *>(s.output[0]),
            static_cast<std::uint16_t *>(s.output[1]), static_cast<std::uint16_t *>(s.output[2]), s.width, s.height, 0, 2);
    else
        deinterleave<<<blocks, 256, 0, s.stream>>>(static_cast<const std::uint16_t *>(y), y_pitch / 2,
            static_cast<const std::uint16_t *>(uv), uv_pitch / 2, static_cast<std::uint16_t *>(s.output[0]),
            static_cast<std::uint16_t *>(s.output[1]), static_cast<std::uint16_t *>(s.output[2]), s.width, s.height, 6, 0);
    check(cudaGetLastError(), "launch resident comparison conversion");
    check(cudaStreamSynchronize(s.stream), "finish resident comparison conversion");
    Picture result;
    result.memory = PictureMemory::CudaDevice;
    result.device_index = s.device;
    result.bit_depth = s.bits;
    for (unsigned p = 0; p < 3; ++p) {
        const unsigned w = p ? (s.width + 1) / 2 : s.width, h = p ? (s.height + 1) / 2 : s.height;
        result.planes[p] = {s.output[p], std::size_t(w) * (s.bits == 8 ? 1 : 2), w, h};
    }
    return result;
}
}
