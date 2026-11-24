#!/usr/bin/env python3
"""Run one managed encoding trial and a frame-checked VMAF comparison."""

import argparse
import ctypes
import hashlib
import json
import os
import re
import selectors
import shutil
import subprocess
import sys
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from fractions import Fraction
from math import ceil
from pathlib import Path
from stat import S_ISREG
from tempfile import TemporaryDirectory
from time import monotonic, monotonic_ns, perf_counter_ns
from types import ModuleType
from typing import Optional
from uuid import UUID

PROFILE_ID = "official-vmaf-cuda-0.6.1"
SOFTWARE_PROFILE_ID = "official-vmaf-cpu-0.6.1"
MODEL_NAME = "vmaf_v0.6.1.json"
MODEL_SHA256 = "5950d61fa1f861bd45d8149d80539ed9f3376cfc2495b8f0fa8e9f57cb131ee3"
VMAF_V1_PROFILE_ID = "bitovp-vmaf-cuda-1.0.16-3d0h"
VMAF_V1_MODEL_ID = "vmaf_v1.0.16_3d0h"
VMAF_V1_MODEL_SHA256 = "e4cf8c147e1368b35497d772920bc92f98c1ad7853c1033d8a836947f427140e"
VMAF_V1_PROBE_RECEIPT_MARGIN_SECONDS = 2
VMAF_V1_RECEIPT_MARGIN_SECONDS = 15
CODECS = {"H264": "h264", "HEVC": "hevc", "AV1": "av1"}
SOFTWARE_CODECS = {"libx264": "H264", "libx265": "HEVC", "libvpx-vp9": "VP9", "libsvtav1": "AV1"}
SOFTWARE_DECODERS = {
    "H264": ("h264",), "HEVC": ("hevc",), "VP9": ("vp9", "libvpx-vp9"), "AV1": ("libdav1d", "libaom-av1"),
}
MAX_CAPTURE = 12 * 1024 * 1024
MAX_REQUEST = 272 * 1024
MAX_FRAMES = 3600
MAX_FRAME_TIME_BASE = Fraction(1, 1000)
INT32_MAX = (1 << 31) - 1
FORMAT_ALLOWLIST = "mov,matroska,webm"
LOCAL_INPUT = ["-protocol_whitelist", "file", "-format_whitelist", FORMAT_ALLOWLIST]
FFMPEG_ARGS = ["-hide_banner", "-nostats", "-nostdin", "-xerror", "-noauto_conversion_filters"]
NUMERALS = re.compile(r"(?:0|[1-9][0-9]{0,18})\Z")
SDK_VERSION = "13.0"
SDK_RECEIPT_VERSION = 2
SDK_SETTINGS_OPTION = f"-bitovp-nvenc-settings-v{SDK_RECEIPT_VERSION}"
SDK_FIELD_PATH = re.compile(r"NV_ENC_[A-Z0-9_]+(?:\.[A-Za-z_][A-Za-z_0-9]*(?:\[[0-9]+\])?)+\Z")
SDK_CAPABILITY = re.compile(
    rf"^[ \t]+{SDK_SETTINGS_OPTION}[ \t]+[^\n]*\bsdk-receipt-version={SDK_RECEIPT_VERSION}"
    r"[ \t]+sdk-catalog-sha256=([0-9a-f]{64})\b", re.M,
)
SDK_SETTINGS_FILE = "nvenc-settings.tsv"
MAX_SDK_WRITES = 4096
MAX_SDK_BAG_SIZE = 512
MAX_SAFE_INTEGER = (1 << 53) - 1
SDK_QP_MODE = "NV_ENC_RC_PARAMS.qpMapMode"
SDK_QP_MAP_BYTES = {"H264": 8160, "HEVC": 2040, "AV1": 510}
SDK_RECONFIGURATION = {
    "NV_ENC_RC_PARAMS.averageBitRate": int,
    "NV_ENC_RC_PARAMS.maxBitRate": int,
    "NV_ENC_RC_PARAMS.vbvBufferSize": int,
    "NV_ENC_RECONFIGURE_PARAMS.resetEncoder": bool,
    "NV_ENC_RECONFIGURE_PARAMS.forceIDR": bool,
}


class RunnerError(ValueError):
    pass


@dataclass(frozen=True)
class SdkSettings:
    session: tuple[str, ...]
    pictures: tuple[str, ...]

    def manifest_bytes(self):
        return "".join(self.session + self.pictures).encode("ascii")

    def manifest_sha256(self):
        return hashlib.sha256(self.manifest_bytes()).hexdigest()

    def expected_receipt(self):
        return (
            f"bitovp-nvenc-settings-v{SDK_RECEIPT_VERSION}\t{len(self.session)}\t{len(self.pictures)}"
            f"\t{self.manifest_sha256()}\n"
        ).encode("ascii")

    def applied(self):
        return {
            "fieldCount": len(self.session) + len(self.pictures),
            "manifestSha256": self.manifest_sha256(),
        }


@dataclass(frozen=True)
class Trial:
    source_path: Path
    start_frame: int
    frame_count: int
    codec: str
    preset: str
    gop_length: int
    frame_interval_p: Optional[int]
    rate: dict
    measure_vmaf_v1: bool
    sdk: Optional[SdkSettings] = None


@dataclass(frozen=True)
class SoftwareTrial:
    source_path: Path
    start_frame: int
    frame_count: int
    codec: str
    software: dict
    measure_vmaf_v1 = False
    sdk = None


@dataclass(frozen=True)
class RunnerSource:
    """Snapshot passed from the launcher to the compiled implementation."""

    path: Path
    identity: tuple
    contents: bytes
    # An older compiled implementation may still read the alias from the snapshot.
    invocation_path: Path


@dataclass(frozen=True)
class OwnedVmafV1:
    invocation_path: Path
    executable: Path
    identity: tuple
    model_bytes: bytes
    profile: dict


@dataclass(frozen=True)
class Runtime:
    ffmpeg: Path
    ffprobe: Path
    gpu_index: Optional[int]
    model_bytes: bytes
    capabilities: dict
    tool_identities: tuple
    invocation_path: Path
    runner_path: Path
    vmaf_v1: Optional[OwnedVmafV1]
    software_catalog: Optional[ModuleType] = None
    software_decoders: Optional[dict] = None


def fields(value, required, optional=frozenset()):
    if not isinstance(value, dict) or not required <= value.keys() <= required | optional:
        raise RunnerError("INVALID_REQUEST")
    return value


def integer(value, lower, upper, code="INVALID_REQUEST"):
    if type(value) is not int or not lower <= value <= upper:
        raise RunnerError(code)
    return value


def digits(value, code="INVALID_REQUEST"):
    if not isinstance(value, str) or not NUMERALS.fullmatch(value):
        raise RunnerError(code)
    return int(value)


def choice(value, accepted):
    if not isinstance(value, str) or value not in accepted:
        raise RunnerError("INVALID_REQUEST")
    return value


def sdk_write_rows(bag, prefix):
    if not isinstance(bag, dict) or len(bag) > MAX_SDK_BAG_SIZE:
        raise RunnerError("INVALID_REQUEST")
    for key, value in bag.items():
        if (
            not isinstance(key, str) or len(key) > 160 or not SDK_FIELD_PATH.fullmatch(key)
            or (type(value) is not bool and (type(value) is not int or abs(value) > MAX_SAFE_INTEGER))
        ):
            raise RunnerError("INVALID_REQUEST")
    return tuple(f"{prefix}\t{key}\t{int(bag[key])}\n" for key in sorted(bag))


def sdk_reconfiguration_rows(bag, frame_index):
    rows = sdk_write_rows(bag, f"reconfigure\t{frame_index}")
    for key, value in bag.items():
        if type(value) is not SDK_RECONFIGURATION.get(key) or not 0 <= value <= (1 << 32) - 1:
            raise RunnerError("INVALID_REQUEST")
    return rows


