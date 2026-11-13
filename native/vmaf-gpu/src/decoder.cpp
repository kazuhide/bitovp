// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kazuhide Yamamoto
#include "decoder.hpp"
#ifdef BITOVP_HAVE_CUDA
#include "cuda/frame_conformer.hpp"
#include <cuda.h>
#endif

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/error.h>
#include <libavutil/imgutils.h>
#include <libavutil/hwcontext.h>
#include <libavutil/pixdesc.h>
#ifdef BITOVP_HAVE_CUDA
#include <libavutil/hwcontext_cuda.h>
#endif
#include <libswscale/swscale.h>
}
#include <chrono>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace bitovp::gpu {
namespace {
using Clock = std::chrono::steady_clock;
double ms(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
void check(int result, const char *operation) {
    if (result >= 0) return;
    char text[AV_ERROR_MAX_STRING_SIZE]{};
    av_strerror(result, text, sizeof(text));
    throw std::runtime_error(std::string(operation) + ": " + text);
}
// A decoder names a full-range picture by a "J" format (H.264, MJPEG) or by
// the plain format and the frame's range (AV1, FFV1). swscale chooses its
// conversion when a context is created, and it takes a "J" source for full
// range against a limited-range target: it then keeps its general scaler for a
// picture that is not scaled. FFmpeg's scale filter names the range of both
// sides first, and swscale copies such a picture plane by plane, widening
// full-range luma from 8 bits by repeating its top bits. The context is
// therefore created for the plain format, and the range is set apart, so that
// a picture is converted as that filter converts it, by either of its names.
AVPixelFormat without_range(AVPixelFormat format) {
    switch (format) {
    case AV_PIX_FMT_YUVJ420P: return AV_PIX_FMT_YUV420P;
    case AV_PIX_FMT_YUVJ422P: return AV_PIX_FMT_YUV422P;
    case AV_PIX_FMT_YUVJ444P: return AV_PIX_FMT_YUV444P;
    case AV_PIX_FMT_YUVJ440P: return AV_PIX_FMT_YUV440P;
    case AV_PIX_FMT_YUVJ411P: return AV_PIX_FMT_YUV411P;
    default: return format;
    }
}

bool unsupported_banding_color(AVColorTransferCharacteristic transfer,
                              AVColorPrimaries primaries, AVColorSpace space) {
    return transfer == AVCOL_TRC_SMPTE2084 || transfer == AVCOL_TRC_ARIB_STD_B67 ||
           transfer == AVCOL_TRC_SMPTE428 || primaries == AVCOL_PRI_BT2020 ||
           space == AVCOL_SPC_BT2020_NCL || space == AVCOL_SPC_BT2020_CL;
}
}

struct Decoder::Impl {
    AVFormatContext *format = nullptr;
    AVCodecContext *codec = nullptr;
    AVPacket *packet = nullptr;
    AVFrame *frame = nullptr, *conformed = nullptr, *spare_conformed = nullptr;
    bool retention_enabled = false;
    SwsContext *scale = nullptr;
    AVBufferRef *hardware = nullptr;
    bool cuda_decode = false;
    bool standalone_input = false;
    int device_index = 0;
    Picture resident;
#ifdef BITOVP_HAVE_CUDA
    std::unique_ptr<CudaFrameConformer> cuda_conformer;
#endif
    int stream = -1;
    bool demux_eof = false, flush_sent = false, has_picture = false;
    unsigned width, height, bits;
    VideoInfo info;
    std::int64_t first_pts = AV_NOPTS_VALUE, current_pts = AV_NOPTS_VALUE;
    double decoded_ms = 0, conformed_ms = 0;

