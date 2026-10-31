// SPDX-License-Identifier: MIT
#include "bitovp_gpu.hpp"
#include "model_oracle.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <iostream>
#include <map>
#include <stdexcept>

using namespace bitovp::gpu;
namespace {
struct Frame {
    Picture picture;
    std::array<std::vector<unsigned char>, 3> storage;
    Frame(unsigned bits, unsigned index, bool distorted) {
        picture.bit_depth = bits;
        for (unsigned p = 0; p < 3; ++p) {
            const unsigned w = p ? 320 : 640, h = p ? 180 : 360, bytes = bits == 8 ? 1 : 2;
            const std::size_t stride = (w + 7) * bytes;
            storage[p].resize(stride * h, 0xa5);
            for (unsigned y = 0; y < h; ++y) for (unsigned x = 0; x < w; ++x) {
                unsigned value = 24 + (((x + 5 * index) / (3 + p)) + y / 7 + p * 31) % 200;
                if (distorted) value = (value / (2 + p)) * (2 + p) + ((x + y + index) % 19 == 0);
                const std::uint16_t sample = value << (bits - 8);
                std::memcpy(storage[p].data() + y * stride + x * bytes, &sample, bytes);
            }
            picture.planes[p] = {storage[p].data(), stride, w, h};
        }
    }
};
}
int main(int argc, char **argv) {
    try {
        if (argc != 2) throw std::invalid_argument("Usage: cuda_cambi_test MODEL_DIRECTORY");
        for (unsigned bits : {8u, 10u}) for (bool resample : {false, true}) {
            ModelInput model{"test", std::string(argv[1]) + "/vmaf_v1.0.16/vmaf_v1.0.16_3d0h.json", {}};
            model.feature_overrides["cambi"]["cambi_max_val"] = "1000";
            if (resample) {
                model.feature_overrides["cambi"]["enc_width"] = "480";
                model.feature_overrides["cambi"]["enc_height"] = "270";
                model.feature_overrides["cambi"]["enc_bitdepth"] = "8";
            }
            ModelOracle cpu({model}, {640, 360, bits, 1, false}, OracleMode::Cpu);
            auto plan = cpu.feature_plan();
            plan.extractors.erase(std::remove_if(plan.extractors.begin(), plan.extractors.end(),
                [](const auto &spec) { return spec.name != "cambi"; }), plan.extractors.end());
            if (plan.extractors.size() != 1) throw std::runtime_error("Unexpected CAMBI feature plan");
            auto backend = create_cuda_backend({});
            backend->configure(plan);
            std::map<std::uint64_t, double> actual;
            for (unsigned i = 0; i < 6; ++i) {
                Frame ref(bits, i, false), dist(bits, i, true);
                cpu.submit(i, ref.picture, dist.picture);
                for (const auto &score : backend->extract(i, ref.picture, dist.picture))
                    if (!actual.emplace(score.index, score.value).second)
                        throw std::runtime_error("Duplicate CAMBI feature");
            }
            if (!backend->flush().empty()) throw std::runtime_error("Unexpected delayed CAMBI output");
            const auto expected = cpu.finish(6);
            unsigned checked = 0;
            double maximum = 0, maximum_error = 0;
            for (const auto &score : expected.features) {
                if (score.name != plan.extractors[0].provided_features.at(0)) continue;
                const auto found = actual.find(score.index);
                if (found == actual.end()) throw std::runtime_error("Missing CAMBI frame");
                const double error = std::abs(found->second - score.value);
                if (!std::isfinite(found->second) || error > 1e-6 + 1e-7 * std::abs(score.value))
                    throw std::runtime_error("CAMBI parity failed at " + std::to_string(score.index) +
                        " expected=" + oracle_double_to_string(score.value) + " got=" + oracle_double_to_string(found->second));
                maximum = std::max(maximum, score.value);
                maximum_error = std::max(maximum_error, error);
                ++checked;
            }
            if (checked != 6 || maximum <= 0) throw std::runtime_error("CAMBI fixture did not exercise unclipped positive output");
            std::cout << "PASS CUDA parallel CAMBI bpc=" << bits << " resample=" << resample
                      << " maximum=" << maximum << " error=" << maximum_error
                      << " kernelMs=" << backend->timings().kernel_ms << '\n';
        }
        return 0;
    } catch (const std::exception &error) { std::cerr << error.what() << '\n'; return 1; }
}
