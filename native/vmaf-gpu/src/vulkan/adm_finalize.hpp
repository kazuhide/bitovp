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
// Scalar normalization adapted from Netflix/vmaf
// 74f930d17de8c58e7c2ce55e2b897b0030ebd8ef integer_adm.c.
#pragma once
#include "adm_parameters.hpp"

namespace bitovp::gpu::vulkan_detail {
using AdmTotals = std::array<std::array<std::uint64_t, 9>,4>;
struct AdmFinalized {
    // Per scale: numerator, denominator and AIM numerator in binary32.
    std::array<std::array<float,3>,4> scales{};
    std::array<double,3> scores{}; // ADM3, ADM2, AIM.
};
inline float adm_float(const AdmParameters &p, unsigned offset) {
    float value; std::memcpy(&value, &p.words.at(offset), sizeof(value)); return value;
}
inline double adm_double(const AdmParameters &p, unsigned offset) {
    double value; std::memcpy(&value, &p.words.at(offset), sizeof(value)); return value;
}
inline AdmFinalized finalize_adm(const AdmParameters &p, const AdmTotals &totals) {
    AdmFinalized result;
    double numerator = 0, denominator = 0, aim_numerator = 0;
    const float exponent = 1.0f / 3.0f;
    for (unsigned scale = 0; scale < 4; ++scale) {
        const unsigned base = 64 + scale * 16;
        std::array<float,3> den{}, num{}, aim{};
        for (unsigned theta = 0; theta < 3; ++theta) {
            const double factor = adm_float(p, base + (theta == 2 ? 10 : 9));
            const int den_exponent = scale == 0 ? 18 - int(p.words[base + 4]) :
                (scale == 1 ? 32 : scale == 2 ? 27 : 23) - int(p.words[base + 4]) - int(p.words[base + 5]);
            const float csf = static_cast<float>(double(totals[scale][theta]) /
                std::ldexp(1.0, den_exponent) * std::pow(factor, 3.0));
            const float noise = adm_float(p, base + 13);
            den[theta] = ::powf(csf, exponent) + noise;
            const int num_exponent = scale == 0 ? (theta == 2 ? 57 : 52) -
                int(p.words[base + (theta == 2 ? 7 : 6)]) - int(p.words[base + 8]) :
                (scale == 1 ? 45 : scale == 2 ? 39 : 36) - int(p.words[base + 6]) - int(p.words[base + 8]);
            // Scale zero divides in double before narrowing. Other scales
            // first narrow the integer accumulator and divisor to binary32.
            const float nv = scale == 0 ? static_cast<float>(double(totals[scale][3 + theta]) /
                std::ldexp(1.0, num_exponent)) :
                static_cast<float>(totals[scale][3 + theta]) / static_cast<float>(std::ldexp(1.0, num_exponent));
            const float av = scale == 0 ? static_cast<float>(double(totals[scale][6 + theta]) /
                std::ldexp(1.0, num_exponent)) :
                static_cast<float>(totals[scale][6 + theta]) / static_cast<float>(std::ldexp(1.0, num_exponent));
            num[theta] = ::powf(nv, exponent) + noise;
            aim[theta] = ::powf(av, exponent);
        }
        result.scales[scale] = {{(num[0] + num[1]) + num[2], (den[0] + den[1]) + den[2],
                                  (aim[0] + aim[1]) + aim[2]}};
        numerator += result.scales[scale][0];
        denominator += result.scales[scale][1];
        aim_numerator += result.scales[scale][2];
    }
    const double limit = adm_double(p, 22);
    if (numerator < limit) numerator = 0;
    if (denominator < limit) denominator = 0;
    const double score = denominator == 0 ? 1.0 : numerator / denominator;
    const double aim = denominator == 0 ? 0.0 : aim_numerator / denominator;
    const double weight = adm_double(p, 18);
    result.scores = {{std::max(score * weight + (1.0 - aim) * (1.0 - weight), adm_double(p, 20)), score, aim}};
    return result;
}
}
