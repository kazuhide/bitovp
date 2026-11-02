// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include "bitovp_gpu.hpp"
#include <cuda_runtime.h>

namespace bitovp::gpu {
// Borrows the caller's current CUDA device and stream. Input 4:2:0 pictures
// remain owned by the caller and must be resident on that device. enqueue()
// borrows their storage until collect() returns. extract() waits for its own
// work before returning; no pixels are processed on the CPU.
// The CPU evaluates final logarithms from 25 eigenvalues + N block variances
// per image; their transfer and CPU time are included in timings().
// Bounded pinned-host statistics contain 4*(26+N)*sizeof(float) bytes per
// instance; pixel buffers remain in device memory. One pending frame is allowed.
// Calls must be serialized. The device/context and stream outlive this object.
class CudaParallelSpeed {
public:
    CudaParallelSpeed(const ExtractorSpec &, const FeaturePlan &, cudaStream_t);
    ~CudaParallelSpeed();
    CudaParallelSpeed(const CudaParallelSpeed &) = delete;
    CudaParallelSpeed &operator=(const CudaParallelSpeed &) = delete;
    std::vector<FeatureScore> extract(std::uint64_t, const Picture &reference_device,
                                      const Picture &distorted_device);
    void enqueue(std::uint64_t, const Picture &reference_device, const Picture &distorted_device);
    std::vector<FeatureScore> collect();
    BackendTimings timings() const;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
