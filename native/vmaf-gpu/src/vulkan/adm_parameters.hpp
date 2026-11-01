/*
 * Copyright 2016-2020 Netflix, Inc.
 * Copyright (c) 2026 Kazuhide Yamamoto
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
// Configuration math and constants adapted from Netflix/vmaf
// 74f930d17de8c58e7c2ce55e2b897b0030ebd8ef:
// integer_adm.c/.h and barten_csf_tools.h. No image samples are computed here.
#pragma once
#include "bitovp_gpu.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>

namespace bitovp::gpu::vulkan_detail {
struct AdmPass {
    std::array<std::uint32_t, 8> push{};
    std::uint32_t groups_x = 1, groups_y = 1;
};

inline double adm_option(const ExtractorSpec &spec, const char *name, double fallback) {
    const auto found = spec.options.find(name);
    if (found == spec.options.end()) return fallback;
    if (found->second == "true") return 1;
    if (found->second == "false") return 0;
    std::size_t end = 0;
    const double value = std::stod(found->second, &end);
    if (end != found->second.size() || !std::isfinite(value))
        throw std::invalid_argument(std::string("invalid Vulkan ADM option: ") + name);
    return value;
}

struct AdmParameters {
    ExtractorSpec spec;
    std::vector<std::uint32_t> words;
    std::size_t word_count = 0;
    std::vector<AdmPass> passes;
    std::uint32_t result_offset = 0;
    // Header word zero is never an allocated map; compact CSF uses it as an
    // invalid sentinel for orientation-map slots that no valid pass accesses.
    static constexpr std::uint32_t unused_csf_map_offset = 0;

    static unsigned ceil_log2(unsigned value) {
        unsigned result = 0;
        for (--value; value; value >>= 1) ++result;
        return result;
    }
    void set_float(unsigned offset, float value) {
        std::memcpy(&words.at(offset), &value, sizeof(value));
    }
    void set_double(unsigned offset, double value) {
        std::memcpy(&words.at(offset), &value, sizeof(value));
    }
    std::uint32_t allocate(std::size_t count) {
        if (count > std::numeric_limits<std::uint32_t>::max() - word_count)
            throw std::invalid_argument("Vulkan ADM workspace exceeds 32-bit word offsets");
        const auto offset = static_cast<std::uint32_t>(word_count);
        word_count += count;
        return offset;
    }
    void add(unsigned mode, unsigned scale, unsigned width, unsigned height,
             unsigned source_width, unsigned source_height, unsigned selector,
             bool rows = false, bool single = false) {
        AdmPass pass;
        pass.push = {mode, scale, width, height, source_width, source_height, selector, 0};
        pass.groups_x = single ? 1 : rows ? height : (width + 15) / 16;
        pass.groups_y = rows || single ? 1 : (height + 15) / 16;
        passes.push_back(pass);
    }

    AdmParameters(const ExtractorSpec &extractor, const FeaturePlan &plan,
                  bool compact_csf = false, bool scalar_totals = false) : spec(extractor) {
        if ((plan.bit_depth != 8 && plan.bit_depth != 10) || plan.width < 64 || plan.height < 64 ||
            plan.width > 7680 || plan.height > 7680)
            throw std::invalid_argument("Vulkan ADM requires supported 8/10-bit geometry");
        const std::array<const char *, 13> known = {"debug", "adm_csf_scale", "adm_csf_diag_scale",
            "adm_dlm_weight", "adm_enhn_gain_limit", "adm_norm_view_dist", "adm_norm_view_dist_extra",
            "adm_ref_display_height", "adm_csf_mode", "adm_noise_weight", "adm_skip_aim",
            "adm_skip_scale0", "adm_min_val"};
        for (const auto &entry : spec.options)
            if (std::find(known.begin(), known.end(), entry.first) == known.end())
                throw std::invalid_argument("unknown Vulkan ADM option: " + entry.first);
        if (adm_option(spec, "adm_csf_mode", 0) != 2 ||
            adm_option(spec, "adm_norm_view_dist_extra", 0) != 0 ||
            adm_option(spec, "adm_skip_aim", 0) != 0 || adm_option(spec, "adm_skip_scale0", 0) != 0)
            throw std::invalid_argument("Vulkan ADM currently qualifies the eight v1 mode-2 plans without skipped stages");
        const double distance = adm_option(spec, "adm_norm_view_dist", 3);
        const unsigned display = static_cast<unsigned>(adm_option(spec, "adm_ref_display_height", 1080));
        // Official blended-CSF tables, narrowed to the three conditions used by
        // all eight v1.0.16 / HFR models. 2160@1.5H shares 1080@3H PPD.
        static const float coefficients[3][2][4] = {
            {{0.01183f, 0.025026f, 0.04295f, 0.058621f},
             {0.004302f, 0.011778f, 0.023918f, 0.035901f}},
            {{0.004212f, 0.014809f, 0.029642f, 0.047464f},
             {0.000984f, 0.005852f, 0.0146f, 0.027574f}},
            {{0.00226f, 0.01183f, 0.025026f, 0.04295f},
             {0.000479f, 0.004302f, 0.011778f, 0.023918f}}};
        unsigned condition;
        if ((display == 1080 && distance == 3) || (display == 2160 && distance == 1.5)) condition = 0;
        else if (display == 1080 && distance == 5) condition = 1;
        else if (display == 2160 && distance == 3) condition = 2;
        else throw std::invalid_argument("Vulkan ADM viewing condition is outside the qualified model set");
        const double gain = adm_option(spec, "adm_enhn_gain_limit", 100);
        const double weight = adm_option(spec, "adm_dlm_weight", 0.5);
        const double minimum = adm_option(spec, "adm_min_val", 0);
        const double noise = adm_option(spec, "adm_noise_weight", 0.03125);
        if (gain < 1 || gain > 100 || weight < 0 || weight > 1 || minimum < 0 || minimum > 1 || noise < 0 || noise > 1500)
            throw std::invalid_argument("Vulkan ADM numeric option is outside its official range");
        words.resize(128, 0);
        word_count = words.size();
        words[0] = plan.width; words[1] = plan.height; words[2] = plan.bit_depth;
        words[3] = words[4] = plan.width * (plan.bit_depth > 8 ? 2 : 1);
        set_double(16, gain); set_double(18, weight); set_double(20, minimum);
        set_double(22, 1e-10 * (double(plan.width) * plan.height) / (1920.0 * 1080.0));
        const double radians = std::acos(-1.0) / 180.0;
        set_float(24, static_cast<float>(std::cos(radians) * std::cos(radians)));
        const std::size_t map_count = std::size_t((plan.width + 1) / 2) * ((plan.height + 1) / 2);
        const std::size_t temporary_count = std::size_t(plan.width) * ((plan.height + 1) / 2);
        for (unsigned map = 0; map < 20; ++map) {
            const bool unused = map == 15 || map == 16 || map == 18 || map == 19;
            words[32 + map] = compact_csf && unused ? unused_csf_map_offset : allocate(map_count);
        }
        words[52] = allocate(temporary_count); words[53] = allocate(temporary_count);
        for (unsigned slot = 54; slot <= 56; ++slot) words[slot] = allocate(((plan.height + 1) / 2) * 3 * 2);
        words[57] = allocate(4 * 3);
        result_offset = words[58] = allocate(6); // ADM3, ADM2, AIM doubles.
        if (scalar_totals) words[59] = allocate(4 * 9 * 2); // Exact uint64 totals per scale.
        unsigned width = plan.width, height = plan.height;
        for (unsigned scale = 0; scale < 4; ++scale) {
            const unsigned output_width = (width + 1) / 2, output_height = (height + 1) / 2;
            const unsigned left = static_cast<unsigned>(output_width * 0.1 - 0.5);
            const unsigned top = static_cast<unsigned>(output_height * 0.1 - 0.5);
            const unsigned cropped_width = output_width - 2 * left, cropped_height = output_height - 2 * top;
            const unsigned base = 64 + scale * 16;
            words[base] = output_width; words[base + 1] = output_height;
            words[base + 2] = left; words[base + 3] = top;
            words[base + 4] = scale ? ceil_log2(cropped_width) :
                static_cast<unsigned>(std::max<int>(int(ceil_log2(cropped_width * cropped_height)) - 20, 0));
            words[base + 5] = scale ? ceil_log2(cropped_height) : 0;
            words[base + 6] = scale ? ceil_log2(output_width) : ceil_log2(output_width) - 4;
            words[base + 7] = scale ? words[base + 6] : ceil_log2(output_width) - 3;
            words[base + 8] = ceil_log2(output_height);
            for (unsigned orientation = 0; orientation < 2; ++orientation) {
                const float factor = coefficients[condition][orientation][scale];
                set_float(base + 9 + orientation, factor);
                const double multiplier = scale ? 4294967296.0 : orientation ? 8388608.0 : 2097152.0;
                const auto fixed = static_cast<std::uint32_t>(factor * multiplier);
                words[base + 11 + orientation] = scale ? fixed : fixed & 65535u;
            }
            set_float(base + 13, std::pow(static_cast<float>(double(cropped_width) * cropped_height * noise), 1.0f / 3.0f));
            for (unsigned image = 0; image < 2; ++image) {
                add(0, scale, width, output_height, width, height, image);
                add(1, scale, output_width, output_height, width, height, image);
            }
            add(2, scale, output_width, output_height, width, height, 0);
            for (unsigned aim = 0; aim < 2; ++aim) {
                add(3, scale, output_width, output_height, width, height, aim);
                add(4, scale, output_width, output_height, width, height, aim, true);
            }
            add(5, scale, output_width, output_height, width, height, 0, false, true);
            width = output_width; height = output_height;
        }
        add(6, 0, width, height, plan.width, plan.height, 0, false, true);
    }
};
}
