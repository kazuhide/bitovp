/*
 * Copyright 2016-2026 Netflix, Inc.
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
// integer_motion.c flush and motion_blend_tools.h. Temporal finalization uses
// a bounded four-scalar ring; reference images live in a separate GPU ring.
#pragma once
#include "cambi_parameters.hpp"

namespace bitovp::gpu::vulkan_detail {
struct MotionParameters {
    ExtractorSpec spec;
    double blend_factor, blend_offset, fps_weight, maximum, previous_processed = 0;
    bool five_frame, moving_average, force_zero;
    std::array<double, 4> sad{};

    explicit MotionParameters(const ExtractorSpec &value) : spec(value) {
        blend_factor = option(spec, "motion_blend_factor", 1);
        blend_offset = option(spec, "motion_blend_offset", 40);
        fps_weight = option(spec, "motion_fps_weight", 1);
        maximum = option(spec, "motion_max_val", 10000);
        five_frame = boolean(spec, "motion_five_frame_window");
        moving_average = boolean(spec, "motion_moving_average");
        force_zero = boolean(spec, "motion_force_zero");
        if (blend_factor < 0 || blend_factor > 1 || blend_offset < 0 || blend_offset > 1000 ||
            fps_weight < 0 || fps_weight > 5 || maximum < 0 || maximum > 10000)
            throw std::invalid_argument("invalid Vulkan motion options");
    }
    void emit(std::vector<FeatureScore> &output, const char *base, double value, std::uint64_t index) const {
        const auto name = spec.canonical_names.find(base);
        if (name != spec.canonical_names.end() &&
            std::find(spec.provided_features.begin(), spec.provided_features.end(), name->second) != spec.provided_features.end())
            output.push_back({index, name->second, value});
    }
    double blend(double value) const {
        return std::min(value * blend_factor + (1 - blend_factor) * std::min(blend_offset, value), maximum);
    }
    void finalize(std::uint64_t index, bool has_next, std::vector<FeatureScore> &output) {
        const unsigned stride = five_frame ? 2u : 1u;
        double motion2 = sad[index % sad.size()];
        if (has_next) {
            const std::uint64_t lo = index - (stride - 1u);
            motion2 = lo >= stride ? std::min(sad[lo % sad.size()], sad[(index + 1u) % sad.size()]) :
                sad[(index + 1u) % sad.size()];
        }
        const double processed = blend(motion2);
        const double motion3 = moving_average ? (processed + previous_processed) / 2.0 : processed;
        previous_processed = processed;
        emit(output, "VMAF_integer_feature_motion2_score", motion2, index);
        emit(output, "VMAF_integer_feature_motion3_score", motion3, index);
    }
    void append(std::uint64_t index, std::uint64_t integer_sad, std::uint64_t pixels,
                std::vector<FeatureScore> &output) {
        const unsigned stride = five_frame ? 2u : 1u;
        const double value = index < stride || force_zero ? 0 :
            std::min(double(integer_sad) / 256.0 / double(pixels) * fps_weight, maximum);
        sad[index % sad.size()] = value;
        emit(output, "VMAF_integer_feature_motion_sad_score", value, index);
        if (boolean(spec, "debug")) emit(output, "VMAF_integer_feature_motion_score", value, index);
        if (index == stride) {
            previous_processed = blend(value);
            for (unsigned i = 0; i < stride; ++i) {
                emit(output, "VMAF_integer_feature_motion2_score", 0, i);
                emit(output, "VMAF_integer_feature_motion3_score", previous_processed, i);
            }
        }
        if (index > stride) finalize(index - 1u, true, output);
    }
    void flush(std::uint64_t count, std::vector<FeatureScore> &output) {
        const unsigned stride = five_frame ? 2u : 1u;
        if (count <= stride) {
            for (std::uint64_t i = 0; i < count; ++i) {
                emit(output, "VMAF_integer_feature_motion2_score", 0, i);
                emit(output, "VMAF_integer_feature_motion3_score", 0, i);
            }
        } else finalize(count - 1u, false, output);
    }
};
} // namespace bitovp::gpu::vulkan_detail