def sdk_qp_map_row(value, mode, codec, frame_index):
    if (
        mode == 0 or not isinstance(value, str) or len(value) != 2 * SDK_QP_MAP_BYTES[codec]
        or not re.fullmatch(r"[0-9a-f]+", value)
        or (mode == 1 and any(level > 5 for level in bytes.fromhex(value)))
    ):
        raise RunnerError("INVALID_REQUEST")
    return f"qpmap\t{frame_index}\t{value}\n"


def sdk_metadata_rows(entries, codec, frame_index):
    if not isinstance(entries, list) or len(entries) > 32:
        raise RunnerError("INVALID_REQUEST")
    rows = []
    for entry in entries:
        fields(entry, {"type", "payload"})
        if codec == "AV1":
            metadata_type = integer(entry["type"], 1, 5)
        else:
            metadata_type = integer(entry["type"], 0, (1 << 32) - 1)
        data = entry["payload"]
        if (
            not isinstance(data, str) or not 2 <= len(data) <= 32768 or len(data) % 2
            or not re.fullmatch(r"[0-9a-f]+", data)
        ):
            raise RunnerError("INVALID_REQUEST")
        rows.append(f"metadata\t{frame_index}\t{metadata_type}\t{data}\n")
    return tuple(rows)


def parse_sdk_settings(data, frame_count, codec):
    data = fields(data, {"version"}, {"session", "pictures"})
    choice(data["version"], {SDK_VERSION})
    session_values = data.get("session", {})
    session = sdk_write_rows(session_values, "init")
    qp_mode = integer(session_values.get(SDK_QP_MODE, 0), 0, 2)
    if qp_mode == 1 and codec != "H264":
        raise RunnerError("INVALID_REQUEST")
    pictures = {}
    entries = data.get("pictures", [])
    if not isinstance(entries, list) or len(entries) > frame_count:
        raise RunnerError("INVALID_REQUEST")
    total = len(session)
    has_qp_maps = False
    for entry in entries:
        fields(entry, {"frameIndex"}, {"fields", "reconfigure", "qpMap", "metadata"})
        frame_index = integer(entry["frameIndex"], 0, frame_count - 1)
        rows = sdk_reconfiguration_rows(entry.get("reconfigure", {}), frame_index)
        rows += sdk_write_rows(entry.get("fields", {}), f"picture\t{frame_index}")
        if "qpMap" in entry:
            rows += (sdk_qp_map_row(entry["qpMap"], qp_mode, codec, frame_index),)
            has_qp_maps = True
        rows += sdk_metadata_rows(entry.get("metadata", []), codec, frame_index)
        total += len(rows)
        if not rows or frame_index in pictures or total > MAX_SDK_WRITES:
            raise RunnerError("INVALID_REQUEST")
        pictures[frame_index] = rows
    if not total or bool(qp_mode) != has_qp_maps:
        raise RunnerError("INVALID_REQUEST")
    return SdkSettings(session, tuple(row for frame in sorted(pictures) for row in pictures[frame]))


def parse_trial(request):
    fields(request, {"schemaVersion", "sourcePath", "trial"})
    integer(request["schemaVersion"], 1, 1)
    source = request["sourcePath"]
    if not isinstance(source, str) or not Path(source).is_absolute() or "\0" in source:
        raise RunnerError("INVALID_REQUEST")
    row = request["trial"]
    if isinstance(row, dict) and "software" in row:
        fields(row, {"sourceId", "window", "codec", "software"})
    else:
        fields(row, {"sourceId", "window", "codec", "preset", "tuning", "config"},
               {"additionalScoringProfiles", "sdk"})
    measure_vmaf_v1 = "additionalScoringProfiles" in row
    if measure_vmaf_v1 and row["additionalScoringProfiles"] != [VMAF_V1_PROFILE_ID]:
        raise RunnerError("INVALID_REQUEST")
    if not isinstance(row["sourceId"], str) or not 1 <= len(row["sourceId"]) <= 160:
        raise RunnerError("INVALID_REQUEST")
    window = fields(row["window"], {"timeBase", "startPts", "endPtsExclusive"})
    clock = fields(window["timeBase"], {"num", "den"})
    frame_ticks = Fraction(30 * integer(clock["num"], 1, INT32_MAX), integer(clock["den"], 1, INT32_MAX))
    start = digits(window["startPts"]) * frame_ticks
    end = digits(window["endPtsExclusive"]) * frame_ticks
    count = end - start
    if start.denominator != 1 or end.denominator != 1 or not 1 <= count <= MAX_FRAMES:
        raise RunnerError("UNSUPPORTED_WINDOW")
    if end > INT32_MAX:
        raise RunnerError("UNSUPPORTED_WINDOW")
    if "software" in row:
        software = fields(row["software"], {"encoder", "options"}, {"nativeOptions"})
        encoder = choice(software["encoder"], SOFTWARE_CODECS)
        if row["codec"] != SOFTWARE_CODECS[encoder]:
            raise RunnerError("INVALID_REQUEST")
        return SoftwareTrial(Path(source), int(start), int(count), row["codec"], software)
    codec = choice(row["codec"], CODECS)
    preset = choice(row["preset"], {"P1", "P2", "P3", "P4", "P5", "P6", "P7"})
    choice(row["tuning"], {"HIGH_QUALITY"})
    config = fields(row["config"], {"gopLength", "rcParams"}, {"frameIntervalP"})
    gop = integer(config["gopLength"], 1, INT32_MAX)
    frame_interval = integer(config["frameIntervalP"], 1, 5) if "frameIntervalP" in config else None
    rate = fields(
        config["rcParams"], {"rateControlMode", "averageBitRate"},
        {"maxBitRate", "vbvBufferSize", "enableAQ", "enableTemporalAQ", "lookaheadDepth"},
    )
    choice(rate["rateControlMode"], {"VBR"})
    integer(rate["averageBitRate"], 1, (1 << 32) - 1)
    for key in ("maxBitRate", "vbvBufferSize"):
        if key in rate:
            integer(rate[key], 1, INT32_MAX)
    if "maxBitRate" in rate and rate["maxBitRate"] < rate["averageBitRate"]:
        raise RunnerError("INVALID_REQUEST")
    for key in ("enableAQ", "enableTemporalAQ"):
        if key in rate and type(rate[key]) is not bool:
            raise RunnerError("INVALID_REQUEST")
    if "lookaheadDepth" in rate:
        integer(rate["lookaheadDepth"], 0, 32)
    sdk = parse_sdk_settings(row["sdk"], int(count), codec) if "sdk" in row else None
    return Trial(Path(source), int(start), int(count), codec, preset, gop, frame_interval, rate, measure_vmaf_v1, sdk)


def is_hex_digest(value, length):
    return isinstance(value, str) and len(value) == length and re.fullmatch(r"[0-9a-f]+", value) is not None


def parse_expected_runtime(encoded):
    if encoded is None:
        return None
    expected = fields(json.loads(encoded), {"runtimeId"}, {"additionalScoringProfiles", "nvencSdk"})
    if not is_hex_digest(expected["runtimeId"], 64):
        raise RunnerError("INVALID_REQUEST")
    if "nvencSdk" in expected:
        sdk = fields(expected["nvencSdk"], {"version", "catalogSha256"})
        if sdk["version"] != SDK_VERSION or not is_hex_digest(sdk["catalogSha256"], 64):
            raise RunnerError("INVALID_REQUEST")
    if "additionalScoringProfiles" not in expected:
        return expected
    profiles = expected["additionalScoringProfiles"]
    if not isinstance(profiles, list) or len(profiles) != 1:
        raise RunnerError("INVALID_REQUEST")
    profile = fields(profiles[0], {
        "scoringProfileId", "scorerSha256", "modelSha256", "sourceSha256", "officialRevision", "decoderRuntimeSha256",
    })
    if (
        profile["scoringProfileId"] != VMAF_V1_PROFILE_ID or profile["modelSha256"] != VMAF_V1_MODEL_SHA256
        or not is_hex_digest(profile["scorerSha256"], 64) or not is_hex_digest(profile["sourceSha256"], 64)
        or not is_hex_digest(profile["officialRevision"], 40) or not is_hex_digest(profile["decoderRuntimeSha256"], 64)
    ):
        raise RunnerError("INVALID_REQUEST")
    return expected


