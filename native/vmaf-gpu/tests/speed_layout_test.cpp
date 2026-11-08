// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "../src/vulkan/speed_parameters.hpp"
#include <algorithm>
#include <array>
#include <iostream>
#include <stdexcept>
#include <utility>
#include <vector>

using namespace bitovp::gpu;
namespace {
void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}
void run(unsigned width, unsigned height, unsigned depth, const char *prescale) {
    ExtractorSpec spec;
    spec.name = "speed_chroma";
    spec.options["speed_prescale"] = prescale;
    spec.options["speed_prescale_method"] = "bilinear";
    FeaturePlan plan;
    plan.width = width; plan.height = height; plan.bit_depth = depth;
    const vulkan_detail::SpeedParameters parameters(spec, plan);
    const std::size_t frame_words = std::size_t(parameters.stride) *
        std::max(parameters.height, parameters.scaled_height);
    std::vector<std::pair<std::size_t, std::size_t>> regions;
    for (unsigned offset : {parameters.frame_a, parameters.frame_b,
                            parameters.temporary, parameters.downscaled})
        regions.push_back({offset, frame_words});
    const unsigned count = parameters.blocks;
    const std::array<std::size_t, 7> sizes{625, 25, 25u * count, 25u * count,
        3125u + 25u * count, 26u + count, 1};
    for (unsigned i = 0; i < parameters.matrices.size(); ++i) {
        const auto &slot = parameters.matrices[i];
        const unsigned offsets[]{slot.covariance, slot.eigenvalues, slot.independent,
            slot.solution, slot.temporary, slot.result, slot.failure};
        for (unsigned field = 0; field < sizes.size(); ++field) {
            require(parameters.words[36u + i * 7u + field] == offsets[field],
                "SPEED host and shader slot tables disagree");
            regions.push_back({offsets[field], sizes[field]});
        }
    }
    std::sort(regions.begin(), regions.end());
    std::size_t end = parameters.words.size();
    for (const auto &[offset, size] : regions) {
        require(offset == end, "SPEED workspace regions overlap or have an unaccounted allocation");
        end += size;
        require(end <= parameters.word_count, "SPEED workspace region exceeds its allocation");
    }
    require(end == parameters.word_count, "SPEED workspace size differs from its regions");
    require(parameters.words[31] == parameters.matrices[0].eigenvalues,
        "SPEED mean scratch no longer aliases the pre-factor scratch");
    require(parameters.reference_result == parameters.matrices[0].result &&
        parameters.distorted_result == parameters.matrices[1].result,
        "SPEED compatibility result aliases disagree");
    std::cout << "PASS speed_layout width=" << width << " height=" << height
              << " depth=" << depth << " prescale=" << prescale
              << " blocks=" << count << " workspace_bytes="
              << parameters.word_count * sizeof(std::uint32_t) << '\n';
}
}
int main() {
    try {
        for (unsigned depth : {8u, 10u})
            for (const auto &geometry : {std::array<unsigned, 2>{768, 768},
                                       std::array<unsigned, 2>{1538, 1090},
                                       std::array<unsigned, 2>{1920, 1080}})
                for (const char *prescale : {"0.5", "1", "2"})
                    run(geometry[0], geometry[1], depth, prescale);
    } catch (const std::exception &error) {
        std::cerr << "FAIL speed_layout: " << error.what() << '\n';
        return 1;
    }
}
