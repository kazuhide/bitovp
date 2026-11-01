// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include "bitovp_gpu.hpp"
#include <algorithm>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <exception>
#include <functional>
#include <limits>
#include <iterator>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>

namespace bitovp::gpu {

// A slot owns the input pixels, not a lease on the decoder's reusable output.
// assign() completes its copy before returning; the worker may then read the
// picture until it publishes completion. A slot is never reassigned in flight.
class StagedPicture {
public:
    virtual ~StagedPicture() = default;
    virtual void assign(const Picture &source) = 0;
    virtual const Picture &picture() const = 0;
    virtual BackendTimings timings() const { return {}; }
};
using PictureStager = std::function<std::unique_ptr<StagedPicture>(const Picture &)>;

class HostStagedPicture final : public StagedPicture {
public:
    void assign(const Picture &source) override {
        if (source.memory != PictureMemory::Host || source.cuda_ready_event)
            throw std::invalid_argument("Host frame staging requires ready host input");
        if (source.bit_depth != 8 && source.bit_depth != 10)
            throw std::invalid_argument("Frame staging requires 8/10-bit input");
        picture_ = source;
        picture_.device_index = -1;
        picture_.cuda_ready_event = nullptr;
        const std::size_t bytes = source.bit_depth > 8 ? 2 : 1;
        for (unsigned plane = 0; plane < 3; ++plane) {
            const auto &input = source.planes[plane];
            if ((input.width == 0) != (input.height == 0) ||
                input.width > std::numeric_limits<std::size_t>::max() / bytes)
                throw std::invalid_argument("Invalid staged picture geometry");
            const std::size_t row = input.width * bytes;
            if ((row && (!input.data || input.stride < row)) ||
                (input.height && row > std::numeric_limits<std::size_t>::max() / input.height) ||
                (input.height > 1 && input.stride > (std::numeric_limits<std::size_t>::max() - row) / (input.height - 1)))
                throw std::invalid_argument("Invalid staged picture stride");
            auto &storage = planes_[plane];
            storage.resize(row * input.height);
            for (unsigned y = 0; y < input.height; ++y)
                std::memcpy(storage.data() + y * row,
                    static_cast<const std::uint8_t *>(input.data) + y * input.stride, row);
            picture_.planes[plane] = {storage.data(), row, input.width, input.height};
        }
    }
    const Picture &picture() const override { return picture_; }
private:
    Picture picture_;
    std::array<std::vector<std::uint8_t>, 3> planes_;
};

inline std::unique_ptr<StagedPicture> stage_host_picture(const Picture &source) {
    if (source.memory != PictureMemory::Host)
        throw std::invalid_argument("This frame pipeline cannot stage device input");
    return std::make_unique<HostStagedPicture>();
}

std::unique_ptr<StagedPicture> stage_cuda_picture(const Picture &source);

// Spatial extractors have no cross-frame state. Each worker receives its own
// backend context and contiguous local indices. Only motion stays in a single
// ordered context. extract() can return completed spatial scores for an earlier
// input; flush() drains every remaining input in source order.
class FramePipeline final : public FeatureBackend {
public:
    using Factory = std::function<std::unique_ptr<FeatureBackend>()>;
    FramePipeline(Factory factory, unsigned depth, PictureStager stager = stage_host_picture)
        : factory_(std::move(factory)), stager_(std::move(stager)), depth_(depth) {
        if (!factory_ || !stager_ || (depth_ != 2 && depth_ != 4))
            throw std::invalid_argument("Frame pipeline requires 2 or 4 bounded slots");
        ordered_ = factory_();
        if (!ordered_) throw std::invalid_argument("Frame pipeline factory returned no backend");
    }
    ~FramePipeline() override { stop(); }
    FramePipeline(const FramePipeline &) = delete;
    FramePipeline &operator=(const FramePipeline &) = delete;
    DeviceInfo device() const override { return ordered_->device(); }
    PsnrSums psnr(const Picture &reference, const Picture &distorted) override {
        return ordered_->psnr(reference, distorted);
    }
    void configure(const FeaturePlan &plan) override {
        stop();
        configured_ = false; failed_ = false; flushed_ = false;
        count_ = 0; pending_.clear();
        FeaturePlan spatial = plan, temporal = plan;
        spatial.extractors.clear(); temporal.extractors.clear();
        for (const auto &extractor : plan.extractors) {
            if (extractor.name == "motion") temporal.extractors.push_back(extractor);
            else if (extractor.name == "adm" || extractor.name == "cambi" ||
                     extractor.name == "speed_chroma" || extractor.name == "psnr")
                spatial.extractors.push_back(extractor);
            else throw std::invalid_argument("Frame pipeline does not know this extractor's temporal contract");
        }
        ordered_->configure(temporal);
        temporal_ = !temporal.extractors.empty();
        plan_ = plan;
        try {
            if (!spatial.extractors.empty()) for (unsigned i = 0; i < depth_; ++i) {
                auto slot = std::make_unique<Slot>();
                slot->backend = factory_();
                if (!slot->backend || !same_device(slot->backend->device(), ordered_->device()))
                    throw std::runtime_error("Frame pipeline workers selected different devices");
                slot->backend->configure(spatial);
                slots_.push_back(std::move(slot));
            }
            for (auto &slot : slots_) slot->worker = std::thread([value = slot.get()] { work(*value); });
        } catch (...) { stop(); throw; }
        configured_ = true;
    }
    std::vector<FeatureScore> extract(std::uint64_t index,
                                     const Picture &reference, const Picture &distorted) override {
        active();
        if (index != count_ || index == UINT64_MAX)
            throw std::invalid_argument("Frame pipeline indices must be contiguous and start at zero");
        validate(reference, distorted);
        try {
            std::vector<FeatureScore> result;
            if (slots_.empty()) {
                if (temporal_) result = ordered_->extract(index, reference, distorted);
            } else {
                const unsigned number = unsigned(index % slots_.size());
                auto &slot = *slots_[number];
                if (pending_.size() == slots_.size()) collect_front(result);
                if (!slot.reference) slot.reference = stager_(reference);
                if (!slot.distorted) slot.distorted = stager_(distorted);
                if (!slot.reference || !slot.distorted)
                    throw std::runtime_error("Frame pipeline stager returned no storage");
                slot.reference->assign(reference);
                slot.distorted->assign(distorted);
                if (temporal_) append(result, ordered_->extract(index, reference, distorted));
                {
                    std::lock_guard<std::mutex> lock(slot.mutex);
                    if (slot.pending || slot.complete)
                        throw std::logic_error("Frame pipeline reused a live slot");
                    slot.source_index = index;
                    slot.pending = true;
                }
                pending_.push_back(number);
                slot.changed.notify_all();
            }
            ++count_;
            return result;
        } catch (...) { failed_ = true; throw; }
    }
    std::vector<FeatureScore> flush() override {
        if (!configured_ || failed_) throw std::logic_error("Frame pipeline is not accepting completion");
        if (flushed_) return {};
        try {
            std::vector<FeatureScore> result;
            while (!pending_.empty()) collect_front(result);
            for (auto &slot : slots_) {
                if (!slot->backend->flush().empty())
                    throw std::runtime_error("Spatial frame pipeline unexpectedly returned temporal scores");
            }
            if (temporal_) append(result, ordered_->flush());
            flushed_ = true;
            return result;
        } catch (...) { failed_ = true; throw; }
    }
    BackendTimings timings() const override {
        if (!pending_.empty()) throw std::logic_error("Frame pipeline timings require a completed drain");
        auto result = ordered_->timings();
        for (const auto &slot : slots_) {
            accumulate(result, slot->backend->timings());
            if (slot->reference) accumulate(result, slot->reference->timings());
            if (slot->distorted) accumulate(result, slot->distorted->timings());
        }
        return result;
    }
private:
    struct Slot {
        std::unique_ptr<FeatureBackend> backend;
        std::unique_ptr<StagedPicture> reference, distorted;
        std::mutex mutex;
        std::condition_variable changed;
        std::thread worker;
        bool stopping = false, pending = false, complete = false;
        std::uint64_t source_index = 0, local_index = 0;
        std::vector<FeatureScore> scores;
        std::exception_ptr error;
        ~Slot() {
            { std::lock_guard<std::mutex> lock(mutex); stopping = true; }
            changed.notify_all();
            if (worker.joinable()) worker.join();
        }
    };
    static bool same_device(const DeviceInfo &a, const DeviceInfo &b) {
        return a.backend == b.backend && a.index == b.index && a.uuid == b.uuid;
    }
    static void append(std::vector<FeatureScore> &to, std::vector<FeatureScore> from) {
        to.insert(to.end(), std::make_move_iterator(from.begin()), std::make_move_iterator(from.end()));
    }
    static void accumulate(BackendTimings &to, const BackendTimings &from) {
        to.device_copied_bytes += from.device_copied_bytes;
        to.cpu_postprocess_ms += from.cpu_postprocess_ms;
        to.upload_ms += from.upload_ms; to.kernel_ms += from.kernel_ms;
        to.download_ms += from.download_ms;
        to.uploaded_bytes += from.uploaded_bytes; to.downloaded_bytes += from.downloaded_bytes;
        to.allocated_bytes += from.allocated_bytes;
        for (const auto &[key, value] : from.extractor_kernel_ms) to.extractor_kernel_ms[key] += value;
    }
    void active() const {
        if (!configured_ || failed_ || flushed_) throw std::logic_error("Frame pipeline is not accepting frames");
    }
    void validate(const Picture &a, const Picture &b) const {
        for (const auto *picture : {&a, &b})
            if (picture->memory != PictureMemory::CudaDevice && picture->cuda_ready_event)
                throw std::invalid_argument("CUDA readiness events require device pictures");
        if (a.bit_depth != plan_.bit_depth || b.bit_depth != plan_.bit_depth ||
            a.planes[0].width != plan_.width || a.planes[0].height != plan_.height)
            throw std::invalid_argument("Frame pipeline picture does not match its plan");
        const std::size_t bytes = plan_.bit_depth > 8 ? 2 : 1;
        for (unsigned p = 0; p < 3; ++p) {
            const auto &x = a.planes[p], &y = b.planes[p];
            if (x.width != y.width || x.height != y.height ||
                (x.width == 0) != (x.height == 0) ||
                (x.width && (!x.data || !y.data || x.stride < x.width * bytes || y.stride < y.width * bytes)))
                throw std::invalid_argument("Frame pipeline input planes do not match");
        }
    }
    static void work(Slot &slot) noexcept {
        for (;;) {
            std::unique_lock<std::mutex> lock(slot.mutex);
            slot.changed.wait(lock, [&] { return slot.stopping || slot.pending; });
            if (slot.stopping) return;
            const auto source_index = slot.source_index, local_index = slot.local_index;
            lock.unlock();
            std::vector<FeatureScore> scores;
            std::exception_ptr error;
            try {
                scores = slot.backend->extract(local_index, slot.reference->picture(), slot.distorted->picture());
                for (auto &score : scores) {
                    if (score.index != local_index)
                        throw std::runtime_error("Spatial frame worker returned a different frame index");
                    score.index = source_index;
                }
            } catch (...) { error = std::current_exception(); }
            lock.lock();
            slot.scores = std::move(scores); slot.error = error;
            ++slot.local_index;
            slot.pending = false; slot.complete = true;
            lock.unlock(); slot.changed.notify_all();
        }
    }
    void collect_front(std::vector<FeatureScore> &result) {
        auto &slot = *slots_[pending_.front()];
        std::unique_lock<std::mutex> lock(slot.mutex);
        slot.changed.wait(lock, [&] { return slot.complete; });
        if (slot.error) std::rethrow_exception(slot.error);
        append(result, std::move(slot.scores));
        slot.complete = false;
        pending_.pop_front();
    }
    void stop() noexcept {
        for (auto &slot : slots_) {
            { std::lock_guard<std::mutex> lock(slot->mutex); slot->stopping = true; }
            slot->changed.notify_all();
        }
        slots_.clear();
        pending_.clear();
    }
    Factory factory_;
    PictureStager stager_;
    const unsigned depth_;
    std::unique_ptr<FeatureBackend> ordered_;
    std::vector<std::unique_ptr<Slot>> slots_;
    std::deque<unsigned> pending_;
    FeaturePlan plan_;
    bool configured_ = false, failed_ = false, flushed_ = false, temporal_ = false;
    std::uint64_t count_ = 0;
};
}
