// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once

#include "bitovp_gpu.hpp"

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace bitovp::gpu {

inline constexpr const char *oracle_source_revision =
    "74f930d17de8c58e7c2ce55e2b897b0030ebd8ef";

struct ModelInput {
    std::string id;
    std::string path;
    // Official extractor name -> official option name -> value.
    // For example, cambi -> enc_width/enc_height/enc_bitdepth.
    std::map<std::string, std::map<std::string, std::string>> feature_overrides;
};

struct ModelOracleConfig {
    unsigned width = 0;
    unsigned height = 0;
    unsigned bit_depth = 0;
    unsigned cpu_threads = 1;
    bool include_psnr = true;
};

enum class OracleMode { Cpu, ImportedFeatures };

struct OraclePooledScores {
    double minimum = 0;
    double maximum = 0;
    double mean = 0;
    double harmonic_mean = 0;
};

struct OracleResult {
    std::uint64_t frame_count = 0;
    // Complete required feature series, including delayed temporal outputs.
    std::vector<FeatureScore> features;
    std::map<std::string, std::vector<double>> model_scores;
    std::map<std::string, OraclePooledScores> pooled;
};

// All calls on an instance must be serialized. Models outlive their context.
// submit() copies caller-owned planar samples before returning. CPU and imported
// feature contexts are deliberately separate: importing never re-extracts pixels.
class ModelOracle {
public:
    ModelOracle(std::vector<ModelInput> models, ModelOracleConfig config,
                OracleMode mode);
    ~ModelOracle();
    ModelOracle(const ModelOracle &) = delete;
    ModelOracle &operator=(const ModelOracle &) = delete;
    ModelOracle(ModelOracle &&) noexcept;
    ModelOracle &operator=(ModelOracle &&) noexcept;

    // Effective options include defaults. An unset nullable string option is
    // represented by an empty string; canonical names come from libvmaf itself.
    const FeaturePlan &feature_plan() const;
    void submit(std::uint64_t index, const Picture &reference,
                const Picture &distorted);
    // Delayed outputs may arrive out of order, but duplicates, unknown feature
    // names, non-finite values and indices outside the final interval are errors.
    void import_scores(const std::vector<FeatureScore> &scores);
    // Flushes CPU temporal state, verifies every required feature at every frame,
    // then calls the official predictor and pooling APIs without JSON rounding.
    // An instance is terminal after finish(), or after an upstream input failure.
    OracleResult finish(std::uint64_t expected_frame_count);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

// Round-trippable, locale-independent double text for golden/output values.
std::string oracle_double_to_string(double value);

} // namespace bitovp::gpu
