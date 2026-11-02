// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "decoder.hpp"

#include <cuda_runtime.h>
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/error.h>
#include <libavutil/pixdesc.h>
}

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using bitovp::gpu::Decoder;
using bitovp::gpu::Picture;
using bitovp::gpu::PictureMemory;
using bitovp::gpu::VideoInfo;

namespace {
void require(bool condition, const std::string &message) {
    if (!condition) throw std::runtime_error(message);
}
void check(int code, const char *operation) {
    if (code >= 0) return;
    char text[AV_ERROR_MAX_STRING_SIZE]{};
    av_strerror(code, text, sizeof(text));
    throw std::runtime_error(std::string(operation) + ": " + text);
}
void check_cuda(cudaError_t code, const char *operation) {
    if (code != cudaSuccess)
        throw std::runtime_error(std::string(operation) + ": " + cudaGetErrorString(code));
}

struct PublicDecoder {
    AVFormatContext *format = nullptr;
    AVCodecContext *codec = nullptr;
    AVPacket *packet = nullptr;
    AVFrame *frame = nullptr;
    ~PublicDecoder() {
        av_frame_free(&frame);
        av_packet_free(&packet);
        avcodec_free_context(&codec);
        avformat_close_input(&format);
    }
};

bool supports_cuda(const AVCodec *codec) {
    if (!codec) return false;
    for (int index = 0; const auto *config = avcodec_get_hw_config(codec, index); ++index) {
        if (config->device_type == AV_HWDEVICE_TYPE_CUDA &&
            config->pix_fmt == AV_PIX_FMT_CUDA &&
            (config->methods & AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX)) return true;
    }
    return false;
}

struct SourceEvidence {
    unsigned width = 0, height = 0, bits = 0;
    double fps = 0, first_absolute_time = 0;
    AVCodecID codec_id = AV_CODEC_ID_NONE;
    std::string best_decoder, cuda_candidates;
    bool best_has_cuda = false, full_range = false;
    std::vector<double> timestamps;
};

// This independent public-API decoder supplies the source metadata and PTS
// timeline. The owned CPU/GPU Decoder payloads are compared below, without VMAF.
SourceEvidence inspect_source(const std::string &path) {
    PublicDecoder input;
    check(avformat_open_input(&input.format, path.c_str(), nullptr, nullptr), "probe open input");
    check(avformat_find_stream_info(input.format, nullptr), "probe stream info");
    const AVCodec *best = nullptr;
    const int index = av_find_best_stream(input.format, AVMEDIA_TYPE_VIDEO, -1, -1, &best, 0);
    check(index, "probe best video stream");
    const auto *stream = input.format->streams[index];
    SourceEvidence out;
    out.width = unsigned(stream->codecpar->width);
    out.height = unsigned(stream->codecpar->height);
    out.fps = av_q2d(av_guess_frame_rate(input.format, input.format->streams[index], nullptr));
    out.codec_id = stream->codecpar->codec_id;
    out.best_decoder = best->name;
    out.best_has_cuda = supports_cuda(best);
    void *iterator = nullptr;
    while (const auto *candidate = av_codec_iterate(&iterator)) {
        if (av_codec_is_decoder(candidate) && candidate->id == out.codec_id && supports_cuda(candidate)) {
            if (!out.cuda_candidates.empty()) out.cuda_candidates += ',';
            out.cuda_candidates += candidate->name;
        }
    }
    input.codec = avcodec_alloc_context3(best);
    require(input.codec != nullptr, "probe allocate decoder");
    check(avcodec_parameters_to_context(input.codec, stream->codecpar), "probe configure decoder");
    input.codec->thread_count = 2;
    check(avcodec_open2(input.codec, best, nullptr), "probe open decoder");
    input.packet = av_packet_alloc();
    input.frame = av_frame_alloc();
    require(input.packet && input.frame, "probe allocate packet/frame");
    std::int64_t first_pts = AV_NOPTS_VALUE;
    const auto receive = [&]() {
        for (;;) {
            const int result = avcodec_receive_frame(input.codec, input.frame);
            if (result == AVERROR_EOF || result == AVERROR(EAGAIN)) return;
            check(result, "probe receive frame");
            require(!(input.frame->flags & AV_FRAME_FLAG_CORRUPT), "probe corrupt source frame");
            const auto *description = av_pix_fmt_desc_get(static_cast<AVPixelFormat>(input.frame->format));
            require(description && description->nb_components == 3, "probe unsupported source components");
            const unsigned bits = unsigned(description->comp[0].depth);
            const bool full = input.frame->color_range == AVCOL_RANGE_JPEG;
            require(unsigned(input.frame->width) == out.width && unsigned(input.frame->height) == out.height,
                    "probe source dimensions changed");
            if (out.timestamps.empty()) {
                out.bits = bits;
                out.full_range = full;
            } else require(bits == out.bits && full == out.full_range, "probe source precision/range changed");
            const auto pts = input.frame->best_effort_timestamp;
            require(pts != AV_NOPTS_VALUE, "probe missing presentation timestamp");
            if (first_pts == AV_NOPTS_VALUE) {
                first_pts = pts;
                out.first_absolute_time = double(pts) * av_q2d(stream->time_base);
            }
            const double time = double(pts - first_pts) * av_q2d(stream->time_base);
            require(out.timestamps.empty() || time > out.timestamps.back(), "probe non-increasing PTS");
            out.timestamps.push_back(time);
            require(out.timestamps.size() <= 256, "Qualification fixtures must contain at most 256 frames");
            av_frame_unref(input.frame);
        }
    };
    for (;;) {
        const int result = av_read_frame(input.format, input.packet);
        if (result == AVERROR_EOF) break;
        check(result, "probe read packet");
        if (input.packet->stream_index == index) {
            check(avcodec_send_packet(input.codec, input.packet), "probe send packet");
            receive();
        }
        av_packet_unref(input.packet);
    }
    check(avcodec_send_packet(input.codec, nullptr), "probe flush decoder");
    receive();
    require(!out.timestamps.empty(), "Qualification fixture has no frames");
    return out;
}

void check_source_info(const VideoInfo &actual, const SourceEvidence &source, const char *name) {
    require(actual.width == source.width && actual.height == source.height && actual.bit_depth == source.bits,
            std::string(name) + " source_info must preserve original dimensions and encoded precision");
    require(std::isfinite(actual.frames_per_second) && actual.frames_per_second == source.fps,
            std::string(name) + " source_info frame rate differs from public FFmpeg metadata");
    const auto *codec = avcodec_find_decoder_by_name(actual.codec.c_str());
    require(codec && codec->id == source.codec_id, std::string(name) + " source_info codec is not the input decoder");
}

struct PayloadComparison {
    std::uint64_t samples = 0, mismatches = 0;
    std::array<std::uint64_t, 3> ten_bit_low_samples{};
    unsigned maximum_error = 0;
    std::string first_mismatch;
};

void compare_payload(const Picture &cpu, const Picture &gpu, const SourceEvidence &source,
                     int device, std::size_t frame, PayloadComparison &comparison) {
    require(cpu.memory == PictureMemory::Host && cpu.device_index == -1,
            "CPU decoder did not return a typed Host picture");
    require(gpu.memory == PictureMemory::CudaDevice && gpu.device_index == device,
            "GPU decoder did not return a typed CudaDevice picture on the requested device");
    require(cpu.bit_depth == 10 && gpu.bit_depth == 10, "Comparison output must preserve 10-bit precision");
    for (unsigned plane = 0; plane < 3; ++plane) {
        const auto &a = cpu.planes[plane];
        const auto &b = gpu.planes[plane];
        const unsigned width = plane ? (source.width + 1) / 2 : source.width;
        const unsigned height = plane ? (source.height + 1) / 2 : source.height;
        const std::size_t row_bytes = std::size_t(width) * sizeof(std::uint16_t);
        require(a.data && b.data && a.width == width && b.width == width &&
                a.height == height && b.height == height && a.stride >= row_bytes && b.stride >= row_bytes,
                "CPU/GPU active plane geometry or stride differs from source YUV420 dimensions");
        cudaPointerAttributes attributes{};
        check_cuda(cudaPointerGetAttributes(&attributes, b.data), "inspect resident plane pointer");
        require(attributes.type == cudaMemoryTypeDevice && attributes.device == device &&
                attributes.devicePointer == b.data,
                "Resident plane pointer is not device memory on the requested CUDA device");
        std::vector<std::uint16_t> downloaded(std::size_t(width) * height);
        // D2H exists only in this test: production pixel processing remains resident.
        check_cuda(cudaMemcpy2D(downloaded.data(), row_bytes, b.data, b.stride, row_bytes,
                                height, cudaMemcpyDeviceToHost), "download resident active samples");
        for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
            std::uint16_t expected = 0;
            std::memcpy(&expected, static_cast<const unsigned char *>(a.data) +
                        std::size_t(y) * a.stride + x * sizeof(expected), sizeof(expected));
            const unsigned actual = downloaded[std::size_t(y) * width + x];
            require(expected <= 1023 && actual <= 1023, "Conformed sample exceeds declared 10-bit precision");
            if (source.bits == 8)
                require((expected & 3u) == 0 && (actual & 3u) == 0,
                        "8-to-10-bit conversion must left-shift each decoded sample by two bits");
            else if (expected & 3u) ++comparison.ten_bit_low_samples[plane];
            ++comparison.samples;
            if (expected != actual) {
                ++comparison.mismatches;
                const unsigned error = expected > actual ? expected - actual : actual - expected;
                comparison.maximum_error = std::max(comparison.maximum_error, error);
                if (comparison.first_mismatch.empty()) {
                    std::ostringstream detail;
                    detail << "frame=" << frame << " plane=" << plane << " x=" << x << " y=" << y
                           << " cpu=" << expected << " gpu=" << actual;
                    comparison.first_mismatch = detail.str();
                }
            }
        }
    }
}

