// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "adm_csf_cases.hpp"
#include "../src/cuda/parallel_adm.cu"
#include <iostream>

namespace {
__global__ void observe_threshold(bitovp::gpu::Stage stage) {
    const unsigned x = blockIdx.x * blockDim.x + threadIdx.x;
    const unsigned y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x < stage.p.width && y < stage.p.height)
        stage.words[stage.words[59] + y * stage.p.width + x] = unsigned(stage.masking_threshold(x, y));
}
}
int main() {
    try {
        const auto count = bitovp::gpu::adm_csf_test::cases([](const auto &fixture) {
            using namespace bitovp::gpu;
            unsigned *workspace = nullptr;
            const auto check_status = [](cudaError_t code) {
                if (code != cudaSuccess) throw std::runtime_error(cudaGetErrorString(code));
            };
            check_status(cudaMalloc(&workspace, fixture.words.size() * sizeof(unsigned)));
            try {
                check_status(cudaMemcpy(workspace, fixture.words.data(), fixture.words.size() * sizeof(unsigned), cudaMemcpyHostToDevice));
                for (const auto &pass : fixture.passes) {
                    Parameters p{}; std::memcpy(&p, pass.data(), sizeof(p));
                    const dim3 grid((p.width + 15) / 16, (p.height + 15) / 16), block(16, 16);
                    const Stage stage{workspace, nullptr, nullptr, p};
                    if (p.mode == 7) observe_threshold<<<grid, block>>>(stage);
                    else adm_stage<<<grid, block>>>(stage);
                    check_status(cudaGetLastError());
                }
                std::vector<std::uint32_t> actual(fixture.words.size());
                check_status(cudaMemcpy(actual.data(), workspace, actual.size() * sizeof(unsigned), cudaMemcpyDeviceToHost));
                fixture.verify(actual);
            } catch (...) { cudaFree(workspace); throw; }
            check_status(cudaFree(workspace));
        });
        std::cout << "PASS CUDA exact ADM CSF sums: " << count << " scale/orientation/rounding/edge/ownership cases\n";
    } catch (const std::exception &error) {
        std::cerr << "FAIL cuda_adm_csf: " << error.what() << '\n'; return 1;
    }
}
