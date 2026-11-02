// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#pragma once
#include <condition_variable>
#include <cstdint>
#include <exception>
#include <functional>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <thread>
#include <utility>

namespace bitovp::gpu {
// One producer and one consumer, with at most one queued value. The consumer
// releases its current value before next(), so decoding can keep only that
// value and one following value alive. stop() is called by the consumer.
template<typename Value> class Prefetch {
public:
    using Producer = std::function<std::optional<Value>()>;
    explicit Prefetch(Producer producer, std::uint64_t maximum = 0)
        : producer_(std::move(producer)), maximum_(maximum) {
        if (!producer_) throw std::invalid_argument("Prefetch requires a producer");
        worker_ = std::thread([this] { produce(); });
    }
    ~Prefetch() { stop(); }
    Prefetch(const Prefetch &) = delete;
    Prefetch &operator=(const Prefetch &) = delete;

    std::optional<Value> next() {
        std::unique_lock<std::mutex> lock(mutex_);
        changed_.wait(lock, [&] { return stopped_ || queued_ || finished_; });
        if (stopped_) return std::nullopt;
        if (queued_) {
            auto value = std::move(queued_);
            queued_.reset();
            lock.unlock();
            changed_.notify_all();
            return value;
        }
        if (error_) std::rethrow_exception(error_);
        return std::nullopt;
    }
    void stop() noexcept {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            stopped_ = true;
            queued_.reset();
        }
        changed_.notify_all();
        if (worker_.joinable()) worker_.join();
    }
private:
    void produce() noexcept {
        try {
            std::uint64_t produced = 0;
            for (;;) {
                std::unique_lock<std::mutex> lock(mutex_);
                // Acquire space before calling the decoder, not after it has
                // allocated a third frame behind a full queue.
                changed_.wait(lock, [&] { return stopped_ || !queued_; });
                if (stopped_) return;
                if (maximum_ && produced == maximum_) {
                    finished_ = true;
                    lock.unlock(); changed_.notify_all(); return;
                }
                lock.unlock();
                auto value = producer_();
                lock.lock();
                if (stopped_) return;
                if (!value) {
                    finished_ = true;
                    lock.unlock(); changed_.notify_all(); return;
                }
                queued_.emplace(std::move(*value));
                ++produced;
                lock.unlock(); changed_.notify_all();
            }
        } catch (...) {
            {
                std::lock_guard<std::mutex> lock(mutex_);
                if (!stopped_) error_ = std::current_exception();
                finished_ = true;
            }
            changed_.notify_all();
        }
    }
    Producer producer_;
    const std::uint64_t maximum_;
    std::mutex mutex_;
    std::condition_variable changed_;
    std::optional<Value> queued_;
    std::exception_ptr error_;
    bool stopped_ = false, finished_ = false;
    std::thread worker_;
};
}
