// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include <algorithm>
#include <array>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace bitovp::gpu::cambi_mask_test {
// The expected final mask uses the original two-dimensional neighborhood,
// independent of the production horizontal/vertical decomposition. Every
// workspace word is checked to catch accidental aliasing and out-of-bounds writes.
struct Fixture {
    std::vector<std::uint32_t> words;
    unsigned width, height, depth, threshold, pattern;
    unsigned image_a, image_b, mask_a, mask_b, input_offset, stride;
    std::vector<unsigned> samples;
    std::vector<std::array<std::uint32_t, 8>> passes;

    Fixture(unsigned w, unsigned h, unsigned bits, unsigned gate, unsigned style)
        : width(w), height(h), depth(bits), threshold(gate), pattern(style) {
        words.resize(64 + width + height, 0);
        words[0] = width; words[1] = height; words[2] = width; words[3] = height;
        stride = width * (depth == 8 ? 1u : 2u) + (depth == 8 ? 3u : 6u);
        words[4] = stride; words[5] = words[6] = depth; words[10] = threshold;
        words[23] = 64; words[24] = 64 + width;
        for (unsigned x = 0; x < width; ++x) words[64 + x] = x;
        for (unsigned y = 0; y < height; ++y) words[64 + width + y] = y;
        const auto allocate = [&] {
            const auto offset = unsigned(words.size());
            words.resize(words.size() + std::size_t(width) * height + 17, 0x13579bdfu);
            return offset;
        };
        image_a = allocate(); image_b = allocate(); mask_a = allocate(); mask_b = allocate();
        // A separate descriptor view of the same allocation supplies source
        // pixels; 16-KiB alignment covers the Vulkan storage-buffer alignment.
        input_offset = unsigned((words.size() + 4095u) / 4096u * 4096u);
        words.resize(input_offset + (std::size_t(stride) * height + 3u) / 4u + 17, 0x2468ace0u);
        const auto write_byte = [&](std::size_t offset, unsigned value) {
            auto &word = words[input_offset + offset / 4u];
            const unsigned shift = unsigned(offset % 4u) * 8u;
            word = (word & ~(255u << shift)) | ((value & 255u) << shift);
        };
        const unsigned maximum = (1u << depth) - 1u;
        samples.resize(std::size_t(width) * height);
        for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
            unsigned value = 0;
            if (pattern == 0) value = maximum / 2u;
            if (pattern == 1) value = (x * 83u + y * 197u + x * y * 13u) & maximum;
            if (pattern == 2) value = ((y / 5u) * 9u) & maximum;
            if (pattern == 3) value = ((x / 4u) * 13u) & maximum;
            if (pattern == 4) value = x < width / 2u && y < height / 2u ? 0u : maximum;
            samples[std::size_t(y) * width + x] = value;
            const std::size_t position = std::size_t(y) * stride + x * (depth == 8 ? 1u : 2u);
            write_byte(position, value);
            if (depth == 10) write_byte(position + 1u, value >> 8u);
        }
        passes.push_back({0, width, height, image_a, image_a, mask_a, mask_b, 0});
        unsigned image = image_a;
        if (depth == 8) {
            passes.push_back({1, width, height, image_a, image_b, mask_a, mask_b, 0});
            image = image_b;
        }
        passes.push_back({11, width, height, image, image, mask_a, mask_b, 0});
        passes.push_back({2, width, height, image, image, mask_b, mask_a, 0});
    }

    std::vector<std::uint32_t> expected() const {
        auto result = words;
        std::vector<unsigned> normalized(samples.size()), filtered(samples.size());
        for (std::size_t i = 0; i < samples.size(); ++i) {
            normalized[i] = depth == 8 ? samples[i] * 4u : samples[i];
            result[image_a + i] = normalized[i];
        }
        for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
            const std::size_t pixel = std::size_t(y) * width + x;
            if (depth == 10) { filtered[pixel] = normalized[pixel]; continue; }
            // Average the available 2x2 source box with floor division. This
            // expresses the official edge rule without copying GPU branches.
            unsigned sum = 0, count = 0;
            for (unsigned yy = y; yy < std::min(y + 2u, height); ++yy)
                for (unsigned xx = x; xx < std::min(x + 2u, width); ++xx) {
                    sum += normalized[std::size_t(yy) * width + xx]; ++count;
                }
            filtered[pixel] = sum / count;
            result[image_b + pixel] = filtered[pixel];
        }
        std::vector<bool> flat(samples.size());
        for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
            const auto center = filtered[std::size_t(y) * width + x];
            flat[std::size_t(y) * width + x] =
                (x == width - 1u || center == filtered[std::size_t(y) * width + x + 1u]) &&
                (y == height - 1u || center == filtered[std::size_t(y + 1u) * width + x]);
        }
        for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
            const unsigned left = x > 3u ? x - 3u : 0u;
            const unsigned top = y > 3u ? y - 3u : 0u;
            unsigned count = 0, horizontal = 0;
            for (unsigned yy = top; yy < std::min(y + 4u, height); ++yy)
                for (unsigned xx = left; xx < std::min(x + 4u, width); ++xx)
                    count += flat[std::size_t(yy) * width + xx] ? 1u : 0u;
            for (unsigned xx = left; xx < std::min(x + 4u, width); ++xx)
                horizontal += flat[std::size_t(y) * width + xx] ? 1u : 0u;
            const auto pixel = std::size_t(y) * width + x;
            result[mask_a + pixel] = count > threshold ? 1u : 0u;
            result[mask_b + pixel] = horizontal;
        }
        return result;
    }
    void verify(const std::vector<std::uint32_t> &actual) const {
        const auto wanted = expected();
        if (actual.size() != wanted.size()) throw std::runtime_error("CAMBI mask workspace size changed");
        for (std::size_t i = 0; i < wanted.size(); ++i)
            if (actual[i] != wanted[i])
                throw std::runtime_error("CAMBI integer mask mismatch at word " + std::to_string(i) +
                    " for " + std::to_string(width) + "x" + std::to_string(height) +
                    " depth=" + std::to_string(depth) + " threshold=" + std::to_string(threshold) +
                    " pattern=" + std::to_string(pattern));
    }
};

template<class Run> unsigned cases(Run run) {
    unsigned count = 0;
    for (const auto size : {std::array<unsigned, 2>{1, 1}, {2, 3}, {5, 7},
                            {17, 19}, {33, 35}, {65, 49}, {257, 63}})
        for (unsigned depth : {8u, 10u}) for (unsigned pattern = 0; pattern < 5; ++pattern)
            for (unsigned threshold : {0u, 6u, 24u, 48u, 49u}) {
                run(Fixture(size[0], size[1], depth, threshold, pattern)); ++count;
            }
    return count;
}
} // namespace bitovp::gpu::cambi_mask_test
