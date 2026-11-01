/*
 * Copyright 2016-2020 Netflix, Inc.
 * Copyright 2016-2025 Netflix, Inc.
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
// feature/speed.c, vif_tools.c, picture_copy.c and the owned Vulkan port.
#include "parallel_speed.hpp"
#include "../vulkan/speed_parameters.hpp"
#include "parallel_speed.cuh"
#include <chrono>
#include <limits>
#include <set>
#include <stdexcept>

namespace bitovp::gpu {
namespace {
using Math = parallel_speed_detail::SpeedMath;
using Dimensions = Math::SpeedDimensions;
struct Parameters { unsigned mode, width, height, source, destination, extra; };
struct Workspace {
    unsigned *words;
    const unsigned char *input;
    std::size_t input_stride;
    __device__ float *floats() const { return reinterpret_cast<float *>(words); }
    __device__ Dimensions dimensions() const {
        Dimensions d{};
        d.original_width = int(words[0]); d.original_height = int(words[1]);
        d.scaled_width = int(words[2]); d.scaled_height = int(words[3]);
        d.operating_width = int(words[6]); d.operating_height = int(words[7]);
        d.truncated_width = (d.operating_width / 5) * 5;
        d.truncated_height = (d.operating_height / 5) * 5;
        d.block_size = 5; d.elements_in_block = 25;
        d.num_blocks_horizontal = d.truncated_width / 5;
        d.num_blocks_vertical = d.truncated_height / 5;
        d.num_blocks = d.num_blocks_horizontal * d.num_blocks_vertical;
        d.submatrix_width = d.truncated_width - 4; d.submatrix_height = d.truncated_height - 4;
        d.alloc_width = int(words[4]); d.alloc_height = max(d.original_height, d.scaled_height);
        return d;
    }
};
__device__ int mirror(int value, int size) { return value < 0 ? -value : value >= size ? 2 * size - value - 2 : value; }
__global__ void image_kernel(Workspace b, Parameters p) {
    const unsigned x = blockIdx.x * blockDim.x + threadIdx.x, y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x >= p.width || y >= p.height) return;
    auto *f = b.floats(); const auto *w = b.words;
    const unsigned stride = w[4], pixel = y * stride + x;
    if (p.mode == 0) {
        float value = w[5] == 8 ? float(b.input[std::size_t(y) * b.input_stride + x])
            : float(reinterpret_cast<const unsigned short *>(b.input + std::size_t(y) * b.input_stride)[x]) / 4.0f;
        f[p.destination + pixel] = value - 128.0f;
    } else if (p.mode == 1) {
        const unsigned x1 = w[w[17] + x], x2 = w[w[18] + x], y1 = w[w[20] + y], y2 = w[w[21] + y];
        const float dx = f[w[19] + x], dy = f[w[22] + y];
        f[p.destination + pixel] = (1.0f - dy) * (1.0f - dx) * f[p.source + y1 * stride + x1] +
            (1.0f - dy) * dx * f[p.source + y1 * stride + x2] +
            dy * (1.0f - dx) * f[p.source + y2 * stride + x1] + dy * dx * f[p.source + y2 * stride + x2];
    } else if (p.mode == 2 || p.mode == 4) {
        const unsigned filter = p.mode == 2 ? w[13] : w[15];
        const int size = int(p.mode == 2 ? w[14] : w[16]), height = int(p.mode == 2 ? w[3] : w[7]);
        const int center = p.mode == 2 ? int(y * 16) : int(y);
        float value = 0;
        for (int tap = 0; tap < size; ++tap) value += f[filter + tap] * f[p.source + unsigned(mirror(center - size / 2 + tap, height)) * stride + x];
        f[p.destination + pixel] = value;
    } else {
        const unsigned filter = p.mode == 3 ? w[13] : w[15];
        const int size = int(p.mode == 3 ? w[14] : w[16]), width = int(p.mode == 3 ? w[2] : w[6]);
        const int center = p.mode == 3 ? int(x * 16) : int(x);
        float value = 0;
        for (int tap = 0; tap < size; ++tap) value += f[filter + tap] * f[p.source + y * stride + unsigned(mirror(center - size / 2 + tap, width))];
        if (p.mode == 5) value = f[p.extra + pixel] - value;
        f[p.destination + pixel] = value;
    }
}
// Each element retains the CPU's row-major accumulation order. Parallelism is
// between independent means/covariances, not within their sums.
__global__ void means_kernel(Workspace b, unsigned image) {
    const unsigned i = threadIdx.x;
    if (i >= 25) return;
    Math m{b.floats()};
    m.f[b.words[31] + i] = m.compute_mean(b.dimensions(), int(image), int(b.words[4]), int(i / 5), int(i % 5));
}
__global__ void covariance_kernel(Workspace b, unsigned image, unsigned output) {
    const unsigned i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= 325) return;
    // Pack only the lower triangle into full warps. Each lane retains its
    // complete ascending-pixel FP64 sum and writes both symmetric cells.
    unsigned x = 0;
    for (unsigned step = 16; step; step >>= 1) {
        const unsigned candidate = x + step;
        if (candidate < 25 && candidate * (candidate + 1) / 2 <= i) x = candidate;
    }
    const unsigned y = i - x * (x + 1) / 2;
    Math m{b.floats()};
    const float value = m.compute_covariance(b.dimensions(), int(image), int(b.words[31]), int(b.words[4]), int(x / 5), int(x % 5), int(y / 5), int(y % 5));
    m.f[output + x * 25 + y] = value;
    m.f[output + y * 25 + x] = value;
}
__global__ void independent_kernel(Workspace b, unsigned image, unsigned output) {
    const auto d = b.dimensions();
    const unsigned cell = blockIdx.x * blockDim.x + threadIdx.x;
    if (cell >= 25u * unsigned(d.num_blocks)) return;
    const unsigned i = cell / unsigned(d.num_blocks), block = cell % unsigned(d.num_blocks);
    const unsigned y = (block / unsigned(d.num_blocks_horizontal)) * 5u + i / 5u;
    const unsigned x = (block % unsigned(d.num_blocks_horizontal)) * 5u + i % 5u;
    b.floats()[output + cell] = b.floats()[image + y * b.words[4] + x];
}
__device__ void block_copy(float *f, int destination, int source, int count) {
    for (int i = int(threadIdx.x); i < count; i += int(blockDim.x)) f[destination + i] = f[source + i];
    __syncthreads();
}
__device__ void block_multiply(float *f, int destination, int x, int y, int rows, int inner, int columns) {
    // CPU matrix_mul visits i,k,j. Each output cell has the same ascending k
    // sum here; parallel outputs do not change the rounding of that sum.
    for (int cell = int(threadIdx.x); cell < rows * columns; cell += int(blockDim.x)) {
        const int i = cell / columns, j = cell % columns;
        float sum = 0;
        for (int k = 0; k < inner; ++k) sum += f[x + i * inner + k] * f[y + k * columns + j];
        f[destination + cell] = sum;
    }
    __syncthreads();
}
__device__ void block_factor(float *f) {
    constexpr int size = 25, square = size * size;
    constexpr int a = 0, q = a + square, r = q + square;
    constexpr int tmp1 = r + square, tmp2 = tmp1 + square, norm_value = tmp2 + square;
    block_copy(f, tmp2, a, square);
    for (int cell = int(threadIdx.x); cell < square; cell += int(blockDim.x)) f[q + cell] = cell / size == cell % size ? 1.0f : 0.0f;
    __syncthreads();
    Math m{f};
    for (int k = 0; k < size - 1; ++k) {
        for (int cell = int(threadIdx.x); cell < square; cell += int(blockDim.x)) {
            const int i = cell / size, j = cell % size;
            if (i < k || j < k) f[tmp2 + cell] = i == j ? 1.0f : 0.0f;
        }
        __syncthreads();
        if (threadIdx.x < size) f[r + threadIdx.x] = f[tmp2 + threadIdx.x * size + k];
        __syncthreads();
        if (!threadIdx.x) {
            const float norm = m.vector_norm(r, size);
            f[r + k] += m.get_sign(f[a + k * size + k]) * norm;
            f[norm_value] = m.vector_norm(r, size);
        }
        __syncthreads();
        if (threadIdx.x < size) f[r + threadIdx.x] = __fdiv_rn(f[r + threadIdx.x], f[norm_value]);
        __syncthreads();
        for (int cell = int(threadIdx.x); cell < square; cell += int(blockDim.x)) {
            const int i = cell / size, j = cell % size;
            float value = -2.0f * f[r + i] * f[r + j];
            if (i == j) value += 1.0f;
            f[tmp1 + cell] = value;
        }
        __syncthreads();
        block_multiply(f, r, tmp1, tmp2, size, size, size);
        block_copy(f, tmp2, r, square);
        block_multiply(f, r, tmp1, q, size, size, size);
        block_copy(f, q, r, square);
    }
    block_multiply(f, r, q, a, size, size, size);
}
__device__ void cooperative_eigenvalues(float *f, float &tau, float &alpha) {
    constexpr int size = 25, square = size * size;
    constexpr int a = square + size, d = a + square, sd = d + size;
    constexpr int v = sd + size, x = v + size;
    const int lane = int(threadIdx.x);
    Math m{f};
    block_copy(f, a, 0, square);
    for (int column = 0; column < size - 2; ++column) {
        // Scalar norms/divisions and dependent dot products retain CPU order.
        // Independent rows and matrix cells share the remaining work.
        if (!lane) tau = m.compute_householder_transform(a, column, column + 1, size);
        __syncthreads();
        if (lane > column && lane < size) f[v + lane] = f[a + lane * size + column];
        __syncthreads();
        if (tau != 0.0f) {
            if (!lane) {
                f[a + (column + 1) * size + column] = f[v + column + 1];
                f[v + column + 1] = 1.0f;
            }
            __syncthreads();
            if (lane > column && lane < size) {
                float sum = 0;
                for (int j = column + 1; j < size; ++j)
                    sum += tau * f[a + lane * size + j] * f[v + j];
                f[x + lane] = sum;
            }
            __syncthreads();
            if (!lane) {
                const float dot = m.tridiagonal_dot_product(x, v, column + 1, size);
                alpha = Math::round_float(-0.5 * double(tau) * double(dot));
            }
            __syncthreads();
            if (lane > column && lane < size) f[x + lane] += alpha * f[v + lane];
            __syncthreads();
            for (int cell = lane; cell < square; cell += int(blockDim.x)) {
                const int row = cell / size, col = cell % size;
                if (row > column && col > column)
                    f[a + cell] -= f[x + row] * f[v + col] + f[v + row] * f[x + col];
            }
        }
        // Zero-tau iterations also finish before lane zero overwrites tau.
        __syncthreads();
    }
    if (lane < size) f[d + lane] = f[a + lane * size + lane];
    if (lane < size - 1) f[sd + lane] = f[a + (lane + 1) * size + lane];
    __syncthreads();
    if (!lane) m.compute_eigenvalues_tridiagonal(d, sd, square, size);
}

template <bool Cooperative = true>
__global__ void factor_kernel(Workspace b) {
    // The covariance, QR factors and eigenvalue workspace fit in 12.5 KiB.
    // Shared storage changes only where binary32 intermediates are stored;
    // every scalar eigenvalue and per-cell QR accumulation retains its order.
    __shared__ float scratch[3126];
    __shared__ float tau, alpha;
    constexpr int size = 25, square = size * size, q = square, r = q + square;
    Math m{scratch}; const auto d = b.dimensions();
    auto *f = b.floats();
    const unsigned slot = 36u + blockIdx.x * 7u;
    const int covariance = int(b.words[slot]), eigenvalues = int(b.words[slot + 1u]);
    const int temporary = int(b.words[slot + 4u]), output = int(b.words[slot + 5u]);
    const unsigned failure = b.words[slot + 6u];
    for (int i = int(threadIdx.x); i < square; i += int(blockDim.x)) scratch[i] = f[covariance + i];
    __syncthreads();
    if constexpr (Cooperative) cooperative_eigenvalues(scratch, tau, alpha);
    else if (!threadIdx.x) m.compute_eigenvalues(0, square, size, square + size);
    __syncthreads();
    if (!threadIdx.x) b.words[failure] = m.is_matrix_regular(d, square) ? 0 : 1;
    __syncthreads();
    if (threadIdx.x < size) {
        const float value = scratch[square + threadIdx.x];
        f[eigenvalues + threadIdx.x] = value;
        f[output + threadIdx.x] = value;
    }
    __syncthreads();
    if (!b.words[failure]) {
        block_factor(scratch);
        if (!threadIdx.x) {
            for (int i = size - 1; i >= 0; --i)
                if (fabsf(scratch[r + i * size + i]) < 1e-6) { b.words[failure] = 1; break; }
        }
        for (int i = int(threadIdx.x); i < 2 * square; i += int(blockDim.x)) f[temporary + q + i] = scratch[q + i];
    }
    if (!threadIdx.x) f[output + size + d.num_blocks] = b.words[failure] ? 1.0f : 0.0f;
}
__global__ void solve_kernel(Workspace b) {
    const auto d = b.dimensions();
    const int block = int(blockIdx.x * blockDim.x + threadIdx.x);
    if (block >= d.num_blocks) return;
    auto *f = b.floats();
    const unsigned slot = 36u + blockIdx.y * 7u;
    const int output = int(b.words[slot + 5u]);
    if (b.words[b.words[slot + 6u]]) { f[output + 25 + block] = 0; return; }
    constexpr int size = 25, square = size * size;
    const int independent = int(b.words[slot + 2u]), solution = int(b.words[slot + 3u]), temporary = int(b.words[slot + 4u]);
    const int q = temporary + square, r = q + square, rectangle = temporary + 5 * square;
    // Independent RHS columns can run on separate blocks. Ascending-k dot
    // products and descending-row substitution match the CPU's binary32 sums.
    // Upstream's two exact Q transposes still cancel before this multiplication.
    for (int i = 0; i < size; ++i) {
        float value = 0;
        for (int k = 0; k < size; ++k) value += f[q + i * size + k] * f[independent + k * d.num_blocks + block];
        f[rectangle + i * d.num_blocks + block] = value;
    }
    for (int i = size - 1; i >= 0; --i) {
        float value = f[rectangle + i * d.num_blocks + block];
        for (int k = i + 1; k < size; ++k) value -= f[solution + k * d.num_blocks + block] * f[r + i * size + k];
        f[solution + i * d.num_blocks + block] = __fdiv_rn(value, f[r + i * size + i]);
    }
    float variance = 0;
    for (int i = 0; i < size; ++i) {
        const float value = __fdiv_rn(f[solution + i * d.num_blocks + block] * f[independent + i * d.num_blocks + block], 25.0f);
        variance = i == 0 ? value : variance + value;
    }
    f[output + size + block] = variance;
}
void check(cudaError_t status, const char *operation) {
    if (status != cudaSuccess) throw std::runtime_error(std::string(operation) + ": " + cudaGetErrorString(status));
}
using Clock = std::chrono::steady_clock;
double elapsed(Clock::time_point start) { return std::chrono::duration<double, std::milli>(Clock::now() - start).count(); }
vulkan_detail::SpeedParameters validated_parameters(const ExtractorSpec &spec, const FeaturePlan &p) {
    if (spec.name != "speed_chroma" || (p.bit_depth != 8 && p.bit_depth != 10) || !p.width || !p.height || p.width % 2 || p.height % 2)
        throw std::invalid_argument("CUDA parallel SPEED requires 8/10-bit 4:2:0 geometry");
    const std::set<std::string> names{"speed_kernelscale", "speed_prescale", "speed_prescale_method", "speed_sigma_nn", "speed_nn_floor", "speed_max_val", "speed_weight_var_mode"};
    for (const auto &[name, value] : spec.options) if (!names.count(name)) throw std::invalid_argument("unknown CUDA SPEED option: " + name);
    const auto number = [&](const char *name, double fallback) { return vulkan_detail::option(spec, name, fallback); };
    const float kernelscale = float(number("speed_kernelscale", 1.0));
    // The same official vif_validate_kernelscale table and tolerance.
    constexpr float valid[]{1.0f, 0.5f, 1.5f, 2.0f, 2.0f / 3.0f, 2.4f, 360.0f / 97.0f, 4.0f / 3.0f,
        3.5f / 3.0f, 3.75f / 3.0f, 4.25f / 3.0f, 5.0f / 3.0f, 3.0f, 1.0f / 2.25f, 1.4746f, 1.54f,
        1.6f, 1.06667f, 0.711111f, 0.740740f, 1.111111f};
    if (std::none_of(std::begin(valid), std::end(valid), [&](float value) { return std::abs(kernelscale - value) < 1e-3; }))
        throw std::invalid_argument("invalid CUDA SPEED kernelscale");
    const double floor = number("speed_nn_floor", 0), maximum = number("speed_max_val", 1000), weight = number("speed_weight_var_mode", 0), sigma = number("speed_sigma_nn", 0.29);
    if (floor < 0 || floor > 1 || maximum < 0 || maximum > 1000 || weight != std::floor(weight) || weight < 0 || weight > 6 || sigma < 0.1 || sigma > 2.0)
        throw std::invalid_argument("invalid CUDA SPEED noise, maximum, or variance mode");
    const auto method = vulkan_detail::text_option(spec, "speed_prescale_method", "nearest");
    if (method != "nearest" && method != "bilinear" && method != "bicubic" && method != "lanczos4")
        throw std::invalid_argument("invalid CUDA SPEED scaling method");
    if (spec.provided_features.empty()) throw std::invalid_argument("CUDA SPEED requires canonical collector names");
    const std::set<std::string> bases{"Speed_chroma_feature_speed_chroma_u_score", "Speed_chroma_feature_speed_chroma_v_score", "Speed_chroma_feature_speed_chroma_uv_score"};
    for (const auto &name : spec.provided_features) {
        const auto count = std::count_if(spec.canonical_names.begin(), spec.canonical_names.end(), [&](const auto &entry) { return entry.second == name; });
        const auto found = std::find_if(spec.canonical_names.begin(), spec.canonical_names.end(), [&](const auto &entry) { return entry.second == name && bases.count(entry.first); });
        if (count != 1 || found == spec.canonical_names.end()) throw std::invalid_argument("unmapped or duplicate CUDA SPEED canonical feature: " + name);
    }
    if (std::set<std::string>(spec.provided_features.begin(), spec.provided_features.end()).size() != spec.provided_features.size())
        throw std::invalid_argument("duplicate CUDA SPEED requested collector name");
    vulkan_detail::SpeedParameters result(spec, p);
    if (result.resize && result.scaled_width > 7680)
        throw std::invalid_argument("CUDA SPEED bilinear width exceeds the official limit");
    if (result.operating_width <= result.words[16] / 2 || result.operating_height <= result.words[16] / 2)
        throw std::invalid_argument("CUDA SPEED operating image is smaller than its reflection filter radius");
    return result;
}
}

struct CudaParallelSpeed::Impl {
    vulkan_detail::SpeedParameters parameters;
    FeaturePlan plan;
    cudaStream_t stream;
    int device = -1;
    unsigned *words = nullptr;
    cudaEvent_t start = nullptr, computed = nullptr, downloaded = nullptr;
    float *statistics_values = nullptr;
    std::size_t result_count = 0;
    BackendTimings timing;
    std::uint64_t pending_index = 0;
    bool failed = false, pending = false;
    Impl(const ExtractorSpec &spec, const FeaturePlan &p, cudaStream_t s) : parameters(validated_parameters(spec, p)), plan(p), stream(s) {
        try {
            check(cudaGetDevice(&device), "CUDA SPEED current device");
            check(cudaMalloc(&words, parameters.word_count * sizeof(unsigned)), "CUDA SPEED allocation");
            timing.allocated_bytes = parameters.word_count * sizeof(unsigned);
            check(cudaEventCreateWithFlags(&start, cudaEventBlockingSync), "CUDA SPEED start event");
            check(cudaEventCreateWithFlags(&computed, cudaEventBlockingSync), "CUDA SPEED computed event");
            check(cudaEventCreateWithFlags(&downloaded, cudaEventBlockingSync), "CUDA SPEED downloaded event");
            const auto begin = Clock::now();
            const auto configuration_bytes = parameters.words.size() * sizeof(unsigned);
            check(cudaMemcpyAsync(words, parameters.words.data(), configuration_bytes, cudaMemcpyHostToDevice, stream), "CUDA SPEED configuration upload");
            check(cudaEventRecord(downloaded, stream), "CUDA SPEED configuration event");
            check(cudaEventSynchronize(downloaded), "CUDA SPEED configuration completion");
            timing.upload_ms += elapsed(begin); timing.uploaded_bytes += configuration_bytes;
            result_count = 26 + parameters.blocks;
            // Pinned statistics make the D2H copies truly asynchronous. The
            // blocking event, rather than pageable-copy staging, waits for GPU
            // completion. Four small results allow U/V math and later model
            // configurations to run before the CPU evaluates logarithms.
            check(cudaMallocHost(&statistics_values, 4u * result_count * sizeof(float)), "CUDA SPEED pinned statistics");
        } catch (...) { cudaStreamSynchronize(stream); cleanup(); throw; }
    }
    void cleanup() noexcept {
        int previous = -1;
        const bool known = cudaGetDevice(&previous) == cudaSuccess;
        if (known && device >= 0 && previous != device) cudaSetDevice(device);
        if (pending) cudaStreamSynchronize(stream);
        cudaFree(words); words = nullptr;
        if (statistics_values) cudaFreeHost(statistics_values);
        statistics_values = nullptr;
        if (start) cudaEventDestroy(start);
        if (computed) cudaEventDestroy(computed);
        if (downloaded) cudaEventDestroy(downloaded);
        start = computed = downloaded = nullptr;
        if (known && device >= 0 && previous != device) cudaSetDevice(previous);
    }
    ~Impl() { cleanup(); }
    void validate_device() const {
        int current = -1; check(cudaGetDevice(&current), "CUDA SPEED current device");
        if (current != device) throw std::invalid_argument("CUDA SPEED current device changed");
    }
    void validate(const Picture &p) const {
        if (p.memory != PictureMemory::CudaDevice || p.device_index != device || p.bit_depth != plan.bit_depth)
            throw std::invalid_argument("CUDA SPEED inputs must belong to the configured CUDA device and bit depth");
        for (unsigned c = 0; c < 3; ++c) {
            const auto &plane = p.planes[c]; const unsigned w = c ? plan.width / 2 : plan.width, h = c ? plan.height / 2 : plan.height;
            if (!plane.data || plane.width != w || plane.height != h || plane.stride < std::size_t(w) * (plan.bit_depth == 8 ? 1u : 2u) ||
                (plan.bit_depth == 10 && (plane.stride % 2 || reinterpret_cast<std::uintptr_t>(plane.data) % 2)))
                throw std::invalid_argument("CUDA SPEED input plane has invalid geometry, stride, or alignment");
            cudaPointerAttributes attributes{};
            if (cudaPointerGetAttributes(&attributes, plane.data) != cudaSuccess) {
                cudaGetLastError();
                throw std::invalid_argument("CUDA SPEED input is not a CUDA allocation");
            }
            if (attributes.type != cudaMemoryTypeDevice || attributes.device != device)
                throw std::invalid_argument("CUDA SPEED input is not resident device memory on the configured device");
        }
    }
    void image(const Plane &input, const vulkan_detail::SpeedMatrixSlot &slot) {
        const auto &p = parameters;
        const Workspace b{words, static_cast<const unsigned char *>(input.data), input.stride};
        const auto dispatch = [&](unsigned mode, unsigned width, unsigned height, unsigned source, unsigned destination, unsigned extra = 0) {
            image_kernel<<<dim3((width + 15) / 16, (height + 15) / 16), dim3(16, 16), 0, stream>>>(b, {mode, width, height, source, destination, extra});
            check(cudaGetLastError(), "CUDA SPEED image pass");
        };
        dispatch(0, p.width, p.height, 0, p.frame_a);
        unsigned source = p.frame_a;
        if (p.resize) { dispatch(1, p.scaled_width, p.scaled_height, source, p.frame_b); source = p.frame_b; }
        dispatch(2, p.scaled_width, p.operating_height, source, p.temporary);
        dispatch(3, p.operating_width, p.operating_height, p.temporary, p.downscaled);
        dispatch(4, p.operating_width, p.operating_height, p.downscaled, p.temporary);
        dispatch(5, p.operating_width, p.operating_height, p.temporary, p.downscaled, p.downscaled);
        means_kernel<<<1, 32, 0, stream>>>(b, p.downscaled); check(cudaGetLastError(), "CUDA SPEED means pass");
        covariance_kernel<<<11, 32, 0, stream>>>(b, p.downscaled, slot.covariance); check(cudaGetLastError(), "CUDA SPEED covariance pass");
        // Retain the compact RHS before the next image reuses the large pixel
        // workspace. The matrix solver no longer reads a mutable image buffer.
        independent_kernel<<<(25u * p.blocks + 127u) / 128u, 128, 0, stream>>>(b, p.downscaled, slot.independent);
        check(cudaGetLastError(), "CUDA SPEED independent pass");
    }
    void enqueue(std::uint64_t index, const Picture &r, const Picture &d) {
        pending = true;
        pending_index = index;
        check(cudaEventRecord(start, stream), "CUDA SPEED start");
        image(r.planes[1], parameters.matrices[0]); image(d.planes[1], parameters.matrices[1]);
        image(r.planes[2], parameters.matrices[2]); image(d.planes[2], parameters.matrices[3]);
        const Workspace b{words, nullptr, 0};
        factor_kernel<<<4, 256, 0, stream>>>(b); check(cudaGetLastError(), "CUDA SPEED batched factor pass");
        solve_kernel<<<dim3((parameters.blocks + 31u) / 32u, 4), 32, 0, stream>>>(b);
        check(cudaGetLastError(), "CUDA SPEED batched solve pass");
        check(cudaEventRecord(computed, stream), "CUDA SPEED computed");
        const auto bytes = result_count * sizeof(float);
        for (unsigned i = 0; i < parameters.matrices.size(); ++i)
            check(cudaMemcpyAsync(statistics_values + i * result_count, words + parameters.matrices[i].result,
                bytes, cudaMemcpyDeviceToHost, stream), "CUDA SPEED statistics readback");
        check(cudaEventRecord(downloaded, stream), "CUDA SPEED downloaded");
    }
    std::vector<FeatureScore> collect() {
        check(cudaEventSynchronize(downloaded), "CUDA SPEED completion");
        float kernel_ms = 0, download_ms = 0;
        check(cudaEventElapsedTime(&kernel_ms, start, computed), "CUDA SPEED kernel timing");
        check(cudaEventElapsedTime(&download_ms, computed, downloaded), "CUDA SPEED download timing");
        timing.kernel_ms += kernel_ms; timing.extractor_kernel_ms["speed_chroma"] += kernel_ms;
        timing.download_ms += download_ms; timing.downloaded_bytes += 4u * result_count * sizeof(float);
        const auto begin = Clock::now();
        const auto u = parameters.channel_score(statistics_values, statistics_values + result_count);
        const auto v = parameters.channel_score(statistics_values + 2u * result_count, statistics_values + 3u * result_count);
        const float uv = u.second && !v.second ? v.first : v.second && !u.second ? u.first : float((u.first + v.first) / 2.0);
        const std::map<std::string, double> values{{"Speed_chroma_feature_speed_chroma_u_score", u.first}, {"Speed_chroma_feature_speed_chroma_v_score", v.first}, {"Speed_chroma_feature_speed_chroma_uv_score", uv}};
        std::vector<FeatureScore> result;
        for (const auto &[base, canonical] : parameters.spec.canonical_names) {
            if (std::find(parameters.spec.provided_features.begin(), parameters.spec.provided_features.end(), canonical) == parameters.spec.provided_features.end()) continue;
            const auto value = values.at(base);
            if (!std::isfinite(value)) throw std::runtime_error("CUDA SPEED produced a non-finite feature");
            result.push_back({pending_index, canonical, std::min(value, parameters.maximum)});
        }
        timing.cpu_postprocess_ms += elapsed(begin);
        pending = false;
        return result;
    }
};
CudaParallelSpeed::CudaParallelSpeed(const ExtractorSpec &spec, const FeaturePlan &plan, cudaStream_t stream) : impl_(std::make_unique<Impl>(spec, plan, stream)) {}
CudaParallelSpeed::~CudaParallelSpeed() = default;
BackendTimings CudaParallelSpeed::timings() const { return impl_->timing; }
std::vector<FeatureScore> CudaParallelSpeed::extract(std::uint64_t index, const Picture &r, const Picture &d) {
    enqueue(index, r, d);
    return collect();
}
void CudaParallelSpeed::enqueue(std::uint64_t index, const Picture &r, const Picture &d) {
    if (impl_->failed) throw std::logic_error("CUDA SPEED failed; create a new instance before reuse");
    if (impl_->pending) throw std::logic_error("CUDA SPEED already has a pending frame");
    impl_->validate_device();
    impl_->validate(r); impl_->validate(d);
    try {
        impl_->enqueue(index, r, d);
    } catch (...) {
        impl_->failed = true; cudaStreamSynchronize(impl_->stream); impl_->pending = false; throw;
    }
}
std::vector<FeatureScore> CudaParallelSpeed::collect() {
    if (impl_->failed) throw std::logic_error("CUDA SPEED failed; create a new instance before reuse");
    if (!impl_->pending) throw std::logic_error("CUDA SPEED has no pending frame");
    impl_->validate_device();
    try {
        return impl_->collect();
    } catch (...) {
        impl_->failed = true; cudaStreamSynchronize(impl_->stream); impl_->pending = false; throw;
    }
}
} // namespace bitovp::gpu
