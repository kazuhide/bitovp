"""Generate SDK field descriptions and checked writes from the NVENC inventory."""

from dataclasses import dataclass
import re


CODECS = ("H264", "HEVC", "AV1")
INTEGER_TYPE = re.compile(r"(u?)int(8|16|32)_t")
ARRAY_TYPE = re.compile(r"(.+)\[(\d+)\]")

# The C paths are relative to the same session objects FFmpeg passes to NVENC.
# Spell HEVC VUI with its public alias even though the header shares its record.
SCOPES = (
    ("NV_ENC_INITIALIZE_PARAMS", "(*initialize)", "session", CODECS),
    ("NV_ENC_CONFIG", "(*initialize->encodeConfig)", "session", CODECS),
    ("NV_ENC_RC_PARAMS", "initialize->encodeConfig->rcParams", "session", CODECS),
    ("NV_ENC_CONFIG_H264", "initialize->encodeConfig->encodeCodecConfig.h264Config", "session", ("H264",)),
    ("NV_ENC_CONFIG_HEVC", "initialize->encodeConfig->encodeCodecConfig.hevcConfig", "session", ("HEVC",)),
    ("NV_ENC_CONFIG_AV1", "initialize->encodeConfig->encodeCodecConfig.av1Config", "session", ("AV1",)),
    ("NV_ENC_CONFIG_H264_VUI_PARAMETERS",
     "initialize->encodeConfig->encodeCodecConfig.h264Config.h264VUIParameters", "session", ("H264",)),
    ("NV_ENC_CONFIG_HEVC_VUI_PARAMETERS",
     "initialize->encodeConfig->encodeCodecConfig.hevcConfig.hevcVUIParameters", "session", ("HEVC",)),
    ("NV_ENC_PIC_PARAMS", "(*picture)", "picture", CODECS),
    ("NV_ENC_PIC_PARAMS_H264", "picture->codecPicParams.h264PicParams", "picture", ("H264",)),
    ("NV_ENC_PIC_PARAMS_HEVC", "picture->codecPicParams.hevcPicParams", "picture", ("HEVC",)),
    ("NV_ENC_PIC_PARAMS_AV1", "picture->codecPicParams.av1PicParams", "picture", ("AV1",)),
)

# Repeated roots are exposed once, under the public name of their own structure.
SEPARATE_ROOTS = {
    "NV_ENC_CONFIG.rcParams", "NV_ENC_CONFIG.encodeCodecConfig",
    "NV_ENC_CONFIG_H264.h264VUIParameters", "NV_ENC_CONFIG_HEVC.hevcVUIParameters",
    "NV_ENC_PIC_PARAMS.codecPicParams", "NV_ENC_INITIALIZE_PARAMS.encodeConfig",
}

OWNED_ATTACHMENTS = {
    "NV_ENC_CONFIG_AV1.filmGrainParams": "NV_ENC_FILM_GRAIN_PARAMS_AV1",
    "NV_ENC_PIC_PARAMS_AV1.filmGrainParams": "NV_ENC_FILM_GRAIN_PARAMS_AV1",
    "NV_ENC_PIC_PARAMS_HEVC.pMasteringDisplay": "MASTERING_DISPLAY_INFO",
    "NV_ENC_PIC_PARAMS_AV1.pMasteringDisplay": "MASTERING_DISPLAY_INFO",
    "NV_ENC_PIC_PARAMS_HEVC.pMaxCll": "CONTENT_LIGHT_LEVEL",
    "NV_ENC_PIC_PARAMS_AV1.pMaxCll": "CONTENT_LIGHT_LEVEL",
}

AV1_TILE_LIMIT = 64
OWNED_TILE_ARRAYS = {
    f"{owner}.{name}"
    for owner in ("NV_ENC_CONFIG_AV1", "NV_ENC_PIC_PARAMS_AV1")
    for name in ("tileWidths", "tileHeights")
}


