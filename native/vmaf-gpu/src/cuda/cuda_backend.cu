// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
// CUDA runtime contracts: https://docs.nvidia.com/cuda/archive/13.0.1/cuda-runtime-api/
#include "bitovp_gpu.hpp"
#include "../driver_identity.hpp"
#include "../pci_bus_id.hpp"
#include <cuda_runtime.h>
#include "motion.cuh"
#include "parallel_cambi.hpp"
#include "parallel_adm.hpp"
#include "parallel_speed.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace bitovp::gpu {
namespace {

void checked(cudaError_t status, const char *operation) {
    if (status != cudaSuccess)
        throw std::runtime_error(std::string(operation) + ": " + cudaGetErrorString(status));
}

struct DeviceScope {
    int previous = -1;
    explicit DeviceScope(int device) {
        checked(cudaGetDevice(&previous), "cudaGetDevice");
        if (previous != device) checked(cudaSetDevice(device), "cudaSetDevice");
    }
    ~DeviceScope() { if (previous >= 0) cudaSetDevice(previous); }
};

struct Event {
    cudaEvent_t event = nullptr;
    Event() { checked(cudaEventCreateWithFlags(&event, cudaEventBlockingSync), "cudaEventCreate"); }
    ~Event() { if (event) cudaEventDestroy(event); }
    Event(const Event &) = delete;
    Event &operator=(const Event &) = delete;
};

double elapsed(const Event &from, const Event &to) {
    float milliseconds = 0;
    checked(cudaEventElapsedTime(&milliseconds, from.event, to.event), "cudaEventElapsedTime");
    return milliseconds;
}

template <typename Sample, bool Pitched>
__global__ void squared_errors(const Sample *reference, const Sample *distorted,
                               std::size_t reference_stride, std::size_t distorted_stride,
                               unsigned width, std::size_t samples, unsigned long long *sum) {
    __shared__ unsigned long long partial[256];
    unsigned long long local = 0;
    for (std::size_t i = blockIdx.x * blockDim.x + threadIdx.x; i < samples;
         i += static_cast<std::size_t>(blockDim.x) * gridDim.x) {
        std::size_t a = i, b = i;
        if constexpr (Pitched) {
            const std::size_t row = i / width, column = i % width;
            a = row * reference_stride + column;
            b = row * distorted_stride + column;
        }
        const long long difference = static_cast<long long>(reference[a]) - distorted[b];
        local += static_cast<unsigned long long>(difference * difference);
    }
    partial[threadIdx.x] = local;
    __syncthreads();
    for (unsigned offset = 128; offset; offset /= 2) {
        if (threadIdx.x < offset) partial[threadIdx.x] += partial[threadIdx.x + offset];
        __syncthreads();
    }
    if (threadIdx.x == 0) atomicAdd(sum, partial[0]);
}

template <typename Sample>
void launch_squared_errors(const Plane &reference, const Plane &distorted,
                           unsigned long long *sum, cudaStream_t stream) {
    const std::size_t samples = static_cast<std::size_t>(reference.width) * reference.height;
    const unsigned blocks = static_cast<unsigned>(std::min<std::size_t>((samples + 255) / 256, 4096));
    const auto a = static_cast<const Sample *>(reference.data);
    const auto b = static_cast<const Sample *>(distorted.data);
    const auto a_stride = reference.stride / sizeof(Sample), b_stride = distorted.stride / sizeof(Sample);
    if (a_stride == reference.width && b_stride == reference.width)
        squared_errors<Sample, false><<<blocks, 256, 0, stream>>>(
            a, b, a_stride, b_stride, reference.width, samples, sum);
    else
        squared_errors<Sample, true><<<blocks, 256, 0, stream>>>(
            a, b, a_stride, b_stride, reference.width, samples, sum);
}

struct Allocation {
    void *pointer = nullptr;
    std::size_t capacity = 0;
};

struct FailureDrain {
    cudaStream_t stream;
    bool *accepting = nullptr;
    bool armed = true;
    ~FailureDrain() {
        if (armed) {
            if (accepting) *accepting = false;
            cudaStreamSynchronize(stream);
        }
    }
};

struct MotionState {
    ExtractorSpec spec;
    double blend_factor = 1, blend_offset = 40, fps_weight = 1, maximum = 10000;
    bool five_frame = false, moving_average = false, force_zero = false;
    std::array<double, 4> sad{};
    double previous_processed = 0;
};

double option_number(const ExtractorSpec &spec, const char *name,
                     double fallback, double minimum, double maximum) {
    const auto found = spec.options.find(name);
    if (found == spec.options.end()) return fallback;
    std::size_t end = 0;
    const double value = std::stod(found->second, &end);
    if (end != found->second.size() || !std::isfinite(value) || value < minimum || value > maximum)
        throw std::invalid_argument(std::string("Invalid CUDA option: ") + name);
    return value;
}

bool option_bool(const ExtractorSpec &spec, const char *name, bool fallback = false) {
    const auto found = spec.options.find(name);
    if (found == spec.options.end()) return fallback;
    if (found->second == "true" || found->second == "1") return true;
    if (found->second == "false" || found->second == "0") return false;
    throw std::invalid_argument(std::string("Invalid CUDA boolean option: ") + name);
}

void emit(const ExtractorSpec &spec, std::vector<FeatureScore> &output,
          const char *base, double value, std::uint64_t index) {
    const auto found = spec.canonical_names.find(base);
    if (found != spec.canonical_names.end() &&
        std::find(spec.provided_features.begin(), spec.provided_features.end(), found->second)
            != spec.provided_features.end())
        output.push_back({index, found->second, value});
}

void accumulate(BackendTimings &to, const BackendTimings &from, bool memory) {
    to.upload_ms += from.upload_ms; to.kernel_ms += from.kernel_ms;
    to.download_ms += from.download_ms; to.cpu_postprocess_ms += from.cpu_postprocess_ms;
    to.uploaded_bytes += from.uploaded_bytes; to.downloaded_bytes += from.downloaded_bytes;
    to.device_copied_bytes += from.device_copied_bytes;
    if (memory) to.allocated_bytes += from.allocated_bytes;
    for (const auto &[name, time] : from.extractor_kernel_ms) to.extractor_kernel_ms[name] += time;
}

class CudaBackend final : public FeatureBackend {
public:
    explicit CudaBackend(const BackendOptions &options) {
        profile_ = options.profile;
        if (options.vendor_id && options.vendor_id != 0x10de)
            throw std::invalid_argument("CUDA requires an NVIDIA device (vendor 0x10de)");
        int count = 0;
        checked(cudaGetDeviceCount(&count), "cudaGetDeviceCount");
        device_index_ = options.device_index < 0 ? 0 : options.device_index;
        if (device_index_ < 0 || device_index_ >= count)
            throw std::invalid_argument("Requested CUDA device index is unavailable");
        DeviceScope scope(device_index_);
        cudaDeviceProp properties{};
        checked(cudaGetDeviceProperties(&properties, device_index_), "cudaGetDeviceProperties");
        info_.backend = "cuda";
        info_.index = device_index_;
        info_.name = properties.name;
        info_.vendor_id = 0x10de;
        info_.integrated = properties.integrated != 0;
        std::array<char, 32> pci{};
        checked(cudaDeviceGetPCIBusId(pci.data(), int(pci.size()), device_index_), "cudaDeviceGetPCIBusId");
        if (pci.back() == '\0') info_.pci_bus_id = normalize_pci_bus_id(pci.data());
        std::size_t free_bytes = 0, total_bytes = 0;
        checked(cudaMemGetInfo(&free_bytes, &total_bytes), "cudaMemGetInfo");
        if (!total_bytes || free_bytes > total_bytes)
            throw std::runtime_error("CUDA returned invalid device memory information");
        info_.memory_budget = free_bytes;
        info_.memory_total_bytes = total_bytes;
        info_.memory_available_bytes = free_bytes;
        info_.memory_available_source = "cuda-mem-get-info";
        int driver_api = 0;
        checked(cudaDriverGetVersion(&driver_api), "cudaDriverGetVersion");
        const auto driver = nvidia_driver_identity();
        info_.driver_version_known = !driver.version.empty();
        info_.driver_version_source = driver.version.empty() ? "cuda-api-only" : driver.source;
        info_.driver_version = (driver.version.empty() ? "unknown" : driver.version) +
            ";cuda-api=" + std::to_string(driver_api);
        std::ostringstream uuid;
        uuid << std::hex << std::setfill('0');
        for (unsigned i = 0; i < sizeof(properties.uuid.bytes); ++i)
            uuid << std::setw(2) << static_cast<unsigned>(
                static_cast<unsigned char>(properties.uuid.bytes[i]));
        info_.uuid = uuid.str();
        checked(cudaStreamCreateWithFlags(&stream_, cudaStreamNonBlocking), "cudaStreamCreate");
        try { reserve(sums_, sizeof(unsigned long long) * 3); }
        catch (...) { cudaStreamDestroy(stream_); stream_ = nullptr; throw; }
    }

