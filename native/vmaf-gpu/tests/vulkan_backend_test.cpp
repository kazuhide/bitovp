// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "bitovp_gpu.hpp"

#include <array>
#include <cmath>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <vector>

using namespace bitovp::gpu;

namespace {
void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}

struct Images {
    Picture reference;
    Picture distorted;
    std::array<std::vector<std::uint8_t>, 3> reference_storage;
    std::array<std::vector<std::uint8_t>, 3> distorted_storage;

    Images(unsigned depth, unsigned width, unsigned height, bool maximum_error = false) {
        reference.bit_depth = distorted.bit_depth = depth;
        const unsigned bytes = depth == 8 ? 1 : 2;
        const unsigned peak = (1u << depth) - 1u;
        for (unsigned p = 0; p < 3; ++p) {
            const unsigned w = p ? (width + 1u) / 2u : width;
            const unsigned h = p ? (height + 1u) / 2u : height;
            const std::size_t stride = (w + 11u + p * 3u) * bytes;
            reference_storage[p].assign(stride * h, 0xa5);
            distorted_storage[p].assign(stride * h, 0x5a);
            for (unsigned y = 0; y < h; ++y) {
                for (unsigned x = 0; x < w; ++x) {
                    const std::uint16_t r = maximum_error ? peak :
                        ((x * 139u + y * 73u + p * 211u) & peak);
                    const std::uint16_t d = maximum_error ? 0u :
                        ((x * 97u + y * 47u + p * 43u + 3u) & peak);
                    std::memcpy(reference_storage[p].data() + y * stride + x * bytes, &r, bytes);
                    std::memcpy(distorted_storage[p].data() + y * stride + x * bytes, &d, bytes);
                }
            }
            reference.planes[p] = {reference_storage[p].data(), stride, w, h};
            distorted.planes[p] = {distorted_storage[p].data(), stride, w, h};
        }
    }
};

PsnrSums exact_sums(const Picture &reference, const Picture &distorted) {
    PsnrSums result;
    const unsigned bytes = reference.bit_depth == 8 ? 1 : 2;
    for (unsigned p = 0; p < 3; ++p) {
        const Plane &r = reference.planes[p];
        const Plane &d = distorted.planes[p];
        result.sample_count[p] = std::uint64_t(r.width) * r.height;
        for (unsigned y = 0; y < r.height; ++y) {
            for (unsigned x = 0; x < r.width; ++x) {
                std::uint16_t a = 0, b = 0;
                std::memcpy(&a, static_cast<const std::uint8_t *>(r.data) + y * r.stride + x * bytes, bytes);
                std::memcpy(&b, static_cast<const std::uint8_t *>(d.data) + y * d.stride + x * bytes, bytes);
                const std::int64_t difference = std::int64_t(a) - b;
                result.squared_error[p] += std::uint64_t(difference * difference);
            }
        }
    }
    return result;
}

void exact_psnr(FeatureBackend &backend, unsigned depth, unsigned width,
                unsigned height, bool maximum_error = false) {
    Images images(depth, width, height, maximum_error);
    const auto expected = exact_sums(images.reference, images.distorted);
    const auto actual = backend.psnr(images.reference, images.distorted);
    require(actual.squared_error == expected.squared_error, "Vulkan SSE must exactly match integer CPU sums");
    require(actual.sample_count == expected.sample_count, "Vulkan must count only active samples");
    const auto zero = backend.psnr(images.reference, images.reference);
    require(zero.squared_error == std::array<std::uint64_t, 3>{}, "identical planes must have exact zero SSE");
    std::cout << "PASS depth=" << depth << " geometry=" << width << 'x' << height
              << " max_error=" << maximum_error << " sse_y=" << actual.squared_error[0] << '\n';
}
}

