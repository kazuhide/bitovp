// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "speed_covariance_cases.hpp"
#include "../src/cuda/parallel_speed.cu"
#include <iostream>

int main() {
    try {
        const auto count = bitovp::gpu::speed_covariance_test::cases([](const auto &fixture, unsigned groups) {
            using namespace bitovp::gpu;
            unsigned *workspace = nullptr;
            const auto check_status = [](cudaError_t code) {
                if (code != cudaSuccess) throw std::runtime_error(cudaGetErrorString(code));
            };
            check_status(cudaMalloc(&workspace, fixture.words.size() * sizeof(unsigned)));
            try {
                check_status(cudaMemcpy(workspace, fixture.words.data(), fixture.words.size() * sizeof(unsigned), cudaMemcpyHostToDevice));
                covariance_kernel<<<groups, 32>>>({workspace, nullptr, 0}, fixture.image, fixture.covariance[fixture.slot]);
                check_status(cudaGetLastError());
                std::vector<std::uint32_t> actual(fixture.words.size());
                check_status(cudaMemcpy(actual.data(), workspace, actual.size() * sizeof(unsigned), cudaMemcpyDeviceToHost));
                fixture.verify(actual, groups);
            } catch (...) { cudaFree(workspace); throw; }
            check_status(cudaFree(workspace));
        });
        std::cout << "PASS CUDA exact packed covariance: " << count << " shape/pattern/slot/partial/tail/guard cases\n";
    } catch (const std::exception &error) {
        std::cerr << "FAIL cuda_speed_covariance: " << error.what() << '\n'; return 1;
    }
}
