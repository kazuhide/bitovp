// SPDX-License-Identifier: MIT
#pragma once
#include "cli_options.hpp"
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace bitovp::gpu {
std::string banding_capabilities(const std::string &source,
    const std::string &executable, const std::vector<std::string> &backends);
int run_banding(const cli::Options &options,
    const std::function<std::unique_ptr<FeatureBackend>()> &create_backend,
    const std::string &source, const std::string &executable);
}
