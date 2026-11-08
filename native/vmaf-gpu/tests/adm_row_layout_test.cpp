// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "../src/vulkan/adm_parameters.hpp"
#include <array>
#include <iostream>
#include <stdexcept>

using namespace bitovp::gpu;

int main() {
    try {
        ExtractorSpec spec;
        spec.name = "adm";
        spec.options = {{"adm_csf_mode", "2"}, {"adm_norm_view_dist", "3"},
                        {"adm_ref_display_height", "1080"}};
        for (const auto dimensions : {std::array<unsigned, 2>{64, 64}, {770, 514},
                                      {1026, 770}, {1282, 722}, {1922, 1082}}) {
            for (unsigned depth : {8u, 10u}) {
                FeaturePlan plan{dimensions[0], dimensions[1], depth, {spec}};
                vulkan_detail::AdmParameters parameters(spec, plan);
                unsigned rows = 0;
                for (const auto &pass : parameters.passes) {
                    if (pass.push[0] == 4) {
                        // Each workgroup owns one complete row, including its
                        // single rounding operation after the integer reduction.
                        if (pass.groups_x != pass.push[3] || pass.groups_y != 1)
                            throw std::runtime_error("ADM row launch does not assign one workgroup per row");
                        ++rows;
                    } else if (pass.push[0] >= 5) {
                        if (pass.groups_x != 1 || pass.groups_y != 1)
                            throw std::runtime_error("ADM scalar reduction launch changed");
                    }
                }
                if (rows != 8 || parameters.passes.size() != 41)
                    throw std::runtime_error("ADM scale/selector stage coverage changed");
            }
        }
        std::cout << "PASS ADM row launch coverage for all four scales and both selectors\n";
    } catch (const std::exception &error) {
        std::cerr << "FAIL adm_row_layout: " << error.what() << '\n';
        return 1;
    }
}
