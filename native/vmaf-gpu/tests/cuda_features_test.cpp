// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "bitovp_gpu.hpp"
#include "model_oracle.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

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
        if (argc != 2) throw std::invalid_argument("Usage: cuda_features_test <official-source-model-dir>");
        std::vector<ModelInput> models;
        for (bool hfr : {false, true}) for (const auto *variant :
             {"1d5h_2160", "3d0h", "3d0h_2160", "5d0h"}) {
            const std::string family = hfr ? "vmaf_v1.0.16_hfr" : "vmaf_v1.0.16";
            const std::string name = family + "_" + variant;
            models.push_back({name, std::string(argv[1]) + "/" + family + "/" + name + ".json", {}});
        }
        const TestCase cases[] = {
            {768, 768, Pattern::Textured, "textured"},
            {768, 768, Pattern::Flat, "flat"},
            {1026, 770, Pattern::RankDeficient, "rank-deficient"},
            // Decimation and RHS launches both have partial boundary groups.
            {1538, 1090, Pattern::Textured, "textured"},
            {1538, 1090, Pattern::Edge, "edge"},
        };
        for (unsigned bpc : {8u, 10u}) for (const auto &test_case : cases) {
            ModelOracleConfig config{test_case.width, test_case.height, bpc, 1, true};
            ModelOracle cpu(models, config, OracleMode::Cpu);
            ModelOracle imported(models, config, OracleMode::ImportedFeatures);
            auto backend = create_cuda_backend({});
            backend->configure(cpu.feature_plan());
            for (unsigned index = 0; index < 6; ++index) {
                Fixture fixture(bpc, index, test_case);
                cpu.submit(index, fixture.reference, fixture.distorted);
                imported.import_scores(backend->extract(index, fixture.reference, fixture.distorted));
            }
            imported.import_scores(backend->flush());
            const auto expected = cpu.finish(6);
            const auto actual = imported.finish(6);
            if (test_case.pattern == Pattern::Textured) {
                bool nonzero_speed = false;
                for (const auto &score : expected.features)
                    if (score.name.find("speed") != std::string::npos && std::abs(score.value) > 1e-9)
                        nonzero_speed = true;
                require(nonzero_speed, "Textured fixture did not exercise nondegenerate SPEED");
            }
            std::map<std::pair<std::uint64_t, std::string>, double> by_feature;
            for (const auto &score : actual.features)
                require(by_feature.emplace(std::make_pair(score.index, score.name), score.value).second,
                        "Duplicate CUDA feature score");
            require(actual.features.size() == expected.features.size(), "CUDA feature series is incomplete");
            for (const auto &score : expected.features) {
                const auto found = by_feature.find({score.index, score.name});
                require(found != by_feature.end(), "Missing CUDA feature: " + score.name);
                require(std::isfinite(found->second) &&
                    std::abs(found->second - score.value) <= 1e-6 + 1e-7 * std::abs(score.value),
                    "CUDA feature exceeds abs1e-6+rel1e-7: " + score.name +
                    " index=" + std::to_string(score.index) +
                    " expected=" + oracle_double_to_string(score.value) +
                    " actual=" + oracle_double_to_string(found->second));
            }
            for (const auto &[model, scores] : expected.model_scores) {
                const auto &got = actual.model_scores.at(model);
                require(got.size() == scores.size(), "Missing CUDA model frame score");
                for (std::size_t i = 0; i < scores.size(); ++i)
                    require(std::isfinite(got[i]) && std::abs(got[i] - scores[i]) <= 1e-4,
                            "CUDA VMAF exceeds absolute 1e-4: " + model);
                const auto &a = expected.pooled.at(model), &b = actual.pooled.at(model);
                require(std::abs(a.mean - b.mean) <= 1e-4 &&
                    std::abs(a.minimum - b.minimum) <= 1e-4 &&
                    std::abs(a.maximum - b.maximum) <= 1e-4 &&
                    std::abs(a.harmonic_mean - b.harmonic_mean) <= 1e-4,
                    "CUDA VMAF pooling exceeds absolute 1e-4: " + model);
            }
            const auto timing = backend->timings();
            std::cout << "PASS cuda_features eight models bpc=" << bpc << " pattern=" << test_case.name
                      << " width=" << test_case.width << " height=" << test_case.height
                      << " features=" << actual.features.size() << " kernel_ms=" << timing.kernel_ms
                      << " uploaded_bytes=" << timing.uploaded_bytes << " downloaded_bytes="
                      << timing.downloaded_bytes << " allocated_bytes=" << timing.allocated_bytes << '\n';
        }
    } catch (const std::exception &error) {
        std::cerr << "FAIL cuda_features: " << error.what() << '\n';
        return 1;
    }
}
