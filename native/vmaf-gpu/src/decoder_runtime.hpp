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
    struct SharedObject {
        std::string path;
        std::uintptr_t executable_address;
    };
    std::vector<SharedObject> libraries;
    std::string sha256;
    LoaderGeneration generation;
};

std::optional<LoaderGeneration> runtime_loader_generation() noexcept;
std::optional<DecoderRuntime> capture_decoder_runtime() noexcept;
bool decoder_runtime_unchanged(const DecoderRuntime &snapshot) noexcept;
}