def encode_options(trial):
    args = [
        "-c:v", CODECS[trial.codec] + "_nvenc", "-preset", trial.preset.lower(),
        "-tune", "hq", "-rc", "vbr", "-g", str(trial.gop_length),
        "-b:v", str(trial.rate["averageBitRate"]),
    ]
    if trial.frame_interval_p is not None:
        args.extend(["-bf", str(trial.frame_interval_p - 1)])
    options = {
        "maxBitRate": "-maxrate:v", "vbvBufferSize": "-bufsize:v",
        "enableAQ": "-spatial-aq", "enableTemporalAQ": "-temporal-aq", "lookaheadDepth": "-rc-lookahead",
    }
    for name, option in options.items():
        if name in trial.rate:
            args.extend([option, str(int(trial.rate[name]))])
    return args


def capture(args, stage, cwd=None, timeout=15, env=None):
    """Read both pipes to a fixed limit and kill a stalled or oversized subprocess."""
    deadline = monotonic() + timeout
    chunks = {"stdout": bytearray(), "stderr": bytearray()}
    try:
        with subprocess.Popen(
            args, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        ) as process, selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, "stdout")
            selector.register(process.stderr, selectors.EVENT_READ, "stderr")
            try:
                while selector.get_map():
                    remaining = deadline - monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(args, timeout)
                    for event, _ in selector.select(remaining):
                        block = os.read(event.fd, 65536)
                        if not block:
                            selector.unregister(event.fd)
                            continue
                        output = chunks[event.data]
                        if len(output) + len(block) > MAX_CAPTURE:
                            raise RunnerError(stage + "_OUTPUT_LIMIT")
                        output.extend(block)
                if process.wait(timeout=max(0, deadline - monotonic())) != 0:
                    raise RunnerError(stage + "_FAILED")
            finally:
                if process.poll() is None:
                    process.kill()
    except subprocess.TimeoutExpired as error:
        raise RunnerError(stage + "_TIMEOUT") from error
    except OSError as error:
        raise RunnerError(stage + "_UNAVAILABLE") from error
    return tuple(chunks[key].decode("utf-8", errors="replace") for key in ("stdout", "stderr"))


def unsigned_rational(value, code):
    if not isinstance(value, str) or not re.fullmatch(r"[1-9]\d{0,9}/[1-9]\d{0,9}", value):
        raise RunnerError(code)
    return Fraction(value)


def parse_measurement(probe):
    streams = probe.get("streams") if isinstance(probe, dict) else None
    if not isinstance(streams, list) or not all(isinstance(stream, dict) for stream in streams):
        raise RunnerError("INVALID_VIDEO_METADATA")
    video = [stream for stream in streams if stream.get("codec_type") == "video"]
    if len(video) != 1:
        raise RunnerError("UNSUPPORTED_VIDEO_TRACKS")
    stream = video[0]
    properties = {
        "width": 1920, "height": 1080, "pix_fmt": "yuv420p", "sample_aspect_ratio": "1:1",
        "avg_frame_rate": "30/1", "color_range": "tv", "color_space": "bt709",
        "color_transfer": "bt709", "color_primaries": "bt709", "start_pts": 0,
    }
    if any(stream.get(key) != value for key, value in properties.items()):
        raise RunnerError("UNSUPPORTED_VIDEO_FORMAT")
    disposition = stream.get("disposition", {})
    if not isinstance(disposition, dict) or disposition.get("attached_pic") not in (0, None):
        raise RunnerError("UNSUPPORTED_VIDEO_TRACKS")
    if any(side.get("side_data_type") == "Display Matrix" for side in stream.get("side_data_list", [])):
        raise RunnerError("UNSUPPORTED_VIDEO_DISPLAY")
    time_base = unsigned_rational(stream.get("time_base"), "INVALID_VIDEO_CLOCK")
    if time_base > MAX_FRAME_TIME_BASE:
        raise RunnerError("UNSUPPORTED_VIDEO_CLOCK")
    return time_base


def parse_frames(log, label, pixel_format):
    prefix = r"^\[showinfo@" + re.escape(label) + r" @ [^\]]+\]\s+"
    clocks = re.findall(prefix + r"config in time_base:\s*(\d+/\d+)", log, flags=re.MULTILINE)
    if len(clocks) != 1:
        raise RunnerError("INVALID_FRAME_CLOCK")
    time_base = unsigned_rational(clocks[0], "INVALID_FRAME_CLOCK")
    if time_base > MAX_FRAME_TIME_BASE:
        raise RunnerError("UNSUPPORTED_FRAME_CLOCK")
    rows = re.findall(prefix + r"n:\s*(\d+)\s+pts:\s*(-?\d+)\s+(.*)$", log, flags=re.MULTILINE)
    colors = re.findall(
        prefix + r"color_range:(\S+) color_space:(\S+) color_primaries:(\S+) color_trc:(\S+)",
        log, flags=re.MULTILINE,
    )
    if len(colors) != len(rows) or any(color != ("tv", "bt709", "bt709", "bt709") for color in colors):
        raise RunnerError("FRAME_COLOR_CHANGED")
    frames = []
    for expected, (index, pts, attributes) in enumerate(rows):
        geometry = re.search(r"\bfmt:(\S+)\s+.*?\bsar:(\S+)\s+s:(\S+)\s+i:(\S+)\s+iskey:([01])\b", attributes)
        if int(index) != expected or geometry is None:
            raise RunnerError("INVALID_FRAME_METADATA")
        if geometry.groups()[:4] != (pixel_format, "1/1", "1920x1080", "P"):
            raise RunnerError("FRAME_FORMAT_CHANGED")
        frames.append((int(pts), geometry.group(5) == "1"))
    return time_base, frames


def validate_timeline(log, label, start_frame, count, pixel_format):
    time_base, frames = parse_frames(log, label, pixel_format)
    if len(frames) != count:
        raise RunnerError("INCOMPLETE_FRAME_COVERAGE")
    for offset, (pts, _) in enumerate(frames):
        if abs(pts * time_base - Fraction(start_frame + offset, 30)) > time_base / 2:
            raise RunnerError("FRAME_PTS_MISMATCH")
    return tuple(i for i, (_, key) in enumerate(frames) if key)


def parse_packet_sizes(probe):
    packets = probe.get("packets") if isinstance(probe, dict) else None
    if not isinstance(packets, list) or not packets:
        raise RunnerError("INVALID_PACKET_COVERAGE")
    total = 0
    for packet in packets:
        if not isinstance(packet, dict):
            raise RunnerError("INVALID_PACKET_COVERAGE")
        size = digits(packet.get("size"), "INVALID_PACKET_COVERAGE")
        if size == 0:
            raise RunnerError("INVALID_PACKET_COVERAGE")
        total += size
    return total


def observed_gop(probe, frame_count):
    """Report an interval only for consistent key-packet PTS covering the encoded window."""
    clock = unsigned_rational(probe["streams"][0].get("time_base"), "INVALID_PACKET_CLOCK")
    keys = []
    for packet in probe["packets"]:
        flags = packet.get("flags")
        if not isinstance(flags, str):
            return None
        if "K" not in flags:
            continue
        pts = packet.get("pts")
        if type(pts) is not int:
            return None
        seconds = pts * clock
        index = round(seconds * 30)
        if not 0 <= index < frame_count or abs(seconds - Fraction(index, 30)) > clock / 2:
            return None
        keys.append(index)
    keys.sort()
    intervals = {right - left for left, right in zip(keys, keys[1:])}
    if len(intervals) != 1 or keys[0] != 0:
        return None
    interval = next(iter(intervals))
    if interval == 0 or frame_count - keys[-1] > interval:
        return None
    return interval


