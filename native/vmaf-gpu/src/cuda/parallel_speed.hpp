// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include "bitovp_gpu.hpp"
#include <cuda_runtime.h>

namespace bitovp::gpu {
// Borrows the caller's current CUDA device and stream. Input 4:2:0 pictures
// remain owned by the caller and must be resident on that device. extract()
// waits for its own work before returning; no pixels are processed on the CPU.
// The CPU evaluates final logarithms from 25 eigenvalues + N block variances
// per image; their transfer and CPU time are included in timings().
// Two bounded pinned-host statistics buffers contain 2*(26+N)*sizeof(float)
// bytes per instance; pixel buffers remain in device memory.
// Calls must be serialized. The device/context and stream outlive this object.
class CudaParallelSpeed {
public:
    CudaParallelSpeed(const ExtractorSpec &, const FeaturePlan &, cudaStream_t);
    ~CudaParallelSpeed();
    CudaParallelSpeed(const CudaParallelSpeed &) = delete;
    CudaParallelSpeed &operator=(const CudaParallelSpeed &) = delete;
    std::vector<FeatureScore> extract(std::uint64_t, const Picture &reference_device,
                                      const Picture &distorted_device);
    BackendTimings timings() const;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
