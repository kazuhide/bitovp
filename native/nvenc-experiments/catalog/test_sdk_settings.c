#include <sdk-settings.h>

#include <assert.h>
#include <limits.h>

int main(void)
{
    NV_ENC_CONFIG config = {0};
    NV_ENC_INITIALIZE_PARAMS initialize = {0};
    NV_ENC_PIC_PARAMS picture = {0};

    initialize.encodeGUID = NV_ENC_CODEC_H264_GUID;
    initialize.encodeConfig = &config;

    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_RC_PARAMS.enableAQ", 1) == 0);
    assert(config.rcParams.enableAQ == 1);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_RC_PARAMS.enableAQ", 2) < 0);
    assert(config.rcParams.enableAQ == 1);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_RC_PARAMS.enableAQ", 0) == 0);
    assert(config.rcParams.enableAQ == 0);

    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_RC_PARAMS.aqStrength", 15) == 0);
    assert(config.rcParams.aqStrength == 15);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_RC_PARAMS.aqStrength", 16) < 0);
    assert(config.rcParams.aqStrength == 15);

    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_RC_PARAMS.rateControlMode",
                                   NV_ENC_PARAMS_RC_CONSTQP) == 0);
    assert(config.rcParams.rateControlMode == NV_ENC_PARAMS_RC_CONSTQP);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_RC_PARAMS.rateControlMode", 3) < 0);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_RC_PARAMS.qpMapMode", NV_ENC_QP_MAP_EMPHASIS) == 0);
    assert(config.rcParams.qpMapMode == NV_ENC_QP_MAP_EMPHASIS);

    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_RC_PARAMS.constQP.qpInterP", -12) == 0);
    assert(config.rcParams.constQP.qpInterP == UINT32_MAX - 11);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_RC_PARAMS.cbQPIndexOffset", -3) == 0);
    assert(config.rcParams.cbQPIndexOffset == -3);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_RC_PARAMS.temporalLayerQP[7]", 25) == 0);
    assert(config.rcParams.temporalLayerQP[7] == 25);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_RC_PARAMS.temporalLayerQP[8]", 25) < 0);

    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_CONFIG.gopLength", UINT32_MAX) == 0);
    assert(config.gopLength == UINT32_MAX);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_CONFIG.gopLength",
                                   INT64_C(1) + UINT32_MAX) < 0);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_CONFIG.version", 1) < 0);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_INITIALIZE_PARAMS.encodeWidth", 1280) < 0);

    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_CONFIG.profileGUID", 3) == 0);
    assert(memcmp(&config.profileGUID, &NV_ENC_H264_PROFILE_HIGH_GUID, sizeof(GUID)) == 0);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_INITIALIZE_PARAMS.tuningInfo",
                                   NV_ENC_TUNING_INFO_LOW_LATENCY) == 0);
    assert(initialize.tuningInfo == NV_ENC_TUNING_INFO_LOW_LATENCY);

    assert(bitovp_nvenc_write_field(&initialize, NULL,
                                   "NV_ENC_CONFIG_H264_VUI_PARAMETERS.videoFullRangeFlag", 1) == 0);
    assert(config.encodeCodecConfig.h264Config.h264VUIParameters.videoFullRangeFlag == 1);
    assert(bitovp_nvenc_write_field(&initialize, &picture, "NV_ENC_CONFIG.gopLength", 60) < 0);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_PIC_PARAMS.encodePicFlags", 2) < 0);
    assert(bitovp_nvenc_write_field(&initialize, &picture, "NV_ENC_PIC_PARAMS.encodePicFlags", 2) == 0);
    assert(picture.encodePicFlags == NV_ENC_PIC_FLAG_FORCEIDR);
    assert(bitovp_nvenc_write_field(&initialize, &picture, "NV_ENC_PIC_PARAMS.encodePicFlags",
                                   NV_ENC_PIC_FLAG_EOS) < 0);
    assert(picture.encodePicFlags == NV_ENC_PIC_FLAG_FORCEIDR);

    initialize.encodeGUID = NV_ENC_CODEC_HEVC_GUID;
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_RC_PARAMS.qpMapMode", NV_ENC_QP_MAP_EMPHASIS) < 0);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_RC_PARAMS.qpMapMode", NV_ENC_QP_MAP_DELTA) == 0);
    assert(config.rcParams.qpMapMode == NV_ENC_QP_MAP_DELTA);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_CONFIG.profileGUID", 3) < 0);
    assert(bitovp_nvenc_write_field(&initialize, NULL,
                                   "NV_ENC_CONFIG_H264_VUI_PARAMETERS.videoFullRangeFlag", 1) < 0);
    assert(bitovp_nvenc_write_field(&initialize, NULL,
                                   "NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.videoFullRangeFlag", 1) == 0);
    assert(config.encodeCodecConfig.hevcConfig.hevcVUIParameters.videoFullRangeFlag == 1);
    assert(bitovp_nvenc_write_field(&initialize, &picture, "NV_ENC_PIC_PARAMS_HEVC.ltrMarkFrame", 1) == 0);
    assert(picture.codecPicParams.hevcPicParams.ltrMarkFrame == 1);

    MASTERING_DISPLAY_INFO mastering = {0};
    assert(bitovp_nvenc_write_field(&initialize, &picture, "NV_ENC_PIC_PARAMS_HEVC.pMasteringDisplay.r.x", 80) < 0);
    picture.codecPicParams.hevcPicParams.pMasteringDisplay = &mastering;
    assert(bitovp_nvenc_write_field(&initialize, &picture, "NV_ENC_PIC_PARAMS_HEVC.pMasteringDisplay.r.x", 80) == 0);
    assert(mastering.r.x == 80);

    initialize.encodeGUID = NV_ENC_CODEC_AV1_GUID;
    memset(&config.encodeCodecConfig, 0, sizeof(config.encodeCodecConfig));
    memset(&picture.codecPicParams, 0, sizeof(picture.codecPicParams));
    NV_ENC_FILM_GRAIN_PARAMS_AV1 session_grain = {0};
    NV_ENC_FILM_GRAIN_PARAMS_AV1 picture_grain = {0};
    config.encodeCodecConfig.av1Config.filmGrainParams = &session_grain;
    picture.codecPicParams.av1PicParams.filmGrainParams = &picture_grain;
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_CONFIG_AV1.filmGrainParams.numYPoints", 15) < 0);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_CONFIG_AV1.filmGrainParams.numYPoints", 14) == 0);
    assert(session_grain.numYPoints == 14);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYValue[13]", 120) == 0);
    assert(bitovp_nvenc_write_field(&initialize, &picture, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYValue[13]", 30) == 0);
    assert(bitovp_nvenc_write_field(&initialize, &picture, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYValue[14]", 30) < 0);
    assert(session_grain.pointYValue[13] == 120);
    assert(picture_grain.pointYValue[13] == 30);

    uint32_t tile_widths[NV_MAX_TILE_COLS_AV1] = {0};
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_CONFIG_AV1.tileWidths[0]", 1) < 0);
    config.encodeCodecConfig.av1Config.tileWidths = tile_widths;
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_CONFIG_AV1.tileWidths[0]", 0) < 0);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_CONFIG_AV1.tileWidths[0]", 1) == 0);
    assert(bitovp_nvenc_write_field(&initialize, NULL, "NV_ENC_CONFIG_AV1.tileWidths[64]", 1) < 0);
    assert(tile_widths[0] == 1);
    return 0;
}
