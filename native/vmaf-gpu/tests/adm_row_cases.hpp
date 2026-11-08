// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include <algorithm>
#include <array>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace bitovp::gpu::adm_row_test {

// Isolate row pooling from the preceding wavelet stages. Alternating signed
// bands have closed-form even/odd populations, so the integer oracle does not
// reproduce the GPU's lane partition or reduction tree.
struct Fixture {
    using Wide = unsigned __int128;
    std::array<std::uint32_t, 8> parameters{};
    std::vector<std::uint32_t> words;
    unsigned width, height, scale, selector;
    bool overflow;

    Fixture(unsigned w, unsigned h, unsigned s, unsigned selected, bool wrap = false)
        : width(w), height(h), scale(s), selector(selected), overflow(wrap) {
        parameters = {4, scale, width, height, width, height, selector, 0};
        words.resize(128, 0);
        words[0] = width; words[1] = height; words[2] = 10;
        for (unsigned band = 0; band < 20; ++band) {
            words[32 + band] = static_cast<std::uint32_t>(words.size());
            words.resize(words.size() + std::size_t(width) * height, 0);
        }
        for (unsigned slot = 54; slot <= 56; ++slot) {
            words[slot] = static_cast<std::uint32_t>(words.size());
            words.resize(words.size() + height * 6, 0xfedcba98u);
        }
        const auto config = 64 + scale * 16;
        words[config + 2] = static_cast<unsigned>(std::max(0.0, width * 0.1 - 0.5));
        words[config + 3] = static_cast<unsigned>(std::max(0.0, height * 0.1 - 0.5));
        words[config + 4] = 3 + scale;
        words[config + 5] = 4 + scale;
        words[config + 6] = 10 + scale;
        words[config + 7] = 11 + scale;
        words[config + 8] = 2 + scale;
        words[config + 11] = words[config + 12] = scale ? 1u << 27 : 1u << 15;
        for (unsigned row = 0; row < height; ++row) for (unsigned x = 0; x < width; ++x) {
            const bool odd = x % 2 != 0;
            const auto denominator = denominator_value(odd);
            const auto numerator = numerator_value(odd);
            for (unsigned band : {1u, 2u, 3u})
                words[words[32 + band] + row * width + x] = static_cast<std::uint32_t>(denominator);
            for (unsigned band = 8; band <= 13; ++band)
                words[words[32 + band] + row * width + x] = static_cast<std::uint32_t>(numerator);
        }
        words.resize(words.size() + 32, 0x13579bdfu);
    }

    std::int64_t denominator_value(bool odd) const {
        const std::int64_t magnitude = overflow ? (odd ? 1073741819 : 1073741821) :
            scale ? (odd ? 33554427 : 33554429) : (odd ? 29999 : 30000);
        return odd ? -magnitude : magnitude;
    }
    std::int64_t numerator_value(bool odd) const {
        const std::int64_t magnitude = scale ? (odd ? 67108819 : 67108823) : (odd ? 14320 : 14321);
        return odd ? -magnitude : magnitude;
    }
    static std::uint64_t half(unsigned shift) { return shift ? std::uint64_t(1) << (shift - 1) : 0; }
    unsigned config(unsigned field) const { return words[64 + scale * 16 + field]; }

