/* The BitOVP runner writes this manifest into its private attempt directory.
 * This file is included by the pinned FFmpeg nvenc.c for the local build. */
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "libavutil/avstring.h"
#include "bitovp_nvenc_bindings.h"

_Static_assert(offsetof(NvencContext, avclass) == 0,
               "FFmpeg AVOptions requires AVClass at the start of NvencContext");

enum {
    BITOVP_NVENC_INIT = -1,
    BITOVP_NVENC_MAX_FRAMES = 3600,
    BITOVP_NVENC_MAX_GROUP = 512,
    BITOVP_NVENC_MAX_WRITES = 4096,
    BITOVP_NVENC_FIELD_CAPACITY = 192,
    BITOVP_NVENC_MAX_QP_BYTES = 120 * 68,
    BITOVP_NVENC_MAX_METADATA_ROWS = 32,
    BITOVP_NVENC_MAX_METADATA_BYTES = 16384,
    BITOVP_NVENC_LINE_CAPACITY = 2 * BITOVP_NVENC_MAX_METADATA_BYTES + 64,
};

typedef enum BitovpNvencPhase {
    BITOVP_NVENC_SESSION,
    BITOVP_NVENC_RECONFIGURE,
    BITOVP_NVENC_PICTURE,
    BITOVP_NVENC_QPMAP,
    BITOVP_NVENC_METADATA,
} BitovpNvencPhase;

typedef struct BitovpNvencWrite {
    BitovpNvencPhase phase;
    int frame;
    int64_t value;
    uint8_t *bytes;
    uint32_t byte_count;
    size_t ordinal;
    char field[BITOVP_NVENC_FIELD_CAPACITY];
} BitovpNvencWrite;

typedef struct BitovpNvencTiles {
    uint32_t widths[NV_MAX_TILE_COLS_AV1];
    uint32_t heights[NV_MAX_TILE_ROWS_AV1];
} BitovpNvencTiles;

typedef struct BitovpNvencPayload {
    BitovpNvencTiles tiles;
    NV_ENC_SEI_PAYLOAD metadata[BITOVP_NVENC_MAX_METADATA_ROWS];
    uint32_t metadata_count;
    NV_ENC_SEI_PAYLOAD *combined_metadata;
    NV_ENC_FILM_GRAIN_PARAMS_AV1 film_grain;
    MASTERING_DISPLAY_INFO mastering_display;
    CONTENT_LIGHT_LEVEL content_light;
} BitovpNvencPayload;

typedef struct BitovpNvencSettings {
    BitovpNvencWrite *writes;
    size_t count;
    size_t init_count;
    size_t picture_cursor;
    NV_ENC_FILM_GRAIN_PARAMS_AV1 initial_film_grain;
    BitovpNvencTiles initial_tiles;
    int receipt_written;
} BitovpNvencSettings;

static void bitovp_nvenc_free_settings(NvencContext *ctx)
{
    BitovpNvencSettings *settings = ctx->bitovp_nvenc_settings;
    if (settings && settings->writes) {
        for (size_t i = 0; i < settings->count; i++)
            av_free(settings->writes[i].bytes);
        av_freep(&settings->writes);
    }
    av_freep(&ctx->bitovp_nvenc_settings);
}

static int bitovp_nvenc_parse_number(const char *text, int64_t *result)
{
    const char *digits = text + (text[0] == '-');
    char *end;
    intmax_t value;

    if (!*digits || digits[strspn(digits, "0123456789")])
        return AVERROR(EINVAL);
    errno = 0;
    value = strtoimax(text, &end, 10);
    if (errno || *end || value < INT64_MIN || value > INT64_MAX)
        return AVERROR(EINVAL);
    *result = value;
    return 0;
}

static int bitovp_nvenc_hex_digit(char digit)
{
    if (digit >= '0' && digit <= '9')
        return digit - '0';
    if (digit >= 'a' && digit <= 'f')
        return 10 + digit - 'a';
    return -1;
}

static int bitovp_nvenc_parse_bytes(const char *data, BitovpNvencWrite *write, size_t max_bytes)
{
    const size_t length = strlen(data);
    const size_t count = length / 2;

    if (!count || length % 2 || count > max_bytes ||
        strspn(data, "0123456789abcdef") != length)
        return AVERROR(EINVAL);
    write->bytes = av_malloc(count);
    if (!write->bytes)
        return AVERROR(ENOMEM);
    for (size_t i = 0; i < count; i++)
        write->bytes[i] = bitovp_nvenc_hex_digit(data[2 * i]) * 16 +
                          bitovp_nvenc_hex_digit(data[2 * i + 1]);
    write->byte_count = count;
    return 0;
}