struct Fixture {
    const char *name;
    AVCodecID codec;
    unsigned bits;
    bool full_range = false, nonzero_pts = false;
};

void qualify(const std::filesystem::path &directory, const Fixture &fixture, int device) {
    const auto path = (directory / fixture.name).string();
    const auto source = inspect_source(path);
    require(source.codec_id == fixture.codec && source.bits == fixture.bits, "Fixture codec/precision is unexpected");
    require(!fixture.full_range || source.full_range, "Full-range fixture is not tagged full-range");
    require(!fixture.nonzero_pts || source.first_absolute_time > 0, "Nonzero-PTS fixture starts at zero");
    std::cout << "SOURCE " << fixture.name << " codec=" << source.best_decoder
              << " best_cuda_hw_config=" << source.best_has_cuda
              << " cuda_candidates=" << source.cuda_candidates << " dimensions=" << source.width << 'x'
              << source.height << " bits=" << source.bits << " full_range=" << source.full_range
              << " first_source_pts_seconds=" << source.first_absolute_time
              << " frames=" << source.timestamps.size() << std::endl;
    Decoder cpu(path, 0, 0, 10, 2, false, device);
    Decoder gpu(path, 0, 0, 10, 2, true, device);
    const auto cpu_info = cpu.source_info(), gpu_info = gpu.source_info();
    check_source_info(cpu_info, source, "CPU");
    check_source_info(gpu_info, source, "GPU");
    require(cpu_info.codec == source.best_decoder, "CPU decoding must retain FFmpeg's selected software decoder");
    std::cout << "SELECTED " << fixture.name << " cpu=" << cpu_info.codec << " cuda=" << gpu_info.codec
              << " selected_cuda_hw_config=" << supports_cuda(avcodec_find_decoder_by_name(gpu_info.codec.c_str()))
              << std::endl;
    require(supports_cuda(avcodec_find_decoder_by_name(gpu_info.codec.c_str())),
            "GPU source_info does not identify a CUDA-capable decoder");
    PayloadComparison comparison;
    std::size_t frames = 0;
    double previous_time = -1;
    for (;;) {
        const bool has_cpu = cpu.next(), has_gpu = gpu.next();
        require(has_cpu == has_gpu, "CPU/GPU frame count differs at EOF/decoder flush");
        if (!has_cpu) break;
        require(frames < source.timestamps.size(), "Owned decoder emitted more frames than public FFmpeg decoder");
        const double time = cpu.timestamp(), gpu_time = gpu.timestamp();
        require(std::isfinite(time) && std::isfinite(gpu_time) && time == gpu_time &&
                time == source.timestamps[frames], "CPU/GPU/public decoder PTS differs");
        require((frames == 0 && time == 0) || (frames > 0 && time > previous_time),
                "Relative presentation timestamps must start at zero and increase");
        previous_time = time;
        compare_payload(cpu.picture(), gpu.picture(), source, device, frames, comparison);
        ++frames;
    }
    require(frames == source.timestamps.size(), "Owned decoder dropped delayed source frames at EOF");
    if (source.bits == 10)
        for (unsigned plane = 0; plane < 3; ++plane)
            require(comparison.ten_bit_low_samples[plane] > 0,
                    "10-bit fixture must exercise nonzero low bits on every Y/U/V plane");
    require(comparison.mismatches == 0,
            "Pixel payload differs: samples=" + std::to_string(comparison.samples) +
            " mismatches=" + std::to_string(comparison.mismatches) +
            " max_error=" + std::to_string(comparison.maximum_error) + ' ' + comparison.first_mismatch);
    std::cout << "PASS " << fixture.name << " frames=" << frames << " samples=" << comparison.samples
              << " mismatches=0 max_error=0 actual_device=" << device << " output_bits=10"
              << " nonzero_low_bits=" << comparison.ten_bit_low_samples[0] << ','
              << comparison.ten_bit_low_samples[1] << ',' << comparison.ten_bit_low_samples[2]
              << " cpu_decode_ms=" << cpu.decode_ms() << " gpu_decode_ms=" << gpu.decode_ms() << '\n';
}

