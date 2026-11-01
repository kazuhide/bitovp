// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "frame_pipeline.hpp"
#include <cuda_runtime.h>
#include <iostream>
#include <stdexcept>
#include <string>

using namespace bitovp::gpu;
namespace {
void checked(cudaError_t code, const char *name) {
    if (code != cudaSuccess) throw std::runtime_error(std::string(name) + ": " + cudaGetErrorString(code));
}
void require(bool condition, const char *message) { if (!condition) throw std::runtime_error(message); }
template<typename Sample>
__global__ void fill_later(Sample *data, std::size_t stride, unsigned width, unsigned height,
                           unsigned seed, unsigned long long delay) {
    const auto start = clock64();
    while (clock64() - start < delay) {}
    for (unsigned y = 0; y < height; ++y)
        for (unsigned x = 0; x < width; ++x) data[y * stride + x] = seed + y * 11 + x;
}
struct Resources {
    cudaStream_t stream = nullptr;
    cudaEvent_t ready = nullptr;
    std::array<void *, 3> data{};
    ~Resources() {
        if (stream) cudaStreamSynchronize(stream);
        for (auto pointer : data) cudaFree(pointer);
        if (ready) cudaEventDestroy(ready);
        if (stream) cudaStreamDestroy(stream);
    }
};
void exercise(unsigned bits) {
    Resources r;
    checked(cudaStreamCreateWithFlags(&r.stream, cudaStreamNonBlocking), "create producer stream");
    checked(cudaEventCreateWithFlags(&r.ready, cudaEventDisableTiming), "create producer event");
    int clock_khz = 0;
    checked(cudaDeviceGetAttribute(&clock_khz, cudaDevAttrClockRate, 0), "read device clock attribute");
    require(clock_khz > 0, "CUDA clock attribute must be positive");
    Picture input; input.memory = PictureMemory::CudaDevice; input.device_index = 0;
    input.bit_depth = bits; input.cuda_ready_event = r.ready;
    const unsigned bytes = bits > 8 ? 2 : 1;
    for (unsigned p = 0; p < 3; ++p) {
        const unsigned width = p ? 3 : 5, height = p ? 2 : 4;
        std::size_t pitch = 0;
        checked(cudaMallocPitch(&r.data[p], &pitch, width * bytes, height), "allocate source plane");
        checked(cudaMemset2D(r.data[p], pitch, 0, width * bytes, height), "clear source plane");
        input.planes[p] = {r.data[p], pitch, width, height};
    }
    auto staged = stage_cuda_picture(input);
    // Warm both the lazily loaded producer kernel and the slot allocations.
    // Otherwise JIT/loading or cudaMallocPitch can finish the delayed producer
    // before assign() reaches its explicit cross-stream readiness dependency.
    const auto &first = input.planes[0];
    if (bits == 8) fill_later<<<1, 1, 0, r.stream>>>(static_cast<std::uint8_t *>(r.data[0]),
        first.stride, first.width, first.height, 0, 0);
    else fill_later<<<1, 1, 0, r.stream>>>(static_cast<std::uint16_t *>(r.data[0]),
        first.stride / 2, first.width, first.height, 0, 0);
    checked(cudaGetLastError(), "warm producer kernel");
    checked(cudaStreamSynchronize(r.stream), "complete producer warmup");
    auto warm_input = input; warm_input.cuda_ready_event = nullptr;
    staged->assign(warm_input);
    const auto produce = [&](unsigned seed) {
        for (unsigned p = 0; p < 3; ++p) {
            const auto &plane = input.planes[p];
            // The independent staging stream must wait; without its explicit
            // producer event the first plane would still contain old samples.
            const unsigned long long delay = p ? 0 : static_cast<unsigned long long>(clock_khz) * 20;
            if (bits == 8) fill_later<<<1, 1, 0, r.stream>>>(static_cast<std::uint8_t *>(r.data[p]),
                plane.stride, plane.width, plane.height, seed + p, delay);
            else fill_later<<<1, 1, 0, r.stream>>>(static_cast<std::uint16_t *>(r.data[p]),
                plane.stride / 2, plane.width, plane.height, seed + p, delay);
            checked(cudaGetLastError(), "launch delayed producer");
        }
        checked(cudaEventRecord(r.ready, r.stream), "publish producer completion");
        require(cudaEventQuery(r.ready) == cudaErrorNotReady, "Readiness fixture producer already completed before staging");
    };
    // Deliberately omit the event on the same preallocated slot. The owned
    // copy must expose an old pixel: if implicit synchronization already made
    // it current, this fixture cannot prove the explicit readiness dependency.
    produce(20);
    auto no_event = input; no_event.cuda_ready_event = nullptr;
    staged->assign(no_event);
    std::uint16_t stale = 0;
    checked(cudaMemcpy(&stale, staged->picture().planes[0].data, bytes, cudaMemcpyDeviceToHost),
            "read missing-event negative control");
    require(stale != 20, "Missing-event negative control was vacuous: staging already saw new pixels");
    checked(cudaEventSynchronize(r.ready), "finish negative-control producer");
    for (unsigned seed : {30u, 90u}) {
        produce(seed);
        staged->assign(input);
        checked(cudaEventQuery(r.ready), "staging did not complete the producer dependency");
        const auto &output = staged->picture();
        require(!output.cuda_ready_event, "Owned staged input did not publish ready memory");
        for (unsigned p = 0; p < 3; ++p) {
            const auto &plane = output.planes[p];
            std::vector<std::uint8_t> buffer(plane.width * plane.height * bytes);
            checked(cudaMemcpy2D(buffer.data(), plane.width * bytes, plane.data, plane.stride,
                plane.width * bytes, plane.height, cudaMemcpyDeviceToHost), "read staged plane");
            for (unsigned y = 0; y < plane.height; ++y) for (unsigned x = 0; x < plane.width; ++x) {
                unsigned value = bits == 8 ? buffer[y * plane.width + x] :
                    reinterpret_cast<const std::uint16_t *>(buffer.data())[y * plane.width + x];
                require(value == seed + p + y * 11 + x, "Stager read before producer completion or changed pitched pixels");
            }
        }
    }
    const auto timing = staged->timings();
    require(timing.device_copied_bytes == (5 * 4 + 2 * 3 * 2) * bytes * 4,
            "CUDA staged input copy accounting changed");
    require(timing.allocated_bytes > 0, "CUDA staging allocation was omitted");
}
}
int main() {
    try {
        checked(cudaSetDevice(0), "select CUDA test device");
        exercise(8); exercise(10);
        std::cout << "PASS CUDA frame-slot ownership, pitched8/10bit copy, producer-event ordering and effective missing-event control\n";
    } catch (const std::exception &error) { std::cerr << "FAIL: " << error.what() << '\n'; return 1; }
}
