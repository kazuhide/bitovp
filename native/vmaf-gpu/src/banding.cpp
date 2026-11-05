// SPDX-License-Identifier: MIT
#include "banding.hpp"
#include "decoder.hpp"
#include "device_protocol.hpp"
#include "model_oracle.hpp"
#include "supervisor.hpp"
extern "C" {
#include <libavutil/mem.h>
#include <libavutil/sha.h>
}
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif
#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <fcntl.h>
#include <iomanip>
#include <iostream>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <sys/resource.h>
#include <unistd.h>

namespace bitovp::gpu {
namespace {
using Clock = std::chrono::steady_clock;
using protocol::quoted;
double elapsed(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
std::string hash_file(const std::string &path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) throw std::runtime_error("Cannot open CAMBI identity input");
    std::unique_ptr<AVSHA, decltype(&av_free)> sha(av_sha_alloc(), &av_free);
    if (!sha) throw std::bad_alloc();
    if (av_sha_init(sha.get(), 256)) throw std::runtime_error("Cannot initialize CAMBI SHA-256");
    std::array<char, 65536> bytes{};
    while (input.read(bytes.data(), bytes.size()) || input.gcount())
        av_sha_update(sha.get(), reinterpret_cast<const std::uint8_t *>(bytes.data()), input.gcount());
    if (!input.eof()) throw std::runtime_error("Cannot read CAMBI identity input");
    std::array<std::uint8_t, 32> digest{};
    av_sha_final(sha.get(), digest.data());
    std::ostringstream output;
    for (const auto byte : digest)
        output << std::hex << std::setw(2) << std::setfill('0') << unsigned(byte);
    return output.str();
}
std::string executable_path(const std::string &argument) {
#if defined(__linux__)
    (void)argument;
    return std::filesystem::canonical("/proc/self/exe").string();
#elif defined(__APPLE__)
    (void)argument;
    std::uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    std::vector<char> path(size);
    if (_NSGetExecutablePath(path.data(), &size))
        throw std::runtime_error("Cannot determine CAMBI executable identity");
    return std::filesystem::canonical(path.data()).string();
#else
    return std::filesystem::canonical(argument).string();
#endif
}
struct Identity {
    std::string executable, binary, supervisor_path;
    std::optional<std::string> supervisor;
};
Identity identity(const std::string &source, const std::string &argument) {
    if (!protocol::hex_digest(source, 64))
        throw std::runtime_error("CAMBI requires a recorded implementation source identity");
    Identity value;
    value.executable = executable_path(argument);
    value.binary = hash_file(value.executable);
#if defined(__linux__)
    value.supervisor_path = supervisor::companion_path();
    if (!supervisor::companion_matches(value.supervisor_path, source))
        throw std::runtime_error("CAMBI supervisor identity is missing or mismatched");
    value.supervisor = hash_file(value.supervisor_path);
#endif
    return value;
}
void publish(const std::string &path, const std::string &data) {
    const auto temporary = path + ".partial." + std::to_string(getpid());
    int descriptor = open(temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (descriptor < 0) throw std::runtime_error("Cannot exclusively create CAMBI output");
    try {
        std::size_t offset = 0;
        while (offset < data.size()) {
            const auto count = write(descriptor, data.data() + offset, data.size() - offset);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) throw std::runtime_error("Cannot write CAMBI output");
            offset += std::size_t(count);
        }
        const auto closed = close(descriptor);
        descriptor = -1;
        if (closed) throw std::runtime_error("Cannot close CAMBI output");
        std::filesystem::create_hard_link(temporary, path);
        std::filesystem::remove(temporary);
    } catch (...) {
        if (descriptor >= 0) close(descriptor);
        std::filesystem::remove(temporary);
        throw;
    }
}
struct FrameTime { double time, duration; };
std::vector<double> scores(const OracleResult &result, const ExtractorSpec &extractor,
                           std::size_t count) {
    if (result.frame_count != count || result.features.size() != count ||
        !result.model_scores.empty() || !result.pooled.empty() ||
        extractor.provided_features.size() != 1)
        throw std::runtime_error("Standalone CAMBI feature coverage differs");
    std::vector<double> values(count);
    std::vector<bool> present(count, false);
    for (const auto &feature : result.features) {
        if (feature.name != extractor.provided_features[0] || feature.index >= count ||
            present[feature.index] || !std::isfinite(feature.value) || feature.value < 0)
            throw std::runtime_error("Standalone CAMBI contains invalid or duplicate scores");
        present[feature.index] = true;
        values[feature.index] = feature.value;
    }
    return values;
}
}
std::string banding_capabilities(const std::string &source,
    const std::string &executable, const std::vector<std::string> &backends) {
    const auto own = identity(source, executable);
    std::ostringstream out;
    out << "{\"schemaVersion\":1,\"kind\":\"bitovp-native-capabilities\",\"sourceSha256\":"
        << quoted(source) << ",\"binarySha256\":" << quoted(own.binary)
        << ",\"officialSourceRevision\":" << quoted(oracle_source_revision)
        << ",\"metrics\":[\"VMAF_V1\",\"CAMBI_NR\"],\"backends\":[";
    for (std::size_t i = 0; i < backends.size(); ++i) {
        if (i) out << ',';
        out << quoted(backends[i]);
    }
    out << "],\"bandingReceiptSchemaVersion\":1}";
    return out.str();
}
int run_banding(const cli::Options &options,
    const std::function<std::unique_ptr<FeatureBackend>()> &create_backend,
    const std::string &source, const std::string &executable) {
    const auto own = identity(source, executable);
    const auto input_hash = hash_file(options.distorted);
    const auto start = Clock::now();
    Decoder decoder(options.distorted, 0, 0, 0, options.decode_threads);
    const auto input = decoder.source_info();
    if ((input.width & 1) || (input.height & 1) || input.width < 144 || input.height < 144 ||
        (input.width < 216 && input.height < 216) || input.width > 7680 || input.height > 7680)
        throw std::invalid_argument("Standalone CAMBI input geometry is unsupported");
    const std::vector<FeatureInput> features{{"cambi", {
        {"enc_width", std::to_string(input.width)}, {"enc_height", std::to_string(input.height)},
        {"enc_bitdepth", std::to_string(input.bit_depth)}}}};
    const ModelOracleConfig config{input.width, input.height, input.bit_depth, options.threads, false};
    ModelOracle oracle({}, config, options.backend == "cpu" ? OracleMode::Cpu :
                       OracleMode::ImportedFeatures, features);
    const auto &plan = oracle.feature_plan();
    if (plan.extractors.size() != 1 || plan.extractors[0].name != "cambi")
        throw std::runtime_error("Standalone CAMBI extractor plan differs");
    std::unique_ptr<ModelOracle> baseline;
    if (options.verify) baseline = std::make_unique<ModelOracle>(
        std::vector<ModelInput>{}, config, OracleMode::Cpu, features);
    auto backend = create_backend();
    if ((options.backend == "cpu") == bool(backend))
        throw std::runtime_error("Standalone CAMBI actual backend differs");
    if (backend) {
        backend->configure(plan);
        if (backend->device().backend != options.backend)
            throw std::runtime_error("Standalone CAMBI actual device backend differs");
    }
    const double initialize_ms = elapsed(start);
    double extract_ms = 0, cpu_ms = 0;
    std::vector<FrameTime> times;
    while (decoder.next()) {
        const double time = decoder.timestamp(), duration = decoder.duration();
        if (!std::isfinite(time) || time < 0 || (!times.empty() &&
            (!(time > times.back().time) || time + 1e-9 < times.back().time + times.back().duration)))
            throw std::runtime_error("Standalone CAMBI timestamps are nonmonotone or overlapping");
        if (!std::isfinite(time + duration))
            throw std::runtime_error("Standalone CAMBI timing overflows");
        times.push_back({time, duration});
        const auto index = times.size() - 1;
        const auto picture = decoder.picture();
        const auto feature_start = Clock::now();
        if (backend) oracle.import_scores(backend->extract(index, picture, picture));
        else oracle.submit(index, picture, picture);
        extract_ms += elapsed(feature_start);
        if (baseline) {
            const auto cpu_start = Clock::now();
            baseline->submit(index, picture, picture);
            cpu_ms += elapsed(cpu_start);
        }
    }
    if (times.empty()) throw std::runtime_error("Standalone CAMBI input contains no frames");
    const auto finish_start = Clock::now();
    if (backend) oracle.import_scores(backend->flush());
    const auto raw = scores(oracle.finish(times.size()), plan.extractors[0], times.size());
    auto canonical = raw;
    if (baseline) {
        const auto cpu_start = Clock::now();
        canonical = scores(baseline->finish(times.size()), plan.extractors[0], times.size());
        cpu_ms += elapsed(cpu_start);
    }
    double max_error = 0;
    for (std::size_t i = 0; i < raw.size(); ++i) {
        const double error = std::abs(raw[i] - canonical[i]);
        max_error = std::max(max_error, error);
        if (error > 1e-6 + 1e-7 * std::abs(canonical[i]))
            throw std::runtime_error("Standalone CAMBI GPU parity failed at frame " + std::to_string(i));
    }
    const double finish_ms = elapsed(finish_start);
    if (hash_file(options.distorted) != input_hash || hash_file(own.executable) != own.binary ||
        (own.supervisor && hash_file(own.supervisor_path) != *own.supervisor))
        throw std::runtime_error("Standalone CAMBI input or binary identity changed during analysis");
    const auto gpu = backend ? backend->timings() : BackendTimings{};
    rusage usage{};
    if (getrusage(RUSAGE_SELF, &usage)) throw std::runtime_error("Cannot read CAMBI resource usage");
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out << std::setprecision(17);
    out << "{\"schemaVersion\":1,\"metric\":\"CAMBI_NR\",\"implementation\":\"bitovp-owned\""
        << ",\"officialSourceRevision\":" << quoted(oracle_source_revision)
        << ",\"sourceSha256\":" << quoted(source) << ",\"binarySha256\":" << quoted(own.binary)
        << ",\"supervisorBinarySha256\":";
    if (own.supervisor) out << quoted(*own.supervisor);
    else out << "null";
    out << ",\"backend\":" << quoted(options.backend) << ",\"decodeBackend\":\"cpu\""
        << ",\"cpuThreads\":" << options.threads << ",\"decodeThreads\":" << options.decode_threads
        << ",\"inflightFrames\":1,\"requestedDeviceIndex\":" << options.device.device_index
        << ",\"input\":{\"sha256\":" << quoted(input_hash) << ",\"width\":" << input.width
        << ",\"height\":" << input.height << ",\"bitDepth\":" << input.bit_depth << "}"
        << ",\"extractor\":{\"name\":\"cambi\",\"featureName\":"
        << quoted(plan.extractors[0].provided_features.at(0)) << ",\"options\":{";
    bool first = true;
    for (const auto &[key, value] : plan.extractors[0].options) {
        if (!first) out << ',';
        first = false;
        out << quoted(key) << ':' << quoted(value);
    }
    out << "}},\"device\":";
    if (backend) protocol::write_device(out, backend->device());
    else out << "null";
    out << ",\"coverage\":{\"complete\":true,\"decodedFrames\":" << times.size()
        << ",\"scoredFrames\":" << raw.size() << ",\"startTimeSeconds\":" << times.front().time
        << ",\"endTimeSeconds\":" << times.back().time + times.back().duration
        << ",\"timingSource\":\"PRESENTATION_TIMESTAMPS_AND_FRAME_DURATION\"},\"frames\":[";
    for (std::size_t i = 0; i < times.size(); ++i) {
        if (i) out << ',';
        out << "{\"index\":" << i << ",\"timeSeconds\":" << times[i].time
            << ",\"durationSeconds\":" << times[i].duration << ",\"rawScore\":" << raw[i]
            << ",\"cpuReferenceScore\":" << canonical[i] << '}';
    }
    out << "],\"cpuParity\":{\"checked\":" << (baseline ? "true" : "false")
        << ",\"frameCount\":" << (baseline ? times.size() : 0)
        << ",\"maxAbsoluteError\":" << max_error
        << ",\"absoluteTolerance\":0.000001,\"relativeTolerance\":0.0000001}"
        << ",\"timingMs\":{\"wall\":" << elapsed(start) << ",\"initialize\":" << initialize_ms
        << ",\"decode\":" << decoder.decode_ms() << ",\"conform\":" << decoder.conform_ms()
        << ",\"extract\":" << extract_ms << ",\"cpuReference\":" << cpu_ms
        << ",\"finish\":" << finish_ms << ",\"upload\":" << gpu.upload_ms
        << ",\"kernel\":" << gpu.kernel_ms << ",\"download\":" << gpu.download_ms
        << ",\"cpuPostprocess\":" << gpu.cpu_postprocess_ms << "},\"extractorKernelMs\":{";
    first = true;
    for (const auto &[name, value] : gpu.extractor_kernel_ms) {
        if (!first) out << ',';
        first = false;
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
        << "},\"resourceSnapshotScope\":\"before-result-serialization\"}\n";
    publish(options.output, out.str());
    std::cout << "PASS " << options.backend << " CAMBI: " << times.size() << " frames\n";
    return 0;
}
}
