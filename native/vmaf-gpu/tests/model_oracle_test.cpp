// SPDX-License-Identifier: MIT
#include "model_oracle.hpp"

#include <libvmaf/libvmaf.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <limits>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

using namespace bitovp::gpu;

namespace {
constexpr unsigned fixture_width = 768, fixture_height = 768;
void require(bool condition, const std::string &message) {
    if (!condition) throw std::runtime_error(message);
}
void official(int error, const char *operation) {
    if (error) throw std::runtime_error(std::string(operation) + ": " +
                                        std::to_string(error));
}
template <class F> void rejects(F operation, const char *message) {
    bool rejected = false;
    try { operation(); } catch (const std::exception &) { rejected = true; }
    require(rejected, message);
}

// Padding is deliberately nonzero and every plane has a different byte stride.
// Values are native-endian samples, including at 10 bits.
struct Frame {
    Picture picture;
    std::array<std::vector<std::uint16_t>, 3> storage;
    Frame(unsigned bits, unsigned frame_index, bool distorted) {
        picture.bit_depth = bits;
        for (unsigned plane = 0; plane < 3; ++plane) {
            const unsigned width = plane ? fixture_width / 2 : fixture_width;
            const unsigned height = plane ? fixture_height / 2 : fixture_height;
            const std::size_t stride = (width + 18 + plane * 8) *
                                       (bits == 8 ? 1 : 2);
            storage[plane].resize((stride * height + 1) / 2, 0xa5a5);
            auto *bytes = reinterpret_cast<unsigned char *>(storage[plane].data());
            for (unsigned y = 0; y < height; ++y) {
                for (unsigned x = 0; x < width; ++x) {
                    std::uint32_t noise = ((x + frame_index) * 73856093u) ^
                                          (y * 19349663u) ^ (plane * 83492791u);
                    noise ^= noise >> 13u;
                    noise *= 1274126177u;
                    noise ^= noise >> 16u;
                    unsigned base = 64u + (noise & 127u);
                    if (distorted) base = (base / (2u + plane)) * (2u + plane) +
                                          ((x + y + frame_index) % 19u == 0u);
                    // Nonzero 10-bit low bits distinguish native 10-bit data
                    // from merely shifting an 8-bit fixture into a 16-bit word.
                    const unsigned value = (base << (bits - 8)) +
                        (bits == 10 ? ((noise >> (distorted ? 4u : 2u)) & 3u) : 0u);
                    if (bits == 8) bytes[y * stride + x] = value;
                    else {
                        const std::uint16_t sample = value;
                        std::memcpy(bytes + y * stride + x * 2, &sample, 2);
                    }
                }
            }
            picture.planes[plane] = {bytes, stride, width, height};
        }
    }
};

// This context uses only the official public CPU extraction/prediction API.
// It does not call the adapter or reuse the oracle's collector.
struct DirectCpu {
    std::vector<VmafModel *> models;
    VmafContext *context = nullptr;
    explicit DirectCpu(const std::vector<ModelInput> &inputs, unsigned threads) {
        VmafConfiguration config{};
        config.log_level = VMAF_LOG_LEVEL_ERROR;
        config.n_threads = threads;
        config.n_subsample = 1;
        config.gpumask = 1;
        official(vmaf_init(&context, config), "direct init");
        try {
            for (const auto &input : inputs) {
                VmafModel *model = nullptr;
                VmafModelConfig model_config{};
                model_config.name = input.id.c_str();
                official(vmaf_model_load_from_path(&model, &model_config,
                                                  input.path.c_str()), "direct model");
                models.push_back(model);
                for (const auto &[extractor, options] : input.feature_overrides) {
                    VmafFeatureDictionary *dictionary = nullptr;
                    for (const auto &[key, value] : options)
                        official(vmaf_feature_dictionary_set(&dictionary, key.c_str(),
                                                             value.c_str()), "direct option");
                    official(vmaf_model_feature_overload(model, extractor.c_str(), dictionary),
                             "direct override");
                }
                official(vmaf_use_features_from_model(context, model), "direct features");
            }
            official(vmaf_use_feature(context, "psnr", nullptr), "direct psnr");
        } catch (...) { close(); throw; }
    }
    void close() {
        if (context) vmaf_close(context);
        context = nullptr;
        for (auto *model : models) vmaf_model_destroy(model);
        models.clear();
    }
    ~DirectCpu() { close(); }
    void submit(unsigned index, const Picture &reference, const Picture &distorted) {
        VmafPicture ref{}, dist{};
        official(vmaf_picture_alloc(&ref, VMAF_PIX_FMT_YUV420P,
                                    reference.bit_depth, fixture_width, fixture_height), "direct ref alloc");
        try {
            official(vmaf_picture_alloc(&dist, VMAF_PIX_FMT_YUV420P,
                                        distorted.bit_depth, fixture_width, fixture_height), "direct dist alloc");
            for (unsigned p = 0; p < 3; ++p) {
                for (unsigned y = 0; y < ref.h[p]; ++y) {
                    const std::size_t count = ref.w[p] * (ref.bpc > 8 ? 2 : 1);
                    std::memcpy(static_cast<unsigned char *>(ref.data[p]) + y * ref.stride[p],
                                static_cast<const unsigned char *>(reference.planes[p].data) +
                                    y * reference.planes[p].stride, count);
                    std::memcpy(static_cast<unsigned char *>(dist.data[p]) + y * dist.stride[p],
                                static_cast<const unsigned char *>(distorted.planes[p].data) +
                                    y * distorted.planes[p].stride, count);
                }
            }
            official(vmaf_read_pictures(context, &ref, &dist, index), "direct read");
        } catch (...) {
            if (ref.ref) vmaf_picture_unref(&ref);
            if (dist.ref) vmaf_picture_unref(&dist);
            throw;
        }
        if (ref.ref) vmaf_picture_unref(&ref);
        if (dist.ref) vmaf_picture_unref(&dist);
    }
};

std::vector<ModelInput> all_models(const std::filesystem::path &root) {
    std::vector<ModelInput> inputs;
    for (const auto &family : {"vmaf_v1.0.16", "vmaf_v1.0.16_hfr"}) {
        for (const auto &view : {"3d0h", "3d0h_2160", "5d0h", "1d5h_2160"}) {
            const std::string id = std::string(family) + "_" + view;
            inputs.push_back({id, (root / family / (id + ".json")).string(), {}});
        }
    }
    return inputs;
}

void compare_all_models(const std::vector<ModelInput> &models, unsigned bits,
                        unsigned count, unsigned threads) {
    ModelOracleConfig config{fixture_width, fixture_height, bits, threads, true};
    ModelOracle cpu(models, config, OracleMode::Cpu);
    DirectCpu direct(models, threads);
    std::set<std::string> names;
    unsigned adm_specs = 0, motion_specs = 0;
    for (const auto &extractor : cpu.feature_plan().extractors) {
        if (extractor.name == "adm") ++adm_specs;
        if (extractor.name == "motion") ++motion_specs;
        require(!extractor.options.empty(), "effective defaults missing");
        for (const auto &name : extractor.provided_features) {
            names.insert(name);
            bool mapped = false;
            for (const auto &[base, canonical] : extractor.canonical_names)
                mapped |= canonical == name;
            require(mapped, "required feature lacks official canonical map");
        }
    }
    require(adm_specs == 4, "distinct viewing distances were merged in the plan");
    require(motion_specs == 2, "normal and HFR motion options were merged");
    for (unsigned i = 0; i < count; ++i) {
        Frame ref(bits, i, false), dist(bits, i, true);
        cpu.submit(i, ref.picture, dist.picture);
        direct.submit(i, ref.picture, dist.picture);
    }
    official(vmaf_read_pictures(direct.context, nullptr, nullptr, 0), "direct flush");
    const auto result = cpu.finish(count);
    require(result.frame_count == count && result.features.size() == names.size() * count,
            "flush omitted a frame or required delayed feature");
    bool nonzero_speed = false;
    for (const auto &feature : result.features) {
        double expected = 0;
        official(vmaf_feature_score_at_index(direct.context, feature.name.c_str(),
                                             &expected, feature.index), "direct feature");
        require(feature.value == expected, "CPU feature differs from official double");
        if (feature.name.find("speed_chroma_uv") == 0 && feature.value > 0)
            nonzero_speed = true;
    }
    require(nonzero_speed, "fixture reached only SpEED's degenerate zero-result path");
    for (std::size_t m = 0; m < models.size(); ++m) {
        const auto &values = result.model_scores.at(models[m].id);
        require(values.size() == count, "model frame count mismatch");
        for (unsigned i = 0; i < count; ++i) {
            double expected = 0;
            official(vmaf_score_at_index(direct.context, direct.models[m], &expected, i),
                     "direct predict");
            require(values[i] == expected, "prediction differs from official double");
        }
        const auto &pooled = result.pooled.at(models[m].id);
        const std::array<std::pair<VmafPoolingMethod, double>, 4> pools{{
            {VMAF_POOL_METHOD_MIN, pooled.minimum}, {VMAF_POOL_METHOD_MAX, pooled.maximum},
            {VMAF_POOL_METHOD_MEAN, pooled.mean},
            {VMAF_POOL_METHOD_HARMONIC_MEAN, pooled.harmonic_mean}}};
        for (const auto &[method, actual] : pools) {
            double expected = 0;
            official(vmaf_score_pooled(direct.context, direct.models[m], method, &expected,
                                      0, count - 1), "direct pooling");
            require(actual == expected, "pooling differs from official double");
        }
    }
    ModelOracle imported(models, config, OracleMode::ImportedFeatures);
    auto reversed = result.features;
    std::reverse(reversed.begin(), reversed.end());
    imported.import_scores(reversed); // Temporal backends may return earlier indices.
    const auto predicted = imported.finish(count);
    require(predicted.model_scores == result.model_scores,
            "imported features changed official model predictions");
    for (const auto &[id, pooled] : result.pooled) {
        const auto &other = predicted.pooled.at(id);
        require(pooled.mean == other.mean && pooled.minimum == other.minimum &&
                    pooled.maximum == other.maximum && pooled.harmonic_mean == other.harmonic_mean,
                "imported feature pooling differs");
    }
    rejects([&] { cpu.finish(count); }, "finish may be called twice");
    std::cout << "official CPU/import parity: " << models.size() << " models, " << bits
              << " bit, " << count << " frames, threads=" << threads << '\n';
}

void boundaries(const ModelInput &model) {
    const ModelOracleConfig config{fixture_width, fixture_height, 8, 1, true};
    Frame ref(8, 0, false), dist(8, 0, true);
    rejects([&] { ModelOracle rejected({model}, {128, 128, 8, 1, true}, OracleMode::Cpu); },
            "unsafe small SpEED geometry accepted");
    ModelOracle cpu({model}, config, OracleMode::Cpu);
    rejects([&] { cpu.submit(1, ref.picture, dist.picture); }, "nonsequential index accepted");
    Picture wrong = ref.picture;
    wrong.memory = PictureMemory::CudaDevice;
    rejects([&] { cpu.submit(0, wrong, dist.picture); }, "device picture accepted by CPU oracle");
    wrong = ref.picture;
    wrong.cuda_ready_event = reinterpret_cast<void *>(1);
    rejects([&] { cpu.submit(0, wrong, dist.picture); }, "CUDA readiness event accepted on CPU host picture");
    wrong = ref.picture;
    wrong.planes[1].stride = 0;
    rejects([&] { cpu.submit(0, wrong, dist.picture); }, "invalid chroma stride accepted");
    cpu.submit(0, ref.picture, dist.picture);
    const auto result = cpu.finish(1);
    require(!result.features.empty(), "one-frame flush produced no features");
    for (const auto &kind : {"duplicate", "unknown", "nonfinite", "past-end", "missing"}) {
        ModelOracle imported({model}, config, OracleMode::ImportedFeatures);
        if (std::string(kind) == "duplicate") {
            imported.import_scores({result.features.front()});
            rejects([&] { imported.import_scores({result.features.front()}); },
                    "duplicate feature accepted");
        } else if (std::string(kind) == "unknown") {
            rejects([&] { imported.import_scores({{0, "not-a-model-feature", 1}}); },
                    "unknown feature accepted");
        } else if (std::string(kind) == "nonfinite") {
            auto score = result.features.front();
            score.value = std::numeric_limits<double>::infinity();
            rejects([&] { imported.import_scores({score}); }, "infinite feature accepted");
        } else if (std::string(kind) == "past-end") {
            auto score = result.features.front();
            score.index = 1;
            imported.import_scores({score});
            rejects([&] { imported.finish(1); }, "out-of-range feature accepted");
        } else {
            auto incomplete = result.features;
            incomplete.pop_back();
            imported.import_scores(incomplete);
            rejects([&] { imported.finish(1); }, "missing delayed feature accepted");
        }
    }
    ModelInput bad = model;
    bad.feature_overrides["cambi"]["enc_wdith"] = "320";
    rejects([&] { ModelOracle rejected({bad}, config, OracleMode::Cpu); },
            "unknown override spelling silently accepted");
    bad = model;
    bad.feature_overrides["not-required"] = {{"anything", "1"}};
    rejects([&] { ModelOracle rejected({bad}, config, OracleMode::Cpu); },
            "unrelated extractor override silently accepted");
    const double precise = std::nextafter(1.0, 2.0);
    require(std::stod(oracle_double_to_string(precise)) == precise,
            "feature output lost double precision");
    std::cout << "input/import boundary and precision checks passed\n";
}
} // namespace

int main(int argc, char **argv) {
    try {
        require(argc == 2, "usage: model_oracle_test /official/vmaf/model");
        const auto models = all_models(argv[1]);
        compare_all_models(models, 8, 6, 1);
        compare_all_models(models, 10, 2, 2);
        boundaries(models.back());
        std::cout << "model_oracle_test: PASS\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "model_oracle_test: FAIL: " << error.what() << '\n';
        return 1;
    }
}
