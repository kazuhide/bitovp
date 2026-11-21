#!/usr/bin/env python3
"""Run one local NVENC encoding and a frame-checked VMAF-CUDA comparison."""

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
from time import monotonic, perf_counter_ns
from types import ModuleType
from typing import Optional
from uuid import UUID

PROFILE_ID = "official-vmaf-cuda-0.6.1"
MODEL_NAME = "vmaf_v0.6.1.json"
MODEL_SHA256 = "5950d61fa1f861bd45d8149d80539ed9f3376cfc2495b8f0fa8e9f57cb131ee3"
CODECS = {"H264": "h264", "HEVC": "hevc", "AV1": "av1"}
MAX_CAPTURE = 12 * 1024 * 1024
MAX_FRAMES = 3600
MAX_FRAME_TIME_BASE = Fraction(1, 1000)
INT32_MAX = (1 << 31) - 1
FORMAT_ALLOWLIST = "mov,matroska,webm"
LOCAL_INPUT = ["-protocol_whitelist", "file", "-format_whitelist", FORMAT_ALLOWLIST]
FFMPEG_ARGS = ["-hide_banner", "-nostats", "-nostdin", "-xerror", "-noauto_conversion_filters"]
NUMERALS = re.compile(r"(?:0|[1-9][0-9]{0,18})\Z")


class RunnerError(ValueError):
    pass


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


@dataclass(frozen=True)
class RunnerSource:
    invocation_path: Path
    path: Path
    identity: tuple
    contents: bytes


@dataclass(frozen=True)
class Runtime:
    ffmpeg: Path
    ffprobe: Path
    gpu_index: int
    model_bytes: bytes
    capabilities: dict
    tool_identities: tuple
    runner_source: RunnerSource


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


def parse_trial(request):
    fields(request, {"schemaVersion", "sourcePath", "trial"})
    integer(request["schemaVersion"], 1, 1)
    source = request["sourcePath"]
    if not isinstance(source, str) or not Path(source).is_absolute() or "\0" in source:
        raise RunnerError("INVALID_REQUEST")
    row = fields(request["trial"], {"sourceId", "window", "codec", "preset", "tuning", "config"})
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
    return Trial(Path(source), int(start), int(count), codec, preset, gop, frame_interval, rate)


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