    ~CudaBackend() override {
        int previous = -1;
        cudaGetDevice(&previous);
        cudaSetDevice(device_index_);
        if (stream_) cudaStreamSynchronize(stream_);
        parallel_cambi_.clear();
        parallel_adm_.clear();
        parallel_speed_.clear();
        for (auto &allocation : reference_) cudaFree(allocation.pointer);
        for (auto &allocation : distorted_) cudaFree(allocation.pointer);
        for (auto &allocation : history_) cudaFree(allocation.pointer);
        cudaFree(motion_vertical_.pointer);
        cudaFree(sums_.pointer);
        if (stream_) cudaStreamDestroy(stream_);
        if (previous >= 0) cudaSetDevice(previous);
    }

    DeviceInfo device() const override { return info_; }
    BackendTimings timings() const override {
        auto result = timing_;
        for (const auto &feature : parallel_cambi_) accumulate(result, feature->timings(), true);
        for (const auto &feature : parallel_adm_) accumulate(result, feature->timings(), true);
        for (const auto &feature : parallel_speed_) accumulate(result, feature->timings(), true);
        return result;
    }

    PsnrSums psnr(const Picture &reference, const Picture &distorted) override {
        return calculate_psnr(reference, distorted, true);
    }

private:
    PsnrSums calculate_psnr(const Picture &reference, const Picture &distorted, bool upload_inputs) {
        validate_pair(reference, distorted);
        DeviceScope scope(device_index_);
        FailureDrain failure{stream_};
        const unsigned bytes = reference.bit_depth > 8 ? 2 : 1;
        // Device planes stay borrowed until this synchronous call completes.
        const Picture reference_device = upload_inputs ? resident_view(reference, reference_) : reference;
        const Picture distorted_device = upload_inputs ? resident_view(distorted, distorted_) : distorted;
        Event start, uploaded, computed, downloaded;
        checked(cudaEventRecord(start.event, stream_), "cudaEventRecord start");
        if (upload_inputs) {
            wait_for_picture(reference);
            wait_for_picture(distorted);
            upload_host_picture(reference, reference_device);
            upload_host_picture(distorted, distorted_device);
        }
        checked(cudaEventRecord(uploaded.event, stream_), "cudaEventRecord uploaded");
        checked(cudaMemsetAsync(sums_.pointer, 0, sizeof(unsigned long long) * 3, stream_),
                "cudaMemsetAsync PSNR sums");
        auto *device_sums = static_cast<unsigned long long *>(sums_.pointer);
        PsnrSums result;
        for (unsigned plane = 0; plane < 3; ++plane) {
            const auto &a = reference.planes[plane];
            const std::size_t samples = static_cast<std::size_t>(a.width) * a.height;
            result.sample_count[plane] = samples;
            if (!samples) continue;
            if (bytes == 1)
                launch_squared_errors<std::uint8_t>(reference_device.planes[plane], distorted_device.planes[plane],
                                                   device_sums + plane, stream_);
            else
                launch_squared_errors<std::uint16_t>(reference_device.planes[plane], distorted_device.planes[plane],
                                                    device_sums + plane, stream_);
            checked(cudaGetLastError(), "CUDA squared_errors launch");
        }
        checked(cudaEventRecord(computed.event, stream_), "cudaEventRecord computed");
        checked(cudaMemcpyAsync(result.squared_error.data(), sums_.pointer,
            sizeof(unsigned long long) * 3, cudaMemcpyDeviceToHost, stream_),
            "cudaMemcpyAsync PSNR sums");
        checked(cudaEventRecord(downloaded.event, stream_), "cudaEventRecord downloaded");
        checked(cudaEventSynchronize(downloaded.event), "cudaEventSynchronize PSNR");
        timing_.upload_ms += elapsed(start, uploaded);
        timing_.kernel_ms += elapsed(uploaded, computed);
        timing_.extractor_kernel_ms["psnr"] += elapsed(uploaded, computed);
        timing_.download_ms += elapsed(computed, downloaded);
        timing_.downloaded_bytes += sizeof(unsigned long long) * 3;
        failure.armed = false;
        return result;
    }

public:
    void configure(const FeaturePlan &plan) override {
        configured_ = false;
        if ((plan.bit_depth != 8 && plan.bit_depth != 10) || plan.width < 3 || plan.height < 3 ||
            plan.width > 32768 || plan.height > 32768)
            throw std::invalid_argument("CUDA feature plan requires 8/10-bit dimensions of at least 3x3");
        std::vector<MotionState> motions;
        std::vector<ExtractorSpec> psnr_specs;
        std::vector<ExtractorSpec> cambi_specs;
        std::vector<ExtractorSpec> adm_specs;
        std::vector<ExtractorSpec> speed_specs;
        for (const auto &spec : plan.extractors) {
            if (spec.name == "cambi") {
                cambi_specs.push_back(spec);
                continue;
            }
            if (spec.name == "adm") {
                adm_specs.push_back(spec);
                continue;
            }
            if (spec.name == "speed_chroma") {
                speed_specs.push_back(spec);
                continue;
            }
            if (spec.name == "psnr") {
                for (const auto &[name, value] : spec.options) {
                    (void)value;
                    if (name != "enable_chroma" && name != "enable_mse" &&
                        name != "enable_apsnr" && name != "reduced_hbd_peak" && name != "min_sse")
                        throw std::invalid_argument("Unknown CUDA PSNR option: " + name);
                }
                if (option_bool(spec, "enable_apsnr"))
                    throw std::invalid_argument("CUDA APSNR aggregation is not part of the current feature contract");
                psnr_specs.push_back(spec);
                continue;
            }
            if (spec.name != "motion") throw std::invalid_argument("Unsupported CUDA extractor: " + spec.name);
            for (const auto &[name, value] : spec.options) {
                (void)value;
                if (name != "motion_blend_factor" && name != "motion_blend_offset" &&
                    name != "motion_fps_weight" && name != "motion_max_val" &&
                    name != "motion_five_frame_window" && name != "motion_moving_average" &&
                    name != "motion_force_zero" && name != "debug")
                    throw std::invalid_argument("Unknown CUDA motion option: " + name);
            }
            MotionState state;
            state.spec = spec;
            state.blend_factor = option_number(spec, "motion_blend_factor", 1, 0, 1);
            state.blend_offset = option_number(spec, "motion_blend_offset", 40, 0, 1000);
            state.fps_weight = option_number(spec, "motion_fps_weight", 1, 0, 5);
            state.maximum = option_number(spec, "motion_max_val", 10000, 0, 10000);
            state.five_frame = option_bool(spec, "motion_five_frame_window");
            state.moving_average = option_bool(spec, "motion_moving_average");
            state.force_zero = option_bool(spec, "motion_force_zero");
            motions.push_back(std::move(state));
        }
        DeviceScope scope(device_index_);
        FailureDrain failure{stream_, &configured_};
        for (const auto &feature : parallel_cambi_) accumulate(timing_, feature->timings(), false);
        for (const auto &feature : parallel_adm_) accumulate(timing_, feature->timings(), false);
        for (const auto &feature : parallel_speed_) accumulate(timing_, feature->timings(), false);
        parallel_cambi_.clear();
        parallel_adm_.clear();
        parallel_speed_.clear();
        std::vector<std::unique_ptr<CudaParallelCambi>> cambi;
        for (const auto &spec : cambi_specs)
            cambi.push_back(std::make_unique<CudaParallelCambi>(spec, plan, stream_, profile_));
        std::vector<std::unique_ptr<CudaParallelAdm>> adm;
        for (const auto &spec : adm_specs)
            adm.push_back(std::make_unique<CudaParallelAdm>(spec, plan, stream_));
        std::vector<std::unique_ptr<CudaParallelSpeed>> speed;
        for (const auto &spec : speed_specs)
            speed.push_back(std::make_unique<CudaParallelSpeed>(spec, plan, stream_));
        const std::size_t samples = static_cast<std::size_t>(plan.width) * plan.height;
        if (!motions.empty()) {
            for (auto &allocation : history_) reserve(allocation, samples * (plan.bit_depth > 8 ? 2 : 1));
            reserve(motion_vertical_, samples * sizeof(std::int32_t));
        }
        plan_ = plan;
        motions_ = std::move(motions);
        psnr_specs_ = std::move(psnr_specs);
        parallel_cambi_ = std::move(cambi);
        parallel_adm_ = std::move(adm);
        parallel_speed_ = std::move(speed);
        frame_count_ = 0;
        flushed_ = false;
        configured_ = true;
        failure.armed = false;
    }
    std::vector<FeatureScore> extract(std::uint64_t index, const Picture &reference,
                                      const Picture &distorted) override {
        if (!configured_ || flushed_) throw std::runtime_error("CUDA feature context is not accepting input");
        if (index != frame_count_) throw std::invalid_argument("CUDA feature indices must start at zero and be contiguous");
        validate_pair(reference, distorted);
        if (reference.bit_depth != plan_.bit_depth || reference.planes[0].width != plan_.width ||
            reference.planes[0].height != plan_.height)
            throw std::invalid_argument("CUDA picture does not match configured geometry");
        DeviceScope scope(device_index_);
        FailureDrain failure{stream_, &configured_};
        const std::size_t bytes = plan_.bit_depth > 8 ? 2 : 1;
        const std::size_t row_bytes = static_cast<std::size_t>(plan_.width) * bytes;
        const std::size_t frame_bytes = row_bytes * plan_.height;
        const Picture reference_device = resident_view(reference, reference_);
        const Picture distorted_device = resident_view(distorted, distorted_);
        Event start, uploaded;
        checked(cudaEventRecord(start.event, stream_), "cudaEventRecord feature upload");
        wait_for_picture(reference);
        wait_for_picture(distorted);
        upload_host_picture(reference, reference_device);
        upload_host_picture(distorted, distorted_device);
        checked(cudaEventRecord(uploaded.event, stream_), "cudaEventRecord feature uploaded");
        checked(cudaEventSynchronize(uploaded.event), "CUDA feature upload completion");
        timing_.upload_ms += elapsed(start, uploaded);
        std::vector<FeatureScore> output;
        for (auto &cambi : parallel_cambi_)
            output.push_back(cambi->extract(index, distorted_device.planes[0]));
        for (auto &adm : parallel_adm_) {
            auto scores = adm->extract(index, reference_device.planes[0], distorted_device.planes[0]);
            output.insert(output.end(), scores.begin(), scores.end());
        }
        for (auto &speed : parallel_speed_) {
            auto scores = speed->extract(index, reference_device, distorted_device);
            output.insert(output.end(), scores.begin(), scores.end());
        }
        if (!psnr_specs_.empty()) {
            // Reuse the same resident planes as ADM, CAMBI, SPEED and motion.
            const auto sums = calculate_psnr(reference_device, distorted_device, false);
            static const char *names[] = {"psnr_y", "psnr_cb", "psnr_cr"};
            static const char *mse_names[] = {"mse_y", "mse_cb", "mse_cr"};
            for (const auto &spec : psnr_specs_) {
                const bool chroma = option_bool(spec, "enable_chroma", true);
                const bool reduced = option_bool(spec, "reduced_hbd_peak");
                const double min_sse = option_number(spec, "min_sse", 0, 0, std::numeric_limits<double>::max());
                const double peak = reduced ? 255 * (1u << (plan_.bit_depth - 8)) :
                                             (1u << plan_.bit_depth) - 1;
                for (unsigned p = 0; p < (chroma ? 3u : 1u); ++p) {
                    if (!sums.sample_count[p]) continue;
                    const double mse = static_cast<double>(sums.squared_error[p]) / sums.sample_count[p];
                    const double maximum = min_sse != 0 ?
                        std::ceil(10.0 * std::log10(peak * peak / (min_sse / sums.sample_count[p]))) :
                        6 * plan_.bit_depth + 12;
                    const double score = std::min(10.0 * std::log10(peak * peak / std::max(mse, 1e-16)), maximum);
                    emit(spec, output, names[p], score, index);
                    if (option_bool(spec, "enable_mse")) emit(spec, output, mse_names[p], mse, index);
                }
            }
        }
        for (auto &state : motions_) {
            const unsigned stride = state.five_frame ? 2 : 1;
            double sad = 0;
            if (!state.force_zero && index >= stride) {
                const auto sum = motion_sad(history_[(index - stride) % 2].pointer, reference_device.planes[0]);
                sad = std::min(static_cast<double>(sum) / 256.0 /
                    (static_cast<std::size_t>(plan_.width) * plan_.height) * state.fps_weight,
                    state.maximum);
            }
            state.sad[index % state.sad.size()] = sad;
            emit(state.spec, output, "VMAF_integer_feature_motion_sad_score", sad, index);
            emit(state.spec, output, "VMAF_integer_feature_motion_score", sad, index);
            if (index == stride) {
                const double stamp = blend(state, sad);
                for (unsigned i = 0; i < stride; ++i) {
                    emit(state.spec, output, "VMAF_integer_feature_motion2_score", 0, i);
                    emit(state.spec, output, "VMAF_integer_feature_motion3_score", stamp, i);
                }
                state.previous_processed = stamp;
            }
            if (index > stride) emit_motion(state, index - 1, true, output);
        }
        if (!motions_.empty()) {
            checked(cudaMemcpy2DAsync(history_[index % 2].pointer, row_bytes,
                reference_device.planes[0].data, reference_device.planes[0].stride,
                row_bytes, plan_.height, cudaMemcpyDeviceToDevice, stream_), "CUDA retain motion history");
            timing_.device_copied_bytes += frame_bytes;
        }
        checked(cudaStreamSynchronize(stream_), "CUDA motion history completion");
        ++frame_count_;
        failure.armed = false;
        return output;
    }
    std::vector<FeatureScore> flush() override {
        if (!configured_) throw std::runtime_error("CUDA feature plan has not been configured");
        if (flushed_) return {};
        std::vector<FeatureScore> output;
        for (auto &state : motions_) {
            const unsigned stride = state.five_frame ? 2 : 1;
            if (frame_count_ <= stride) {
                for (std::uint64_t i = 0; i < frame_count_; ++i) {
                    emit(state.spec, output, "VMAF_integer_feature_motion2_score", 0, i);
                    emit(state.spec, output, "VMAF_integer_feature_motion3_score", 0, i);
                }
            } else emit_motion(state, frame_count_ - 1, false, output);
        }
        flushed_ = true;
        return output;
    }

private:
    bool profile_ = false;
    static double blend(const MotionState &state, double score) {
        return std::min(score * state.blend_factor +
            (1.0 - state.blend_factor) * std::min(state.blend_offset, score), state.maximum);
    }

