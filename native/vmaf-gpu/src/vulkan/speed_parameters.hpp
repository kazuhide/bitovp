/*
 * Copyright 2016-2025 Netflix, Inc.
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
// Adapted from Netflix/vmaf 74f930d17de8c58e7c2ce55e2b897b0030ebd8ef
// feature/speed.c and vif_tools.c. The CPU only prepares fixed coefficients
// and evaluates final scalar entropy/logarithms from GPU-produced statistics.
#pragma once
#include "cambi_parameters.hpp"
#include <array>

namespace bitovp::gpu::vulkan_detail {
struct SpeedMatrixSlot {
    unsigned covariance, eigenvalues, independent, solution, temporary, result, failure;
};
struct SpeedParameters {
    ExtractorSpec spec;
    std::vector<std::uint32_t> words;
    std::size_t word_count = 0;
    unsigned width, height, scaled_width, scaled_height, operating_width, operating_height;
    unsigned stride, blocks, frame_a, frame_b, temporary, downscaled, reference_result, distorted_result;
    // U reference/distorted, followed by V reference/distorted. Only small
    // matrix statistics are retained; the full image workspace is shared.
    std::array<SpeedMatrixSlot, 4> matrices;
    float sigma, floor;
    double maximum;
    unsigned weight_mode;
    bool resize;

    SpeedParameters(const ExtractorSpec &extractor, const FeaturePlan &plan)
        : spec(extractor), width(plan.width / 2), height(plan.height / 2) {
        const double prescale = option(spec, "speed_prescale", 1.0);
        const float kernelscale = float(option(spec, "speed_kernelscale", 1.0));
        sigma = float(option(spec, "speed_sigma_nn", 0.29));
        floor = float(option(spec, "speed_nn_floor", 0.0));
        maximum = option(spec, "speed_max_val", 1000);
        weight_mode = unsigned(option(spec, "speed_weight_var_mode", 0));
        if (!(prescale >= 0.1 && prescale <= 4) || weight_mode > 6 || !(sigma >= 0.1f && sigma <= 2.0f))
            throw std::invalid_argument("invalid Vulkan SPEED configuration");
        const auto method = text_option(spec, "speed_prescale_method", "nearest");
        resize = std::abs(prescale - 1.0) >= 1e-3;
        if (resize && method != "bilinear")
            throw std::invalid_argument("Vulkan SPEED currently qualifies bilinear prescaling only");
        scaled_width = unsigned(width * prescale + 0.5);
        scaled_height = unsigned(height * prescale + 0.5);
        operating_width = scaled_width >> 4u;
        operating_height = scaled_height >> 4u;
        blocks = (operating_width / 5u) * (operating_height / 5u);
        if (!blocks) throw std::invalid_argument("SPEED chroma is too small for its 5 by 5 block after prescale and decimation");
        stride = (std::max(width, scaled_width) + 7u) & ~7u;
        words.resize(64);
        words[0] = width; words[1] = height; words[2] = scaled_width; words[3] = scaled_height;
        words[4] = stride; words[5] = plan.bit_depth; words[6] = operating_width; words[7] = operating_height;
        const auto append_float = [&](float value) {
            std::uint32_t bits;
            std::memcpy(&bits, &value, sizeof(bits));
            words.push_back(bits);
        };
        const auto gaussian = [&](unsigned scale, bool antialias) {
            int size = int(std::ceil(float((1u << (4u - scale)) + 1u) * kernelscale));
            if ((size & 1) == 0) ++size;
            size = std::max(size, 3);
            const float deviation = antialias ? float(std::sqrt(4.0) * size / 5.0f) : size / 5.0f;
            std::vector<float> values;
            float sum = 0;
            for (int i = 0; i < size; ++i) {
                const float x = float(i - (size - 1) / 2);
                const float numerator = float(std::exp(-0.5 * x / deviation * x / deviation));
                const float denominator = float(1 / (deviation * std::sqrt(2 * 3.14159265358979323846)));
                const float value = numerator / denominator;
                values.push_back(value);
                sum += value;
            }
            const auto offset = unsigned(words.size());
            for (float value : values) append_float(value / sum);
            return std::array<unsigned, 2>{offset, unsigned(size)};
        };
        const auto antialias = gaussian(1, true), mean = gaussian(4, false);
        words[13] = antialias[0]; words[14] = antialias[1]; words[15] = mean[0]; words[16] = mean[1];
        const auto map = [&](unsigned source, unsigned destination, unsigned position) {
            const float ratio = float(source) / destination;
            words[position] = words.size();
            for (unsigned i = 0; i < destination; ++i) {
                const float value = float((i + 0.5) * ratio - 0.5);
                int index = int(std::floor(value));
                if (index < 0) index = -index;
                if (index > int(source) - 1) index = 2 * (int(source) - 1) - index;
                words.push_back(unsigned(index));
            }
            words[position + 1] = words.size();
            for (unsigned i = 0; i < destination; ++i) {
                const float value = float((i + 0.5) * ratio - 0.5);
                int index = int(std::ceil(value));
                if (index < 0) index = -index;
                if (index > int(source) - 1) index = 2 * (int(source) - 1) - index;
                words.push_back(unsigned(index));
            }
            words[position + 2] = words.size();
            for (unsigned i = 0; i < destination; ++i) {
                const float value = float((i + 0.5) * ratio - 0.5);
                append_float(value - int(words[words[position] + i]));
            }
        };
        map(width, scaled_width, 17); map(height, scaled_height, 20);
        word_count = words.size();
        const auto allocate = [&](std::size_t count) {
            const auto offset = unsigned(word_count);
            word_count += count;
            return offset;
        };
        const auto frame_size = std::size_t(stride) * std::max(height, scaled_height);
        frame_a = allocate(frame_size); frame_b = allocate(frame_size);
        temporary = allocate(frame_size); downscaled = allocate(frame_size);
        for (unsigned i = 0; i < matrices.size(); ++i) {
            auto &slot = matrices[i];
            slot = {allocate(625), allocate(25), allocate(25u * blocks),
                allocate(25u * blocks), allocate(3125u + 25u * blocks),
                allocate(26u + blocks), allocate(1)};
            const unsigned offsets[]{slot.covariance, slot.eigenvalues, slot.independent,
                slot.solution, slot.temporary, slot.result, slot.failure};
            std::copy(std::begin(offsets), std::end(offsets), words.begin() + 36u + i * 7u);
        }
        // Mean preparation uses slot zero's eigenvalue scratch only until all
        // four images have been preprocessed. The batched factors then own it.
        words[30] = matrices[0].covariance; words[31] = matrices[0].eigenvalues;
        words[32] = matrices[0].independent; words[33] = matrices[0].solution;
        words[34] = matrices[0].temporary;
        reference_result = matrices[0].result; distorted_result = matrices[1].result;
    }

    struct Statistics {
        std::vector<float> variance;
        std::vector<float> entropy;
        bool failed;
    };
    Statistics statistics(const float *result) const {
        Statistics stats;
        stats.variance.assign(result + 25, result + 25 + blocks);
        stats.entropy.assign(blocks, 0);
        stats.failed = result[25u + blocks] != 0.0f;
        constexpr double pi = 3.14159265358979323846, e = 2.71828182845904523536;
        for (unsigned k = 0; k < 25; ++k) {
            const float eigenvalue = result[k] < 0 ? 0 : result[k];
            for (unsigned i = 0; i < blocks; ++i)
                stats.entropy[i] += std::log2(double(eigenvalue * stats.variance[i] + sigma)) + std::log2(2 * pi * e);
        }
        return stats;
    }
    std::pair<float, bool> channel_score(const float *reference, const float *distorted) const {
        const auto r = statistics(reference), d = statistics(distorted);
        if (r.failed != d.failed) return {0.0f, true};
        constexpr double pi = 3.14159265358979323846, e = 2.71828182845904523536;
        const float base_entropy = float(25 * (std::log2(double((1 + floor) * sigma)) + std::log2(2 * pi * e)));
        float score = 0;
        for (unsigned i = 0; i < blocks; ++i) {
            if (r.entropy[i] < base_entropy && d.entropy[i] < base_entropy) continue;
            float spatial_reference = 0, spatial_distorted = 0;
            if (weight_mode <= 1) {
                spatial_reference = float(r.entropy[i] * std::log2(double(1 + r.variance[i])));
                spatial_distorted = float(d.entropy[i] * std::log2(double(1 + d.variance[i])));
            } else if (weight_mode == 2) {
                spatial_reference = float(r.entropy[i] * std::log2(double(1 + d.variance[i])));
                spatial_distorted = float(d.entropy[i] * std::log2(double(1 + d.variance[i])));
            } else {
                double variance;
                if (weight_mode <= 4) variance = (r.variance[i] + d.variance[i]) / 2.0;
                else if (weight_mode == 5) variance = 0.75 * r.variance[i] + 0.25 * d.variance[i];
                else variance = 0.25 * r.variance[i] + 0.75 * d.variance[i];
                spatial_reference = float(r.entropy[i] * std::log2(weight_mode == 3 ? 1 + variance : double(1 + r.variance[i])));
                spatial_distorted = float(d.entropy[i] * std::log2(1 + variance));
            }
            score += std::abs(spatial_reference - spatial_distorted);
        }
        return {score / float(blocks), r.failed || d.failed};
    }
};
} // namespace bitovp::gpu::vulkan_detail
