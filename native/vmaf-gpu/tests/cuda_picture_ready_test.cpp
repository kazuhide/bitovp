// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "bitovp_gpu.hpp"
#include <cuda_runtime.h>
#include <array>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>

using namespace bitovp::gpu;
namespace {
void checked(cudaError_t code, const char *operation) {
    if (code != cudaSuccess) throw std::runtime_error(std::string(operation) + ": " + cudaGetErrorString(code));
}
void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}

// The callback owns its state and makes no CUDA calls. A failed assertion
// releases it before the consumer future is destroyed; the watchdog is a final
// bound against a regressed consumer blocking indefinitely during this test.
class ProducerGate {
    struct State {
        std::mutex mutex;
        std::condition_variable changed;
        bool released = false, expired = false;
    };
    using Ticket = std::shared_ptr<State>;
    Ticket state_ = std::make_shared<State>();
    std::thread watchdog_;
    static void CUDART_CB hold(void *opaque) {
        std::unique_ptr<Ticket> ticket(static_cast<Ticket *>(opaque));
        auto &state = **ticket;
        std::unique_lock<std::mutex> lock(state.mutex);
        state.changed.wait(lock, [&] { return state.released; });
    }
public:
    ProducerGate() : watchdog_([state = state_] {
        std::unique_lock<std::mutex> lock(state->mutex);
        if (!state->changed.wait_for(lock, std::chrono::seconds(5), [&] { return state->released; })) {
            state->released = state->expired = true;
            state->changed.notify_all();
        }
    }) {}
    ~ProducerGate() { release(); if (watchdog_.joinable()) watchdog_.join(); }
    void enqueue(cudaStream_t stream) {
        auto ticket = std::make_unique<Ticket>(state_);
        checked(cudaLaunchHostFunc(stream, hold, ticket.get()), "enqueue producer interlock");
        ticket.release();
    }
    void release() {
        std::lock_guard<std::mutex> lock(state_->mutex);
        state_->released = true;
        state_->changed.notify_all();
    }
    bool expired() const {
        std::lock_guard<std::mutex> lock(state_->mutex);
        return state_->expired;
    }
};

struct Source {
    Picture picture;
    std::array<void *,3> device{}, host{};
    cudaStream_t stream = nullptr;
    cudaEvent_t ready = nullptr;
    explicit Source(unsigned bits) {
        picture.memory = PictureMemory::CudaDevice;
        picture.device_index = 0;
        picture.bit_depth = bits;
        try {
            checked(cudaStreamCreateWithFlags(&stream,cudaStreamNonBlocking), "create producer stream");
            checked(cudaEventCreateWithFlags(&ready,cudaEventDisableTiming), "create producer event");
            for (unsigned p = 0; p < 3; ++p) {
                const unsigned width = p ? 34 : 67, height = p ? 22 : 43;
                const std::size_t row = width * (bits > 8 ? 2u : 1u);
                std::size_t pitch = 0;
                checked(cudaMallocPitch(&device[p],&pitch,row,height), "allocate producer plane");
                checked(cudaMallocHost(&host[p],row * height), "allocate pinned producer pixels");
                picture.planes[p] = {device[p],pitch,width,height};
            }
        } catch (...) { release(); throw; }
    }
    ~Source() { release(); }
    Source(const Source &) = delete;
    Source &operator=(const Source &) = delete;
    void release() noexcept {
        if (stream) cudaStreamSynchronize(stream);
        for (auto value : device) if (value) cudaFree(value);
        for (auto value : host) if (value) cudaFreeHost(value);
        if (ready) cudaEventDestroy(ready);
        if (stream) cudaStreamDestroy(stream);
    }
    void pixels(unsigned seed) {
        for (unsigned p = 0; p < 3; ++p) {
            const auto &plane = picture.planes[p];
            for (unsigned y = 0; y < plane.height; ++y) for (unsigned x = 0; x < plane.width; ++x) {
                const std::uint16_t value = seed + (x * 3 + y * 7 + p * 11) % 37;
                const std::size_t offset = std::size_t(y) * plane.width + x;
                if (picture.bit_depth == 8) static_cast<std::uint8_t *>(host[p])[offset] = value;
                else static_cast<std::uint16_t *>(host[p])[offset] = value;
            }
        }
    }
    void copy() {
        for (unsigned p = 0; p < 3; ++p) {
            const auto &plane = picture.planes[p];
            const std::size_t row = plane.width * (picture.bit_depth > 8 ? 2u : 1u);
            checked(cudaMemcpy2DAsync(device[p],plane.stride,host[p],row,row,plane.height,
                                     cudaMemcpyHostToDevice,stream), "produce resident pixels");
        }
        checked(cudaEventRecord(ready,stream), "record producer readiness");
    }
    void reset(unsigned seed) {
        pixels(seed); copy();
        checked(cudaStreamSynchronize(stream), "complete ready input");
        picture.cuda_ready_event = nullptr;
    }
    void pending(unsigned seed, ProducerGate &gate) {
        pixels(seed); gate.enqueue(stream); copy();
        picture.cuda_ready_event = ready;
        require(cudaEventQuery(ready) == cudaErrorNotReady, "Producer gate did not retain unfinished input");
    }
};

