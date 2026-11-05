// SPDX-License-Identifier: MIT
#include "model_oracle.hpp"
#include <libvmaf/libvmaf.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <iostream>
#include <limits>
#include <stdexcept>

using namespace bitovp::gpu;
namespace {
void require(bool value, const char *message) { if (!value) throw std::runtime_error(message); }
void official(int error, const char *operation) {
    if (error) throw std::runtime_error(std::string(operation) + " failed: " + std::to_string(error));
}
template<class F> void rejects(F action, const char *message) {
    bool rejected = false;
    try { action(); } catch (const std::exception &) { rejected = true; }
    require(rejected, message);
}
struct Frame {
    Picture picture;
    std::array<std::vector<unsigned char>, 3> storage;
    Frame(unsigned bits, unsigned index) {
        picture.bit_depth = bits;
        for (unsigned p = 0; p < 3; ++p) {
            const unsigned width = p ? 320 : 640, height = p ? 180 : 360;
            const unsigned bytes = bits > 8 ? 2 : 1;
            const auto stride = (width + 11u + p) * bytes;
            storage[p].resize(stride * height, 0xa5);
            for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
                const std::uint16_t sample = p ? (128u << (bits - 8)) :
                    ((24u + ((x + index * 2) / 8 + y / 40) % 180u) << (bits - 8)) +
                    (bits == 10 ? index % 4u : 0u);
                std::memcpy(storage[p].data() + y * stride + x * bytes, &sample, bytes);
            }
            picture.planes[p] = {storage[p].data(), stride, width, height};
        }
    }
};
struct Direct {
    VmafContext *context = nullptr;
    explicit Direct(const FeatureInput &input) {
        VmafConfiguration config{};
        config.log_level = VMAF_LOG_LEVEL_ERROR;
        config.gpumask = 1;
        config.n_subsample = 1;
        official(vmaf_init(&context, config), "direct init");
        VmafFeatureDictionary *dictionary = nullptr;
        for (const auto &[key, value] : input.options)
            official(vmaf_feature_dictionary_set(&dictionary, key.c_str(), value.c_str()), "direct option");
        official(vmaf_use_feature(context, "cambi", dictionary), "direct feature-only registration");
    }
    ~Direct() { if (context) vmaf_close(context); }
    void submit(unsigned index, const Picture &picture) {
        VmafPicture ref{}, dist{};
        official(vmaf_picture_alloc(&ref, VMAF_PIX_FMT_YUV420P, picture.bit_depth, 640, 360), "direct ref");
        official(vmaf_picture_alloc(&dist, VMAF_PIX_FMT_YUV420P, picture.bit_depth, 640, 360), "direct dist");
        for (unsigned p = 0; p < 3; ++p) for (unsigned y = 0; y < ref.h[p]; ++y) {
            const auto *data = static_cast<const unsigned char *>(picture.planes[p].data) +
                               y * picture.planes[p].stride;
            const auto count = ref.w[p] * (picture.bit_depth > 8 ? 2 : 1);
            std::memcpy(static_cast<unsigned char *>(ref.data[p]) + y * ref.stride[p], data, count);
            std::memcpy(static_cast<unsigned char *>(dist.data[p]) + y * dist.stride[p], data, count);
        }
        official(vmaf_read_pictures(context, &ref, &dist, index), "direct read");
        if (ref.ref) vmaf_picture_unref(&ref);
        if (dist.ref) vmaf_picture_unref(&dist);
    }
};
void check(unsigned bits) {
    const FeatureInput feature{"cambi", {{"enc_width", "640"}, {"enc_height", "360"},
                                         {"enc_bitdepth", std::to_string(bits)}}};
    const ModelOracleConfig config{640, 360, bits, 1, false};
    ModelOracle oracle({}, config, OracleMode::Cpu, {feature});
    Direct direct(feature);
    const auto &plan = oracle.feature_plan();
    require(plan.extractors.size() == 1 && plan.extractors[0].name == "cambi",
            "Standalone plan includes unrelated model features");
    const auto &extractor = plan.extractors[0];
    require(extractor.options.at("cambi_max_val") == "1000" &&
            extractor.options.at("full_ref") == "false" &&
            extractor.options.at("heatmaps_path").empty() &&
            extractor.options.at("window_size") == "65", "Official defaults changed or model clipping leaked");
    for (unsigned i = 0; i < 6; ++i) {
        Frame frame(bits, i);
        oracle.submit(i, frame.picture, frame.picture);
        direct.submit(i, frame.picture);
    }
    official(vmaf_read_pictures(direct.context, nullptr, nullptr, 0), "direct flush");
    const auto result = oracle.finish(6);
    require(result.features.size() == 6 && result.model_scores.empty() && result.pooled.empty(),
            "Standalone oracle invented a model score or omitted a feature");
    double maximum = 0;
    for (const auto &value : result.features) {
        double expected = 0;
        official(vmaf_feature_score_at_index(direct.context, value.name.c_str(), &expected,
                                             value.index), "direct score");
        require(std::isfinite(value.value) && value.value == expected,
                "Standalone oracle differs from independent public libvmaf extraction");
        maximum = std::max(maximum, value.value);
    }
    require(maximum > 17, "Fixture did not exercise CAMBI above the legacy model clip");
    ModelOracle imported({}, config, OracleMode::ImportedFeatures, {feature});
    imported.import_scores(result.features);
    const auto actual = imported.finish(6);
    for (unsigned i = 0; i < 6; ++i)
        require(actual.features[i].value == result.features[i].value, "Imported CAMBI value changed");
    ModelOracle incomplete({}, config, OracleMode::ImportedFeatures, {feature});
    incomplete.import_scores({result.features.front()});
    rejects([&] { incomplete.finish(6); }, "Incomplete CAMBI coverage was accepted");
    FeatureInput invalid = feature;
    invalid.options["enc_wdith"] = "640";
    rejects([&] { ModelOracle bad({}, config, OracleMode::Cpu, {invalid}); },
            "Unknown standalone option was accepted");
    std::cout << "CAMBI-only public CPU parity: " << bits << " bit, 6 frames, maximum=" << maximum << '\n';
    std::cout << "Feature name: " << extractor.provided_features.at(0) << '\n';
    for (const auto &[key, value] : extractor.options) std::cout << key << '=' << value << '\n';
}
}
int main() {
    try {
        check(8); check(10);
        std::cout << "standalone_cambi_oracle: PASS\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "standalone_cambi_oracle: FAIL: " << error.what() << '\n';
        return 1;
    }
}