def field_roles():
    roles = {}

    def mark(owner, role, reason, *fields):
        for field in fields:
            roles[f"{owner}.{field}"] = {"role": role, "reason": reason}

    mark("NV_ENC_INITIALIZE_PARAMS", "trial_field", "The trial supplies this selector.",
         "encodeGUID", "presetGUID")
    mark("NV_ENC_INITIALIZE_PARAMS", "media_contract", "The frame transport derives this from the verified input.",
         "encodeWidth", "encodeHeight", "darWidth", "darHeight", "frameRateNum", "frameRateDen",
         "bufferFormat", "maxEncodeWidth", "maxEncodeHeight")
    mark("NV_ENC_INITIALIZE_PARAMS", "transport_managed", "Requires a different buffer or output lifecycle.",
         "enableEncodeAsync", "reportSliceOffsets", "enableSubFrameWrite", "enableOutputInVidmem",
         "enableReconFrameOutput", "enableOutputStats", "outputStatsLevel")
    mark("NV_ENC_INITIALIZE_PARAMS", "transport_managed", "The runtime schedules display-order frames with driver PTD.",
         "enablePTD")
    mark("NV_ENC_INITIALIZE_PARAMS", "different_operation", "The motion-estimation operation does not produce the measured bitstream.",
         "enableMEOnlyMode")
    mark("NV_ENC_INITIALIZE_PARAMS", "payload_required", "Requires the external motion-estimation hint adapter.",
         "enableExternalMEHints", "maxMEHintCountsPerBlock")
    mark("NV_ENC_INITIALIZE_PARAMS", "different_operation", "Requires encoder-state save and restore operations.",
         "numStateBuffers")
    mark("NV_ENC_CONFIG", "media_contract", "Requires a supported picture format and frame layout.",
         "monoChromeEncoding", "frameFieldMode")
    mark("NV_ENC_RC_PARAMS", "different_operation", "Requires the application to submit frames through NvEncLookahead.",
         "enableExtLookahead")
    mark("NV_ENC_RC_PARAMS", "different_operation", "The measured transport uses one input view and no alpha plane.",
         "alphaLayerBitrateRatio", "viewBitrateRatios")
    mark("NV_ENC_RC_PARAMS", "sdk_ignored", "The pinned header describes this field as for future use.",
         "vDcQPIndexOffset")

    for codec in CODECS:
        mark(f"NV_ENC_CONFIG_{codec}", "media_contract", "The verified frame transport owns chroma format and bit-depth.",
             "chromaFormatIDC", "inputBitDepth", "outputBitDepth")
        mark(f"NV_ENC_PIC_PARAMS_{codec}", "transport_managed", "Requires application-controlled picture ordering.",
             "displayPOCSyntax", "refPicFlag")
    mark("NV_ENC_CONFIG_H264", "different_operation", "Stereo MVC requires an additional view.",
         "enableStereoMVC")
    mark("NV_ENC_CONFIG_H264", "media_contract", "Separate colour planes require a different frame layout.",
         "separateColourPlaneFlag")
    mark("NV_ENC_CONFIG_HEVC", "different_operation", "The measured transport uses one input view and no alpha plane.",
         "enableAlphaLayerEncoding", "enableMVHEVC", "outputHevc3DReferenceDisplayInfo", "numViews")
    mark("NV_ENC_CONFIG_AV1", "transport_managed", "The Matroska muxer expects the low-overhead OBU framing.",
         "outputAnnexBFormat")
    mark("NV_ENC_PIC_PARAMS", "transport_managed", "The runtime derives frame shape and ordering from the source.",
         "pictureStruct", "pictureType")
    mark("NV_ENC_PIC_PARAMS", "typed_payload", "The runtime sets the map pointer and byte count from sdk.pictures[].qpMap.",
         "qpDeltaMap", "qpDeltaMapSize")
    mark("NV_ENC_PIC_PARAMS", "payload_required", "This value must be derived from a runtime-allocated payload.",
         "meHintCountsPerBlock", "meExternalHints",
         "meHintRefPicDist", "meExternalSbHints", "meSbHintsCount")
    mark("NV_ENC_PIC_PARAMS", "different_operation", "Requires encoder-state save and restore operations.",
         "stateBufferIdx")
    mark("NV_ENC_PIC_PARAMS_H264", "different_operation", "Requires a different frame layout or multiple input views.",
         "colourPlaneId", "h264ExtPicParams")
    mark("NV_ENC_PIC_PARAMS_H264", "payload_required", "Requires an allocated slice index array.",
         "forceIntraSliceCount", "forceIntraSliceIdx")
    mark("NV_ENC_PIC_PARAMS_H264", "sdk_ignored", "Deprecated in the pinned header.",
         "sliceTypeData", "sliceTypeArrayCnt")
    mark("NV_ENC_PIC_PARAMS_HEVC", "different_operation", "Requires multiple views and a view metadata payload.",
         "viewId", "p3DReferenceDisplayInfo")
    mark("NV_ENC_PIC_PARAMS_HEVC", "payload_required", "Requires an allocated slice-type array.",
         "sliceTypeData", "sliceTypeArrayCnt")
    for codec in ("H264", "HEVC"):
        mark(f"NV_ENC_PIC_PARAMS_{codec}", "typed_payload",
             "The runtime prepares the SEI payload table and count from sdk.pictures[].metadata.",
             "seiPayloadArrayCnt", "seiPayloadArray")
    mark("NV_ENC_PIC_PARAMS_AV1", "transport_managed",
         "These flags require application-controlled picture ordering.",
         "goldenFrameFlag", "arfFrameFlag", "arf2FrameFlag", "bwdFrameFlag", "overlayFrameFlag")
    mark("NV_ENC_PIC_PARAMS_AV1", "sdk_ignored", "The pinned header defines this as a placeholder.",
         "showExistingFrameFlag")
    mark("NV_ENC_PIC_PARAMS_AV1", "typed_payload",
         "The runtime prepares the OBU_METADATA payload table and count from sdk.pictures[].metadata.",
         "obuPayloadArrayCnt", "obuPayloadArray")
    mark("NV_ENC_RECONFIGURE_PARAMS", "timed_operation", "The runtime prepares a session copy for the timed reconfigure event.",
         "reInitEncodeParams")
    return roles


