// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include "../src/vulkan/cambi_lut.hpp"
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace bitovp::gpu::cambi_score_test {
inline std::uint32_t bits(float value) {
    std::uint32_t result;
    std::memcpy(&result, &value, sizeof(result));
    return result;
}
inline float floating(std::uint32_t value) {
    float result;
    std::memcpy(&result, &value, sizeof(result));
    return result;
}

struct Fixture {
    std::vector<std::uint32_t> words;
    unsigned width, height, depth, contrasts, window, pattern, gate, mask_style;
    unsigned image, mask, scores, input_offset = 0;
    std::vector<std::array<std::uint32_t, 8>> passes;

    Fixture(unsigned w, unsigned h, unsigned bits_per_sample, unsigned differences,
            unsigned window_size, unsigned style, unsigned visibility, unsigned mask_pattern)
        : width(w), height(h), depth(bits_per_sample), contrasts(differences),
          window(window_size), pattern(style), gate(visibility), mask_style(mask_pattern) {
        words.resize(64, 0);
        words[5] = words[6] = depth;
        words[7] = window; words[8] = contrasts;
        words[9] = gate == 1 ? 2048u : gate == 2 ? 512u : gate == 3 ? 128u : 0u;
        words[21] = unsigned(words.size());
        for (unsigned difference = 0; difference < contrasts; ++difference) {
            const unsigned threshold = gate == 1 ? 2048u : gate == 2 ? 512u :
                gate == 3 ? 128u + difference : (difference % 2u ? 1023u : 64u);
            words.push_back(threshold + contrasts);
        }
        words[22] = unsigned(words.size());
        for (float value : vulkan_detail::cambi_reciprocal_lut) words.push_back(bits(value));
        const auto allocate = [&] {
            const auto offset = unsigned(words.size());
            words.resize(words.size() + std::size_t(width) * height + 19, 0x13579bdfu);
            return offset;
        };
        image = allocate(); mask = allocate(); scores = allocate(); words[20] = scores;
        for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
            unsigned value = 0;
            if (pattern == 0) value = 127u + (x / 3u + y / 5u) % 17u;
            if (pattern == 1) value = (x * 83u + y * 197u + x * y * 13u) & 1023u;
            if (pattern == 2) value = (x + y) % 3u == 0u ? 0u : ((x + y) % 3u == 1u ? 1023u : 512u);
            if (pattern == 3) value = 512u;
            if (pattern == 4) value = 63u + (x + y) % (2u * contrasts + 3u);
            if (pattern == 5) value = 128u + (x + y) % 2u;
            if (pattern == 6) value = 511u - contrasts + (x + y) % 2u;
            // Mode 5 sees the normalized ten-bit image, independently of
            // whether decoding originally supplied eight- or ten-bit samples.
            if (depth == 8) value = value / 4u * 4u;
            const auto pixel = std::size_t(y) * width + x;
            words[image + pixel] = value;
            words[mask + pixel] = mask_style == 0 ? 1u : mask_style == 1 ? 0u :
                mask_style == 2 ? unsigned((x * 17u + y * 29u) % 7u != 0u) :
                unsigned(x == 0 || y == 0 || x + 1u == width || y + 1u == height);
        }
        passes.push_back({5, width, height, image, image, mask, mask, 0});
    }

    std::array<unsigned, 2> dispatch_groups(const std::array<std::uint32_t, 8> &) const {
        return {(width + 15u) / 16u, (height + 15u) / 16u};
    }

    std::vector<std::uint32_t> expected() const {
        auto result = words;
        const unsigned weights[32] = {1,2,3,4,4,5,5,6,6,6,6,7,7,7,7,8,8,8,8,8,8,8,9,9,9,9,9,9,9,9,9,9};
        // Original direct-window algorithm: test every contrast separately
        // for every neighbor. This does not share the optimized signed-bin
        // assignment or its center-only early visibility return.
        for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
            const auto pixel = std::size_t(y) * width + x;
            float score = 0;
            if (words[mask + pixel]) {
                const unsigned raw = words[image + pixel], value = raw + contrasts;
                unsigned p0 = 0;
                std::array<unsigned, 32> positives{}, negatives{};
                const int radius = int(window >> 1u);
                for (int yy = std::max(0, int(y) - radius); yy <= std::min(int(height) - 1, int(y) + radius); ++yy)
                    for (int xx = std::max(0, int(x) - radius); xx <= std::min(int(width) - 1, int(x) + radius); ++xx) {
                        const auto neighbor = std::size_t(yy) * width + unsigned(xx);
                        if (!words[mask + neighbor]) continue;
                        const auto sample = words[image + neighbor];
                        if (sample == raw) ++p0;
                        for (unsigned difference = 0; difference < contrasts; ++difference) {
                            if (sample == raw + difference + 1u) ++positives[difference];
                            if (int(sample) == int(raw) - int(difference) - 1) ++negatives[difference];
                        }
                    }
                for (unsigned difference = 0; difference < contrasts; ++difference)
                    if (value <= words[words[21] + difference] && value + difference + 1u > words[9]) {
                        const unsigned p1 = std::max(positives[difference], negatives[difference]);
                        const float candidate = float(weights[difference] * p0 * p1) *
                            floating(words[words[22] + p1 + p0]);
                        score = std::max(score, candidate);
                    }
            }
            result[scores + pixel] = bits(score);
        }
        return result;
    }
    void verify(const std::vector<std::uint32_t> &actual) const {
        const auto wanted = expected();
        if (actual.size() != wanted.size()) throw std::runtime_error("CAMBI score workspace size changed");
        for (std::size_t word = 0; word < wanted.size(); ++word)
            if (actual[word] != wanted[word])
                throw std::runtime_error("CAMBI bit-exact C-score mismatch at word " + std::to_string(word) +
                    " for " + std::to_string(width) + "x" + std::to_string(height) +
                    " depth=" + std::to_string(depth) + " contrasts=" + std::to_string(contrasts) +
                    " window=" + std::to_string(window) + " pattern=" + std::to_string(pattern) +
                    " gate=" + std::to_string(gate) + " mask=" + std::to_string(mask_style));
    }
};

