// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "speed_factor_cases.hpp"
#include "../src/cuda/parallel_speed.cu"
#include <iostream>

namespace {
void check_status(cudaError_t code) {
    if (code != cudaSuccess) throw std::runtime_error(cudaGetErrorString(code));
}
std::vector<std::uint32_t> execute(const bitovp::gpu::speed_factor_test::Fixture &fixture,
                                 unsigned groups, bool scalar) {
    using namespace bitovp::gpu;
    unsigned *workspace = nullptr;
    check_status(cudaMalloc(&workspace, fixture.words.size() * sizeof(unsigned)));
    try {
        check_status(cudaMemcpy(workspace, fixture.words.data(), fixture.words.size() * sizeof(unsigned), cudaMemcpyHostToDevice));
        const Workspace b{workspace, nullptr, 0};
        if (scalar) factor_kernel<false><<<groups, 256>>>(b);
        else factor_kernel<><<<groups, 256>>>(b);
        check_status(cudaGetLastError());
        std::vector<std::uint32_t> actual(fixture.words.size());
        check_status(cudaMemcpy(actual.data(), workspace, actual.size() * sizeof(unsigned), cudaMemcpyDeviceToHost));
        fixture.verify_contract(actual, groups);
        check_status(cudaFree(workspace));
        return actual;
    } catch (...) { cudaFree(workspace); throw; }
}
}
int main() {
    try {
        const auto count = bitovp::gpu::speed_factor_test::cases([](const auto &fixture, unsigned groups) {
            const auto scalar = execute(fixture, groups, true);
            const auto cooperative = execute(fixture, groups, false);
            for (std::size_t i = 0; i < scalar.size(); ++i)
                if (scalar[i] != cooperative[i]) throw std::runtime_error("Cooperative factor raw-bit mismatch at word " + std::to_string(i));
        });
        std::cout << "PASS CUDA exact cooperative factor: " << count << " diagonal/SPD/rank/failure/slot/guard cases\n";
    } catch (const std::exception &error) {
        std::cerr << "FAIL cuda_speed_factor: " << error.what() << '\n'; return 1;
    }
}