    static void emit_motion(MotionState &state, std::uint64_t index, bool has_next,
                            std::vector<FeatureScore> &output) {
        const unsigned stride = state.five_frame ? 2 : 1;
        double motion2 = state.sad[index % state.sad.size()];
        if (has_next) {
            const std::uint64_t lo = index - (stride - 1);
            motion2 = lo >= stride ? std::min(state.sad[lo % state.sad.size()],
                                              state.sad[(index + 1) % state.sad.size()])
                                  : state.sad[(index + 1) % state.sad.size()];
        }
        const double processed = blend(state, motion2);
        const double motion3 = state.moving_average ?
            (processed + state.previous_processed) / 2.0 : processed;
        state.previous_processed = processed;
        emit(state.spec, output, "VMAF_integer_feature_motion2_score", motion2, index);
        emit(state.spec, output, "VMAF_integer_feature_motion3_score", motion3, index);
    }

    std::uint64_t motion_sad(const void *previous, const Plane &current) {
        Event start, computed, downloaded;
        checked(cudaEventRecord(start.event, stream_), "CUDA motion kernel start");
        const std::size_t count = static_cast<std::size_t>(plan_.width) * plan_.height;
        const unsigned blocks = static_cast<unsigned>(std::min<std::size_t>((count + 255) / 256, 4096));
        auto *vertical = static_cast<std::int32_t *>(motion_vertical_.pointer);
        auto *sum = static_cast<unsigned long long *>(sums_.pointer);
        checked(cudaMemsetAsync(sum, 0, sizeof(*sum), stream_), "CUDA reset motion sum");
        if (plan_.bit_depth == 8)
            motion_cuda::vertical<<<blocks, 256, 0, stream_>>>(
                static_cast<const std::uint8_t *>(previous),
                static_cast<const std::uint8_t *>(current.data), current.stride,
                vertical, plan_.width, plan_.height, plan_.bit_depth);
        else
            motion_cuda::vertical<<<blocks, 256, 0, stream_>>>(
                static_cast<const std::uint16_t *>(previous),
                static_cast<const std::uint16_t *>(current.data), current.stride / 2,
                vertical, plan_.width, plan_.height, plan_.bit_depth);
        checked(cudaGetLastError(), "CUDA motion vertical launch");
        motion_cuda::horizontal_sad<<<blocks, 256, 0, stream_>>>(
            vertical, plan_.width, plan_.height, sum);
        checked(cudaGetLastError(), "CUDA motion horizontal launch");
        checked(cudaEventRecord(computed.event, stream_), "CUDA motion computed");
        std::uint64_t result = 0;
        checked(cudaMemcpyAsync(&result, sum, sizeof(result), cudaMemcpyDeviceToHost, stream_),
                "CUDA motion SAD readback");
        checked(cudaEventRecord(downloaded.event, stream_), "CUDA motion downloaded");
        checked(cudaEventSynchronize(downloaded.event), "CUDA motion complete");
        timing_.kernel_ms += elapsed(start, computed);
        timing_.extractor_kernel_ms["motion"] += elapsed(start, computed);
        timing_.download_ms += elapsed(computed, downloaded);
        timing_.downloaded_bytes += sizeof(result);
        return result;
    }

