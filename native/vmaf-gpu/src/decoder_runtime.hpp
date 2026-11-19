// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace bitovp::gpu {
using LoaderGeneration = std::pair<std::uint64_t, std::uint64_t>;

struct DecoderRuntime {
    std::string sha256;
    LoaderGeneration generation;
    std::vector<std::string> libraries;
    std::string providers;
};

std::optional<LoaderGeneration> runtime_loader_generation() noexcept;
std::optional<DecoderRuntime> capture_decoder_runtime() noexcept;
bool decoder_runtime_unchanged(const DecoderRuntime &snapshot) noexcept;
bool decoder_runtime_preserved(const DecoderRuntime &before, const DecoderRuntime &after) noexcept;
}