    std::uint64_t denominator_term(bool odd) const {
        const auto signed_value = denominator_value(odd);
        const Wide value = signed_value < 0 ? -signed_value : signed_value;
        if (!scale) return static_cast<std::uint64_t>(value * value * value);
        const unsigned shift = scale == 2 ? 30 : 31;
        const Wide square = (value * value + (Wide(1) << shift)) >> shift;
        return static_cast<std::uint64_t>((square * value + half(config(4))) >> config(4));
    }
    std::uint64_t numerator_term(bool odd, unsigned orientation) const {
        // Use wider host arithmetic and explicit floor division for negative
        // rounded products. The selected inputs keep the original signed pixel
        // products in range; only the intentional uint64 sum case wraps.
        __int128 value = numerator_value(odd) * __int128(config(orientation == 2 ? 12 : 11));
        if (scale) {
            value += __int128(1) << 27;
            const __int128 divisor = __int128(1) << 28;
            value = value < 0 ? -((-value + divisor - 1) / divisor) : value / divisor;
        }
        if (value < 0) value = -value;
        // With zero masking bands, each higher-scale center term is
        // (-2^31) >> 32 == -1. Three orientations make the threshold -3;
        // the neighboring zero bands contribute nothing.
        if (scale) value += 3;
        const unsigned square_shift = !scale && orientation != 2 ? 29 : 30;
        const Wide square = (Wide(value) * Wide(value) + half(square_shift)) >> square_shift;
        const unsigned cube_shift = config(orientation == 2 ? 7 : 6);
        return static_cast<std::uint64_t>((square * Wide(value) + half(cube_shift)) >> cube_shift);
    }
    std::uint64_t row_sum(std::uint64_t even, std::uint64_t odd, unsigned shift) const {
        const unsigned left = config(2), right = width - left;
        const unsigned even_count = (right + 1) / 2 - (left + 1) / 2;
        const unsigned odd_count = right - left - even_count;
        const auto sum = static_cast<std::uint64_t>(Wide(even) * even_count + Wide(odd) * odd_count);
        return (sum + half(shift)) >> shift;
    }
    std::vector<std::uint32_t> expected(unsigned dispatched_rows) const {
        if (dispatched_rows > height) throw std::invalid_argument("row test launch exceeds fixture height");
        auto result = words;
        const auto store = [&](unsigned slot, unsigned row, unsigned orientation, std::uint64_t value) {
            const unsigned offset = words[slot] + (row * 3 + orientation) * 2;
            result[offset] = static_cast<std::uint32_t>(value);
            result[offset + 1] = static_cast<std::uint32_t>(value >> 32);
        };
        for (unsigned row = 0; row < dispatched_rows; ++row) {
            const bool cropped = row < config(3) || row >= height - config(3);
            for (unsigned orientation = 0; orientation < 3; ++orientation) {
                if (!selector) store(54, row, orientation, cropped ? 0 :
                    row_sum(denominator_term(false), denominator_term(true), config(scale ? 5 : 4)));
                store(selector ? 56 : 55, row, orientation, cropped ? 0 :
                    row_sum(numerator_term(false, orientation), numerator_term(true, orientation), config(8)));
            }
        }
        return result;
    }
    void verify(const std::vector<std::uint32_t> &actual, unsigned dispatched_rows) const {
        const auto wanted = expected(dispatched_rows);
        if (actual.size() != wanted.size()) throw std::runtime_error("ADM row workspace size changed");
        for (std::size_t i = 0; i < wanted.size(); ++i)
            if (actual[i] != wanted[i])
                throw std::runtime_error("ADM integer row mismatch at word " + std::to_string(i) +
                    " for " + std::to_string(width) + "x" + std::to_string(height) +
                    " scale=" + std::to_string(scale) + " selector=" + std::to_string(selector) +
                    " rows=" + std::to_string(dispatched_rows));
    }
};

template<class Run> unsigned cases(Run run) {
    unsigned count = 0;
    for (const auto size : {std::array<unsigned, 2>{4, 3}, {31, 5}, {33, 5},
                            {257, 19}, {1025, 35}, {1921, 65}})
        for (unsigned scale = 0; scale < 4; ++scale) for (unsigned selector = 0; selector < 2; ++selector) {
            Fixture fixture(size[0], size[1], scale, selector);
            run(fixture, 1); ++count;
            run(fixture, fixture.height); ++count;
        }
    Fixture wrapping(257, 5, 0, 0, true);
    run(wrapping, wrapping.height); ++count;
    return count;
}
} // namespace bitovp::gpu::adm_row_test