    void wait_for_picture(const Picture &picture) {
        if (picture.cuda_ready_event)
            checked(cudaStreamWaitEvent(stream_, static_cast<cudaEvent_t>(picture.cuda_ready_event), 0),
                    "CUDA wait for picture producer");
    }

    void validate_pair(const Picture &a, const Picture &b) const {
        for (const auto *picture : {&a, &b}) {
            if (picture->memory != PictureMemory::CudaDevice && picture->cuda_ready_event)
                throw std::invalid_argument("CUDA readiness events require device pictures");
            if ((picture->memory != PictureMemory::Host && picture->memory != PictureMemory::CudaDevice) ||
                (picture->memory == PictureMemory::CudaDevice && picture->device_index != device_index_))
                throw std::invalid_argument("CUDA picture memory domain or device does not match the backend");
        }
        if (a.bit_depth != b.bit_depth || (a.bit_depth != 8 && a.bit_depth != 10))
            throw std::invalid_argument("CUDA input requires matching 8- or 10-bit pictures");
        const std::size_t bytes = a.bit_depth > 8 ? 2 : 1;
        for (unsigned plane = 0; plane < 3; ++plane) {
            const auto &x = a.planes[plane];
            const auto &y = b.planes[plane];
            if (x.width != y.width || x.height != y.height ||
                ((x.width == 0) != (x.height == 0)))
                throw std::invalid_argument("CUDA input plane dimensions do not match");
            if (!x.width) {
                if (plane == 0) throw std::invalid_argument("CUDA luma plane is empty");
                continue;
            }
            const std::size_t row_bytes = static_cast<std::size_t>(x.width) * bytes;
            if (!x.data || !y.data || x.stride < row_bytes || y.stride < row_bytes ||
                x.stride % bytes || y.stride % bytes)
                throw std::invalid_argument("CUDA input plane data or stride is invalid");
            if ((a.memory == PictureMemory::CudaDevice && reinterpret_cast<std::uintptr_t>(x.data) % bytes) ||
                (b.memory == PictureMemory::CudaDevice && reinterpret_cast<std::uintptr_t>(y.data) % bytes))
                throw std::invalid_argument("CUDA resident input sample alignment is invalid");
            const std::uint64_t maximum = (std::uint64_t{1} << a.bit_depth) - 1;
            if (static_cast<std::uint64_t>(x.width) * x.height >
                std::numeric_limits<std::uint64_t>::max() / (maximum * maximum))
                throw std::invalid_argument("CUDA input exceeds the uint64 squared-error range");
        }
    }

