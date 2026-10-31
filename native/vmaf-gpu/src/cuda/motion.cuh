/**
 * Copyright 2016-2026 Netflix, Inc.
 * Copyright (c) 2026 Kazuhide Yamamoto
 *
 * Licensed under the BSD+Patent License (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * https://opensource.org/licenses/BSDplusPatent
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Adapted scalar equations: Netflix/vmaf
 * 74f930d17de8c58e7c2ce55e2b897b0030ebd8ef,
 * libvmaf/src/feature/integer_motion.c and integer_motion.h.
 * CUDA implementation uses a full intermediate plane to parallelize rows.
 */
#pragma once

namespace bitovp::gpu::motion_cuda {
__device__ __constant__ int filter[5] = {3571, 16004, 26386, 16004, 3571};

__device__ int mirror(int index, int size) {
    if (index < 0) return -index;
    if (index >= size) return 2 * size - index - 2;
    return index;
}

template <typename Sample>
__global__ void vertical(const Sample *previous, const Sample *current,
                         std::int32_t *filtered, unsigned width, unsigned height,
                         unsigned bpc) {
    const std::size_t samples = static_cast<std::size_t>(width) * height;
    for (std::size_t i = blockIdx.x * blockDim.x + threadIdx.x; i < samples;
         i += static_cast<std::size_t>(blockDim.x) * gridDim.x) {
        const unsigned y = i / width, x = i % width;
        std::int64_t sum = 0;
        for (int k = 0; k < 5; ++k) {
            const std::size_t p = static_cast<std::size_t>(
                mirror(static_cast<int>(y) - 2 + k, height)) * width + x;
            sum += static_cast<std::int64_t>(filter[k]) *
                (static_cast<int>(previous[p]) - current[p]);
        }
        filtered[i] = static_cast<std::int32_t>((sum + (1 << (bpc - 1))) >> bpc);
    }
}

__global__ void horizontal_sad(const std::int32_t *filtered, unsigned width,
                               unsigned height, unsigned long long *sad) {
    __shared__ unsigned long long partial[256];
    const std::size_t samples = static_cast<std::size_t>(width) * height;
    unsigned long long sum_abs = 0;
    for (std::size_t i = blockIdx.x * blockDim.x + threadIdx.x; i < samples;
         i += static_cast<std::size_t>(blockDim.x) * gridDim.x) {
        const unsigned y = i / width, x = i % width;
        std::int64_t sum = 0;
        for (int k = 0; k < 5; ++k)
            sum += static_cast<std::int64_t>(filter[k]) *
                filtered[static_cast<std::size_t>(y) * width +
                    mirror(static_cast<int>(x) - 2 + k, width)];
        const auto value = static_cast<std::int32_t>((sum + (1 << 15)) >> 16);
        sum_abs += value < 0 ? -static_cast<std::int64_t>(value) : value;
    }
    partial[threadIdx.x] = sum_abs;
    __syncthreads();
    for (unsigned offset = 128; offset; offset /= 2) {
        if (threadIdx.x < offset) partial[threadIdx.x] += partial[threadIdx.x + offset];
        __syncthreads();
    }
    if (threadIdx.x == 0) atomicAdd(sad, partial[0]);
}
} // namespace bitovp::gpu::motion_cuda