FIELD_ROLES = field_roles()

CODEC_FIELDS = {
    "NV_ENC_INITIALIZE_PARAMS.enableWeightedPrediction": ("H264", "HEVC"),
    "NV_ENC_INITIALIZE_PARAMS.splitEncodeMode": ("HEVC", "AV1"),
    "NV_ENC_INITIALIZE_PARAMS.enableUniDirectionalB": ("HEVC",),
    "NV_ENC_RC_PARAMS.yDcQPIndexOffset": ("AV1",),
    "NV_ENC_RC_PARAMS.uDcQPIndexOffset": ("AV1",),
    "NV_ENC_RC_PARAMS.cbQPIndexOffset": ("H264", "HEVC"),
    "NV_ENC_RC_PARAMS.crQPIndexOffset": ("H264", "HEVC"),
}

BOOLEAN_FIELDS = {
    "overscanInfoPresentFlag", "overscanInfo", "videoSignalTypePresentFlag", "videoFullRangeFlag",
    "colourDescriptionPresentFlag", "chromaSampleLocationFlag", "bitstreamRestrictionFlag",
    "timingInfoPresentFlag", "skipClockTimestampInsertion", "ltrTrustMode", "colorRange",
}

CUSTOM_BOUNDS = {
    "NV_ENC_CONFIG.frameIntervalP": (0, 33),
    "NV_ENC_RC_PARAMS.lookaheadDepth": (0, 32),
    "NV_ENC_CONFIG_H264.disableDeblockingFilterIDC": (0, 2),
    "NV_ENC_CONFIG_HEVC.disableDeblockingFilterIDC": (0, 2),
    "NV_ENC_CONFIG_AV1.numTileColumns": (0, AV1_TILE_LIMIT),
    "NV_ENC_CONFIG_AV1.numTileRows": (0, AV1_TILE_LIMIT),
    "NV_ENC_PIC_PARAMS_AV1.numTileColumns": (0, AV1_TILE_LIMIT),
    "NV_ENC_PIC_PARAMS_AV1.numTileRows": (0, AV1_TILE_LIMIT),
    # Mask the three picture flags that operate on ordinary encoded pictures.
    # EOS, save/restore, and reconstructed output use their own transport.
    "NV_ENC_PIC_PARAMS.encodePicFlags": (0, 7),
}
FILM_GRAIN_COUNTS = {"numYPoints": 14, "numCbPoints": 10, "numCrPoints": 10}
RECONFIGURE_RATES = ("averageBitRate", "maxBitRate", "vbvBufferSize")
RECONFIGURE_FLAGS = ("resetEncoder", "forceIDR")

EXCLUDED_ENUM_VALUES = {
    "NV_ENC_TUNING_INFO_UNDEFINED", "NV_ENC_TUNING_INFO_COUNT",
}


@dataclass
class SdkWrite:
    descriptor: dict
    target: str
    cast: str
    attached: str = ""
    guid: bool = False


def profile_choices(guids):
    profiles = [row["name"] for row in guids
                if re.fullmatch(r"NV_ENC_(?:CODEC|H264|HEVC|AV1)_PROFILE_.+_GUID", row["name"])]
    return [{"value": index, "name": name,
             "codecs": list(CODECS) if name.startswith("NV_ENC_CODEC_") else [name.split("_")[2]]}
            for index, name in enumerate(profiles)]


