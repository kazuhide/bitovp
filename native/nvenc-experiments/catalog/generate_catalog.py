"""Render the Linux NVENC ABI inventory from the pinned nvEncodeAPI.h."""

import argparse
from bisect import bisect_left
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request

from sdk_bindings import FIELD_ROLES, reconfigure_bindings, render_binding_header, sdk_writes


COMMIT = "e844e5b26f46bb77479f063029595293aa8f812d"
HEADER_SHA256 = "4fe4094541ef0f8a13249d97a8692dc5f835a6e9dd42eeadb3e2f7321d54dc7e"
HEADER_URL = (
    f"https://raw.githubusercontent.com/FFmpeg/nv-codec-headers/{COMMIT}/include/ffnvcodec/nvEncodeAPI.h"
)
CATALOG = Path(__file__).with_name("sdk-13.0.json")
BINDING_HEADER = Path(__file__).with_name("sdk-settings.h")
BINDING_TEST = Path(__file__).with_name("test_sdk_settings.c")


def binding(field, option, *, required=False, **limits):
    return {"trialField": field, "ffmpegOption": option, "required": required, **limits}


VBV_LIMITS = {"minimum": 1, "maximum": 2147483647}
FFMPEG_BINDINGS = {
    ("NV_ENC_INITIALIZE_PARAMS", "encodeGUID"): binding(
        "codec", "-c:v", required=True,
        values=["H264", "HEVC", "AV1"],
        ffmpegValues={"H264": "h264_nvenc", "HEVC": "hevc_nvenc", "AV1": "av1_nvenc"},
    ),
    ("NV_ENC_INITIALIZE_PARAMS", "presetGUID"): binding(
        "preset", "-preset", required=True, values=[f"P{i}" for i in range(1, 8)],
        ffmpegConversion="lowercase",
    ),
    ("NV_ENC_INITIALIZE_PARAMS", "tuningInfo"): binding(
        "tuning", "-tune", required=True, values=["HIGH_QUALITY"],
        ffmpegValues={"HIGH_QUALITY": "hq"},
    ),
    ("NV_ENC_CONFIG", "gopLength"): binding(
        "config.gopLength", "-g", required=True, minimum=1, maximum=2147483647, unit="frames",
    ),
    ("NV_ENC_CONFIG", "frameIntervalP"): binding(
        "config.frameIntervalP", "-bf", minimum=1, maximum=5, unit="frames",
        ffmpegConversion="subtract_one",
    ),
    ("NV_ENC_RC_PARAMS", "rateControlMode"): binding(
        "config.rcParams.rateControlMode", "-rc", required=True,
        values=["VBR"], ffmpegValues={"VBR": "vbr"},
    ),
    ("NV_ENC_RC_PARAMS", "averageBitRate"): binding(
        "config.rcParams.averageBitRate", "-b:v", required=True, minimum=1, maximum=4294967295, unit="bps",
    ),
    ("NV_ENC_RC_PARAMS", "maxBitRate"): binding(
        "config.rcParams.maxBitRate", "-maxrate:v", unit="bps",
        atLeastTrialField="config.rcParams.averageBitRate", **VBV_LIMITS,
    ),
    ("NV_ENC_RC_PARAMS", "vbvBufferSize"): binding(
        "config.rcParams.vbvBufferSize", "-bufsize:v", unit="bits", **VBV_LIMITS,
    ),
    ("NV_ENC_RC_PARAMS", "enableAQ"): binding(
        "config.rcParams.enableAQ", "-spatial-aq", values=[False, True], ffmpegConversion="boolean_to_0_or_1",
    ),
    ("NV_ENC_RC_PARAMS", "enableTemporalAQ"): binding(
        "config.rcParams.enableTemporalAQ", "-temporal-aq", values=[False, True],
        ffmpegConversion="boolean_to_0_or_1",
    ),
    ("NV_ENC_RC_PARAMS", "lookaheadDepth"): binding(
        "config.rcParams.lookaheadDepth", "-rc-lookahead", minimum=0, maximum=32, unit="frames",
    ),
}

