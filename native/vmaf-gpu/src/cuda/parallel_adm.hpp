// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include "bitovp_gpu.hpp"
#include <cuda_runtime.h>

namespace bitovp::gpu {
// Resident CUDA luma planes; pixels and integer per-row reductions stay on GPU.
// Only setup coefficients and the three ADM3/ADM2/AIM scalars cross the host.
class CudaParallelAdm {
public:
    CudaParallelAdm(const ExtractorSpec &, const FeaturePlan &, cudaStream_t);
    ~CudaParallelAdm();
    CudaParallelAdm(const CudaParallelAdm &) = delete;
    CudaParallelAdm &operator=(const CudaParallelAdm &) = delete;
    std::vector<FeatureScore> extract(std::uint64_t, const Plane &reference_device,
                                     const Plane &distorted_device);
    BackendTimings timings() const;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
