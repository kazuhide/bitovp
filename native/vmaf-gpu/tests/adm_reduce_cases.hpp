// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include <array>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace bitovp::gpu::adm_reduce_test {
constexpr std::uint32_t guard = 0x5c19e3afu;
struct Fixture {
    std::vector<std::uint32_t> words, expected;
    std::array<std::uint32_t, 8> parameters;
    std::string label;
    void verify(const std::vector<std::uint32_t> &actual) const {
        if (actual.size() != expected.size()) throw std::runtime_error(label + ": workspace size");
        for (std::size_t i = 0; i < actual.size(); ++i)
            if (actual[i] != expected[i])
                throw std::runtime_error(label + ": word " + std::to_string(i) +
                    " expected " + std::to_string(expected[i]) + " got " + std::to_string(actual[i]));
    }
};
inline std::uint64_t random64(std::uint64_t &seed) {
    seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; return seed;
}
inline void store64(std::vector<std::uint32_t> &words, unsigned offset, std::uint64_t value) {
    words[offset] = std::uint32_t(value); words[offset + 1] = std::uint32_t(value >> 32);
}
inline Fixture make(unsigned rows, unsigned scale, unsigned pattern) {
    Fixture fixture;
    fixture.label = "rows=" + std::to_string(rows) + " scale=" + std::to_string(scale) +
        " pattern=" + std::to_string(pattern);
    fixture.parameters = {5, scale, 17, rows, 34, rows * 2, 0, 0};
    fixture.words.resize(128, guard);
    auto allocate = [&](unsigned size) {
        const auto start = unsigned(fixture.words.size()) + 16;
        fixture.words.resize(start + size + 16, guard); return start;
    };
    for (unsigned total = 0; total < 3; ++total) fixture.words[54 + total] = allocate(rows * 6);
    fixture.words[59] = allocate(18);
    std::array<std::uint64_t, 9> totals{};
    std::uint64_t seed = 0x31bd49e75c3261afull + rows * 31 + scale * 103 + pattern * 257;
    for (unsigned row = 0; row < rows; ++row) for (unsigned total = 0; total < 3; ++total)
        for (unsigned theta = 0; theta < 3; ++theta) {
            std::uint64_t value = 0;
            switch (pattern) {
            case 0: break;
            case 1: value = (std::uint64_t(1) << (row % 64)) + total * 3 + theta; break;
            case 2: value = ~std::uint64_t(0) - (row * 17 + total * 3 + theta); break;
            default: value = random64(seed);
            }
            store64(fixture.words, fixture.words[54 + total] + (row * 3 + theta) * 2, value);
            // Serial unsigned arithmetic is the independent oracle. Deliberate
            // overflow cases must agree modulo2^64 with any reduction order.
            totals[total * 3 + theta] += value;
        }
    fixture.expected = fixture.words;
    for (unsigned total = 0; total < 9; ++total)
        store64(fixture.expected, fixture.words[59] + total * 2, totals[total]);
    return fixture;
}
template <typename Run> unsigned cases(Run run) {
    unsigned count = 0;
    for (unsigned rows : {0u, 1u, 31u, 32u, 33u, 127u, 540u, 1081u})
        for (unsigned scale = 0; scale < 4; ++scale) for (unsigned pattern = 0; pattern < 4; ++pattern) {
            run(make(rows, scale, pattern)); ++count;
        }
    return count;
}
}
