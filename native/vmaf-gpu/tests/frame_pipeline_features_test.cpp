// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "bitovp_gpu.hpp"
#include "model_oracle.hpp"
#include "frame_pipeline.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>
#include <tuple>
#include <cstring>
#include <set>

using namespace bitovp::gpu;
namespace {
enum class Pattern { Textured, Flat, RankDeficient, Edge };
struct TestCase {
    unsigned width, height;
    Pattern pattern;
    const char *name;
};
struct Fixture {
    Picture reference, distorted;
    std::vector<std::uint16_t> a16[3], b16[3];
    std::vector<std::uint8_t> a8[3], b8[3];
    Fixture(unsigned bpc, unsigned frame, const TestCase &test_case) {
        reference.bit_depth = distorted.bit_depth = bpc;
        const bool flat = test_case.pattern == Pattern::Flat;
        for (unsigned p = 0; p < 3; ++p) {
            const unsigned w = p ? test_case.width / 2 : test_case.width;
            const unsigned h = p ? test_case.height / 2 : test_case.height, stride = w + 16;
            a16[p].resize(stride * h); b16[p].resize(stride * h);
            a8[p].resize(stride * h); b8[p].resize(stride * h);
            for (unsigned y = 0; y < h; ++y) for (unsigned x = 0; x < w; ++x) {
                const unsigned v = flat ? 120
                    : test_case.pattern == Pattern::RankDeficient ? 16 + (x * 7 + p * 31) % 215
                    : test_case.pattern == Pattern::Edge ? ((x == 0 || y == 0 || x + 1 == w || y + 1 == h) ? 230 : 16)
                    : 16 + ((x * 13 + y * 7 + (x * y % 53) + frame * frame * 3 + p * 31) % 215);
                const unsigned d = flat ? 120 : std::clamp<int>(
                    static_cast<int>(v) + static_cast<int>((x + y * 3 + p + frame) % 9) - 4, 0, 255);
                a8[p][y * stride + x] = v; b8[p][y * stride + x] = d;
                a16[p][y * stride + x] = (v << 2) + (flat ? 0 : (x + frame) % 4);
                b16[p][y * stride + x] = (d << 2) + (flat ? 0 : (y + p) % 4);
            }
            reference.planes[p] = {bpc == 8 ? static_cast<const void *>(a8[p].data()) : a16[p].data(),
                stride * (bpc == 8 ? 1u : 2u), w, h};
            distorted.planes[p] = {bpc == 8 ? static_cast<const void *>(b8[p].data()) : b16[p].data(),
                stride * (bpc == 8 ? 1u : 2u), w, h};
        }
    }
};
void require(bool condition, const std::string &message) {
    if (!condition) throw std::runtime_error(message);
}
}

