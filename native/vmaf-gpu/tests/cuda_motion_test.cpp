// SPDX-License-Identifier: BSD-2-Clause-Patent
// Copyright 2016-2026 Netflix, Inc.
// Copyright (c) 2026 Kazuhide Yamamoto
// Reference scalar equations adapted from Netflix/vmaf at
// 74f930d17de8c58e7c2ce55e2b897b0030ebd8ef:
// libvmaf/src/feature/integer_motion.c and motion_blend_tools.h.
// Licensed under the BSD+Patent License:
// https://opensource.org/licenses/BSDplusPatent
// Distributed on an "AS IS" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
#include "bitovp_gpu.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <map>
#include <stdexcept>
#include <vector>

namespace {
constexpr int filter[] = {3571, 16004, 26386, 16004, 3571};
int mirror(int i, int n) { return i < 0 ? -i : i >= n ? 2 * n - i - 2 : i; }
std::uint64_t cpu_sad(const std::vector<std::uint16_t> &a,
                      const std::vector<std::uint16_t> &b,
                      unsigned w, unsigned h, unsigned bpc) {
    std::vector<std::int32_t> vertical(w * h);
    for (unsigned y = 0; y < h; ++y)
        for (unsigned x = 0; x < w; ++x) {
            std::int64_t sum = 0;
            for (int k = 0; k < 5; ++k) {
                const auto p = mirror(static_cast<int>(y) - 2 + k, h) * w + x;
                sum += static_cast<std::int64_t>(filter[k]) *
                       (static_cast<int>(a[p]) - b[p]);
            }
            vertical[y * w + x] = (sum + (1 << (bpc - 1))) >> bpc;
        }
    std::uint64_t sad = 0;
    for (unsigned y = 0; y < h; ++y)
        for (unsigned x = 0; x < w; ++x) {
            std::int64_t sum = 0;
            for (int k = 0; k < 5; ++k)
                sum += static_cast<std::int64_t>(filter[k]) *
                       vertical[y * w + mirror(static_cast<int>(x) - 2 + k, w)];
            sad += std::abs(static_cast<std::int32_t>((sum + (1 << 15)) >> 16));
        }
    return sad;
}

std::vector<double> cpu_motion(const std::vector<std::vector<std::uint16_t>> &frames,
                              unsigned bpc, bool hfr) {
    const unsigned stride = hfr ? 2 : 1;
    std::vector<double> sad(frames.size());
    for (unsigned i = stride; i < frames.size(); ++i)
        sad[i] = std::min(cpu_sad(frames[i - stride], frames[i], 17, 13, bpc) /
                         256.0 / (17 * 13) * 1.7, 18.0);
    auto blend = [](double v) { return v * 0.35 + 0.65 * std::min(4.0, v); };
    const double stamp = frames.size() > stride ? std::min(blend(sad[stride]), 18.0) : 0;
    std::vector<double> result(frames.size());
    double previous = 0;
    for (unsigned i = 0; i < frames.size(); ++i) {
        if (i < stride) result[i] = previous = stamp;
        else {
            double motion2;
            if (i + 1 >= frames.size()) motion2 = sad[i];
            else if (i - (stride - 1) >= stride)
                motion2 = std::min(sad[i - (stride - 1)], sad[i + 1]);
            else motion2 = sad[i + 1];
            const double processed = std::min(blend(motion2), 18.0);
            result[i] = hfr ? (processed + previous) / 2 : processed;
            previous = processed;
        }
    }
    return result;
}
}

int main() {
    try {
        auto backend = bitovp::gpu::create_cuda_backend({});
        for (unsigned bpc : {8u, 10u}) for (bool hfr : {false, true})
            for (unsigned count : {1u, 2u, 5u, 6u}) {
                bitovp::gpu::ExtractorSpec spec;
                spec.name = "motion";
                spec.options = {{"motion_max_val", "18"}, {"motion_fps_weight", "1.7"},
                    {"motion_blend_factor", "0.35"}, {"motion_blend_offset", "4"},
                    {"motion_five_frame_window", hfr ? "true" : "false"},
                    {"motion_moving_average", hfr ? "true" : "false"}};
                spec.provided_features = {"motion3_for_test"};
                spec.canonical_names = {{"VMAF_integer_feature_motion3_score", "motion3_for_test"}};
                backend->configure({17, 13, bpc, {spec}});
                std::vector<std::vector<std::uint16_t>> frames(count);
                std::map<std::uint64_t, double> output;
                auto consume = [&](const std::vector<bitovp::gpu::FeatureScore> &scores) {
                    for (const auto &score : scores) {
                        if (score.name != "motion3_for_test" ||
                            !output.emplace(score.index, score.value).second)
                            throw std::runtime_error("Unexpected or duplicate temporal score");
                    }
                };
                for (unsigned i = 0; i < count; ++i) {
                    frames[i].resize(17 * 13);
                    std::vector<std::uint8_t> padded((17 + 7) * 13 * (bpc > 8 ? 2 : 1));
                    for (unsigned y = 0; y < 13; ++y) for (unsigned x = 0; x < 17; ++x) {
                        const auto value = static_cast<std::uint16_t>(
                            ((x * 29 + y * 13 + i * i * 37) & 255) << (bpc - 8));
                        frames[i][y * 17 + x] = value;
                        if (bpc == 8) padded[y * 24 + x] = value;
                        else reinterpret_cast<std::uint16_t *>(padded.data())[y * 24 + x] = value;
                    }
                    bitovp::gpu::Picture picture;
                    picture.bit_depth = bpc;
                    picture.planes[0] = {padded.data(), 24u * (bpc > 8 ? 2u : 1u), 17, 13};
                    consume(backend->extract(i, picture, picture));
                }
                consume(backend->flush());
                const auto expected = cpu_motion(frames, bpc, hfr);
                if (output.size() != count) throw std::runtime_error("Missing temporal endpoint");
                for (unsigned i = 0; i < count; ++i)
                    if (!std::isfinite(output.at(i)) || std::abs(output.at(i) - expected[i]) >
                        1e-6 + 1e-7 * std::abs(expected[i]))
                        throw std::runtime_error("Motion3 differs from the fixed CPU scalar equations");
                if (!backend->flush().empty()) throw std::runtime_error("Flush duplicated scores");
            }
        const auto timing = backend->timings();
        std::cout << "PASS cuda_motion ordinary/HFR 8/10-bit 1/2/5/6 frames "
                  << "kernel_ms=" << timing.kernel_ms << " uploaded_bytes="
                  << timing.uploaded_bytes << " downloaded_bytes=" << timing.downloaded_bytes << '\n';
    } catch (const std::exception &error) {
        std::cerr << "FAIL cuda_motion: " << error.what() << '\n';
        return 1;
    }
}
