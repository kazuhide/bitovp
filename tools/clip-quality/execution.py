"""Private CPU-only probe/excerpt processes with an owned process-group deadline."""
from __future__ import annotations

from decimal import Decimal, InvalidOperation
import datetime
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
from urllib.parse import parse_qs, urlsplit

from bounded_probe import BoundedReader, HTTPSRangeFetcher, LocalRangeProxy, ProbeError, project_metadata
from corpus import digest
from materialize_revision import RevisionError, materialize_policy


class OperationError(Exception):
    pass


class _Sender:
    def __init__(self, connection):
        self.connection, self.lock = connection, threading.Lock()

    def send(self, message):
        with self.lock:
            self.connection.send(message)

    def close(self):
        with self.lock:
            self.connection.close()


def _entry(worker, connection, payload, start_gate):
    # Spawn inherits the parent's startup SIGINT mask. The parent owns cleanup;
    # this child must not retain the temporary mask for its whole operation.
    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGINT})
    os.umask(0o077)
    os.setsid()
    connection.send({"kind": "ready", "pid": os.getpid(), "pgid": os.getpgrp()})
    sender = _Sender(connection)
    try:
        # No native child can be created before the parent has bound this session.
        start_gate.wait()
        worker(sender, payload)
    except (OperationError, ProbeError) as error:
        sender.send({"ok": False, "error": str(error)})
    except Exception:
        sender.send({"ok": False, "error": "OPERATION_FAILED"})
    finally:
        sender.close()


def run_isolated(worker, payload, *, timeout_seconds):
    if not hasattr(os, "setsid") or not 0 < timeout_seconds <= 900:
        raise OperationError("OPERATION_LIMIT_INVALID")
    context = multiprocessing.get_context("spawn")
    receive, send = context.Pipe(duplex=False)
    process = None
    deadline, owned_group, final = time.monotonic() + timeout_seconds, False, None
    progress = {"reservedBytes": 0, "receivedBytes": 0}
    cleanup_confirmed = False
    try:
        start_gate = context.Event()
        process = context.Process(target=_entry, args=(worker, send, payload, start_gate))
        # Defer SIGINT until multiprocessing has retained its child's PID. An
        # explicit exception from a partial start is also inside our cleanup.
        startup_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})
        try:
            process.start()
            send.close()
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, startup_mask)
        while time.monotonic() < deadline:
            if receive.poll(min(0.05, max(0, deadline - time.monotonic()))):
                try:
                    message = receive.recv()
                except EOFError:
                    break
                if message.get("kind") == "ready":
                    owned_group = message.get("pid") == process.pid and message.get("pgid") == process.pid
                    if owned_group:
                        start_gate.set()
                elif message.get("kind") == "progress":
                    progress = {key: int(message.get(key, 0)) for key in progress}
                else:
                    final = message
                    break
            elif not process.is_alive():
                break
        if final is None:
            final = {"ok": False, "error": "OPERATION_DEADLINE_EXCEEDED" if time.monotonic() >= deadline else "OPERATION_FAILED",
                "receivedBytesLowerBound": progress["receivedBytes"], "reservedBytesLowerBound": progress["reservedBytes"],
                "byteCountComplete": False}
    finally:
        # Covers operator interruption too, before an owned child can outlive the CLI.
        cleanup_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})
        try:
            try:
                # A partial start may have a PID even when start() raised. The
                # gate keeps worker/native execution blocked until ownership.
                if process is not None and process.pid is not None:
                    if not owned_group and process.is_alive():
                        try:
                            owned_group = os.getpgid(process.pid) == process.pid
                        except ProcessLookupError:
                            pass
                    process.join(timeout=min(1, max(0.05, deadline - time.monotonic())))
                    if process.is_alive():
                        if owned_group:
                            try:
                                os.killpg(process.pid, signal.SIGTERM)
                            except ProcessLookupError:
                                pass
                        else:
                            process.terminate()
                        process.join(timeout=1)
                    # A ready group can retain native children after its leader exits.
                    if owned_group:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    if process.is_alive():
                        process.kill()
                    process.join(timeout=1)
                    cleanup_confirmed = not process.is_alive()
                else:
                    cleanup_confirmed = True  # No child was started.
            finally:
                # send.close() itself may have been interrupted during startup.
                # Closing either pipe must not skip the other or the Process handle.
                try:
                    send.close()
                finally:
                    try:
                        receive.close()
                    finally:
                        if process is not None and not process.is_alive():
                            process.close()
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, cleanup_mask)
    final["cleanupConfirmed"] = cleanup_confirmed
    if not cleanup_confirmed:
        final["ok"], final["error"] = False, "CLEANUP_UNCONFIRMED"
    return final


