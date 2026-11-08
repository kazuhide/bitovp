// SPDX-License-Identifier: MIT
#include "cuda/parallel_adm.hpp"
#include "cuda/scalar_features.hpp"
#include "model_oracle.hpp"
#include <libvmaf/libvmaf.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <map>
#include <stdexcept>

using namespace bitovp::gpu;
namespace {
void check(cudaError_t status, const char *message) {
    if (status != cudaSuccess) throw std::runtime_error(std::string(message) + ": " + cudaGetErrorString(status));
}
struct Frame {
    Picture picture;
    std::array<std::vector<std::uint16_t>, 3> storage;
    Frame(unsigned width, unsigned height, unsigned depth, unsigned index, bool distorted, bool textured) {
        picture.bit_depth = depth;
        for (unsigned p = 0; p < 3; ++p) {
            const unsigned w = width >> (p != 0), h = height >> (p != 0);
            const std::size_t stride = (w + 13 + p * 8) * (depth == 8 ? 1 : 2);
            storage[p].assign((stride * h + 1) / 2, 0xa5a5);
            auto *bytes = reinterpret_cast<unsigned char *>(storage[p].data());
            for (unsigned y = 0; y < h; ++y) for (unsigned x = 0; x < w; ++x) {
                std::uint32_t noise = ((x + index) * 73856093u) ^ (y * 19349663u) ^ (p * 83492791u);
                noise ^= noise >> 13; noise *= 1274126177u; noise ^= noise >> 16;
                unsigned value = textured ? 64u + (noise & 127u) :
                    24u + (((x + index * 5) / (3 + p)) + y / 7 + p * 31) % 200;
                if (distorted) value = value / (2 + p) * (2 + p) + ((x + y + index) % 19 == 0);
                const std::uint16_t sample = (value << (depth - 8)) +
                    (depth == 10 && textured ? ((noise >> (distorted ? 4 : 2)) & 3) : 0);
                std::memcpy(bytes + y * stride + x * (depth == 8 ? 1 : 2), &sample, depth == 8 ? 1 : 2);
            }
            picture.planes[p] = {bytes, stride, w, h};
        }
    }
};
struct DeviceFrame {
    Picture picture;
    DeviceFrame(unsigned width, unsigned height, unsigned depth) {
        picture.bit_depth = depth;
        picture.memory = PictureMemory::CudaDevice;
        check(cudaGetDevice(&picture.device_index), "get CUDA device");
        for (unsigned p = 0; p < 3; ++p) {
            const unsigned w = width >> (p != 0), h = height >> (p != 0);
            void *data = nullptr; std::size_t stride = 0;
            check(cudaMallocPitch(&data, &stride, w * (depth == 8 ? 1 : 2), h), "allocate resident input");
            picture.planes[p] = {data, stride, w, h};
        }
    }
    ~DeviceFrame() { for (const auto &plane : picture.planes) if (plane.data) cudaFree(const_cast<void *>(plane.data)); }
    void upload(const Picture &source, cudaStream_t stream) {
        for (unsigned p = 0; p < 3; ++p)
            check(cudaMemcpy2DAsync(const_cast<void *>(picture.planes[p].data), picture.planes[p].stride,
                source.planes[p].data, source.planes[p].stride,
                source.planes[p].width * (source.bit_depth == 8 ? 1 : 2), source.planes[p].height,
                cudaMemcpyHostToDevice, stream), "upload resident input");
    }
};
using Key = std::pair<std::uint64_t, std::string>;
struct DirectAdmCpu {
    VmafContext *context = nullptr;
    explicit DirectAdmCpu(const FeaturePlan &plan) {
        VmafConfiguration configuration{};
        configuration.n_threads = 1; configuration.n_subsample = 1; configuration.gpumask = 1;
        configuration.log_level = VMAF_LOG_LEVEL_ERROR;
        if (vmaf_init(&context, configuration)) throw std::runtime_error("direct ADM CPU init failed");
        try {
            for (const auto &spec : plan.extractors) {
                VmafFeatureDictionary *options = nullptr;
                for (const auto &[key, value] : spec.options)
                    if (vmaf_feature_dictionary_set(&options, key.c_str(), value.c_str()))
                        throw std::runtime_error("direct ADM CPU option failed");
                if (vmaf_use_feature(context, "adm", options)) throw std::runtime_error("direct ADM CPU registration failed");
            }
        } catch (...) { vmaf_close(context); context = nullptr; throw; }
    }
    ~DirectAdmCpu() { if (context) vmaf_close(context); }
    void submit(unsigned index, const Picture &reference, const Picture &distorted) {
        VmafPicture ref{}, dist{};
        const auto copy = [](VmafPicture &output, const Picture &input) {
            if (vmaf_picture_alloc(&output, VMAF_PIX_FMT_YUV420P, input.bit_depth,
                                   input.planes[0].width, input.planes[0].height))
                throw std::runtime_error("direct CPU picture allocation failed");
            for (unsigned plane = 0; plane < 3; ++plane)
                for (unsigned y = 0; y < input.planes[plane].height; ++y)
                    std::memcpy(static_cast<unsigned char *>(output.data[plane]) + y * output.stride[plane],
                        static_cast<const unsigned char *>(input.planes[plane].data) + y * input.planes[plane].stride,
                        input.planes[plane].width * (input.bit_depth == 8 ? 1 : 2));
        };
        try {
            copy(ref, reference); copy(dist, distorted);
            if (vmaf_read_pictures(context, &ref, &dist, index)) throw std::runtime_error("direct ADM CPU extraction failed");
        } catch (...) {
            if (ref.ref) vmaf_picture_unref(&ref);
            if (dist.ref) vmaf_picture_unref(&dist);
            throw;
        }
    }
    void finish() {
        if (vmaf_read_pictures(context, nullptr, nullptr, 0)) throw std::runtime_error("direct ADM CPU flush failed");
    }
    double at(const Key &key) {
        double result = 0;
        if (vmaf_feature_score_at_index(context, key.second.c_str(), &result, unsigned(key.first)))
            throw std::runtime_error("direct ADM CPU feature missing: " + key.second);
        return result;
    }
};
void compare(double expected, double actual, const std::string &name) {
    if (!std::isfinite(actual) || std::abs(expected - actual) > 1e-6 + 1e-7 * std::abs(expected))
        throw std::runtime_error(name + " expected=" + oracle_double_to_string(expected) +
                                 " actual=" + oracle_double_to_string(actual));
}
void run(const std::vector<ModelInput> &models, unsigned width, unsigned height, unsigned depth, unsigned count) {
    cudaStream_t stream = nullptr; check(cudaStreamCreate(&stream), "create stream");
    try {
        ModelOracle cpu(models, {width, height, depth, 1, true}, OracleMode::Cpu);
        const auto full_plan = cpu.feature_plan();
        FeaturePlan adm_plan = full_plan;
        adm_plan.extractors.clear();
        std::vector<std::unique_ptr<CudaParallelAdm>> parallel;
        for (const auto &spec : full_plan.extractors) if (spec.name == "adm") {
            auto required = spec;
            for (const auto base : {"VMAF_integer_feature_adm2_score", "VMAF_integer_feature_aim_score"})
                required.provided_features.push_back(spec.canonical_names.at(base));
            adm_plan.extractors.push_back(required);
            parallel.push_back(std::make_unique<CudaParallelAdm>(required, full_plan, stream));
        }
        DirectAdmCpu direct(adm_plan);
        CudaScalarFeatures scalar(adm_plan, stream);
        DeviceFrame device_ref(width, height, depth), device_dist(width, height, depth);
        std::map<Key, double> parallel_values, scalar_values;
        double scalar_wall_ms = 0, parallel_wall_ms = 0;
        for (unsigned index = 0; index < count; ++index) {
            Frame ref(width, height, depth, index, false, index % 2 == 0);
            Frame dist(width, height, depth, index, true, index % 2 == 0);
            cpu.submit(index, ref.picture, dist.picture);
            direct.submit(index, ref.picture, dist.picture);
            device_ref.upload(ref.picture, stream); device_dist.upload(dist.picture, stream);
            check(cudaStreamSynchronize(stream), "finish input uploads");
            auto start = std::chrono::steady_clock::now();
            for (const auto &score : scalar.extract(index, device_ref.picture, device_dist.picture))
                scalar_values.emplace(Key{score.index, score.name}, score.value);
            scalar_wall_ms += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
            start = std::chrono::steady_clock::now();
            for (const auto &engine : parallel) for (const auto &score : engine->extract(index,
                device_ref.picture.planes[0], device_dist.picture.planes[0]))
                if (!parallel_values.emplace(Key{score.index, score.name}, score.value).second)
                    throw std::runtime_error("duplicate parallel ADM output");
            parallel_wall_ms += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        }
        const auto expected = cpu.finish(count);
        direct.finish();
        double max_feature_error = 0;
        for (const auto &[key, value] : parallel_values) {
            const double groundtruth = direct.at(key);
            compare(groundtruth, value, "parallel/official CPU ADM2/AIM/ADM3 " + key.second);
            compare(scalar_values.at(key), value, "parallel/scalar ADM2/AIM/ADM3 " + key.second);
            max_feature_error = std::max(max_feature_error, std::abs(groundtruth - value));
        }
        auto hybrid = expected.features;
        std::size_t matched = 0;
        for (auto &feature : hybrid) {
            const auto found = parallel_values.find({feature.index, feature.name});
            if (found == parallel_values.end()) continue;
            compare(feature.value, found->second, "parallel/CPU " + feature.name);
            compare(scalar_values.at(found->first), found->second, "parallel/scalar " + feature.name);
            feature.value = found->second; ++matched;
        }
        if (parallel_values.size() != 3 * adm_plan.extractors.size() * count || matched != adm_plan.extractors.size() * count)
            throw std::runtime_error("parallel ADM coverage mismatch");
        ModelOracle imported(models, {width, height, depth, 1, true}, OracleMode::ImportedFeatures);
        imported.import_scores(hybrid);
        const auto actual = imported.finish(count);
        for (const auto &[id, values] : actual.model_scores)
            for (unsigned index = 0; index < count; ++index)
                if (std::abs(values[index] - expected.model_scores.at(id)[index]) > 1e-4)
                    throw std::runtime_error("parallel ADM changed VMAF beyond 1e-4: " + id);
        double kernel_ms = 0;
        for (const auto &engine : parallel) kernel_ms += engine->timings().kernel_ms;
        std::cout << std::setprecision(17) << "PASS ADM " << width << 'x' << height << " depth=" << depth
                  << " frames=" << count << " models=" << models.size() << " features=" << matched
                  << " minimum=" << adm_plan.extractors.front().options.at("adm_min_val")
                  << " auxiliary_features=" << parallel_values.size() << " max_error=" << max_feature_error
                  << " scalar_kernel_ms=" << scalar.timings().kernel_ms << " parallel_kernel_ms=" << kernel_ms
                  << " scalar_wall_ms=" << scalar_wall_ms << " parallel_wall_ms=" << parallel_wall_ms << '\n';
    } catch (...) { cudaStreamDestroy(stream); throw; }
    check(cudaStreamDestroy(stream), "destroy stream");
}
}
int main(int argc, char **argv) {
    try {
        if (argc != 2 && argc != 3) throw std::runtime_error("usage: cuda_parallel_adm_test MODEL_DIRECTORY [benchmark]");
        std::vector<ModelInput> models;
        for (const auto family : {"vmaf_v1.0.16", "vmaf_v1.0.16_hfr"})
            for (const auto view : {"3d0h", "3d0h_2160", "5d0h", "1d5h_2160"}) {
                const std::string id = std::string(family) + "_" + view;
                models.push_back({id, (std::filesystem::path(argv[1]) / family / (id + ".json")).string(), {}});
            }
        if (argc == 3) { models.resize(1); run(models, 1920, 1080, 10, 2); }
        else {
            run(models, 768, 768, 8, 2); run(models, 768, 768, 10, 2);
            for (auto &model : models) model.feature_overrides["adm"]["adm_min_val"] = "0";
            run(models, 768, 768, 8, 2); run(models, 768, 768, 10, 2);
        }
        return 0;
    } catch (const std::exception &error) { std::cerr << error.what() << '\n'; return 1; }
}