    Picture resident_view(const Picture &input, std::array<Allocation, 3> &storage) {
        if (input.memory == PictureMemory::CudaDevice) return input;
        Picture result = input;
        result.memory = PictureMemory::CudaDevice;
        result.device_index = device_index_;
        const unsigned bytes = input.bit_depth > 8 ? 2 : 1;
        for (unsigned p = 0; p < 3; ++p) {
            const auto &plane = input.planes[p];
            const std::size_t row_bytes = static_cast<std::size_t>(plane.width) * bytes;
            reserve(storage[p], row_bytes * plane.height);
            result.planes[p] = {storage[p].pointer, row_bytes, plane.width, plane.height};
        }
        return result;
    }

    void upload_host_picture(const Picture &source, const Picture &destination) {
        if (source.memory != PictureMemory::Host) return;
        const unsigned bytes = source.bit_depth > 8 ? 2 : 1;
        for (unsigned p = 0; p < 3; ++p) {
            const auto &plane = source.planes[p];
            if (!plane.width || !plane.height) continue;
            const std::size_t row_bytes = static_cast<std::size_t>(plane.width) * bytes;
            checked(cudaMemcpy2DAsync(const_cast<void *>(destination.planes[p].data),
                destination.planes[p].stride, plane.data, plane.stride,
                row_bytes, plane.height, cudaMemcpyHostToDevice, stream_), "CUDA host picture upload");
            timing_.uploaded_bytes += row_bytes * plane.height;
        }
    }