def _remaining(deadline):
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise OperationError("OPERATION_DEADLINE_EXCEEDED")
    return seconds


def signed_source_url(source, deadline, *, expires=300):
    args = ["aws", "--profile", "default", "--region", source["region"], "--endpoint-url",
        "https://s3.%s.amazonaws.com" % source["region"], "s3", "presign",
        "s3://%s/%s" % (source["bucket"], source["key"]), "--expires-in", str(expires)]
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=min(15, _remaining(deadline)), check=False)
        if result.returncode or not 0 < len(result.stdout) < 32768:
            raise OperationError("AWS_PRESIGN_FAILED")
        return result.stdout.decode("utf-8").strip()
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        raise OperationError("AWS_PRESIGN_FAILED") from None


def presign_lifetime_proof(url, operation_seconds, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    try:
        query = parse_qs(urlsplit(url).query)
        issued = datetime.datetime.strptime(query["X-Amz-Date"][0], "%Y%m%dT%H%M%SZ").replace(tzinfo=datetime.timezone.utc)
        lifetime = int(query["X-Amz-Expires"][0])
        expires = issued + datetime.timedelta(seconds=lifetime)
        if (expires - now).total_seconds() < operation_seconds + 5:
            raise OperationError("PRESIGN_LIFETIME_TOO_SHORT")
    except (ValueError, KeyError, IndexError):
        raise OperationError("PRESIGN_LIFETIME_UNVERIFIED") from None
    return {"issuedAtUtc": issued.isoformat(), "expiresAtUtc": expires.isoformat(), "lifetimeSeconds": lifetime,
        "operationDeadlineSeconds": operation_seconds, "coversDeclaredOperationDeadline": True,
        "credentialExpiry": "NOT_INSPECTED_403_IS_TERMINAL", "urlPersisted": False}


def _reader(source, payload, deadline, connection, expires=300, *, materialize=False):
    signed = signed_source_url(source, deadline, expires=expires)
    lifetime = presign_lifetime_proof(signed, payload["deadlineSeconds"])
    fetch = HTTPSRangeFetcher(signed, source)
    policy = materialize_policy(payload) if materialize else {"cacheBlockBytes": 1024**2, "cacheCapacityBytes": 8 * 1024**2}
    reader = BoundedReader(source["sizeBytes"], fetch, limit_bytes=payload["limitBytes"], deadline=deadline,
        cache_block_bytes=policy["cacheBlockBytes"], cache_capacity_bytes=policy["cacheCapacityBytes"])
    reader.presign_proof = lifetime
    original = reader.read

    def monitored(start, length):
        try:
            return original(start, length)
        finally:
            proof = reader.proof()
            try:
                connection.send({"kind": "progress", "reservedBytes": proof["reservedBytes"], "receivedBytes": proof["receivedBytes"]})
            except (OSError, BrokenPipeError):
                reader.stop()
    reader.read = monitored
    return reader


ENTRIES = "format=format_name,start_time,duration:stream=index,codec_type,codec_name,width,height,pix_fmt,field_order,sample_aspect_ratio,r_frame_rate,avg_frame_rate,time_base,start_time,duration,nb_frames,sample_rate,channels,channel_layout,color_space,color_transfer,color_primaries"


def _metadata(target, deadline, remote=False):
    args = ["ffprobe", "-v", "error", "-max_alloc", "67108864"]
    if remote:
        args += ["-protocol_whitelist", "http,tcp", "-format_whitelist", "mov,mxf,mpeg,mpegts,matroska,avi",
            "-probesize", "4194304", "-analyzeduration", "2000000"]
    args += ["-show_entries", ENTRIES, "-of", "json", target]
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=_remaining(deadline), check=False)
        if len(result.stdout) > 1024 * 1024:
            raise OperationError("FFPROBE_OUTPUT_INVALID")
        parsed = json.loads(result.stdout)
        if not isinstance(parsed, dict):
            raise ValueError()
        return project_metadata(parsed, complete=result.returncode == 0), result.returncode
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise OperationError("FFPROBE_FAILED") from None


