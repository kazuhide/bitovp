// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include "bitovp_gpu.hpp"
#include <memory>
#include <string>
#include <utility>

namespace bitovp::gpu {
struct VideoInfo {
    unsigned width = 0, height = 0;
    unsigned bit_depth = 0;
    double frames_per_second = 0;
    std::string codec;
};

// A CPU picture whose pixels and presentation timestamp survive the decoder's
// next() call and destruction. Keeping the owner private prevents a dangling
// view after accidentally releasing only its storage handle.
class RetainedPicture {
public:
    const Picture &picture() const noexcept { return picture_; }
    double timestamp() const noexcept { return timestamp_; }
private:
    friend class Decoder;
    RetainedPicture(Picture picture, double time, std::shared_ptr<void> storage)
        : picture_(picture), timestamp_(time), storage_(std::move(storage)) {}
    Picture picture_;
    double timestamp_;
    std::shared_ptr<void> storage_;
};

// Owns a bounded decode buffer and a conformed planar picture. Borrowed views
// remain valid until next() or destruction. CPU snapshot users lazily get a
// second output slot; at most two distinct retained pictures can stay live.
class Decoder {
public:
    // bit_depth=0 preserves supported original precision and validates the
    // standalone CAMBI input scope; existing explicit-depth decoding is unchanged.
    Decoder(const std::string &path, unsigned width, unsigned height,
            unsigned bit_depth, unsigned threads, bool cuda = false, int device = 0);
    ~Decoder();
    Decoder(const Decoder &) = delete;
    Decoder &operator=(const Decoder &) = delete;
    VideoInfo source_info() const;
    bool next();
    Picture picture() const;
    RetainedPicture retain_picture() const;
    // Relative presentation time in seconds. Throws if timestamps are absent.
    double timestamp() const;
    // Actual decoded-frame duration in seconds. No frame-rate estimate is used.
    double duration() const;
    double decode_ms() const;
    double conform_ms() const;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