void qualify_geometry_constraints(const std::filesystem::path &directory, int device) {
    const auto eight_bit = (directory / "h264-8.mkv").string();
    const auto source = inspect_source(eight_bit);
    const unsigned width = source.width / 2, height = source.height / 2;
    Decoder cpu(eight_bit, width, height, 10, 2, false, device);
    require(cpu.next(), "CPU geometry fixture has no frame");
    check_source_info(cpu.source_info(), source, "CPU resized");
    const auto resized = cpu.picture();
    require(resized.memory == PictureMemory::Host && resized.planes[0].width == width &&
            resized.planes[0].height == height, "CPU-only preprocessing lost its existing resize support");
    bool rejected = false;
    try { Decoder gpu(eight_bit, width, height, 10, 2, true, device); }
    catch (const std::invalid_argument &) { rejected = true; }
    require(rejected, "Resident CUDA decoding must explicitly reject changed input dimensions");
    rejected = false;
    try { Decoder gpu((directory / "hevc-10.mkv").string(), 0, 0, 8, 2, true, device); }
    catch (const std::invalid_argument &) { rejected = true; }
    require(rejected, "Resident CUDA decoding must explicitly reject source precision loss");
    std::cout << "PASS constraints CPU resize remains available; resident resize and 10-to-8-bit loss rejected\n";
}
}

