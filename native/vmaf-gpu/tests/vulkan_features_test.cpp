// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "bitovp_gpu.hpp"
#include "model_oracle.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <cstdlib>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>
#include <utility>

using namespace bitovp::gpu;

namespace {
struct Frame {
    Picture picture;
    std::array<std::vector<std::uint8_t>, 3> storage;
    Frame(unsigned depth, unsigned frame, bool distorted, unsigned luma_width,
          unsigned luma_height, bool textured) {
        picture.bit_depth = depth;
        const unsigned bytes = depth == 8 ? 1 : 2;
        for (unsigned p = 0; p < 3; ++p) {
            const unsigned width = p ? luma_width / 2 : luma_width;
            const unsigned height = p ? luma_height / 2 : luma_height;
            const std::size_t stride = (width + 7) * bytes;
            storage[p].assign(stride * height, distorted ? 0x55 : 0xaa);
            for (unsigned y = 0; y < height; ++y) {
                for (unsigned x = 0; x < width; ++x) {
                    std::uint32_t noise = ((x + frame) * 73856093u) ^ (y * 19349663u) ^ (p * 83492791u);
                    noise ^= noise >> 13u; noise *= 1274126177u; noise ^= noise >> 16u;
                    unsigned v = textured ? 64u + (noise & 127u) :
                        24u + (((x + 5 * frame) / (3 + p)) + y / 7u + p * 31u) % 200u;
                    if (distorted) v = (v / (2u + p)) * (2u + p) + ((x + y + frame) % 19u == 0u);
                    const std::uint16_t sample = (v << (depth - 8)) +
                        (textured && depth == 10 ? ((noise >> (distorted ? 4u : 2u)) & 3u) : 0u);
                    std::memcpy(storage[p].data() + y * stride + x * bytes, &sample, bytes);
                }
            }
            picture.planes[p] = {storage[p].data(), stride, width, height};
        }
    }
};
using Key = std::pair<std::uint64_t, std::string>;
void insert_scores(std::map<Key, double> &destination, const std::vector<FeatureScore> &scores) {
    for (const auto &score : scores) {
        if (!std::isfinite(score.value) || !destination.emplace(Key{score.index, score.name}, score.value).second)
            throw std::runtime_error("non-finite or duplicate Vulkan feature score: " + score.name);
    }
}
}

