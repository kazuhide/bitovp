// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include "bitovp_gpu.hpp"
#include <cuda_runtime.h>

namespace bitovp::gpu {
// Private device-only feature engine. Picture pointers passed to extract() are
// CUDA device pointers owned by CudaBackend, never host pixel-processing inputs.
class CudaScalarFeatures {
public:
    CudaScalarFeatures(const FeaturePlan &plan, cudaStream_t stream);
    ~CudaScalarFeatures();
    CudaScalarFeatures(const CudaScalarFeatures &) = delete;
    CudaScalarFeatures &operator=(const CudaScalarFeatures &) = delete;
    std::vector<FeatureScore> extract(std::uint64_t index, const Picture &reference_device,
                                      const Picture &distorted_device);
    BackendTimings timings() const;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
