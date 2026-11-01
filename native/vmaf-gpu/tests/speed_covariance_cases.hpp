// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace bitovp::gpu::speed_covariance_test {
inline std::uint32_t bits(float value) {
    std::uint32_t result;
    std::memcpy(&result, &value, sizeof(result));
    return result;
}
inline float value(std::uint32_t bits) {
    float result;
    std::memcpy(&result, &bits, sizeof(result));
    return result;
}

// The oracle enumerates the complete lower triangle in nested matrix order.
// It does not reproduce the shader's packed-index prefix search. Per-entry
// source pixels are then accumulated in the unchanged scalar row-major order.
struct Fixture {
    std::array<std::uint32_t, 8> parameters{};
    std::vector<std::uint32_t> words;
    unsigned width, height, stride, slot, means, image;
    unsigned sample_width, sample_height;
    std::array<unsigned, 4> covariance{};

    Fixture(unsigned w, unsigned h, unsigned selected, unsigned pattern)
        : width(w), height(h), stride(w + 7), slot(selected), means(0), image(0),
          sample_width(w / 5 * 5 - 4), sample_height(h / 5 * 5 - 4) {
        words.resize(64, 0);
        words[0] = words[2] = words[6] = width;
        words[1] = words[3] = words[7] = height;
        words[4] = stride;
        for (unsigned i = 0; i < covariance.size(); ++i) {
            covariance[i] = static_cast<unsigned>(words.size());
            words[36 + i * 7] = covariance[i];
            words.resize(words.size() + 625 + 16, 0x5a193c7du);
        }
        means = static_cast<unsigned>(words.size());
        words[31] = means;
        words.resize(words.size() + 25 + 16, 0x3f800001u);
        image = static_cast<unsigned>(words.size());
        words.resize(words.size() + stride * height + 32, 0xc2edcba9u);
        parameters = {8, width, height, image, 0, 0, 0, slot};
        std::uint32_t random = 0x632be59bu;
        for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
            random = random * 1664525u + 1013904223u;
            const int sample = pattern == 0 ? 37 : pattern == 1 ? int(x + 2 * y) - 19 :
                pattern == 2 ? ((x + y) % 2 ? -83 : 79) : int(random % 1025) - 512;
            words[image + y * stride + x] = bits(float(sample) / 4.0f);
        }
        const auto count = sample_width * sample_height;
        for (unsigned row = 0; row < 5; ++row) for (unsigned column = 0; column < 5; ++column) {
            float sum = 0;
            for (unsigned y = 0; y < sample_height; ++y)
                for (unsigned x = 0; x < sample_width; ++x)
                    sum += value(words[image + (row + y) * stride + column + x]);
            words[means + row * 5 + column] = bits(static_cast<float>(double(sum) / double(count)));
        }
    }

    std::vector<std::uint32_t> expected(unsigned groups) const {
        auto result = words;
        unsigned packed = 0;
        const unsigned count = sample_width * sample_height;
        for (unsigned row = 0; row < 25; ++row) for (unsigned column = 0; column <= row; ++column, ++packed) {
            if (packed >= groups * 32) continue;
            const double left_mean = value(words[means + row]);
            const double right_mean = value(words[means + column]);
            double sum = 0;
            for (unsigned y = 0; y < sample_height; ++y) for (unsigned x = 0; x < sample_width; ++x) {
                const double left = value(words[image + (row / 5 + y) * stride + row % 5 + x]);
                const double right = value(words[image + (column / 5 + y) * stride + column % 5 + x]);
                sum += (left - left_mean) * (right - right_mean);
            }
            const auto covariance_bits = bits(static_cast<float>(sum / double(count)));
            result[covariance[slot] + row * 25 + column] = covariance_bits;
            result[covariance[slot] + column * 25 + row] = covariance_bits;
        }
        return result;
    }

    void verify(const std::vector<std::uint32_t> &actual, unsigned groups) const {
        const auto wanted = expected(groups);
        if (actual.size() != wanted.size()) throw std::runtime_error("Covariance workspace length changed");
        for (std::size_t i = 0; i < wanted.size(); ++i) if (actual[i] != wanted[i])
            throw std::runtime_error("Covariance mismatch at word " + std::to_string(i) +
                ", slot " + std::to_string(slot) + ", geometry " + std::to_string(width) + "x" +
                std::to_string(height) + ", groups " + std::to_string(groups));
    }
};

template <typename Runner> unsigned cases(Runner run) {
    unsigned count = 0;
    for (const auto shape : std::array<std::array<unsigned, 2>, 5>{{{5, 5}, {9, 11}, {20, 25}, {31, 26}, {79, 53}}})
        for (unsigned pattern = 0; pattern < 4; ++pattern)
            for (unsigned slot = 0; slot < 4; ++slot) {
                Fixture fixture(shape[0], shape[1], slot, pattern);
                for (unsigned groups : {1u, 10u, 11u, 12u}) {
                    run(fixture, groups);
                    ++count;
                }
            }
    return count;
}
} // namespace bitovp::gpu::speed_covariance_test