LIFECYCLE_BY_TYPE = {
    "NV_ENC_INITIALIZE_PARAMS": "initialize",
    "NV_ENC_RECONFIGURE_PARAMS": "reconfigure",
    "NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS": "session",
    "NV_ENC_CAPS_PARAM": "capability_query",
    "NV_ENCODE_API_FUNCTION_LIST": "abi",
}
PICTURE_TYPES = {
    "NV_ENC_PIC_PARAMS",
    "NV_ENC_CODEC_PIC_PARAMS",
    "NV_ENC_SEI_PAYLOAD",
    "NV_ENC_TIME_CODE",
    "NV_ENC_CLOCK_TIMESTAMP_SET",
    "NV_ENC_FILM_GRAIN_PARAMS_AV1",
    "NV_ENC_LOOKAHEAD_PIC_PARAMS",
    "NV_ENC_MEONLY_PARAMS",
    "NV_ENC_RESTORE_ENCODER_STATE_PARAMS",
    "HEVC_3D_REFERENCE_DISPLAY_INFO",
    "CHROMA_POINTS",
    "MASTERING_DISPLAY_INFO",
    "CONTENT_LIGHT_LEVEL",
}
CONFIG_TYPES = {"NV_ENC_CONFIG", "NV_ENC_CODEC_CONFIG", "NV_ENC_RC_PARAMS", "NV_ENC_QP", "NV_ENC_PRESET_CONFIG"}
# The motion-estimation output buffer holds these payloads, whose fields omit I/O annotations.
OUTPUT_ONLY_TYPES = {"NV_ENC_H264_MV_DATA", "NV_ENC_HEVC_MV_DATA", "NV_ENC_MVECTOR"}
OUTPUT_TYPES = OUTPUT_ONLY_TYPES | {
    "NV_ENC_LOCK_BITSTREAM", "NV_ENC_ENCODE_OUT_PARAMS", "NV_ENC_STAT",
    "NV_ENC_SEQUENCE_PARAM_PAYLOAD", "NV_ENC_OUTPUT_STATS_ROW", "NV_ENC_OUTPUT_STATS_BLOCK",
}
RESOURCE_TYPES = {
    "GUID", "NVENC_RECT", "NV_ENC_CREATE_INPUT_BUFFER", "NV_ENC_CREATE_BITSTREAM_BUFFER",
    "NV_ENC_CREATE_MV_BUFFER", "NV_ENC_LOCK_INPUT_BUFFER", "NV_ENC_MAP_INPUT_RESOURCE",
    "NV_ENC_INPUT_RESOURCE_OPENGL_TEX", "NV_ENC_FENCE_POINT_D3D12", "NV_ENC_INPUT_RESOURCE_D3D12",
    "NV_ENC_OUTPUT_RESOURCE_D3D12", "NV_ENC_REGISTER_RESOURCE", "NV_ENC_EVENT_PARAMS",
}
RESERVED_FIELDS = {
    ("NV_ENC_CREATE_BITSTREAM_BUFFER", "bitstreamBufferPtr"),
    ("NV_ENC_INITIALIZE_PARAMS", "privData"),
    ("NV_ENC_INITIALIZE_PARAMS", "privDataSize"),
    ("NV_ENC_PIC_PARAMS_MVC", "priorityID"),
    ("NV_ENC_PIC_PARAMS_H264", "ltrUsageMode"),
    ("NV_ENC_PIC_PARAMS_HEVC", "ltrUsageMode"),
}
RUNNER_FIELDS = {
    "NV_ENC_INITIALIZE_PARAMS": {
        "encodeWidth", "encodeHeight", "darWidth", "darHeight", "frameRateNum",
        "frameRateDen", "bufferFormat",
    },
    "NV_ENC_PIC_PARAMS": {
        "inputWidth", "inputHeight", "inputPitch", "frameIdx", "inputTimeStamp",
        "inputDuration", "bufferFmt",
    },
}
DIRECTION = re.compile(r"^\s*\[(in|out|in\s*,\s*out)\]", re.IGNORECASE)


def children(node, kind):
    return [item for item in node.get("inner", []) if item["kind"] == kind]


def walk(node):
    yield node
    for child in node.get("inner", []):
        yield from walk(child)


def header_declarations(ast):
    for node in ast["inner"]:
        location = node.get("loc", {})
        if "offset" in location and "includedFrom" not in location:
            yield node


def lifecycle(name):
    if name in LIFECYCLE_BY_TYPE:
        return LIFECYCLE_BY_TYPE[name]
    if name in CONFIG_TYPES or name.startswith("NV_ENC_CONFIG_"):
        return "configuration"
    if name in PICTURE_TYPES or name.startswith(("NV_ENC_PIC_PARAMS_", "NVENC_EXTERNAL_ME_")):
        return "picture"
    if name in OUTPUT_TYPES:
        return "output"
    if name in RESOURCE_TYPES:
        return "resource"
    return "auxiliary"


def field_direction(field):
    for node in walk(field):
        if node["kind"] == "TextComment" and (match := DIRECTION.match(node["text"])):
            return {"in": "in", "out": "out"}.get(match[1].lower(), "inout")
    return "unspecified"


