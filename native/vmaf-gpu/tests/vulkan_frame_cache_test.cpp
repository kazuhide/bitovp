// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "bitovp_gpu.hpp"
#include "model_oracle.hpp"
#include <libvmaf/libvmaf.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>

using namespace bitovp::gpu;
namespace {
using Key = std::pair<std::uint64_t, std::string>;
void require(bool condition, const std::string &message) {
    if (!condition) throw std::runtime_error(message);
}
template <typename Action> void rejects(Action action, const char *message) {
    try { action(); } catch (const std::invalid_argument &) { return; }
    throw std::runtime_error(message);
}
bool enabled(const ExtractorSpec &spec, const char *key) {
    const auto found = spec.options.find(key);
    return found != spec.options.end() && (found->second == "true" || found->second == "1");
}
struct Frame {
    Picture picture;
    std::array<std::vector<std::uint8_t>, 3> storage;
    Frame(unsigned width, unsigned height, unsigned depth, unsigned index, bool distorted) {
        picture.bit_depth = depth;
        const unsigned bytes = depth == 8 ? 1 : 2;
        for (unsigned p = 0; p < 3; ++p) {
            const unsigned w = width >> (p != 0), h = height >> (p != 0);
            // Different, changing padded strides ensure the temporal ring keeps
            // each frame's layout rather than borrowing the caller's pixels.
            const auto stride = std::size_t(w + 7 + index % 3 * 5 + p * 2 + (distorted ? 3 : 0)) * bytes;
            storage[p].assign(stride * h, distorted ? 0x5a : 0xa5);
            for (unsigned y = 0; y < h; ++y) for (unsigned x = 0; x < w; ++x) {
                unsigned sample = 32 + ((x * 17 + y * 23 + index * index * 13 + p * 29) % 192);
                if (distorted) sample = sample / 7 * 7;
                const auto value = static_cast<std::uint16_t>(sample << (depth - 8));
                std::memcpy(storage[p].data() + y * stride + x * bytes, &value, bytes);
            }
            picture.planes[p] = {storage[p].data(), stride, w, h};
        }
    }
};
class DirectCpu {
    VmafContext *context = nullptr;
public:
    explicit DirectCpu(const FeaturePlan &plan) {
        VmafConfiguration config{};
        config.n_threads = 1; config.n_subsample = 1; config.gpumask = 1;
        config.log_level = VMAF_LOG_LEVEL_ERROR;
        if (vmaf_init(&context, config)) throw std::runtime_error("Direct CPU init failed");
        try {
            for (const auto &spec : plan.extractors) {
                VmafFeatureDictionary *options = nullptr;
                for (const auto &[key, value] : spec.options)
                    if (vmaf_feature_dictionary_set(&options, key.c_str(), value.c_str()))
                        throw std::runtime_error("Direct CPU feature option failed");
                if (vmaf_use_feature(context, spec.name.c_str(), options))
                    throw std::runtime_error("Direct CPU feature registration failed: " + spec.name);
            }
        } catch (...) { vmaf_close(context); context = nullptr; throw; }
    }
    ~DirectCpu() { if (context) vmaf_close(context); }
    void submit(unsigned index, const Picture &reference, const Picture &distorted) {
        VmafPicture r{}, d{};
        const auto copy = [](VmafPicture &output, const Picture &input) {
            if (vmaf_picture_alloc(&output, VMAF_PIX_FMT_YUV420P, input.bit_depth,
                                   input.planes[0].width, input.planes[0].height))
                throw std::runtime_error("Direct CPU picture allocation failed");
            for (unsigned p = 0; p < 3; ++p) for (unsigned y = 0; y < input.planes[p].height; ++y)
                std::memcpy(static_cast<std::uint8_t *>(output.data[p]) + y * output.stride[p],
                    static_cast<const std::uint8_t *>(input.planes[p].data) + y * input.planes[p].stride,
                    input.planes[p].width * (input.bit_depth == 8 ? 1 : 2));
        };
        try {
            copy(r, reference); copy(d, distorted);
            if (vmaf_read_pictures(context, &r, &d, index)) throw std::runtime_error("Direct CPU extraction failed");
        } catch (...) {
            if (r.ref) vmaf_picture_unref(&r);
            if (d.ref) vmaf_picture_unref(&d);
            throw;
        }
    }
    void finish() {
        if (vmaf_read_pictures(context, nullptr, nullptr, 0)) throw std::runtime_error("Direct CPU flush failed");
    }
    double at(const Key &key) {
        double score = 0;
        if (vmaf_feature_score_at_index(context, key.second.c_str(), &score, unsigned(key.first)))
            throw std::runtime_error("Direct CPU feature missing: " + key.second);
        return score;
    }
};
FeaturePlan plan_for(const std::string &directory, unsigned width, unsigned height, unsigned depth,
                     bool adm, bool psnr, unsigned force_zero) {
    std::vector<ModelInput> models;
    for (const std::string family : {"vmaf_v1.0.16", "vmaf_v1.0.16_hfr"}) {
        const auto id = family + "_3d0h";
        ModelInput model{id, directory + "/" + family + "/" + id + ".json", {}};
        if (force_zero == 1 || (force_zero == 2 && family == "vmaf_v1.0.16"))
            model.feature_overrides["motion"]["motion_force_zero"] = "true";
        models.push_back(std::move(model));
    }
    // Describe effective options/canonical names at a geometry accepted by
    // every model feature. SpEED validates its minimum dimensions before a
    // caller can filter it out; this test never registers or executes SpEED.
    // Selected ADM/motion/PSNR options are geometry-independent. Both backend
    // configuration and DirectCpu picture allocation below use the actual
    // small geometry, including after reconfiguration.
    ModelOracle model(models, {768, 768, depth, 1, psnr}, OracleMode::ImportedFeatures);
    FeaturePlan plan{width, height, depth, {}};
    for (const auto &spec : model.feature_plan().extractors)
        if (spec.name == "motion" || (adm && spec.name == "adm") || (psnr && spec.name == "psnr"))
            plan.extractors.push_back(spec);
    return plan;
}
void run(FeatureBackend &backend, const FeaturePlan &plan, unsigned count, bool adm, bool psnr) {
    DirectCpu cpu(plan);
    std::set<std::string> names;
    unsigned adm_count = 0;
    std::array<bool, 3> active_lags{};
    for (const auto &spec : plan.extractors) {
        names.insert(spec.provided_features.begin(), spec.provided_features.end());
        if (spec.name == "adm") ++adm_count;
        if (spec.name == "motion" && !enabled(spec, "motion_force_zero"))
            active_lags[enabled(spec, "motion_five_frame_window") ? 2 : 1] = true;
    }
    const bool history = active_lags[1] || active_lags[2];
    backend.configure(plan);
    std::map<Key, double> actual;
    const auto consume = [&](const auto &scores) {
        for (const auto &score : scores)
            require(std::isfinite(score.value) && actual.emplace(Key{score.index, score.name}, score.value).second,
                    "Non-finite or duplicate cached-frame output");
    };
    Frame initial(plan.width, plan.height, plan.bit_depth, 0, false);
    rejects([&] { backend.extract(1, initial.picture, initial.picture); }, "Noncontiguous index was accepted");
    for (unsigned i = 0; i < count; ++i) {
        Frame reference(plan.width, plan.height, plan.bit_depth, i, false);
        Frame distorted(plan.width, plan.height, plan.bit_depth, i, true);
        cpu.submit(i, reference.picture, distorted.picture);
        const auto before = backend.timings().uploaded_bytes;
        consume(backend.extract(i, reference.picture, distorted.picture));
        const auto after = backend.timings().uploaded_bytes;
        const std::uint64_t pixels = std::uint64_t(plan.width) * plan.height;
        const unsigned bytes = plan.bit_depth == 8 ? 1 : 2;
        const std::uint64_t input = (psnr ? 3u : adm ? 2u : history ? 1u : 0u) * pixels * bytes;
        std::uint64_t metadata = std::uint64_t(adm_count) * 128u * sizeof(std::uint32_t) + (psnr ? 12u : 0u);
        for (unsigned lag = 1; lag <= 2; ++lag) if (active_lags[lag] && i >= lag) metadata += 4;
        require(after - before == input + metadata, "Reference Y was uploaded more than once or copy accounting changed");
        // The next caller may recycle every source buffer immediately.
        for (auto &storage : reference.storage) std::fill(storage.begin(), storage.end(), 0xff);
        for (auto &storage : distorted.storage) std::fill(storage.begin(), storage.end(), 0xff);
    }
    consume(backend.flush());
    require(backend.flush().empty(), "Repeated flush duplicated cached-frame outputs");
    cpu.finish();
    require(actual.size() == std::size_t(count) * names.size(), "Incomplete cached-frame feature series");
    for (unsigned i = 0; i < count; ++i) for (const auto &name : names) {
        const Key key{i, name};
        const double expected = cpu.at(key), got = actual.at(key);
        require(std::isfinite(got) && std::abs(got - expected) <= 1e-6 + 1e-7 * std::abs(expected),
                "Cached reference/official CPU feature mismatch: " + name);
    }
    rejects([&] { backend.extract(count, initial.picture, initial.picture); }, "Finished cache accepted another frame");
}
void failed_frame(FeatureBackend &backend, const FeaturePlan &plan) {
    backend.configure(plan);
    Frame bad(plan.width, plan.height, plan.bit_depth, 0, false);
    const std::uint16_t invalid = std::uint16_t(1u << plan.bit_depth);
    require(plan.bit_depth == 10, "Failure fixture requires a representable invalid 10-bit sample");
    std::memcpy(bad.storage[0].data(), &invalid, sizeof(invalid));
    rejects([&] { backend.extract(0, bad.picture, bad.picture); }, "Out-of-range sample was accepted");
    rejects([&] { backend.flush(); }, "Failed cache was allowed to flush");
    rejects([&] { backend.extract(0, bad.picture, bad.picture); }, "Failed cache was reused without configure");
    // Reuse the same Plane objects after changing their host pixels. A stale
    // active cache would return the earlier invalid GPU upload instead.
    for (auto &storage : bad.storage) std::fill(storage.begin(), storage.end(), 0);
    const auto sse = backend.psnr(bad.picture, bad.picture);
    for (const auto sum : sse.squared_error) require(sum == 0, "Frame cache remained active after failed extraction");
}
}
int main(int argc, char **argv) {
    try {
        require(argc == 2, "Usage: vulkan_frame_cache_test MODEL_DIRECTORY");
        BackendOptions options; options.vendor_id = 0x1002;
        auto backend = create_vulkan_backend(options);
        rejects([&] { backend->flush(); }, "Unconfigured backend was allowed to flush");
        unsigned cases = 0;
        for (unsigned depth : {8u, 10u}) for (unsigned force_zero : {0u, 1u, 2u})
            for (const auto mode : std::array<std::array<bool, 2>, 3>{{{true, true}, {true, false}, {false, false}}}) {
                const auto plan = plan_for(argv[1], 192, 128, depth, mode[0], mode[1], force_zero);
                run(*backend, plan, 6, mode[0], mode[1]);
                ++cases;
            }
        // Reconfigure across geometry and delayed-output endpoint lengths.
        for (unsigned count : {1u, 2u}) {
            const auto plan = plan_for(argv[1], 128, 96, 10, true, true, 0);
            run(*backend, plan, count, true, true);
            ++cases;
        }
        const auto plan = plan_for(argv[1], 192, 128, 10, true, true, 0);
        failed_frame(*backend, plan);
        run(*backend, plan, 6, true, true);
        std::cout << "PASS Vulkan reference-Y/motion cache: " << cases + 1
                  << " mixed/force-zero/lag/stride/reconfigure/flush/error cases, exact upload accounting\n";
    } catch (const std::exception &error) {
        std::cerr << "FAIL vulkan_frame_cache: " << error.what() << '\n';
        return 1;
    }
}
