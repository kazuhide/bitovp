/*
 * Copyright 2016-2020 Netflix, Inc.
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
// Adapted from Netflix/vmaf 74f930d17de8c58e7c2ce55e2b897b0030ebd8ef:
// feature/cambi.c and feature/luminance_tools.c. Only scalar configuration is
// evaluated on the CPU; image processing and spatial pooling run in Vulkan.
#pragma once
#include "bitovp_gpu.hpp"
#include "cambi_lut.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>

namespace bitovp::gpu::vulkan_detail {
inline double option(const ExtractorSpec &spec, const char *name, double fallback) {
    const auto found = spec.options.find(name);
    if (found == spec.options.end()) return fallback;
    std::size_t consumed = 0;
    const double value = std::stod(found->second, &consumed);
    if (consumed != found->second.size() || !std::isfinite(value))
        throw std::invalid_argument(std::string("invalid Vulkan option: ") + name);
    return value;
}
inline bool boolean(const ExtractorSpec &spec, const char *name, bool fallback = false) {
    const auto found = spec.options.find(name);
    if (found == spec.options.end()) return fallback;
    if (found->second == "true" || found->second == "1") return true;
    if (found->second == "false" || found->second == "0") return false;
    throw std::invalid_argument(std::string("invalid Vulkan boolean: ") + name);
}
inline std::string text_option(const ExtractorSpec &spec, const char *name, const char *fallback) {
    const auto found = spec.options.find(name);
    return found == spec.options.end() ? std::string(fallback) : found->second;
}
inline double cambi_luminance(int sample, bool pq) {
    const double v = double(std::clamp(sample, 64, 940) - 64) / (940 - 64);
    if (pq) {
        const double m1 = 0.1593017578125, m2 = 78.84375;
        const double c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
        const double numerator = std::max(std::pow(v, 1.0 / m2) - c1, 0.0);
        const double denominator = c2 - c3 * std::pow(v, 1.0 / m2);
        return 10000 * std::pow(numerator / denominator, 1.0 / m1);
    }
    const double gamma = 2.4, white = 300.0, black = 0.01;
    const double a = std::pow(std::pow(white, 1.0 / gamma) - std::pow(black, 1.0 / gamma), gamma);
    const double b = std::pow(black, 1.0 / gamma) /
        (std::pow(white, 1.0 / gamma) - std::pow(black, 1.0 / gamma));
    return a * std::pow(std::max(v + b, 0.0), gamma);
}
inline unsigned cambi_tvi(unsigned difference, double threshold, bool pq) {
    const auto condition = [&](int sample) {
        const double luminance = cambi_luminance(sample, pq);
        return cambi_luminance(sample + int(difference), pq) - luminance > threshold * luminance;
    };
    const auto direction = [&](int sample) {
        if (!condition(sample)) return 1;
        return condition(sample + 1) ? -1 : 0;
    };
    int foot = 64, head = 940 - int(difference) - 1;
    int flag = direction(foot);
    if (flag == 1) return 0;
    if (!flag) return unsigned(foot);
    flag = direction(head);
    if (flag == -1) return 1023;
    if (!flag) return unsigned(head);
    for (unsigned iteration = 0; iteration < 2048; ++iteration) {
        const int middle = foot + (head - foot) / 2;
        flag = direction(middle);
        if (!flag) return unsigned(middle);
        if (flag == 1) head = middle;
        else foot = middle;
    }
    throw std::runtime_error("CAMBI TVI bisection failed");
}

struct CambiParameters {
    ExtractorSpec spec;
    std::vector<std::uint32_t> words;
    std::size_t word_count = 0;
    unsigned width = 0, height = 0, window = 0;
    double topk = 0, maximum = 0;
    bool high_resolution = false;
    std::uint32_t image_a = 0, image_b = 0, mask_a = 0, mask_b = 0, scores = 0;

    CambiParameters(const ExtractorSpec &extractor, const FeaturePlan &plan) : spec(extractor) {
        if (boolean(spec, "full_ref"))
            throw std::invalid_argument("Vulkan CAMBI full_ref is not part of the qualified eight-model plan");
        const auto heatmap = text_option(spec, "heatmaps_path", "");
        if (!heatmap.empty()) throw std::invalid_argument("Vulkan CAMBI heatmaps are not supported");
        width = unsigned(option(spec, "enc_width", 0));
        height = unsigned(option(spec, "enc_height", 0));
        if (!width || !height || width > plan.width || height > plan.height) {
            width = plan.width;
            height = plan.height;
        }
        if ((width < 216 && height < 216) || width > 7680 || height > 7680)
            throw std::invalid_argument("invalid Vulkan CAMBI encoding geometry");
        unsigned encoded_depth = unsigned(option(spec, "enc_bitdepth", 0));
        if (!encoded_depth) encoded_depth = plan.bit_depth;
        const unsigned contrast_log = unsigned(option(spec, "max_log_contrast", 2));
        if (contrast_log > 5) throw std::invalid_argument("invalid CAMBI max_log_contrast");
        const unsigned differences = 1u << contrast_log;
        const unsigned speedup = unsigned(option(spec, "cambi_high_res_speedup", 0));
        const auto pixels = std::uint64_t(width) * height;
        high_resolution = (speedup == 1080 && pixels >= 1920u * 1080u) ||
            (speedup == 1440 && pixels >= 2560u * 1440u) ||
            (speedup == 2160 && pixels >= 3840u * 2160u);
        window = (unsigned(option(spec, "window_size", 65)) * (width + height) / 375u) >> 4u;
        if (high_resolution) window = (window + 1u) >> 1u;
        window |= 1u;
        if (window * window >= 4226) throw std::invalid_argument("CAMBI window exceeds reciprocal LUT");
        topk = option(spec, "topk", 0.6);
        if (topk == 0.6) topk = option(spec, "cambi_topk", 0.6);
        maximum = option(spec, "cambi_max_val", 1000);
        if (!(topk >= 0.0001 && topk <= 1) || maximum < 0)
            throw std::invalid_argument("invalid Vulkan CAMBI pooling options");
        std::string eotf = text_option(spec, "cambi_eotf", "bt1886");
        if (eotf == "bt1886") eotf = text_option(spec, "eotf", "bt1886");
        if (eotf != "bt1886" && eotf != "pq") throw std::invalid_argument("invalid CAMBI EOTF");
        const bool pq = eotf == "pq";
        const double visibility = option(spec, "cambi_vis_lum_threshold", 0);
        unsigned vlt = 64;
        while (vlt <= 1023 && cambi_luminance(int(vlt), pq) < visibility) ++vlt;
        if (vlt == 64) vlt = 0;
        if (vlt > 1023) throw std::invalid_argument("CAMBI visibility threshold is outside the EOTF range");
        unsigned shifted = (width >> 6u) * (height >> 6u), ceil_log = 0;
        if (shifted) for (--shifted; shifted; shifted >>= 1u) ++ceil_log;
        const unsigned mask_index = unsigned((49 + 3 * (int(ceil_log) - 11) - 1) >> 1);
        words.resize(64);
        words[0] = width; words[1] = height; words[2] = plan.width; words[3] = plan.height;
        words[5] = plan.bit_depth; words[6] = encoded_depth;
        words[7] = window; words[8] = differences; words[9] = vlt; words[10] = mask_index;
        words[21] = words.size();
        const double threshold = option(spec, "tvi_threshold", 0.019);
        for (unsigned d = 0; d < 32; ++d)
            words.push_back(d < differences ? cambi_tvi(d + 1u, threshold, pq) + differences : 0u);
        words[22] = words.size();
        for (float value : cambi_reciprocal_lut) {
            std::uint32_t bits;
            std::memcpy(&bits, &value, sizeof(bits));
            words.push_back(bits);
        }
        const auto add_map = [&](unsigned input, unsigned output) {
            const auto offset = std::uint32_t(words.size());
            const float ratio = float(input) / float(output);
            float position = ratio / 2.0f - 0.5f;
            for (unsigned i = 0; i < output; ++i) {
                words.push_back(unsigned(int(position + 0.5f)));
                position += ratio;
            }
            return offset;
        };
        words[23] = add_map(plan.width, width);
        words[24] = add_map(plan.height, height);
        scores = words[25] = words.size();
        words.resize(words.size() + 10, 0);
        word_count = words.size();
        const auto image = [&] {
            const auto offset = std::uint32_t(word_count);
            word_count += std::size_t(width) * height;
            return offset;
        };
        image_a = words[16] = image(); image_b = words[17] = image();
        mask_a = words[18] = image(); mask_b = words[19] = image();
        words[20] = image();
        // Each 256-pixel workgroup writes a double sum and an integer count.
        // The radix histogram and selection state occupy reserved words 32..50.
        words[26] = std::uint32_t(word_count);
        words[27] = unsigned((pixels + 255u) / 256u);
        word_count += std::size_t(words[27]) * 3u;
    }
};
} // namespace bitovp::gpu::vulkan_detail