FeaturePlan plan(unsigned bits) {
    FeaturePlan value; value.width = 67; value.height = 43; value.bit_depth = bits;
    ExtractorSpec spec; spec.name = "psnr"; spec.options["enable_mse"] = "true";
    for (const char *name : {"mse_y","mse_cb","mse_cr"}) {
        spec.canonical_names[name] = name;
        spec.provided_features.push_back(name);
    }
    value.extractors.push_back(std::move(spec));
    return value;
}

using Values = std::array<double,3>;
Values consume(FeatureBackend &backend, bool feature_api, const Picture &reference, const Picture &distorted) {
    Values result{};
    if (!feature_api) {
        const auto sums = backend.psnr(reference,distorted);
        for (unsigned p = 0; p < 3; ++p) {
            require(sums.sample_count[p] == std::uint64_t(reference.planes[p].width) * reference.planes[p].height,
                    "Direct PSNR sample count changed");
            result[p] = double(sums.squared_error[p]) / sums.sample_count[p];
        }
    } else {
        const auto scores = backend.extract(0,reference,distorted);
        require(scores.size() == 3, "PSNR feature coverage changed");
        const std::array<const char *,3> names{{"mse_y","mse_cb","mse_cr"}};
        for (const auto &score : scores) {
            require(score.index == 0, "Readiness regression changed the feature index");
            unsigned p = 0;
            while (p < 3 && score.name != names[p]) ++p;
            require(p < 3, "Unexpected PSNR feature"); result[p] = score.value;
        }
    }
    return result;
}

void run_case(FeatureBackend &backend, bool feature_api, Source &reference, Source &distorted,
              unsigned pending_mask, bool omit_events) {
    reference.reset(0); distorted.reset(0);
    if (feature_api) backend.configure(plan(reference.picture.bit_depth));
    // Declaring the future first ensures the gate releases before an unfinished
    // async consumer is joined during stack unwinding.
    std::future<Values> consumer;
    ProducerGate gate;
    if (pending_mask & 1) reference.pending(20,gate); else reference.reset(20);
    if (pending_mask & 2) distorted.pending(70,gate); else distorted.reset(70);
    auto a = reference.picture, b = distorted.picture;
    if (omit_events) a.cuda_ready_event = b.cuda_ready_event = nullptr;
    consumer = std::async(std::launch::async,[&backend,feature_api,a,b] { return consume(backend,feature_api,a,b); });
    const auto status = consumer.wait_for(omit_events ? std::chrono::milliseconds(500) : std::chrono::milliseconds(100));
    if (omit_events) {
        require(status == std::future_status::ready,
                "Missing-event negative control was vacuous: a CUDA call implicitly waited for the producer");
        const auto wrong = consumer.get();
        require(wrong != Values{{2500,2500,2500}}, "Missing-event negative control read already-finished input");
        require(!gate.expired(), "Negative control escaped through its watchdog");
        gate.release();
    } else {
        require(status == std::future_status::timeout, "Direct CUDA API returned before its picture producer completed");
        require(!gate.expired(), "Consumer watchdog expired before the readiness assertion");
        gate.release();
        const auto actual = consumer.get();
        require(actual == Values{{2500,2500,2500}}, "Direct CUDA API consumed unready or changed resident pixels");
    }
    checked(cudaEventSynchronize(reference.ready), "finish reference producer");
    checked(cudaEventSynchronize(distorted.ready), "finish distorted producer");
}

void exercise(unsigned bits) {
    Source reference(bits), distorted(bits);
    auto backend = create_cuda_backend({});
    reference.reset(20); distorted.reset(70);
    // Warm the exact PSNR specialization and all allocations before placing a
    // producer callback in flight. CUDA lazy module loading can synchronize the
    // context and would otherwise invalidate the missing-event control.
    require(consume(*backend,false,reference.picture,distorted.picture) == Values{{2500,2500,2500}},
            "Ready direct PSNR warmup differs");
    backend->configure(plan(bits));
    require(consume(*backend,true,reference.picture,distorted.picture) == Values{{2500,2500,2500}},
            "Ready PSNR feature warmup differs");
    for (bool feature_api : {false,true}) for (unsigned pending_mask : {1u,2u,3u}) {
        run_case(*backend,feature_api,reference,distorted,pending_mask,true);
        run_case(*backend,feature_api,reference,distorted,pending_mask,false);
    }
    auto invalid = reference.picture; invalid.memory = PictureMemory::Host; invalid.cuda_ready_event = reference.ready;
    bool rejected = false;
    try { (void)backend->psnr(invalid,invalid); } catch (const std::invalid_argument &) { rejected = true; }
    require(rejected, "Direct PSNR silently accepted a CUDA event on host memory");
    backend->configure(plan(bits)); rejected = false;
    try { (void)backend->extract(0,invalid,invalid); } catch (const std::invalid_argument &) { rejected = true; }
    require(rejected, "Feature extraction silently accepted a CUDA event on host memory");
    std::cout << "PASS CUDA direct PSNR/features bpc=" << bits
              << " reference/distorted/both producer events, effective missing-event controls and invalid host-event rejection\n";
}
}

int main() {
    try { checked(cudaSetDevice(0), "select CUDA test device"); exercise(8); exercise(10); }
    catch (const std::exception &error) { std::cerr << "FAIL cuda_picture_ready: " << error.what() << '\n'; return 1; }
}