def is_pointer(field_type, pointer_aliases):
    spelled = field_type["qualType"]
    return "*" in field_type.get("desugaredQualType", spelled) or any(
        token in pointer_aliases for token in re.findall(r"\b\w+\b", spelled)
    )


def field_classification(key, field_type, direction, phase, pointer_aliases):
    owner, name = key
    if name.lower().startswith("reserved") or key in RESERVED_FIELDS:
        return "reserved"
    if is_pointer(field_type, pointer_aliases):
        return "pointer"
    if key in FFMPEG_BINDINGS:
        return "ffmpeg_vbr_binding"
    if (name in {"version", "apiVersion"} or direction == "out" or owner in OUTPUT_ONLY_TYPES
            or phase in {"resource", "abi", "capability_query"}
            or name in RUNNER_FIELDS.get(owner, ())):
        return "runner_managed"
    if phase == "picture":
        return "per_frame"
    return "inventoried_unbound"


def constant_value(node):
    constants = children(node, "ConstantExpr")
    if len(constants) != 1:
        raise ValueError(f"missing a single evaluated integer for {node['name']}")
    return int(constants[0]["value"])


def enum_values(node, source_line):
    value = -1
    for item in children(node, "EnumConstantDecl"):
        if any(x["kind"] != "FullComment" for x in item.get("inner", [])):
            value = constant_value(item)
        else:
            value += 1
        yield {"name": item["name"], "value": value, "sourceLine": source_line(item)}


def guid_value(node):
    data1, data2, data3, *octets = [
        int(item["value"]) for item in walk(node) if item["kind"] == "IntegerLiteral"
    ]
    if len(octets) != 8 or data1 >> 32 or data2 >> 16 or data3 >> 16:
        raise ValueError(f"unexpected GUID initializer for {node['name']}")
    tail = bytes(octets)
    return f"{data1:08x}-{data2:04x}-{data3:04x}-{tail[:2].hex()}-{tail[2:].hex()}"


def record_fields(name, node, source_line, pointer_aliases):
    phase = lifecycle(name)
    for field in children(node, "FieldDecl"):
        key = (name, field["name"])
        direction = field_direction(field)
        classification = field_classification(key, field["type"], direction, phase, pointer_aliases)
        row = {
            "name": field["name"],
            "type": field["type"]["qualType"],
            "direction": direction,
            "lifecycle": phase,
            "classification": classification,
            "sourceLine": source_line(field),
        }
        if field.get("isBitfield"):
            row["bitWidth"] = constant_value(field)
        if classification == "ffmpeg_vbr_binding":
            row["binding"] = FFMPEG_BINDINGS[key]
        yield row


def render_catalog(ast, header):
    newline_offsets = [match.start() for match in re.finditer(b"\n", header)]

    def source_line(node):
        return bisect_left(newline_offsets, node["loc"]["offset"]) + 1

    declarations = list(header_declarations(ast))
    records = {
        f"{node.get('tagUsed', 'enum')} {node['name']}": node
        for node in declarations
        if node["kind"] == "EnumDecl" or node["kind"] == "RecordDecl" and node.get("completeDefinition")
    }
    typedefs = {
        node["name"]: node for node in declarations if node["kind"] == "TypedefDecl"
    }
    type_nodes = {
        name: records[node["type"]["qualType"]]
        for name, node in typedefs.items() if node["type"]["qualType"] in records
    }
    if {node["id"] for node in records.values()} != {node["id"] for node in type_nodes.values()}:
        raise ValueError("a public struct, union, or enum is missing its typedef")
    pointer_aliases = {
        name for name, node in typedefs.items() if is_pointer(node["type"], ())
    }
    macros = set(re.findall(rb"^#define[ \t]+([A-Z0-9_]+)", header, re.MULTILINE))
    types = []
    for name, node in sorted(type_nodes.items()):
        kind = node.get("tagUsed", "enum")
        row = {"name": name, "kind": kind, "sourceLine": source_line(node)}
        if kind == "enum":
            row["values"] = list(enum_values(node, source_line))
        else:
            version_macro = f"{name}_VER"
            if version_macro.encode("ascii") in macros:
                row["versionMacro"] = version_macro
            row["fields"] = list(record_fields(name, node, source_line, pointer_aliases))
        types.append(row)
    guids = [
        {"name": node["name"], "value": guid_value(node), "sourceLine": source_line(node)}
        for node in declarations if node["kind"] == "VarDecl" and node["type"]["qualType"] == "const GUID"
    ]
    aliases = [
        {"name": name, "type": node["type"]["qualType"], "sourceLine": source_line(node)}
        for name, node in sorted(typedefs.items()) if name not in type_nodes
    ]
    actual_bindings = {
        (record["name"], field["name"]) for record in types
        for field in record.get("fields", []) if "binding" in field
    }
    if actual_bindings != FFMPEG_BINDINGS.keys():
        raise ValueError("a runner binding references an absent or nonconfigurable header field")
    return {
        "schemaVersion": 1,
        "upstream": {
            "project": "FFmpeg/nv-codec-headers",
            "tag": "n13.0.19.0",
            "commit": COMMIT,
            "sdkVersion": "13.0",
            "url": HEADER_URL,
            "headerSha256": HEADER_SHA256,
        },
        "bindingScope": {
            "runner": "native/nvenc-experiments/runner.py",
            "codecs": ["H264", "HEVC", "AV1"],
            "evidence": "ffmpeg_vbr_argument_mapping",
        },
        "denominator": {
            "structs": sum(row["kind"] == "struct" for row in types),
            "unions": sum(row["kind"] == "union" for row in types),
            "enums": sum(row["kind"] == "enum" for row in types),
            "fields": sum(len(row.get("fields", [])) for row in types),
            "enumValues": sum(len(row.get("values", [])) for row in types),
            "guids": len(guids),
            "aliases": len(aliases),
        },
        "types": types,
        "guids": guids,
        "aliases": aliases,
    }