int main(int argc, char **argv) {
    try {
        if (argc < 2) throw std::runtime_error("usage: vulkan_features_test MODEL_DIRECTORY [EXTRACTOR|all] [CAMBI_TOPK]");
        const std::string directory = argv[1];
        const std::string filter = argc > 2 ? argv[2] : "all";
        std::vector<ModelInput> models;
        for (const std::string family : {"vmaf_v1.0.16", "vmaf_v1.0.16_hfr"}) {
            for (const std::string suffix : {"1d5h_2160", "3d0h", "3d0h_2160", "5d0h"}) {
                const auto id = family + "_" + suffix;
                models.push_back({id, directory + "/" + family + "/" + id + ".json", {}});
                if (filter == "cambi") {
                    models.back().feature_overrides["cambi"]["cambi_max_val"] = "1000";
                    if (argc > 3) models.back().feature_overrides["cambi"]["topk"] = argv[3];
                }
            }
        }
        BackendOptions options;
        options.vendor_id = 0x1002;
        auto backend = create_vulkan_backend(options);
        if (backend->device().vendor_id != 0x1002 || !backend->device().integrated)
            throw std::runtime_error("feature tests require the selected AMD APU");
        for (unsigned depth : {8u, 10u}) {
            // A 768-square fixture leaves at least 36 covariance samples even
            // after 0.5 chroma prescaling. Smaller fixtures can exercise only
            // SpEED's singular-matrix path and falsely appear numerically exact.
            const unsigned width = filter == "cambi" ? 640u : 768u;
            const unsigned height = filter == "cambi" ? 360u : 768u;
            ModelOracleConfig config{width, height, depth, 1, filter == "all"};
            ModelOracle oracle(models, config, OracleMode::Cpu);
            FeaturePlan plan = oracle.feature_plan();
            if (filter != "all")
                plan.extractors.erase(std::remove_if(plan.extractors.begin(), plan.extractors.end(),
                    [&](const auto &spec) { return spec.name != filter; }), plan.extractors.end());
            if (plan.extractors.empty()) throw std::runtime_error("requested extractor is absent from the official plan");
            std::set<std::string> required;
            for (const auto &spec : plan.extractors)
                required.insert(spec.provided_features.begin(), spec.provided_features.end());
            backend->configure(plan);
            std::map<Key, double> actual;
            for (unsigned frame = 0; frame < 6; ++frame) {
                Frame reference(depth, frame, false, width, height, filter != "cambi");
                Frame distorted(depth, frame, true, width, height, filter != "cambi");
                oracle.submit(frame, reference.picture, distorted.picture);
                insert_scores(actual, backend->extract(frame, reference.picture, distorted.picture));
            }
            insert_scores(actual, backend->flush());
            const auto expected = oracle.finish(6);
            std::size_t checked = 0;
            double maximum_error = 0, minimum_value = INFINITY, maximum_value = -INFINITY;
            for (const auto &score : expected.features) {
                if (!required.count(score.name)) continue;
                const auto found = actual.find({score.index, score.name});
                if (found == actual.end()) throw std::runtime_error("missing Vulkan feature: " + score.name);
                const double tolerance = 1e-6 + 1e-7 * std::abs(score.value);
                if (std::abs(found->second - score.value) > tolerance)
                    throw std::runtime_error("Vulkan/official CPU feature mismatch: " + score.name +
                        " frame=" + std::to_string(score.index) + " expected=" +
                        oracle_double_to_string(score.value) + " actual=" + oracle_double_to_string(found->second));
                maximum_error = std::max(maximum_error, std::abs(found->second - score.value));
                minimum_value = std::min(minimum_value, score.value);
                maximum_value = std::max(maximum_value, score.value);
                ++checked;
            }
            if (!checked || actual.size() != checked)
                throw std::runtime_error("Vulkan feature series contains missing or unexpected entries");
            if (filter == "speed_chroma" && maximum_value <= 0)
                throw std::runtime_error("SpEED fixture must exercise a nonzero, nonsingular feature result");
            if (filter == "cambi") {
                const auto frames = depth == 8 ? 6u : 12u;
                const auto sample_bytes = depth == 8 ? 1u : 3u;
                const std::uint64_t maximum_upload = std::uint64_t(width) * height * 6u * sample_bytes +
                    std::uint64_t(frames) * 65536u;
                if (backend->timings().uploaded_bytes > maximum_upload)
                    throw std::runtime_error("CAMBI must upload scalar metadata instead of the entire GPU image workspace");
            }
            std::cout << "PASS feature=" << filter << " depth=" << depth << " scores=" << checked
                      << " min=" << oracle_double_to_string(minimum_value)
                      << " max=" << oracle_double_to_string(maximum_value)
                      << " max_abs_error=" << oracle_double_to_string(maximum_error) << '\n';
            if (filter == "all") {
                ModelOracle imported(models, config, OracleMode::ImportedFeatures);
                std::vector<FeatureScore> scores;
                for (const auto &item : actual) scores.push_back({item.first.first, item.first.second, item.second});
                imported.import_scores(scores);
                const auto result = imported.finish(6);
                for (const auto &model : expected.model_scores) {
                    const auto &values = result.model_scores.at(model.first);
                    if (values.size() != model.second.size()) throw std::runtime_error("Vulkan model score count mismatch");
                    for (unsigned i = 0; i < values.size(); ++i)
                        if (std::abs(values[i] - model.second[i]) > 1e-4)
                            throw std::runtime_error("Vulkan VMAF mismatch: " + model.first);
                    const auto &cpu_pool = expected.pooled.at(model.first);
                    const auto &gpu_pool = result.pooled.at(model.first);
                    for (double difference : {gpu_pool.mean - cpu_pool.mean,
                            gpu_pool.minimum - cpu_pool.minimum, gpu_pool.maximum - cpu_pool.maximum,
                            gpu_pool.harmonic_mean - cpu_pool.harmonic_mean})
                        if (!std::isfinite(difference) || std::abs(difference) > 1e-4)
                            throw std::runtime_error("Vulkan pooled VMAF mismatch: " + model.first);
                }
                std::cout << "PASS all eight official frame and pooled model scores depth=" << depth << '\n';
            }
        }
        const auto timing = backend->timings();
        std::cout << "RECEIPT allocated_bytes=" << timing.allocated_bytes
                  << " uploaded_bytes=" << timing.uploaded_bytes
                  << " downloaded_bytes=" << timing.downloaded_bytes
                  << " cpu_postprocess_ms=" << timing.cpu_postprocess_ms << '\n';
        if (std::getenv("BITOVP_VULKAN_PROFILE_PASSES"))
            for (const auto &entry : timing.extractor_kernel_ms)
                std::cout << "PROFILE " << entry.first << "=" << entry.second << " ms\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "FAIL " << error.what() << '\n';
        return 1;
    }
}
