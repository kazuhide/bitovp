// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "decoder.hpp"
#include "decoder_pair.hpp"
#include "prefetch.hpp"
#include "model_oracle.hpp"
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
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/resource.h>
#include <unistd.h>

#ifndef BITOVP_NATIVE_SOURCE_SHA256
#define BITOVP_NATIVE_SOURCE_SHA256 "unrecorded"
#endif

using namespace bitovp::gpu;
namespace {
using Clock = std::chrono::steady_clock;
double elapsed(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
std::string quoted(const std::string &s) {
    std::ostringstream out;
    out << '"';
    for (const unsigned char c : s) {
        if (c == '"' || c == '\\') out << '\\' << c;
        else if (c < 0x20) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << unsigned(c);
        else out << c;
    }
    out << '"';
    return out.str();
}
std::string file_hash(const std::string &path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error("Cannot open file for SHA-256");
    std::unique_ptr<AVSHA, decltype(&av_free)> state(av_sha_alloc(), &av_free);
    if (!state) throw std::bad_alloc();
    if (av_sha_init(state.get(), 256)) throw std::runtime_error("Cannot initialize SHA-256");
    std::array<char, 1 << 16> buffer{};
    while (in.read(buffer.data(), buffer.size()) || in.gcount())
        av_sha_update(state.get(), reinterpret_cast<const std::uint8_t *>(buffer.data()), in.gcount());
    if (!in.eof()) throw std::runtime_error("Cannot read file for SHA-256");
    std::array<std::uint8_t, 32> digest{};
    av_sha_final(state.get(), digest.data());
    std::ostringstream out;
    for (auto b : digest) out << std::hex << std::setw(2) << std::setfill('0') << unsigned(b);
    return out.str();
}
unsigned integer(const std::string &value, const std::string &key, unsigned maximum) {
    if (value.empty() || value.find_first_not_of("0123456789") != std::string::npos)
        throw std::invalid_argument(key + " requires an unsigned integer");
    std::size_t used = 0;
    const auto result = std::stoull(value, &used);
    if (used != value.size() || result > maximum) throw std::invalid_argument(key + " exceeds its supported limit");
    return unsigned(result);
}
struct Options {
    std::string reference, distorted, output, backend = "cpu", decode = "cpu";
    std::vector<ModelInput> models;
    unsigned width = 0, height = 0, bits = 8, threads = 1, decode_threads = 1, max_frames = 0;
    BackendOptions device;
    bool verify = false;
};
Options parse(int argc, char **argv) {
    Options out;
    std::set<std::string> used, model_ids;
    for (int i = 1; i < argc; ++i) {
        const std::string key = argv[i];
        if (key == "--profile") {
            if (out.device.profile) throw std::invalid_argument("Duplicate --profile");
            out.device.profile = true;
            continue;
        }
        if (key == "--verify-cpu") {
            if (out.verify) throw std::invalid_argument("Duplicate --verify-cpu");
            out.verify = true;
            continue;
        }
        if (i + 1 >= argc) throw std::invalid_argument("Missing value for " + key);
        const std::string value = argv[++i];
        if (key != "--model" && !used.insert(key).second) throw std::invalid_argument("Duplicate option " + key);
        if (key == "--reference") out.reference = value;
        else if (key == "--distorted") out.distorted = value;
        else if (key == "--output") out.output = value;
        else if (key == "--backend") out.backend = value;
        else if (key == "--decode") out.decode = value;
        else if (key == "--width") out.width = integer(value, key, 16384);
        else if (key == "--height") out.height = integer(value, key, 16384);
        else if (key == "--bit-depth") out.bits = integer(value, key, 10);
        else if (key == "--threads") out.threads = integer(value, key, 256);
        else if (key == "--decode-threads") out.decode_threads = integer(value, key, 256);
        else if (key == "--max-frames") out.max_frames = integer(value, key, 10000000);
        else if (key == "--device") out.device.device_index = int(integer(value, key, 256));
        else if (key == "--vendor") {
            if (value == "amd") out.device.vendor_id = 0x1002;
            else if (value == "nvidia") out.device.vendor_id = 0x10de;
            else throw std::invalid_argument("--vendor must be amd or nvidia");
        } else if (key == "--model") {
            const auto eq = value.find('=');
            if (eq == std::string::npos || eq == 0 || eq + 1 == value.size())
                throw std::invalid_argument("--model requires id=path");
            const auto id = value.substr(0, eq);
            if (!model_ids.insert(id).second) throw std::invalid_argument("Duplicate model id");
            out.models.push_back({id, value.substr(eq + 1), {}});
        } else throw std::invalid_argument("Unknown option " + key);
    }
    if (out.reference.empty() || out.distorted.empty() || out.output.empty() || out.models.empty())
        throw std::invalid_argument("Required: --reference path --distorted path --model id=path --output path");
    if (out.backend != "cpu" && out.backend != "cuda" && out.backend != "vulkan")
        throw std::invalid_argument("--backend must be cpu, cuda, or vulkan");
    if (out.decode != "cpu" && out.decode != "cuda") throw std::invalid_argument("--decode must be cpu or cuda");
    if (out.decode == "cuda" && out.backend != "cuda")
        throw std::invalid_argument("Resident CUDA decoding requires CUDA feature extraction");
    if ((out.width == 0) != (out.height == 0)) throw std::invalid_argument("Set width and height together");
    if (out.bits != 8 && out.bits != 10) throw std::invalid_argument("--bit-depth must be 8 or 10");
    if (out.backend == "cpu" && (out.verify || out.device.device_index >= 0 || out.device.vendor_id))
        throw std::invalid_argument("GPU options cannot be used with CPU scoring");
    if (std::filesystem::exists(out.output)) throw std::invalid_argument("Output already exists");
    return out;
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
                  const std::string &reference_hash, const std::string &distorted_hash) {
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
        << ",\"requestedDeviceIndex\":" << o.device.device_index
        << ",\"referenceSha256\":" << quoted(reference_hash) << ",\"distortedSha256\":" << quoted(distorted_hash)
        << ",\"distortedOriginal\":{\"width\":" << dist.source_info().width
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
        if (argc == 2 && std::string(argv[1]) == "--version") {
            std::cout << "bitovp-vmaf 0.1 owned CUDA/Vulkan; official=" << oracle_source_revision
                      << "; source=" << BITOVP_NATIVE_SOURCE_SHA256 << '\n';
            return 0;
        }
        const auto options = parse(argc, argv);
        // Hashes are measured separately: warm file-cache reads are not scoring.
        const auto reference_hash = file_hash(options.reference);
        const auto distorted_hash = file_hash(options.distorted);
        std::map<std::string, std::string> model_hashes;
        auto models = options.models;
        for (const auto &model : models) model_hashes[model.id] = file_hash(model.path);
        const auto start = Clock::now();
        const bool resident_decode = options.decode == "cuda";
        const int decode_device = options.device.device_index < 0 ? 0 : options.device.device_index;
        Decoder reference(options.reference, options.width, options.height, options.bits, options.decode_threads,
                          resident_decode, decode_device);
        const auto first = reference.source_info();
        const unsigned width = options.width ? options.width : first.width;
        const unsigned height = options.height ? options.height : first.height;
        Decoder distorted(options.distorted, width, height, options.bits, options.decode_threads,
                          resident_decode, decode_device);
        const auto second = distorted.source_info();
        if (!(first.frames_per_second > 0) || !(second.frames_per_second > 0) ||
            std::abs(first.frames_per_second - second.frames_per_second) > 1e-6)
            throw std::runtime_error("Inputs must have the same known frame rate; conform them before comparison");
        for (auto &model : models) {
            model.feature_overrides["cambi"]["enc_width"] = std::to_string(second.width);
            model.feature_overrides["cambi"]["enc_height"] = std::to_string(second.height);
            model.feature_overrides["cambi"]["enc_bitdepth"] = std::to_string(second.bit_depth);
        }
        ModelOracleConfig config{width, height, options.bits, options.threads, true};
        ModelOracle oracle(models, config, options.backend == "cpu" ? OracleMode::Cpu : OracleMode::ImportedFeatures);
        std::unique_ptr<ModelOracle> baseline;
        if (options.verify) baseline = std::make_unique<ModelOracle>(models, config, OracleMode::Cpu);
        std::unique_ptr<Decoder> cpu_reference, cpu_distorted;
        if (options.verify && resident_decode) {
            cpu_reference = std::make_unique<Decoder>(options.reference, width, height, options.bits, options.decode_threads);
            cpu_distorted = std::make_unique<Decoder>(options.distorted, width, height, options.bits, options.decode_threads);
        }
        std::unique_ptr<FeatureBackend> backend;
        if (options.backend == "cuda") {
#ifdef BITOVP_HAVE_CUDA
            backend = create_cuda_backend(options.device);
#else
            throw std::runtime_error("This binary was built without CUDA");
#endif
        }
        if (options.backend == "vulkan") {
#ifdef BITOVP_HAVE_VULKAN
            backend = create_vulkan_backend(options.device);
#else
            throw std::runtime_error("This binary was built without Vulkan");
#endif
        }
        if (backend) backend->configure(oracle.feature_plan());
        const double initialize_ms = elapsed(start);
        double extract_ms = 0;
        std::uint64_t count = 0;
        const auto consume = [&](const Picture &ref, const Picture &dist, double reference_time, double distorted_time) {
            validate_comparison_timestamps(reference_time, distorted_time, first.frames_per_second);
            const auto feature_start = Clock::now();
            if (backend) oracle.import_scores(backend->extract(count, ref, dist));
            else oracle.submit(count, ref, dist);
            extract_ms += elapsed(feature_start);
            if (cpu_reference) {
                if (!cpu_reference->next() || !cpu_distorted->next() ||
                    std::abs(cpu_reference->timestamp() - reference_time) > 0.25 / first.frames_per_second ||
                    std::abs(cpu_distorted->timestamp() - distorted_time) > 0.25 / first.frames_per_second)
                    throw std::runtime_error("CPU/NVDEC reference frame coverage differs");
                baseline->submit(count, cpu_reference->picture(), cpu_distorted->picture());
            } else if (baseline) baseline->submit(count, ref, dist);
            ++count;
        };
        if (options.backend == "vulkan" && !resident_decode) {
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
        if (cpu_reference && !options.max_frames && (cpu_reference->next() || cpu_distorted->next()))
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
        write_output(options, result, oracle.feature_plan(), device,
                     backend ? backend->timings() : BackendTimings{}, reference, distorted,
                     wall_ms, initialize_ms, extract_ms, finish_ms, parity, model_hashes,
                     reference_hash, distorted_hash);
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