def capture(args, stage, cwd=None, timeout=15):
    """Read both pipes to a fixed limit and kill a stalled or oversized subprocess."""
    deadline = monotonic() + timeout
    chunks = {"stdout": bytearray(), "stderr": bytearray()}
    try:
        with subprocess.Popen(
            args, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
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


def read_file(path, limit, stage):
    with path.open("rb") as source:
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


def require_unchanged_tools(identities, runner_source):
    try:
        current_runner = runner_source.invocation_path.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise RunnerError("RUNTIME_TOOL_CHANGED") from error
    if current_runner != runner_source.path or any(
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
    source = RunnerSource(invocation_path, path, identity, contents)
    require_unchanged_tools(((path, identity),), source)
    return source


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


def resolve_runtime(runner_source):
    require_unchanged_tools(((runner_source.path, runner_source.identity),), runner_source)
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
    identities[runner_source.path] = runner_source.identity
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
    require_unchanged_tools(tool_identities, runner_source)
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
    require_unchanged_tools(tool_identities, runner_source)
    data = {
        "schemaVersion": 1, "gpuUuid": uuid, "gpuName": name, "driverVersion": driver_version.strip(),
        "supportedCodecs": codecs, "scoringProfileId": PROFILE_ID,
        **digests, "maxNvencApiVersion": runtime_version, "modelSha256": model_sha,
    }
    data["runtimeId"] = hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return Runtime(ffmpeg, ffprobe, index, model_bytes, data, tool_identities, runner_source)


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


def encode(runtime, trial, source, source_time_base, work):
    started = perf_counter_ns()
    output = work / "encoded.mkv"
    _, log = capture(
        [str(runtime.ffmpeg), *FFMPEG_ARGS, "-copyts", *cuda_args(runtime), *LOCAL_INPUT, "-noautorotate", "-i", str(source),
         "-map", "0:v:0", "-an", "-sn", "-dn", "-vf",
         reference_filter(trial, source_time_base, "encode_ref") + ",scale=out_range=limited,format=nv12,hwupload",
         *encode_options(trial), "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709",
         "-color_trc", "bt709", "-fps_mode", "passthrough", "-avoid_negative_ts", "disabled",
         "-frames:v", str(trial.frame_count + 1), "-fs", "1073741824", str(output)],
        "ENCODE", work, timeout=300,
    )
    elapsed_ms = (perf_counter_ns() - started) // 1000000
    validate_timeline(log, "encode_ref", trial.start_frame, trial.frame_count, "yuv420p")
    return output, elapsed_ms


def score(runtime, trial, source, source_time_base, encoded, work, cuda=True):
    started = perf_counter_ns()
    name = "cuda-score.json" if cuda else "cpu-score.json"
    reference = reference_filter(trial, source_time_base, "score_ref")
    gpu_input = [
        "-hwaccel", "cuda", "-hwaccel_device", "experiment", "-hwaccel_output_format", "cuda",
        "-c:v", CODECS[trial.codec] + "_cuvid",
    ] if cuda else []
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
         *LOCAL_INPUT, *gpu_input, "-i", str(encoded), *LOCAL_INPUT, "-noautorotate", "-i", str(source),
         "-filter_complex", graph, "-map", "[out]", "-an", "-sn", "-dn",
         "-fps_mode", "passthrough", "-c:v", "wrapped_avframe", "-f", "null", "-"],
        "CUDA_SCORE" if cuda else "CPU_SCORE", work, timeout=300,
    )
    elapsed_ms = (perf_counter_ns() - started) // 1000000
    validate_timeline(log, "score_ref", trial.start_frame, trial.frame_count, "yuv420p")
    validate_timeline(log, "distorted", 0, trial.frame_count, "cuda" if cuda else "yuv420p")
    return (*parse_vmaf(work / name, trial.frame_count), elapsed_ms)


def measure(runtime, trial, cpu_audit):
    require_unchanged_tools(runtime.tool_identities, runtime.runner_source)
    if trial.codec not in runtime.capabilities["supportedCodecs"]:
        raise RunnerError("UNSUPPORTED_RUNTIME_CODEC")
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
        if [stream.get("codec_name") for stream in packet_probe.get("streams", [])] != [CODECS[trial.codec]]:
            raise RunnerError("ENCODED_CODEC_MISMATCH")
        video_bytes = parse_packet_sizes(packet_probe)
        mean, milli, scores, score_ms = score(runtime, trial, source, source_clock, encoded, work)
        result = {
            "schemaVersion": 1, "runtimeId": runtime.capabilities["runtimeId"], "scoringProfileId": PROFILE_ID,
            "scoreMilli": milli, "meanVmaf": mean, "frameCount": trial.frame_count, "videoBytes": str(video_bytes),
            "durationTicks": str(trial.frame_count), "timeBase": {"num": 1, "den": 30},
            "encodeMs": encode_ms, "scoreMs": score_ms,
        }
        interval = observed_gop(packet_probe, trial.frame_count)
        if interval is not None:
            result["observedGopFrames"] = interval
        if cpu_audit:
            cpu_mean, _, cpu_scores, cpu_ms = score(runtime, trial, source, source_clock, encoded, work, cuda=False)
            result["cpuAudit"] = {
                "meanVmaf": cpu_mean, "scoreMs": cpu_ms,
                "gpuMinusCpuPerFrame": [float(gpu - cpu) for gpu, cpu in zip(scores, cpu_scores)],
            }
        require_unchanged_tools(runtime.tool_identities, runtime.runner_source)
        return result


def main(runner_source):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("probe")
    run = commands.add_parser("measure")
    run.add_argument("--request-file", type=Path, required=True)
    run.add_argument("--cpu-audit", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "probe":
            result = resolve_runtime(runner_source).capabilities
        else:
            trial = parse_trial(json.loads(read_file(args.request_file, 32 * 1024, "REQUEST")))
            result = measure(resolve_runtime(runner_source), trial, args.cpu_audit)
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