def describe_field(field, key, phase, codecs, kind, enums, profiles):
    width = field.get("bitWidth")
    match = INTEGER_TYPE.fullmatch(kind)
    choices = []
    if key == "NV_ENC_CONFIG.profileGUID":
        choices = profiles
    elif key == "NV_ENC_INITIALIZE_PARAMS.splitEncodeMode":
        choices = enums["NV_ENC_SPLIT_ENCODE_MODE"]
    elif key == "NV_ENC_CONFIG_HEVC.maxCUSize":
        choices = [row for row in enums[kind] if row["name"].endswith(("_AUTOSELECT", "_32x32"))]
    elif field["name"] == "level" and len(codecs) == 1:
        codec = codecs[0]
        choices = [row for row in enums["NV_ENC_LEVEL"]
                   if row["name"].startswith(f"NV_ENC_LEVEL_{codec}_")
                   or codec != "AV1" and row["name"] == "NV_ENC_LEVEL_AUTOSELECT"]
    elif field["name"] == "tier" and len(codecs) == 1:
        choices = [row for row in enums["NV_ENC_LEVEL"] if row["name"].startswith(f"NV_ENC_TIER_{codecs[0]}_")]
    elif key == "NV_ENC_RC_PARAMS.qpMapMode":
        choices = [row.copy() for row in enums[kind] if row["value"] in (0, 1, 2)]
        for choice in choices:
            if choice["value"] == 1:
                choice.update(codecs=["H264"], requires={
                    "NV_ENC_RC_PARAMS.enableAQ": False, "NV_ENC_RC_PARAMS.enableTemporalAQ": False,
                })
    elif kind in enums:
        choices = enums[kind]
    boolean = (width == 1 and field["name"] != "countingType") or field["name"] in BOOLEAN_FIELDS
    if choices:
        minimum, maximum = min(row["value"] for row in choices), max(row["value"] for row in choices)
    elif boolean:
        minimum, maximum = 0, 1
    elif ".filmGrainParams." in key and field["name"] in FILM_GRAIN_COUNTS:
        minimum, maximum = 0, FILM_GRAIN_COUNTS[field["name"]]
    elif key.split("[", 1)[0] in OWNED_TILE_ARRAYS:
        minimum, maximum = 1, (1 << 32) - 1
    elif key in CUSTOM_BOUNDS:
        minimum, maximum = CUSTOM_BOUNDS[key]
    elif match:
        bits = width or int(match[2])
        signed = not match[1] or kind == "uint32_t" and field["name"] in {"qpIntra", "qpInterP", "qpInterB"}
        minimum = -(1 << (bits - 1)) if signed else 0
        maximum = (1 << (bits - int(signed))) - 1
    else:
        raise ValueError(f"unsupported SDK binding type {kind} for {key}")
    descriptor = {
        "field": key, "phase": phase, "codecs": list(CODEC_FIELDS.get(key, codecs)),
        "type": "boolean" if boolean else "integer",
        "minimum": minimum, "maximum": maximum, "sourceLine": field["sourceLine"],
    }
    if choices:
        descriptor["values"] = sorted(set(row["value"] for row in choices))
        descriptor["choices"] = choices
    return descriptor


def sdk_writes(catalog):
    records = {row["name"]: row for row in catalog["types"] if "fields" in row}
    aliases = {row["name"]: row["type"] for row in catalog["aliases"]}
    enums = {row["name"]: [{"name": value["name"], "value": value["value"]} for value in row["values"]
                           if value["name"] not in EXCLUDED_ENUM_VALUES and not value["name"].endswith("_RESERVED")]
             for row in catalog["types"] if "values" in row}
    profiles = profile_choices(catalog["guids"])
    inventory_fields = {
        f"{record['name']}.{field['name']}" for record in records.values() for field in record["fields"]
    }
    if not FIELD_ROLES.keys() <= inventory_fields:
        raise ValueError(f"unrecognized SDK field roles: {sorted(FIELD_ROLES.keys() - inventory_fields)}")

    def visit(owner, prefix, base, phase, codecs, attached=""):
        record = records[aliases.get(owner, owner)]
        for field in record["fields"]:
            member = field["name"]
            key = f"{prefix}.{member}"
            target = f"{base}.{member}"
            if key in SEPARATE_ROOTS or key in FIELD_ROLES:
                continue
            if key in OWNED_ATTACHMENTS:
                yield from visit(OWNED_ATTACHMENTS[key], key, f"(*{target})", phase, codecs, target)
                continue
            if key in OWNED_TILE_ARRAYS:
                for index in range(AV1_TILE_LIMIT):
                    suffix = f"[{index}]"
                    descriptor = describe_field(field, key + suffix, phase, codecs, "uint32_t", enums, profiles)
                    yield SdkWrite(descriptor, target + suffix, "uint32_t", target)
                continue
            if field["classification"] in {"reserved", "runner_managed", "pointer"}:
                continue
            kind = field["type"]
            array = ARRAY_TYPE.fullmatch(kind)
            suffixes = [f"[{index}]" for index in range(int(array[2]))] if array else [""]
            if array:
                kind = array[1]
            for suffix in suffixes:
                nested_record = kind in records or kind in aliases and aliases[kind] in records
                if nested_record and kind != "GUID":
                    yield from visit(kind, key + suffix, target + suffix, phase, codecs, attached)
                    continue
                descriptor = describe_field(field, key + suffix, phase, codecs, kind, enums, profiles)
                yield SdkWrite(descriptor, target + suffix, kind, attached, kind == "GUID")

    writes = sorted(
        (item for owner, base, phase, codecs in SCOPES
         for item in visit(owner, owner, base, phase, codecs)),
        key=lambda write: write.descriptor["field"],
    )
    if len(writes) != len({write.descriptor["field"] for write in writes}):
        raise ValueError("ambiguous SDK field name")
    return writes


