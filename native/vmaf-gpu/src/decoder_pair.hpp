// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include "decoder.hpp"
#include <cmath>
#include <optional>
#include <stdexcept>

namespace bitovp::gpu {
struct RetainedPair { RetainedPicture reference, distorted; };
inline std::optional<RetainedPair> next_retained_pair(Decoder &reference, Decoder &distorted) {
    const bool has_reference = reference.next(), has_distorted = distorted.next();
    if (has_reference != has_distorted)
        throw std::runtime_error("Comparison inputs have different frame counts");
    if (!has_reference) return std::nullopt;
    return RetainedPair{reference.retain_picture(), distorted.retain_picture()};
}
inline void validate_comparison_timestamps(double reference, double distorted, double frames_per_second) {
    if (std::abs(reference - distorted) > 0.25 / frames_per_second)
        throw std::runtime_error("Comparison presentation timestamps do not align");
}
}
