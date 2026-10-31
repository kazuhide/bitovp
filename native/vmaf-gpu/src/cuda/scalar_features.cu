// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
// Mathematical routines included below retain Netflix's BSD+Patent notices.
#include "scalar_features.hpp"
#include "device_environment.cuh"
#include <algorithm>
#include <limits>
#include <stdexcept>
#include <utility>

namespace bitovp::gpu::scalar_cuda { using FILE = void; }
#include "generated/adm.cuh"
#undef div_lookup
#include "generated/cambi.cuh"
#include "generated/speed.cuh"
#undef strcmp
#undef sqrt
#undef log2
#undef log
#undef log10
#undef exp
#undef ceil
#undef floor
#undef fabs
#undef pow

namespace bitovp::gpu {
namespace {
using namespace scalar_cuda;

void check(cudaError_t status, const char *operation) {
    if (status != cudaSuccess)
        throw std::runtime_error(std::string(operation) + ": " + cudaGetErrorString(status));
}

enum Kind { Adm, Cambi, Speed };
struct Result { VmafFeatureCollector scores; int error; std::size_t used; };

__global__ void feature_kernel(Kind kind, void *state, Params *params, Arena *arena,
    VmafPicture reference, VmafPicture distorted, unsigned index, bool initialize,
    Result *result) {
    active_arena() = arena;
    result->scores.count = 0;
    result->error = 0;
    if (initialize) {
        arena->used = 0;
        arena->error = 0;
        arena->division_lookup = allocate(65537 * sizeof(std::int32_t));
        if (!arena->division_lookup) { result->error = -ENOMEM; return; }
        VmafFeatureExtractor fex;
        fex.priv = state;
        if (kind == Adm) {
            auto *s = static_cast<adm::AdmState *>(state);
            adm::own_set_options(s, params);
            s->dwt2_8 = adm::adm_dwt2_8;
            s->dwt2_16 = adm::adm_dwt2_16;
            s->adm_decouple = adm::adm_decouple;
            s->adm_decouple_s123 = adm::adm_decouple_s123;
            s->adm_csf = adm::adm_csf;
            s->i4_adm_csf = adm::i4_adm_csf;
            s->adm_csf_den_scale = adm::adm_csf_den_scale;
            s->adm_csf_den_s123 = adm::adm_csf_den_s123;
            s->adm_cm = adm::adm_cm;
            s->i4_adm_cm = adm::i4_adm_cm;
            s->adm_dwt2_s123_combined = adm::adm_dwt2_s123_combined;
            result->error = adm::adm_buffer_alloc(&s->buf, reference.w[0], reference.h[0]);
        } else if (kind == Cambi) {
            cambi::own_set_options(static_cast<cambi::CambiState *>(state), params);
            result->error = cambi::init(&fex, reference.pix_fmt, reference.bpc,
                                        reference.w[0], reference.h[0]);
        } else {
            speed::own_set_options(static_cast<speed::SpeedChromaState *>(state), params);
            result->error = speed::init_chroma(&fex, reference.pix_fmt, reference.bpc,
                                              reference.w[0], reference.h[0]);
        }
        arena->persistent = arena->used;
    }
    arena->used = arena->persistent;
    if (result->error || arena->error) { result->error = result->error ? result->error : -arena->error; return; }
    VmafFeatureExtractor fex;
    fex.priv = state;
    if (kind == Adm) {
        auto *s = static_cast<adm::AdmState *>(state);
        adm::AdmScore out[2]{};
        adm::integer_compute_adm(s, &reference, &distorted, &s->buf, out);
        const double adm3 = fmax(out[0].score * s->adm_dlm_weight +
            (1 - out[0].aim) * (1 - s->adm_dlm_weight), s->adm_min_val);
        vmaf_feature_collector_append_with_dict(&result->scores, nullptr,
            "VMAF_integer_feature_adm3_score", adm3, index);
        vmaf_feature_collector_append_with_dict(&result->scores, nullptr,
            "VMAF_integer_feature_adm2_score", out[0].score, index);
        vmaf_feature_collector_append_with_dict(&result->scores, nullptr,
            "VMAF_integer_feature_aim_score", out[0].aim, index);
    } else if (kind == Cambi)
        result->error = cambi::extract(&fex, &reference, nullptr, &distorted,
                                        nullptr, index, &result->scores);
    else
        result->error = speed::extract_chroma(&fex, &reference, nullptr, &distorted,
                                             nullptr, index, &result->scores);
    if (arena->error) result->error = -arena->error;
    result->used = arena->peak;
}

VmafPicture device_picture(const Picture &picture) {
    VmafPicture result;
    result.bpc = picture.bit_depth;
    const auto &y = picture.planes[0], &c = picture.planes[1];
    result.pix_fmt = !c.width ? VMAF_PIX_FMT_YUV400P :
        c.width == y.width ? VMAF_PIX_FMT_YUV444P :
        c.height == y.height ? VMAF_PIX_FMT_YUV422P : VMAF_PIX_FMT_YUV420P;
    for (unsigned p = 0; p < 3; ++p) {
        result.w[p] = picture.planes[p].width;
        result.h[p] = picture.planes[p].height;
        result.stride[p] = picture.planes[p].stride;
        result.data[p] = const_cast<void *>(picture.planes[p].data);
    }
    result.ref = (void *)1;
    return result;
}
}

struct CudaScalarFeatures::Impl {
    struct Instance {
        ExtractorSpec spec;
        Kind kind;
        void *state = nullptr;
        Params *params = nullptr;
        Arena *arena = nullptr;
        unsigned char *storage = nullptr;
        std::size_t capacity = 0;
        bool initialized = false;
        ~Instance() { cudaFree(state); cudaFree(params); cudaFree(arena); cudaFree(storage); }
    };
    cudaStream_t stream;
    BackendTimings timing;
    std::vector<std::unique_ptr<Instance>> instances;
    Result *result_device = nullptr;

