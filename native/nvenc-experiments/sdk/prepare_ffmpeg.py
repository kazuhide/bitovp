#!/usr/bin/env python3
"""Install the BitOVP SDK settings bridge into the pinned private FFmpeg build."""

import argparse
from hashlib import sha256
from pathlib import Path


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError(f"Expected one FFmpeg source anchor: {old!r}")
    return source.replace(old, new, 1)


def prepare(root):
    libavcodec = root / "libavcodec"
    sdk_dir = Path(__file__).resolve().parent
    catalog = sdk_dir.parent / "catalog"
    catalog_digest = sha256((catalog / "sdk-13.0.json").read_bytes()).hexdigest()
    files = {
        libavcodec / "bitovp_nvenc_bindings.h": (catalog / "sdk-settings.h").read_bytes(),
        libavcodec / "bitovp_nvenc_settings.inc": (sdk_dir / "nvenc_settings.inc").read_bytes(),
    }

    header = libavcodec / "nvenc.h"
    context = replace_once(
        header.read_text(encoding="utf-8"),
        "typedef struct NvencContext",
        "struct BitovpNvencSettings;\n\ntypedef struct NvencContext",
    )
    files[header] = replace_once(
        context,
        "} NvencContext;",
        """    char *bitovp_nvenc_settings_path;
    struct BitovpNvencSettings *bitovp_nvenc_settings;
} NvencContext;""",
    ).encode()

    for codec in ("h264", "hevc", "av1"):
        wrapper = libavcodec / f"nvenc_{codec}.c"
        files[wrapper] = replace_once(
            wrapper.read_text(encoding="utf-8"),
            "static const AVOption options[] = {",
            f"""static const AVOption options[] = {{
    {{ "bitovp-nvenc-settings", "Apply checked BitOVP SDK fields (sdk-receipt-version=2 sdk-catalog-sha256={catalog_digest})",
      OFFSET(bitovp_nvenc_settings_path), AV_OPT_TYPE_STRING, {{ .str = NULL }}, 0, 0, VE }},""",
        ).encode()

    main = libavcodec / "nvenc.c"
    source = main.read_text(encoding="utf-8")
    substitutions = (
        (
            '#include "config.h"',
            """#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE
#endif
#if defined(__APPLE__) && !defined(_DARWIN_C_SOURCE)
#define _DARWIN_C_SOURCE
#endif

#include "config.h" """.rstrip(),
        ),
        (
            "static void compute_dar(AVCodecContext *avctx, int *dw, int *dh) {",
            '#include "bitovp_nvenc_settings.inc"\n\n'
            "static void compute_dar(AVCodecContext *avctx, int *dw, int *dh) {",
        ),
        (
            "    int dw, dh;\n\n    ctx->encode_config.version = NV_ENC_CONFIG_VER;",
            """    int dw, dh;
    const int requested_surfaces = ctx->nb_surfaces;
    const int requested_delay = ctx->async_depth;

    res = bitovp_nvenc_read_settings(avctx);
    if (res < 0)
        return res;

    ctx->encode_config.version = NV_ENC_CONFIG_VER;""",
        ),
        (
            "    nv_status = p_nvenc->nvEncGetEncodePresetConfigEx(ctx->nvencoder,",
            """    res = bitovp_nvenc_apply_tuning(avctx);
    if (res < 0)
        return res;

    nv_status = p_nvenc->nvEncGetEncodePresetConfigEx(ctx->nvencoder,""",
        ),
        (
            "    res = nvenc_setup_codec_config(avctx);\n    if (res)\n        return res;",
            """    res = nvenc_setup_codec_config(avctx);
    if (res)
        return res;

    res = bitovp_nvenc_apply_settings(avctx, requested_surfaces, requested_delay);
    if (res < 0)
        return res;""",
        ),
        (
            "    ctx->nvencoder = NULL;\n\n    if (ctx->cu_context_internal)",
            """    ctx->nvencoder = NULL;
    bitovp_nvenc_free_settings(ctx);

    if (ctx->cu_context_internal)""",
        ),
        (
            "    int sei_count = 0;\n    int i;\n#ifdef NVENC_HAVE_HEVC_AND_AV1_MASTERING_METADATA",
            """    int sei_count = 0;
    int i;
    size_t picture_cursor = 0;
    BitovpNvencPayload picture_payload = { 0 };
#ifdef NVENC_HAVE_HEVC_AND_AV1_MASTERING_METADATA""",
        ),
        (
            "        reconfig_encoder(avctx, frame);",
            """        if (!ctx->bitovp_nvenc_settings) {
            reconfig_encoder(avctx, frame);
        } else {
            picture_cursor = ctx->bitovp_nvenc_settings->picture_cursor;
            res = bitovp_nvenc_reconfigure(avctx, ctx->frame_idx_counter, &picture_cursor, 1);
            if (res < 0) {
                res2 = nvenc_pop_context(avctx);
                return res2 < 0 ? res2 : res;
            }
        }""",
        ),
        (
            "        nvenc_codec_specific_pic_params(avctx, frame, &pic_params, ctx->sei_data, sei_count);\n"
            "    } else {\n        pic_params.encodePicFlags = NV_ENC_PIC_FLAG_EOS;\n    }",
            """        nvenc_codec_specific_pic_params(avctx, frame, &pic_params, ctx->sei_data, sei_count);
        res = bitovp_nvenc_apply_picture(avctx, &pic_params, &picture_payload, &picture_cursor);
        if (res < 0) {
            for (i = 0; i < sei_count; i++)
                av_freep(&(ctx->sei_data[i].payload));
            return res;
        }
    } else {
        res = bitovp_nvenc_verify_end(avctx);
        if (res < 0)
            return res;
        pic_params.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
    }""",
        ),
        (
            "    res = nvenc_push_context(avctx);\n    if (res < 0)\n        return res;\n\n"
            "    nv_status = p_nvenc->nvEncEncodePicture(ctx->nvencoder, &pic_params);",
            """    res = nvenc_push_context(avctx);
    if (res >= 0)
        nv_status = bitovp_nvenc_submit_picture(p_nvenc->nvEncEncodePicture, ctx->nvencoder,
                                               &pic_params, ctx->bitovp_nvenc_settings != NULL);

    av_freep(&picture_payload.combined_metadata);
    if (res < 0)
        return res;""",
        ),
        (
            '        return nvenc_print_error(avctx, nv_status, "EncodePicture failed!");\n\n'
            "    if (frame && frame->buf[0]) {",
            """    {
        res = nvenc_print_error(avctx, nv_status, "EncodePicture failed!");
        return ctx->bitovp_nvenc_settings && res == AVERROR(EAGAIN) ? AVERROR(EIO) : res;
    }

    if (frame && frame->buf[0]) {
        if (ctx->bitovp_nvenc_settings)
            ctx->bitovp_nvenc_settings->picture_cursor = picture_cursor;""",
        ),
        (
            "    /* all the pending buffers are now ready for output */\n    if (nv_status == NV_ENC_SUCCESS) {",
            """    /* all the pending buffers are now ready for output */
    if (nv_status == NV_ENC_SUCCESS) {
        if (pic_params.encodePicFlags == NV_ENC_PIC_FLAG_EOS) {
            res = bitovp_nvenc_write_receipt(avctx);
            if (res < 0)
                return res;
        }""",
        ),
    )
    for old, new in substitutions:
        source = replace_once(source, old, new)
    files[main] = source.encode()

    for path, content in files.items():
        path.write_bytes(content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ffmpeg_source", type=Path)
    args = parser.parse_args()
    prepare(args.ffmpeg_source)


if __name__ == "__main__":
    main()