template<class Run> unsigned cases(Run run) {
    unsigned count = 0;
    for (unsigned contrasts : {1u, 2u, 4u, 8u, 16u, 32u})
        for (unsigned depth : {8u, 10u})
            for (unsigned pattern = 0; pattern < 5; ++pattern) {
                unsigned width = 65, height = 49;
                for (unsigned scale = 0; scale < 5; ++scale) {
                    run(Fixture(width, height, depth, contrasts,
                        scale == 0 ? 17u : scale == 1 ? 65u : scale == 2 ? 3u : 1u,
                        pattern, (pattern + scale) % 4u, (pattern + scale + contrasts) % 4u));
                    ++count;
                    width = (width + 1u) / 2u; height = (height + 1u) / 2u;
                }
                // Very small planes exercise windows larger than the image,
                // negative contrast offsets at zero and saturated ten-bit pixels.
                run(Fixture(1, 1, depth, contrasts, 65, pattern, 1, 0)); ++count;
                run(Fixture(3, 5, depth, contrasts, 17, pattern, 0, 3)); ++count;
            }
    for (unsigned contrasts : {1u, 2u, 4u, 8u, 16u, 32u}) {
        // Nonzero scores on the TVI <= boundary and just across the VLT >
        // boundary ensure that early visibility rejection keeps strictness.
        run(Fixture(17, 19, 10, contrasts, 3, 5, 3, 0)); ++count;
        run(Fixture(17, 19, 10, contrasts, 3, 6, 2, 0)); ++count;
        run(Fixture(17, 19, 10, contrasts, 33, 0, 0, 0)); ++count;
    }
    return count;
}
} // namespace bitovp::gpu::cambi_score_test
