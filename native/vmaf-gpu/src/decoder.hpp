// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include "bitovp_gpu.hpp"
#include <memory>
#include <string>

namespace bitovp::gpu {
struct VideoInfo {
    unsigned width = 0, height = 0;
    unsigned bit_depth = 0;
    double frames_per_second = 0;
    std::string codec;
};

// Owns a bounded decode buffer and one conformed planar picture. The view from
// next() remains valid until the next call on this decoder or its destruction.
class Decoder {
public:
    Decoder(const std::string &path, unsigned width, unsigned height,
            unsigned bit_depth, unsigned threads, bool cuda = false, int device = 0);
    ~Decoder();
    Decoder(const Decoder &) = delete;
    Decoder &operator=(const Decoder &) = delete;
    VideoInfo source_info() const;
    bool next();
    Picture picture() const;
    // Relative presentation time in seconds. Throws if timestamps are absent.
    double timestamp() const;
    double decode_ms() const;
    double conform_ms() const;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
