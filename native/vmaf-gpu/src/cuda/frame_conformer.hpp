// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include "bitovp_gpu.hpp"

namespace bitovp::gpu {
// Converts resident NV12/P010 surfaces to resident planar 4:2:0. Dimensions
// remain unchanged. Input ownership stays with FFmpeg; output lives until the
// next conversion or destruction of this object.
class CudaFrameConformer {
public:
    CudaFrameConformer(unsigned width, unsigned height, unsigned bits, int device);
    ~CudaFrameConformer();
    CudaFrameConformer(const CudaFrameConformer &) = delete;
    CudaFrameConformer &operator=(const CudaFrameConformer &) = delete;
    Picture convert(const void *luma, std::size_t luma_pitch,
                    const void *chroma, std::size_t chroma_pitch,
                    unsigned source_bits, void *producer_stream);
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
