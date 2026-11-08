"""Offline finalization of a completed private proxy, never a source-clock proof."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

from corpus import digest
from execution import OperationError, _remaining


def file_sha256(path):
    sha = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def validate_partial_reuse(operation, probe, probe_sha, partial, expected_sha):
    result = operation.get("result") or {}
    proof = result.get("readProof") or {}
    if (operation.get("ok") is not False or not operation.get("cleanupConfirmed")
        or operation.get("error") not in {"OUTPUT_VALIDATION_FAILED", "UPSTREAM_READ_FAILED"}
        or result.get("nativeReturnCode") != 0 or not proof.get("byteCountComplete")
        or proof.get("failureCode") not in {None, "UPSTREAM_READ_FAILED"}
        or not probe.get("ok") or operation.get("assetId") != probe.get("assetId")
        or operation.get("source") != probe.get("source") or operation.get("sourceProbeSha256") != probe_sha
        or ((probe.get("result") or {}).get("metadata") or {}).get("assessment") != "VIDEO_PRESENT"):
        raise OperationError("PARTIAL_REUSE_NOT_BOUND")
    partial = Path(partial)
    if (partial.name != "excerpt.partial.mp4" or partial.is_symlink() or not partial.is_file()
        or partial.stat().st_uid != os.getuid() or not 0 < partial.stat().st_size <= 512 * 1024 * 1024):
        raise OperationError("PARTIAL_REUSE_NOT_BOUND")
    if not isinstance(expected_sha, str) or not re.fullmatch("[a-f0-9]{64}", expected_sha) or file_sha256(partial) != expected_sha:
        raise OperationError("PARTIAL_SHA_MISMATCH")


def finalization_recipe(metadata, original_metadata):
    videos = [s for s in metadata.get("streams", []) if s.get("codec_type") == "video"]
    audios = [s for s in metadata.get("streams", []) if s.get("codec_type") == "audio"]
    try:
        video = videos[0]
        frames = int(video["nb_frames"])
        valid = (len(videos) == 1 and len(audios) <= 1 and video.get("codec_name") == "h264"
            and video.get("r_frame_rate") == "30/1" and video.get("avg_frame_rate") == "30/1"
            and video.get("sample_aspect_ratio") == "1:1" and video.get("time_base") == "1/30000"
            and int(video["start_pts"]) == 0 and int(video["duration_ts"]) == frames * 1000
            and 1800 <= frames <= 5400)
    except (ValueError, KeyError, IndexError, TypeError):
        valid = False
    if not valid:
        raise OperationError("PARTIAL_VIDEO_CLOCK_INVALID")
    starts = {kind: [s.get("start_time") for s in original_metadata.get("streams", []) if s.get("codec_type") == kind]
              for kind in ("video", "audio")}
    return {"version": "clip-quality-excerpt-finalization-v2", "frameCount": frames,
        "duration": {"num": frames, "den": 30}, "outputClock": {"startUs": 0, "fps": {"num": 30, "den": 1}},
        "videoPolicy": "COPY_EXISTING_CFR30_BITSTREAM_WITHOUT_EXTENSION",
        "audioPolicy": "TRIM_TO_VIDEO_SAMPLE_COUNT_REENCODE_AAC48K_STEREO" if audios else "NO_AUDIO",
        "audioEndSample": frames * 1600 if audios else None, "audioCodecPadding": "PRESENTATION_TRIM_WITH_UP_TO_1023_DECODED_TAIL_SAMPLES",
        "originalContainerStartSeconds": original_metadata.get("format", {}).get("start_time"),
        "originalStreamStartSeconds": starts,
        "clockScope": "LOCAL_EVALUATION_PROXY_ONLY_NOT_EXACT_ORIGINAL_OR_PROVIDER_CLOCK_PROOF"}


def validate_video_frames(frames, expected):
    if len(frames) != expected:
        raise OperationError("VIDEO_DECODE_CLOCK_INVALID")
    for index, frame in enumerate(frames):
        try:
            if int(frame["best_effort_timestamp"]) != index * 1000 or int(frame.get("duration", frame.get("pkt_duration"))) != 1000:
                raise ValueError()
        except (KeyError, ValueError, TypeError):
            raise OperationError("VIDEO_DECODE_CLOCK_INVALID") from None
    return {"decodedFrameCount": expected, "timeBase": {"num": 1, "den": 30000},
        "timestampSequence": "0_PLUS_INDEX_TIMES_1000_IN_1_30000", "frameDurationTicks": 1000}


def validate_audio_clock(audio, decoded_samples, frames):
    target = frames * 1600
    try:
        valid = (audio.get("codec_name") == "aac" and audio.get("sample_rate") == "48000" and audio.get("channels") == 2
            and audio.get("time_base") == "1/48000" and int(audio["start_pts"]) == 0
            and int(audio["duration_ts"]) == target and target <= decoded_samples <= target + 1023)
    except (KeyError, TypeError, ValueError):
        valid = False
    if not valid:
        raise OperationError("AUDIO_DECODE_CLOCK_INVALID")
    return {"presentationSampleCount": target, "sampleRate": 48000, "channels": 2,
        "decodedSampleCount": decoded_samples, "decodedTailPaddingSamples": decoded_samples - target,
        "timeBase": {"num": 1, "den": 48000}, "startSample": 0}


def _native(args, deadline, *, capture=False, output=None):
    try:
        native = subprocess.run(args, stdout=subprocess.PIPE if capture else (output or subprocess.DEVNULL),
            stderr=subprocess.DEVNULL, timeout=_remaining(deadline), check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise OperationError("FINALIZATION_NATIVE_FAILED") from None
    if native.returncode:
        raise OperationError("FINALIZATION_NATIVE_FAILED")
    if capture and len(native.stdout) > 4 * 1024 * 1024:
        raise OperationError("FINALIZATION_NATIVE_OUTPUT_INVALID")
    return native.stdout if capture else None


def _header(path, deadline):
    entries = "stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,sample_aspect_ratio,time_base,start_pts,duration_ts,nb_frames,sample_rate,channels:format=duration,start_time"
    raw = _native(["ffprobe", "-v", "error", "-show_entries", entries, "-of", "json", str(path)], deadline, capture=True)
    try:
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, UnicodeError):
        raise OperationError("FINALIZATION_NATIVE_OUTPUT_INVALID") from None


def _video_hash(path, deadline):
    raw = _native(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-map", "0:v:0",
        "-c:v", "copy", "-f", "hash", "-hash", "sha256", "-"], deadline, capture=True)
    if not re.fullmatch(rb"SHA256=[a-f0-9]{64}\s*", raw):
        raise OperationError("FINALIZATION_NATIVE_OUTPUT_INVALID")
    return raw.decode("ascii").strip().split("=")[1]


def finalize_worker(connection, payload):
    start, partial = time.monotonic(), Path(payload["partial"])
    deadline = start + payload["deadlineSeconds"]
    if not 0 < payload["deadlineSeconds"] <= 600 or file_sha256(partial) != payload["partialSha256"]:
        raise OperationError("PARTIAL_SHA_MISMATCH")
    original_metadata = payload["sourceMetadata"]
    recipe = finalization_recipe(_header(partial, deadline), original_metadata)
    output = Path(payload["outputDirectory"]) / "excerpt.finalizing.mp4"
    if output.exists() or output.is_symlink():
        raise OperationError("OUTPUT_EXISTS")
    args = ["ffmpeg", "-v", "error", "-xerror", "-nostdin", "-n", "-threads", "2", "-i", str(partial),
        "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-map_chapters", "-1", "-c:v", "copy"]
    if recipe["audioEndSample"] is not None:
        args += ["-af", "atrim=end_sample=%d,asetpts=PTS-STARTPTS" % recipe["audioEndSample"],
            "-filter_threads", "2", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"]
    args += ["-video_track_timescale", "30000", "-movie_timescale", "30000", "-movflags", "+faststart", str(output)]
    _native(args, deadline)
    metadata = _header(output, deadline)
    after = finalization_recipe(metadata, original_metadata)
    if after != recipe:
        raise OperationError("FINALIZATION_CHANGED_VIDEO_CLOCK")
    raw = _native(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "frame=best_effort_timestamp,duration,pkt_duration", "-of", "json", str(output)], deadline, capture=True)
    try:
        video_proof = validate_video_frames(json.loads(raw)["frames"], recipe["frameCount"])
    except (ValueError, KeyError, TypeError):
        raise OperationError("VIDEO_DECODE_CLOCK_INVALID") from None
    _native(["ffmpeg", "-v", "error", "-xerror", "-err_detect", "explode", "-threads", "2", "-nostdin",
        "-i", str(output), "-map", "0:v:0", "-an", "-f", "null", "-"], deadline)
    input_video_hash, output_video_hash = _video_hash(partial, deadline), _video_hash(output, deadline)
    if input_video_hash != output_video_hash:
        raise OperationError("FINALIZATION_CHANGED_VIDEO_BITSTREAM")
    audio_proof = None
    if recipe["audioEndSample"] is not None:
        with tempfile.TemporaryFile() as pcm:
            _native(["ffmpeg", "-v", "error", "-xerror", "-err_detect", "explode", "-threads", "2", "-nostdin",
                "-i", str(output), "-map", "0:a:0", "-vn", "-c:a", "pcm_s16le", "-f", "s16le", "-"], deadline, output=pcm)
            pcm_bytes = pcm.tell()
        if pcm_bytes % 4:
            raise OperationError("AUDIO_DECODE_CLOCK_INVALID")
        audio = next(s for s in metadata["streams"] if s.get("codec_type") == "audio")
        audio_proof = validate_audio_clock(audio, pcm_bytes // 4, recipe["frameCount"])
    if file_sha256(partial) != payload["partialSha256"]:
        raise OperationError("PARTIAL_SHA_CHANGED_DURING_FINALIZATION")
    final = output.with_name("excerpt.mp4")
    output_sha = file_sha256(output)
    os.link(output, final)
    output.unlink()
    artifact = {"schemaVersion": "clip-quality-finalized-artifact-v2", "outputFilename": "excerpt.mp4",
        "outputSha256": output_sha, "outputBytes": final.stat().st_size, "recipe": recipe, "recipeHash": digest(recipe),
        "frameCount": recipe["frameCount"], "duration": recipe["duration"], "excerptClockStartUs": 0,
        "metadata": metadata, "hasAudio": audio_proof is not None,
        "fullDecodeProof": {"video": video_proof, "audio": audio_proof, "nativeVideoDecodeExitCode": 0,
            "nativeAudioDecodeExitCode": 0 if audio_proof is not None else None, "videoBitstreamSha256": output_video_hash,
            "videoBitstreamUnchanged": True, "clockScope": recipe["clockScope"]}}
    connection.send({"ok": True, "error": None, "result": {"artifact": artifact,
        "elapsedMs": round((time.monotonic() - start) * 1000), "deadlineSeconds": payload["deadlineSeconds"],
        "networkOperations": 0, "externalLlmUsed": False, "originalFailurePreserved": True}})
