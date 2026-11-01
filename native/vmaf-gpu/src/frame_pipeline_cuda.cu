// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "frame_pipeline.hpp"
#include <cuda_runtime.h>
#include <limits>
#include <string>

namespace bitovp::gpu {
namespace {
void checked(cudaError_t code, const char *operation) {
    if (code != cudaSuccess) throw std::runtime_error(std::string(operation) + ": " + cudaGetErrorString(code));
}
struct DeviceScope {
    int previous = -1;
    explicit DeviceScope(int target) {
        checked(cudaGetDevice(&previous), "Read CUDA staging device");
        if (target != previous) checked(cudaSetDevice(target), "Select CUDA staging device");
    }
    ~DeviceScope() { if (previous >= 0) cudaSetDevice(previous); }
};
class CudaStagedPicture final : public StagedPicture {
public:
    explicit CudaStagedPicture(int device) : device_(device) {
        DeviceScope scope(device_);
        checked(cudaStreamCreateWithFlags(&stream_, cudaStreamNonBlocking), "Create CUDA staging stream");
        try {
            checked(cudaEventCreate(&started_), "Create CUDA staging start event");
            checked(cudaEventCreate(&completed_), "Create CUDA staging completion event");
        } catch (...) { release(); throw; }
    }
    ~CudaStagedPicture() override {
        int previous = -1; cudaGetDevice(&previous); cudaSetDevice(device_);
        release();
        if (previous >= 0) cudaSetDevice(previous);
    }
    void assign(const Picture &source) override {
        if (source.memory != PictureMemory::CudaDevice || source.device_index != device_ ||
            (source.bit_depth != 8 && source.bit_depth != 10))
            throw std::invalid_argument("CUDA frame staging requires a matching device and 8/10-bit input");
        DeviceScope scope(device_);
        const std::size_t bytes = source.bit_depth > 8 ? 2 : 1;
        for (unsigned p = 0; p < 3; ++p) {
            const auto &plane = source.planes[p];
            if ((plane.width == 0) != (plane.height == 0) ||
                plane.width > std::numeric_limits<std::size_t>::max() / bytes)
                throw std::invalid_argument("Invalid CUDA staged picture geometry");
            const std::size_t row = plane.width * bytes;
            if ((row && (!plane.data || plane.stride < row)) ||
                (plane.height && row > std::numeric_limits<std::size_t>::max() / plane.height) ||
                (plane.height > 1 && plane.stride > (std::numeric_limits<std::size_t>::max() - row) / (plane.height - 1)))
                throw std::invalid_argument("Invalid CUDA staged picture stride");
            if (row > buffers_[p].row || plane.height > buffers_[p].height) {
                auto &buffer = buffers_[p];
                cudaFree(buffer.data);
                buffer.data = nullptr; buffer.pitch = buffer.row = buffer.height = 0;
                checked(cudaMallocPitch(&buffer.data, &buffer.pitch, row, plane.height), "Allocate CUDA input slot");
                buffer.row = row; buffer.height = plane.height;
            }
        }
        try {
            checked(cudaEventRecord(started_, stream_), "Record CUDA staging start");
            if (source.cuda_ready_event)
                checked(cudaStreamWaitEvent(stream_, static_cast<cudaEvent_t>(source.cuda_ready_event), 0),
                        "Wait for CUDA producer before slot copy");
            for (unsigned p = 0; p < 3; ++p) {
                const auto &plane = source.planes[p];
                const std::size_t row = plane.width * bytes;
                if (row) checked(cudaMemcpy2DAsync(buffers_[p].data, buffers_[p].pitch,
                    plane.data, plane.stride, row, plane.height, cudaMemcpyDeviceToDevice, stream_),
                    "Copy CUDA picture into owned frame slot");
            }
            checked(cudaEventRecord(completed_, stream_), "Record CUDA staging completion");
            // The decoder may overwrite its reusable output after assign().
            // Finish this copy before releasing that borrowed source view.
            checked(cudaEventSynchronize(completed_), "Complete CUDA owned input copy");
            float ms = 0;
            checked(cudaEventElapsedTime(&ms, started_, completed_), "Measure CUDA staging copy");
            timing_.upload_ms += ms;
        } catch (...) { cudaStreamSynchronize(stream_); throw; }
        picture_ = source;
        picture_.cuda_ready_event = nullptr;
        for (unsigned p = 0; p < 3; ++p) {
            const auto &plane = source.planes[p];
            picture_.planes[p] = {buffers_[p].data, buffers_[p].pitch, plane.width, plane.height};
            timing_.device_copied_bytes += std::uint64_t(plane.width) * plane.height * bytes;
        }
    }
    const Picture &picture() const override { return picture_; }
    BackendTimings timings() const override {
        auto result = timing_;
        for (const auto &buffer : buffers_) result.allocated_bytes += buffer.pitch * buffer.height;
        return result;
    }
private:
    struct Buffer { void *data = nullptr; std::size_t pitch = 0, row = 0, height = 0; };
    void release() noexcept {
        if (stream_) cudaStreamSynchronize(stream_);
        for (auto &buffer : buffers_) { cudaFree(buffer.data); buffer.data = nullptr; }
        if (started_) cudaEventDestroy(started_);
        if (completed_) cudaEventDestroy(completed_);
        if (stream_) cudaStreamDestroy(stream_);
        started_ = completed_ = nullptr; stream_ = nullptr;
    }
    int device_;
    cudaStream_t stream_ = nullptr;
    cudaEvent_t started_ = nullptr, completed_ = nullptr;
    std::array<Buffer,3> buffers_{};
    Picture picture_;
    BackendTimings timing_;
};
}
std::unique_ptr<StagedPicture> stage_cuda_picture(const Picture &source) {
    if (source.memory == PictureMemory::Host) return stage_host_picture(source);
    if (source.memory != PictureMemory::CudaDevice || source.device_index < 0)
        throw std::invalid_argument("Unknown CUDA frame pipeline input memory");
    return std::make_unique<CudaStagedPicture>(source.device_index);
}
}
