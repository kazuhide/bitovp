// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include "bitovp_gpu.hpp"
#include <cuda_runtime.h>

namespace bitovp::gpu {
// Inputs are already-resident planar CUDA samples on the supplied stream.
// Only scalar settings and five pooled scale scores cross the host boundary.
class CudaParallelCambi {
public:
    CudaParallelCambi(const ExtractorSpec &, const FeaturePlan &, cudaStream_t, bool profile = false);
    ~CudaParallelCambi();
    CudaParallelCambi(const CudaParallelCambi &) = delete;
    CudaParallelCambi &operator=(const CudaParallelCambi &) = delete;
    FeatureScore extract(std::uint64_t, const Plane &distorted_device);
    BackendTimings timings() const;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
