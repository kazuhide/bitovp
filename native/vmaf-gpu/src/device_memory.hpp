// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include <cstdint>
#include <optional>

namespace bitovp::gpu {
// VK_EXT_memory_budget is process allocation headroom, not a reservation or
// the physical heap size. Over-budget use has zero headroom; absent or invalid
// budget data stays unknown.
inline std::optional<std::uint64_t> vulkan_available_bytes(std::uint64_t total,
                                                         std::uint64_t budget,
                                                         std::uint64_t used) {
    if (!total || !budget || budget > total) return std::nullopt;
    return used >= budget ? 0 : budget - used;
}
} // namespace bitovp::gpu