def compile_header(clang, header):
    with tempfile.TemporaryDirectory(prefix="bitovp-nvenc-catalog-") as scratch:
        path = Path(scratch) / "nvEncodeAPI.h"
        path.write_bytes(header)
        result = subprocess.run(
            [clang, "-x", "c", "-std=c11", "-fsyntax-only", "-fparse-all-comments",
             "-Xclang", "-ast-dump=json", str(path)],
            stdout=subprocess.PIPE,
            check=True,
        )
        return json.loads(result.stdout)


def read_pinned_header(path):
    if path is None:
        with urllib.request.urlopen(HEADER_URL, timeout=30) as request:
            header = request.read(1024 * 1024)
    else:
        header = path.read_bytes()
    digest = hashlib.sha256(header).hexdigest()
    if digest != HEADER_SHA256:
        raise ValueError(f"nvEncodeAPI.h digest is {digest}, expected {HEADER_SHA256}")
    return header


def verify_binding_header(clang, header, bindings):
    with tempfile.TemporaryDirectory(prefix="bitovp-nvenc-bindings-") as scratch:
        root = Path(scratch)
        include = root / "ffnvcodec"
        include.mkdir()
        (include / "nvEncodeAPI.h").write_bytes(header)
        (root / BINDING_HEADER.name).write_bytes(bindings)
        executable = root / "test_sdk_settings"
        subprocess.run(
            [clang, "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", str(root),
             str(BINDING_TEST), "-o", str(executable)], check=True,
        )
        subprocess.run([str(executable)], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify generated files against the pinned header")
    parser.add_argument("--header", type=Path, help="use a local copy of the pinned header")
    parser.add_argument("--clang", default="clang", help="path to the Clang executable")
    parser.add_argument("--output", type=Path, default=CATALOG)
    parser.add_argument("--bindings-output", type=Path, help="generated C header path, beside the catalog by default")
    options = parser.parse_args()
    try:
        header = read_pinned_header(options.header)
        catalog = render_catalog(compile_header(options.clang, header), header)
        writes = sdk_writes(catalog)
        catalog["sdkBindings"] = [item.descriptor for item in writes] + reconfigure_bindings(catalog, writes)
        catalog["sdkLimitations"] = dict(sorted(FIELD_ROLES.items()))
        data = (json.dumps(catalog, indent="\t") + "\n").encode("utf-8")
        binding_path = options.bindings_output or options.output.with_name(BINDING_HEADER.name)
        binding_bytes = render_binding_header(writes).encode("utf-8")
        for path, contents in ((options.output, data), (binding_path, binding_bytes)):
            if options.check:
                if path.read_bytes() != contents:
                    raise ValueError(f"generated file differs from the pinned header: {path}")
            else:
                path.write_bytes(contents)
        if options.check:
            verify_binding_header(options.clang, header, binding_bytes)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"{exc}\n")
    print(f"{options.output.name}: {catalog['denominator']}, {len(catalog['sdkBindings'])} indexed SDK setting paths")


if __name__ == "__main__":
    main()