def probe_worker(connection, payload):
    if not 0 < payload["limitBytes"] <= 64 * 1024 * 1024 or not 0 < payload["deadlineSeconds"] <= 45:
        raise OperationError("PROBE_LIMIT_INVALID")
    start = time.monotonic()
    deadline = start + payload["deadlineSeconds"]
    reader = _reader(payload["source"], payload, deadline, connection)
    metadata, error = None, None
    try:
        with LocalRangeProxy(reader) as url:
            metadata, code = _metadata(url, deadline, remote=True)
            if code:
                error = "FFPROBE_FAILED"
    except (OperationError, ProbeError) as failure:
        error = str(failure)
    finally:
        reader.stop()
    proof = reader.proof()
    error = proof["failureCode"] or error
    if error and metadata:
        metadata["assessment"] = "UNRESOLVED"
    connection.send({"ok": error is None, "error": error, "result": {
        "metadata": metadata, "readProof": proof, "elapsedMs": round((time.monotonic() - start) * 1000),
        "deadlineSeconds": payload["deadlineSeconds"], "urlPersisted": False, "sourceEtagPinned": True}})


def excerpt_recipe(metadata):
    if metadata.get("assessment") != "VIDEO_PRESENT":
        raise OperationError("VIDEO_NOT_CONFIRMED")
    videos = [stream for stream in metadata.get("streams", []) if stream.get("codec_type") == "video"]
    if any(stream.get("color_transfer") in {"smpte2084", "arib-std-b67"} for stream in videos):
        raise OperationError("HDR_REQUIRES_EXPLICIT_TONEMAP_POLICY")
    try:
        duration = Decimal(str(metadata.get("format", {}).get("duration")))
        if not duration.is_finite() or duration <= 0:
            raise InvalidOperation()
    except (InvalidOperation, ValueError):
        raise OperationError("SOURCE_DURATION_UNAVAILABLE") from None
    offset = min(300, max(0, int(duration - 180)))
    duration_us = min(180000000, int((duration - offset) * 1000000))
    return {"version": "clip-quality-excerpt-v1", "sourceOffsetUs": offset * 1000000,
        "sourceHeaderStartSeconds": metadata.get("format", {}).get("start_time"),
        "sourceOffsetPrecision": "REQUESTED_SEEK_WITH_DECODER_FRAME_ROUNDING", "requestedDurationUs": duration_us,
        "outputClock": {"startUs": 0, "fps": {"num": 30, "den": 1}},
        "videoFilter": "bwdif=mode=send_frame:parity=auto:deint=interlaced,scale=w='trunc(iw*sar/2)*2':h=ih,setsar=1,scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,setpts=PTS-STARTPTS,fps=fps=30:start_time=0:round=near,format=yuv420p",
        "colorPolicy": "SDR_BT709_ASSIGNED_EVALUATION_PROXY_NOT_PROVIDER_PROOF", "videoCodec": "libx264",
        "preset": "veryfast", "crf": 22, "decoderThreads": 2, "encoderThreads": 2, "audio": "AAC_48KHZ_STEREO_128K",
        "metadataPolicy": "STRIP_METADATA_AND_CHAPTERS", "purpose": "PRIVATE_EVALUATION_EXCERPT"}