    void reserve(Allocation &allocation, std::size_t bytes) {
        if (bytes <= allocation.capacity) return;
        void *replacement = nullptr;
        checked(cudaMalloc(&replacement, bytes), "cudaMalloc");
        if (allocation.pointer) {
            const auto status = cudaFree(allocation.pointer);
            if (status != cudaSuccess) { cudaFree(replacement); checked(status, "cudaFree resize"); }
        }
        timing_.allocated_bytes -= allocation.capacity;
        allocation.pointer = replacement;
        allocation.capacity = bytes;
        timing_.allocated_bytes += bytes;
    }

    int device_index_ = -1;
    cudaStream_t stream_ = nullptr;
    DeviceInfo info_;
    BackendTimings timing_;
    std::array<Allocation, 3> reference_, distorted_;
    std::array<Allocation, 2> history_;
    Allocation motion_vertical_;
    Allocation sums_;
    FeaturePlan plan_;
    std::vector<MotionState> motions_;
    std::vector<ExtractorSpec> psnr_specs_;
    std::vector<std::unique_ptr<CudaParallelCambi>> parallel_cambi_;
    std::vector<std::unique_ptr<CudaParallelAdm>> parallel_adm_;
    std::vector<std::unique_ptr<CudaParallelSpeed>> parallel_speed_;
    std::uint64_t frame_count_ = 0;
    bool configured_ = false, flushed_ = false;
};
}

std::unique_ptr<FeatureBackend> create_cuda_backend(const BackendOptions &options) {
    return std::make_unique<CudaBackend>(options);
}
} // namespace bitovp::gpu
