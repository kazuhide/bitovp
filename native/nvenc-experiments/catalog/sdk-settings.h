/* Generated from the pinned NVENC SDK catalog. Edit sdk_bindings.py. */
#ifndef BITOVP_NVENC_SDK_SETTINGS_H
#define BITOVP_NVENC_SDK_SETTINGS_H

#include <stdint.h>
#include <string.h>
#include <ffnvcodec/nvEncodeAPI.h>

static inline int bitovp_nvenc_write_field(NV_ENC_INITIALIZE_PARAMS *initialize,
                                          NV_ENC_PIC_PARAMS *picture,
                                          const char *field, int64_t value)
{
    if (!initialize || !initialize->encodeConfig || !field) return -1;
    const int h264 = !memcmp(&initialize->encodeGUID, &NV_ENC_CODEC_H264_GUID, sizeof(GUID));
    const int hevc = !memcmp(&initialize->encodeGUID, &NV_ENC_CODEC_HEVC_GUID, sizeof(GUID));
    const int av1 = !memcmp(&initialize->encodeGUID, &NV_ENC_CODEC_AV1_GUID, sizeof(GUID));
    if (!h264 && !hevc && !av1) return -1;
    if (!picture) {
        if (strcmp(field, "NV_ENC_CONFIG.frameIntervalP") == 0) {
            if (value < 0 || value > 33) return -1;
            (*initialize->encodeConfig).frameIntervalP = (int32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG.gopLength") == 0) {
            if (value < 0 || value > 4294967295) return -1;
            (*initialize->encodeConfig).gopLength = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG.mvPrecision") == 0) {
            if (value != 0 && value != 1 && value != 2 && value != 3) return -1;
            (*initialize->encodeConfig).mvPrecision = (NV_ENC_MV_PRECISION)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG.profileGUID") == 0) {
            switch (value) {
            case 0:
                (*initialize->encodeConfig).profileGUID = NV_ENC_CODEC_PROFILE_AUTOSELECT_GUID;
                return 0;
            case 1:
                if (!(h264)) return -1;
                (*initialize->encodeConfig).profileGUID = NV_ENC_H264_PROFILE_BASELINE_GUID;
                return 0;
            case 2:
                if (!(h264)) return -1;
                (*initialize->encodeConfig).profileGUID = NV_ENC_H264_PROFILE_MAIN_GUID;
                return 0;
            case 3:
                if (!(h264)) return -1;
                (*initialize->encodeConfig).profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;
                return 0;
            case 4:
                if (!(h264)) return -1;
                (*initialize->encodeConfig).profileGUID = NV_ENC_H264_PROFILE_HIGH_10_GUID;
                return 0;
            case 5:
                if (!(h264)) return -1;
                (*initialize->encodeConfig).profileGUID = NV_ENC_H264_PROFILE_HIGH_422_GUID;
                return 0;
            case 6:
                if (!(h264)) return -1;
                (*initialize->encodeConfig).profileGUID = NV_ENC_H264_PROFILE_HIGH_444_GUID;
                return 0;
            case 7:
                if (!(h264)) return -1;
                (*initialize->encodeConfig).profileGUID = NV_ENC_H264_PROFILE_STEREO_GUID;
                return 0;
            case 8:
                if (!(h264)) return -1;
                (*initialize->encodeConfig).profileGUID = NV_ENC_H264_PROFILE_PROGRESSIVE_HIGH_GUID;
                return 0;
            case 9:
                if (!(h264)) return -1;
                (*initialize->encodeConfig).profileGUID = NV_ENC_H264_PROFILE_CONSTRAINED_HIGH_GUID;
                return 0;
            case 10:
                if (!(hevc)) return -1;
                (*initialize->encodeConfig).profileGUID = NV_ENC_HEVC_PROFILE_MAIN_GUID;
                return 0;
            case 11:
                if (!(hevc)) return -1;
                (*initialize->encodeConfig).profileGUID = NV_ENC_HEVC_PROFILE_MAIN10_GUID;
                return 0;
            case 12:
                if (!(hevc)) return -1;
                (*initialize->encodeConfig).profileGUID = NV_ENC_HEVC_PROFILE_FREXT_GUID;
                return 0;
            case 13:
                if (!(av1)) return -1;
                (*initialize->encodeConfig).profileGUID = NV_ENC_AV1_PROFILE_MAIN_GUID;
                return 0;
            default: return -1;
            }
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.chromaSamplePosition") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.chromaSamplePosition = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.colorPrimaries") == 0) {
            if (!(av1)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 4 && value != 5 && value != 6 && value != 7 && value != 8 && value != 9 && value != 10 && value != 11 && value != 12 && value != 22) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.colorPrimaries = (NV_ENC_VUI_COLOR_PRIMARIES)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.colorRange") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.colorRange = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.disableSeqHdr") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.disableSeqHdr = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.enableBitstreamPadding") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.enableBitstreamPadding = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.enableCustomTileConfig") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.enableCustomTileConfig = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.enableDecoderModelInfo") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.enableDecoderModelInfo = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.enableFilmGrainParams") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.enableFilmGrainParams = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.enableFrameIdNumbers") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.enableFrameIdNumbers = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.enableIntraRefresh") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.enableIntraRefresh = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.enableLTR") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.enableLTR = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.enableTemporalSVC") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.enableTemporalSVC = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.enableTimingInfo") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.enableTimingInfo = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.applyGrain") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 1) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).applyGrain = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffLag") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 3) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffLag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffShiftMinus6") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 3) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffShiftMinus6 = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[0]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[10]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[10] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[11]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[11] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[12]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[12] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[13]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[13] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[14]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[14] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[15]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[15] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[16]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[16] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[17]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[17] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[18]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[18] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[19]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[19] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[1]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[20]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[20] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[21]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[21] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[22]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[22] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[23]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[23] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[24]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[24] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[2]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[3]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[4]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[5]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[6]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[7]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[8]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCbPlus128[9]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCbPlus128[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[0]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[10]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[10] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[11]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[11] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[12]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[12] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[13]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[13] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[14]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[14] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[15]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[15] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[16]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[16] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[17]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[17] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[18]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[18] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[19]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[19] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[1]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[20]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[20] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[21]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[21] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[22]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[22] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[23]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[23] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[24]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[24] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[2]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[3]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[4]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[5]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[6]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[7]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[8]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsCrPlus128[9]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsCrPlus128[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[0]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[10]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[10] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[11]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[11] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[12]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[12] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[13]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[13] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[14]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[14] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[15]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[15] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[16]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[16] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[17]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[17] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[18]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[18] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[19]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[19] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[1]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[20]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[20] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[21]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[21] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[22]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[22] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[23]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[23] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[2]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[3]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[4]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[5]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[6]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[7]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[8]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.arCoeffsYPlus128[9]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).arCoeffsYPlus128[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.cbLumaMult") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).cbLumaMult = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.cbMult") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).cbMult = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.cbOffset") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 65535) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).cbOffset = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.chromaScalingFromLuma") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 1) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).chromaScalingFromLuma = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.clipToRestrictedRange") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 1) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).clipToRestrictedRange = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.crLumaMult") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).crLumaMult = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.crMult") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).crMult = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.crOffset") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 65535) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).crOffset = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.grainScaleShift") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 3) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).grainScaleShift = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.grainScalingMinus8") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 3) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).grainScalingMinus8 = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.numCbPoints") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 10) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).numCbPoints = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.numCrPoints") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 10) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).numCrPoints = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.numYPoints") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 14) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).numYPoints = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.overlapFlag") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 1) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).overlapFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbScaling[0]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbScaling[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbScaling[1]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbScaling[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbScaling[2]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbScaling[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbScaling[3]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbScaling[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbScaling[4]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbScaling[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbScaling[5]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbScaling[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbScaling[6]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbScaling[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbScaling[7]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbScaling[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbScaling[8]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbScaling[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbScaling[9]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbScaling[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbValue[0]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbValue[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbValue[1]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbValue[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbValue[2]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbValue[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbValue[3]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbValue[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbValue[4]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbValue[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbValue[5]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbValue[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbValue[6]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbValue[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbValue[7]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbValue[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbValue[8]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbValue[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCbValue[9]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCbValue[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrScaling[0]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrScaling[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrScaling[1]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrScaling[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrScaling[2]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrScaling[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrScaling[3]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrScaling[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrScaling[4]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrScaling[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrScaling[5]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrScaling[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrScaling[6]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrScaling[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrScaling[7]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrScaling[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrScaling[8]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrScaling[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrScaling[9]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrScaling[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrValue[0]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrValue[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrValue[1]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrValue[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrValue[2]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrValue[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrValue[3]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrValue[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrValue[4]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrValue[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrValue[5]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrValue[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrValue[6]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrValue[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrValue[7]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrValue[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrValue[8]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrValue[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointCrValue[9]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointCrValue[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYScaling[0]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYScaling[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYScaling[10]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYScaling[10] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYScaling[11]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYScaling[11] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYScaling[12]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYScaling[12] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYScaling[13]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYScaling[13] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYScaling[1]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYScaling[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYScaling[2]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYScaling[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYScaling[3]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYScaling[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYScaling[4]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYScaling[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYScaling[5]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYScaling[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYScaling[6]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYScaling[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYScaling[7]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYScaling[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYScaling[8]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYScaling[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYScaling[9]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYScaling[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYValue[0]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYValue[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYValue[10]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYValue[10] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYValue[11]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYValue[11] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYValue[12]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYValue[12] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYValue[13]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYValue[13] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYValue[1]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYValue[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYValue[2]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYValue[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYValue[3]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYValue[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYValue[4]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYValue[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYValue[5]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYValue[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYValue[6]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYValue[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYValue[7]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYValue[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYValue[8]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYValue[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.filmGrainParams.pointYValue[9]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*initialize->encodeConfig->encodeCodecConfig.av1Config.filmGrainParams).pointYValue[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.idrPeriod") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.idrPeriod = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.intraRefreshCnt") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.intraRefreshCnt = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.intraRefreshPeriod") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.intraRefreshPeriod = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.level") == 0) {
            if (!(av1)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 3 && value != 4 && value != 5 && value != 6 && value != 7 && value != 8 && value != 9 && value != 10 && value != 11 && value != 12 && value != 13 && value != 14 && value != 15 && value != 16 && value != 17 && value != 18 && value != 19 && value != 20 && value != 21 && value != 22 && value != 23 && value != 24) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.level = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.ltrNumFrames") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.ltrNumFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.matrixCoefficients") == 0) {
            if (!(av1)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 4 && value != 5 && value != 6 && value != 7 && value != 8 && value != 9 && value != 10 && value != 11) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.matrixCoefficients = (NV_ENC_VUI_MATRIX_COEFFS)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.maxNumRefFramesInDPB") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.maxNumRefFramesInDPB = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.maxPartSize") == 0) {
            if (!(av1)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 3 && value != 4 && value != 5) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.maxPartSize = (NV_ENC_AV1_PART_SIZE)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.maxTemporalLayersMinus1") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.maxTemporalLayersMinus1 = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.minPartSize") == 0) {
            if (!(av1)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 3 && value != 4 && value != 5) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.minPartSize = (NV_ENC_AV1_PART_SIZE)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.numBwdRefs") == 0) {
            if (!(av1)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 3 && value != 4 && value != 5 && value != 6 && value != 7) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.numBwdRefs = (NV_ENC_NUM_REF_FRAMES)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.numFwdRefs") == 0) {
            if (!(av1)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 3 && value != 4 && value != 5 && value != 6 && value != 7) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.numFwdRefs = (NV_ENC_NUM_REF_FRAMES)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.numTemporalLayers") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.numTemporalLayers = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.numTileColumns") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 64) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.numTileColumns = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.numTileRows") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 64) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.numTileRows = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.outputMasteringDisplay") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.outputMasteringDisplay = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.outputMaxCll") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.outputMaxCll = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.repeatSeqHdr") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.repeatSeqHdr = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tfLevel") == 0) {
            if (!(av1)) return -1;
            if (value != 0 && value != 4) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tfLevel = (NV_ENC_TEMPORAL_FILTER_LEVEL)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tier") == 0) {
            if (!(av1)) return -1;
            if (value != 0 && value != 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tier = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[0]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[0] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[10]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[10] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[11]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[11] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[12]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[12] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[13]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[13] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[14]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[14] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[15]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[15] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[16]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[16] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[17]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[17] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[18]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[18] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[19]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[19] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[1]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[1] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[20]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[20] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[21]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[21] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[22]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[22] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[23]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[23] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[24]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[24] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[25]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[25] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[26]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[26] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[27]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[27] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[28]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[28] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[29]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[29] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[2]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[2] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[30]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[30] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[31]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[31] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[32]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[32] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[33]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[33] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[34]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[34] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[35]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[35] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[36]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[36] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[37]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[37] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[38]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[38] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[39]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[39] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[3]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[3] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[40]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[40] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[41]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[41] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[42]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[42] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[43]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[43] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[44]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[44] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[45]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[45] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[46]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[46] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[47]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[47] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[48]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[48] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[49]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[49] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[4]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[4] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[50]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[50] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[51]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[51] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[52]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[52] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[53]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[53] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[54]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[54] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[55]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[55] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[56]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[56] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[57]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[57] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[58]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[58] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[59]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[59] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[5]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[5] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[60]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[60] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[61]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[61] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[62]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[62] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[63]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[63] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[6]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[6] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[7]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[7] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[8]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[8] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileHeights[9]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileHeights[9] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[0]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[0] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[10]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[10] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[11]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[11] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[12]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[12] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[13]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[13] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[14]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[14] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[15]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[15] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[16]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[16] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[17]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[17] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[18]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[18] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[19]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[19] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[1]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[1] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[20]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[20] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[21]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[21] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[22]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[22] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[23]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[23] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[24]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[24] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[25]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[25] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[26]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[26] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[27]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[27] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[28]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[28] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[29]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[29] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[2]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[2] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[30]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[30] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[31]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[31] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[32]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[32] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[33]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[33] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[34]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[34] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[35]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[35] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[36]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[36] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[37]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[37] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[38]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[38] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[39]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[39] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[3]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[3] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[40]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[40] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[41]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[41] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[42]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[42] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[43]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[43] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[44]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[44] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[45]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[45] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[46]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[46] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[47]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[47] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[48]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[48] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[49]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[49] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[4]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[4] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[50]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[50] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[51]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[51] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[52]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[52] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[53]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[53] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[54]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[54] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[55]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[55] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[56]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[56] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[57]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[57] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[58]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[58] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[59]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[59] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[5]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[5] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[60]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[60] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[61]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[61] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[62]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[62] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[63]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[63] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[6]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[6] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[7]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[7] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[8]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[8] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.tileWidths[9]") == 0) {
            if (!(av1)) return -1;
            if (!initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.tileWidths[9] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.transferCharacteristics") == 0) {
            if (!(av1)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 4 && value != 5 && value != 6 && value != 7 && value != 8 && value != 9 && value != 10 && value != 11 && value != 12 && value != 13 && value != 14 && value != 15 && value != 16 && value != 17 && value != 18) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.transferCharacteristics = (NV_ENC_VUI_TRANSFER_CHARACTERISTIC)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_AV1.useBFramesAsRef") == 0) {
            if (!(av1)) return -1;
            if (value != 0 && value != 1 && value != 2) return -1;
            initialize->encodeConfig->encodeCodecConfig.av1Config.useBFramesAsRef = (NV_ENC_BFRAME_REF_MODE)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.adaptiveTransformMode") == 0) {
            if (!(h264)) return -1;
            if (value != 0 && value != 1 && value != 2) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.adaptiveTransformMode = (NV_ENC_H264_ADAPTIVE_TRANSFORM_MODE)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.bdirectMode") == 0) {
            if (!(h264)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 3) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.bdirectMode = (NV_ENC_H264_BDIRECT_MODE)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.disableDeblockingFilterIDC") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 2) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.disableDeblockingFilterIDC = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.disableSPSPPS") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.disableSPSPPS = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.disableSVCPrefixNalu") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.disableSVCPrefixNalu = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.enableConstrainedEncoding") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.enableConstrainedEncoding = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.enableFillerDataInsertion") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.enableFillerDataInsertion = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.enableIntraRefresh") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.enableIntraRefresh = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.enableLTR") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.enableLTR = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.enableScalabilityInfoSEI") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.enableScalabilityInfoSEI = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.enableTemporalSVC") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.enableTemporalSVC = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.enableTimeCode") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.enableTimeCode = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.enableVFR") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.enableVFR = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.entropyCodingMode") == 0) {
            if (!(h264)) return -1;
            if (value != 0 && value != 1 && value != 2) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.entropyCodingMode = (NV_ENC_H264_ENTROPY_CODING_MODE)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.fmoMode") == 0) {
            if (!(h264)) return -1;
            if (value != 0 && value != 1 && value != 2) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.fmoMode = (NV_ENC_H264_FMO_MODE)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.hierarchicalBFrames") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.hierarchicalBFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.hierarchicalPFrames") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.hierarchicalPFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.idrPeriod") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.idrPeriod = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.intraRefreshCnt") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.intraRefreshCnt = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.intraRefreshPeriod") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.intraRefreshPeriod = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.level") == 0) {
            if (!(h264)) return -1;
            if (value != 0 && value != 9 && value != 10 && value != 11 && value != 12 && value != 13 && value != 20 && value != 21 && value != 22 && value != 30 && value != 31 && value != 32 && value != 40 && value != 41 && value != 42 && value != 50 && value != 51 && value != 52 && value != 60 && value != 61 && value != 62) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.level = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.ltrNumFrames") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.ltrNumFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.ltrTrustMode") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.ltrTrustMode = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.maxNumRefFrames") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.maxNumRefFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.maxTemporalLayers") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.maxTemporalLayers = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.numRefL0") == 0) {
            if (!(h264)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 3 && value != 4 && value != 5 && value != 6 && value != 7) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.numRefL0 = (NV_ENC_NUM_REF_FRAMES)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.numRefL1") == 0) {
            if (!(h264)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 3 && value != 4 && value != 5 && value != 6 && value != 7) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.numRefL1 = (NV_ENC_NUM_REF_FRAMES)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.numTemporalLayers") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.numTemporalLayers = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.outputAUD") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.outputAUD = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.outputBufferingPeriodSEI") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.outputBufferingPeriodSEI = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.outputFramePackingSEI") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.outputFramePackingSEI = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.outputPictureTimingSEI") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.outputPictureTimingSEI = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.outputRecoveryPointSEI") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.outputRecoveryPointSEI = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.ppsId") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.ppsId = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.qpPrimeYZeroTransformBypassFlag") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.qpPrimeYZeroTransformBypassFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.repeatSPSPPS") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.repeatSPSPPS = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.singleSliceIntraRefresh") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.singleSliceIntraRefresh = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.sliceMode") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.sliceMode = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.sliceModeData") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.sliceModeData = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.spsId") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.spsId = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.stereoMode") == 0) {
            if (!(h264)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 3 && value != 4 && value != 5 && value != 6) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.stereoMode = (NV_ENC_STEREO_PACKING_MODE)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.tfLevel") == 0) {
            if (!(h264)) return -1;
            if (value != 0 && value != 4) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.tfLevel = (NV_ENC_TEMPORAL_FILTER_LEVEL)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.useBFramesAsRef") == 0) {
            if (!(h264)) return -1;
            if (value != 0 && value != 1 && value != 2) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.useBFramesAsRef = (NV_ENC_BFRAME_REF_MODE)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264.useConstrainedIntraPred") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.useConstrainedIntraPred = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264_VUI_PARAMETERS.bitstreamRestrictionFlag") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.h264VUIParameters.bitstreamRestrictionFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264_VUI_PARAMETERS.chromaSampleLocationBot") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.h264VUIParameters.chromaSampleLocationBot = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264_VUI_PARAMETERS.chromaSampleLocationFlag") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.h264VUIParameters.chromaSampleLocationFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264_VUI_PARAMETERS.chromaSampleLocationTop") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.h264VUIParameters.chromaSampleLocationTop = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264_VUI_PARAMETERS.colourDescriptionPresentFlag") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.h264VUIParameters.colourDescriptionPresentFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264_VUI_PARAMETERS.colourMatrix") == 0) {
            if (!(h264)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 4 && value != 5 && value != 6 && value != 7 && value != 8 && value != 9 && value != 10 && value != 11) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.h264VUIParameters.colourMatrix = (NV_ENC_VUI_MATRIX_COEFFS)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264_VUI_PARAMETERS.colourPrimaries") == 0) {
            if (!(h264)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 4 && value != 5 && value != 6 && value != 7 && value != 8 && value != 9 && value != 10 && value != 11 && value != 12 && value != 22) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.h264VUIParameters.colourPrimaries = (NV_ENC_VUI_COLOR_PRIMARIES)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264_VUI_PARAMETERS.numUnitInTicks") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.h264VUIParameters.numUnitInTicks = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264_VUI_PARAMETERS.overscanInfo") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.h264VUIParameters.overscanInfo = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264_VUI_PARAMETERS.overscanInfoPresentFlag") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.h264VUIParameters.overscanInfoPresentFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264_VUI_PARAMETERS.timeScale") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.h264VUIParameters.timeScale = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264_VUI_PARAMETERS.timingInfoPresentFlag") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.h264VUIParameters.timingInfoPresentFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264_VUI_PARAMETERS.transferCharacteristics") == 0) {
            if (!(h264)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 4 && value != 5 && value != 6 && value != 7 && value != 8 && value != 9 && value != 10 && value != 11 && value != 12 && value != 13 && value != 14 && value != 15 && value != 16 && value != 17 && value != 18) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.h264VUIParameters.transferCharacteristics = (NV_ENC_VUI_TRANSFER_CHARACTERISTIC)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264_VUI_PARAMETERS.videoFormat") == 0) {
            if (!(h264)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 3 && value != 4 && value != 5) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.h264VUIParameters.videoFormat = (NV_ENC_VUI_VIDEO_FORMAT)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264_VUI_PARAMETERS.videoFullRangeFlag") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.h264VUIParameters.videoFullRangeFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_H264_VUI_PARAMETERS.videoSignalTypePresentFlag") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.h264Config.h264VUIParameters.videoSignalTypePresentFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.disableDeblockAcrossSliceBoundary") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.disableDeblockAcrossSliceBoundary = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.disableDeblockingFilterIDC") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 2) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.disableDeblockingFilterIDC = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.disableSPSPPS") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.disableSPSPPS = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.enableConstrainedEncoding") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.enableConstrainedEncoding = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.enableFillerDataInsertion") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.enableFillerDataInsertion = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.enableIntraRefresh") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.enableIntraRefresh = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.enableLTR") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.enableLTR = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.enableTemporalSVC") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.enableTemporalSVC = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.idrPeriod") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.idrPeriod = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.intraRefreshCnt") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.intraRefreshCnt = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.intraRefreshPeriod") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.intraRefreshPeriod = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.level") == 0) {
            if (!(hevc)) return -1;
            if (value != 0 && value != 30 && value != 60 && value != 63 && value != 90 && value != 93 && value != 120 && value != 123 && value != 150 && value != 153 && value != 156 && value != 180 && value != 183 && value != 186) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.level = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.ltrNumFrames") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.ltrNumFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.ltrTrustMode") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.ltrTrustMode = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.maxCUSize") == 0) {
            if (!(hevc)) return -1;
            if (value != 0 && value != 3) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.maxCUSize = (NV_ENC_HEVC_CUSIZE)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.maxNumRefFramesInDPB") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.maxNumRefFramesInDPB = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.maxTemporalLayersMinus1") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.maxTemporalLayersMinus1 = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.minCUSize") == 0) {
            if (!(hevc)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 3 && value != 4) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.minCUSize = (NV_ENC_HEVC_CUSIZE)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.numRefL0") == 0) {
            if (!(hevc)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 3 && value != 4 && value != 5 && value != 6 && value != 7) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.numRefL0 = (NV_ENC_NUM_REF_FRAMES)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.numRefL1") == 0) {
            if (!(hevc)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 3 && value != 4 && value != 5 && value != 6 && value != 7) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.numRefL1 = (NV_ENC_NUM_REF_FRAMES)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.numTemporalLayers") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.numTemporalLayers = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.outputAUD") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.outputAUD = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.outputBufferingPeriodSEI") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.outputBufferingPeriodSEI = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.outputMasteringDisplay") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.outputMasteringDisplay = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.outputMaxCll") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.outputMaxCll = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.outputPictureTimingSEI") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.outputPictureTimingSEI = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.outputRecoveryPointSEI") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.outputRecoveryPointSEI = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.outputTimeCodeSEI") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.outputTimeCodeSEI = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.ppsId") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.ppsId = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.repeatSPSPPS") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.repeatSPSPPS = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.singleSliceIntraRefresh") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.singleSliceIntraRefresh = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.sliceMode") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.sliceMode = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.sliceModeData") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.sliceModeData = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.spsId") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.spsId = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.tfLevel") == 0) {
            if (!(hevc)) return -1;
            if (value != 0 && value != 4) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.tfLevel = (NV_ENC_TEMPORAL_FILTER_LEVEL)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.tier") == 0) {
            if (!(hevc)) return -1;
            if (value != 0 && value != 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.tier = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.useBFramesAsRef") == 0) {
            if (!(hevc)) return -1;
            if (value != 0 && value != 1 && value != 2) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.useBFramesAsRef = (NV_ENC_BFRAME_REF_MODE)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.useConstrainedIntraPred") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.useConstrainedIntraPred = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC.vpsId") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.vpsId = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.bitstreamRestrictionFlag") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters.bitstreamRestrictionFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.chromaSampleLocationBot") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters.chromaSampleLocationBot = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.chromaSampleLocationFlag") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters.chromaSampleLocationFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.chromaSampleLocationTop") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters.chromaSampleLocationTop = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.colourDescriptionPresentFlag") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters.colourDescriptionPresentFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.colourMatrix") == 0) {
            if (!(hevc)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 4 && value != 5 && value != 6 && value != 7 && value != 8 && value != 9 && value != 10 && value != 11) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters.colourMatrix = (NV_ENC_VUI_MATRIX_COEFFS)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.colourPrimaries") == 0) {
            if (!(hevc)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 4 && value != 5 && value != 6 && value != 7 && value != 8 && value != 9 && value != 10 && value != 11 && value != 12 && value != 22) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters.colourPrimaries = (NV_ENC_VUI_COLOR_PRIMARIES)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.numUnitInTicks") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters.numUnitInTicks = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.overscanInfo") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters.overscanInfo = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.overscanInfoPresentFlag") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters.overscanInfoPresentFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.timeScale") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters.timeScale = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.timingInfoPresentFlag") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters.timingInfoPresentFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.transferCharacteristics") == 0) {
            if (!(hevc)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 4 && value != 5 && value != 6 && value != 7 && value != 8 && value != 9 && value != 10 && value != 11 && value != 12 && value != 13 && value != 14 && value != 15 && value != 16 && value != 17 && value != 18) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters.transferCharacteristics = (NV_ENC_VUI_TRANSFER_CHARACTERISTIC)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.videoFormat") == 0) {
            if (!(hevc)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 3 && value != 4 && value != 5) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters.videoFormat = (NV_ENC_VUI_VIDEO_FORMAT)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.videoFullRangeFlag") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters.videoFullRangeFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_CONFIG_HEVC_VUI_PARAMETERS.videoSignalTypePresentFlag") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters.videoSignalTypePresentFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_INITIALIZE_PARAMS.enableUniDirectionalB") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            (*initialize).enableUniDirectionalB = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_INITIALIZE_PARAMS.enableWeightedPrediction") == 0) {
            if (!(h264 || hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            (*initialize).enableWeightedPrediction = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_INITIALIZE_PARAMS.splitEncodeMode") == 0) {
            if (!(hevc || av1)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 3 && value != 4 && value != 15) return -1;
            (*initialize).splitEncodeMode = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_INITIALIZE_PARAMS.tuningInfo") == 0) {
            if (value != 1 && value != 2 && value != 3 && value != 4 && value != 5) return -1;
            (*initialize).tuningInfo = (NV_ENC_TUNING_INFO)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.aqStrength") == 0) {
            if (value < 0 || value > 15) return -1;
            initialize->encodeConfig->rcParams.aqStrength = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.averageBitRate") == 0) {
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->rcParams.averageBitRate = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.cbQPIndexOffset") == 0) {
            if (!(h264 || hevc)) return -1;
            if (value < -128 || value > 127) return -1;
            initialize->encodeConfig->rcParams.cbQPIndexOffset = (int8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.constQP.qpInterB") == 0) {
            if (value < -2147483648 || value > 2147483647) return -1;
            initialize->encodeConfig->rcParams.constQP.qpInterB = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.constQP.qpInterP") == 0) {
            if (value < -2147483648 || value > 2147483647) return -1;
            initialize->encodeConfig->rcParams.constQP.qpInterP = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.constQP.qpIntra") == 0) {
            if (value < -2147483648 || value > 2147483647) return -1;
            initialize->encodeConfig->rcParams.constQP.qpIntra = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.crQPIndexOffset") == 0) {
            if (!(h264 || hevc)) return -1;
            if (value < -128 || value > 127) return -1;
            initialize->encodeConfig->rcParams.crQPIndexOffset = (int8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.disableBadapt") == 0) {
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->rcParams.disableBadapt = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.disableIadapt") == 0) {
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->rcParams.disableIadapt = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.enableAQ") == 0) {
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->rcParams.enableAQ = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.enableInitialRCQP") == 0) {
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->rcParams.enableInitialRCQP = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.enableLookahead") == 0) {
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->rcParams.enableLookahead = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.enableMaxQP") == 0) {
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->rcParams.enableMaxQP = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.enableMinQP") == 0) {
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->rcParams.enableMinQP = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.enableNonRefP") == 0) {
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->rcParams.enableNonRefP = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.enableTemporalAQ") == 0) {
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->rcParams.enableTemporalAQ = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.initialRCQP.qpInterB") == 0) {
            if (value < -2147483648 || value > 2147483647) return -1;
            initialize->encodeConfig->rcParams.initialRCQP.qpInterB = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.initialRCQP.qpInterP") == 0) {
            if (value < -2147483648 || value > 2147483647) return -1;
            initialize->encodeConfig->rcParams.initialRCQP.qpInterP = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.initialRCQP.qpIntra") == 0) {
            if (value < -2147483648 || value > 2147483647) return -1;
            initialize->encodeConfig->rcParams.initialRCQP.qpIntra = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.lookaheadDepth") == 0) {
            if (value < 0 || value > 32) return -1;
            initialize->encodeConfig->rcParams.lookaheadDepth = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.lookaheadLevel") == 0) {
            if (value != 0 && value != 1 && value != 2 && value != 3 && value != 15) return -1;
            initialize->encodeConfig->rcParams.lookaheadLevel = (NV_ENC_LOOKAHEAD_LEVEL)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.lowDelayKeyFrameScale") == 0) {
            if (value < 0 || value > 255) return -1;
            initialize->encodeConfig->rcParams.lowDelayKeyFrameScale = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.maxBitRate") == 0) {
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->rcParams.maxBitRate = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.maxQP.qpInterB") == 0) {
            if (value < -2147483648 || value > 2147483647) return -1;
            initialize->encodeConfig->rcParams.maxQP.qpInterB = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.maxQP.qpInterP") == 0) {
            if (value < -2147483648 || value > 2147483647) return -1;
            initialize->encodeConfig->rcParams.maxQP.qpInterP = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.maxQP.qpIntra") == 0) {
            if (value < -2147483648 || value > 2147483647) return -1;
            initialize->encodeConfig->rcParams.maxQP.qpIntra = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.minQP.qpInterB") == 0) {
            if (value < -2147483648 || value > 2147483647) return -1;
            initialize->encodeConfig->rcParams.minQP.qpInterB = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.minQP.qpInterP") == 0) {
            if (value < -2147483648 || value > 2147483647) return -1;
            initialize->encodeConfig->rcParams.minQP.qpInterP = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.minQP.qpIntra") == 0) {
            if (value < -2147483648 || value > 2147483647) return -1;
            initialize->encodeConfig->rcParams.minQP.qpIntra = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.multiPass") == 0) {
            if (value != 0 && value != 1 && value != 2) return -1;
            initialize->encodeConfig->rcParams.multiPass = (NV_ENC_MULTI_PASS)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.qpMapMode") == 0) {
            if (value == 1 && !(h264)) return -1;
            if (value != 0 && value != 1 && value != 2) return -1;
            initialize->encodeConfig->rcParams.qpMapMode = (NV_ENC_QP_MAP_MODE)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.rateControlMode") == 0) {
            if (value != 0 && value != 1 && value != 2) return -1;
            initialize->encodeConfig->rcParams.rateControlMode = (NV_ENC_PARAMS_RC_MODE)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.strictGOPTarget") == 0) {
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->rcParams.strictGOPTarget = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.targetQuality") == 0) {
            if (value < 0 || value > 255) return -1;
            initialize->encodeConfig->rcParams.targetQuality = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.targetQualityLSB") == 0) {
            if (value < 0 || value > 255) return -1;
            initialize->encodeConfig->rcParams.targetQualityLSB = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.temporalLayerQP[0]") == 0) {
            if (value < 0 || value > 255) return -1;
            initialize->encodeConfig->rcParams.temporalLayerQP[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.temporalLayerQP[1]") == 0) {
            if (value < 0 || value > 255) return -1;
            initialize->encodeConfig->rcParams.temporalLayerQP[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.temporalLayerQP[2]") == 0) {
            if (value < 0 || value > 255) return -1;
            initialize->encodeConfig->rcParams.temporalLayerQP[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.temporalLayerQP[3]") == 0) {
            if (value < 0 || value > 255) return -1;
            initialize->encodeConfig->rcParams.temporalLayerQP[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.temporalLayerQP[4]") == 0) {
            if (value < 0 || value > 255) return -1;
            initialize->encodeConfig->rcParams.temporalLayerQP[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.temporalLayerQP[5]") == 0) {
            if (value < 0 || value > 255) return -1;
            initialize->encodeConfig->rcParams.temporalLayerQP[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.temporalLayerQP[6]") == 0) {
            if (value < 0 || value > 255) return -1;
            initialize->encodeConfig->rcParams.temporalLayerQP[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.temporalLayerQP[7]") == 0) {
            if (value < 0 || value > 255) return -1;
            initialize->encodeConfig->rcParams.temporalLayerQP[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.temporallayerIdxMask") == 0) {
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->rcParams.temporallayerIdxMask = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.uDcQPIndexOffset") == 0) {
            if (!(av1)) return -1;
            if (value < -128 || value > 127) return -1;
            initialize->encodeConfig->rcParams.uDcQPIndexOffset = (int8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.vbvBufferSize") == 0) {
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->rcParams.vbvBufferSize = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.vbvInitialDelay") == 0) {
            if (value < 0 || value > 4294967295) return -1;
            initialize->encodeConfig->rcParams.vbvInitialDelay = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.yDcQPIndexOffset") == 0) {
            if (!(av1)) return -1;
            if (value < -128 || value > 127) return -1;
            initialize->encodeConfig->rcParams.yDcQPIndexOffset = (int8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_RC_PARAMS.zeroReorderDelay") == 0) {
            if (value < 0 || value > 1) return -1;
            initialize->encodeConfig->rcParams.zeroReorderDelay = (uint32_t)value;
            return 0;
        }
    } else {
        if (strcmp(field, "NV_ENC_PIC_PARAMS.encodePicFlags") == 0) {
            if (value < 0 || value > 7) return -1;
            (*picture).encodePicFlags = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.enableCustomTileConfig") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.av1PicParams.enableCustomTileConfig = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.errorResilientModeFlag") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.av1PicParams.errorResilientModeFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.applyGrain") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 1) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).applyGrain = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffLag") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 3) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffLag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffShiftMinus6") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 3) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffShiftMinus6 = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[0]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[10]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[10] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[11]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[11] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[12]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[12] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[13]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[13] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[14]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[14] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[15]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[15] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[16]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[16] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[17]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[17] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[18]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[18] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[19]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[19] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[1]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[20]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[20] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[21]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[21] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[22]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[22] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[23]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[23] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[24]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[24] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[2]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[3]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[4]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[5]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[6]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[7]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[8]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCbPlus128[9]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCbPlus128[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[0]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[10]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[10] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[11]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[11] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[12]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[12] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[13]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[13] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[14]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[14] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[15]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[15] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[16]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[16] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[17]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[17] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[18]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[18] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[19]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[19] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[1]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[20]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[20] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[21]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[21] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[22]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[22] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[23]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[23] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[24]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[24] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[2]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[3]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[4]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[5]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[6]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[7]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[8]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsCrPlus128[9]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsCrPlus128[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[0]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[10]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[10] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[11]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[11] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[12]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[12] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[13]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[13] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[14]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[14] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[15]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[15] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[16]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[16] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[17]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[17] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[18]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[18] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[19]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[19] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[1]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[20]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[20] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[21]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[21] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[22]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[22] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[23]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[23] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[2]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[3]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[4]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[5]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[6]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[7]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[8]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.arCoeffsYPlus128[9]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).arCoeffsYPlus128[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.cbLumaMult") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).cbLumaMult = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.cbMult") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).cbMult = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.cbOffset") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).cbOffset = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.chromaScalingFromLuma") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 1) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).chromaScalingFromLuma = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.clipToRestrictedRange") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 1) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).clipToRestrictedRange = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.crLumaMult") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).crLumaMult = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.crMult") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).crMult = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.crOffset") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).crOffset = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.grainScaleShift") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 3) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).grainScaleShift = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.grainScalingMinus8") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 3) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).grainScalingMinus8 = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.numCbPoints") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 10) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).numCbPoints = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.numCrPoints") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 10) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).numCrPoints = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.numYPoints") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 14) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).numYPoints = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.overlapFlag") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 1) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).overlapFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbScaling[0]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbScaling[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbScaling[1]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbScaling[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbScaling[2]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbScaling[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbScaling[3]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbScaling[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbScaling[4]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbScaling[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbScaling[5]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbScaling[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbScaling[6]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbScaling[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbScaling[7]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbScaling[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbScaling[8]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbScaling[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbScaling[9]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbScaling[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbValue[0]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbValue[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbValue[1]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbValue[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbValue[2]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbValue[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbValue[3]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbValue[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbValue[4]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbValue[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbValue[5]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbValue[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbValue[6]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbValue[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbValue[7]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbValue[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbValue[8]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbValue[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCbValue[9]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCbValue[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrScaling[0]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrScaling[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrScaling[1]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrScaling[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrScaling[2]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrScaling[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrScaling[3]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrScaling[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrScaling[4]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrScaling[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrScaling[5]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrScaling[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrScaling[6]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrScaling[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrScaling[7]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrScaling[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrScaling[8]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrScaling[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrScaling[9]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrScaling[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrValue[0]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrValue[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrValue[1]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrValue[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrValue[2]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrValue[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrValue[3]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrValue[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrValue[4]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrValue[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrValue[5]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrValue[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrValue[6]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrValue[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrValue[7]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrValue[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrValue[8]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrValue[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointCrValue[9]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointCrValue[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYScaling[0]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYScaling[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYScaling[10]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYScaling[10] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYScaling[11]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYScaling[11] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYScaling[12]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYScaling[12] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYScaling[13]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYScaling[13] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYScaling[1]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYScaling[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYScaling[2]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYScaling[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYScaling[3]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYScaling[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYScaling[4]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYScaling[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYScaling[5]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYScaling[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYScaling[6]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYScaling[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYScaling[7]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYScaling[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYScaling[8]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYScaling[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYScaling[9]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYScaling[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYValue[0]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYValue[0] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYValue[10]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYValue[10] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYValue[11]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYValue[11] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYValue[12]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYValue[12] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYValue[13]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYValue[13] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYValue[1]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYValue[1] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYValue[2]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYValue[2] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYValue[3]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYValue[3] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYValue[4]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYValue[4] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYValue[5]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYValue[5] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYValue[6]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYValue[6] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYValue[7]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYValue[7] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYValue[8]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYValue[8] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParams.pointYValue[9]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.filmGrainParams) return -1;
            if (value < 0 || value > 255) return -1;
            (*picture->codecPicParams.av1PicParams.filmGrainParams).pointYValue[9] = (uint8_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.filmGrainParamsUpdate") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.av1PicParams.filmGrainParamsUpdate = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.forceIntraRefreshWithFrameCnt") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.forceIntraRefreshWithFrameCnt = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.ltrMarkFrame") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.av1PicParams.ltrMarkFrame = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.ltrMarkFrameIdx") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.ltrMarkFrameIdx = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.ltrUseFrameBitmap") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.ltrUseFrameBitmap = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.ltrUseFrames") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.av1PicParams.ltrUseFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.numTemporalLayers") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.numTemporalLayers = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.numTileColumns") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 64) return -1;
            picture->codecPicParams.av1PicParams.numTileColumns = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.numTileRows") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 64) return -1;
            picture->codecPicParams.av1PicParams.numTileRows = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.pMasteringDisplay.b.x") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.av1PicParams.pMasteringDisplay).b.x = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.pMasteringDisplay.b.y") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.av1PicParams.pMasteringDisplay).b.y = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.pMasteringDisplay.g.x") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.av1PicParams.pMasteringDisplay).g.x = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.pMasteringDisplay.g.y") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.av1PicParams.pMasteringDisplay).g.y = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.pMasteringDisplay.maxLuma") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 4294967295) return -1;
            (*picture->codecPicParams.av1PicParams.pMasteringDisplay).maxLuma = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.pMasteringDisplay.minLuma") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 4294967295) return -1;
            (*picture->codecPicParams.av1PicParams.pMasteringDisplay).minLuma = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.pMasteringDisplay.r.x") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.av1PicParams.pMasteringDisplay).r.x = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.pMasteringDisplay.r.y") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.av1PicParams.pMasteringDisplay).r.y = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.pMasteringDisplay.whitePoint.x") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.av1PicParams.pMasteringDisplay).whitePoint.x = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.pMasteringDisplay.whitePoint.y") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.av1PicParams.pMasteringDisplay).whitePoint.y = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.pMaxCll.maxContentLightLevel") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.pMaxCll) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.av1PicParams.pMaxCll).maxContentLightLevel = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.pMaxCll.maxPicAverageLightLevel") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.pMaxCll) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.av1PicParams.pMaxCll).maxPicAverageLightLevel = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.temporalConfigUpdate") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.av1PicParams.temporalConfigUpdate = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.temporalId") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.temporalId = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileConfigUpdate") == 0) {
            if (!(av1)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.av1PicParams.tileConfigUpdate = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[0]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[0] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[10]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[10] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[11]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[11] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[12]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[12] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[13]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[13] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[14]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[14] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[15]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[15] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[16]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[16] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[17]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[17] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[18]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[18] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[19]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[19] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[1]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[1] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[20]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[20] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[21]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[21] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[22]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[22] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[23]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[23] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[24]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[24] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[25]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[25] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[26]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[26] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[27]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[27] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[28]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[28] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[29]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[29] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[2]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[2] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[30]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[30] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[31]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[31] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[32]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[32] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[33]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[33] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[34]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[34] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[35]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[35] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[36]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[36] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[37]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[37] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[38]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[38] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[39]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[39] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[3]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[3] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[40]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[40] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[41]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[41] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[42]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[42] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[43]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[43] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[44]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[44] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[45]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[45] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[46]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[46] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[47]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[47] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[48]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[48] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[49]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[49] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[4]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[4] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[50]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[50] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[51]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[51] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[52]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[52] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[53]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[53] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[54]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[54] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[55]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[55] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[56]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[56] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[57]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[57] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[58]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[58] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[59]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[59] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[5]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[5] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[60]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[60] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[61]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[61] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[62]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[62] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[63]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[63] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[6]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[6] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[7]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[7] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[8]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[8] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileHeights[9]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileHeights) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileHeights[9] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[0]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[0] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[10]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[10] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[11]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[11] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[12]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[12] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[13]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[13] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[14]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[14] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[15]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[15] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[16]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[16] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[17]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[17] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[18]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[18] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[19]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[19] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[1]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[1] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[20]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[20] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[21]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[21] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[22]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[22] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[23]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[23] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[24]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[24] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[25]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[25] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[26]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[26] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[27]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[27] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[28]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[28] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[29]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[29] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[2]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[2] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[30]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[30] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[31]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[31] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[32]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[32] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[33]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[33] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[34]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[34] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[35]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[35] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[36]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[36] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[37]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[37] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[38]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[38] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[39]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[39] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[3]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[3] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[40]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[40] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[41]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[41] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[42]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[42] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[43]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[43] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[44]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[44] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[45]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[45] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[46]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[46] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[47]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[47] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[48]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[48] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[49]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[49] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[4]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[4] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[50]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[50] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[51]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[51] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[52]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[52] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[53]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[53] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[54]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[54] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[55]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[55] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[56]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[56] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[57]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[57] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[58]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[58] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[59]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[59] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[5]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[5] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[60]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[60] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[61]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[61] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[62]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[62] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[63]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[63] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[6]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[6] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[7]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[7] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[8]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[8] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_AV1.tileWidths[9]") == 0) {
            if (!(av1)) return -1;
            if (!picture->codecPicParams.av1PicParams.tileWidths) return -1;
            if (value < 1 || value > 4294967295) return -1;
            picture->codecPicParams.av1PicParams.tileWidths[9] = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.constrainedFrame") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.h264PicParams.constrainedFrame = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.forceIntraRefreshWithFrameCnt") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.h264PicParams.forceIntraRefreshWithFrameCnt = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.ltrMarkFrame") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.h264PicParams.ltrMarkFrame = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.ltrMarkFrameIdx") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.h264PicParams.ltrMarkFrameIdx = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.ltrUseFrameBitmap") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.h264PicParams.ltrUseFrameBitmap = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.ltrUseFrames") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.h264PicParams.ltrUseFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.sliceMode") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.h264PicParams.sliceMode = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.sliceModeData") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.h264PicParams.sliceModeData = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.sliceModeDataUpdate") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.h264PicParams.sliceModeDataUpdate = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[0].cntDroppedFrames") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[0].cntDroppedFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[0].countingType") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[0].countingType = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[0].discontinuityFlag") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[0].discontinuityFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[0].hoursValue") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 31) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[0].hoursValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[0].minutesValue") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 63) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[0].minutesValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[0].nFrames") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 255) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[0].nFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[0].secondsValue") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 63) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[0].secondsValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[0].timeOffset") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[0].timeOffset = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[1].cntDroppedFrames") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[1].cntDroppedFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[1].countingType") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[1].countingType = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[1].discontinuityFlag") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[1].discontinuityFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[1].hoursValue") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 31) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[1].hoursValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[1].minutesValue") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 63) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[1].minutesValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[1].nFrames") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 255) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[1].nFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[1].secondsValue") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 63) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[1].secondsValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[1].timeOffset") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[1].timeOffset = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[2].cntDroppedFrames") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[2].cntDroppedFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[2].countingType") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[2].countingType = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[2].discontinuityFlag") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[2].discontinuityFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[2].hoursValue") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 31) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[2].hoursValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[2].minutesValue") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 63) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[2].minutesValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[2].nFrames") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 255) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[2].nFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[2].secondsValue") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 63) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[2].secondsValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.clockTimestamp[2].timeOffset") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.h264PicParams.timeCode.clockTimestamp[2].timeOffset = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.displayPicStruct") == 0) {
            if (!(h264)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 3 && value != 4) return -1;
            picture->codecPicParams.h264PicParams.timeCode.displayPicStruct = (NV_ENC_DISPLAY_PIC_STRUCT)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_H264.timeCode.skipClockTimestampInsertion") == 0) {
            if (!(h264)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.h264PicParams.timeCode.skipClockTimestampInsertion = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.constrainedFrame") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.hevcPicParams.constrainedFrame = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.forceIntraRefreshWithFrameCnt") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.hevcPicParams.forceIntraRefreshWithFrameCnt = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.ltrMarkFrame") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.hevcPicParams.ltrMarkFrame = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.ltrMarkFrameIdx") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.hevcPicParams.ltrMarkFrameIdx = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.ltrUseFrameBitmap") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.hevcPicParams.ltrUseFrameBitmap = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.ltrUseFrames") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.hevcPicParams.ltrUseFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.numTemporalLayers") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.hevcPicParams.numTemporalLayers = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.pMasteringDisplay.b.x") == 0) {
            if (!(hevc)) return -1;
            if (!picture->codecPicParams.hevcPicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.hevcPicParams.pMasteringDisplay).b.x = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.pMasteringDisplay.b.y") == 0) {
            if (!(hevc)) return -1;
            if (!picture->codecPicParams.hevcPicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.hevcPicParams.pMasteringDisplay).b.y = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.pMasteringDisplay.g.x") == 0) {
            if (!(hevc)) return -1;
            if (!picture->codecPicParams.hevcPicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.hevcPicParams.pMasteringDisplay).g.x = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.pMasteringDisplay.g.y") == 0) {
            if (!(hevc)) return -1;
            if (!picture->codecPicParams.hevcPicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.hevcPicParams.pMasteringDisplay).g.y = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.pMasteringDisplay.maxLuma") == 0) {
            if (!(hevc)) return -1;
            if (!picture->codecPicParams.hevcPicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 4294967295) return -1;
            (*picture->codecPicParams.hevcPicParams.pMasteringDisplay).maxLuma = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.pMasteringDisplay.minLuma") == 0) {
            if (!(hevc)) return -1;
            if (!picture->codecPicParams.hevcPicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 4294967295) return -1;
            (*picture->codecPicParams.hevcPicParams.pMasteringDisplay).minLuma = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.pMasteringDisplay.r.x") == 0) {
            if (!(hevc)) return -1;
            if (!picture->codecPicParams.hevcPicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.hevcPicParams.pMasteringDisplay).r.x = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.pMasteringDisplay.r.y") == 0) {
            if (!(hevc)) return -1;
            if (!picture->codecPicParams.hevcPicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.hevcPicParams.pMasteringDisplay).r.y = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.pMasteringDisplay.whitePoint.x") == 0) {
            if (!(hevc)) return -1;
            if (!picture->codecPicParams.hevcPicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.hevcPicParams.pMasteringDisplay).whitePoint.x = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.pMasteringDisplay.whitePoint.y") == 0) {
            if (!(hevc)) return -1;
            if (!picture->codecPicParams.hevcPicParams.pMasteringDisplay) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.hevcPicParams.pMasteringDisplay).whitePoint.y = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.pMaxCll.maxContentLightLevel") == 0) {
            if (!(hevc)) return -1;
            if (!picture->codecPicParams.hevcPicParams.pMaxCll) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.hevcPicParams.pMaxCll).maxContentLightLevel = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.pMaxCll.maxPicAverageLightLevel") == 0) {
            if (!(hevc)) return -1;
            if (!picture->codecPicParams.hevcPicParams.pMaxCll) return -1;
            if (value < 0 || value > 65535) return -1;
            (*picture->codecPicParams.hevcPicParams.pMaxCll).maxPicAverageLightLevel = (uint16_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.sliceMode") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.hevcPicParams.sliceMode = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.sliceModeData") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.hevcPicParams.sliceModeData = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.sliceModeDataUpdate") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.hevcPicParams.sliceModeDataUpdate = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.temporalConfigUpdate") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.hevcPicParams.temporalConfigUpdate = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.temporalId") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.hevcPicParams.temporalId = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[0].cntDroppedFrames") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[0].cntDroppedFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[0].countingType") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[0].countingType = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[0].discontinuityFlag") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[0].discontinuityFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[0].hoursValue") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 31) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[0].hoursValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[0].minutesValue") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 63) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[0].minutesValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[0].nFrames") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 255) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[0].nFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[0].secondsValue") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 63) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[0].secondsValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[0].timeOffset") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[0].timeOffset = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[1].cntDroppedFrames") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[1].cntDroppedFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[1].countingType") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[1].countingType = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[1].discontinuityFlag") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[1].discontinuityFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[1].hoursValue") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 31) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[1].hoursValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[1].minutesValue") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 63) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[1].minutesValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[1].nFrames") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 255) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[1].nFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[1].secondsValue") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 63) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[1].secondsValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[1].timeOffset") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[1].timeOffset = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[2].cntDroppedFrames") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[2].cntDroppedFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[2].countingType") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[2].countingType = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[2].discontinuityFlag") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[2].discontinuityFlag = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[2].hoursValue") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 31) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[2].hoursValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[2].minutesValue") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 63) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[2].minutesValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[2].nFrames") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 255) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[2].nFrames = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[2].secondsValue") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 63) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[2].secondsValue = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.clockTimestamp[2].timeOffset") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 4294967295) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.clockTimestamp[2].timeOffset = (uint32_t)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.displayPicStruct") == 0) {
            if (!(hevc)) return -1;
            if (value != 0 && value != 1 && value != 2 && value != 3 && value != 4) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.displayPicStruct = (NV_ENC_DISPLAY_PIC_STRUCT)value;
            return 0;
        }
        if (strcmp(field, "NV_ENC_PIC_PARAMS_HEVC.timeCode.skipClockTimestampInsertion") == 0) {
            if (!(hevc)) return -1;
            if (value < 0 || value > 1) return -1;
            picture->codecPicParams.hevcPicParams.timeCode.skipClockTimestampInsertion = (uint32_t)value;
            return 0;
        }
    }
    return -1;
}

#endif