int main(int argc, char **argv) {
    if (argc < 2 || argc > 3) {
        std::cerr << "Usage: cuda_decoder_test <fixture-directory> [cuda-device-index]\n";
        return 2;
    }
    int device = 0;
    try {
        if (argc == 3) {
            std::size_t parsed = 0;
            device = std::stoi(argv[2], &parsed);
            require(parsed == std::strlen(argv[2]) && device >= 0, "CUDA device index must be nonnegative");
        }
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 2;
    }
    const std::array<Fixture, 9> fixtures{{
        {"h264-8.mkv", AV_CODEC_ID_H264, 8}, {"hevc-8.mkv", AV_CODEC_ID_HEVC, 8},
        {"hevc-10.mkv", AV_CODEC_ID_HEVC, 10}, {"vp9-8.mkv", AV_CODEC_ID_VP9, 8},
        {"vp9-10.mkv", AV_CODEC_ID_VP9, 10}, {"av1-8.mkv", AV_CODEC_ID_AV1, 8},
        {"av1-10.mkv", AV_CODEC_ID_AV1, 10}, {"h264-full-range.mkv", AV_CODEC_ID_H264, 8, true},
        {"nonzero-pts.mkv", AV_CODEC_ID_H264, 8, false, true}
    }};
    std::cout << std::setprecision(17);
    unsigned failures = 0;
    for (const auto &fixture : fixtures) {
        try { qualify(argv[1], fixture, device); }
        catch (const std::exception &error) {
            ++failures;
            std::cerr << "FAIL " << fixture.name << ": " << error.what() << std::endl;
        }
    }
    try { qualify_geometry_constraints(argv[1], device); }
    catch (const std::exception &error) {
        ++failures;
        std::cerr << "FAIL constraints: " << error.what() << std::endl;
    }
    std::cout << "CUDA decoder payload qualification: " << fixtures.size() + 1 - failures << '/'
              << fixtures.size() + 1 << " PASS (9 payload fixtures plus constraints)\n";
    return failures ? 1 : 0;
}