def read_file(path, limit, stage, *, require_regular=False):
    opener = (lambda name, flags: os.open(name, flags | os.O_NONBLOCK)) if require_regular else None
    with open(path, "rb", opener=opener) as source:
        if require_regular and not S_ISREG(os.fstat(source.fileno()).st_mode):
            raise RunnerError(stage + "_NOT_REGULAR")
        content = source.read(limit + 1)
    if len(content) > limit:
        raise RunnerError(stage + "_SIZE_LIMIT")
    return content


def parse_vmaf(log_path, count):
    payload = json.loads(read_file(log_path, MAX_CAPTURE, "SCORE"), parse_float=Decimal)
    try:
        frames = payload["frames"]
        if not isinstance(frames, list) or len(frames) != count:
            raise RunnerError("INCOMPLETE_SCORE_COVERAGE")
        scores = []
        for index, frame in enumerate(frames):
            if type(frame["frameNum"]) is not int or frame["frameNum"] != index:
                raise RunnerError("INCOMPLETE_SCORE_COVERAGE")
            scores.append(Decimal(str(frame["metrics"]["vmaf"])))
        mean = Decimal(str(payload["pooled_metrics"]["vmaf"]["mean"]))
    except (KeyError, TypeError, ArithmeticError) as error:
        raise RunnerError("INVALID_SCORE") from error
    if any(not score.is_finite() or not 0 <= score <= 100 for score in [mean, *scores]):
        raise RunnerError("INVALID_SCORE")
    if abs(mean - sum(scores) / count) > Decimal("0.000002"):
        raise RunnerError("INCONSISTENT_MEAN_SCORE")
    return float(mean), int((mean * 1000).to_integral_value(rounding=ROUND_HALF_UP)), scores


def executable(name, default):
    path = os.environ.get(name)
    if path is None:
        path = shutil.which(default)
    if path is None:
        raise RunnerError("RUNTIME_TOOL_MISSING")
    resolved = Path(path).resolve(strict=True)
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise RunnerError("RUNTIME_TOOL_MISSING")
    return resolved


def cuda_device(index):
    """Resolve the exact CUDA ordinal, including the existing CUDA_VISIBLE_DEVICES mask."""
    try:
        driver = ctypes.CDLL("libcuda.so.1")
        device = ctypes.c_int()
        raw_uuid = (ctypes.c_ubyte * 16)()
        name = ctypes.create_string_buffer(256)
        if (driver.cuInit(0) or driver.cuDeviceGet(ctypes.byref(device), index)
                or driver.cuDeviceGetUuid_v2(ctypes.byref(raw_uuid), device)
                or driver.cuDeviceGetName(name, len(name), device)):
            raise RunnerError("CUDA_DEVICE_UNAVAILABLE")
    except (OSError, AttributeError) as error:
        raise RunnerError("CUDA_DEVICE_UNAVAILABLE") from error
    return "GPU-" + str(UUID(bytes=bytes(raw_uuid))), name.value.decode("utf-8", errors="replace")


def regular_file_identity(info):
    if not S_ISREG(info.st_mode):
        raise RunnerError("RUNTIME_TOOL_CHANGED")
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def runtime_tool_identity(path):
    try:
        return regular_file_identity(path.lstat())
    except OSError as error:
        raise RunnerError("RUNTIME_TOOL_CHANGED") from error


def require_unchanged_tools(identities, invocation_path, runner_path):
    try:
        current_runner = invocation_path.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise RunnerError("RUNTIME_TOOL_CHANGED") from error
    if current_runner != runner_path or any(
        runtime_tool_identity(path) != identity for path, identity in identities
    ):
        raise RunnerError("RUNTIME_TOOL_CHANGED")


def read_runner_source(invocation_path):
    invocation_path = invocation_path.absolute()
    try:
        path = invocation_path.resolve(strict=True)
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as handle:
            identity = regular_file_identity(os.fstat(handle.fileno()))
            contents = handle.read()
            if len(contents) != identity[2] or regular_file_identity(os.fstat(handle.fileno())) != identity:
                raise RunnerError("RUNTIME_TOOL_CHANGED")
    except (OSError, RuntimeError) as error:
        raise RunnerError("RUNTIME_TOOL_CHANGED") from error
    require_unchanged_tools(((path, identity),), invocation_path, path)
    return RunnerSource(path, identity, contents, invocation_path)


def sha256_file(path, identity):
    digest = hashlib.sha256()
    try:
        # A replacement symlink or FIFO must fail without being followed or blocking.
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as source:
            if regular_file_identity(os.fstat(source.fileno())) != identity:
                raise RunnerError("RUNTIME_TOOL_CHANGED")
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
            if regular_file_identity(os.fstat(source.fileno())) != identity:
                raise RunnerError("RUNTIME_TOOL_CHANGED")
    except OSError as error:
        raise RunnerError("RUNTIME_TOOL_CHANGED") from error
    return digest.hexdigest()


def parse_sdk_probe(report, index, uuid):
    if not isinstance(report, dict) or type(report.get("schemaVersion")) is not int or report["schemaVersion"] != 1:
        raise RunnerError("INVALID_NVENC_PROBE")
    if type(report.get("deviceIndex")) is not int or report["deviceIndex"] != index or report.get("gpuUuid") != uuid:
        raise RunnerError("NVENC_DEVICE_MISMATCH")
    if report.get("sdkApiVersion") != {"major": 13, "minor": 0} or not isinstance(report.get("encoders"), list):
        raise RunnerError("INVALID_NVENC_PROBE")
    runtime_version = integer(report.get("maxNvencApiVersion"), 208, 4294967295, "INVALID_NVENC_PROBE")
    codecs = set()
    for encoder in report["encoders"]:
        if not isinstance(encoder, dict) or "codec" not in encoder:
            raise RunnerError("INVALID_NVENC_PROBE")
        codec = encoder["codec"]
        formats = encoder.get("inputFormats")
        if not isinstance(formats, list) or any(type(value) is not int for value in formats):
            raise RunnerError("INVALID_NVENC_PROBE")
        if codec is not None:
            if not isinstance(codec, str) or codec not in CODECS:
                raise RunnerError("INVALID_NVENC_PROBE")
            if 1 in formats:  # NV_ENC_BUFFER_FORMAT_NV12
                codecs.add(codec)
    return runtime_version, codecs


def matches_owned_cuda_device(device, index, gpu_uuid):
    return (
        isinstance(device, dict)
        and type(device.get("index")) is int
        and device["index"] == index
        and device.get("uuid") == gpu_uuid.removeprefix("GPU-").replace("-", "").lower()
    )


def matches_owned_cuda_driver(reported, driver_version):
    # The owned scorer may append the CUDA driver API version to the NVIDIA release.
    return isinstance(reported, str) and re.fullmatch(
        re.escape(driver_version) + r"(?:;cuda-api=[0-9]+)?", reported,
    ) is not None


def optional_stage_timeout(limit, reserve):
    deadline = os.environ.get("BITOVP_NVENC_RUNNER_DEADLINE_NS")
    if deadline is None:
        return limit
    remaining = (digits(deadline, "VMAF_V1_INVALID_DEADLINE") - monotonic_ns()) / 10**9
    return min(limit, remaining - reserve)