static int bitovp_nvenc_parse_line(char *line, BitovpNvencWrite *write)
{
    static const struct {
        const char *name;
        BitovpNvencPhase phase;
    } phases[] = {
        { "init\t", BITOVP_NVENC_SESSION },
        { "reconfigure\t", BITOVP_NVENC_RECONFIGURE },
        { "picture\t", BITOVP_NVENC_PICTURE },
        { "qpmap\t", BITOVP_NVENC_QPMAP },
        { "metadata\t", BITOVP_NVENC_METADATA },
    };
    const char *after_phase = NULL;
    char *separator;
    char *field;
    int64_t frame;
    size_t key_length;

    *write = (BitovpNvencWrite){ 0 };
    for (size_t i = 0; i < FF_ARRAY_ELEMS(phases); i++)
        if (av_strstart(line, phases[i].name, &after_phase)) {
            write->phase = phases[i].phase;
            break;
        }
    if (!after_phase)
        return AVERROR(EINVAL);

    field = line + (after_phase - line);
    write->frame = BITOVP_NVENC_INIT;
    if (write->phase != BITOVP_NVENC_SESSION) {
        separator = strchr(field, '\t');
        if (!separator)
            return AVERROR(EINVAL);
        *separator = '\0';
        if (bitovp_nvenc_parse_number(field, &frame) < 0 ||
            frame < 0 || frame >= BITOVP_NVENC_MAX_FRAMES)
            return AVERROR(EINVAL);
        write->frame = frame;
        field = separator + 1;
    }

    if (write->phase == BITOVP_NVENC_QPMAP)
        return bitovp_nvenc_parse_bytes(field, write, BITOVP_NVENC_MAX_QP_BYTES);

    separator = strchr(field, '\t');
    if (!separator)
        return AVERROR(EINVAL);
    *separator = '\0';
    if (write->phase == BITOVP_NVENC_METADATA) {
        if (bitovp_nvenc_parse_number(field, &write->value) < 0 ||
            write->value < 0 || write->value > UINT32_MAX)
            return AVERROR(EINVAL);
        return bitovp_nvenc_parse_bytes(separator + 1, write, BITOVP_NVENC_MAX_METADATA_BYTES);
    }

    key_length = strlen(field);
    if (!key_length || key_length >= sizeof(write->field) ||
        strspn(field, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.[]") != key_length)
        return AVERROR(EINVAL);
    memcpy(write->field, field, key_length + 1);
    return bitovp_nvenc_parse_number(separator + 1, &write->value);
}

static int bitovp_nvenc_compare_writes(const void *left, const void *right)
{
    const BitovpNvencWrite *a = left;
    const BitovpNvencWrite *b = right;

    if (a->frame != b->frame)
        return a->frame < b->frame ? -1 : 1;
    if (a->phase != b->phase)
        return a->phase < b->phase ? -1 : 1;
    if (a->phase == BITOVP_NVENC_METADATA)
        return (a->ordinal > b->ordinal) - (a->ordinal < b->ordinal);
    return strcmp(a->field, b->field);
}

static int bitovp_nvenc_read_settings(AVCodecContext *avctx)
{
    NvencContext *ctx = avctx->priv_data;
    const char *path = ctx->bitovp_nvenc_settings_path;
    BitovpNvencSettings *settings;
    struct stat info;
    FILE *stream;
    char line[BITOVP_NVENC_LINE_CAPACITY];
    int fd;
    int result = 0;
    size_t group_size = 0;

    if (!path)
        return 0;

    fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) {
        result = AVERROR(errno);
        av_log(avctx, AV_LOG_ERROR, "Cannot open BitOVP NVENC settings\n");
        return result;
    }
    if (fstat(fd, &info) < 0 || !S_ISREG(info.st_mode) || info.st_size <= 0 ||
        info.st_size > BITOVP_NVENC_MAX_WRITES * BITOVP_NVENC_LINE_CAPACITY) {
        close(fd);
        av_log(avctx, AV_LOG_ERROR, "Invalid BitOVP NVENC settings file\n");
        return AVERROR(EINVAL);
    }
    stream = fdopen(fd, "r");
    if (!stream) {
        result = AVERROR(errno);
        close(fd);
        return result;
    }

    settings = av_mallocz(sizeof(*settings));
    if (!settings) {
        fclose(stream);
        return AVERROR(ENOMEM);
    }
    ctx->bitovp_nvenc_settings = settings;
    settings->writes = av_malloc_array(BITOVP_NVENC_MAX_WRITES, sizeof(*settings->writes));
    if (!settings->writes) {
        fclose(stream);
        bitovp_nvenc_free_settings(ctx);
        return AVERROR(ENOMEM);
    }

    while (fgets(line, sizeof(line), stream)) {
        char *end = strchr(line, '\n');
        if (!end || settings->count == BITOVP_NVENC_MAX_WRITES) {
            result = AVERROR(EINVAL);
            break;
        }
        *end = '\0';
        result = bitovp_nvenc_parse_line(line, &settings->writes[settings->count]);
        if (result < 0)
            break;
        settings->writes[settings->count].ordinal = settings->count;
        settings->count++;
    }
    if (ferror(stream))
        result = AVERROR(EIO);
    fclose(stream);
    if (result < 0 || !settings->count) {
        bitovp_nvenc_free_settings(ctx);
        av_log(avctx, AV_LOG_ERROR, "Invalid BitOVP NVENC settings entry\n");
        return result < 0 ? result : AVERROR(EINVAL);
    }

    qsort(settings->writes, settings->count, sizeof(*settings->writes), bitovp_nvenc_compare_writes);
    for (size_t i = 0; i < settings->count; i++) {
        const BitovpNvencWrite *current = &settings->writes[i];
        if (i && !bitovp_nvenc_compare_writes(current, current - 1))
            goto invalid;
        if (!i || current->frame != (current - 1)->frame ||
            current->phase != (current - 1)->phase)
            group_size = 0;
        if (++group_size > (current->phase == BITOVP_NVENC_METADATA ?
                            BITOVP_NVENC_MAX_METADATA_ROWS : BITOVP_NVENC_MAX_GROUP))
            goto invalid;
        if (current->frame == BITOVP_NVENC_INIT)
            settings->init_count++;
    }
    settings->picture_cursor = settings->init_count;
    return 0;

invalid:
    bitovp_nvenc_free_settings(ctx);
    av_log(avctx, AV_LOG_ERROR, "Invalid or duplicate BitOVP NVENC settings entry\n");
    return AVERROR(EINVAL);
}

static int bitovp_nvenc_assign(AVCodecContext *avctx, NV_ENC_PIC_PARAMS *picture,
                               const BitovpNvencWrite *write)
{
    NvencContext *ctx = avctx->priv_data;

    if (bitovp_nvenc_write_field(&ctx->init_encode_params, picture, write->field, write->value) == 0)
        return 0;
    av_log(avctx, AV_LOG_ERROR, "Cannot apply BitOVP NVENC setting %s (frame %d)\n",
           write->field, write->frame);
    return AVERROR(EINVAL);
}

static int bitovp_nvenc_apply_tuning(AVCodecContext *avctx)
{
    NvencContext *ctx = avctx->priv_data;
    BitovpNvencSettings *settings = ctx->bitovp_nvenc_settings;

    if (!settings)
        return 0;
    for (size_t i = 0; i < settings->init_count; i++) {
        const BitovpNvencWrite *write = &settings->writes[i];
        int result;

        if (strcmp(write->field, "NV_ENC_INITIALIZE_PARAMS.tuningInfo"))
            continue;
        result = bitovp_nvenc_assign(avctx, NULL, write);
        if (result < 0)
            return result;
        ctx->tuning_info = ctx->init_encode_params.tuningInfo;
        ctx->flags &= ~(NVENC_LOSSLESS | NVENC_LOWLATENCY);
        if (ctx->tuning_info == NV_ENC_TUNING_INFO_LOSSLESS)
            ctx->flags |= NVENC_LOSSLESS;
        if (ctx->tuning_info == NV_ENC_TUNING_INFO_LOW_LATENCY ||
            ctx->tuning_info == NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY)
            ctx->flags |= NVENC_LOWLATENCY;
        break;
    }
    return 0;
}

static void bitovp_nvenc_picture_payload(AVCodecContext *avctx, NV_ENC_PIC_PARAMS *picture,
                                          BitovpNvencPayload *payload, const char *field)
{
    if (avctx->codec_id == AV_CODEC_ID_HEVC) {
        NV_ENC_PIC_PARAMS_HEVC *hevc = &picture->codecPicParams.hevcPicParams;
        if (av_strstart(field, "NV_ENC_PIC_PARAMS_HEVC.pMasteringDisplay.", NULL)) {
            if (hevc->pMasteringDisplay)
                payload->mastering_display = *hevc->pMasteringDisplay;
            hevc->pMasteringDisplay = &payload->mastering_display;
        }
        if (av_strstart(field, "NV_ENC_PIC_PARAMS_HEVC.pMaxCll.", NULL)) {
            if (hevc->pMaxCll)
                payload->content_light = *hevc->pMaxCll;
            hevc->pMaxCll = &payload->content_light;
        }
    } else if (avctx->codec_id == AV_CODEC_ID_AV1) {
        NV_ENC_PIC_PARAMS_AV1 *av1 = &picture->codecPicParams.av1PicParams;
        if (av_strstart(field, "NV_ENC_PIC_PARAMS_AV1.pMasteringDisplay.", NULL)) {
            if (av1->pMasteringDisplay)
                payload->mastering_display = *av1->pMasteringDisplay;
            av1->pMasteringDisplay = &payload->mastering_display;
        }
        if (av_strstart(field, "NV_ENC_PIC_PARAMS_AV1.pMaxCll.", NULL)) {
            if (av1->pMaxCll)
                payload->content_light = *av1->pMaxCll;
            av1->pMaxCll = &payload->content_light;
        }
        if (av_strstart(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[", NULL))
            av1->tileWidths = payload->tiles.widths;
        if (av_strstart(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[", NULL))
            av1->tileHeights = payload->tiles.heights;
        if (av_strstart(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.", NULL)) {
            if (av1->filmGrainParams)
                payload->film_grain = *av1->filmGrainParams;
            av1->filmGrainParams = &payload->film_grain;
        }
    }
}

static int bitovp_nvenc_grain_valid(const NV_ENC_FILM_GRAIN_PARAMS_AV1 *grain)
{
    return grain->numYPoints <= FF_ARRAY_ELEMS(grain->pointYValue) &&
           grain->numCbPoints <= FF_ARRAY_ELEMS(grain->pointCbValue) &&
           grain->numCrPoints <= FF_ARRAY_ELEMS(grain->pointCrValue);
}

static int bitovp_nvenc_tiles_dimension(const uint32_t *sizes, uint32_t count,
                                        uint32_t capacity, uint32_t pixels)
{
    uint64_t total = 0;

    if (!sizes || !count || count > capacity)
        return 0;
    for (uint32_t i = 0; i < count; i++) {
        if (!sizes[i])
            return 0;
        total += sizes[i];
    }
    for (uint32_t i = count; i < capacity; i++)
        if (sizes[i])
            return 0;
    return total == (pixels + 63) / 64;
}

static int bitovp_nvenc_tiles_valid(const NV_ENC_INITIALIZE_PARAMS *init,
                                    const uint32_t *widths, uint32_t columns,
                                    const uint32_t *heights, uint32_t rows)
{
    return bitovp_nvenc_tiles_dimension(widths, columns, NV_MAX_TILE_COLS_AV1, init->encodeWidth) &&
           bitovp_nvenc_tiles_dimension(heights, rows, NV_MAX_TILE_ROWS_AV1, init->encodeHeight);
}

static int bitovp_nvenc_check_picture(AVCodecContext *avctx, const NV_ENC_PIC_PARAMS *picture,
                                       const BitovpNvencPayload *payload)
{
    NvencContext *ctx = avctx->priv_data;
    const NV_ENC_CODEC_CONFIG *codec = &ctx->encode_config.encodeCodecConfig;
    const uint32_t allowed = NV_ENC_PIC_FLAG_FORCEINTRA | NV_ENC_PIC_FLAG_FORCEIDR
                           | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;

    if ((picture->encodePicFlags & ~allowed) || picture->pictureStruct != NV_ENC_PIC_STRUCT_FRAME)
        goto invalid;
    if (avctx->codec_id == AV_CODEC_ID_HEVC) {
        const NV_ENC_PIC_PARAMS_HEVC *hevc = &picture->codecPicParams.hevcPicParams;
        if ((hevc->pMasteringDisplay == &payload->mastering_display && !codec->hevcConfig.outputMasteringDisplay) ||
            (hevc->pMaxCll == &payload->content_light && !codec->hevcConfig.outputMaxCll))
            goto invalid;
    }
    if (avctx->codec_id == AV_CODEC_ID_AV1) {
        const NV_ENC_PIC_PARAMS_AV1 *av1 = &picture->codecPicParams.av1PicParams;
        if ((av1->tileConfigUpdate && av1->forceIntraRefreshWithFrameCnt) ||
            (av1->enableCustomTileConfig &&
             (!av1->tileConfigUpdate ||
              av1->tileWidths != payload->tiles.widths ||
              av1->tileHeights != payload->tiles.heights ||
              !bitovp_nvenc_tiles_valid(&ctx->init_encode_params,
                                       av1->tileWidths, av1->numTileColumns,
                                       av1->tileHeights, av1->numTileRows))) ||
            (!av1->enableCustomTileConfig && (av1->tileWidths || av1->tileHeights)) ||
            (av1->pMasteringDisplay == &payload->mastering_display && !codec->av1Config.outputMasteringDisplay) ||
            (av1->pMaxCll == &payload->content_light && !codec->av1Config.outputMaxCll) ||
            (av1->filmGrainParams == &payload->film_grain) != av1->filmGrainParamsUpdate ||
            (av1->filmGrainParamsUpdate &&
             (!codec->av1Config.enableFilmGrainParams || !bitovp_nvenc_grain_valid(av1->filmGrainParams))))
            goto invalid;
    }
    return 0;

invalid:
    av_log(avctx, AV_LOG_ERROR, "Incompatible BitOVP NVENC picture settings on frame %" PRIu32 "\n",
           picture->frameIdx);
    return AVERROR(EINVAL);
}

/* Caller holds the FFmpeg CUDA context when execute is true. */
static int bitovp_nvenc_reconfigure(AVCodecContext *avctx, unsigned frame, size_t *cursor,
                                    int execute)
{
    NvencContext *ctx = avctx->priv_data;
    BitovpNvencSettings *settings = ctx->bitovp_nvenc_settings;
    NV_ENC_CONFIG config = ctx->encode_config;
    NV_ENC_RECONFIGURE_PARAMS params = { .version = NV_ENC_RECONFIGURE_PARAMS_VER };
    size_t start = *cursor;
    int updates_rate = 0;
    NVENCSTATUS status;

    params.reInitEncodeParams = ctx->init_encode_params;
    params.reInitEncodeParams.encodeConfig = &config;
    while (*cursor < settings->count) {
        const BitovpNvencWrite *write = &settings->writes[*cursor];
        const char *path = write->field;
        int64_t value = write->value;

        if ((unsigned)write->frame != frame || write->phase != BITOVP_NVENC_RECONFIGURE)
            break;
        if (!strcmp(path, "NV_ENC_RECONFIGURE_PARAMS.forceIDR")) {
            if (value != 0 && value != 1)
                goto invalid;
            params.forceIDR = value;
        } else if (!strcmp(path, "NV_ENC_RECONFIGURE_PARAMS.resetEncoder")) {
            if (value != 0 && value != 1)
                goto invalid;
            params.resetEncoder = value;
        } else if (!strcmp(path, "NV_ENC_RC_PARAMS.averageBitRate") ||
                   !strcmp(path, "NV_ENC_RC_PARAMS.maxBitRate") ||
                   !strcmp(path, "NV_ENC_RC_PARAMS.vbvBufferSize")) {
            if (bitovp_nvenc_write_field(&params.reInitEncodeParams, NULL, path, value) != 0)
                goto invalid;
            updates_rate = 1;
        } else {
            goto invalid;
        }
        (*cursor)++;
    }

    if (*cursor == start || !execute)
        return 0;
    if (updates_rate && (!ctx->support_dyn_bitrate || config.rcParams.rateControlMode == NV_ENC_PARAMS_RC_CONSTQP))
        goto invalid;

    status = ctx->nvenc_dload_funcs.nvenc_funcs.nvEncReconfigureEncoder(ctx->nvencoder, &params);
    if (status != NV_ENC_SUCCESS)
        return nvenc_print_error(avctx, status, "BitOVP NvEncReconfigureEncoder failed");
    ctx->encode_config = config;
    return 0;

invalid:
    av_log(avctx, AV_LOG_ERROR, "Invalid BitOVP NVENC reconfigure settings on frame %u\n", frame);
    return AVERROR(EINVAL);
}

static int bitovp_nvenc_attach_map(AVCodecContext *avctx, NV_ENC_PIC_PARAMS *picture,
                                   const BitovpNvencWrite *write)
{
    NvencContext *ctx = avctx->priv_data;
    const NV_ENC_INITIALIZE_PARAMS *init = &ctx->init_encode_params;
    const NV_ENC_RC_PARAMS *rate = &ctx->encode_config.rcParams;
    const unsigned block = avctx->codec_id == AV_CODEC_ID_H264 ? 16 :
                           avctx->codec_id == AV_CODEC_ID_HEVC ? 32 : 64;
    const unsigned cols = (init->encodeWidth + block - 1) / block;
    const unsigned rows = (init->encodeHeight + block - 1) / block;

    if ((uint64_t)cols * rows != write->byte_count ||
        (rate->qpMapMode != NV_ENC_QP_MAP_EMPHASIS && rate->qpMapMode != NV_ENC_QP_MAP_DELTA))
        goto invalid;
    if (rate->qpMapMode == NV_ENC_QP_MAP_EMPHASIS) {
        if (avctx->codec_id != AV_CODEC_ID_H264 || rate->enableAQ || rate->enableTemporalAQ)
            goto invalid;
        for (size_t i = 0; i < write->byte_count; i++)
            if (write->bytes[i] > NV_ENC_EMPHASIS_MAP_LEVEL_5)
                goto invalid;
    }

    picture->qpDeltaMap = (int8_t *)write->bytes;
    picture->qpDeltaMapSize = write->byte_count;
    return 0;

invalid:
    av_log(avctx, AV_LOG_ERROR, "Invalid BitOVP NVENC QP map on frame %" PRIu32 "\n", picture->frameIdx);
    return AVERROR(EINVAL);
}

static int bitovp_nvenc_collect_metadata(AVCodecContext *avctx, BitovpNvencPayload *payload,
                                         const BitovpNvencWrite *write)
{
    /* For AV1 the payload type is metadata_type inside OBU_METADATA. */
    if (avctx->codec_id == AV_CODEC_ID_AV1 && (write->value < 1 || write->value > 5)) {
        av_log(avctx, AV_LOG_ERROR, "Invalid BitOVP NVENC AV1 metadata type on frame %d\n",
               write->frame);
        return AVERROR(EINVAL);
    }
    payload->metadata[payload->metadata_count++] = (NV_ENC_SEI_PAYLOAD){
        .payloadType = write->value,
        .payloadSize = write->byte_count,
        .payload = write->bytes,
    };
    return 0;
}

static int bitovp_nvenc_attach_metadata(AVCodecContext *avctx, NV_ENC_PIC_PARAMS *picture,
                                        BitovpNvencPayload *payload)
{
    NV_ENC_SEI_PAYLOAD **payloads;
    uint32_t *count;
    size_t combined_count;
    NV_ENC_SEI_PAYLOAD *combined;

    if (!payload->metadata_count)
        return 0;
    if (avctx->codec_id == AV_CODEC_ID_H264) {
        payloads = &picture->codecPicParams.h264PicParams.seiPayloadArray;
        count = &picture->codecPicParams.h264PicParams.seiPayloadArrayCnt;
    } else if (avctx->codec_id == AV_CODEC_ID_HEVC) {
        payloads = &picture->codecPicParams.hevcPicParams.seiPayloadArray;
        count = &picture->codecPicParams.hevcPicParams.seiPayloadArrayCnt;
    } else {
        payloads = &picture->codecPicParams.av1PicParams.obuPayloadArray;
        count = &picture->codecPicParams.av1PicParams.obuPayloadArrayCnt;
    }
    if (!*count) {
        *payloads = payload->metadata;
        *count = payload->metadata_count;
        return 0;
    }

    combined_count = (uint64_t)*count + payload->metadata_count;
    if (combined_count > UINT32_MAX)
        return AVERROR(EINVAL);
    combined = av_malloc_array(combined_count, sizeof(*combined));
    if (!combined)
        return AVERROR(ENOMEM);
    memcpy(combined, *payloads, (size_t)*count * sizeof(*combined));
    memcpy(combined + *count, payload->metadata, payload->metadata_count * sizeof(*combined));
    payload->combined_metadata = combined;
    *payloads = combined;
    *count = combined_count;
    return 0;
}

static int bitovp_nvenc_apply_picture(AVCodecContext *avctx, NV_ENC_PIC_PARAMS *picture,
                                      BitovpNvencPayload *payload, size_t *cursor)
{
    NvencContext *ctx = avctx->priv_data;
    BitovpNvencSettings *settings = ctx->bitovp_nvenc_settings;
    size_t start = *cursor;

    if (!settings)
        return 0;

    while (*cursor < settings->count) {
        const BitovpNvencWrite *write = &settings->writes[*cursor];
        int result;

        if ((unsigned)write->frame < picture->frameIdx ||
            ((unsigned)write->frame == picture->frameIdx && write->phase == BITOVP_NVENC_RECONFIGURE)) {
            av_log(avctx, AV_LOG_ERROR, "Missed BitOVP NVENC picture settings on frame %d\n", write->frame);
            return AVERROR(EINVAL);
        }
        if ((unsigned)write->frame > picture->frameIdx)
            break;
        if (write->phase == BITOVP_NVENC_QPMAP) {
            result = bitovp_nvenc_attach_map(avctx, picture, write);
        } else if (write->phase == BITOVP_NVENC_METADATA) {
            result = bitovp_nvenc_collect_metadata(avctx, payload, write);
        } else {
            bitovp_nvenc_picture_payload(avctx, picture, payload, write->field);
            result = bitovp_nvenc_assign(avctx, picture, write);
        }
        if (result < 0)
            return result;
        (*cursor)++;
    }
    if (*cursor > start) {
        int result = bitovp_nvenc_check_picture(avctx, picture, payload);
        if (result < 0)
            return result;
    }
    return bitovp_nvenc_attach_metadata(avctx, picture, payload);
}

static int bitovp_nvenc_picture_preflight(AVCodecContext *avctx)
{
    NvencContext *ctx = avctx->priv_data;
    BitovpNvencSettings *settings = ctx->bitovp_nvenc_settings;
    size_t cursor = settings->picture_cursor;
    int has_map = 0;

    while (cursor < settings->count) {
        NV_ENC_PIC_PARAMS picture = { .version = NV_ENC_PIC_PARAMS_VER,
                                      .pictureStruct = NV_ENC_PIC_STRUCT_FRAME };
        BitovpNvencPayload payload = { 0 };
        int result;

        picture.frameIdx = settings->writes[cursor].frame;
        result = bitovp_nvenc_reconfigure(avctx, picture.frameIdx, &cursor, 0);
        if (result < 0)
            return result;
        result = bitovp_nvenc_apply_picture(avctx, &picture, &payload, &cursor);
        if (result < 0)
            return result;
        has_map |= !!picture.qpDeltaMap;
    }
    if (ctx->encode_config.rcParams.qpMapMode != NV_ENC_QP_MAP_DISABLED && !has_map) {
        av_log(avctx, AV_LOG_ERROR, "BitOVP NVENC QP map mode requires a frame map\n");
        return AVERROR(EINVAL);
    }
    return 0;
}

static int bitovp_nvenc_profile(const GUID *guid, enum AVCodecID codec)
{
    const struct {
        enum AVCodecID codec;
        const GUID *guid;
        int value;
    } profiles[] = {
        { AV_CODEC_ID_H264, &NV_ENC_H264_PROFILE_BASELINE_GUID, AV_PROFILE_H264_BASELINE },
        { AV_CODEC_ID_H264, &NV_ENC_H264_PROFILE_MAIN_GUID, AV_PROFILE_H264_MAIN },
        { AV_CODEC_ID_H264, &NV_ENC_H264_PROFILE_HIGH_GUID, AV_PROFILE_H264_HIGH },
        { AV_CODEC_ID_H264, &NV_ENC_H264_PROFILE_HIGH_10_GUID, AV_PROFILE_H264_HIGH_10 },
        { AV_CODEC_ID_H264, &NV_ENC_H264_PROFILE_HIGH_422_GUID, AV_PROFILE_H264_HIGH_422 },
        { AV_CODEC_ID_H264, &NV_ENC_H264_PROFILE_HIGH_444_GUID, AV_PROFILE_H264_HIGH_444_PREDICTIVE },
        { AV_CODEC_ID_H264, &NV_ENC_H264_PROFILE_STEREO_GUID, AV_PROFILE_H264_STEREO_HIGH },
        { AV_CODEC_ID_H264, &NV_ENC_H264_PROFILE_PROGRESSIVE_HIGH_GUID, AV_PROFILE_H264_HIGH },
        { AV_CODEC_ID_H264, &NV_ENC_H264_PROFILE_CONSTRAINED_HIGH_GUID, AV_PROFILE_H264_HIGH },
        { AV_CODEC_ID_HEVC, &NV_ENC_HEVC_PROFILE_MAIN_GUID, AV_PROFILE_HEVC_MAIN },
        { AV_CODEC_ID_HEVC, &NV_ENC_HEVC_PROFILE_MAIN10_GUID, AV_PROFILE_HEVC_MAIN_10 },
        { AV_CODEC_ID_HEVC, &NV_ENC_HEVC_PROFILE_FREXT_GUID, AV_PROFILE_HEVC_REXT },
        { AV_CODEC_ID_AV1, &NV_ENC_AV1_PROFILE_MAIN_GUID, AV_PROFILE_AV1_MAIN },
    };

    for (size_t i = 0; i < FF_ARRAY_ELEMS(profiles); i++) {
        if (codec == profiles[i].codec && !memcmp(guid, profiles[i].guid, sizeof(*guid)))
            return profiles[i].value;
    }
    return AV_PROFILE_UNKNOWN;
}

static void bitovp_nvenc_update_stream(AVCodecContext *avctx)
{
    NvencContext *ctx = avctx->priv_data;
    const NV_ENC_CONFIG *encode = &ctx->encode_config;
    const NV_ENC_CODEC_CONFIG *codec = &encode->encodeCodecConfig;
    const NV_ENC_CONFIG_H264_VUI_PARAMETERS *vui;

    avctx->profile = bitovp_nvenc_profile(&encode->profileGUID, avctx->codec_id);
    if (avctx->codec_id == AV_CODEC_ID_AV1) {
        const NV_ENC_CONFIG_AV1 *av1 = &codec->av1Config;
        avctx->level = av1->level ? av1->level : AV_LEVEL_UNKNOWN;
        avctx->color_range = av1->colorRange ? AVCOL_RANGE_JPEG : AVCOL_RANGE_MPEG;
        avctx->colorspace = (enum AVColorSpace)av1->matrixCoefficients;
        avctx->color_trc = (enum AVColorTransferCharacteristic)av1->transferCharacteristics;
        avctx->color_primaries = (enum AVColorPrimaries)av1->colorPrimaries;
        return;
    }

    if (avctx->codec_id == AV_CODEC_ID_H264) {
        const NV_ENC_CONFIG_H264 *h264 = &codec->h264Config;
        avctx->level = h264->level ? h264->level : AV_LEVEL_UNKNOWN;
        vui = &h264->h264VUIParameters;
    } else {
        const NV_ENC_CONFIG_HEVC *hevc = &codec->hevcConfig;
        avctx->level = hevc->level ? hevc->level : AV_LEVEL_UNKNOWN;
        vui = &hevc->hevcVUIParameters;
    }

    avctx->color_range = vui->videoSignalTypePresentFlag && vui->videoFullRangeFlag ?
                         AVCOL_RANGE_JPEG : AVCOL_RANGE_MPEG;
    if (vui->videoSignalTypePresentFlag && vui->colourDescriptionPresentFlag) {
        avctx->colorspace = (enum AVColorSpace)vui->colourMatrix;
        avctx->color_trc = (enum AVColorTransferCharacteristic)vui->transferCharacteristics;
        avctx->color_primaries = (enum AVColorPrimaries)vui->colourPrimaries;
    } else {
        avctx->colorspace = AVCOL_SPC_UNSPECIFIED;
        avctx->color_trc = AVCOL_TRC_UNSPECIFIED;
        avctx->color_primaries = AVCOL_PRI_UNSPECIFIED;
    }
}

static int bitovp_nvenc_validate_transport(AVCodecContext *avctx, int lookahead)
{
    NvencContext *ctx = avctx->priv_data;
    const NV_ENC_INITIALIZE_PARAMS *init = &ctx->init_encode_params;
    const NV_ENC_CONFIG *encode = &ctx->encode_config;
    const NV_ENC_CODEC_CONFIG *codec = &encode->encodeCodecConfig;
    const int frame_interval = encode->frameIntervalP;

    if (init->enableEncodeAsync || init->enablePTD != 1 ||
        init->reportSliceOffsets || init->enableSubFrameWrite ||
        init->enableExternalMEHints || init->enableMEOnlyMode ||
        init->enableOutputInVidmem || init->enableReconFrameOutput ||
        init->enableOutputStats || init->numStateBuffers ||
        init->encodeWidth != avctx->width || init->encodeHeight != avctx->height ||
        encode->frameFieldMode != NV_ENC_PARAMS_FRAME_FIELD_MODE_FRAME ||
        encode->rcParams.enableExtLookahead ||
        encode->rcParams.qpMapMode == NV_ENC_QP_MAP ||
        frame_interval < 0 || frame_interval > MAX_REGISTERED_FRAMES / 4 ||
        lookahead < 0 || lookahead > MAX_REGISTERED_FRAMES - frame_interval - 5)
        goto unsupported;
    if (avctx->codec_id == AV_CODEC_ID_HEVC &&
        (codec->hevcConfig.enableAlphaLayerEncoding || codec->hevcConfig.enableMVHEVC))
        goto unsupported;
    if (avctx->codec_id == AV_CODEC_ID_AV1) {
        const NV_ENC_CONFIG_AV1 *av1 = &codec->av1Config;
        const BitovpNvencTiles *tiles = &ctx->bitovp_nvenc_settings->initial_tiles;
        if (av1->outputAnnexBFormat ||
            !!av1->enableFilmGrainParams != !!av1->filmGrainParams ||
            (av1->filmGrainParams && !bitovp_nvenc_grain_valid(av1->filmGrainParams)) ||
            (av1->enableCustomTileConfig &&
             (av1->tileWidths != tiles->widths || av1->tileHeights != tiles->heights ||
              !bitovp_nvenc_tiles_valid(init, av1->tileWidths, av1->numTileColumns,
                                       av1->tileHeights, av1->numTileRows))) ||
            (!av1->enableCustomTileConfig && (av1->tileWidths || av1->tileHeights)))
            goto unsupported;
    }
    return 0;

unsupported:
    av_log(avctx, AV_LOG_ERROR, "BitOVP NVENC settings require an unsupported media or session mode\n");
    return AVERROR(EINVAL);
}

static int bitovp_nvenc_apply_settings(AVCodecContext *avctx, int requested_surfaces,
                                       int requested_delay)
{
    NvencContext *ctx = avctx->priv_data;
    BitovpNvencSettings *settings = ctx->bitovp_nvenc_settings;
    int lookahead;
    int result;

    if (!settings)
        return 0;

    for (size_t i = 0; i < settings->init_count; i++) {
        const BitovpNvencWrite *write = &settings->writes[i];

        /* Tuning was applied before asking the driver for preset defaults. */
        if (!strcmp(write->field, "NV_ENC_INITIALIZE_PARAMS.tuningInfo"))
            continue;
        if (avctx->codec_id == AV_CODEC_ID_AV1) {
            NV_ENC_CONFIG_AV1 *av1 = &ctx->encode_config.encodeCodecConfig.av1Config;
            if (av_strstart(write->field, "NV_ENC_CONFIG_AV1.filmGrainParams.", NULL))
                av1->filmGrainParams = &settings->initial_film_grain;
            if (av_strstart(write->field, "NV_ENC_CONFIG_AV1.tileWidths[", NULL))
                av1->tileWidths = settings->initial_tiles.widths;
            if (av_strstart(write->field, "NV_ENC_CONFIG_AV1.tileHeights[", NULL))
                av1->tileHeights = settings->initial_tiles.heights;
        }
        result = bitovp_nvenc_assign(avctx, NULL, write);
        if (result < 0)
            return result;
    }

    lookahead = ctx->encode_config.rcParams.enableLookahead ?
                ctx->encode_config.rcParams.lookaheadDepth : 0;
    result = bitovp_nvenc_validate_transport(avctx, lookahead);
    if (result < 0)
        return result;
    result = bitovp_nvenc_picture_preflight(avctx);
    if (result < 0)
        return result;

    /* NVENC consumes the final SDK structure while FFmpeg owns the queue sizes. */
    ctx->nb_surfaces = requested_surfaces;
    ctx->async_depth = requested_delay;
    ctx->rc_lookahead = lookahead;
    nvenc_recalc_surfaces(avctx);
    bitovp_nvenc_update_stream(avctx);
    return 0;
}

static int bitovp_nvenc_verify_end(AVCodecContext *avctx)
{
    NvencContext *ctx = avctx->priv_data;
    BitovpNvencSettings *settings = ctx->bitovp_nvenc_settings;

    if (settings && settings->picture_cursor != settings->count) {
        av_log(avctx, AV_LOG_ERROR, "Unconsumed BitOVP NVENC picture settings\n");
        return AVERROR(EINVAL);
    }
    return 0;
}

static int bitovp_nvenc_write_receipt(AVCodecContext *avctx)
{
    NvencContext *ctx = avctx->priv_data;
    BitovpNvencSettings *settings = ctx->bitovp_nvenc_settings;
    char *receipt;
    char contents[96];
    int length;
    int fd;
    ssize_t written;
    int result;

    if (!settings || settings->receipt_written)
        return 0;

    receipt = av_asprintf("%s.receipt", ctx->bitovp_nvenc_settings_path);
    if (!receipt)
        return AVERROR(ENOMEM);

    fd = open(receipt, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    av_free(receipt);
    if (fd < 0) {
        result = AVERROR(errno);
        av_log(avctx, AV_LOG_ERROR, "Cannot create BitOVP NVENC settings receipt\n");
        return result;
    }
    length = snprintf(contents, sizeof(contents), "bitovp-nvenc-settings-v1\t%zu\t%zu\n",
                      settings->init_count, settings->count - settings->init_count);

    do {
        written = write(fd, contents, length);
    } while (written < 0 && errno == EINTR);
    result = close(fd);
    if (written != length || result < 0) {
        av_log(avctx, AV_LOG_ERROR, "Cannot write BitOVP NVENC settings receipt\n");
        return AVERROR(EIO);
    }

    settings->receipt_written = 1;
    return 0;
}
