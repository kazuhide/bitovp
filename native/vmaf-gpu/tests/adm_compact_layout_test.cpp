// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "../src/vulkan/adm_parameters.hpp"
#include <array>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

using namespace bitovp::gpu;
namespace {
using Parameters = vulkan_detail::AdmParameters;
void require(bool value, const std::string &message) {
    if (!value) throw std::runtime_error(message);
}
bool unused(unsigned map) { return map == 15 || map == 16 || map == 18 || map == 19; }
struct Region { std::size_t offset, count; };
void layout(const Parameters &p, const FeaturePlan &plan, bool compact, const std::string &label) {
    const std::size_t maps = std::size_t((plan.width + 1) / 2) * ((plan.height + 1) / 2);
    const std::size_t temporary = std::size_t(plan.width) * ((plan.height + 1) / 2);
    const std::size_t rows = std::size_t((plan.height + 1) / 2) * 6;
    std::vector<Region> regions;
    std::size_t end = 128;
    const auto region = [&](unsigned slot, std::size_t count) {
        require(p.words[slot] == end, label + ": allocation prefix at " + std::to_string(slot));
        regions.push_back({end, count}); end += count;
    };
    for (unsigned map = 0; map < 20; ++map) {
        if (compact && unused(map))
            require(p.words[32 + map] == Parameters::unused_csf_map_offset,
                    label + ": unused CSF map lacks invalid sentinel");
        else region(32 + map, maps);
    }
    region(52, temporary); region(53, temporary);
    for (unsigned slot = 54; slot < 57; ++slot) region(slot, rows);
    region(57, 12); region(58, 6);
    require(end == p.word_count, label + ": word count includes a hole or tail");
    require(p.result_offset == p.words[58], label + ": result address mismatch");
    std::size_t previous = 128;
    for (const auto &entry : regions) {
        require(entry.count && entry.offset >= previous, label + ": regions overlap");
        require(entry.offset + entry.count <= p.word_count, label + ": region exceeds workspace");
        require(entry.offset + entry.count <= std::numeric_limits<std::uint32_t>::max(),
                label + ": region exceeds shader word offsets");
        previous = entry.offset + entry.count;
    }
    const auto map_bounds = [&](unsigned map, std::size_t count) {
        require(map < 20 && !(compact && unused(map)), label + ": pass accesses unused map");
        require(p.words[32 + map] >= 128 && count <= maps &&
                std::size_t(p.words[32 + map]) + count <= p.word_count,
                label + ": pass map range exceeds workspace");
    };
    const auto slot_bounds = [&](unsigned slot, std::size_t count, std::size_t capacity) {
        require(p.words[slot] >= 128 && count <= capacity &&
                std::size_t(p.words[slot]) + count <= p.word_count,
                label + ": pass scratch/result range exceeds workspace");
    };
    unsigned mode_count[7]{};
    require(p.passes.size() == 41, label + ": scheduled stage count changed");
    for (const auto &pass : p.passes) {
        const auto mode = pass.push[0], scale = pass.push[1], width = pass.push[2], height = pass.push[3];
        const auto source_width = pass.push[4], source_height = pass.push[5], selector = pass.push[6];
        require(mode < 7 && scale < 4 && selector < 2, label + ": invalid pass parameters");
        ++mode_count[mode];
        require(width && height && width <= plan.width && height <= plan.height &&
                source_width <= plan.width && source_height <= plan.height,
                label + ": pass geometry exceeds source");
        const std::size_t pixels = std::size_t(width) * height;
        if (mode == 0) {
            slot_bounds(52, std::size_t(source_width) * height, temporary);
            slot_bounds(53, std::size_t(source_width) * height, temporary);
            if (scale) map_bounds(selector * 4, std::size_t(source_width) * source_height);
        } else if (mode == 1) {
            slot_bounds(52, std::size_t(source_width) * height, temporary);
            slot_bounds(53, std::size_t(source_width) * height, temporary);
            for (unsigned band = 0; band < 4; ++band) map_bounds(selector * 4 + band, pixels);
        } else if (mode == 2) {
            for (unsigned map : {1u, 2u, 3u, 5u, 6u, 7u, 8u, 9u, 10u, 11u, 12u, 13u})
                map_bounds(map, pixels);
        } else if (mode == 3) {
            for (unsigned theta = 0; theta < 3; ++theta) map_bounds((selector ? 8 : 11) + theta, pixels);
            for (unsigned map = 14; map < 20; ++map)
                if (!compact || !unused(map)) map_bounds(map, pixels);
        } else if (mode == 4) {
            for (unsigned map : {1u, 2u, 3u, 8u, 9u, 10u, 11u, 12u, 13u, 14u, 17u})
                map_bounds(map, pixels);
            if (!compact) for (unsigned map : {15u, 16u, 18u, 19u}) map_bounds(map, pixels);
            if (!selector) slot_bounds(54, std::size_t(height) * 6, rows);
            slot_bounds(selector ? 56 : 55, std::size_t(height) * 6, rows);
            require(pass.groups_x == height && pass.groups_y == 1, label + ": row launch changed");
        } else if (mode == 5) {
            for (unsigned slot = 54; slot < 57; ++slot) slot_bounds(slot, std::size_t(height) * 6, rows);
            slot_bounds(57, scale * 3 + 3, 12);
        } else {
            slot_bounds(57, 12, 12); slot_bounds(58, 6, 6);
        }
    }
    require(mode_count[0] == 8 && mode_count[1] == 8 && mode_count[2] == 4 && mode_count[3] == 8 &&
            mode_count[4] == 8 && mode_count[5] == 4 && mode_count[6] == 1,
            label + ": stage coverage changed");
}
void compare(const ExtractorSpec &spec, const FeaturePlan &plan, const std::string &label) {
    const Parameters default_layout(spec, plan), full(spec, plan, false), compact(spec, plan, true);
    require(default_layout.words == full.words && default_layout.word_count == full.word_count &&
            default_layout.result_offset == full.result_offset,
            label + ": default CUDA-compatible prefix changed");
    layout(full, plan, false, label + " full"); layout(compact, plan, true, label + " compact");
    const std::size_t maps = std::size_t((plan.width + 1) / 2) * ((plan.height + 1) / 2);
    require(full.word_count - compact.word_count == 4 * maps, label + ": unexpected saved word count");
    require((full.word_count - compact.word_count) * sizeof(std::uint32_t) == 4 * maps * 4,
            label + ": unexpected saved bytes");
    require(full.result_offset - compact.result_offset == 4 * maps, label + ": result offset not rebased");
    require(full.spec.name == compact.spec.name && full.spec.options == compact.spec.options,
            label + ": extractor metadata changed");
    for (unsigned i = 0; i < full.words.size(); ++i)
        if (i < 32 || i > 58) require(full.words[i] == compact.words[i], label + ": non-offset metadata changed");
    require(full.passes.size() == compact.passes.size() && default_layout.passes.size() == full.passes.size(),
            label + ": default/compact stage count changed");
    for (std::size_t i = 0; i < full.passes.size(); ++i) {
        const auto &a = full.passes[i], &b = compact.passes[i], &c = default_layout.passes[i];
        require(a.push == b.push && a.groups_x == b.groups_x && a.groups_y == b.groups_y &&
                a.push == c.push && a.groups_x == c.groups_x && a.groups_y == c.groups_y,
                label + ": compact/default pass metadata changed");
    }
}
}
int main() {
    try {
        unsigned count = 0;
        std::vector<ExtractorSpec> specs;
        ExtractorSpec defaults; defaults.name = "adm"; defaults.options = {{"adm_csf_mode", "2"}};
        specs.push_back(defaults);
        // Both SDR/HFR families use these four viewing-condition variants.
        for (unsigned family = 0; family < 2; ++family)
            for (const auto &condition : {std::array<const char *, 2>{"1.5", "2160"}, {"3", "1080"},
                                           {"3", "2160"}, {"5", "1080"}}) {
                auto spec = defaults;
                spec.options["adm_norm_view_dist"] = condition[0];
                spec.options["adm_ref_display_height"] = condition[1];
                specs.push_back(spec);
            }
        for (const auto dimensions : {std::array<unsigned, 2>{64, 64}, {65, 67}, {770, 514},
                                      {1026, 770}, {1282, 722}, {1920, 1080}, {1921, 1081},
                                      {3840, 2160}, {7679, 7679}, {7680, 7680}})
            for (unsigned depth : {8u, 10u}) for (const auto &spec : specs) {
                FeaturePlan plan{dimensions[0], dimensions[1], depth, {spec}};
                compare(spec, plan, std::to_string(count)); ++count;
            }
        unsigned rejected = 0;
        for (const auto &geometry : {std::array<unsigned, 3>{63, 64, 8}, {64, 63, 10}, {7681, 64, 8},
                                     {64, 7681, 10}, {64, 64, 12},
                                     {std::numeric_limits<unsigned>::max(), 64, 10}})
            for (bool compact : {false, true}) {
                bool failed = false;
                try {
                    FeaturePlan plan{geometry[0], geometry[1], geometry[2], {defaults}};
                    const Parameters parameters(defaults, plan, compact);
                } catch (const std::invalid_argument &) { failed = true; }
                require(failed, "compact/full layout accepted unsupported geometry"); ++rejected;
            }
        std::cout << "PASS ADM full/default/compact layouts: " << count
                  << " default/eight-model/depth/odd/max-geometry cases; " << rejected
                  << " unsupported-geometry rejections\n";
    } catch (const std::exception &error) {
        std::cerr << "FAIL adm_compact_layout: " << error.what() << '\n';
        return 1;
    }
}
