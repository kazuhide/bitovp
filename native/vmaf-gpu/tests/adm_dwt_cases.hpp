// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include <array>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace bitovp::gpu::adm_dwt_test {
// Independent 64-bit integer oracle. This deliberately retains the original
// four-tap sums and every rounding/narrowing point instead of reproducing the
// shader's modulo-32-bit specialization.
constexpr std::array<std::int64_t, 4> low{15826, 27411, 7345, -4240};
constexpr std::array<std::int64_t, 4> high{-4240, -7345, 27411, -15826};
constexpr std::uint32_t guard = 0xa35cf19du;
inline std::int64_t signed_word(std::uint32_t bits) {
    return bits < 0x80000000u ? std::int64_t(bits) : std::int64_t(bits) - 0x100000000ll;
}
inline std::int32_t narrow(std::int64_t value) {
    const auto bits = std::uint64_t(value) & 65535u;
    return bits < 32768 ? std::int32_t(bits) : std::int32_t(bits) - 65536;
}
inline std::int64_t shift(std::int64_t value, unsigned count) {
    const std::int64_t divisor = std::int64_t(1) << count;
    return value >= 0 ? value / divisor : -((-value + divisor - 1) / divisor);
}
inline unsigned reflect(int value, unsigned size) {
    return unsigned(value < 0 ? -value : value >= int(size) ? 2 * int(size) - value - 1 : value);
}
inline std::uint32_t next(std::uint32_t &seed) {
    seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; return seed;
}
struct Fixture {
    std::vector<std::uint32_t> words, expected;
    std::vector<std::array<std::uint32_t, 8>> passes;
    std::array<unsigned, 2> input_offsets{};
    std::string label;
    void verify(const std::vector<std::uint32_t> &actual) const {
        if (actual.size() != expected.size()) throw std::runtime_error(label + ": workspace size");
        for (std::size_t i = 0; i < actual.size(); ++i)
            if (actual[i] != expected[i])
                throw std::runtime_error(label + ": word " + std::to_string(i) +
                    " expected " + std::to_string(expected[i]) + " got " + std::to_string(actual[i]));
    }
};
inline void byte(std::vector<std::uint32_t> &words, std::size_t offset, unsigned value) {
    auto &word = words[offset / 4];
    const auto shift = unsigned(offset % 4) * 8;
    word = (word & ~(255u << shift)) | ((value & 255u) << shift);
}
inline Fixture make(unsigned width, unsigned height, unsigned depth, unsigned pattern,
                    unsigned selector, bool horizontal_only) {
    Fixture fixture;
    fixture.label = std::to_string(width) + "x" + std::to_string(height) + " depth=" +
        std::to_string(depth) + " pattern=" + std::to_string(pattern) + " selector=" +
        std::to_string(selector) + (horizontal_only ? " horizontal" : " complete");
    const unsigned half_width = (width + 1) / 2, half_height = (height + 1) / 2;
    const unsigned intermediate_size = width * half_height, band_size = half_width * half_height;
    const unsigned sample_bytes = depth == 8 ? 1 : 2;
    const unsigned stride = width * sample_bytes + pattern % 4;
    fixture.words.resize(128, guard);
    fixture.words[2] = depth; fixture.words[3] = fixture.words[4] = stride;
    auto allocate = [&](unsigned size) {
        const auto start = unsigned(fixture.words.size()) + 16;
        fixture.words.resize(start + size + 16, guard); return start;
    };
    fixture.words[52] = allocate(intermediate_size);
    fixture.words[53] = allocate(intermediate_size);
    for (unsigned band = 0; band < 8; ++band) fixture.words[32 + band] = allocate(band_size);
    const unsigned input_size = (stride * height + 3) / 4;
    for (unsigned image = 0; image < 2; ++image) {
        const auto offset = (unsigned(fixture.words.size()) + 1023u) & ~1023u;
        fixture.input_offsets[image] = offset;
        fixture.words.resize(offset + input_size + 16, guard);
    }
    std::vector<std::uint32_t> input(width * height);
    const unsigned maximum = depth == 8 ? 255u : 1023u;
    std::uint32_t seed = 0x419b237du + pattern * 103u + selector * 29u + width * 17u;
    for (unsigned image = 0; image < 2; ++image) {
        for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
            const auto random = next(seed);
            unsigned value = 0;
            switch (pattern % 8) {
            case 0: value = 0; break;
            case 1: value = maximum; break;
            case 2: value = ((x + y) & 1) ? maximum : 0; break;
            case 3: value = (x * 31u + y * 127u) & maximum; break;
            case 4: value = random & maximum; break;
            case 5: value = random & (depth == 8 ? 255u : 65535u); break;
            case 6: value = ((x / 2 + y / 2) & 1) ? maximum : maximum / 2; break;
            default: value = x == 0 || y == 0 || x + 1 == width || y + 1 == height ? maximum : 0;
            }
            if (image != selector) value ^= maximum;
            if (image == selector) input[y * width + x] = value;
            const auto destination = std::size_t(fixture.input_offsets[image]) * 4 + y * stride + x * sample_bytes;
            byte(fixture.words, destination, value);
            if (sample_bytes == 2) byte(fixture.words, destination + 1, value >> 8);
        }
    }
    if (horizontal_only) {
        // Exercise every sign combination at the four horizontal taps, with
        // the full int16 endpoints even when no valid input image produces it.
        for (unsigned y = 0; y < half_height; ++y) for (unsigned x = 0; x < width; ++x) {
            const auto lo = (pattern & (1u << (x % 4))) ? 32767 : -32768;
            const auto hi = (pattern & (1u << ((x + y + 1) % 4))) ? -32768 : 32767;
            fixture.words[fixture.words[52] + y * width + x] = std::uint32_t(lo);
            fixture.words[fixture.words[53] + y * width + x] = std::uint32_t(hi);
        }
    }
    fixture.expected = fixture.words;
    if (!horizontal_only) {
        fixture.passes.push_back({0, 0, width, half_height, width, height, selector, 0});
        const auto rounding = std::int64_t(1) << (depth - 1);
        for (unsigned y = 0; y < half_height; ++y) for (unsigned x = 0; x < width; ++x) {
            std::int64_t lo = 0, hi = 0;
            for (unsigned k = 0; k < 4; ++k) {
                const auto row = reflect(int(2 * y) - 1 + int(k), height);
                const auto value = input[row * width + x];
                lo += low[k] * value; hi += high[k] * value;
            }
            fixture.expected[fixture.words[52] + y * width + x] =
                std::uint32_t(narrow(shift(lo - 46342 * rounding + rounding, depth)));
            fixture.expected[fixture.words[53] + y * width + x] = std::uint32_t(narrow(shift(hi + rounding, depth)));
        }
    }
    fixture.passes.push_back({1, 0, half_width, half_height, width, height, selector, 0});
    for (unsigned y = 0; y < half_height; ++y) for (unsigned x = 0; x < half_width; ++x) {
        std::array<std::int64_t, 4> sums{};
        for (unsigned k = 0; k < 4; ++k) {
            const auto column = reflect(int(2 * x) - 1 + int(k), width);
            const auto lo = signed_word(fixture.expected[fixture.words[52] + y * width + column]);
            const auto hi = signed_word(fixture.expected[fixture.words[53] + y * width + column]);
            sums[0] += low[k] * lo; sums[1] += high[k] * lo;
            sums[2] += low[k] * hi; sums[3] += high[k] * hi;
        }
        for (unsigned band = 0; band < 4; ++band)
            fixture.expected[fixture.words[32 + selector * 4 + band] + y * half_width + x] =
                std::uint32_t(narrow(shift(sums[band] + 32768, 16)));
    }
    return fixture;
}
template <typename Run> unsigned cases(Run run) {
    unsigned count = 0;
    constexpr std::array<std::array<unsigned, 2>, 6> shapes{{{3, 3}, {4, 4}, {5, 7}, {31, 17}, {33, 35}, {66, 65}}};
    for (const auto &shape : shapes) {
        for (unsigned depth : {8u, 10u}) for (unsigned pattern = 0; pattern < 8; ++pattern)
            for (unsigned selector = 0; selector < 2; ++selector) {
                run(make(shape[0], shape[1], depth, pattern, selector, false)); ++count;
            }
        for (unsigned pattern = 0; pattern < 16; ++pattern) {
            run(make(shape[0], shape[1], 10, pattern, pattern % 2, true)); ++count;
        }
    }
    return count;
}
}