int main(int argc, char **argv) {
    try {
        if (argc < 2 || argc > 3) throw std::invalid_argument("Usage: frame_pipeline_features_test <official-source-model-dir> [all|rank8]");
        const std::string filter = argc > 2 ? argv[2] : "all";
        require(filter == "all" || filter == "rank8", "Unknown fixture filter");
        const auto factory = []() -> std::unique_ptr<FeatureBackend> {
#ifdef BITOVP_PIPELINE_CUDA
            return create_cuda_backend({});
#else
            BackendOptions options; options.vendor_id = 0x1002;
            return create_vulkan_backend(options);
#endif
        };
        std::vector<ModelInput> models;
        for (bool hfr : {false, true}) for (const auto *variant :
             {"1d5h_2160", "3d0h", "3d0h_2160", "5d0h"}) {
            const std::string family = hfr ? "vmaf_v1.0.16_hfr" : "vmaf_v1.0.16";
            const std::string name = family + "_" + variant;
            models.push_back({name, std::string(argv[1]) + "/" + family + "/" + name + ".json", {}});
        }
        const TestCase cases[] = {
            {768, 768, Pattern::Textured, "textured"},
            {1026, 770, Pattern::RankDeficient, "rank-deficient"},
        };
        using Key = std::pair<std::uint64_t, std::string>;
        using CaseKey = std::tuple<unsigned,unsigned,unsigned>;
        std::map<CaseKey,OracleResult> serial_padded, serial_tight;
        unsigned failure_count = 0;
        const auto raw_bits = [](double value) {
            std::uint64_t result; std::memcpy(&result, &value, sizeof(result)); return result;
        };
        for (unsigned depth : {1u, 0u, 2u, 4u}) for (unsigned bpc : {8u, 10u}) for (const auto &test_case : cases) {
            if (filter == "rank8" && (bpc != 8 || test_case.pattern != Pattern::RankDeficient)) continue;
            const std::string path = depth == 0 ? "serial-tight" : depth == 1 ? "serial-padded" : "pipeline-" + std::to_string(depth);
            const std::string context = " path=" + path + " bpc=" + std::to_string(bpc) +
                " pattern=" + test_case.name + " geometry=" + std::to_string(test_case.width) + "x" + std::to_string(test_case.height);
            std::cout << "BEGIN" << context << std::endl;
            const unsigned failures_before = failure_count;
            ModelOracleConfig config{test_case.width, test_case.height, bpc, 1, true};
            ModelOracle cpu(models, config, OracleMode::Cpu);
            ModelOracle imported(models, config, OracleMode::ImportedFeatures);
            std::unique_ptr<FeatureBackend> backend;
            if (depth <= 1) backend = factory();
            else backend = std::make_unique<FramePipeline>(factory, depth);
            backend->configure(cpu.feature_plan());
            HostStagedPicture staged_reference, staged_distorted;
            for (unsigned index = 0; index < 7; ++index) {
                Fixture fixture(bpc, index, test_case);
                cpu.submit(index, fixture.reference, fixture.distorted);
                if (depth == 0) {
                    staged_reference.assign(fixture.reference); staged_distorted.assign(fixture.distorted);
                    imported.import_scores(backend->extract(index, staged_reference.picture(), staged_distorted.picture()));
                } else imported.import_scores(backend->extract(index, fixture.reference, fixture.distorted));
            }
            imported.import_scores(backend->flush());
            const auto expected = cpu.finish(7);
            const auto actual = imported.finish(7);
            if (test_case.pattern == Pattern::Textured) {
                bool nonzero_speed = false;
                for (const auto &score : expected.features)
                    if (score.name.find("speed") != std::string::npos && std::abs(score.value) > 1e-9)
                        nonzero_speed = true;
                require(nonzero_speed, "Textured fixture did not exercise nondegenerate SPEED");
            }
            std::map<Key, double> by_feature;
            for (const auto &score : actual.features)
                require(by_feature.emplace(Key{score.index, score.name}, score.value).second,
                        "Duplicate GPU feature score");
            require(actual.features.size() == expected.features.size(), "GPU feature series is incomplete");
            std::set<std::uint64_t> bad_frames;
            std::map<std::string,std::uint64_t> bad_models;
            for (const auto &score : expected.features) {
                const auto found = by_feature.find({score.index, score.name});
                require(found != by_feature.end(), "Missing GPU feature: " + score.name);
                const double error = std::abs(found->second - score.value);
                if (!std::isfinite(found->second) || error > 1e-6 + 1e-7 * std::abs(score.value)) {
                    ++failure_count; bad_frames.insert(score.index);
                    std::cerr << "FEATURE_FAIL" << context << " frame=" << score.index << " feature=" << score.name
                              << " cpu=" << oracle_double_to_string(score.value) << " gpu=" << oracle_double_to_string(found->second)
                              << " absError=" << oracle_double_to_string(error) << '\n';
                }
            }
            for (const auto &[model, scores] : expected.model_scores) {
                const auto &got = actual.model_scores.at(model);
                require(got.size() == scores.size(), "Missing GPU model frame score");
                for (std::size_t i = 0; i < scores.size(); ++i) {
                    const double error = std::abs(got[i] - scores[i]);
                    if (!std::isfinite(got[i]) || error > 1e-4) {
                        ++failure_count; bad_frames.insert(i); bad_models.emplace(model,i);
                        std::cerr << "MODEL_FAIL" << context << " frame=" << i << " model=" << model
                                  << " cpu=" << oracle_double_to_string(scores[i]) << " gpu=" << oracle_double_to_string(got[i])
                                  << " absError=" << oracle_double_to_string(error) << '\n';
                    }
                }
                const auto &a = expected.pooled.at(model), &b = actual.pooled.at(model);
                const std::pair<const char *,std::pair<double,double>> pools[] = {
                    {"mean",{a.mean,b.mean}}, {"minimum",{a.minimum,b.minimum}},
                    {"maximum",{a.maximum,b.maximum}}, {"harmonicMean",{a.harmonic_mean,b.harmonic_mean}}};
                for (const auto &pool : pools) {
                    const double error = std::abs(pool.second.first-pool.second.second);
                    if (!std::isfinite(pool.second.second) || error > 1e-4) {
                        ++failure_count;
                        std::cerr << "POOL_FAIL" << context << " pool=" << pool.first << " model=" << model
                                  << " cpu=" << oracle_double_to_string(pool.second.first)
                                  << " gpu=" << oracle_double_to_string(pool.second.second)
                                  << " absError=" << oracle_double_to_string(error) << '\n';
                    }
                }
            }
            for (const auto frame : bad_frames) for (const auto &score : expected.features) if (score.index == frame) {
                const double got = by_feature.at({frame,score.name});
                if (raw_bits(got) == raw_bits(score.value)) continue;
                std::cerr << "FEATURE_DIFF" << context << " frame=" << frame << " feature=" << score.name
                          << " cpu=" << oracle_double_to_string(score.value) << " gpu=" << oracle_double_to_string(got)
                          << " signedError=" << oracle_double_to_string(got-score.value) << '\n';
            }
            // Predictor-only counterfactual: replace one differing input by its
            // official value, leaving all other GPU features unchanged. This
            // attributes score amplification without changing either backend.
            for (const auto &[model,frame] : bad_models) {
                for (const auto &score : expected.features) if (score.index == frame) {
                    const double got = by_feature.at({frame,score.name});
                    if (raw_bits(got) == raw_bits(score.value)) continue;
                    auto replacement = actual.features;
                    for (auto &feature : replacement) if (feature.index == frame && feature.name == score.name)
                        feature.value = score.value;
                    ModelOracle attributed(models, config, OracleMode::ImportedFeatures);
                    attributed.import_scores(replacement);
                    const auto patched = attributed.finish(7);
                    const double predicted = patched.model_scores.at(model).at(frame);
                    std::cerr << "ATTRIBUTION" << context << " frame=" << frame << " model=" << model
                              << " replacedFeature=" << score.name << " patchedScore=" << oracle_double_to_string(predicted)
                              << " cpuScore=" << oracle_double_to_string(expected.model_scores.at(model).at(frame))
                              << " remainingError=" << oracle_double_to_string(predicted-expected.model_scores.at(model).at(frame)) << '\n';
                }
            }
            const CaseKey key{bpc,test_case.width,test_case.height};
            const auto compare_gpu_path = [&](const OracleResult &base,const std::string &base_name) {
                std::map<Key,double> base_features;
                for (const auto &score : base.features) base_features.emplace(Key{score.index,score.name},score.value);
                require(base_features.size() == by_feature.size(), "GPU path feature coverage differs");
                unsigned feature_differences = 0, model_differences = 0;
                for (const auto &[feature,value] : by_feature) {
                    const double original = base_features.at(feature);
                    if (raw_bits(original) != raw_bits(value)) {
                        ++feature_differences; ++failure_count;
                        std::cerr << "GPU_PATH_FEATURE_DIFF" << context << " baseline=" << base_name
                                  << " frame=" << feature.first << " feature=" << feature.second
                                  << " baselineValue=" << oracle_double_to_string(original)
                                  << " value=" << oracle_double_to_string(value)
                                  << " signedError=" << oracle_double_to_string(value-original) << '\n';
                    }
                }
                for (const auto &[model,values] : actual.model_scores) {
                    const auto &original = base.model_scores.at(model);
                    require(original.size() == values.size(), "GPU path model coverage differs");
                    for (std::size_t i = 0; i < values.size(); ++i) if (raw_bits(original[i]) != raw_bits(values[i])) {
                        ++model_differences; ++failure_count;
                        std::cerr << "GPU_PATH_MODEL_DIFF" << context << " baseline=" << base_name
                                  << " frame=" << i << " model=" << model
                                  << " baselineValue=" << oracle_double_to_string(original[i])
                                  << " value=" << oracle_double_to_string(values[i]) << '\n';
                    }
                }
                std::cout << "GPU_PATH_COMPARE" << context << " baseline=" << base_name
                          << " featureRawBitDifferences=" << feature_differences
                          << " modelRawBitDifferences=" << model_differences << std::endl;
            };
            if (depth == 1) serial_padded.emplace(key,actual);
            else {
                compare_gpu_path(serial_padded.at(key),"serial-padded");
                if (depth == 0) serial_tight.emplace(key,actual);
                else compare_gpu_path(serial_tight.at(key),"serial-tight");
            }
            const auto timing = backend->timings();
            std::cout << (failure_count == failures_before ? "PASS" : "FAIL") << " frame_pipeline_features eight models" << context
                      << " features=" << actual.features.size() << " kernel_ms=" << timing.kernel_ms
                      << " uploaded_bytes=" << timing.uploaded_bytes << " downloaded_bytes="
                      << timing.downloaded_bytes << " allocated_bytes=" << timing.allocated_bytes << std::endl;
        }
        if (failure_count) throw std::runtime_error("Strict CPU/GPU or interpath parity failures=" + std::to_string(failure_count));

    } catch (const std::exception &error) {
        std::cerr << "FAIL frame_pipeline_features: " << error.what() << '\n';
        return 1;
    }
}
