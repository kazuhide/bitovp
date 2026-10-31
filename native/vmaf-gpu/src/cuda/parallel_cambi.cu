/*
 * Copyright 2016-2020 Netflix, Inc.
 * Licensed under the BSD+Patent License (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * https://opensource.org/licenses/BSDplusPatent
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// Adapted from official Netflix/vmaf 74f930d17de8c58e7c2ce55e2b897b0030ebd8ef
// feature/cambi.c and the owned parallel Vulkan adaptation. Integer masks and
// histograms are independent per pixel; quickselect preserves CPU sum order.
#include "parallel_cambi.hpp"
#include "../vulkan/cambi_parameters.hpp"
#include <cub/device/device_radix_sort.cuh>
#include <algorithm>
#include <array>
#include <limits>
#include <stdexcept>

namespace bitovp::gpu {
namespace {
using Word = unsigned;
struct Parameters {
    unsigned mode, width, height, source_image, destination_image;
    unsigned source_mask, destination_mask, extra;
};
struct Buffers {
    Word *words;
    const unsigned char *input;
    Parameters p;
};
__device__ unsigned mode3(unsigned a, unsigned b, unsigned c) {
    if (a == b || a == c) return a;
    if (b == c) return b;
    return min(a, min(b, c));
}
__device__ unsigned image(const Buffers &b, unsigned x, unsigned y) {
    return b.words[b.p.source_image + y * b.p.width + x];
}
__device__ unsigned horizontal(const Buffers &b, unsigned x, unsigned y) {
    if (x == 0 || x + 1 == b.p.width) return image(b, x, y);
    return mode3(image(b, x - 1, y), image(b, x, y), image(b, x + 1, y));
}
__device__ bool derivative(const Buffers &b, unsigned x, unsigned y) {
    const auto value = image(b, x, y);
    return (x + 1 == b.p.width || value == image(b, x + 1, y)) &&
           (y + 1 == b.p.height || value == image(b, x, y + 1));
}
__device__ void pool(const Buffers &b) {
    auto *words = b.words;
    const auto base = words[20];
    const int n = int(b.p.width * b.p.height), k = int(b.p.extra);
    if (n != k) {
        int left = 0, right = n - 1;
        while (left < right) {
            const float pivot = __uint_as_float(words[base + k]);
            int i = left, j = right;
            do {
                while (__uint_as_float(words[base + i]) > pivot) ++i;
                while (__uint_as_float(words[base + j]) < pivot) --j;
                if (i <= j) {
                    const auto temporary = words[base + i];
                    words[base + i] = words[base + j];
                    words[base + j] = temporary;
                    ++i; --j;
                }
            } while (i <= j);
            if (j < k) left = i;
            if (k < i) right = j;
        }
    }
    double sum = 0;
    for (int i = 0; i < k; ++i) sum += double(__uint_as_float(words[base + i]));
    const auto bits = static_cast<unsigned long long>(__double_as_longlong(sum / double(k)));
    words[b.p.destination_image] = unsigned(bits);
    words[b.p.destination_image + 1] = unsigned(bits >> 32);
}
__global__ void cambi_kernel(Buffers b) {
    const unsigned x = blockIdx.x * blockDim.x + threadIdx.x;
    const unsigned y = blockIdx.y * blockDim.y + threadIdx.y;
    if (b.p.mode == 6) { if (!x && !y) pool(b); return; }
    const auto &p = b.p;
    auto *words = b.words;
    if (x >= p.width || y >= p.height) return;
    const unsigned pixel = y * p.width + x;
    if (p.mode == 0) {
        const unsigned sx = words[words[23] + x], sy = words[words[24] + y];
        const unsigned value = words[5] == 8
            ? b.input[std::size_t(sy) * words[4] + sx]
            : reinterpret_cast<const unsigned short *>(b.input + std::size_t(sy) * words[4])[sx];
        words[p.destination_image + pixel] = words[5] == 8 ? value << 2 : value;
    } else if (p.mode == 1) {
        unsigned value = image(b, x, y);
        if (y + 1 < p.height) {
            value += image(b, x, y + 1);
            if (x + 1 < p.width) value = (value + image(b, x + 1, y) + image(b, x + 1, y + 1)) >> 2;
            else value >>= 1;
        } else if (x + 1 < p.width) value = (value + image(b, x + 1, y)) >> 1;
        words[p.destination_image + pixel] = value;
    } else if (p.mode == 2) {
        unsigned count = 0;
        for (int yy = max(0, int(y) - 3); yy <= min(int(p.height) - 1, int(y) + 3); ++yy)
            for (int xx = max(0, int(x) - 3); xx <= min(int(p.width) - 1, int(x) + 3); ++xx)
                if (derivative(b, unsigned(xx), unsigned(yy))) ++count;
        words[p.destination_mask + pixel] = count > words[10] ? 1 : 0;
    } else if (p.mode == 3) {
        const unsigned offset = (y * 2) * p.extra + x * 2;
        words[p.destination_image + pixel] = words[p.source_image + offset];
        words[p.destination_mask + pixel] = words[p.source_mask + offset];
    } else if (p.mode == 4) {
        words[p.destination_image + pixel] = y == 0 || y + 1 == p.height ? image(b, x, y) :
            mode3(horizontal(b, x, y - 1), horizontal(b, x, y), horizontal(b, x, y + 1));
    } else if (p.mode == 5) {
        float result = 0;
        if (words[p.source_mask + pixel]) {
            const unsigned raw = image(b, x, y), differences = words[8], value = raw + differences;
            unsigned p0 = 0, positives[32], negatives[32];
            for (unsigned d = 0; d < differences; ++d) positives[d] = negatives[d] = 0;
            const int radius = int(words[7] >> 1);
            for (int yy = max(0, int(y) - radius); yy <= min(int(p.height) - 1, int(y) + radius); ++yy) {
                for (int xx = max(0, int(x) - radius); xx <= min(int(p.width) - 1, int(x) + radius); ++xx) {
                    const unsigned neighbor = unsigned(yy) * p.width + unsigned(xx);
                    if (!words[p.source_mask + neighbor]) continue;
                    const unsigned v = words[p.source_image + neighbor];
                    if (v == raw) ++p0;
                    for (unsigned d = 0; d < differences; ++d) {
                        if (v == raw + d + 1) ++positives[d];
                        if (int(v) == int(raw) - int(d) - 1) ++negatives[d];
                    }
                }
            }
            const unsigned weights[32] = {1,2,3,4,4,5,5,6,6,6,6,7,7,7,7,8,8,8,8,8,8,8,9,9,9,9,9,9,9,9,9,9};
            for (unsigned d = 0; d < differences; ++d) {
                if (value <= words[words[21] + d] && value + d + 1 > words[9]) {
                    const unsigned p1 = max(positives[d], negatives[d]);
                    const float value_c = float(weights[d] * p0 * p1) *
                        __uint_as_float(words[words[22] + p1 + p0]);
                    if (value_c > result) result = value_c;
                }
            }
        }
        words[words[20] + pixel] = __float_as_uint(result);
    }
}
__global__ void sum_largest(const float *sorted, unsigned count, double *pooled) {
    __shared__ double partial[256];
    double local = 0;
    for (std::size_t i = std::size_t(blockIdx.x) * blockDim.x + threadIdx.x; i < count;
         i += std::size_t(blockDim.x) * gridDim.x) local += double(sorted[i]);
    partial[threadIdx.x] = local;
    __syncthreads();
    for (unsigned step = 128; step; step >>= 1) {
        if (threadIdx.x < step) partial[threadIdx.x] += partial[threadIdx.x + step];
        __syncthreads();
    }
    if (!threadIdx.x) atomicAdd(pooled, partial[0] / double(count));
}
void check(cudaError_t code, const char *op) {
    if (code != cudaSuccess) throw std::runtime_error(std::string(op) + ": " + cudaGetErrorString(code));
}
struct Event {
    cudaEvent_t value = nullptr;
    Event() { check(cudaEventCreateWithFlags(&value, cudaEventBlockingSync), "create CAMBI timer"); }
    ~Event() { if (value) cudaEventDestroy(value); }
};
double duration(const Event &a, const Event &b) {
    float value = 0;
    check(cudaEventElapsedTime(&value, a.value, b.value), "read CAMBI timer");
    return value;
}
}

struct CudaParallelCambi::Impl {
    vulkan_detail::CambiParameters parameters;
    cudaStream_t stream;
    Word *workspace = nullptr;
    float *sorted = nullptr;
    void *sort_temporary = nullptr;
    std::size_t sort_capacity = 0;
    double *device_scales = nullptr, *host_scales = nullptr;
    BackendTimings timing;
    std::string canonical;
    bool profile;
    Impl(const ExtractorSpec &spec, const FeaturePlan &plan, cudaStream_t supplied_stream, bool supplied_profile)
        : parameters(spec, plan), stream(supplied_stream), profile(supplied_profile) {
        const auto name = spec.canonical_names.find("Cambi_feature_cambi_score");
        if (name == spec.canonical_names.end()) throw std::invalid_argument("CAMBI canonical feature name is missing");
        canonical = name->second;
        try {
            const auto bytes = parameters.word_count * sizeof(Word);
            check(cudaMalloc(&workspace, bytes), "allocate parallel CAMBI workspace");
            timing.allocated_bytes = bytes;
            const auto max_width = parameters.high_resolution ? (parameters.width + 1) / 2 : parameters.width;
            const auto max_height = parameters.high_resolution ? (parameters.height + 1) / 2 : parameters.height;
            const auto max_count = std::size_t(max_width) * max_height;
            check(cudaMalloc(&sorted, max_count * sizeof(float)), "allocate CAMBI radix output");
            check(cub::DeviceRadixSort::SortKeysDescending(nullptr, sort_capacity,
                reinterpret_cast<float *>(workspace + parameters.words[20]), sorted,
                max_count, 0, 32, stream), "size CAMBI radix scratch");
            check(cudaMalloc(&sort_temporary, sort_capacity), "allocate CAMBI radix scratch");
            check(cudaMalloc(&device_scales, 5 * sizeof(double)), "allocate CAMBI pooled output");
            check(cudaMallocHost(&host_scales, 5 * sizeof(double)), "allocate CAMBI pinned readback");
            timing.allocated_bytes += max_count * sizeof(float) + sort_capacity + 5 * sizeof(double);
            Event from, to;
            check(cudaEventRecord(from.value, stream), "begin CAMBI setup upload");
            const auto immutable_bytes = parameters.image_a * sizeof(Word);
            check(cudaMemcpyAsync(workspace, parameters.words.data(), immutable_bytes,
                                  cudaMemcpyHostToDevice, stream), "upload CAMBI constants");
            check(cudaEventRecord(to.value, stream), "end CAMBI setup upload");
            check(cudaEventSynchronize(to.value), "complete CAMBI setup upload");
            timing.uploaded_bytes += immutable_bytes;
            timing.upload_ms += duration(from, to);
        } catch (...) { close(); throw; }
    }
    void close() {
        cudaStreamSynchronize(stream);
        cudaFree(workspace); cudaFree(sorted); cudaFree(sort_temporary); cudaFree(device_scales);
        cudaFreeHost(host_scales);
    }
    ~Impl() { close(); }
    FeatureScore extract(std::uint64_t index, const Plane &input) {
        if (!input.data || input.stride > std::numeric_limits<unsigned>::max())
            throw std::invalid_argument("Invalid resident CAMBI input stride");
        const unsigned stride = unsigned(input.stride);
        Event from, uploaded, calculated, downloaded;
        check(cudaEventRecord(from.value, stream), "begin CAMBI upload");
        check(cudaMemcpyAsync(workspace + 4, &stride, sizeof(stride), cudaMemcpyHostToDevice, stream), "upload CAMBI input pitch");
        check(cudaEventRecord(uploaded.value, stream), "end CAMBI upload");
        unsigned width = parameters.width, height = parameters.height;
        auto image = parameters.image_a, other_image = parameters.image_b;
        auto mask = parameters.mask_a, other_mask = parameters.mask_b;
        struct Stage { unsigned mode; Event start, end; explicit Stage(unsigned m) : mode(m) {} };
        std::vector<std::unique_ptr<Stage>> stages;
        const auto dispatch = [&](unsigned mode, unsigned extra = 0, unsigned destination = 0) {
            auto stage = profile ? std::make_unique<Stage>(mode) : nullptr;
            if (stage) check(cudaEventRecord(stage->start.value, stream), "begin CAMBI stage profile");
            const Parameters p{mode, width, height, image, destination ? destination : other_image, mask, other_mask, extra};
            const dim3 block(16, 16), grid((width + 15) / 16, (height + 15) / 16);
            if (mode == 6) {
                const auto scale = (destination - parameters.scores) / 2;
                auto temporary_bytes = sort_capacity;
                check(cub::DeviceRadixSort::SortKeysDescending(sort_temporary, temporary_bytes,
                    reinterpret_cast<float *>(workspace + parameters.words[20]), sorted,
                    std::size_t(width) * height, 0, 32, stream), "sort CAMBI scores");
                check(cudaMemsetAsync(device_scales + scale, 0, sizeof(double), stream), "reset CAMBI pooled sum");
                const unsigned groups = std::min((extra + 255) / 256, 4096u);
                sum_largest<<<groups, 256, 0, stream>>>(sorted, extra, device_scales + scale);
            } else {
                cambi_kernel<<<grid, block, 0, stream>>>(
                    {workspace, static_cast<const unsigned char *>(input.data), p});
            }
            check(cudaGetLastError(), "launch parallel CAMBI stage");
            if (stage) {
                check(cudaEventRecord(stage->end.value, stream), "end CAMBI stage profile");
                stages.push_back(std::move(stage));
            }
        };
        dispatch(0, 0, image);
        if (parameters.words[6] < 10) { dispatch(1); std::swap(image, other_image); }
        std::swap(mask, other_mask);
        dispatch(2);
        std::swap(mask, other_mask);
        for (unsigned scale = 0; scale < 5; ++scale) {
            if (scale || parameters.high_resolution) {
                const auto old_width = width;
                width = (width + 1) >> 1; height = (height + 1) >> 1;
                dispatch(3, old_width);
                std::swap(image, other_image); std::swap(mask, other_mask);
            }
            dispatch(4); std::swap(image, other_image);
            dispatch(5);
            const auto count = std::uint64_t(width) * height;
            const auto topk = unsigned(std::clamp(parameters.topk * double(count), 1.0, double(count)));
            dispatch(6, topk, parameters.scores + scale * 2);
        }
        check(cudaEventRecord(calculated.value, stream), "end CAMBI compute");
        check(cudaMemcpyAsync(host_scales, device_scales, 5 * sizeof(double),
                              cudaMemcpyDeviceToHost, stream), "read CAMBI pooled scales");
        check(cudaEventRecord(downloaded.value, stream), "end CAMBI readback");
        check(cudaEventSynchronize(downloaded.value), "complete parallel CAMBI");
        for (const auto &stage : stages)
            timing.extractor_kernel_ms["cambi.stage." + std::to_string(stage->mode)] += duration(stage->start, stage->end);
        timing.uploaded_bytes += sizeof(stride); timing.downloaded_bytes += 5 * sizeof(double);
        timing.upload_ms += duration(from, uploaded);
        timing.kernel_ms += duration(uploaded, calculated);
        timing.extractor_kernel_ms["cambi"] += duration(uploaded, calculated);
        timing.download_ms += duration(calculated, downloaded);
        const unsigned weights[5] = {16, 8, 4, 2, 1};
        double score = 0;
        for (unsigned scale = 0; scale < 5; ++scale) score += host_scales[scale] * weights[scale];
        return {index, canonical, std::min(score / double(parameters.window * parameters.window), parameters.maximum)};
    }
};
CudaParallelCambi::CudaParallelCambi(const ExtractorSpec &spec, const FeaturePlan &plan, cudaStream_t stream, bool profile)
    : impl_(std::make_unique<Impl>(spec, plan, stream, profile)) {}
CudaParallelCambi::~CudaParallelCambi() = default;
FeatureScore CudaParallelCambi::extract(std::uint64_t index, const Plane &input) { return impl_->extract(index, input); }
BackendTimings CudaParallelCambi::timings() const { return impl_->timing; }
}
