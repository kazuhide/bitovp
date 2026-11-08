// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include "model_oracle.hpp"
#include <filesystem>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace bitovp::gpu::cli {
inline unsigned integer(const std::string &value, const std::string &key, unsigned maximum) {
    if (value.empty() || value.find_first_not_of("0123456789") != std::string::npos)
        throw std::invalid_argument(key + " requires an unsigned integer");
    std::size_t used = 0;
    const auto result = std::stoull(value, &used);
    if (used != value.size() || result > maximum) throw std::invalid_argument(key + " exceeds its supported limit");
    return unsigned(result);
}
struct Options {
    std::string reference, distorted, output, backend = "cpu", decode = "cpu";
    std::string metric;
    std::vector<ModelInput> models;
    unsigned width = 0, height = 0, bits = 8, threads = 1, decode_threads = 1, max_frames = 0;
    unsigned inflight_frames = 1;
    BackendOptions device;
    bool verify = false, device_info = false;
};
inline Options parse(int argc, char **argv) {
    Options out;
    std::set<std::string> used, model_ids;
    for (int i = 1; i < argc; ++i) {
        const std::string key = argv[i];
        if (key == "--device-info") {
            if (out.device_info) throw std::invalid_argument("Duplicate --device-info");
            out.device_info = true;
            continue;
        }
        if (key == "--profile") {
            if (out.device.profile) throw std::invalid_argument("Duplicate --profile");
            out.device.profile = true;
            continue;
        }
        if (key == "--verify-cpu") {
            if (out.verify) throw std::invalid_argument("Duplicate --verify-cpu");
            out.verify = true;
            continue;
        }
        if (i + 1 >= argc) throw std::invalid_argument("Missing value for " + key);
        const std::string value = argv[++i];
        if (key != "--model" && !used.insert(key).second) throw std::invalid_argument("Duplicate option " + key);
        if (key == "--reference") out.reference = value;
        else if (key == "--metric") out.metric = value;
        else if (key == "--distorted") out.distorted = value;
        else if (key == "--output") out.output = value;
        else if (key == "--backend") out.backend = value;
        else if (key == "--decode") out.decode = value;
        else if (key == "--width") out.width = integer(value, key, 16384);
        else if (key == "--height") out.height = integer(value, key, 16384);
        else if (key == "--bit-depth") out.bits = integer(value, key, 10);
        else if (key == "--threads") out.threads = integer(value, key, 256);
        else if (key == "--decode-threads") out.decode_threads = integer(value, key, 256);
        else if (key == "--max-frames") out.max_frames = integer(value, key, 10000000);
        else if (key == "--inflight-frames") out.inflight_frames = integer(value, key, 4);
        else if (key == "--device") out.device.device_index = int(integer(value, key, 256));
        else if (key == "--vendor") {
            if (value == "amd") out.device.vendor_id = 0x1002;
            else if (value == "nvidia") out.device.vendor_id = 0x10de;
            else throw std::invalid_argument("--vendor must be amd or nvidia");
        } else if (key == "--model") {
            const auto eq = value.find('=');
            if (eq == std::string::npos || eq == 0 || eq + 1 == value.size())
                throw std::invalid_argument("--model requires id=path");
            const auto id = value.substr(0, eq);
            if (!model_ids.insert(id).second) throw std::invalid_argument("Duplicate model id");
            out.models.push_back({id, value.substr(eq + 1), {}});
        } else throw std::invalid_argument("Unknown option " + key);
    }
    if (out.device_info) {
        if (out.backend != "cuda" && out.backend != "vulkan")
            throw std::invalid_argument("--device-info requires --backend cuda or vulkan");
        if (out.backend == "cuda" && out.device.vendor_id && out.device.vendor_id != 0x10de)
            throw std::invalid_argument("CUDA device-info requires an NVIDIA device");
        for (const auto &key : used)
            if (key != "--backend" && key != "--device" && key != "--vendor")
                throw std::invalid_argument("Option is not valid with --device-info: " + key);
        if (out.verify || out.device.profile || !out.models.empty())
            throw std::invalid_argument("Scoring options are not valid with --device-info");
        return out;
    }
    if (used.count("--metric") && out.metric != "cambi")
        throw std::invalid_argument("--metric must be cambi");
    if (out.metric == "cambi") {
        if (out.distorted.empty() || out.output.empty())
            throw std::invalid_argument("Required: --metric cambi --distorted path --output path");
        for (const auto &key : {"--reference", "--model", "--width", "--height", "--bit-depth", "--max-frames"})
            if (used.count(key) || (std::string(key) == "--model" && !out.models.empty()))
                throw std::invalid_argument(std::string("Option is not valid with --metric cambi: ") + key);
        if (out.decode != "cpu" || out.inflight_frames != 1)
            throw std::invalid_argument("CAMBI requires --decode cpu and --inflight-frames 1");
        if (out.backend != "cpu" && !out.verify)
            throw std::invalid_argument("CAMBI GPU scoring requires --verify-cpu");
    } else if (out.reference.empty() || out.distorted.empty() || out.output.empty() || out.models.empty())
        throw std::invalid_argument("Required: --reference path --distorted path --model id=path --output path");
    if (out.backend != "cpu" && out.backend != "cuda" && out.backend != "vulkan")
        throw std::invalid_argument("--backend must be cpu, cuda, or vulkan");
    if (out.decode != "cpu" && out.decode != "cuda") throw std::invalid_argument("--decode must be cpu or cuda");
    if (out.decode == "cuda" && out.backend != "cuda")
        throw std::invalid_argument("Resident CUDA decoding requires CUDA feature extraction");
    if ((out.width == 0) != (out.height == 0)) throw std::invalid_argument("Set width and height together");
    if (out.bits != 8 && out.bits != 10) throw std::invalid_argument("--bit-depth must be 8 or 10");
    if (out.inflight_frames != 1 && out.inflight_frames != 2 && out.inflight_frames != 4)
        throw std::invalid_argument("--inflight-frames must be 1, 2 or 4");
    if (out.backend == "cpu" && out.inflight_frames != 1)
        throw std::invalid_argument("Concurrent frame slots require GPU scoring");
    if (out.backend == "cpu" && (out.verify || out.device.device_index >= 0 || out.device.vendor_id))
        throw std::invalid_argument("GPU options cannot be used with CPU scoring");
    if (std::filesystem::exists(out.output)) throw std::invalid_argument("Output already exists");
    return out;
}
} // namespace bitovp::gpu::cli
