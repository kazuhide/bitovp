// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include "decoder.hpp"
#include <cmath>
#include <cstdint>
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
// Frame `index` of each input, timed from that input's first frame. The
// ordinary method gives each input one frame per slot of the frame rate with
// FFmpeg's `fps` filter, counted from its first frame, before libvmaf compares
// slot N of the two; this scorer compares the frames in their order. The two
// are the same comparison only when frame N of each input lies in slot N: an
// input that leaves a slot out, puts two frames in one or drifts from its
// frame rate has frames repeated or dropped there, and is refused here, with
// a quarter of a slot as the limit where the filter's is half. Only frame
// starts are read: a last frame that lasts several slots, which the filter
// repeats, passes.
inline void validate_comparison_timestamps(std::uint64_t index, double reference, double distorted,
                                           double frames_per_second) {
    const double quarter = 0.25 / frames_per_second;
    if (std::abs(reference - distorted) > quarter)
        throw std::runtime_error("Comparison presentation timestamps do not align");
    const double slot = double(index) / frames_per_second;
    if (std::abs(reference - slot) > quarter || std::abs(distorted - slot) > quarter)
        throw std::runtime_error("Comparison frame times do not follow the frame rate");
}
}
