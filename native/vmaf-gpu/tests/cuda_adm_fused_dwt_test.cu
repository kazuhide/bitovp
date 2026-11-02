// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "adm_dwt_cases.hpp"
#include "../src/cuda/parallel_adm.cu"
#include <iostream>

int main() {
    try {
        unsigned count = 0;
        bitovp::gpu::adm_dwt_test::cases([&](const auto &original) {
            if (original.passes.size() != 2) return;
            auto fixture = original;
            const auto &pass = fixture.passes.back();
            const unsigned intermediate_size = pass[4] * pass[3];
            // The int64 oracle's four bands remain exact. Fused processing
            // must leave the unused global vertical scratch guards untouched.
            for (unsigned slot : {52u, 53u}) for (unsigned i = 0; i < intermediate_size; ++i)
                fixture.expected[fixture.words[slot] + i] = fixture.words[fixture.words[slot] + i];
            using namespace bitovp::gpu;
            unsigned *workspace = nullptr;
            const auto check_status = [](cudaError_t code) {
                if (code != cudaSuccess) throw std::runtime_error(cudaGetErrorString(code));
            };
            check_status(cudaMalloc(&workspace, fixture.words.size() * sizeof(unsigned)));
            try {
                check_status(cudaMemcpy(workspace, fixture.words.data(), fixture.words.size() * sizeof(unsigned), cudaMemcpyHostToDevice));
                Parameters p{}; std::memcpy(&p, pass.data(), sizeof(p));
                const auto *ref = reinterpret_cast<const unsigned char *>(workspace + fixture.input_offsets[0]);
                const auto *dist = reinterpret_cast<const unsigned char *>(workspace + fixture.input_offsets[1]);
                adm_first_dwt<<<dim3((p.width + 15) / 16, (p.height + 15) / 16), dim3(16, 16)>>>(
                    {workspace, ref, dist, p});
                check_status(cudaGetLastError());
                std::vector<std::uint32_t> actual(fixture.words.size());
                check_status(cudaMemcpy(actual.data(), workspace, actual.size() * sizeof(unsigned), cudaMemcpyDeviceToHost));
                fixture.verify(actual);
            } catch (...) { cudaFree(workspace); throw; }
            check_status(cudaFree(workspace)); ++count;
        });
        std::cout << "PASS CUDA exact fused ADM scale-zero DWT: " << count << " depth/edge/rounding/overflow/ownership cases\n";
    } catch (const std::exception &error) {
        std::cerr << "FAIL cuda_adm_fused_dwt: " << error.what() << '\n'; return 1;
    }
}