    Impl(const std::string &path, unsigned w, unsigned h, unsigned b, unsigned threads, bool cuda, int device)
        : cuda_decode(cuda), standalone_input(b == 0), device_index(device), width(w), height(h), bits(b) {
        if (b != 0 && b != 8 && b != 10) throw std::invalid_argument("Decode bit depth must be 8 or 10");
        if (threads > 256) throw std::invalid_argument("Decode thread count exceeds 256");
        try {
            check(avformat_open_input(&format, path.c_str(), nullptr, nullptr), "open video");
            check(avformat_find_stream_info(format, nullptr), "read video streams");
            const AVCodec *decoder = nullptr;
            stream = av_find_best_stream(format, AVMEDIA_TYPE_VIDEO, -1, -1, &decoder, 0);
            check(stream, "find video stream");
            auto *video = format->streams[stream];
            if (standalone_input) {
                unsigned videos = 0;
                for (unsigned i = 0; i < format->nb_streams; ++i)
                    videos += format->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO;
                if (videos != 1)
                    throw std::invalid_argument("Standalone CAMBI requires exactly one video stream");
                const auto sar = av_guess_sample_aspect_ratio(format, video, nullptr);
                if (sar.num > 0 && sar.den > 0 && sar.num != sar.den)
                    throw std::invalid_argument("Standalone CAMBI requires square-pixel input");
                const auto *parameters = video->codecpar;
                if (unsupported_banding_color(parameters->color_trc, parameters->color_primaries,
                                              parameters->color_space))
                    throw std::invalid_argument("Standalone CAMBI supports SDR input only");
                if ((parameters->format != AV_PIX_FMT_YUV420P &&
                     parameters->format != AV_PIX_FMT_YUV420P10LE) ||
                    parameters->color_range == AVCOL_RANGE_JPEG)
                    throw std::invalid_argument("Standalone CAMBI requires limited-range planar 4:2:0 input");
                if (const auto *rotation = av_dict_get(video->metadata, "rotate", nullptr, 0);
                    rotation && std::string(rotation->value) != "0")
                    throw std::invalid_argument("Standalone CAMBI presentation transforms are unsupported");
#if LIBAVCODEC_VERSION_INT >= AV_VERSION_INT(60, 31, 102)
                if (av_packet_side_data_get(parameters->coded_side_data, parameters->nb_coded_side_data,
                                            AV_PKT_DATA_DISPLAYMATRIX))
#else
                std::size_t matrix_size = 0;
                if (av_stream_get_side_data(video, AV_PKT_DATA_DISPLAYMATRIX, &matrix_size))
#endif
                    throw std::invalid_argument("Standalone CAMBI presentation transforms are unsupported");
            }
            if (cuda_decode) {
#ifdef BITOVP_HAVE_CUDA
                const auto supports_cuda = [](const AVCodec *candidate) {
                    for (int i = 0;; ++i) {
                        const auto *config = avcodec_get_hw_config(candidate, i);
                        if (!config) return false;
                        if (config->device_type == AV_HWDEVICE_TYPE_CUDA && config->pix_fmt == AV_PIX_FMT_CUDA &&
                            (config->methods & AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX)) return true;
                    }
                };
                if (!supports_cuda(decoder)) {
                    decoder = nullptr;
                    void *iterator = nullptr;
                    while (const auto *candidate = av_codec_iterate(&iterator)) {
                        if (av_codec_is_decoder(candidate) && candidate->id == video->codecpar->codec_id && supports_cuda(candidate)) {
                            decoder = candidate;
                            break;
                        }
                    }
                    if (!decoder) throw std::runtime_error("No CUDA-capable decoder is available for this codec");
                }
#else
                throw std::invalid_argument("This binary was built without resident CUDA decoding");
#endif
            }
            if (video->codecpar->width <= 0 || video->codecpar->height <= 0)
                throw std::runtime_error("Video dimensions are unknown");
            info.width = unsigned(video->codecpar->width);
            info.height = unsigned(video->codecpar->height);
            const auto *descriptor = av_pix_fmt_desc_get(static_cast<AVPixelFormat>(video->codecpar->format));
            if (descriptor && descriptor->nb_components)
                info.bit_depth = unsigned(descriptor->comp[0].depth);
            else if (video->codecpar->bits_per_raw_sample > 0)
                info.bit_depth = unsigned(video->codecpar->bits_per_raw_sample);
            if (!info.bit_depth || info.bit_depth > 16)
                throw std::runtime_error("Cannot determine original encoded bit depth");
            // Zero is reserved for the standalone metric path: preserve the
            // encoded precision instead of silently quantizing it to a default.
            if (!bits) {
                if (info.bit_depth != 8 && info.bit_depth != 10)
                    throw std::invalid_argument("Standalone CAMBI supports original 8/10-bit input only");
                bits = info.bit_depth;
            }
            info.frames_per_second = av_q2d(av_guess_frame_rate(format, video, nullptr));
            info.codec = decoder->name;
            if (!width) width = info.width;
            if (!height) height = info.height;
            if (!width || !height || width > 16384 || height > 16384)
                throw std::invalid_argument("Decode dimensions exceed the supported limit");
            codec = avcodec_alloc_context3(decoder);
            if (!codec) throw std::bad_alloc();
            check(avcodec_parameters_to_context(codec, video->codecpar), "configure decoder");
            codec->thread_count = int(threads);
            if (cuda_decode) {
#ifdef BITOVP_HAVE_CUDA
                if (width != info.width || height != info.height)
                    throw std::invalid_argument("Resident CUDA decoding currently requires unchanged input dimensions");
                if (device < 0 || (info.bit_depth != 8 && info.bit_depth != 10) || info.bit_depth > bits)
                    throw std::invalid_argument("Resident CUDA decoding requires supported 8/10-bit input without precision loss");
                check(av_hwdevice_ctx_create(&hardware, AV_HWDEVICE_TYPE_CUDA,
                    std::to_string(device).c_str(), nullptr, AV_CUDA_USE_PRIMARY_CONTEXT), "create primary CUDA decoder context");
                codec->hw_device_ctx = av_buffer_ref(hardware);
                if (!codec->hw_device_ctx) throw std::bad_alloc();
                codec->get_format = [](AVCodecContext *, const AVPixelFormat *formats) -> AVPixelFormat {
                    for (const auto *format = formats; *format != AV_PIX_FMT_NONE; ++format)
                        if (*format == AV_PIX_FMT_CUDA) return *format;
                    return AV_PIX_FMT_NONE;
                };
                cuda_conformer = std::make_unique<CudaFrameConformer>(width, height, bits, device);
#else
                throw std::invalid_argument("This binary was built without resident CUDA decoding");
#endif
            }
            check(avcodec_open2(codec, decoder, nullptr), "open decoder");
            packet = av_packet_alloc();
            frame = av_frame_alloc();
            conformed = av_frame_alloc();
            if (!packet || !frame || !conformed) throw std::bad_alloc();
            conformed->format = bits == 8 ? AV_PIX_FMT_YUV420P : AV_PIX_FMT_YUV420P10LE;
            conformed->width = int(width);
            conformed->height = int(height);
            if (!cuda_decode) check(av_frame_get_buffer(conformed, 64), "allocate comparison frame");
        } catch (...) { close(); throw; }
    }
    ~Impl() { close(); }
    void close() {
#ifdef BITOVP_HAVE_CUDA
        cuda_conformer.reset();
#endif
        sws_freeContext(scale);
        av_frame_free(&frame);
        av_frame_free(&conformed);
        av_frame_free(&spare_conformed);
        av_packet_free(&packet);
        avcodec_free_context(&codec);
        avformat_close_input(&format);
        av_buffer_unref(&hardware);
    }
    void select_cpu_output() {
        if (av_frame_is_writable(conformed)) return;
        if (!spare_conformed) {
            AVFrame *spare = av_frame_alloc();
            if (!spare) throw std::bad_alloc();
            spare->format = conformed->format;
            spare->width = int(width); spare->height = int(height);
            const int allocated = av_frame_get_buffer(spare, 64);
            if (allocated < 0) { av_frame_free(&spare); check(allocated, "allocate retained comparison frame"); }
            spare_conformed = spare;
        }
        if (!av_frame_is_writable(spare_conformed))
            throw std::logic_error("Release a retained comparison picture before decoding another frame");
        // Reuse an unleased surface instead of av_frame_make_writable copying
        // the previous picture that sws_scale is about to overwrite completely.
        std::swap(conformed, spare_conformed);
    }
    bool next() {
        has_picture = false;
        if (retention_enabled) {
            const auto select_start = Clock::now();
            // Check the two-slot bound before consuming another encoded frame.
            select_cpu_output();
            conformed_ms += ms(select_start);
        }
        av_frame_unref(frame);
        const auto start = Clock::now();
        for (;;) {
            const int received = avcodec_receive_frame(codec, frame);
            if (received == 0) break;
            if (received == AVERROR_EOF) { decoded_ms += ms(start); return false; }
            if (received != AVERROR(EAGAIN)) check(received, "decode frame");
            if (demux_eof) {
                if (flush_sent) throw std::runtime_error("Decoder stalled after end of input");
                check(avcodec_send_packet(codec, nullptr), "flush decoder");
                flush_sent = true;
                continue;
            }
            for (;;) {
                const int read = av_read_frame(format, packet);
                if (read == AVERROR_EOF) { demux_eof = true; break; }
                check(read, "read video packet");
                if (packet->stream_index != stream) { av_packet_unref(packet); continue; }
                const int sent = avcodec_send_packet(codec, packet);
                av_packet_unref(packet);
                check(sent, "submit video packet");
                break;
            }
        }
        decoded_ms += ms(start);
        if (frame->flags & AV_FRAME_FLAG_CORRUPT)
            throw std::runtime_error("Refusing to compare a corrupt decoded frame");
        auto actual_format = static_cast<AVPixelFormat>(frame->format);
        if (cuda_decode) {
            if (actual_format != AV_PIX_FMT_CUDA || !frame->hw_frames_ctx)
                throw std::runtime_error("CUDA decoder returned a nonresident picture");
            actual_format = static_cast<AVHWFramesContext *>(static_cast<void *>(frame->hw_frames_ctx->data))->sw_format;
        }
        const auto *descriptor = av_pix_fmt_desc_get(actual_format);
        if (frame->width != int(info.width) || frame->height != int(info.height) || !descriptor ||
            unsigned(descriptor->comp[0].depth) != info.bit_depth)
            throw std::runtime_error("Mid-stream video format changes are not supported");
        if (standalone_input && (unsupported_banding_color(frame->color_trc, frame->color_primaries,
                frame->colorspace) || frame->crop_top || frame->crop_bottom || frame->crop_left ||
                frame->crop_right || av_frame_get_side_data(frame, AV_FRAME_DATA_DISPLAYMATRIX) ||
                (actual_format != AV_PIX_FMT_YUV420P && actual_format != AV_PIX_FMT_YUV420P10LE) ||
                frame->color_range == AVCOL_RANGE_JPEG ||
                (frame->sample_aspect_ratio.num > 0 && frame->sample_aspect_ratio.den > 0 &&
                 frame->sample_aspect_ratio.num != frame->sample_aspect_ratio.den)))
            throw std::runtime_error("Standalone CAMBI decoded presentation or color is unsupported");
        current_pts = frame->best_effort_timestamp;
        if (current_pts == AV_NOPTS_VALUE)
            throw std::runtime_error("Comparison input has no presentation timestamps");
        if (first_pts == AV_NOPTS_VALUE) first_pts = current_pts;
        const auto conform_start = Clock::now();
        if (cuda_decode) {
#ifdef BITOVP_HAVE_CUDA
            if (actual_format != AV_PIX_FMT_NV12 && actual_format != AV_PIX_FMT_P010LE)
                throw std::runtime_error("CUDA decoder returned an unsupported surface layout");
            auto *context = static_cast<AVHWDeviceContext *>(static_cast<void *>(hardware->data));
            auto *cuda = static_cast<AVCUDADeviceContext *>(context->hwctx);
            resident = cuda_conformer->convert(frame->data[0], frame->linesize[0],
                frame->data[1], frame->linesize[1], info.bit_depth, cuda->stream);
            conformed_ms += ms(conform_start);
            has_picture = true;
            return true;
#endif
        }
        check(av_frame_make_writable(conformed), "reuse comparison frame");
        const auto decoded_format = static_cast<AVPixelFormat>(frame->format);
        const auto plain_format = without_range(decoded_format);
        scale = sws_getCachedContext(scale, frame->width, frame->height,
            plain_format, int(width), int(height),
            static_cast<AVPixelFormat>(conformed->format), SWS_BICUBIC,
            nullptr, nullptr, nullptr);
        if (!scale) throw std::runtime_error("Cannot create comparison scaler");
        // Keep decoded range/matrix explicit. Neither backend may choose its own
        // pixel conversion, and chroma is always preserved in the comparison.
        const int *matrix = sws_getCoefficients(frame->colorspace == AVCOL_SPC_BT709
            ? SWS_CS_ITU709 : SWS_CS_DEFAULT);
        const int full_range = frame->color_range == AVCOL_RANGE_JPEG || plain_format != decoded_format;
        check(sws_setColorspaceDetails(scale, matrix, full_range, matrix, full_range,
                                      0, 1 << 16, 1 << 16), "set comparison colorspace");
        const int rows = sws_scale(scale, frame->data, frame->linesize, 0, frame->height,
                                  conformed->data, conformed->linesize);
        if (rows != int(height)) throw std::runtime_error("Incomplete comparison frame");
        conformed_ms += ms(conform_start);
        has_picture = true;
        return true;
    }
};

Decoder::Decoder(const std::string &path, unsigned width, unsigned height,
                 unsigned bit_depth, unsigned threads, bool cuda, int device)
    : impl_(std::make_unique<Impl>(path, width, height, bit_depth, threads, cuda, device)) {}
Decoder::~Decoder() = default;
VideoInfo Decoder::source_info() const { return impl_->info; }
bool Decoder::next() { return impl_->next(); }
Picture Decoder::picture() const {
    if (!impl_->has_picture) throw std::logic_error("No decoded comparison picture");
    if (impl_->cuda_decode) return impl_->resident;
    Picture out;
    out.bit_depth = impl_->bits;
    for (unsigned p = 0; p < 3; ++p) out.planes[p] = {
        impl_->conformed->data[p], std::size_t(impl_->conformed->linesize[p]),
        p ? (impl_->width + 1) / 2 : impl_->width,
        p ? (impl_->height + 1) / 2 : impl_->height};
    return out;
}
RetainedPicture Decoder::retain_picture() const {
    if (impl_->cuda_decode)
        throw std::invalid_argument("Resident CUDA pictures do not support CPU decoder retention");
    const auto view = picture();
    const auto time = timestamp();
    AVFrame *frame = av_frame_clone(impl_->conformed);
    if (!frame) throw std::bad_alloc();
    std::shared_ptr<void> storage(frame, [](void *pointer) {
        auto *owned = static_cast<AVFrame *>(pointer);
        av_frame_free(&owned);
    });
    impl_->retention_enabled = true;
    return RetainedPicture(view, time, std::move(storage));
}
double Decoder::timestamp() const {
    if (!impl_->has_picture) throw std::logic_error("No decoded comparison timestamp");
    return double(impl_->current_pts - impl_->first_pts) *
        av_q2d(impl_->format->streams[impl_->stream]->time_base);
}
double Decoder::duration() const {
    if (!impl_->has_picture) throw std::logic_error("No decoded frame duration");
#if LIBAVUTIL_VERSION_MAJOR >= 58
    const auto duration = impl_->frame->duration;
#else
    const auto duration = impl_->frame->pkt_duration;
#endif
    const double seconds = double(duration) *
        av_q2d(impl_->format->streams[impl_->stream]->time_base);
    if (!std::isfinite(seconds) || !(seconds > 0))
        throw std::runtime_error("Standalone CAMBI requires a positive actual frame duration");
    return seconds;
}
double Decoder::decode_ms() const { return impl_->decoded_ms; }
double Decoder::conform_ms() const { return impl_->conformed_ms; }
}