def discover_vmaf_v1(index, gpu_uuid, driver_version, supported_codecs):
    binary = os.environ.get("VMAF_NATIVE_PATH")
    models = os.environ.get("VMAF_MODEL_DIR")
    if not binary or not models or not Path(binary).is_absolute() or not Path(models).is_absolute():
        return None
    invocation = Path(binary)
    try:
        if optional_stage_timeout(8, VMAF_V1_PROBE_RECEIPT_MARGIN_SECONDS) <= 0:
            return None
        tool = executable("VMAF_NATIVE_PATH", "bitovp-vmaf")
        identity = runtime_tool_identity(tool)
        binary_sha = sha256_file(tool, identity)
        model = read_file(
            Path(models) / (VMAF_V1_MODEL_ID + ".json"), 2 * 1024 * 1024,
            "VMAF_V1_MODEL", require_regular=True,
        )
        model_sha = hashlib.sha256(model).hexdigest()
        if model_sha != VMAF_V1_MODEL_SHA256:
            return None
        require_unchanged_tools(((tool, identity),), invocation, tool)
        timeout = optional_stage_timeout(8, VMAF_V1_PROBE_RECEIPT_MARGIN_SECONDS)
        if timeout <= 0:
            return None
        output, _ = capture(
            [str(tool), "--device-info", "--backend", "cuda", "--device", str(index), "--experiment-window"],
            "VMAF_V1_PROBE", timeout=timeout,
        )
        require_unchanged_tools(((tool, identity),), invocation, tool)
        report = json.loads(output)
        device = report["device"]
        native_codecs = report["experimentCudaDecoders"]
        if (
            type(report["schemaVersion"]) is not int or report["schemaVersion"] != 1
            or report["backend"] != "cuda" or report["binarySha256"] != binary_sha
            or not isinstance(native_codecs, list) or not set(supported_codecs) <= set(native_codecs)
            or not matches_owned_cuda_device(device, index, gpu_uuid)
            or device.get("driverVersionKnown") is not True
            or not matches_owned_cuda_driver(device.get("driverVersion"), driver_version)
            or not is_hex_digest(report["sourceSha256"], 64)
            or not is_hex_digest(report["officialSourceRevision"], 40)
            or not is_hex_digest(report["decoderRuntimeSha256"], 64)
        ):
            return None
    except (OSError, ValueError, RuntimeError, TypeError, KeyError):
        # This optional capability cannot stop an otherwise valid v0.6.1 worker.
        return None
    return OwnedVmafV1(invocation, tool, identity, model, {
        "scoringProfileId": VMAF_V1_PROFILE_ID,
        "scorerSha256": binary_sha,
        "modelSha256": model_sha,
        "sourceSha256": report["sourceSha256"],
        "officialRevision": report["officialSourceRevision"],
        "decoderRuntimeSha256": report["decoderRuntimeSha256"],
    })


def discover_sdk_settings(ffmpeg, codecs):
    digests = set()
    for codec in codecs:
        stdout, stderr = capture(
            [str(ffmpeg), "-hide_banner", "-h", "encoder=" + CODECS[codec] + "_nvenc"],
            "NVENC_SETTINGS_PROBE",
        )
        matches = SDK_CAPABILITY.findall(stdout + "\n" + stderr)
        if len(matches) != 1:
            return None
        digests.add(matches[0])
    if len(digests) == 1:
        return {"version": SDK_VERSION, "catalogSha256": digests.pop()}
    return None


def software_library_paths(program):
    """Identify dynamically loaded codec, scorer, decoder and FFmpeg binaries."""
    if sys.platform == "darwin":
        env = {**os.environ, "DYLD_PRINT_LIBRARIES": "1"}
        _, trace = capture([str(program), "-version"], "SOFTWARE_LIBRARY_PROBE", env=env)
        paths = re.findall(r"^dyld\[\d+\]: <[^>]+> (/[^\n]+)$", trace, re.M)
    else:
        env = {**os.environ, "LD_TRACE_LOADED_OBJECTS": "1"}
        trace, _ = capture([str(program), "-version"], "SOFTWARE_LIBRARY_PROBE", env=env)
        if "=> not found" in trace:
            raise RunnerError("INCOMPLETE_SOFTWARE_RUNTIME")
        paths = re.findall(r"(?:=> |^\s*)(/[^\n]+?) \(0x", trace, re.M)
    libraries = re.compile(r"lib(?:avcodec|avformat|avfilter|avutil|swscale|x264|x265|vpx|svtav1enc|vmaf|dav1d|aom)[.-]", re.I)
    return sorted({Path(path).resolve(strict=True) for path in paths if libraries.match(Path(path).name)})


