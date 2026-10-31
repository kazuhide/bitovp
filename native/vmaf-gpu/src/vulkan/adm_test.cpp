// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "bitovp_gpu.hpp"
#include "model_oracle.hpp"
#include "adm_parameters.hpp"
#include <cmath>
#include <cstdint>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

using namespace bitovp::gpu;
namespace {
struct Fixture {
    Picture reference, distorted;
    std::vector<std::uint8_t> a8[3], b8[3];
    std::vector<std::uint16_t> a16[3], b16[3];
    Fixture(unsigned bpc, unsigned frame, bool flat) {
        reference.bit_depth = distorted.bit_depth = bpc;
        for (unsigned plane = 0; plane < 3; ++plane) {
            const unsigned w = plane ? 384 : 768, h = w, stride = w + 16;
            a8[plane].resize(stride * h); b8[plane].resize(stride * h);
            a16[plane].resize(stride * h); b16[plane].resize(stride * h);
            for (unsigned y = 0; y < h; ++y) for (unsigned x = 0; x < w; ++x) {
                const unsigned a = flat ? 120 : 16 + ((x * 29 + y * 47 + (x * y % 101) +
                    frame * frame * 11 + plane * 37) % 220);
                const unsigned b = flat ? 120 : static_cast<unsigned>(std::clamp<int>(
                    static_cast<int>(a) + static_cast<int>((x * 3 + y * 5 + frame) % 15) - 7, 0, 255));
                a8[plane][y * stride + x] = a; b8[plane][y * stride + x] = b;
                a16[plane][y * stride + x] = (a << 2) + (flat ? 0 : (x + y) % 4);
                b16[plane][y * stride + x] = (b << 2) + (flat ? 0 : (x * 3 + frame) % 4);
            }
            reference.planes[plane] = {bpc == 8 ? static_cast<const void *>(a8[plane].data()) : a16[plane].data(),
                stride * (bpc == 8 ? 1u : 2u), w, h};
            distorted.planes[plane] = {bpc == 8 ? static_cast<const void *>(b8[plane].data()) : b16[plane].data(),
                stride * (bpc == 8 ? 1u : 2u), w, h};
        }
    }
};
}

int main(int argc, char **argv) {
    try {
        if (argc < 2 || argc > 4)
            throw std::invalid_argument("Usage: vulkan_adm_test <official-model-dir> [device-index] [vendor-id]");
        std::vector<ModelInput> models;
        for (bool hfr : {false, true}) for (const auto *variant :
            {"1d5h_2160", "3d0h", "3d0h_2160", "5d0h"}) {
            const std::string family = hfr ? "vmaf_v1.0.16_hfr" : "vmaf_v1.0.16";
            const std::string name = family + "_" + variant;
            models.push_back({name, std::string(argv[1]) + "/" + family + "/" + name + ".json",
                              {{"adm", {{"adm_min_val", "0"}}}}});
        }
        BackendOptions options;
        options.vendor_id = argc > 3 ? std::stoul(argv[3], nullptr, 0) : 0x1002;
        options.device_index = argc > 2 ? std::stoi(argv[2]) : -1;
        for (unsigned bpc : {8u, 10u}) for (bool flat : {false, true}) {
            ModelOracle oracle(models, {768, 768, bpc, 1, false}, OracleMode::Cpu);
            FeaturePlan plan = oracle.feature_plan();
            plan.extractors.erase(std::remove_if(plan.extractors.begin(), plan.extractors.end(),
                [](const ExtractorSpec &spec) { return spec.name != "adm"; }), plan.extractors.end());
            if (plan.extractors.empty()) throw std::runtime_error("Official plan did not describe ADM");
            std::set<std::string> names;
            for (const auto &spec : plan.extractors) {
                vulkan_detail::AdmParameters parameters(spec, plan);
                if (parameters.passes.size() != 41 || parameters.result_offset + 6 > parameters.word_count ||
                    parameters.words.size() != 128)
                    throw std::runtime_error("ADM workspace or pass contract is incomplete");
                names.insert(spec.provided_features.begin(), spec.provided_features.end());
            }
            auto backend = create_vulkan_backend(options);
            backend->configure(plan);
            {
                Fixture fixture(bpc, 0, flat);
                Picture device_picture = fixture.reference;
                device_picture.memory = PictureMemory::CudaDevice;
                device_picture.planes[0].data = reinterpret_cast<const void *>(std::uintptr_t(1));
                bool rejected = false;
                try { backend->psnr(device_picture, fixture.distorted); }
                catch (const std::invalid_argument &) { rejected = true; }
                if (!rejected) throw std::runtime_error("Vulkan accepted a CUDA device picture as host memory");
            }
            std::map<std::pair<std::uint64_t, std::string>, double> actual;
            for (unsigned index = 0; index < 6; ++index) {
                Fixture fixture(bpc, index, flat);
                oracle.submit(index, fixture.reference, fixture.distorted);
                for (const auto &score : backend->extract(index, fixture.reference, fixture.distorted))
                    if (!actual.emplace(std::make_pair(score.index, score.name), score.value).second)
                        throw std::runtime_error("Duplicate Vulkan ADM score");
            }
            if (!backend->flush().empty()) throw std::runtime_error("Spatial ADM unexpectedly delayed a score");
            const auto expected = oracle.finish(6);
            std::size_t compared = 0;
            double maximum_error = 0;
            for (const auto &score : expected.features) {
                if (!names.count(score.name)) continue;
                const auto found = actual.find({score.index, score.name});
                if (found == actual.end()) throw std::runtime_error("Missing Vulkan ADM feature: " + score.name);
                const double error = std::abs(found->second - score.value);
                if (!std::isfinite(found->second) || error > 1e-6 + 1e-7 * std::abs(score.value))
                    throw std::runtime_error("Vulkan ADM exceeds abs1e-6+rel1e-7: " + score.name +
                        " index=" + std::to_string(score.index) + " expected=" +
                        oracle_double_to_string(score.value) + " actual=" + oracle_double_to_string(found->second));
                maximum_error = std::max(maximum_error, error);
                ++compared;
            }
            if (compared != actual.size() || compared != names.size() * 6)
                throw std::runtime_error("Vulkan ADM compared an incomplete feature series");
            const auto timing = backend->timings();
            std::cout << "PASS vulkan_adm eight model options min_val=0 bpc=" << bpc << " flat=" << flat
                      << " maximum_error=" << oracle_double_to_string(maximum_error)
                      << " device=" << backend->device().name << " kernel_ms=" << timing.kernel_ms << '\n';
        }
    } catch (const std::exception &error) {
        std::cerr << "FAIL vulkan_adm: " << error.what() << '\n';
        return 1;
    }
}
