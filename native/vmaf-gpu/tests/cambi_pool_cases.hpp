// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include "cambi_score_cases.hpp"
#include <cmath>
#include <functional>

namespace bitovp::gpu::cambi_pool_test {
struct Fixture {
    std::vector<std::uint32_t> words;
    unsigned width, height, retained, pattern;
    unsigned contrasts = 4, window = 1, input_offset = 0, scores, partials, output;
    std::vector<std::array<std::uint32_t, 8>> passes;

    Fixture(unsigned w, unsigned h, unsigned k, unsigned style)
        : width(w), height(h), retained(k), pattern(style) {
        words.resize(64, 0);
        words[28] = unsigned(words.size());
        words.resize(words.size() + 256, 0);
        const auto pixels = std::size_t(width) * height;
        const auto groups = (pixels + 255u) / 256u;
        scores = words[20] = unsigned(words.size());
        words.resize(words.size() + pixels + 19, 0x13579bdfu);
        partials = words[26] = unsigned(words.size());
        words.resize(words.size() + groups * 3u + 19, 0x2468ace0u);
        output = words[25] = unsigned(words.size());
        words.resize(words.size() + 2 + 19, 0x5a5a5a5au);
        for (std::size_t pixel = 0; pixel < pixels; ++pixel) {
            float value = 0;
            if (pattern == 0) value = float((pixel * 131u + pixel / width * 73u) % 100003u) / 256.0f;
            if (pattern == 1) value = pixel % 3u == 0u ? 0.0f : 4.25f;
            if (pattern == 2) value = pixel % 17u == 0u ? 1024.0f : pixel % 7u == 0u ? 0.5f : 0.0f;
            if (pattern == 3) value = std::ldexp(float(1u + pixel % 31u), int(pixel % 65u) - 48);
            if (pattern == 4) value = 1.0f;
            words[scores + pixel] = cambi_score_test::bits(value);
        }
        const auto append = [&](unsigned mode, unsigned extra = 0) {
            passes.push_back({mode, width, height, 0, output, 0, 0, extra});
        };
        append(6, retained);
        if (retained != pixels)
            for (int shift = 24; shift >= 0; shift -= 8) { append(7, unsigned(shift)); append(8, unsigned(shift)); }
        append(9); append(10, retained);
    }

    std::array<unsigned, 2> dispatch_groups(const std::array<std::uint32_t, 8> &pass) const {
        return {pass[0] == 7u || pass[0] == 9u ? (width * height + 255u) / 256u : 1u, 1u};
    }
    void verify(const std::vector<std::uint32_t> &actual) const {
        auto expected = words;
        const auto pixels = std::size_t(width) * height;
        std::vector<std::uint32_t> sorted(words.begin() + scores, words.begin() + scores + pixels);
        std::sort(sorted.begin(), sorted.end(), std::greater<std::uint32_t>());
        const auto threshold = retained == pixels ? 0u : sorted[retained - 1u];
        std::size_t greater = 0;
        for (const auto value : sorted) greater += value > threshold ? 1u : 0u;
        expected[48] = threshold;
        expected[49] = retained == pixels ? 0u : 0xffffffffu;
        expected[50] = retained == pixels ? retained : retained - unsigned(greater);
        const auto groups = (pixels + 255u) / 256u;
        for (std::size_t group = 0; group < groups; ++group) {
            std::array<double, 256> sums{};
            std::array<unsigned, 256> counts{};
            for (unsigned lane = 0; lane < sums.size(); ++lane) {
                const auto pixel = group * sums.size() + lane;
                if (pixel < pixels && words[scores + pixel] > threshold) {
                    sums[lane] = double(cambi_score_test::floating(words[scores + pixel]));
                    counts[lane] = 1;
                }
            }
            // Mode 9 is unchanged: check every partial and integer count,
            // in addition to the independent sorted-prefix pooling oracle.
            for (unsigned step = 128; step; step >>= 1u)
                for (unsigned lane = 0; lane < step; ++lane) {
                    sums[lane] += sums[lane + step]; counts[lane] += counts[lane + step];
                }
            std::memcpy(expected.data() + partials + group * 3u, &sums[0], sizeof(double));
            expected[partials + group * 3u + 2u] = counts[0];
        }
        double wanted = 0;
        for (unsigned index = 0; index < retained; ++index)
            wanted += double(cambi_score_test::floating(sorted[index]));
        wanted /= double(retained);
        if (actual.size() != expected.size()) throw std::runtime_error("CAMBI pooling workspace size changed");
        double result;
        std::memcpy(&result, actual.data() + output, sizeof(result));
        // A parallel double reduction can change addition grouping. This
        // is much stricter than the unchanged feature qualification bar.
        const double tolerance = 1e-12 + std::abs(wanted) * 1e-12;
        if (!std::isfinite(result) || std::abs(result - wanted) > tolerance)
            throw std::runtime_error("CAMBI sorted-prefix pooled score mismatch");
        for (std::size_t word = 0; word < expected.size(); ++word) {
            if (word == output || word == output + 1u) continue;
            if (actual[word] != expected[word])
                throw std::runtime_error("CAMBI exact pooling state mismatch at word " + std::to_string(word) +
                    " for " + std::to_string(width) + "x" + std::to_string(height) +
                    " retained=" + std::to_string(retained) + " pattern=" + std::to_string(pattern));
        }
    }
};

template<class Run> unsigned cases(Run run) {
    unsigned count = 0;
    for (const auto size : {std::array<unsigned, 2>{1, 1}, {17, 19}, {257, 63}, {1025, 513}})
        for (unsigned pattern = 0; pattern < 5; ++pattern) {
            const auto pixels = size[0] * size[1];
            for (unsigned retained : {1u, std::max(1u, pixels / 2u), std::max(1u, pixels - 1u), pixels}) {
                run(Fixture(size[0], size[1], retained, pattern)); ++count;
            }
        }
    return count;
}
} // namespace bitovp::gpu::cambi_pool_test
