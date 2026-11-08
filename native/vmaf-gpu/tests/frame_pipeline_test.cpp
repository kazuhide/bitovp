// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "../src/frame_pipeline.hpp"
#include <atomic>
#include <chrono>
#include <future>
#include <iostream>
#include <set>
#include <string>

using namespace bitovp::gpu;
namespace {
void require(bool condition, const char *message) { if (!condition) throw std::runtime_error(message); }
struct State {
    std::atomic<unsigned> entered{0}, active{0}, peak{0}, alive{0}, processed{0};
    std::atomic<bool> gate{true};
    int fail_frame = -1;
    bool delayed_motion = false;
};
class Fake final : public FeatureBackend {
public:
    explicit Fake(std::shared_ptr<State> state) : state_(std::move(state)) { ++state_->alive; }
    ~Fake() override { --state_->alive; }
    DeviceInfo device() const override { DeviceInfo d; d.index = 0; d.uuid = "fake"; d.backend = "test"; return d; }
    PsnrSums psnr(const Picture &, const Picture &) override { return {}; }
    void configure(const FeaturePlan &p) override { plan_ = p; count_ = 0; }
    std::vector<FeatureScore> extract(std::uint64_t index, const Picture &r, const Picture &) override {
        require(index == count_++, "Worker local frame sequence is not contiguous");
        if (plan_.extractors.empty()) return {};
        const bool motion = plan_.extractors.front().name == "motion";
        const auto pixel = static_cast<const std::uint8_t *>(r.planes[0].data)[0];
        if (motion) {
            if (!state_->delayed_motion) return {{index, "motion", double(pixel)}};
            const auto previous = previous_pixel_;
            previous_pixel_ = pixel;
            if (!index) return {};
            return {{index - 1, "motion", double(previous)}};
        }
        const unsigned active = ++state_->active;
        auto peak = state_->peak.load();
        while (peak < active && !state_->peak.compare_exchange_weak(peak, active)) {}
        ++state_->entered;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
        while (!state_->gate && std::chrono::steady_clock::now() < deadline) std::this_thread::yield();
        --state_->active;
        require(state_->gate, "Worker test interlock timed out");
        if (state_->fail_frame == int(pixel)) throw std::runtime_error("injected worker error");
        require(static_cast<const std::uint8_t *>(r.planes[0].data)[0] == pixel,
                "Staged pixels were overwritten during extraction");
        ++state_->processed;
        return {{index, "spatial", double(pixel)}};
    }
    std::vector<FeatureScore> flush() override {
        if (state_->delayed_motion && count_ && !plan_.extractors.empty() && plan_.extractors.front().name == "motion")
            return {{count_ - 1, "motion", double(previous_pixel_)}};
        return {};
    }
    BackendTimings timings() const override { BackendTimings t; t.allocated_bytes = 1; return t; }
private:
    std::shared_ptr<State> state_;
    FeaturePlan plan_;
    std::uint64_t count_ = 0;
    unsigned previous_pixel_ = 0;
};
FeaturePlan plan(bool temporal = true) {
    FeaturePlan p; p.width = p.height = 4; p.bit_depth = 8;
    p.extractors.push_back({"adm", {}, {}, {}});
    if (temporal) p.extractors.push_back({"motion", {}, {}, {}});
    return p;
}
struct Input {
    std::array<std::vector<std::uint8_t>,3> bytes;
    Picture picture;
    Input() {
        picture.bit_depth = 8;
        for (unsigned p = 0; p < 3; ++p) {
            const unsigned size = p ? 2 : 4;
            bytes[p].resize(size * (size + 3));
            picture.planes[p] = {bytes[p].data(), size + 3, size, size};
        }
    }
    void set(unsigned value) { for (auto &p : bytes) std::fill(p.begin(), p.end(), value); }
};
auto factory(const std::shared_ptr<State> &state) { return [state] { return std::make_unique<Fake>(state); }; }
void append(std::vector<FeatureScore> &to, std::vector<FeatureScore> from) {
    to.insert(to.end(), from.begin(), from.end());
}
void coverage(unsigned depth, unsigned frames, bool delayed = false) {
    const auto state = std::make_shared<State>();
    state->delayed_motion = delayed;
    {
        FramePipeline pipeline(factory(state), depth);
        pipeline.configure(plan());
        Input input;
        std::vector<FeatureScore> scores;
        for (unsigned i = 0; i < frames; ++i) {
            input.set(i);
            append(scores, pipeline.extract(i, input.picture, input.picture));
            input.set(255);
        }
        append(scores, pipeline.flush());
        require(pipeline.flush().empty(), "Repeated flush duplicated output");
        require(scores.size() == frames * 2, "Frame feature coverage changed");
        std::set<std::pair<unsigned,std::string>> seen;
        for (const auto &score : scores) {
            require(score.index < frames && score.value == score.index, "Worker frame index mapping or input ownership failed");
            require(seen.emplace(score.index, score.name).second, "Pipeline duplicated a feature");
        }
        require(pipeline.timings().allocated_bytes == depth + 1, "Pipeline lost memory accounting");
    }
    require(!state->alive && !state->active, "Pipeline left worker resources alive");
}
void concurrent_workers(unsigned depth) {
    const auto state = std::make_shared<State>();
    state->gate = false;
    FramePipeline pipeline(factory(state), depth);
    pipeline.configure(plan(false));
    Input input;
    for (unsigned i = 0; i < depth; ++i) { input.set(i); (void)pipeline.extract(i, input.picture, input.picture); }
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (state->entered < depth && std::chrono::steady_clock::now() < deadline) std::this_thread::yield();
    const auto entered = state->entered.load(), peak = state->peak.load();
    state->gate = true;
    require(entered == depth && peak == depth, "Distinct frames did not execute concurrently");
    require(pipeline.flush().size() == depth, "Concurrent drain lost frames");
    require(state->peak <= depth, "Frame pipeline exceeded its configured slot bound");
}
void worker_failure() {
    const auto state = std::make_shared<State>();
    state->fail_frame = 1;
    {
        FramePipeline pipeline(factory(state), 4);
        pipeline.configure(plan());
        Input input;
        for (unsigned i = 0; i < 4; ++i) { input.set(i); (void)pipeline.extract(i, input.picture, input.picture); }
        bool caught = false;
        try { (void)pipeline.flush(); }
        catch (const std::runtime_error &e) { caught = std::string(e.what()) == "injected worker error"; }
        require(caught, "Worker failure was lost");
        caught = false;
        try { (void)pipeline.extract(4, input.picture, input.picture); }
        catch (const std::logic_error &) { caught = true; }
        require(caught, "Pipeline accepted new frames after failure");
    }
    require(!state->alive && !state->active, "Failure left worker resources alive");
}
void cancellation_and_reconfigure() {
    const auto state = std::make_shared<State>();
    {
        FramePipeline pipeline(factory(state), 2);
        pipeline.configure(plan());
        Input input;
        for (unsigned i = 0; i < 2; ++i) { input.set(i); (void)pipeline.extract(i, input.picture, input.picture); }
        // configure must join active workers before replacing their storage.
        pipeline.configure(plan());
        input.set(0); auto scores = pipeline.extract(0, input.picture, input.picture);
        append(scores, pipeline.flush());
        require(scores.size() == 2, "Reconfigured pipeline retained previous outputs");
    }
    require(!state->alive && !state->active, "Cancellation left worker resources alive");
}
void host_plane_copy() {
    for (unsigned bits : {8u, 10u}) {
        Picture source; source.bit_depth = bits;
        std::array<std::vector<std::uint8_t>,3> storage;
        const unsigned bytes = bits > 8 ? 2 : 1;
        for (unsigned p = 0; p < 3; ++p) {
            const unsigned width = p ? 3 : 5, height = p ? 2 : 4, row = width * bytes, stride = row + 7;
            storage[p].resize(stride * height, 0xff);
            for (unsigned y = 0; y < height; ++y)
                for (unsigned x = 0; x < row; ++x) storage[p][y * stride + x] = y * 10 + x;
            source.planes[p] = {storage[p].data(), stride, width, height};
        }
        HostStagedPicture staged; staged.assign(source);
        for (auto &buffer : storage) std::fill(buffer.begin(), buffer.end(), 0);
        const auto &output = staged.picture();
        require(output.bit_depth == bits && output.memory == PictureMemory::Host, "Host staged format changed");
        for (unsigned p = 0; p < 3; ++p) {
            const auto &plane = output.planes[p];
            const auto *data = static_cast<const std::uint8_t *>(plane.data);
            require(plane.stride == plane.width * bytes, "Staging did not preserve active row bytes");
            for (unsigned y = 0; y < plane.height; ++y)
                for (unsigned x = 0; x < plane.width * bytes; ++x)
                    require(data[y * plane.stride + x] == y * 10 + x, "Staged row pixels or padding changed");
        }
    }
}
void invalid_input_and_spatial_contract() {
    const auto state = std::make_shared<State>();
    FramePipeline pipeline(factory(state), 2);
    auto p = plan(); p.extractors.push_back({"unknown-temporal", {}, {}, {}});
    bool caught = false;
    try { pipeline.configure(p); } catch (const std::invalid_argument &) { caught = true; }
    require(caught, "Unknown extractor temporal contract was assumed spatial");
    pipeline.configure(plan());
    Input input;
    auto broken = input.picture; broken.planes[0].stride = 1;
    caught = false;
    try { (void)pipeline.extract(0, broken, broken); } catch (const std::invalid_argument &) { caught = true; }
    require(caught, "Invalid stride was accepted");
    broken = input.picture; broken.cuda_ready_event = reinterpret_cast<void *>(1);
    caught = false;
    try { (void)pipeline.extract(0, broken, broken); } catch (const std::invalid_argument &) { caught = true; }
    require(caught, "Frame pipeline silently accepted a CUDA event on host memory");
    HostStagedPicture staging;
    caught = false;
    try { staging.assign(broken); } catch (const std::invalid_argument &) { caught = true; }
    require(caught, "Host staging silently discarded a CUDA readiness event");
    input.set(0); (void)pipeline.extract(0, input.picture, input.picture); (void)pipeline.flush();
    caught = false;
    try { (void)pipeline.extract(1, input.picture, input.picture); } catch (const std::logic_error &) { caught = true; }
    require(caught, "Pipeline accepted a frame after flush");
    auto temporal_only = plan(); temporal_only.extractors.erase(temporal_only.extractors.begin());
    pipeline.configure(temporal_only);
    caught = false;
    try { (void)pipeline.extract(0, broken, broken); } catch (const std::invalid_argument &) { caught = true; }
    require(caught, "Temporal-only pipeline silently accepted a CUDA event on host memory");
}
}
int main() {
    try {
        for (unsigned depth : {2u, 4u}) {
            for (unsigned frames : {0u, 1u, 2u, 3u, 9u, 33u}) {
                coverage(depth, frames); coverage(depth, frames, true);
            }
            concurrent_workers(depth);
        }
        worker_failure(); cancellation_and_reconfigure(); host_plane_copy(); invalid_input_and_spatial_contract();
        std::cout << "PASS bounded concurrent frame ownership, ordering, EOF/short sequences, drain, errors and cancellation\n";
    } catch (const std::exception &e) { std::cerr << "FAIL: " << e.what() << '\n'; return 1; }
}
