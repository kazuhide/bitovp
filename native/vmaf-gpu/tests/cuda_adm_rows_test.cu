// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "adm_row_cases.hpp"
// Compile the actual stage in this translation unit, including its internal
// launch entry point. No production testing hook or scalar baseline is linked.
// A frozen source path can be supplied to reproduce the old row contract.
#ifndef BITOVP_ADM_SOURCE_PATH
#define BITOVP_ADM_SOURCE_PATH "../src/cuda/parallel_adm.cu"
#endif
#include BITOVP_ADM_SOURCE_PATH
#include <iostream>

int main() {
    try {
        const unsigned count = bitovp::gpu::adm_row_test::cases([](const auto &original, unsigned rows) {
            auto fixture = original;
            // The independent oracle retains all six legacy masking bands.
            // This fixture has zero bands, whose three rounded center terms
            // are -1 each at higher scales and zero at scale zero.
            for (unsigned pixel = 0; pixel < fixture.width * fixture.height; ++pixel) {
                fixture.words[fixture.words[46] + pixel] = fixture.scale ? std::uint32_t(-3) : 0u;
                fixture.words[fixture.words[49] + pixel] = 0u;
            }
            using namespace bitovp::gpu;
            std::uint32_t *workspace = nullptr;
            const auto check_status = [](cudaError_t code) {
                if (code != cudaSuccess) throw std::runtime_error(cudaGetErrorString(code));
            };
            check_status(cudaMalloc(&workspace, fixture.words.size() * sizeof(std::uint32_t)));
            try {
                check_status(cudaMemcpy(workspace, fixture.words.data(), fixture.words.size() * sizeof(std::uint32_t), cudaMemcpyHostToDevice));
                Parameters parameters{};
                std::memcpy(&parameters, fixture.parameters.data(), sizeof(parameters));
                adm_stage<<<rows, 32>>>({workspace, nullptr, nullptr, parameters});
                check_status(cudaGetLastError());
                std::vector<std::uint32_t> actual(fixture.words.size());
                check_status(cudaMemcpy(actual.data(), workspace, actual.size() * sizeof(std::uint32_t), cudaMemcpyDeviceToHost));
                fixture.verify(actual, rows);
            } catch (...) { cudaFree(workspace); throw; }
            check_status(cudaFree(workspace));
        });
        std::cout << "PASS CUDA exact integer ADM rows: " << count << " tail/crop/rounding/ownership cases\n";
    } catch (const std::exception &error) {
        std::cerr << "FAIL cuda_adm_rows: " << error.what() << '\n';
        return 1;
    }
}