def materialize_worker(connection, payload):
    try:
        materialize_policy(payload)
    except RevisionError:
        raise OperationError("MATERIALIZE_LIMIT_INVALID") from None
    start = time.monotonic()
    deadline = start + payload["deadlineSeconds"]
    recipe = {**excerpt_recipe(payload["metadata"]), "toolIdentity": payload["toolIdentity"]}
    output = Path(payload["outputDirectory"]) / "excerpt.partial.mp4"
    if output.exists() or output.is_symlink():
        raise OperationError("OUTPUT_EXISTS")
    reader = _reader(payload["source"], payload, deadline, connection, expires=1200, materialize=True)
    failure, result, native_code, phase = None, None, None, "TRANSCODE"
    try:
        with LocalRangeProxy(reader) as url:
            args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-threads", "2",
                "-protocol_whitelist", "http,tcp", "-format_whitelist", "mov,mxf,mpeg,mpegts,matroska,avi",
                "-ss", str(recipe["sourceOffsetUs"] // 1000000), "-i", url,
                "-t", str(Decimal(recipe["requestedDurationUs"]) / 1000000), "-map", "0:v:0", "-map", "0:a:0?",
                "-map_metadata", "-1", "-map_chapters", "-1", "-vf", recipe["videoFilter"],
                "-filter_threads", "2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-threads", "2",
                "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
                "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
                "-af", "aresample=48000:async=1:first_pts=0,asetpts=PTS-STARTPTS",
                "-video_track_timescale", "30000", "-movie_timescale", "30000", "-movflags", "+faststart", str(output)]
            native = subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=max(0.001, _remaining(deadline) - 10), check=False)
            native_code = native.returncode
            if native.returncode:
                raise OperationError("FFMPEG_FAILED")
        proof = reader.proof()
        if proof["failureCode"]:
            raise OperationError(proof["failureCode"])
        phase = "OUTPUT_VALIDATION"
        metadata, code = _metadata(str(output), deadline)
        metadata["clockScope"] = "EXCERPT_CFR30_HEADER_NOT_A_PROVIDER_NORMALIZATION_RECEIPT"
        video = next((stream for stream in metadata["streams"] if stream.get("codec_type") == "video"), {})
        frames = int(video.get("nb_frames", 0))
        expected = round(recipe["requestedDurationUs"] * 30 / 1000000)
        if (code or metadata["assessment"] != "VIDEO_PRESENT" or video.get("r_frame_rate") != "30/1"
            or video.get("sample_aspect_ratio") not in {"1:1", None} or frames <= 0 or abs(frames - expected) > 1):
            raise OperationError("OUTPUT_VALIDATION_FAILED")
        sha = hashlib.sha256()
        with output.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                _remaining(deadline)
                sha.update(block)
        final = output.with_name("excerpt.mp4")
        os.link(output, final)
        output.unlink()
        result = {"recipe": recipe, "recipeHash": digest(recipe), "sourceEtag": payload["source"]["etag"],
            "sourceAssetId": payload["assetId"], "metadata": metadata, "outputSha256": sha.hexdigest(),
            "outputBytes": final.stat().st_size, "outputFilename": "excerpt.mp4", "frameCount": frames,
            "actualVideoDurationUs": (frames * 1000000 + 29) // 30, "excerptClockStartUs": 0,
            "hasAudio": any(stream.get("codec_type") == "audio" for stream in metadata["streams"])}
    except (OperationError, ProbeError) as error:
        failure = str(error)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        failure = "MATERIALIZE_FAILED"
    finally:
        reader.stop()
    connection.send({"ok": failure is None, "error": failure, "result": {
        "artifact": result, "readProof": reader.proof(), "elapsedMs": round((time.monotonic() - start) * 1000),
        "deadlineSeconds": payload["deadlineSeconds"], "urlPersisted": False, "nativeReturnCode": native_code, "phase": phase}})