def resolve_software_runtime(runner_source, invocation_path, expected_runtime):
    ffmpeg = executable("BITOVP_SOFTWARE_FFMPEG", "ffmpeg")
    ffprobe = executable("BITOVP_SOFTWARE_FFPROBE", "ffprobe")
    runner_path = runner_source.path
    catalog = read_runner_source(runner_path.with_name("software_catalog.py"))
    # Compile the exact option validation and command-generation bytes we attest.
    module = ModuleType("_bitovp_software_catalog")
    module.__file__ = str(catalog.path)
    exec(compile(catalog.contents, str(catalog.path), "exec", dont_inherit=True), module.__dict__)
    paths = {ffmpeg, ffprobe, *software_library_paths(ffmpeg), *software_library_paths(ffprobe)}
    identities = {path: runtime_tool_identity(path) for path in sorted(paths)}
    hashes = {path: sha256_file(path, identity) for path, identity in identities.items()}
    identities[runner_path] = runner_source.identity
    identities[catalog.path] = catalog.identity
    model_path = Path(os.environ.get("BITOVP_SOFTWARE_VMAF_MODEL",
                                      Path(os.environ.get("VMAF_MODEL_DIR", "/opt/vmaf/model")) / MODEL_NAME))
    model_bytes = read_file(model_path, 2 * 1024 * 1024, "MODEL", require_regular=True)
    if hashlib.sha256(model_bytes).hexdigest() != MODEL_SHA256:
        raise RunnerError("UNEXPECTED_VMAF_MODEL")
    filters, _ = capture([str(ffmpeg), "-hide_banner", "-filters"], "RUNTIME_PROBE")
    filter_names = {parts[1] for line in filters.splitlines() if len(parts := line.split()) >= 2}
    if not {"libvmaf", "showinfo", "trim", "setpts", "settb"} <= filter_names:
        raise RunnerError("INCOMPLETE_SOFTWARE_RUNTIME")

    def help_text(args):
        stdout, stderr = capture(args, "SOFTWARE_ENCODER_PROBE")
        return stdout + "\n" + stderr

    encoders = module.discover_software_encoders(ffmpeg, capture_help=help_text)
    decoders, _ = capture([str(ffmpeg), "-hide_banner", "-decoders"], "RUNTIME_PROBE")
    decode_names = set(re.findall(r"^\s*V\S*\s+(\S+)", decoders, re.M))
    decode_by_codec = {codec: next((name for name in names if name in decode_names), None)
                       for codec, names in SOFTWARE_DECODERS.items()}
    encoders = [entry for entry in encoders if decode_by_codec[entry["codec"]]]
    if not encoders:
        raise RunnerError("INCOMPLETE_SOFTWARE_RUNTIME")
    capabilities = {
        "schemaVersion": 1, "runtimeKind": "software", "softwareEncoders": encoders,
        "supportedCodecs": [entry["codec"] for entry in encoders], "scoringProfileId": SOFTWARE_PROFILE_ID,
        "ffmpegSha256": hashes[ffmpeg], "ffprobeSha256": hashes[ffprobe], "modelSha256": MODEL_SHA256,
        "runnerSha256": hashlib.sha256(runner_source.contents).hexdigest(),
    }
    if sys.platform == "darwin":
        cpu = capture(["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"], "SOFTWARE_CPU_PROBE")[0].strip()
    else:
        with open("/proc/cpuinfo", encoding="utf-8", errors="replace") as info:
            cpu = next((line.strip() for line in info if line.startswith(("model name", "CPU part"))), os.uname().machine)
    fingerprint = {
        "capabilities": capabilities, "decoders": decode_by_codec,
        "catalogImplementationSha256": hashlib.sha256(catalog.contents).hexdigest(),
        "libraries": sorted((path.name, sha) for path, sha in hashes.items() if path not in (ffmpeg, ffprobe)),
        "cpu": cpu, "threads": len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count(),
    }
    require_unchanged_tools(identities.items(), invocation_path, runner_path)
    runtime_id = hashlib.sha256(json.dumps(fingerprint, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if expected_runtime is not None and expected_runtime != {"runtimeId": runtime_id}:
        raise RunnerError("EXPERIMENT_RUNTIME_CHANGED")
    capabilities["runtimeId"] = runtime_id
    return Runtime(ffmpeg, ffprobe, None, model_bytes, capabilities, tuple(identities.items()),
                   invocation_path, runner_path, None, module, decode_by_codec)


def resolve_runtime(runner_source, invocation_path, *, expected_runtime=None, probe_vmaf_v1=True):
    invocation_path = invocation_path.absolute()
    runner_path = runner_source.path
    require_unchanged_tools(((runner_path, runner_source.identity),), invocation_path, runner_path)
    backend = os.environ.get("BITOVP_EXPERIMENTS_BACKEND", "nvenc")
    if backend == "software":
        return resolve_software_runtime(runner_source, invocation_path, expected_runtime)
    if backend != "nvenc":
        raise RunnerError("INVALID_EXPERIMENTS_BACKEND")
    ffmpeg = executable("BITOVP_NVENC_FFMPEG", "ffmpeg")
    ffprobe = executable("BITOVP_NVENC_FFPROBE", "ffprobe")
    sdk_probe = executable("BITOVP_NVENC_SDK_PROBE", str(ffmpeg.with_name("sdk-probe")))
    tool_paths = {
        "ffmpegSha256": ffmpeg,
        "ffprobeSha256": ffprobe,
        "sdkProbeSha256": sdk_probe,
    }
    identities = {path: runtime_tool_identity(path) for path in tool_paths.values()}
    digests = {name: sha256_file(path, identities[path]) for name, path in tool_paths.items()}
    digests["runnerSha256"] = hashlib.sha256(runner_source.contents).hexdigest()
    identities[runner_path] = runner_source.identity
    tool_identities = tuple(identities.items())
    model = Path(os.environ.get(
        "BITOVP_NVENC_VMAF_MODEL", ffmpeg.parent.parent / "share" / "nvenc-experiments" / MODEL_NAME,
    ))
    model_bytes = read_file(model, 2 * 1024 * 1024, "MODEL")
    model_sha = hashlib.sha256(model_bytes).hexdigest()
    if model_sha != MODEL_SHA256:
        raise RunnerError("UNEXPECTED_VMAF_MODEL")
    index = digits(os.environ.get("BITOVP_NVENC_GPU_INDEX", "0"), "INVALID_CUDA_DEVICE")
    if index > 255:
        raise RunnerError("INVALID_CUDA_DEVICE")
    uuid, name = cuda_device(index)
    driver_version, _ = capture(
        ["nvidia-smi", "--id=" + uuid, "--query-gpu=driver_version", "--format=csv,noheader,nounits"],
        "GPU_QUERY",
    )
    if not re.fullmatch(r"\d+\.\d+(?:\.\d+)?", driver_version.strip()):
        raise RunnerError("INVALID_GPU_RUNTIME")
    require_unchanged_tools(tool_identities, invocation_path, runner_path)
    sdk_report, _ = capture([str(sdk_probe), str(index)], "NVENC_PROBE")
    runtime_version, hardware_codecs = parse_sdk_probe(json.loads(sdk_report), index, uuid)
    inventories = []
    for option in ("-encoders", "-decoders", "-filters"):
        listing, _ = capture([str(ffmpeg), "-hide_banner", option], "RUNTIME_PROBE")
        inventories.append({parts[1] for line in listing.splitlines() if len(parts := line.split()) >= 2})
    encoders, decoders, filters = inventories
    codecs = [
        codec for codec, format_name in CODECS.items()
        if codec in hardware_codecs and format_name + "_nvenc" in encoders and format_name + "_cuvid" in decoders
    ]
    if not codecs or not {"scale_cuda", "hwupload", "libvmaf_cuda"} <= filters:
        raise RunnerError("INCOMPLETE_CUDA_RUNTIME")
    require_unchanged_tools(tool_identities, invocation_path, runner_path)
    data = {
        "schemaVersion": 1, "gpuUuid": uuid, "gpuName": name, "driverVersion": driver_version.strip(),
        "supportedCodecs": codecs, "scoringProfileId": PROFILE_ID,
        **digests, "maxNvencApiVersion": runtime_version, "modelSha256": model_sha,
    }
    sdk = discover_sdk_settings(ffmpeg, codecs)
    if expected_runtime is not None and sdk != expected_runtime.get("nvencSdk"):
        raise RunnerError("EXPERIMENT_RUNTIME_CHANGED")
    if sdk is not None:
        data["nvencSdk"] = sdk
    vmaf_v1 = discover_vmaf_v1(index, uuid, data["driverVersion"], codecs) if probe_vmaf_v1 else None
    discovered_profiles = [vmaf_v1.profile] if vmaf_v1 else None
    if expected_runtime is not None:
        # The worker supplied the admitted descriptor. Keep it in the receipt's
        # identity even when only the required runtime can be verified now.
        admitted_profiles = expected_runtime.get("additionalScoringProfiles")
        if admitted_profiles is not None:
            data["additionalScoringProfiles"] = admitted_profiles
        if discovered_profiles != admitted_profiles:
            vmaf_v1 = None
    elif discovered_profiles is not None:
        data["additionalScoringProfiles"] = discovered_profiles
    require_unchanged_tools(tool_identities, invocation_path, runner_path)
    data["runtimeId"] = hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if expected_runtime is not None and data["runtimeId"] != expected_runtime["runtimeId"]:
        raise RunnerError("EXPERIMENT_RUNTIME_CHANGED")
    return Runtime(ffmpeg, ffprobe, index, model_bytes, data, tool_identities, invocation_path, runner_path, vmaf_v1)


def probe_media(runtime, path, options):
    output, _ = capture(
        [str(runtime.ffprobe), "-v", "error", "-print_format", "json", *options, *LOCAL_INPUT, str(path)],
        "MEDIA_PROBE", timeout=45,
    )
    return json.loads(output)


def first_accepted_pts(frame_number, time_base):
    ticks = Fraction(frame_number, 30) / time_base
    # Both neighbors of an exact half-tick satisfy validate_timeline().
    return ceil(ticks - Fraction(1, 2))


def reference_filter(trial, time_base, label):
    start = first_accepted_pts(trial.start_frame, time_base)
    end = first_accepted_pts(trial.start_frame + trial.frame_count, time_base)
    return "trim=start_pts={}:end_pts={},showinfo@{}=checksum=0,settb=1/30,setpts=N".format(start, end, label)


def cuda_args(runtime):
    return ["-init_hw_device", "cuda=experiment:" + str(runtime.gpu_index), "-filter_hw_device", "experiment"]


def check_software_report(log):
    # Some wrappers report rejected native settings as warnings and return success.
    diagnostics = "\n".join(line for line in log.splitlines()
                            if re.match(r"^(?:\[(?:libx26[45]|libvpx-vp9|libsvtav1|out#|vost#)|x265 \[|Svt\[)", line))
    if re.search(
        r"(?:unknown (?:option|parameter)|error (?:parsing|setting) (?:option|parameter)|"
        r"has not been used for any stream|ignoring (?:invalid|unknown|option|parameter)|"
        r"invalid (?:option|parameter|value for)|failed to set (?:option|parameter|\S+ codec control))", diagnostics, re.I,
    ):
        raise RunnerError("SOFTWARE_SETTING_NOT_APPLIED")


def software_pass_options(argv, encoder, number):
    if encoder != "libx265":
        return [*argv, "-passlogfile:v", "pass", "-pass:v", str(number)]
    # Older FFmpeg x265 wrappers expose native params but no -x265-stats AVOption.
    # Merge into the one dictionary: supplying it twice would drop user settings.
    option = "-x265-params:v"
    managed = f"pass={number}:stats=x265-stats"
    if option not in argv:
        return [*argv, option, managed]
    result = list(argv)
    index = result.index(option) + 1
    result[index] += ":" + managed
    return result


def encode(runtime, trial, source, source_time_base, work):
    started = perf_counter_ns()
    output = work / "encoded.mkv"
    input_devices = []
    filters = reference_filter(trial, source_time_base, "encode_ref")
    if isinstance(trial, SoftwareTrial):
        try:
            options = runtime.software_catalog.build_software_options(
                trial.software, trial.codec, runtime.capabilities["softwareEncoders"],
            )
        except ValueError as error:
            raise RunnerError("INVALID_SOFTWARE_SETTING") from error
    else:
        input_devices = cuda_args(runtime)
        filters += ",scale=out_range=limited,format=nv12,hwupload"
        options = encode_options(trial)
    if trial.sdk is not None:
        manifest = work / SDK_SETTINGS_FILE
        manifest.write_bytes(trial.sdk.manifest_bytes())
        options.extend([SDK_SETTINGS_OPTION, str(manifest)])
    argv = [
        str(runtime.ffmpeg), *FFMPEG_ARGS, "-copyts", *input_devices, *LOCAL_INPUT, "-noautorotate", "-i", str(source),
        "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", filters,
        *options, "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709",
        "-color_trc", "bt709", "-fps_mode", "passthrough", "-avoid_negative_ts", "disabled",
        "-frames:v", str(trial.frame_count + 1), "-fs", "1073741824",
    ]
    software = isinstance(trial, SoftwareTrial)
    two_pass = software and trial.software["options"].get("passes") == "2"
    if two_pass:
        encoder = trial.software["encoder"]
        stats = work / ("x265-stats" if encoder == "libx265" else "pass-0.log")
        first_pass = software_pass_options(argv, encoder, 1)
        _, first_log = capture([*first_pass, "-f", "null", "-"], "ENCODE_FIRST_PASS", work, timeout=300)
        check_software_report(first_log)
        validate_timeline(first_log, "encode_ref", trial.start_frame, trial.frame_count, "yuv420p")
        if not stats.is_file() or stats.stat().st_size == 0:
            raise RunnerError("UNSUPPORTED_SOFTWARE_MULTIPASS")
        argv = software_pass_options(argv, encoder, 2)
    _, log = capture([*argv, str(output)], "ENCODE", work, timeout=300)
    elapsed_ms = (perf_counter_ns() - started) // 1000000
    if software:
        check_software_report(log)
    if trial.sdk is not None:
        expected = trial.sdk.expected_receipt()
        try:
            applied = read_file(manifest.with_name(manifest.name + ".receipt"), len(expected), "NVENC_SDK_SETTINGS",
                                require_regular=True)
        except (OSError, RunnerError) as error:
            raise RunnerError("NVENC_SDK_SETTINGS_NOT_APPLIED") from error
        if applied != expected:
            raise RunnerError("NVENC_SDK_SETTINGS_NOT_APPLIED")
    validate_timeline(log, "encode_ref", trial.start_frame, trial.frame_count, "yuv420p")
    return output, elapsed_ms


def score(runtime, trial, source, source_time_base, encoded, work, cuda=None):
    if cuda is None:
        cuda = not isinstance(trial, SoftwareTrial)
    started = perf_counter_ns()
    name = "cuda-score.json" if cuda else "cpu-score.json"
    reference = reference_filter(trial, source_time_base, "score_ref")
    decoder_input = [
        "-hwaccel", "cuda", "-hwaccel_device", "experiment", "-hwaccel_output_format", "cuda",
        "-c:v", CODECS[trial.codec] + "_cuvid",
    ] if cuda else []
    if isinstance(trial, SoftwareTrial):
        decoder_input = ["-c:v", runtime.software_decoders[trial.codec]]
    distorted = "showinfo@distorted=checksum=0,settb=1/30,setpts=N"
    if cuda:
        reference += ",scale=out_range=limited,format=nv12,hwupload,scale_cuda=format=yuv420p"
        distorted += ",scale_cuda=format=yuv420p"
    filter_name = "libvmaf_cuda" if cuda else "libvmaf"
    graph = (
        f"[0:v:0]{distorted}[dist];[1:v:0]{reference}[ref];"
        f"[dist][ref]{filter_name}=model=path={MODEL_NAME}:log_fmt=json:log_path={name}:n_subsample=1:"
        "shortest=1:repeatlast=0[out]"
    )
    _, log = capture(
        [str(runtime.ffmpeg), *FFMPEG_ARGS, "-copyts", *(cuda_args(runtime) if cuda else []),
         *LOCAL_INPUT, *decoder_input, "-i", str(encoded), *LOCAL_INPUT, "-noautorotate", "-i", str(source),
         "-filter_complex", graph, "-map", "[out]", "-an", "-sn", "-dn",
         "-fps_mode", "passthrough", "-c:v", "wrapped_avframe", "-f", "null", "-"],
        "CUDA_SCORE" if cuda else "CPU_SCORE", work, timeout=300,
    )
    elapsed_ms = (perf_counter_ns() - started) // 1000000
    validate_timeline(log, "score_ref", trial.start_frame, trial.frame_count, "yuv420p")
    validate_timeline(log, "distorted", 0, trial.frame_count, "cuda" if cuda else "yuv420p")
    return (*parse_vmaf(work / name, trial.frame_count), elapsed_ms)


def parse_vmaf_v1(payload, runtime, trial, cpu_audit):
    code = "VMAF_V1_INVALID_RECEIPT"
    profile = runtime.vmaf_v1.profile
    try:
        window = payload["experimentWindow"]
        if (
            type(payload["schema"]) is not int or payload["schema"] != 1
            or payload["implementation"] != "bitovp-owned" or payload["backend"] != "cuda"
            or payload["referenceDecodeBackend"] != "cpu" or payload["decodeBackend"] != "cuda"
            or payload["sourceSha256"] != profile["sourceSha256"]
            or payload["officialRevision"] != profile["officialRevision"]
            or payload["decoderRuntimeSha256"] != profile["decoderRuntimeSha256"]
            or not matches_owned_cuda_device(payload["device"], runtime.gpu_index, runtime.capabilities["gpuUuid"])
            or not matches_owned_cuda_driver(payload["gpuDriver"]["driverVersion"], runtime.capabilities["driverVersion"])
            or (payload["width"], payload["height"], payload["bitDepth"]) != (1920, 1080, 8)
            or integer(payload["frames"], 1, MAX_FRAMES, code) != trial.frame_count
            or integer(window["startFrame"], 0, INT32_MAX, code) != trial.start_frame
            or integer(window["frameCount"], 1, MAX_FRAMES, code) != trial.frame_count
        ):
            raise RunnerError(code)
        models = payload["models"]
        if not isinstance(models, list) or len(models) != 1:
            raise RunnerError(code)
        model = models[0]
        if model["id"] != VMAF_V1_MODEL_ID or model["sha256"] != profile["modelSha256"]:
            raise RunnerError(code)
        scores, mean = model["frames"], model["pooled"]["mean"]
        if not isinstance(scores, list) or len(scores) != trial.frame_count:
            raise RunnerError(code)
        if any(type(value) not in (int, Decimal) or not 0 <= value <= 110 for value in [mean, *scores]):
            raise RunnerError(code)
        if abs(mean - sum(map(Decimal, scores)) / trial.frame_count) > Decimal("0.000002"):
            raise RunnerError(code)
        if cpu_audit:
            parity = payload["cpuParity"]
            if (
                parity["checked"] is not True or parity["scoreCount"] != trial.frame_count
                or not parity["featureCount"] or not 0 <= parity["maxScoreError"] <= Decimal("0.0001")
            ):
                raise RunnerError(code)
        return float(mean), int((Decimal(mean) * 1000).to_integral_value(rounding=ROUND_HALF_UP))
    except (KeyError, TypeError, ArithmeticError) as error:
        raise RunnerError(code) from error


def score_vmaf_v1(runtime, trial, source, encoded, work, cpu_audit):
    profile_id = {"scoringProfileId": VMAF_V1_PROFILE_ID}
    scorer = runtime.vmaf_v1
    if scorer is None:
        return {**profile_id, "status": "failed", "failureCode": "VMAF_V1_UNAVAILABLE"}
    try:
        identities = ((scorer.executable, scorer.identity),)
        require_unchanged_tools(identities, scorer.invocation_path, scorer.executable)
        model = work / (VMAF_V1_MODEL_ID + ".json")
        model.write_bytes(scorer.model_bytes)
        receipt = work / "bitovp-vmaf-v1.json"
        timeout = optional_stage_timeout(300, VMAF_V1_RECEIPT_MARGIN_SECONDS)
        if timeout <= 0:
            raise RunnerError("VMAF_V1_SCORE_TIMEOUT")
        started = perf_counter_ns()
        capture([
            str(scorer.executable), "--reference", str(source), "--distorted", str(encoded),
            "--backend", "cuda", "--decode", "cuda", "--device", str(runtime.gpu_index),
            "--experiment-window", "--reference-start-frame", str(trial.start_frame),
            "--frame-count", str(trial.frame_count), "--bit-depth", "8", "--output", str(receipt),
            "--model", VMAF_V1_MODEL_ID + "=" + str(model),
            *(["--verify-cpu"] if cpu_audit else []),
        ], "VMAF_V1_SCORE", work, timeout=timeout)
        score_ms = (perf_counter_ns() - started) // 1000000
        payload = json.loads(
            read_file(receipt, MAX_CAPTURE, "VMAF_V1_RECEIPT", require_regular=True), parse_float=Decimal,
        )
        mean, milli = parse_vmaf_v1(payload, runtime, trial, cpu_audit)
        require_unchanged_tools(identities, scorer.invocation_path, scorer.executable)
    except RunnerError as error:
        return {**profile_id, "status": "failed", "failureCode": str(error)}
    except (OSError, ValueError, RecursionError):
        return {**profile_id, "status": "failed", "failureCode": "VMAF_V1_INVALID_RECEIPT"}
    return {
        **profile_id, "status": "succeeded", "scoreMilli": milli, "meanVmaf": mean, "scoreMs": score_ms,
        "modelSha256": scorer.profile["modelSha256"], "scorerSha256": scorer.profile["scorerSha256"],
    }


def measure(runtime, trial, cpu_audit):
    require_unchanged_tools(runtime.tool_identities, runtime.invocation_path, runtime.runner_path)
    software = isinstance(trial, SoftwareTrial)
    if software != (runtime.capabilities.get("runtimeKind") == "software"):
        raise RunnerError("UNSUPPORTED_RUNTIME_ENCODER")
    if software and cpu_audit:
        raise RunnerError("UNSUPPORTED_SCORING_PROFILE")
    if trial.codec not in runtime.capabilities["supportedCodecs"]:
        raise RunnerError("UNSUPPORTED_RUNTIME_CODEC")
    if trial.sdk is not None and "nvencSdk" not in runtime.capabilities:
        raise RunnerError("NVENC_SDK_SETTINGS_UNAVAILABLE")
    source = trial.source_path.resolve(strict=True)
    if not source.is_file():
        raise RunnerError("SOURCE_UNAVAILABLE")
    source_clock = parse_measurement(probe_media(runtime, source, ["-show_streams"]))
    with TemporaryDirectory(prefix="bitovp-nvenc-") as directory:
        work = Path(directory)
        (work / MODEL_NAME).write_bytes(runtime.model_bytes)
        encoded, encode_ms = encode(runtime, trial, source, source_clock, work)
        packet_probe = probe_media(runtime, encoded, [
            "-select_streams", "v:0", "-show_packets", "-show_streams",
            "-show_entries", "stream=codec_name,time_base:packet=pts,size,flags",
        ])
        if [stream.get("codec_name") for stream in packet_probe.get("streams", [])] != [trial.codec.lower()]:
            raise RunnerError("ENCODED_CODEC_MISMATCH")
        video_bytes = parse_packet_sizes(packet_probe)
        mean, milli, scores, score_ms = score(runtime, trial, source, source_clock, encoded, work)
        result = {
            "schemaVersion": 1, "runtimeId": runtime.capabilities["runtimeId"], "scoringProfileId": runtime.capabilities["scoringProfileId"],
            "scoreMilli": milli, "meanVmaf": mean, "frameCount": trial.frame_count, "videoBytes": str(video_bytes),
            "durationTicks": str(trial.frame_count), "timeBase": {"num": 1, "den": 30},
            "encodeMs": encode_ms, "scoreMs": score_ms,
        }
        if trial.sdk is not None:
            result["nvencSdkApplied"] = trial.sdk.applied()
        interval = observed_gop(packet_probe, trial.frame_count)
        if interval is not None:
            result["observedGopFrames"] = interval
        if trial.measure_vmaf_v1:
            result["additionalScores"] = [score_vmaf_v1(runtime, trial, source, encoded, work, cpu_audit)]
        if cpu_audit:
            cpu_mean, _, cpu_scores, cpu_ms = score(runtime, trial, source, source_clock, encoded, work, cuda=False)
            result["cpuAudit"] = {
                "meanVmaf": cpu_mean, "scoreMs": cpu_ms,
                "gpuMinusCpuPerFrame": [float(gpu - cpu) for gpu, cpu in zip(scores, cpu_scores)],
            }
        require_unchanged_tools(runtime.tool_identities, runtime.invocation_path, runtime.runner_path)
        return result


def main(runner_source):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("probe")
    run = commands.add_parser("measure")
    run.add_argument("--request-file", type=Path, required=True)
    run.add_argument("--cpu-audit", action="store_true")
    args = parser.parse_args()
    # The invocation path comes from this process, including when an older
    # launcher read the compiled implementation during a runtime upgrade.
    invocation_path = Path(sys.argv[0])
    try:
        if args.command == "probe":
            result = resolve_runtime(runner_source, invocation_path).capabilities
        else:
            request = json.loads(read_file(args.request_file, MAX_REQUEST, "REQUEST"))
            trial = parse_trial(request)
            expected_runtime = parse_expected_runtime(os.environ.get("BITOVP_NVENC_EXPECTED_RUNTIME"))
            runtime = resolve_runtime(
                runner_source, invocation_path, expected_runtime=expected_runtime,
                probe_vmaf_v1=expected_runtime is None or (
                    trial.measure_vmaf_v1 and "additionalScoringProfiles" in expected_runtime
                ),
            )
            result = measure(runtime, trial, args.cpu_audit)
    except RunnerError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, RecursionError):
        print("INVALID_RUNTIME_INPUT", file=sys.stderr)
        return 1
    print(json.dumps(result, separators=(",", ":"), allow_nan=False))
    return 0


def launch_runner(path):
    # Python already loaded the launcher from the pathname, which may have changed.
    # Compile and fingerprint one stable byte buffer for the actual implementation.
    try:
        source = read_runner_source(path)
        code = compile(source.contents, str(source.path), "exec", dont_inherit=True)
    except RunnerError as error:
        print(str(error), file=sys.stderr)
        return 1
    except SyntaxError:
        print("INVALID_RUNTIME_INPUT", file=sys.stderr)
        return 1
    implementation = ModuleType("_bitovp_nvenc_runner_impl")
    implementation.__file__ = str(source.path)
    sys.modules[implementation.__name__] = implementation
    exec(code, implementation.__dict__)
    return implementation.main(source)


if __name__ == "__main__":
    sys.exit(launch_runner(Path(__file__)))