int main() {
    try {
        BackendOptions options;
        options.vendor_id = 0x1002;
        auto backend = create_vulkan_backend(options);
        require(bool(backend), "Vulkan factory must return a backend");
        const auto device = backend->device();
        require(device.backend == "vulkan", "backend receipt must identify Vulkan");
        require(device.vendor_id == 0x1002, "tests must run on the selected AMD GPU");
        require(device.integrated, "APU test must use the integrated GPU");
        require(!device.uuid.empty(), "receipt must contain the device UUID");
        require(device.name.find("llvmpipe") == std::string::npos &&
                device.name.find("lavapipe") == std::string::npos,
                "a software Vulkan device is not a GPU test result");
        std::cout << "DEVICE " << device.name << " uuid=" << device.uuid
                  << " vendor=" << device.vendor_id << " device=" << device.device_id << '\n';

        exact_psnr(*backend, 8, 1, 1);
        exact_psnr(*backend, 8, 63, 35);
        exact_psnr(*backend, 8, 641, 359);
        exact_psnr(*backend, 10, 63, 35);
        exact_psnr(*backend, 10, 1027, 17, true);
        exact_psnr(*backend, 10, 641, 359);

        ExtractorSpec psnr;
        psnr.name = "psnr";
        psnr.options = {{"enable_chroma", "true"}, {"enable_apsnr", "false"}};
        psnr.provided_features = {"psnr_y_for_test", "psnr_cb_for_test", "psnr_cr_for_test"};
        psnr.canonical_names = {{"psnr_y", "psnr_y_for_test"},
            {"psnr_cb", "psnr_cb_for_test"}, {"psnr_cr", "psnr_cr_for_test"}};
        backend->configure({63, 35, 10, {psnr}});
        Images feature_images(10, 63, 35);
        const auto feature_sums = exact_sums(feature_images.reference, feature_images.distorted);
        const auto feature_scores = backend->extract(0, feature_images.reference, feature_images.distorted);
        require(feature_scores.size() == 3, "Vulkan PSNR provider must emit all three required canonical features");
        for (unsigned p = 0; p < 3; ++p) {
            const double mse = double(feature_sums.squared_error[p]) / feature_sums.sample_count[p];
            const double expected = std::min(10.0 * std::log10(1023.0 * 1023.0 / std::max(mse, 1e-16)), 72.0);
            require(feature_scores[p].name == psnr.provided_features[p], "PSNR provider must use its supplied canonical name");
            require(std::abs(feature_scores[p].value - expected) <= 1e-12,
                    "PSNR provider must use the official double logarithm and finite clip");
        }
        const auto capped = backend->extract(1, feature_images.reference, feature_images.reference);
        for (const auto &score : capped) require(score.value == 72.0, "zero-error 10-bit PSNR must clip to 72");
        require(backend->flush().empty(), "per-frame PSNR must not emit duplicate flush scores");

        Images invalid(10, 13, 7);
        invalid.reference.planes[0].stride = 1;
        bool rejected = false;
        try { backend->psnr(invalid.reference, invalid.distorted); }
        catch (const std::exception &) { rejected = true; }
        require(rejected, "a short input stride must be rejected before GPU access");
        invalid.reference.memory = PictureMemory::CudaDevice;
        invalid.reference.planes[0].data = reinterpret_cast<void *>(1);
        rejected = false;
        try { backend->psnr(invalid.reference, invalid.distorted); }
        catch (const std::exception &) { rejected = true; }
        require(rejected, "Vulkan host backend must reject CUDA pointers before dereferencing them");

        const auto times = backend->timings();
        require(times.allocated_bytes > 0, "receipt must count Vulkan allocations");
        require(times.uploaded_bytes > 0, "receipt must count copied input bytes");
        require(times.downloaded_bytes > 0, "receipt must count partial-result readback bytes");
        require(times.kernel_ms >= 0 && times.upload_ms >= 0 && times.download_ms >= 0,
                "timing receipt must not contain negative durations");
        std::cout << "RECEIPT allocated_bytes=" << times.allocated_bytes
                  << " uploaded_bytes=" << times.uploaded_bytes
                  << " downloaded_bytes=" << times.downloaded_bytes
                  << " upload_ms=" << times.upload_ms << " kernel_ms=" << times.kernel_ms
                  << " download_ms=" << times.download_ms << '\n';
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "FAIL " << error.what() << '\n';
        return 1;
    }
}
