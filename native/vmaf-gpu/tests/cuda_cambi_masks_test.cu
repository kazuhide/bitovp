// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "cambi_mask_cases.hpp"
// Compile the production kernels, not a test copy of the optimized stages.
#ifndef BITOVP_CAMBI_SOURCE_PATH
#define BITOVP_CAMBI_SOURCE_PATH "../src/cuda/parallel_cambi.cu"
#endif
#include BITOVP_CAMBI_SOURCE_PATH
#include <iostream>

int main() {
    try {
        const auto count = bitovp::gpu::cambi_mask_test::cases([](const auto &fixture) {
            using namespace bitovp::gpu;
            std::uint32_t *workspace = nullptr;
            const auto check_status = [](cudaError_t code) {
                if (code != cudaSuccess) throw std::runtime_error(cudaGetErrorString(code));
            };
            check_status(cudaMalloc(&workspace, fixture.words.size() * sizeof(std::uint32_t)));
            try {
                check_status(cudaMemcpy(workspace, fixture.words.data(), fixture.words.size() * sizeof(std::uint32_t), cudaMemcpyHostToDevice));
                for (const auto &pass : fixture.passes) {
                    Parameters parameters{};
                    std::memcpy(&parameters, pass.data(), sizeof(parameters));
                    const dim3 block(16, 16), grid((fixture.width + 15u) / 16u, (fixture.height + 15u) / 16u);
                    cambi_kernel<<<grid, block>>>({workspace,
                        reinterpret_cast<const unsigned char *>(workspace + fixture.input_offset), parameters});
                    check_status(cudaGetLastError());
                }
                std::vector<std::uint32_t> actual(fixture.words.size());
                check_status(cudaMemcpy(actual.data(), workspace, actual.size() * sizeof(std::uint32_t), cudaMemcpyDeviceToHost));
                fixture.verify(actual);
            } catch (...) { cudaFree(workspace); throw; }
            check_status(cudaFree(workspace));
        });
        std::cout << "PASS CUDA exact integer CAMBI masks: " << count << " depth/edge/threshold/ownership cases\n";
    } catch (const std::exception &error) {
        std::cerr << "FAIL cuda_cambi_masks: " << error.what() << '\n';
        return 1;
    }
}