def codec_condition(codecs):
    if tuple(codecs) != CODECS:
        return "(" + " || ".join(codec.lower() for codec in codecs) + ")"
    return ""


def reconfigure_bindings(catalog, writes):
    rates = {item.descriptor["field"]: item.descriptor for item in writes}
    result = [dict(rates[f"NV_ENC_RC_PARAMS.{name}"], phase="reconfigure") for name in RECONFIGURE_RATES]
    reconfigure = next(row for row in catalog["types"] if row["name"] == "NV_ENC_RECONFIGURE_PARAMS")
    fields = {row["name"]: row for row in reconfigure["fields"]}
    return result + [describe_field(fields[name], f"NV_ENC_RECONFIGURE_PARAMS.{name}", "reconfigure",
                                    CODECS, fields[name]["type"], {}, []) for name in RECONFIGURE_FLAGS]


def render_write(write):
    row = write.descriptor
    yield f'        if (strcmp(field, "{row["field"]}") == 0) {{'
    allowed = codec_condition(row["codecs"])
    if allowed:
        yield f"            if (!{allowed}) return -1;"
    if write.attached:
        yield f"            if (!{write.attached}) return -1;"
    if write.guid:
        yield "            switch (value) {"
        for choice in row["choices"]:
            yield f'            case {choice["value"]}:'
            allowed = codec_condition(choice["codecs"])
            if allowed:
                yield f"                if (!{allowed}) return -1;"
            yield f'                {write.target} = {choice["name"]};'
            yield "                return 0;"
        yield "            default: return -1;"
        yield "            }"
    else:
        if "values" in row:
            conditions = " && ".join(f"value != {value}" for value in row["values"])
            for choice in row["choices"]:
                allowed = codec_condition(choice.get("codecs", CODECS))
                if allowed:
                    yield f'            if (value == {choice["value"]} && !{allowed}) return -1;'
        else:
            conditions = f'value < {row["minimum"]} || value > {row["maximum"]}'
        yield f"            if ({conditions}) return -1;"
        yield f"            {write.target} = ({write.cast})value;"
        yield "            return 0;"
    yield "        }"


def render_binding_header(writes):
    lines = [
        "/* Generated from the pinned NVENC SDK catalog. Edit sdk_bindings.py. */",
        "#ifndef BITOVP_NVENC_SDK_SETTINGS_H", "#define BITOVP_NVENC_SDK_SETTINGS_H", "",
        "#include <stdint.h>", "#include <string.h>", "#include <ffnvcodec/nvEncodeAPI.h>", "",
        "static inline int bitovp_nvenc_write_field(NV_ENC_INITIALIZE_PARAMS *initialize,",
        "                                          NV_ENC_PIC_PARAMS *picture,",
        "                                          const char *field, int64_t value)",
        "{", "    if (!initialize || !initialize->encodeConfig || !field) return -1;",
    ]
    lines.extend(f"    const int {codec.lower()} = !memcmp(&initialize->encodeGUID, &NV_ENC_CODEC_{codec}_GUID, sizeof(GUID));"
                 for codec in CODECS)
    lines.extend(["    if (!h264 && !hevc && !av1) return -1;", "    if (!picture) {"])
    for phase in ("session", "picture"):
        if phase == "picture":
            lines.append("    } else {")
        for write in writes:
            if write.descriptor["phase"] == phase:
                lines.extend(render_write(write))
    lines.extend(["    }", "    return -1;", "}", "", "#endif", ""])
    return "\n".join(lines)
