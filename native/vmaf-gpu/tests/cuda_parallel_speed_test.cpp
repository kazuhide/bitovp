// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "bitovp_gpu.hpp"
#include "model_oracle.hpp"
#include "parallel_speed.hpp"
#include "scalar_features.hpp"
#include <cuda_runtime.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>
#include <vector>

using namespace bitovp::gpu;
namespace {
void require(bool ok, const std::string &why) { if (!ok) throw std::runtime_error(why); }
void check(cudaError_t status) { if (status != cudaSuccess) throw std::runtime_error(cudaGetErrorString(status)); }
struct Fixture {
    Picture reference, distorted;
    std::vector<std::uint8_t> r8[3], d8[3];
    std::vector<std::uint16_t> r16[3], d16[3];
    Fixture(unsigned width, unsigned height, unsigned bpc, unsigned frame, unsigned pattern) {
        reference.bit_depth = distorted.bit_depth = bpc;
        for (unsigned p = 0; p < 3; ++p) {
            const unsigned w = p ? width / 2 : width, h = p ? height / 2 : height, stride = w + 16;
            r8[p].resize(std::size_t(stride) * h); d8[p].resize(std::size_t(stride) * h);
            r16[p].resize(std::size_t(stride) * h); d16[p].resize(std::size_t(stride) * h);
            for (unsigned y = 0; y < h; ++y) for (unsigned x = 0; x < w; ++x) {
                const bool flat = pattern == 1 || (pattern == 2 && p == 1);
                const unsigned v = flat ? 120 : pattern == 3 ? 16 + (x * 7 + p * 31) % 215
                    : pattern == 4 ? ((x == 0 || y == 0 || x + 1 == w || y + 1 == h) ? 230 : 16)
                    : 16 + (x * 13 + y * 7 + (x * y % 53) + frame * frame * 3 + p * 31) % 215;
                const unsigned d = flat ? 120 : unsigned(std::clamp<int>(int(v) + int((x + y * 3 + p + frame) % 9) - 4, 0, 255));
                r8[p][y * stride + x] = v; d8[p][y * stride + x] = d;
                r16[p][y * stride + x] = (v << 2) + (flat ? 0 : (x + frame) % 4);
                d16[p][y * stride + x] = (d << 2) + (flat ? 0 : (y + p) % 4);
            }
            reference.planes[p] = {bpc == 8 ? static_cast<const void *>(r8[p].data()) : r16[p].data(), stride * (bpc == 8 ? 1u : 2u), w, h};
            distorted.planes[p] = {bpc == 8 ? static_cast<const void *>(d8[p].data()) : d16[p].data(), stride * (bpc == 8 ? 1u : 2u), w, h};
        }
    }
    void read(std::istream &r, std::istream &d) {
        const unsigned bytes = reference.bit_depth == 8 ? 1 : 2;
        for (unsigned p = 0; p < 3; ++p) {
            const auto &plane = reference.planes[p];
            auto *rp = const_cast<char *>(static_cast<const char *>(plane.data));
            auto *dp = const_cast<char *>(static_cast<const char *>(distorted.planes[p].data));
            for (unsigned y = 0; y < plane.height; ++y) {
                r.read(rp + y * plane.stride, plane.width * bytes);
                d.read(dp + y * distorted.planes[p].stride, plane.width * bytes);
            }
        }
        require(bool(r) && bool(d), "raw fixture is truncated");
    }
};
struct Resident {
    Picture picture;
    void *allocations[3]{};
    Resident(const Picture &input, cudaStream_t stream) : picture(input) {
        picture.memory = PictureMemory::CudaDevice;
        check(cudaGetDevice(&picture.device_index));
        try {
            for (unsigned p = 0; p < 3; ++p) {
                const auto &src = input.planes[p];
                check(cudaMalloc(&allocations[p], src.stride * src.height));
                check(cudaMemcpyAsync(allocations[p], src.data, src.stride * src.height, cudaMemcpyHostToDevice, stream));
                picture.planes[p].data = allocations[p];
            }
        } catch (...) { cudaStreamSynchronize(stream); for (auto *ptr : allocations) cudaFree(ptr); throw; }
    }
    ~Resident() { for (auto *ptr : allocations) cudaFree(ptr); }
};
void feature_close(const FeatureScore &expected, double actual) {
    require(std::isfinite(actual) && std::abs(actual - expected.value) <= 1e-6 + 1e-7 * std::abs(expected.value),
        "SPEED feature exceeds abs1e-6+rel1e-7: " + expected.name + " expected=" +
        oracle_double_to_string(expected.value) + " actual=" + oracle_double_to_string(actual));
}
std::vector<ModelInput> models(const std::string &directory) {
    std::vector<ModelInput> out;
    for (bool hfr : {false, true}) for (const auto *variant : {"1d5h_2160", "3d0h", "3d0h_2160", "5d0h"}) {
        const std::string family = hfr ? "vmaf_v1.0.16_hfr" : "vmaf_v1.0.16", name = family + "_" + variant;
        out.push_back({name, directory + "/" + family + "/" + name + ".json", {}});
    }
    return out;
}
void run(const std::vector<ModelInput> &inputs, cudaStream_t stream, unsigned bpc, unsigned pattern,
         const char *raw_reference = nullptr, const char *raw_distorted = nullptr, bool unclipped = false,
         unsigned synthetic_width = 768, unsigned synthetic_height = 768) {
    const bool real = raw_reference != nullptr;
    const unsigned width = real ? 1920 : synthetic_width, height = real ? 1080 : synthetic_height, frames = real ? 2 : 6;
    const ModelOracleConfig config{width, height, bpc, 1, false};
    auto selected_models = inputs;
    if (unclipped) for (auto &model : selected_models) model.feature_overrides["speed_chroma"]["speed_max_val"] = "1000";
    ModelOracle cpu(selected_models, config, OracleMode::Cpu), imported(selected_models, config, OracleMode::ImportedFeatures);
    FeaturePlan speed_plan = cpu.feature_plan(); speed_plan.extractors.clear();
    std::vector<std::unique_ptr<CudaParallelSpeed>> parallel;
    std::set<std::string> speed_names;
    for (const auto &spec : cpu.feature_plan().extractors) if (spec.name == "speed_chroma") {
        speed_plan.extractors.push_back(spec);
        parallel.push_back(std::make_unique<CudaParallelSpeed>(spec, cpu.feature_plan(), stream));
        speed_names.insert(spec.provided_features.begin(), spec.provided_features.end());
    }
    require(parallel.size() == 3, "official eight models did not exercise all three SPEED configurations");
    CudaScalarFeatures baseline(speed_plan, stream);
    std::map<std::pair<std::uint64_t, std::string>, double> scores, baseline_scores;
    std::ifstream raw_r, raw_d;
    if (real) { raw_r.open(raw_reference, std::ios::binary); raw_d.open(raw_distorted, std::ios::binary); }
    double parallel_wall_ms = 0, scalar_wall_ms = 0;
    for (unsigned frame = 0; frame < frames; ++frame) {
        Fixture fixture(width, height, bpc, frame, pattern);
        if (real) fixture.read(raw_r, raw_d);
        cpu.submit(frame, fixture.reference, fixture.distorted);
        Resident r(fixture.reference, stream), d(fixture.distorted, stream);
        check(cudaStreamSynchronize(stream));
        const auto start = std::chrono::steady_clock::now();
        for (auto &extractor : parallel) for (const auto &score : extractor->extract(frame, r.picture, d.picture))
            require(scores.emplace(std::make_pair(score.index, score.name), score.value).second, "duplicate SPEED feature");
        parallel_wall_ms += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        const auto scalar_start = std::chrono::steady_clock::now();
        for (const auto &score : baseline.extract(frame, r.picture, d.picture))
            require(baseline_scores.emplace(std::make_pair(score.index, score.name), score.value).second, "duplicate scalar feature");
        scalar_wall_ms += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - scalar_start).count();
        if (!frame) {
            bool rejected = false;
            try { parallel.front()->extract(999, fixture.reference, fixture.distorted); } catch (const std::invalid_argument &) { rejected = true; }
            require(rejected, "parallel SPEED accepted host pointer as CUDA memory");
            auto invalid = r.picture;
            invalid.device_index += 1;
            rejected = false;
            try { parallel.front()->extract(999, invalid, d.picture); } catch (const std::invalid_argument &) { rejected = true; }
            require(rejected, "parallel SPEED accepted a different CUDA device");
            invalid = r.picture;
            invalid.planes[1].data = fixture.reference.planes[1].data;
            rejected = false;
            try { parallel.front()->extract(999, invalid, d.picture); } catch (const std::invalid_argument &) { rejected = true; }
            require(rejected, "parallel SPEED accepted a mislabeled host pointer");
            invalid = r.picture; invalid.planes[1].stride = 1;
            rejected = false;
            try { parallel.front()->extract(999, invalid, d.picture); } catch (const std::invalid_argument &) { rejected = true; }
            require(rejected, "parallel SPEED accepted a truncated chroma stride");
        }
    }
    const auto expected = cpu.finish(frames);
    std::vector<FeatureScore> replacement;
    std::map<std::string, bool> positive;
    for (const auto &name : speed_names) positive[name] = false;
    double max_error = 0, max_vmaf_error = 0, max_pool_error = 0;
    for (const auto &score : expected.features) {
        auto copy = score;
        if (speed_names.count(score.name)) {
            copy.value = scores.at({score.index, score.name});
            feature_close(score, copy.value);
            feature_close(score, baseline_scores.at({score.index, score.name}));
            max_error = std::max(max_error, std::abs(copy.value - score.value));
            positive[score.name] = positive[score.name] || score.value > 1e-9;
        }
        replacement.push_back(copy);
    }
    if (pattern == 0 || pattern == 2) for (const auto &[name, nondegenerate] : positive)
        require(nondegenerate, "fixture did not exercise nondegenerate SPEED for " + name);
    require(scores.size() == std::size_t(frames) * speed_names.size(), "missing SPEED series");
    imported.import_scores(replacement);
    const auto actual = imported.finish(frames);
    for (const auto &[model, expected_scores] : expected.model_scores) {
        const auto &actual_scores = actual.model_scores.at(model);
        require(actual_scores.size() == expected_scores.size(), "missing model score");
        for (unsigned i = 0; i < frames; ++i) {
            require(std::isfinite(actual_scores[i]) && std::abs(actual_scores[i] - expected_scores[i]) <= 1e-4, "SPEED replacement VMAF exceeds abs1e-4");
            max_vmaf_error = std::max(max_vmaf_error, std::abs(actual_scores[i] - expected_scores[i]));
        }
        const auto &a = expected.pooled.at(model), &b = actual.pooled.at(model);
        require(std::abs(a.mean - b.mean) <= 1e-4 && std::abs(a.minimum - b.minimum) <= 1e-4 &&
            std::abs(a.maximum - b.maximum) <= 1e-4 && std::abs(a.harmonic_mean - b.harmonic_mean) <= 1e-4,
            "SPEED replacement VMAF pooling exceeds abs1e-4");
        max_pool_error = std::max({max_pool_error, std::abs(a.mean - b.mean), std::abs(a.minimum - b.minimum),
                                  std::abs(a.maximum - b.maximum), std::abs(a.harmonic_mean - b.harmonic_mean)});
    }
    BackendTimings time;
    for (const auto &extractor : parallel) {
        const auto t = extractor->timings();
        time.kernel_ms += t.kernel_ms; time.cpu_postprocess_ms += t.cpu_postprocess_ms;
        time.downloaded_bytes += t.downloaded_bytes; time.uploaded_bytes += t.uploaded_bytes;
        time.allocated_bytes += t.allocated_bytes;
    }
    std::cout << "PASS cuda_parallel_speed bpc=" << bpc << " pattern=" << pattern << " real=" << real << " unclipped=" << unclipped
              << " width=" << width << " height=" << height << " frames=" << frames << " max_abs_error=" << oracle_double_to_string(max_error)
              << " max_vmaf_error=" << max_vmaf_error << " max_pool_error=" << max_pool_error
              << " parallel_kernel_ms=" << time.kernel_ms << " scalar_kernel_ms=" << baseline.timings().kernel_ms
              << " parallel_wall_ms=" << parallel_wall_ms << " scalar_wall_ms=" << scalar_wall_ms
              << " cpu_postprocess_ms=" << time.cpu_postprocess_ms << " downloaded_bytes=" << time.downloaded_bytes
              << " uploaded_bytes=" << time.uploaded_bytes << " allocated_bytes=" << time.allocated_bytes << '\n';
}
}
int main(int argc, char **argv) {
    cudaStream_t stream = nullptr;
    try {
        require(argc == 2 || argc == 5, "usage: cuda_parallel_speed_test MODEL_DIR [RAW_REF RAW_DIST BIT_DEPTH]");
        check(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking));
        const auto inputs = models(argv[1]);
        if (argc == 5) for (bool unclipped : {false, true}) run(inputs, stream, unsigned(std::stoul(argv[4])), 0, argv[2], argv[3], unclipped);
        else for (unsigned bpc : {8u, 10u}) {
            for (unsigned pattern : {0u, 1u, 2u, 3u, 4u}) run(inputs, stream, bpc, pattern);
            run(inputs, stream, bpc, 0, nullptr, nullptr, true);
            // Both the decimation and RHS launch have partial boundary groups.
            run(inputs, stream, bpc, 0, nullptr, nullptr, true, 1538, 1090);
            // A non-flat rank-deficient covariance must follow the failure path.
            run(inputs, stream, bpc, 3, nullptr, nullptr, true, 1026, 770);
        }
        check(cudaStreamDestroy(stream));
    } catch (const std::exception &error) {
        if (stream) cudaStreamDestroy(stream);
        std::cerr << "FAIL cuda_parallel_speed: " << error.what() << '\n';
        return 1;
    }
}
