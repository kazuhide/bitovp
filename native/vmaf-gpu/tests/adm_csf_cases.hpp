// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include <array>
#include <cstdint>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <vector>

namespace bitovp::gpu::adm_csf_test {
constexpr std::uint32_t guard = 0x39c715afu;
inline std::int64_t shift(std::int64_t value, unsigned count) {
    const std::int64_t divisor = std::int64_t(1) << count;
    return value >= 0 ? value / divisor : -((-value + divisor - 1) / divisor);
}
inline std::int32_t narrow(std::int64_t value) {
    const auto bits = std::uint64_t(value) & 65535u;
    return bits < 32768 ? std::int32_t(bits) : std::int32_t(bits) - 65536;
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
    std::string label;
    void verify(const std::vector<std::uint32_t> &actual) const {
        if (actual.size() != expected.size()) throw std::runtime_error(label + ": workspace size");
        for (std::size_t i = 0; i < actual.size(); ++i)
            if (actual[i] != expected[i])
                throw std::runtime_error(label + ": word " + std::to_string(i) +
                    " expected " + std::to_string(expected[i]) + " got " + std::to_string(actual[i]));
    }
};
inline Fixture make(unsigned width, unsigned height, unsigned scale, unsigned selector, unsigned pattern) {
    Fixture fixture;
    fixture.label = std::to_string(width) + "x" + std::to_string(height) + " scale=" +
        std::to_string(scale) + " selector=" + std::to_string(selector) + " pattern=" + std::to_string(pattern);
    fixture.words.resize(128, guard);
    const unsigned pixels = width * height;
    auto allocate = [&](unsigned size) {
        const auto start = unsigned(fixture.words.size()) + 16;
        fixture.words.resize(start + size + 16, guard); return start;
    };
    for (unsigned map = 0; map < 20; ++map) fixture.words[32 + map] = allocate(pixels);
    fixture.words[59] = allocate(pixels);
    const unsigned config = 64 + scale * 16;
    const unsigned factor = scale ? (1u << 27) + pattern * 17011u : 32768u + pattern * 1001u;
    fixture.words[config + 11] = factor;
    fixture.words[config + 12] = factor / 2 + 1;
    const int limit = scale ? (1 << 27) : 20000;
    std::uint32_t seed = 0x719c2a1fu + width * 103 + pattern * 17 + scale * 257 + selector;
    std::array<std::vector<std::int64_t>, 6> legacy;
    for (auto &map : legacy) map.resize(pixels);
    for (unsigned pixel = 0; pixel < pixels; ++pixel) for (unsigned theta = 0; theta < 3; ++theta) {
        const auto random = next(seed);
        std::int64_t source = 0;
        switch (pattern) {
        case 0: break;
        case 1: source = (pixel + theta) % 2 ? limit : -limit; break;
        case 2: source = std::int64_t(random % unsigned(limit * 2 + 1)) - limit; break;
        case 3: source = int((pixel * 31 + theta * 127) % 255) - 127; break;
        default: source = pixel % width == 0 || pixel / width == 0 ? limit : -limit / 3;
        }
        const unsigned source_map = (selector == 0 ? 11 : 8) + theta;
        fixture.words[fixture.words[32 + source_map] + pixel] = std::uint32_t(source);
        const auto selected_factor = fixture.words[config + (theta == 2 ? 12 : 11)];
        const auto product = source * selected_factor;
        std::int64_t value, filtered;
        if (!scale) {
            value = narrow(shift(product + (theta == 2 ? 65535 : 16384), theta == 2 ? 17 : 15));
            filtered = narrow(shift(4369 * std::abs(value) + 2048, 12));
        } else {
            value = shift(product + 134217728, 28);
            filtered = shift(143165577 * std::abs(value) - 2147483648ll, 32);
        }
        // Retain all six original maps in the oracle. Only the GPU workspace
        // packs the three center contributions and three filtered values.
        legacy[theta][pixel] = value; legacy[3 + theta][pixel] = filtered;
    }
    fixture.expected = fixture.words;
    for (unsigned pixel = 0; pixel < pixels; ++pixel) {
        std::int64_t center_sum = 0, filtered_sum = 0;
        for (unsigned theta = 0; theta < 3; ++theta) {
            const auto value = legacy[theta][pixel];
            center_sum += !scale ? narrow(shift(8738 * std::abs(value) + 2048, 12)) :
                shift(286331153 * std::abs(value) - 2147483648ll, 32);
            filtered_sum += legacy[3 + theta][pixel];
        }
        fixture.expected[fixture.words[46] + pixel] = std::uint32_t(center_sum);
        fixture.expected[fixture.words[49] + pixel] = std::uint32_t(filtered_sum);
    }
    for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
        std::int64_t threshold = 0;
        for (unsigned theta = 0; theta < 3; ++theta)
            for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
                if (dx == 0 && dy == 0) {
                    const auto value = legacy[theta][y * width + x];
                    threshold += !scale ? narrow(shift(8738 * std::abs(value) + 2048, 12)) :
                        shift(286331153 * std::abs(value) - 2147483648ll, 32);
                } else {
                    const auto xx = reflect(int(x) + dx, width), yy = reflect(int(y) + dy, height);
                    threshold += legacy[3 + theta][yy * width + xx];
                }
            }
        fixture.expected[fixture.words[59] + y * width + x] = std::uint32_t(threshold);
    }
    fixture.passes.push_back({3, scale, width, height, width, height, selector, 0});
    fixture.passes.push_back({7, scale, width, height, width, height, selector, 0});
    return fixture;
}
template <typename Run> unsigned cases(Run run) {
    unsigned count = 0;
    constexpr std::array<std::array<unsigned, 2>, 4> shapes{{{3, 3}, {16, 17}, {33, 35}, {66, 65}}};
    for (const auto &shape : shapes) for (unsigned scale = 0; scale < 4; ++scale)
        for (unsigned selector = 0; selector < 2; ++selector) for (unsigned pattern = 0; pattern < 5; ++pattern) {
            run(make(shape[0], shape[1], scale, selector, pattern)); ++count;
        }
    return count;
}
}
