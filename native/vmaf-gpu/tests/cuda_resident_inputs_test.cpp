// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "bitovp_gpu.hpp"
#include "model_oracle.hpp"
#include "frame_pipeline.hpp"
#include <cuda_runtime.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <map>
#include <stdexcept>
#include <vector>

using namespace bitovp::gpu;
namespace {
void check(cudaError_t code) {
    if (code != cudaSuccess) throw std::runtime_error(cudaGetErrorString(code));
}
void require(bool condition, const std::string &message) {
    if (!condition) throw std::runtime_error(message);
}
struct Fixture {
    Picture reference, distorted;
    std::array<std::vector<std::uint16_t>, 3> a, b;
    Fixture(unsigned bits, unsigned frame) {
        reference.bit_depth = distorted.bit_depth = bits;
        for (unsigned p = 0; p < 3; ++p) {
            const unsigned w = p ? 384 : 768, h = p ? 384 : 768;
            const unsigned stride_a = w + 17, stride_b = w + 31;
            const unsigned bytes = bits == 8 ? 1 : 2;
            a[p].assign(stride_a * h, 0xa5a5); b[p].assign(stride_b * h, 0x5a5a);
            for (unsigned y = 0; y < h; ++y) for (unsigned x = 0; x < w; ++x) {
                const unsigned av = (x * 13 + y * 7 + (x * y % 53) + frame * frame * 3 + p * 31) % 215 + 16;
                const unsigned bv = std::clamp<int>(int(av) + int((x + y * 3 + p + frame) % 9) - 4, 0, 255);
                const std::uint16_t aa = bits == 8 ? av : (av << 2) + (x + frame) % 4;
                const std::uint16_t bb = bits == 8 ? bv : (bv << 2) + (y + p) % 4;
                std::memcpy(reinterpret_cast<unsigned char *>(a[p].data()) + (y * stride_a + x) * bytes, &aa, bytes);
                std::memcpy(reinterpret_cast<unsigned char *>(b[p].data()) + (y * stride_b + x) * bytes, &bb, bytes);
            }
            reference.planes[p] = {a[p].data(), stride_a * bytes, w, h};
            distorted.planes[p] = {b[p].data(), stride_b * bytes, w, h};
        }
    }
};
struct Resident {
    Picture picture;
    std::array<void *, 3> memory{};
    explicit Resident(const Picture &host) : picture(host) {
        picture.memory = PictureMemory::CudaDevice; picture.device_index = 0;
        try {
            for (unsigned p = 0; p < 3; ++p) {
                const auto &plane = host.planes[p];
                // The distinct padding values must not enter any feature.
                const std::size_t pitch = plane.stride + (p + 3) * (host.bit_depth == 8 ? 1 : 2);
                check(cudaMalloc(&memory[p], pitch * plane.height));
                check(cudaMemset(memory[p], 0x7e, pitch * plane.height));
                check(cudaMemcpy2D(memory[p], pitch, plane.data, plane.stride,
                    plane.width * (host.bit_depth == 8 ? 1 : 2), plane.height, cudaMemcpyHostToDevice));
                picture.planes[p] = {memory[p], pitch, plane.width, plane.height};
            }
        } catch (...) { for (auto value : memory) cudaFree(value); throw; }
    }
    ~Resident() { for (auto value : memory) cudaFree(value); }
    Resident(const Resident &) = delete;
    Resident &operator=(const Resident &) = delete;
};
void compare(const OracleResult &expected, const OracleResult &actual) {
    std::map<std::pair<std::uint64_t, std::string>, double> values;
    for (const auto &score : actual.features)
        require(values.emplace(std::make_pair(score.index, score.name), score.value).second,
                "Duplicate resident feature");
    require(values.size() == expected.features.size(), "Missing resident features");
    for (const auto &score : expected.features) {
        const auto got = values.at({score.index, score.name});
        require(std::isfinite(got) && std::abs(got - score.value) <= 1e-6 + 1e-7 * std::abs(score.value),
                "Resident feature exceeds abs1e-6+rel1e-7: " + score.name);
    }
    for (const auto &[name, frames] : expected.model_scores) {
        const auto &got = actual.model_scores.at(name);
        require(got.size() == frames.size(), "Missing resident model frame");
        for (std::size_t i = 0; i < frames.size(); ++i)
            require(std::isfinite(got[i]) && std::abs(got[i] - frames[i]) <= 1e-4,
                    "Resident model score exceeds abs1e-4");
        const auto &a = expected.pooled.at(name), &b = actual.pooled.at(name);
        require(std::abs(a.mean - b.mean) <= 1e-4 && std::abs(a.minimum - b.minimum) <= 1e-4 &&
                std::abs(a.maximum - b.maximum) <= 1e-4 && std::abs(a.harmonic_mean - b.harmonic_mean) <= 1e-4,
                "Resident model pooling exceeds abs1e-4");
    }
}
}
int main(int argc, char **argv) {
    try {
        if (argc != 2) throw std::invalid_argument("Usage: cuda_resident_inputs_test <model-dir>");
        std::vector<ModelInput> models;
        for (bool hfr : {false, true}) for (const auto *variant : {"1d5h_2160", "3d0h", "3d0h_2160", "5d0h"}) {
            const std::string family = hfr ? "vmaf_v1.0.16_hfr" : "vmaf_v1.0.16";
            const std::string name = family + "_" + variant;
            models.push_back({name, std::string(argv[1]) + "/" + family + "/" + name + ".json", {}});
        }
        constexpr unsigned frame_count = 6;
        for (unsigned bits : {8u, 10u}) {
            ModelOracleConfig config{768, 768, bits, 1, true};
            ModelOracle cpu(models, config, OracleMode::Cpu);
            for (unsigned i = 0; i < frame_count; ++i) {
                Fixture input(bits, i); cpu.submit(i, input.reference, input.distorted);
            }
            const auto expected = cpu.finish(frame_count);
            for (unsigned residency = 0; residency < 4; ++residency) for (unsigned depth : {1u, 2u, 4u}) {
                const auto factory = [] { return create_cuda_backend({}); };
                std::unique_ptr<FeatureBackend> backend;
                if (depth == 1) backend = factory();
                else backend = std::make_unique<FramePipeline>(factory, depth, stage_cuda_picture);
                backend->configure(cpu.feature_plan());
                ModelOracle imported(models, config, OracleMode::ImportedFeatures);
                for (unsigned i = 0; i < frame_count; ++i) {
                    Fixture input(bits, i);
                    Resident resident_a(input.reference), resident_b(input.distorted);
                    const auto &a = residency & 1 ? resident_a.picture : input.reference;
                    const auto &b = residency & 2 ? resident_b.picture : input.distorted;
                    if (depth == 1) {
                        auto exact = create_cuda_backend({});
                        const auto host_sums = exact->psnr(input.reference, input.distorted);
                        const auto sums = exact->psnr(a, b);
                        require(sums.squared_error == host_sums.squared_error && sums.sample_count == host_sums.sample_count,
                                "Resident PSNR includes padded bytes or loses integer precision");
                        require(exact->timings().device_copied_bytes == 0,
                                "Direct PSNR copied resident inputs");
                    }
                    imported.import_scores(backend->extract(i, a, b));
                    // Both resident allocations are destroyed before the next frame;
                    // delayed temporal output must use the backend's own history.
                }
                imported.import_scores(backend->flush());
                require(backend->flush().empty(), "Repeated flush emitted resident scores");
                compare(expected, imported.finish(frame_count));
                const auto timing = backend->timings();
                const std::uint64_t luma_bytes = std::uint64_t(768) * 768 * (bits == 8 ? 1 : 2);
                const unsigned resident_inputs = unsigned(bool(residency & 1)) + unsigned(bool(residency & 2));
                // Concurrent slots own a copy of each device input. Extractors
                // borrow that slot copy; only ordered motion retains history.
                const std::uint64_t staged_bytes = depth == 1 ? 0 :
                    (luma_bytes + luma_bytes / 2) * resident_inputs * frame_count;
                require(timing.device_copied_bytes == luma_bytes * frame_count + staged_bytes,
                        "Resident extraction copied more than owned slots and temporal history");
                std::cout << "PASS cuda_resident_inputs bits=" << bits << " residency=" << residency
                          << " depth=" << depth
                          << " eight models / PSNR / pitched mixed memory / temporal ownership\n";
            }
        }
    } catch (const std::exception &error) {
        std::cerr << "FAIL cuda_resident_inputs: " << error.what() << '\n'; return 1;
    }
}
