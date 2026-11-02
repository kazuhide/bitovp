// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "bitovp_gpu.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {
using bitovp::gpu::Picture;

struct Fixture {
    Picture reference, distorted;
    std::array<std::vector<std::uint8_t>, 3> a, b;
    bitovp::gpu::PsnrSums expected;

    Fixture(unsigned bpc, unsigned width, unsigned height, bool chroma_only,
            bool maximum_difference = false) {
        reference.bit_depth = distorted.bit_depth = bpc;
        const unsigned bytes = bpc > 8 ? 2 : 1;
        for (unsigned plane = 0; plane < 3; ++plane) {
            const unsigned w = plane ? width / 2 : width;
            const unsigned h = plane ? height / 2 : height;
            const std::size_t stride_a = (w + 11) * bytes;
            const std::size_t stride_b = (w + 23) * bytes;
            a[plane].assign(stride_a * h, 0xa5);
            b[plane].assign(stride_b * h, 0x5a);
            for (unsigned y = 0; y < h; ++y) {
                for (unsigned x = 0; x < w; ++x) {
                    const unsigned mask = (1u << bpc) - 1;
                    const unsigned av = maximum_difference ? 0 :
                        (x * 73u + y * 29u + plane * 53u) & mask;
                    const unsigned bv = maximum_difference ? mask :
                        ((!plane && chroma_only) ? av :
                         (x * 31u + y * 83u + plane * 101u + 17u) & mask);
                    if (bytes == 1) {
                        a[plane][y * stride_a + x] = av;
                        b[plane][y * stride_b + x] = bv;
                    } else {
                        const std::uint16_t aa = av, bb = bv;
                        std::memcpy(a[plane].data() + y * stride_a + x * 2, &aa, 2);
                        std::memcpy(b[plane].data() + y * stride_b + x * 2, &bb, 2);
                    }
                    const auto diff = static_cast<std::int64_t>(av) - bv;
                    expected.squared_error[plane] += diff * diff;
                    ++expected.sample_count[plane];
                }
            }
            reference.planes[plane] = {a[plane].data(), stride_a, w, h};
            distorted.planes[plane] = {b[plane].data(), stride_b, w, h};
        }
    }
};

void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}
}

int main() {
    try {
        auto backend = bitovp::gpu::create_cuda_backend({});
        for (const unsigned bpc : {8u, 10u}) {
            for (const bool chroma_only : {false, true}) {
                Fixture fixture(bpc, 133, 77, chroma_only);
                const auto actual = backend->psnr(fixture.reference, fixture.distorted);
                require(actual.squared_error == fixture.expected.squared_error,
                        "GPU squared errors differ from exact CPU uint64 sums");
                require(actual.sample_count == fixture.expected.sample_count,
                        "GPU sample counts include padding or omit samples");
                const auto zero = backend->psnr(fixture.reference, fixture.reference);
                require(zero.squared_error == std::array<std::uint64_t, 3>{},
                        "Identical images must have zero squared error");
            }
        }
        Fixture maximum(10, 2048, 64, false, true);
        const auto large = backend->psnr(maximum.reference, maximum.distorted);
        require(large.squared_error == maximum.expected.squared_error,
                "10-bit squared-error sum overflowed 32 bits");
        Fixture invalid(10, 16, 16, false);
        invalid.distorted.planes[1].width++;
        bool rejected = false;
        try { backend->psnr(invalid.reference, invalid.distorted); }
        catch (const std::invalid_argument &) { rejected = true; }
        require(rejected, "Mismatched plane dimensions were accepted");
        invalid = Fixture(10, 16, 16, false);
        invalid.reference.planes[0].stride = 1;
        rejected = false;
        try { backend->psnr(invalid.reference, invalid.distorted); }
        catch (const std::invalid_argument &) { rejected = true; }
        require(rejected, "Stride shorter than an active row was accepted");
        const auto info = backend->device();
        const auto timing = backend->timings();
        require(info.backend == "cuda" && info.vendor_id == 0x10de,
                "Device evidence does not identify NVIDIA CUDA");
        require(timing.uploaded_bytes > 0 && timing.downloaded_bytes > 0 &&
                timing.allocated_bytes > 0 && timing.kernel_ms > 0,
                "CUDA work and memory evidence were not recorded");
        std::cout << "PASS cuda_psnr exact 8/10-bit YUV padded strides; "
                  << info.name << " upload_ms=" << timing.upload_ms
                  << " kernel_ms=" << timing.kernel_ms
                  << " download_ms=" << timing.download_ms
                  << " uploaded_bytes=" << timing.uploaded_bytes
                  << " downloaded_bytes=" << timing.downloaded_bytes
                  << " allocated_bytes=" << timing.allocated_bytes << '\n';
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "FAIL cuda_psnr: " << error.what() << '\n';
        return 1;
    }
}
