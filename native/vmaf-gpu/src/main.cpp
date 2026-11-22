// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "decoder.hpp"
#include "decoder_pair.hpp"
#include "decoder_runtime.hpp"
#include "prefetch.hpp"
#include "frame_pipeline.hpp"
#include "cli_options.hpp"
#include "device_protocol.hpp"
#include "supervisor.hpp"
#include "model_oracle.hpp"
#include "banding.hpp"
extern "C" {
#include <libavutil/mem.h>
#include <libavutil/sha.h>
}
#include <algorithm>
#include <chrono>
#include <cerrno>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <fcntl.h>
#include <iomanip>
#include <iostream>
#include <locale>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/resource.h>
#include <unistd.h>

#ifndef BITOVP_NATIVE_SOURCE_SHA256
#define BITOVP_NATIVE_SOURCE_SHA256 "unrecorded"
#endif

using namespace bitovp::gpu;
using bitovp::gpu::cli::Options;
using bitovp::gpu::cli::parse;
namespace {
using Clock = std::chrono::steady_clock;
double elapsed(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
using bitovp::gpu::protocol::quoted;

bool same_loader_generation(const LoaderGeneration &expected) {
    const auto actual = runtime_loader_generation();
    return actual && *actual == expected;
}

std::optional<DecoderRuntime> initialized_experiment_runtime(const std::optional<DecoderRuntime> &admitted) {
    if (!admitted) return std::nullopt;
    auto initialized = capture_decoder_runtime();
    if (!initialized || !decoder_runtime_preserved(*admitted, *initialized)) return std::nullopt;
    return initialized;
}

bool attestable_gpu_driver(const DeviceInfo &device) {
    if (!device.driver_version_known) return false;
    // The optional NVML query can unload its library before capture.
    const auto &source = device.driver_version_source;
    return source == "sysfs-module-version" || source == "proc-driver-nvidia" ||
           source == "vulkan-raw-driver-version" || source == "vulkan-driver-properties";
}

bool same_gpu_driver(const DeviceInfo &before, const DeviceInfo &after) {
    return attestable_gpu_driver(before) && after.driver_version_known &&
           before.backend == after.backend && before.index == after.index &&
           before.uuid == after.uuid && before.vendor_id == after.vendor_id &&
           before.device_id == after.device_id &&
           before.driver_version == after.driver_version &&
           before.driver_version_source == after.driver_version_source;
}

std::string file_hash(const std::string &path, std::string *snapshot = nullptr) {
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error("Cannot open file for SHA-256");
    std::unique_ptr<AVSHA, decltype(&av_free)> state(av_sha_alloc(), &av_free);
    if (!state) throw std::bad_alloc();
    if (av_sha_init(state.get(), 256)) throw std::runtime_error("Cannot initialize SHA-256");
    std::array<char, 1 << 16> buffer{};
    while (in.read(buffer.data(), buffer.size()) || in.gcount()) {
        const auto count = static_cast<std::size_t>(in.gcount());
        av_sha_update(state.get(), reinterpret_cast<const std::uint8_t *>(buffer.data()), count);
        if (snapshot) snapshot->append(buffer.data(), count);
    }
    if (!in.eof()) throw std::runtime_error("Cannot read file for SHA-256");
    std::array<std::uint8_t, 32> digest{};
    av_sha_final(state.get(), digest.data());
    std::ostringstream out;
    for (auto b : digest) out << std::hex << std::setw(2) << std::setfill('0') << unsigned(b);
    return out.str();
}

std::unique_ptr<FeatureBackend> make_backend(const Options &options) {
    if (options.backend == "cuda") {
#ifdef BITOVP_HAVE_CUDA
        return create_cuda_backend(options.device);
#else
        throw std::runtime_error("This binary was built without CUDA");
#endif
    }
    if (options.backend == "vulkan") {
#ifdef BITOVP_HAVE_VULKAN
        return create_vulkan_backend(options.device);
#else
        throw std::runtime_error("This binary was built without Vulkan");
#endif
    }
    return {};
}
struct Parity {
    double max_feature_error = 0, max_score_error = 0;
    std::size_t features = 0, scores = 0;
};
Parity compare(const OracleResult &cpu, const OracleResult &gpu) {
    if (cpu.frame_count != gpu.frame_count || cpu.features.size() != gpu.features.size())
        throw std::runtime_error("CPU/GPU feature coverage differs");
    std::map<std::pair<std::uint64_t, std::string>, double> expected;
    for (const auto &f : cpu.features) expected[{f.index, f.name}] = f.value;
    Parity result;
    for (const auto &f : gpu.features) {
        const auto found = expected.find({f.index, f.name});
        if (found == expected.end()) throw std::runtime_error("GPU feature absent in CPU reference");
        const double error = std::abs(f.value - found->second);
        result.max_feature_error = std::max(result.max_feature_error, error);
        ++result.features;
        if (error > 1e-6 + 1e-7 * std::abs(found->second))
            throw std::runtime_error("GPU feature parity failed: " + f.name + " at frame " +
                std::to_string(f.index) + " error=" + oracle_double_to_string(error));
    }
    if (cpu.model_scores.size() != gpu.model_scores.size()) throw std::runtime_error("Model coverage differs");
    for (const auto &[id, actual] : gpu.model_scores) {
        const auto &values = cpu.model_scores.at(id);
        if (values.size() != actual.size()) throw std::runtime_error("Model frame coverage differs");
        for (std::size_t i = 0; i < actual.size(); ++i) {
            const double error = std::abs(actual[i] - values[i]);
            result.max_score_error = std::max(result.max_score_error, error);
            ++result.scores;
            if (error > 1e-4) throw std::runtime_error("GPU model parity failed: " + id + " frame=" + std::to_string(i));
        }
        const auto &expected_pool = cpu.pooled.at(id), &actual_pool = gpu.pooled.at(id);
        const double pool_errors[] = {std::abs(expected_pool.minimum - actual_pool.minimum),
            std::abs(expected_pool.maximum - actual_pool.maximum), std::abs(expected_pool.mean - actual_pool.mean),
            std::abs(expected_pool.harmonic_mean - actual_pool.harmonic_mean)};
        for (const auto error : pool_errors) {
            result.max_score_error = std::max(result.max_score_error, error);
            if (error > 1e-4) throw std::runtime_error("GPU model pooling parity failed: " + id);
        }
    }
    return result;
}
void write_output(const Options &o, const OracleResult &result, const FeaturePlan &plan,
                  const DeviceInfo &device, const BackendTimings &gpu,
                  const Decoder &ref, const Decoder &dist,
                  double wall_ms, double initialize_ms, double extract_ms,
                  double finish_ms, const Parity &parity,
                  const std::map<std::string, std::string> &model_hashes,
                  const std::string &reference_hash, const std::string &distorted_hash,
                  bool self_contained_mov_inputs, const std::optional<std::string> &decoder_runtime_sha256,
                  const std::optional<std::string> &scoring_runtime_sha256) {
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out << std::setprecision(17);
    rusage usage{};
    if (getrusage(RUSAGE_SELF, &usage)) throw std::runtime_error("Cannot read process resource usage");
    const auto time_ms = [](const timeval &t) { return t.tv_sec * 1000.0 + t.tv_usec / 1000.0; };
    out << "{\"schema\":1,\"implementation\":\"bitovp-owned\",\"officialRevision\":" << quoted(oracle_source_revision)
        << ",\"resourceSnapshotScope\":\"before-result-serialization\""
        << ",\"sourceSha256\":" << quoted(BITOVP_NATIVE_SOURCE_SHA256)
        << ",\"backend\":" << quoted(o.backend) << ",\"frames\":" << result.frame_count
        << ",\"decodeBackend\":" << quoted(o.decode)
        << ",\"width\":" << plan.width << ",\"height\":" << plan.height
        << ",\"bitDepth\":" << plan.bit_depth << ",\"cpuThreads\":" << o.threads
        << ",\"decodeThreads\":" << o.decode_threads
        << ",\"inflightFrames\":" << o.inflight_frames
        << ",\"requestedDeviceIndex\":" << o.device.device_index
        << ",\"referenceSha256\":" << quoted(reference_hash) << ",\"distortedSha256\":" << quoted(distorted_hash);
    if (o.experiment_window)
        out << ",\"referenceDecodeBackend\":\"cpu\",\"experimentWindow\":{\"startFrame\":"
            << o.reference_start_frame << ",\"frameCount\":" << o.frame_count << '}';
    if (self_contained_mov_inputs) out << ",\"selfContainedMovInputs\":true";
    if (decoder_runtime_sha256) out << ",\"decoderRuntimeSha256\":" << quoted(*decoder_runtime_sha256);
    if (scoring_runtime_sha256)
        out << ",\"scoringRuntimeSha256\":" << quoted(*scoring_runtime_sha256);
    if (scoring_runtime_sha256 || (o.experiment_window && device.backend == "cuda"))
        out << ",\"gpuDriver\":{\"driverVersion\":" << quoted(device.driver_version)
            << ",\"driverVersionSource\":" << quoted(device.driver_version_source) << '}';
    out << ",\"distortedOriginal\":{\"width\":" << dist.source_info().width
        << ",\"height\":" << dist.source_info().height << ",\"bitdepth\":" << dist.source_info().bit_depth
        << "},\"device\":{\"index\":" << device.index << ",\"name\":" << quoted(device.name) << ",\"uuid\":" << quoted(device.uuid)
        << ",\"vendorId\":" << device.vendor_id << ",\"deviceId\":" << device.device_id
        << ",\"integrated\":" << (device.integrated ? "true" : "false")
        << ",\"memoryBudgetBytes\":" << device.memory_budget << "},\"timingMs\":{\"wall\":" << wall_ms
        << ",\"initialize\":" << initialize_ms << ",\"decode\":" << ref.decode_ms() + dist.decode_ms()
        << ",\"conform\":" << ref.conform_ms() + dist.conform_ms()
        << ",\"extract\":" << extract_ms << ",\"finish\":" << finish_ms
        << ",\"upload\":" << gpu.upload_ms << ",\"kernel\":" << gpu.kernel_ms
        << ",\"download\":" << gpu.download_ms
        << ",\"cpuPostprocess\":" << gpu.cpu_postprocess_ms
        << ",\"cpuUser\":" << time_ms(usage.ru_utime) << ",\"cpuSystem\":" << time_ms(usage.ru_stime)
        << "},\"extractorKernelMs\":{";
    bool first_timing = true;
    for (const auto &[name, value] : gpu.extractor_kernel_ms) {
        if (!first_timing) out << ',';
        first_timing = false;
        out << quoted(name) << ':' << value;
    }
    out << "},\"memory\":{\"maxRssBytes\":";
#if defined(__APPLE__)
    out << usage.ru_maxrss;
#else
    out << std::uint64_t(usage.ru_maxrss) * 1024;
#endif
    out << ",\"gpuAllocatedBytes\":" << gpu.allocated_bytes
        << ",\"hostCopiedInputBytes\":" << gpu.uploaded_bytes
        << ",\"hostReadbackBytes\":" << gpu.downloaded_bytes
        << ",\"deviceCopyBytes\":" << gpu.device_copied_bytes
        << "},\"cpuParity\":{\"checked\":" << (o.verify ? "true" : "false")
        << ",\"featureCount\":" << parity.features << ",\"scoreCount\":" << parity.scores
        << ",\"maxFeatureError\":" << parity.max_feature_error
        << ",\"maxScoreError\":" << parity.max_score_error << "},\"models\":[";
    bool first = true;
    for (const auto &model : o.models) {
        if (!first) out << ',';
        first = false;
        const auto &p = result.pooled.at(model.id);
        out << "{\"id\":" << quoted(model.id) << ",\"sha256\":" << quoted(model_hashes.at(model.id))
            << ",\"pooled\":{\"min\":" << p.minimum << ",\"max\":" << p.maximum
            << ",\"mean\":" << p.mean << ",\"harmonicMean\":" << p.harmonic_mean
            << "},\"frames\":[";
        bool head = true;
        for (const auto value : result.model_scores.at(model.id)) {
            if (!head) out << ',';
            head = false;
            out << value;
        }
        out << "]}";
    }
    out << "],\"extractors\":[";
    first = true;
    for (const auto &spec : plan.extractors) {
        if (!first) out << ',';
        first = false;
        out << "{\"name\":" << quoted(spec.name) << ",\"options\":{";
        bool head = true;
        for (const auto &[key, value] : spec.options) {
            if (!head) out << ',';
            head = false;
            out << quoted(key) << ':' << quoted(value);
        }
        out << "},\"features\":[";
        head = true;
        for (const auto &name : spec.provided_features) {
            if (!head) out << ',';
            head = false;
            out << quoted(name);
        }
        out << "]}";
    }
    out << "],\"features\":[";
    first = true;
    for (const auto &f : result.features) {
        if (!first) out << ',';
        first = false;
        out << "{\"index\":" << f.index << ",\"name\":" << quoted(f.name) << ",\"value\":" << f.value << '}';
    }
    out << "]}\n";
    const auto temporary = o.output + ".partial." + std::to_string(getpid());
    int descriptor = open(temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (descriptor < 0) throw std::runtime_error("Cannot exclusively create temporary output");
    try {
        const auto data = out.str();
        std::size_t position = 0;
        while (position < data.size()) {
            const auto count = write(descriptor, data.data() + position, data.size() - position);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) throw std::runtime_error("Cannot write comparison output");
            position += std::size_t(count);
        }
        const auto closed = close(descriptor);
        descriptor = -1;
        if (closed) throw std::runtime_error("Cannot close comparison output");
        // An existing result must never be replaced by a concurrent invocation.
        std::filesystem::create_hard_link(temporary, o.output);
        std::filesystem::remove(temporary);
    } catch (...) {
        if (descriptor >= 0) close(descriptor);
        std::filesystem::remove(temporary);
        throw;
    }
}
}

int main(int argc, char **argv) {
    try {
        if (argc >= 2 && std::string(argv[1]) == "--supervise")
            return supervisor::forward(argc, argv, BITOVP_NATIVE_SOURCE_SHA256);
        if (argc == 2 && std::string(argv[1]) == "--version") {
            std::cout << "bitovp-vmaf 0.1 owned CUDA/Vulkan; official=" << oracle_source_revision
                      << "; source=" << BITOVP_NATIVE_SOURCE_SHA256 << '\n';
            return 0;
        }
        if (argc == 2 && std::string(argv[1]) == "--decoder-runtime") {
            const auto runtime = capture_decoder_runtime();
            std::cout << "{\"schemaVersion\":1,\"sourceSha256\":"
                      << quoted(BITOVP_NATIVE_SOURCE_SHA256) << ",\"sha256\":"
                      << (runtime ? quoted(runtime->sha256) : "null") << "}\n";
            return 0;
        }
        if (argc == 2 && std::string(argv[1]) == "--capabilities") {
            std::vector<std::string> backends{"cpu"};
#ifdef BITOVP_HAVE_CUDA
            backends.push_back("cuda");
#endif
#ifdef BITOVP_HAVE_VULKAN
            backends.push_back("vulkan");
#endif
            std::cout << banding_capabilities(BITOVP_NATIVE_SOURCE_SHA256, argv[0], backends) << '\n';
            return 0;
        }
        const auto options = parse(argc, argv);
        const bool experiment_cuda = options.experiment_window && options.backend == "cuda";
        const auto experiment_decoders = experiment_cuda ? load_experiment_cuda_decoders() : ExperimentCudaDecoders{};
        const auto admitted_experiment_runtime = experiment_decoders.codecs.empty()
            ? std::nullopt : capture_decoder_runtime();
        if (options.device_info) {
            const auto runtime = options.attest_decoder_runtime ? capture_decoder_runtime() : std::nullopt;
            const auto backend = make_backend(options);
            std::optional<std::string> binary_hash;
            try {
#if defined(__linux__)
                binary_hash = file_hash("/proc/self/exe");
#else
                binary_hash = file_hash(std::filesystem::canonical(argv[0]).string());
#endif
            } catch (const std::runtime_error &) {
                // Resource identity is still useful, but this executable must
                // not reuse calibration results without a verified binary hash.
            }
            ProcessSupervisorInfo supervision;
#if defined(__linux__)
            const auto companion = supervisor::companion_path();
            if (supervisor::companion_matches(companion, BITOVP_NATIVE_SOURCE_SHA256)) {
                try {
                    supervision.binary_sha256 = file_hash(companion);
                    supervision.available = true;
                } catch (const std::runtime_error &) {}
            }
#endif
            const auto device = backend->device();
            std::optional<std::string> decoder_runtime_sha256, scoring_runtime_sha256;
            if (runtime && attestable_gpu_driver(device)) {
                const auto configured = capture_decoder_runtime();
                if (configured && decoder_runtime_preserved(*runtime, *configured)) {
                    decoder_runtime_sha256 = runtime->sha256;
                    scoring_runtime_sha256 = configured->sha256;
                }
            }
            std::optional<std::vector<std::string>> experiment_codecs;
            if (options.experiment_window) {
                experiment_codecs.emplace();
                if (initialized_experiment_runtime(admitted_experiment_runtime)) {
                    experiment_codecs = experiment_decoders.codecs;
                    decoder_runtime_sha256 = admitted_experiment_runtime->sha256;
                }
            }
            std::cout << protocol::device_info(device, BITOVP_NATIVE_SOURCE_SHA256,
                                               oracle_source_revision, binary_hash, supervision,
                                               decoder_runtime_sha256, scoring_runtime_sha256, experiment_codecs) << '\n';
            return 0;
        }
        if (options.metric == "cambi")
            return run_banding(options, [&] { return make_backend(options); },
                               BITOVP_NATIVE_SOURCE_SHA256, argv[0]);
        const bool resident_decode = options.decode == "cuda";
        const bool experiment = options.experiment_window;
        if (experiment_cuda && !admitted_experiment_runtime)
            throw std::runtime_error("Experiment CUDA decoder runtime could not be attested");
        const bool attest_inputs = options.attest_decoder_runtime && options.inflight_frames == 1 &&
            !resident_decode && !options.max_frames;
        if (experiment) {
            for (const auto *path : {&options.reference, &options.distorted})
                if (!std::filesystem::path(*path).is_absolute() || !std::filesystem::is_regular_file(*path))
                    throw std::invalid_argument("Experiment video inputs require absolute regular local files");
        }
        // Hashes are measured separately: warm file-cache reads are not scoring.
        const auto reference_hash = file_hash(options.reference);
        const auto distorted_hash = file_hash(options.distorted);
        std::map<std::string, std::string> model_hashes;
        auto models = options.models;
        for (auto &model : models) {
            // Both oracles must load the very bytes included in the attested digest.
            auto *snapshot = (attest_inputs || experiment) ? &model.bytes.emplace() : nullptr;
            model_hashes[model.id] = file_hash(model.path, snapshot);
        }
        const auto start = Clock::now();
        const int decode_device = options.device.device_index < 0 ? 0 : options.device.device_index;
        const auto decoder_runtime = attest_inputs ? capture_decoder_runtime() : std::nullopt;
        Decoder reference(options.reference, options.width, options.height, options.bits, options.decode_threads,
                          resident_decode && !experiment, decode_device, attest_inputs, experiment);
        const auto first = reference.source_info();
        const unsigned width = options.width ? options.width : first.width;
        const unsigned height = options.height ? options.height : first.height;
        Decoder distorted(options.distorted, width, height, options.bits, options.decode_threads,
                          resident_decode, decode_device, attest_inputs, experiment);
        const auto second = distorted.source_info();
        const bool self_contained_mov_inputs = first.self_contained_mov && second.self_contained_mov;
        if (!experiment && (!(first.frames_per_second > 0) || !(second.frames_per_second > 0) ||
            std::abs(first.frames_per_second - second.frames_per_second) > 1e-6))
            throw std::runtime_error("Inputs must have the same known frame rate; conform them before comparison");
        // The models score the pictures as libvmaf through FFmpeg does: nothing
        // about the encode before scaling is declared to CAMBI, so a score is
        // the one that `ffmpeg -lavfi libvmaf` gives for the same pictures.
        ModelOracleConfig config{width, height, options.bits, options.threads, true};
        ModelOracle oracle(models, config, options.backend == "cpu" ? OracleMode::Cpu : OracleMode::ImportedFeatures);
        std::unique_ptr<ModelOracle> baseline;
        if (options.verify) baseline = std::make_unique<ModelOracle>(models, config, OracleMode::Cpu);
        std::unique_ptr<Decoder> cpu_reference, cpu_distorted;
        if (options.verify && resident_decode) {
            cpu_reference = std::make_unique<Decoder>(options.reference, width, height, options.bits,
                                                      options.decode_threads, false, 0, false, experiment);
            cpu_distorted = std::make_unique<Decoder>(options.distorted, width, height, options.bits,
                                                      options.decode_threads, false, 0, false, experiment);
        }
        const bool decoder_open_stable = decoder_runtime && self_contained_mov_inputs &&
            same_loader_generation(decoder_runtime->generation);
        const auto create_backend = [&options] { return make_backend(options); };
        std::unique_ptr<FeatureBackend> backend;
        if (options.inflight_frames > 1) {
            PictureStager stager = stage_host_picture;
#ifdef BITOVP_HAVE_CUDA
            if (resident_decode) stager = stage_cuda_picture;
#endif
            backend = std::make_unique<FramePipeline>(create_backend, options.inflight_frames, std::move(stager));
        } else backend = create_backend();
        if (backend) backend->configure(oracle.feature_plan());
        DeviceInfo configured_device;
        std::optional<DecoderRuntime> scoring_runtime;
        if (decoder_open_stable) {
            if (backend) configured_device = backend->device();
            if (!backend || attestable_gpu_driver(configured_device)) {
                auto configured = capture_decoder_runtime();
                if (configured && decoder_runtime_preserved(*decoder_runtime, *configured))
                    scoring_runtime = std::move(*configured);
            }
        }
        const double initialize_ms = elapsed(start);
        double extract_ms = 0;
        std::uint64_t count = 0;
        std::optional<DecoderRuntime> active_experiment_runtime;
        const auto extract = [&](const Picture &ref, const Picture &dist) {
            const auto feature_start = Clock::now();
            if (backend) oracle.import_scores(backend->extract(count, ref, dist));
            else oracle.submit(count, ref, dist);
            extract_ms += elapsed(feature_start);
        };
        const auto consume = [&](const Picture &ref, const Picture &dist, double reference_time, double distorted_time) {
            validate_comparison_timestamps(count, reference_time, distorted_time, first.frames_per_second);
            extract(ref, dist);
            if (cpu_reference) {
                if (!cpu_reference->next() || !cpu_distorted->next() ||
                    std::abs(cpu_reference->timestamp() - reference_time) > 0.25 / first.frames_per_second ||
                    std::abs(cpu_distorted->timestamp() - distorted_time) > 0.25 / first.frames_per_second)
                    throw std::runtime_error("CPU/NVDEC reference frame coverage differs");
                baseline->submit(count, cpu_reference->picture(), cpu_distorted->picture());
            } else if (baseline) baseline->submit(count, ref, dist);
            ++count;
        };
        if (experiment) {
            for (; count < options.frame_count; ++count) {
                read_experiment_pair(reference, distorted, options.reference_start_frame, count);
                extract(reference.picture(), distorted.picture());
                if (cpu_reference) {
                    read_experiment_pair(*cpu_reference, *cpu_distorted, options.reference_start_frame, count);
                    if (cpu_reference->presentation_time().pts != reference.presentation_time().pts ||
                        cpu_distorted->presentation_time().pts != distorted.presentation_time().pts)
                        throw std::runtime_error("CPU/NVDEC experiment presentation timestamps differ");
                    baseline->submit(count, cpu_reference->picture(), cpu_distorted->picture());
                }
                if (experiment_cuda && count == 0) {
                    // The first decode/extraction can initialize CUDA libraries lazily. From
                    // this point until publication both the closure and generation must match.
                    active_experiment_runtime = initialized_experiment_runtime(admitted_experiment_runtime);
                    if (!active_experiment_runtime)
                        throw std::runtime_error("Experiment CUDA decoder runtime changed during initialization");
                }
            }
            const auto end = options.reference_start_frame + options.frame_count;
            validate_experiment_end(reference, distorted, end);
            if (cpu_reference) validate_experiment_end(*cpu_reference, *cpu_distorted, end);
        } else if ((options.backend == "vulkan" || options.backend == "cuda") && !resident_decode) {
            Prefetch<RetainedPair> pictures([&] { return next_retained_pair(reference, distorted); }, options.max_frames);
            for (;;) {
                // This lease dies before next() gives the producer another
                // free slot. The current pair and one following pair suffice.
                auto pair = pictures.next();
                if (!pair) break;
                consume(pair->reference.picture(), pair->distorted.picture(),
                        pair->reference.timestamp(), pair->distorted.timestamp());
            }
            // Decoder timing fields are read only after its sole producer has
            // stopped. Consumer exceptions also stop and join through RAII.
            pictures.stop();
        } else {
            while (!options.max_frames || count < options.max_frames) {
                const bool has_ref = reference.next(), has_dist = distorted.next();
                if (has_ref != has_dist) throw std::runtime_error("Comparison inputs have different frame counts");
                if (!has_ref) break;
                consume(reference.picture(), distorted.picture(), reference.timestamp(), distorted.timestamp());
            }
        }
        if (!count) throw std::runtime_error("Comparison input contains no frames");
        if (!experiment && cpu_reference && !options.max_frames && (cpu_reference->next() || cpu_distorted->next()))
            throw std::runtime_error("CPU/NVDEC reference has additional frames");
        const auto finish_start = Clock::now();
        if (backend) oracle.import_scores(backend->flush());
        const auto result = oracle.finish(count);
        const double finish_ms = elapsed(finish_start);
        Parity parity;
        if (baseline) parity = compare(baseline->finish(count), result);
        const double wall_ms = elapsed(start);
        DeviceInfo device;
        device.backend = "cpu";
        device.name = "official libvmaf CPU";
        if (backend) device = backend->device();
        std::optional<std::string> decoder_runtime_sha256;
        if (experiment_cuda) {
            const auto finalized = capture_decoder_runtime();
            if (!active_experiment_runtime || !finalized ||
                finalized->generation != active_experiment_runtime->generation ||
                finalized->sha256 != active_experiment_runtime->sha256 || !same_loader_generation(finalized->generation))
                throw std::runtime_error("Experiment CUDA decoder runtime changed during scoring");
            decoder_runtime_sha256 = admitted_experiment_runtime->sha256;
        } else if (decoder_runtime && scoring_runtime &&
            same_loader_generation(scoring_runtime->generation) &&
            decoder_runtime_unchanged(*scoring_runtime) &&
            same_loader_generation(scoring_runtime->generation))
            decoder_runtime_sha256 = decoder_runtime->sha256;
        std::optional<std::string> scoring_runtime_sha256;
        if (decoder_runtime_sha256 && scoring_runtime && same_gpu_driver(configured_device, device) &&
            same_loader_generation(scoring_runtime->generation))
            scoring_runtime_sha256 = scoring_runtime->sha256;
        write_output(options, result, oracle.feature_plan(), device,
                     backend ? backend->timings() : BackendTimings{}, reference, distorted,
                     wall_ms, initialize_ms, extract_ms, finish_ms, parity, model_hashes,
                     reference_hash, distorted_hash, self_contained_mov_inputs,
                     decoder_runtime_sha256, scoring_runtime_sha256);
        std::cout << "PASS " << options.backend << ": " << count << " frames, "
                  << options.models.size() << " models, " << wall_ms << " ms";
        if (options.verify) std::cout << ", CPU parity max feature=" << parity.max_feature_error
                                      << " score=" << parity.max_score_error;
        std::cout << '\n';
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "bitovp-vmaf: " << error.what() << '\n';
        return 1;
    }
}
