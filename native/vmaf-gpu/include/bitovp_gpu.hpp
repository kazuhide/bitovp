// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace bitovp::gpu {

struct Plane {
    const void *data = nullptr;
    std::size_t stride = 0;
    unsigned width = 0;
    unsigned height = 0;
};

// Samples are unsigned bytes at <=8 bits and native-endian uint16_t otherwise.
enum class PictureMemory { Host, CudaDevice };

struct Picture {
    PictureMemory memory = PictureMemory::Host;
    int device_index = -1;
    unsigned bit_depth = 0;
    std::array<Plane, 3> planes{};
};

struct PsnrSums {
    std::array<std::uint64_t, 3> squared_error{};
    std::array<std::uint64_t, 3> sample_count{};
};

struct ExtractorSpec {
    std::string name;
    std::map<std::string, std::string> options;
    // Required collector names, including option-specific canonical suffixes.
    std::vector<std::string> provided_features;
    // Official base feature name -> canonical collector name.
    std::map<std::string, std::string> canonical_names;
};

struct FeaturePlan {
    unsigned width = 0;
    unsigned height = 0;
    unsigned bit_depth = 0;
    std::vector<ExtractorSpec> extractors;
};

struct FeatureScore {
    std::uint64_t index = 0;
    std::string name;
    double value = 0;
};

struct DeviceInfo {
    int index = -1;
    std::string backend;
    std::string name;
    std::string uuid;
    unsigned vendor_id = 0;
    unsigned device_id = 0;
    bool integrated = false;
    std::uint64_t memory_budget = 0;
};

struct BackendOptions {
    bool profile = false;
    int device_index = -1;
    unsigned vendor_id = 0;
    bool prefer_shared_memory = true;
};

struct BackendTimings {
    std::uint64_t device_copied_bytes = 0;
    std::map<std::string, double> extractor_kernel_ms;
    double cpu_postprocess_ms = 0;
    double upload_ms = 0;
    double kernel_ms = 0;
    double download_ms = 0;
    std::uint64_t uploaded_bytes = 0;
    std::uint64_t downloaded_bytes = 0;
    std::uint64_t allocated_bytes = 0;
};

class FeatureBackend {
public:
    virtual ~FeatureBackend() = default;
    virtual DeviceInfo device() const = 0;
    virtual PsnrSums psnr(const Picture &reference, const Picture &distorted) = 0;
    virtual void configure(const FeaturePlan &plan) = 0;
    // Temporal extractors can return scores for earlier input indices.
    virtual std::vector<FeatureScore> extract(std::uint64_t index,
                                              const Picture &reference,
                                              const Picture &distorted) = 0;
    virtual std::vector<FeatureScore> flush() = 0;
    virtual BackendTimings timings() const = 0;
};

std::unique_ptr<FeatureBackend> create_cuda_backend(const BackendOptions &options);
std::unique_ptr<FeatureBackend> create_vulkan_backend(const BackendOptions &options);

} // namespace bitovp::gpu