    Impl(const FeaturePlan &plan, cudaStream_t stream) : stream(stream) {
        try {
            check(cudaMalloc(&result_device, sizeof(Result)), "CUDA feature result allocation");
            timing.allocated_bytes += sizeof(Result);
            for (const auto &spec : plan.extractors) {
                if (spec.name == "motion" || spec.name == "psnr") continue;
                auto instance = std::make_unique<Instance>();
                instance->spec = spec;
                const Option *options = nullptr;
                std::size_t count = 0, state_size = 0, bytes_per_pixel = 0;
                if (spec.name == "adm") {
                    instance->kind = Adm; options = adm::own_options;
                    count = sizeof(adm::own_options) / sizeof(Option);
                    state_size = sizeof(adm::AdmState); bytes_per_pixel = 40;
                } else if (spec.name == "cambi") {
                    instance->kind = Cambi; options = cambi::own_options;
                    count = sizeof(cambi::own_options) / sizeof(Option);
                    state_size = sizeof(cambi::CambiState); bytes_per_pixel = 16;
                } else if (spec.name == "speed_chroma") {
                    instance->kind = Speed; options = speed::own_options;
                    count = sizeof(speed::own_options) / sizeof(Option);
                    state_size = sizeof(speed::SpeedChromaState); bytes_per_pixel = 48;
                } else throw std::invalid_argument("Unsupported CUDA scalar extractor: " + spec.name);
                Params params{};
                for (const auto &entry : spec.options) {
                    const auto &name = entry.first;
                    if (std::find_if(options, options + count, [&](const Option &option) {
                        return name == option.name;
                    }) == options + count)
                        throw std::invalid_argument("Unknown CUDA " + spec.name + " option: " + name);
                }
                for (std::size_t i = 0; i < count; ++i) {
                    const auto found = spec.options.find(options[i].name);
                    if (options[i].string) {
                        const std::string value = found == spec.options.end() ?
                            (options[i].text ? options[i].text : "") : found->second;
                        if (std::string(options[i].name) == "heatmaps_path" && !value.empty())
                            throw std::invalid_argument("CUDA feature engine does not write heatmap files");
                        if (value.size() >= sizeof(params.text[i])) throw std::invalid_argument("CUDA option text is too long");
                        std::memcpy(params.text[i], value.c_str(), value.size() + 1);
                    } else if (options[i].boolean) {
                        if (found == spec.options.end()) params.number[i] = options[i].value;
                        else if (found->second == "true" || found->second == "1") params.number[i] = 1;
                        else if (found->second == "false" || found->second == "0") params.number[i] = 0;
                        else throw std::invalid_argument("Invalid CUDA boolean option");
                    } else {
                        std::size_t end = 0;
                        const double value = found == spec.options.end() ? options[i].value : std::stod(found->second, &end);
                        if (!std::isfinite(value) || (found != spec.options.end() &&
                            ((value != options[i].value &&
                              (value < options[i].minimum || value > options[i].maximum)) ||
                             end != found->second.size())))
                            throw std::invalid_argument("Invalid CUDA numeric option: " + std::string(options[i].name));
                        params.number[i] = value;
                    }
                }
                // Each instance has a bounded device arena. Persistent allocations
                // survive frames; temporary scalar scratch resets to a watermark.
                instance->capacity = static_cast<std::size_t>(plan.width) * plan.height * bytes_per_pixel + 16 * 1024 * 1024;
                check(cudaMalloc(&instance->storage, instance->capacity), "CUDA feature arena allocation");
                check(cudaMalloc(&instance->arena, sizeof(Arena)), "CUDA feature arena metadata");
                Arena arena{instance->storage, instance->capacity, 0, 0, 0, 0, nullptr};
                check(cudaMemcpyAsync(instance->arena, &arena, sizeof(arena), cudaMemcpyHostToDevice, stream), "CUDA feature arena initialization");
                check(cudaMalloc(&instance->state, state_size), "CUDA scalar state allocation");
                check(cudaMemsetAsync(instance->state, 0, state_size, stream), "CUDA scalar state initialization");
                check(cudaMalloc(&instance->params, sizeof(Params)), "CUDA feature options allocation");
                check(cudaMemcpyAsync(instance->params, &params, sizeof(params), cudaMemcpyHostToDevice, stream), "CUDA feature options upload");
                check(cudaStreamSynchronize(stream), "CUDA scalar setup completion");
                timing.uploaded_bytes += sizeof(arena) + sizeof(params);
                timing.allocated_bytes += instance->capacity + sizeof(Arena) + sizeof(Params) + state_size;
                instances.push_back(std::move(instance));
            }
        } catch (...) { cudaStreamSynchronize(stream); cudaFree(result_device); result_device = nullptr; throw; }
    }
    ~Impl() { cudaStreamSynchronize(stream); instances.clear(); cudaFree(result_device); }
};

CudaScalarFeatures::CudaScalarFeatures(const FeaturePlan &plan, cudaStream_t stream)
    : impl_(std::make_unique<Impl>(plan, stream)) {}
CudaScalarFeatures::~CudaScalarFeatures() = default;
BackendTimings CudaScalarFeatures::timings() const { return impl_->timing; }

std::vector<FeatureScore> CudaScalarFeatures::extract(std::uint64_t index,
    const Picture &reference_device, const Picture &distorted_device) {
    if (index > std::numeric_limits<unsigned>::max())
        throw std::invalid_argument("CUDA scalar frame index exceeds the official unsigned index range");
    const auto reference = device_picture(reference_device), distorted = device_picture(distorted_device);
    std::vector<FeatureScore> output;
    for (auto &instance : impl_->instances) {
        cudaEvent_t start = nullptr, computed = nullptr, downloaded = nullptr;
        try {
            check(cudaEventCreateWithFlags(&start, cudaEventBlockingSync), "CUDA scalar start event");
            check(cudaEventCreateWithFlags(&computed, cudaEventBlockingSync), "CUDA scalar computed event");
            check(cudaEventCreateWithFlags(&downloaded, cudaEventBlockingSync), "CUDA scalar readback event");
            check(cudaEventRecord(start, impl_->stream), "CUDA scalar start");
            feature_kernel<<<1, 1, 0, impl_->stream>>>(instance->kind, instance->state,
                instance->params, instance->arena, reference, distorted,
                static_cast<unsigned>(index), !instance->initialized, impl_->result_device);
            check(cudaGetLastError(), "CUDA scalar feature launch");
            check(cudaEventRecord(computed, impl_->stream), "CUDA scalar computed");
            Result result{};
            check(cudaMemcpyAsync(&result, impl_->result_device, sizeof(result), cudaMemcpyDeviceToHost,
                                  impl_->stream), "CUDA scalar feature readback");
            check(cudaEventRecord(downloaded, impl_->stream), "CUDA scalar downloaded");
            check(cudaEventSynchronize(downloaded), "CUDA scalar feature completion");
            float kernel_ms = 0, download_ms = 0;
            check(cudaEventElapsedTime(&kernel_ms, start, computed), "CUDA scalar kernel timing");
            check(cudaEventElapsedTime(&download_ms, computed, downloaded), "CUDA scalar download timing");
            impl_->timing.kernel_ms += kernel_ms;
            impl_->timing.extractor_kernel_ms[instance->spec.name] += kernel_ms;
            impl_->timing.download_ms += download_ms;
            impl_->timing.downloaded_bytes += sizeof(result);
            if (result.error) throw std::runtime_error("CUDA device scalar extractor " + instance->spec.name +
                " failed with code " + std::to_string(result.error));
            instance->initialized = true;
            for (const auto &[base, canonical] : instance->spec.canonical_names) {
                if (std::find(instance->spec.provided_features.begin(), instance->spec.provided_features.end(), canonical)
                    == instance->spec.provided_features.end()) continue;
                const auto hash = name_hash(base.c_str());
                const auto found = std::find_if(result.scores.values, result.scores.values + result.scores.count,
                    [&](const Record &record) { return record.name == hash; });
                if (found == result.scores.values + result.scores.count)
                    throw std::runtime_error("CUDA scalar extractor omitted required feature: " + base);
                if (!std::isfinite(found->value)) throw std::runtime_error("CUDA scalar extractor produced a non-finite feature");
                output.push_back({index, canonical, found->value});
            }
        } catch (...) {
            cudaStreamSynchronize(impl_->stream);
            cudaEventDestroy(start); cudaEventDestroy(computed); cudaEventDestroy(downloaded);
            throw;
        }
        cudaEventDestroy(start); cudaEventDestroy(computed); cudaEventDestroy(downloaded);
    }
    return output;
}
} // namespace bitovp::gpu
