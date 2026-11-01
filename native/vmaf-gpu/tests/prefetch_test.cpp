// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "../src/prefetch.hpp"
#include <atomic>
#include <chrono>
#include <future>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}
class Gate {
    std::mutex mutex;
    std::condition_variable condition;
    bool opened = false;
public:
    void open() {
        { std::lock_guard<std::mutex> lock(mutex); opened = true; }
        condition.notify_all();
    }
    void wait() {
        std::unique_lock<std::mutex> lock(mutex);
        if (!condition.wait_for(lock, std::chrono::seconds(10), [&] { return opened; }))
            throw std::runtime_error("Test interlock timed out");
    }
    ~Gate() { open(); }
};
void ordered_end() {
    unsigned reads = 0;
    bitovp::gpu::Prefetch<unsigned> reader([&]() -> std::optional<unsigned> {
        const auto index = reads++;
        if (index == 100) return std::nullopt;
        return index;
    });
    unsigned count = 0;
    for (;;) {
        auto value = reader.next();
        if (!value) break;
        require(*value == count++, "Prefetch changed frame order");
    }
    reader.stop();
    require(count == 100 && reads == 101, "EOF coverage changed");
    require(!reader.next(), "Finished prefetch produced another value");
}
void frame_limit() {
    for (unsigned limit : {1u, 2u, 7u}) {
        unsigned reads = 0;
        bitovp::gpu::Prefetch<unsigned> reader([&]() -> std::optional<unsigned> { return reads++; }, limit);
        unsigned count = 0;
        for (;;) {
            auto value = reader.next();
            if (!value) break;
            require(*value == count++, "Limited prefetch changed order");
        }
        reader.stop();
        require(count == limit && reads == limit, "Prefetch read beyond the requested frame limit");
    }
}
struct Track {
    std::atomic<unsigned> live{0}, peak{0};
};
struct Owned {
    Track &track;
    unsigned index;
    Owned(Track &state, unsigned number) : track(state), index(number) {
        const auto current = ++track.live;
        auto old = track.peak.load();
        while (old < current && !track.peak.compare_exchange_weak(old, current)) {}
    }
    ~Owned() { --track.live; }
};
void bounded_ownership() {
    Track track;
    unsigned reads = 0;
    Gate second;
    {
        bitovp::gpu::Prefetch<std::shared_ptr<Owned>> reader([&]() -> std::optional<std::shared_ptr<Owned>> {
            auto value = std::make_shared<Owned>(track, reads++);
            if (value->index == 1) second.open();
            return value;
        }, 100);
        unsigned count = 0;
        for (;;) {
            auto value = reader.next();
            if (!value) break;
            require((*value)->index == count++, "Owned frames changed order");
            if ((*value)->index == 0) second.wait();
        }
        reader.stop();
        require(count == 100 && reads == 100, "Owned frame coverage changed");
    }
    require(track.live == 0 && track.peak <= 2, "More than one queued and one consumed frame stayed alive");
}
void producer_error() {
    unsigned reads = 0;
    bitovp::gpu::Prefetch<unsigned> reader([&]() -> std::optional<unsigned> {
        if (reads++ == 0) return 42;
        throw std::runtime_error("decoder failure");
    });
    require(reader.next() == 42u, "Value preceding decoder failure was lost");
    for (unsigned attempt = 0; attempt < 2; ++attempt) {
        bool rejected = false;
        try { (void)reader.next(); }
        catch (const std::runtime_error &error) { rejected = std::string(error.what()) == "decoder failure"; }
        require(rejected, "Producer error was lost or replaced");
    }
    reader.stop();
    require(reads == 2, "Producer continued after its failure");
}
void consumer_error() {
    Track track;
    bool caught = false;
    try {
        unsigned reads = 0;
        bitovp::gpu::Prefetch<std::shared_ptr<Owned>> reader([&]() -> std::optional<std::shared_ptr<Owned>> {
            return std::make_shared<Owned>(track, reads++);
        });
        auto value = reader.next();
        require(value.has_value(), "Consumer error fixture is empty");
        throw std::runtime_error("consumer failure");
    } catch (const std::runtime_error &error) {
        caught = std::string(error.what()) == "consumer failure";
    }
    require(caught && track.live == 0 && track.peak <= 2, "Consumer failure leaked a frame or producer thread");
}
void cancellation() {
    Gate entered, release;
    bitovp::gpu::Prefetch<unsigned> reader([&]() -> std::optional<unsigned> {
        entered.open(); release.wait(); return 1;
    });
    entered.wait();
    std::promise<std::optional<unsigned>> consumed;
    auto result = consumed.get_future();
    std::thread consumer([&] {
        try { consumed.set_value(reader.next()); }
        catch (...) { consumed.set_exception(std::current_exception()); }
    });
    std::thread stopper([&] { reader.stop(); });
    const bool ready = result.wait_for(std::chrono::seconds(10)) == std::future_status::ready;
    release.open();
    stopper.join(); consumer.join();
    require(ready && !result.get(), "Cancellation did not wake a blocked consumer");
    reader.stop();
    require(!reader.next(), "Stopped producer published its in-flight frame");
}
void discard_queued() {
    Track track;
    Gate created;
    {
        bitovp::gpu::Prefetch<std::shared_ptr<Owned>> reader([&]() -> std::optional<std::shared_ptr<Owned>> {
            auto value = std::make_shared<Owned>(track, 0);
            created.open(); return value;
        }, 1);
        created.wait();
        reader.stop();
        require(!reader.next(), "Cancellation retained a queued frame");
    }
    require(track.live == 0, "Queued frame survived reader destruction");
}
void empty_input() {
    unsigned reads = 0;
    bitovp::gpu::Prefetch<unsigned> reader([&]() -> std::optional<unsigned> { ++reads; return std::nullopt; });
    require(!reader.next(), "Empty input produced a value");
    reader.stop();
    require(reads == 1, "Empty input was read repeatedly");
}
}
int main() {
    try {
        ordered_end(); frame_limit(); bounded_ownership(); producer_error();
        consumer_error(); cancellation(); discard_queued(); empty_input();
        std::cout << "PASS prefetch order, bounds, EOF, limits, producer/consumer errors and cancellation\n";
    } catch (const std::exception &error) {
        std::cerr << "FAIL prefetch: " << error.what() << '\n'; return 1;
    }
}
