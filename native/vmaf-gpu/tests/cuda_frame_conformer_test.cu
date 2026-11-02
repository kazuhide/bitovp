// SPDX-License-Identifier: MIT
#include "cuda/frame_conformer.hpp"
#include <cuda_runtime.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <vector>

using namespace bitovp::gpu;
namespace {
void check(cudaError_t code) {
    if (code != cudaSuccess) throw std::runtime_error(cudaGetErrorString(code));
}
__global__ void delay_producer() {
    const auto start = clock64();
    while (clock64() - start < 10000000ULL) {}
}
void run(unsigned source_bits, unsigned output_bits) {
    const unsigned width = 67, height = 43, cw = (width + 1) / 2, ch = (height + 1) / 2;
    const unsigned bytes = source_bits == 8 ? 1 : 2;
    const std::size_t y_pitch = (width + 9) * bytes, uv_pitch = (cw * 2 + 12) * bytes;
    std::vector<std::uint16_t> expected[3];
    for (unsigned p = 0; p < 3; ++p) expected[p].resize(std::size_t(p ? cw : width) * (p ? ch : height));
    unsigned char *host_y = nullptr, *host_uv = nullptr;
    void *device_y = nullptr, *device_uv = nullptr;
    cudaStream_t producer = nullptr;
    cudaEvent_t done = nullptr;
    try {
        check(cudaMallocHost(&host_y, y_pitch * height));
        check(cudaMallocHost(&host_uv, uv_pitch * ch));
        std::memset(host_y, 0xa5, y_pitch * height); std::memset(host_uv, 0x55, uv_pitch * ch);
        for (unsigned p = 0; p < 3; ++p) {
            const unsigned w = p ? cw : width, h = p ? ch : height;
            for (unsigned y = 0; y < h; ++y) for (unsigned x = 0; x < w; ++x) {
                const unsigned value = (x * 19 + y * 41 + p * 37) % (1u << source_bits);
                const std::uint16_t stored = source_bits == 10 ? value << 6 : value;
                auto *location = p ? host_uv + y * uv_pitch + (x * 2 + p - 1) * bytes
                                   : host_y + y * y_pitch + x * bytes;
                std::memcpy(location, &stored, bytes);
                expected[p][std::size_t(y) * w + x] = value << (output_bits - source_bits);
            }
        }
        check(cudaMalloc(&device_y, y_pitch * height));
        check(cudaMalloc(&device_uv, uv_pitch * ch));
        check(cudaStreamCreateWithFlags(&producer, cudaStreamNonBlocking));
        check(cudaEventCreateWithFlags(&done, cudaEventDisableTiming));
        CudaFrameConformer conformer(width, height, output_bits, 0);
        delay_producer<<<1, 1, 0, producer>>>();
        check(cudaGetLastError());
        check(cudaMemcpyAsync(device_y, host_y, y_pitch * height, cudaMemcpyHostToDevice, producer));
        check(cudaMemcpyAsync(device_uv, host_uv, uv_pitch * ch, cudaMemcpyHostToDevice, producer));
        check(cudaEventRecord(done, producer));
        if (cudaEventQuery(done) != cudaErrorNotReady)
            throw std::runtime_error("Producer-fence fixture was already complete");
        const auto output = conformer.convert(device_y, y_pitch, device_uv, uv_pitch, source_bits, producer);
        if (output.memory != PictureMemory::CudaDevice || output.device_index != 0 || output.bit_depth != output_bits)
            throw std::runtime_error("Resident output metadata differs");
        for (unsigned p = 0; p < 3; ++p) {
            const auto count = expected[p].size();
            std::vector<std::uint16_t> actual(count);
            if (output_bits == 8) {
                std::vector<std::uint8_t> narrow(count);
                check(cudaMemcpy(narrow.data(), output.planes[p].data, count, cudaMemcpyDeviceToHost));
                std::copy(narrow.begin(), narrow.end(), actual.begin());
            } else check(cudaMemcpy(actual.data(), output.planes[p].data, count * 2, cudaMemcpyDeviceToHost));
            if (actual != expected[p]) throw std::runtime_error("Resident deinterleave/pitch/precision/fence mismatch");
        }
        bool rejected = false;
        try { conformer.convert(device_y, 0, device_uv, uv_pitch, source_bits, producer); }
        catch (const std::invalid_argument &) { rejected = true; }
        if (!rejected) throw std::runtime_error("Invalid pitch accepted");
        std::cout << "PASS resident " << source_bits << " -> " << output_bits << " bit, odd/padded YUV and producer fence\n";
    } catch (...) {
        if (producer) cudaStreamSynchronize(producer);
        cudaEventDestroy(done); cudaStreamDestroy(producer); cudaFree(device_y); cudaFree(device_uv);
        cudaFreeHost(host_y); cudaFreeHost(host_uv);
        throw;
    }
    cudaEventDestroy(done); cudaStreamDestroy(producer); cudaFree(device_y); cudaFree(device_uv);
    cudaFreeHost(host_y); cudaFreeHost(host_uv);
}
}
int main() {
    try { run(8, 8); run(8, 10); run(10, 10); return 0; }
    catch (const std::exception &e) { std::cerr << e.what() << '\n'; return 1; }
}
