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
// CUDA ADM3 stages, configuration math and constants adapted from Netflix/vmaf
// 74f930d17de8c58e7c2ce55e2b897b0030ebd8ef:
// integer_adm.c/.h, barten_csf_tools.h and the owned Vulkan stage adaptation.
// Host setup handles only coefficients and workspace/launch layout. Pixel
// transforms and exact integer row reductions execute on the CUDA stream.
#include "parallel_adm.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>

namespace bitovp::gpu::cuda_adm_detail {
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
        throw std::invalid_argument(std::string("invalid CUDA ADM option: ") + name);
    return value;
}

struct AdmParameters {
    ExtractorSpec spec;
    std::vector<std::uint32_t> words;
    std::vector<AdmPass> passes;
    std::uint32_t result_offset = 0;
    std::size_t word_count = 128;

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
            throw std::invalid_argument("CUDA ADM workspace exceeds 32-bit word offsets");
        const auto offset = static_cast<std::uint32_t>(word_count);
        word_count += count;
        return offset;
    }
    void add(unsigned mode, unsigned scale, unsigned width, unsigned height,
             unsigned source_width, unsigned source_height, unsigned selector,
             bool rows = false, bool single = false) {
        AdmPass pass;
        pass.push = {mode, scale, width, height, source_width, source_height, selector, 0};
        pass.groups_x = single ? 1 : ((rows ? height : width) + 15) / 16;
        pass.groups_y = rows || single ? 1 : (height + 15) / 16;
        passes.push_back(pass);
    }

    AdmParameters(const ExtractorSpec &extractor, const FeaturePlan &plan) : spec(extractor) {
        if ((plan.bit_depth != 8 && plan.bit_depth != 10) || plan.width < 64 || plan.height < 64 ||
            plan.width > 7680 || plan.height > 7680)
            throw std::invalid_argument("CUDA ADM requires supported 8/10-bit geometry");
        const std::array<const char *, 13> known = {"debug", "adm_csf_scale", "adm_csf_diag_scale",
            "adm_dlm_weight", "adm_enhn_gain_limit", "adm_norm_view_dist", "adm_norm_view_dist_extra",
            "adm_ref_display_height", "adm_csf_mode", "adm_noise_weight", "adm_skip_aim",
            "adm_skip_scale0", "adm_min_val"};
        for (const auto &entry : spec.options)
            if (std::find(known.begin(), known.end(), entry.first) == known.end())
                throw std::invalid_argument("unknown CUDA ADM option: " + entry.first);
        if (adm_option(spec, "adm_csf_mode", 0) != 2 ||
            adm_option(spec, "adm_norm_view_dist_extra", 0) != 0 ||
            adm_option(spec, "adm_skip_aim", 0) != 0 || adm_option(spec, "adm_skip_scale0", 0) != 0)
            throw std::invalid_argument("CUDA ADM currently qualifies the eight v1 mode-2 plans without skipped stages");
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
        else throw std::invalid_argument("CUDA ADM viewing condition is outside the qualified model set");
        const double gain = adm_option(spec, "adm_enhn_gain_limit", 100);
        const double weight = adm_option(spec, "adm_dlm_weight", 0.5);
        const double minimum = adm_option(spec, "adm_min_val", 0);
        const double noise = adm_option(spec, "adm_noise_weight", 0.03125);
        if (gain < 1 || gain > 100 || weight < 0 || weight > 1 || minimum < 0 || minimum > 1 || noise < 0 || noise > 1500)
            throw std::invalid_argument("CUDA ADM numeric option is outside its official range");
        words.resize(128, 0);
        words[0] = plan.width; words[1] = plan.height; words[2] = plan.bit_depth;
        words[3] = words[4] = plan.width * (plan.bit_depth > 8 ? 2 : 1);
        set_double(16, gain); set_double(18, weight); set_double(20, minimum);
        set_double(22, 1e-10 * (double(plan.width) * plan.height) / (1920.0 * 1080.0));
        const double radians = std::acos(-1.0) / 180.0;
        set_float(24, static_cast<float>(std::cos(radians) * std::cos(radians)));
        const std::size_t map_count = std::size_t((plan.width + 1) / 2) * ((plan.height + 1) / 2);
        const std::size_t temporary_count = std::size_t(plan.width) * ((plan.height + 1) / 2);
        for (unsigned map = 0; map < 20; ++map) words[32 + map] = allocate(map_count);
        words[52] = allocate(temporary_count); words[53] = allocate(temporary_count);
        for (unsigned slot = 54; slot <= 56; ++slot) words[slot] = allocate(((plan.height + 1) / 2) * 3 * 2);
        words[57] = allocate(4 * 3);
        result_offset = words[58] = allocate(6); // ADM3, ADM2, AIM doubles.
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

#include <cstdint>
namespace bitovp::gpu {
namespace {
using uint = unsigned;
using uint64_t = unsigned long long;
using int64_t = long long;
template<class T> __device__ T minimum(T a, T b) { return a < b ? a : b; }
template<class T> __device__ T maximum(T a, T b) { return a > b ? a : b; }
template<class T> __device__ T clamp_value(T a, T lo, T hi) { return minimum(maximum(a, lo), hi); }
struct Parameters { uint mode, scale, width, height, source_width, source_height, selector, unused; };
struct Stage {
    uint *words;
    const unsigned char *reference;
    const unsigned char *distorted;
    Parameters p;
const int low_filter[4] = {15826, 27411, 7345, -4240};
const int high_filter[4] = {-4240, -7345, 27411, -15826};
__device__ uint config(uint field) { return words[64u + p.scale * 16u + field]; }
__device__ uint band(uint map) { return words[32u + map]; }
__device__ int at(uint map, uint x, uint y) { return int(words[band(map) + y * p.width + x]); }
__device__ void put(uint map, uint x, uint y, int value) { words[band(map) + y * p.width + x] = uint(value); }
__device__ int narrow16(int value) { return static_cast<short>(value); }
__device__ int reflected(int value, int size) {
    return value < 0 ? -value : value >= size ? 2 * size - value - 1 : value;
}
__device__ double parameter_double(uint offset) { return __longlong_as_double(static_cast<long long>(load64(offset))); }
__device__ void store_double(uint offset, double value) {
    store64(offset, static_cast<uint64_t>(__double_as_longlong(value)));
}
__device__ uint64_t load64(uint offset) { return uint64_t(words[offset]) | (uint64_t(words[offset + 1u]) << 32); }
__device__ void store64(uint offset, uint64_t value) {
    words[offset] = uint(value); words[offset + 1u] = uint(value >> 32);
}
__device__ uint64_t half_round(uint shift) { return shift == 0u ? uint64_t(0) : uint64_t(1) << (shift - 1u); }
__device__ double power2(int exponent) { return ldexp(1.0, exponent); }
__device__ uint raw_sample(uint image, uint x, uint y) {
    const unsigned char *input = image == 0 ? reference : distorted;
    const auto *row = input + std::size_t(y) * words[image == 0 ? 3 : 4];
    return words[2] == 8 ? row[x] : uint(row[x * 2]) | (uint(row[x * 2 + 1]) << 8);
}

__device__ void vertical(uint x, uint y) {
    int64_t lo = int64_t(0), hi = int64_t(0);
    for (int k = 0; k < 4; ++k) {
        int row = reflected(int(2u * y) - 1 + k, int(p.source_height));
        int value = p.scale == 0u ? int(raw_sample(p.selector, x, uint(row))) :
            int(words[band(p.selector * 4u) + uint(row) * p.source_width + x]);
        lo += int64_t(low_filter[k]) * value;
        hi += int64_t(high_filter[k]) * value;
    }
    int vlo, vhi;
    if (p.scale == 0u) {
        int64_t rounding = int64_t(1) << (words[2] - 1u);
        vlo = narrow16(int((lo - int64_t(46342) * rounding + rounding) >> words[2]));
        vhi = narrow16(int((hi + rounding) >> words[2]));
    } else {
        uint shift = p.scale == 1u ? 0u : 16u;
        int64_t rounding = p.scale == 1u ? int64_t(0) : int64_t(32768);
        vlo = int((lo + rounding) >> shift); vhi = int((hi + rounding) >> shift);
    }
    words[words[52] + y * p.source_width + x] = uint(vlo);
    words[words[53] + y * p.source_width + x] = uint(vhi);
}
__device__ void horizontal(uint x, uint y) {
    int64_t a = int64_t(0), v = int64_t(0), h = int64_t(0), d = int64_t(0);
    for (int k = 0; k < 4; ++k) {
        int column = reflected(int(2u * x) - 1 + k, int(p.source_width));
        int lo = int(words[words[52] + y * p.source_width + uint(column)]);
        int hi = int(words[words[53] + y * p.source_width + uint(column)]);
        a += int64_t(low_filter[k]) * lo; v += int64_t(high_filter[k]) * lo;
        h += int64_t(low_filter[k]) * hi; d += int64_t(high_filter[k]) * hi;
    }
    uint shift = p.scale == 0u || p.scale == 2u ? 16u : 15u;
    int64_t rounding = shift == 16u ? int64_t(32768) : int64_t(16384);
    int values[4] = {int((a + rounding) >> shift), int((v + rounding) >> shift),
        int((h + rounding) >> shift), int((d + rounding) >> shift)};
    for (uint k = 0u; k < 4u; ++k)
        put(p.selector * 4u + k, x, y, p.scale == 0u ? narrow16(values[k]) : values[k]);
}
__device__ int64_t gain_ratio(int reference, int distorted) {
    if (reference == 0) return int64_t(32768);
    uint magnitude = uint(abs(reference));
    uint shift = 0u;
    if (p.scale != 0u && magnitude >= 32768u) {
        shift = uint(31 - __clz(magnitude)) - 14u;
        magnitude = (magnitude + (1u << (shift - 1u))) >> shift;
    }
    int64_t reciprocal = int64_t(1073741824u / magnitude);
    if (reference < 0) reciprocal = -reciprocal;
    int64_t value = (reciprocal * distorted + (int64_t(1) << (14u + shift))) >> (15u + shift);
    return clamp_value(value, int64_t(0), int64_t(32768));
}
__device__ void decouple(uint x, uint y) {
    int reference[3] = {at(2u, x, y), at(1u, x, y), at(3u, x, y)};
    int distorted[3] = {at(6u, x, y), at(5u, x, y), at(7u, x, y)};
    int64_t dot_product = int64_t(reference[0]) * distorted[0] + int64_t(reference[1]) * distorted[1];
    int64_t reference_square = int64_t(reference[0]) * reference[0] + int64_t(reference[1]) * reference[1];
    int64_t distorted_square = int64_t(distorted[0]) * distorted[0] + int64_t(distorted[1]) * distorted[1];
    double dot_scaled = double(float(dot_product)) / 4096.0;
    double reference_scaled = double(float(reference_square)) / 4096.0;
    double distorted_scaled = double(float(distorted_square)) / 4096.0;
    double angle_limit = double(__uint_as_float(words[24])) * reference_scaled * distorted_scaled;
    bool angle = dot_scaled >= 0.0 && dot_scaled * dot_scaled >= angle_limit;
    double enhancement = parameter_double(16u);
    for (uint theta = 0u; theta < 3u; ++theta) {
        int64_t ratio = gain_ratio(reference[theta], distorted[theta]);
        int restored = int((ratio * reference[theta] + int64_t(16384)) >> 15);
        if (p.scale == 0u) restored = narrow16(restored);
        if (angle && ratio != int64_t(0) && reference[theta] > 0)
            restored = int(minimum(double(restored) * enhancement, double(distorted[theta])));
        if (angle && ratio != int64_t(0) && reference[theta] < 0)
            restored = int(maximum(double(restored) * enhancement, double(distorted[theta])));
        if (p.scale == 0u) restored = narrow16(restored);
        int artifact = distorted[theta] - restored;
        put(8u + theta, x, y, restored);
        put(11u + theta, x, y, p.scale == 0u ? narrow16(artifact) : artifact);
    }
}
__device__ void contrast_sensitivity(uint x, uint y) {
    for (uint theta = 0u; theta < 3u; ++theta) {
        int source = at((p.selector == 0u ? 11u : 8u) + theta, x, y);
        uint factor = config(theta == 2u ? 12u : 11u);
        int value, filtered;
        if (p.scale == 0u) {
            int product = int(factor) * source;
            value = narrow16((product + (theta == 2u ? 65535 : 16384)) >> (theta == 2u ? 17 : 15));
            filtered = narrow16((4369 * abs(value) + 2048) >> 12);
        } else {
            value = int((int64_t(factor) * source + int64_t(134217728)) >> 28);
            // Original int32 add_bef_shift_flt stores 1u<<31 as negative.
            filtered = int((int64_t(143165577) * abs(value) - int64_t(2147483648ul)) >> 32);
        }
        put(14u + theta, x, y, value); put(17u + theta, x, y, filtered);
    }
}
__device__ int masking_threshold(uint x, uint y) {
    int sum = 0;
    for (uint theta = 0u; theta < 3u; ++theta)
        for (int dy = -1; dy <= 1; ++dy)
            for (int dx = -1; dx <= 1; ++dx) {
                if (dx == 0 && dy == 0) {
                    int value = at(14u + theta, x, y);
                    sum += p.scale == 0u ? narrow16((8738 * abs(value) + 2048) >> 12) :
                        int((int64_t(286331153) * abs(value) - int64_t(2147483648ul)) >> 32);
                } else {
                    uint xx = uint(reflected(int(x) + dx, int(p.width)));
                    uint yy = uint(reflected(int(y) + dy, int(p.height)));
                    sum += at(17u + theta, xx, yy);
                }
            }
    return sum;
}
__device__ void pool_row(uint row) {
    uint left = config(2u), top = config(3u);
    uint right = p.width - left, bottom = p.height - top;
    uint64_t den[3] = {};
    uint64_t num[3] = {};
    if (row >= top && row < bottom) {
        for (uint x = left; x < right; ++x) {
            int threshold = masking_threshold(x, row);
            for (uint theta = 0u; theta < 3u; ++theta) {
                if (p.selector == 0u) {
                    uint map = theta == 0u ? 2u : theta == 1u ? 1u : 3u;
                    uint64_t value = uint64_t(abs(at(map, x, row)));
                    if (p.scale == 0u) den[theta] += value * value * value;
                    else {
                        uint square_shift = p.scale == 2u ? 30u : 31u;
                        uint64_t square = (value * value + (uint64_t(1) << square_shift)) >> square_shift;
                        den[theta] += (square * value + half_round(config(4u))) >> config(4u);
                    }
                }
                int source = at((p.selector == 0u ? 8u : 11u) + theta, x, row);
                uint factor = config(theta == 2u ? 12u : 11u);
                int value = p.scale == 0u ? source * int(factor) :
                    int((int64_t(source) * int64_t(factor) + int64_t(134217728)) >> 28);
                value = maximum(abs(value) - (p.scale == 0u ? threshold << (theta == 2u ? 12 : 10) : threshold), 0);
                uint square_shift = p.scale == 0u && theta != 2u ? 29u : 30u;
                int square = int((int64_t(value) * value + (int64_t(1) << (square_shift - 1u))) >> square_shift);
                uint cube_shift = config(theta == 2u ? 7u : 6u);
                num[theta] += uint64_t((int64_t(square) * value + int64_t(half_round(cube_shift))) >> cube_shift);
            }
        }
    }
    for (uint theta = 0u; theta < 3u; ++theta) {
        if (p.selector == 0u) {
            uint shift = config(p.scale == 0u ? 4u : 5u);
            store64(words[54] + (row * 3u + theta) * 2u, (den[theta] + half_round(shift)) >> shift);
        }
        store64(words[p.selector == 0u ? 55 : 56] + (row * 3u + theta) * 2u,
                (num[theta] + half_round(config(8u))) >> config(8u));
    }
}
__device__ void reduce_scale() {
    uint64_t den[3] = {};
    uint64_t num[3] = {};
    uint64_t aim[3] = {};
    for (uint y = 0u; y < p.height; ++y) for (uint theta = 0u; theta < 3u; ++theta) {
        uint offset = (y * 3u + theta) * 2u;
        den[theta] += load64(words[54] + offset);
        num[theta] += load64(words[55] + offset);
        aim[theta] += load64(words[56] + offset);
    }
    float d[3], n[3], a[3];
    for (uint theta = 0u; theta < 3u; ++theta) {
        double factor = double(__uint_as_float(config(theta == 2u ? 10u : 9u)));
        double factor_cubed = ::pow(factor, 3.0);
        int den_exponent = p.scale == 0u ? 18 - int(config(4u)) :
            (p.scale == 1u ? 32 : p.scale == 2u ? 27 : 23) - int(config(4u)) - int(config(5u));
        float csf = float(double(den[theta]) / power2(den_exponent) * factor_cubed);
        float noise = __uint_as_float(config(13u));
        d[theta] = ::powf(csf, 1.0f / 3.0f) + noise;
        int num_exponent = p.scale == 0u ? (theta == 2u ? 57 : 52) -
            int(config(theta == 2u ? 7u : 6u)) - int(config(8u)) :
            (p.scale == 1u ? 45 : p.scale == 2u ? 39 : 36) - int(config(6u)) - int(config(8u));
        float nv = p.scale == 0u ? float(double(num[theta]) / power2(num_exponent)) :
            float(num[theta]) / float(power2(num_exponent));
        float av = p.scale == 0u ? float(double(aim[theta]) / power2(num_exponent)) :
            float(aim[theta]) / float(power2(num_exponent));
        n[theta] = ::powf(nv, 1.0f / 3.0f) + noise;
        a[theta] = ::powf(av, 1.0f / 3.0f);
    }
    float ns = (n[0] + n[1]) + n[2];
    float ds = (d[0] + d[1]) + d[2];
    float ascore = (a[0] + a[1]) + a[2];
    uint offset = words[57] + p.scale * 3u;
    words[offset] = __float_as_uint(ns); words[offset + 1u] = __float_as_uint(ds);
    words[offset + 2u] = __float_as_uint(ascore);
}
__device__ void finish_score() {
    double numerator = 0.0, denominator = 0.0, aim_numerator = 0.0;
    for (uint scale = 0u; scale < 4u; ++scale) {
        uint offset = words[57] + scale * 3u;
        numerator += double(__uint_as_float(words[offset]));
        denominator += double(__uint_as_float(words[offset + 1u]));
        aim_numerator += double(__uint_as_float(words[offset + 2u]));
    }
    double limit = parameter_double(22u);
    if (numerator < limit) numerator = 0.0;
    if (denominator < limit) denominator = 0.0;
    double score = denominator == 0.0 ? 1.0 : numerator / denominator;
    double aim = denominator == 0.0 ? 0.0 : aim_numerator / denominator;
    double weight = parameter_double(18u);
    double adm3 = maximum(score * weight + (1.0 - aim) * (1.0 - weight), parameter_double(20u));
    store_double(words[58], adm3); store_double(words[58] + 2u, score); store_double(words[58] + 4u, aim);
}

};
__global__ void adm_stage(Stage stage) {
    const uint x = blockIdx.x * blockDim.x + threadIdx.x;
    const uint y = blockIdx.y * blockDim.y + threadIdx.y;
    const auto &p = stage.p;
    if (p.mode == 6) { if (!x && !y) stage.finish_score(); return; }
    if (p.mode == 5) { if (!x && !y) stage.reduce_scale(); return; }
    if (p.mode == 4) { if (x < p.height && !y) stage.pool_row(x); return; }
    if (x >= p.width || y >= p.height) return;
    if (p.mode == 0) stage.vertical(x, y);
    else if (p.mode == 1) stage.horizontal(x, y);
    else if (p.mode == 2) stage.decouple(x, y);
    else if (p.mode == 3) stage.contrast_sensitivity(x, y);
}
void check(cudaError_t status, const char *operation) {
    if (status != cudaSuccess) throw std::runtime_error(std::string(operation) + ": " + cudaGetErrorString(status));
}
struct Event {
    cudaEvent_t value = nullptr;
    Event() { check(cudaEventCreateWithFlags(&value, cudaEventBlockingSync), "create ADM timing event"); }
    ~Event() { if (value) cudaEventDestroy(value); }
};
double duration(const Event &from, const Event &to) {
    float value = 0; check(cudaEventElapsedTime(&value, from.value, to.value), "measure ADM stage"); return value;
}
} // namespace

struct CudaParallelAdm::Impl {
    cuda_adm_detail::AdmParameters parameters;
    FeaturePlan plan;
    cudaStream_t stream;
    uint *workspace = nullptr;
    int device = -1;
    BackendTimings timing;
    std::map<std::string, unsigned> outputs;
    Impl(const ExtractorSpec &spec, const FeaturePlan &configuration, cudaStream_t cuda_stream)
        : parameters(spec, configuration), plan(configuration), stream(cuda_stream) {
        if (spec.name != "adm") throw std::invalid_argument("parallel ADM requires an ADM extractor");
        const std::pair<const char *, unsigned> supported[] = {{"VMAF_integer_feature_adm3_score", 0},
            {"VMAF_integer_feature_adm2_score", 1}, {"VMAF_integer_feature_aim_score", 2}};
        for (const auto &name : spec.provided_features) {
            bool found = false;
            for (const auto &[base, slot] : supported) {
                const auto canonical = spec.canonical_names.find(base);
                if (canonical != spec.canonical_names.end() && canonical->second == name) {
                    outputs.emplace(name, slot); found = true; break;
                }
            }
            if (!found) throw std::invalid_argument("unsupported required parallel ADM feature: " + name);
        }
        if (outputs.empty()) throw std::invalid_argument("parallel ADM has no required canonical features");
        check(cudaGetDevice(&device), "select parallel ADM device");
        try {
            const auto bytes = parameters.word_count * sizeof(uint);
            check(cudaMalloc(&workspace, bytes), "allocate parallel ADM workspace");
            timing.allocated_bytes = bytes;
            Event from, to;
            check(cudaEventRecord(from.value, stream), "begin ADM setup upload");
            check(cudaMemcpyAsync(workspace, parameters.words.data(), parameters.words.size() * sizeof(uint),
                cudaMemcpyHostToDevice, stream), "upload ADM coefficients and layout");
            check(cudaEventRecord(to.value, stream), "end ADM setup upload");
            check(cudaEventSynchronize(to.value), "complete ADM setup upload");
            timing.uploaded_bytes = parameters.words.size() * sizeof(uint);
            timing.upload_ms = duration(from, to);
        } catch (...) { if (workspace) cudaFree(workspace); throw; }
    }
    ~Impl() { if (workspace) { cudaStreamSynchronize(stream); cudaFree(workspace); } }
    void validate(const Plane &plane) const {
        if (!plane.data || plane.width != plan.width || plane.height != plan.height ||
            plane.stride < std::size_t(plan.width) * (plan.bit_depth == 8 ? 1 : 2) ||
            plane.stride > std::numeric_limits<uint>::max())
            throw std::invalid_argument("parallel ADM requires matching resident planar CUDA inputs");
        cudaPointerAttributes attributes{};
        check(cudaPointerGetAttributes(&attributes, plane.data), "inspect ADM device input");
        if (attributes.type != cudaMemoryTypeDevice || attributes.device != device)
            throw std::invalid_argument("parallel ADM input belongs to a different memory domain/device");
    }
    std::vector<FeatureScore> extract(std::uint64_t index, const Plane &reference, const Plane &distorted) {
        validate(reference); validate(distorted);
        int current = -1; check(cudaGetDevice(&current), "check current ADM CUDA device");
        if (current != device) throw std::invalid_argument("parallel ADM context device changed");
        const uint strides[2] = {static_cast<uint>(reference.stride), static_cast<uint>(distorted.stride)};
        Event from, uploaded, calculated, downloaded;
        check(cudaEventRecord(from.value, stream), "begin ADM input settings upload");
        check(cudaMemcpyAsync(workspace + 3, strides, sizeof(strides), cudaMemcpyHostToDevice, stream), "upload ADM pitches");
        check(cudaEventRecord(uploaded.value, stream), "end ADM settings upload");
        for (const auto &pass : parameters.passes) {
            Parameters p{}; std::memcpy(&p, pass.push.data(), sizeof(p));
            const bool single = p.mode == 5 || p.mode == 6;
            const dim3 block = single ? dim3(1) : dim3(16, 16);
            const dim3 grid = single ? dim3(1) : dim3(pass.groups_x, pass.groups_y);
            adm_stage<<<grid, block, 0, stream>>>({workspace,
                static_cast<const unsigned char *>(reference.data), static_cast<const unsigned char *>(distorted.data), p});
            check(cudaGetLastError(), "launch parallel ADM mathematical stage");
        }
        check(cudaEventRecord(calculated.value, stream), "end ADM pixel processing");
        std::array<double, 3> values{};
        check(cudaMemcpyAsync(values.data(), workspace + parameters.result_offset, sizeof(values), cudaMemcpyDeviceToHost, stream), "read ADM scalar results");
        check(cudaEventRecord(downloaded.value, stream), "end ADM scalar readback");
        check(cudaEventSynchronize(downloaded.value), "complete parallel ADM");
        timing.uploaded_bytes += sizeof(strides); timing.downloaded_bytes += sizeof(values);
        timing.upload_ms += duration(from, uploaded); timing.download_ms += duration(calculated, downloaded);
        const double kernel_ms = duration(uploaded, calculated);
        timing.kernel_ms += kernel_ms; timing.extractor_kernel_ms["adm"] += kernel_ms;
        std::vector<FeatureScore> result;
        for (const auto &[name, slot] : outputs) {
            if (!std::isfinite(values[slot])) throw std::runtime_error("parallel ADM produced a non-finite result");
            result.push_back({index, name, values[slot]});
        }
        return result;
    }
};
CudaParallelAdm::CudaParallelAdm(const ExtractorSpec &spec, const FeaturePlan &plan, cudaStream_t stream)
    : impl_(std::make_unique<Impl>(spec, plan, stream)) {}
CudaParallelAdm::~CudaParallelAdm() = default;
std::vector<FeatureScore> CudaParallelAdm::extract(std::uint64_t index, const Plane &reference, const Plane &distorted) {
    return impl_->extract(index, reference, distorted);
}
BackendTimings CudaParallelAdm::timings() const { return impl_->timing; }
} // namespace bitovp::gpu
