"""Bounded, private S3 metadata probes; signed URLs stay inside this process."""
from __future__ import annotations

from contextlib import AbstractContextManager
from collections import OrderedDict
import errno
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import re
import secrets
import ssl
import threading
import time
from urllib.parse import unquote, urlsplit


class ProbeError(Exception):
    CODES = {"SOURCE_URL_NOT_ALLOWED", "READ_LIMIT_INVALID", "RANGE_INVALID", "PROBE_STOPPED",
        "PROBE_DEADLINE_EXCEEDED", "READ_BUDGET_EXCEEDED", "UPSTREAM_READ_FAILED", "UPSTREAM_RANGE_INVALID",
        "SOURCE_CHANGED", "CHUNK_LIMIT_INVALID", "UPSTREAM_TRANSIENT_HTTP", "UPSTREAM_ACCESS_DENIED"}

    def __init__(self, code, received_bytes=0, diagnostic=None):
        self.received_bytes = received_bytes if type(received_bytes) is int and received_bytes >= 0 else 0
        self.diagnostic = _diagnostic(diagnostic or {})
        super().__init__(code if code in self.CODES else "UPSTREAM_READ_FAILED")


def _diagnostic(value):
    names = {"ConnectionResetError", "ConnectionAbortedError", "BrokenPipeError", "TimeoutError", "timeout",
        "RemoteDisconnected", "IncompleteRead", "OSError", "SSLError", "SSLEOFError", "SSLCertVerificationError", "ValueError"}
    codes = {"ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "EBADF", "ENOTCONN", "EHOSTUNREACH", "ENETUNREACH"}
    result = {}
    if "exceptionType" in value:
        result["exceptionType"] = value["exceptionType"] if value["exceptionType"] in names else "OTHER"
    if value.get("osCode") in codes:
        result["osCode"] = value["osCode"]
    if type(value.get("httpStatus")) is int and 100 <= value["httpStatus"] <= 599:
        result["httpStatus"] = value["httpStatus"]
    if value.get("phase") in {"CONNECT", "HEADERS", "BODY"}:
        result["phase"] = value["phase"]
    for key in ("connectionClose", "connectionSocketPresent"):
        if type(value.get(key)) is bool:
            result[key] = value[key]
    return result


def _retryable(error):
    if str(error) not in {"UPSTREAM_TRANSIENT_HTTP", "UPSTREAM_READ_FAILED"}:
        return False
    detail = error.diagnostic
    return detail.get("httpStatus") in {500, 502, 503, 504} or detail.get("exceptionType") in {
        "ConnectionResetError", "ConnectionAbortedError", "BrokenPipeError", "TimeoutError", "timeout", "RemoteDisconnected", "IncompleteRead"
    } or (detail.get("exceptionType") == "OSError" and detail.get("osCode") in {"ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE"})


def validate_source_url(url, source):
    try:
        parts = urlsplit(url)
        bucket, region, key = source["bucket"], source["region"], source["key"]
        virtual = {bucket + ".s3." + region + ".amazonaws.com", bucket + ".s3.amazonaws.com"}
        path_style = {"s3." + region + ".amazonaws.com", "s3.amazonaws.com"}
        valid = (parts.scheme == "https" and parts.port in (None, 443) and not parts.username and not parts.password
            and not parts.fragment and ((parts.hostname in virtual and unquote(parts.path) == "/" + key)
                or (parts.hostname in path_style and unquote(parts.path) == "/" + bucket + "/" + key)))
    except (ValueError, TypeError, KeyError):
        valid = False
    if not valid:
        raise ProbeError("SOURCE_URL_NOT_ALLOWED")
    return url


class BoundedReader:
    def __init__(self, size, fetch, *, limit_bytes, deadline, cache_block_bytes=0, cache_capacity_bytes=8 * 1024 * 1024):
        if type(size) is not int or size <= 0 or type(limit_bytes) is not int or not 0 < limit_bytes <= 6 * 1024 * 1024 * 1024:
            raise ProbeError("READ_LIMIT_INVALID")
        self.size, self.fetch = size, fetch
        if (type(cache_block_bytes) is not int or not 0 <= cache_block_bytes <= 8 * 1024 * 1024
            or type(cache_capacity_bytes) is not int or not max(1, cache_block_bytes) <= cache_capacity_bytes <= 32 * 1024 * 1024):
            raise ProbeError("READ_LIMIT_INVALID")
        self.cache_block_bytes, self.cache_capacity_bytes = cache_block_bytes, cache_capacity_bytes
        self.limit_bytes, self.deadline = limit_bytes, deadline
        self.reserved_bytes = self.received_bytes = 0
        self.ranges, self.cache = [], OrderedDict()
        self.cache_bytes = 0
        self.failure_code = None
        self.lock = threading.Lock()
        self.idle = threading.Condition(self.lock)
        self.active_reads = 0
        self.in_flight = set()
        self.get_attempts = self.retry_count = self.retry_reserved_bytes = self.retry_received_bytes = 0
        self.transport_diagnostics = []
        self.stopped = False

    def stop(self):
        with self.idle:
            self.stopped = True
            self.idle.notify_all()
        stopper = getattr(self.fetch, "stop", None)
        if stopper:
            stopper()

    def wait_until_idle(self, timeout=2):
        with self.idle:
            return self.idle.wait_for(lambda: self.active_reads == 0, timeout=timeout)

    def read(self, start, length):
        if type(start) is not int or type(length) is not int or start < 0 or length <= 0 or start + length > self.size:
            raise ProbeError("RANGE_INVALID")
        if not self.cache_block_bytes:
            return self._read_direct(start, length)
        block = (start // self.cache_block_bytes) * self.cache_block_bytes
        end = start + length
        result = bytearray()
        while block < end:
            data = self._read_direct(block, min(self.cache_block_bytes, self.size - block))
            result.extend(data[max(0, start - block):min(len(data), end - block)])
            block += self.cache_block_bytes
        return bytes(result)

    def _read_direct(self, start, length):
        with self.idle:
            if type(start) is not int or type(length) is not int or start < 0 or length <= 0 or start + length > self.size:
                raise ProbeError("RANGE_INVALID")
            if self.stopped:
                raise ProbeError("PROBE_STOPPED")
            if time.monotonic() >= self.deadline:
                self.failure_code = "PROBE_DEADLINE_EXCEEDED"
                raise ProbeError(self.failure_code)
            key = (start, start + length - 1)
            while key in self.in_flight:
                remaining = self.deadline - time.monotonic()
                if remaining <= 0:
                    self.failure_code = "PROBE_DEADLINE_EXCEEDED"
                    raise ProbeError(self.failure_code)
                self.idle.wait(timeout=remaining)
                if self.stopped:
                    raise ProbeError("PROBE_STOPPED")
            if self.failure_code:
                raise ProbeError(self.failure_code)
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key]
            if self.reserved_bytes + length > self.limit_bytes or len(self.ranges) >= 8192:
                self.failure_code = "READ_BUDGET_EXCEEDED"
                raise ProbeError(self.failure_code)
            self.reserved_bytes += length
            self.active_reads += 1
            self.in_flight.add(key)
        try:
            return self._read_reserved(key, start, length)
        finally:
            with self.idle:
                self.active_reads -= 1
                self.in_flight.discard(key)
                self.idle.notify_all()

    def _read_reserved(self, key, start, length):
        for attempt in range(1, 4):
            with self.lock:
                if self.stopped:
                    raise ProbeError("PROBE_STOPPED")
                if time.monotonic() >= self.deadline:
                    self.failure_code = "PROBE_DEADLINE_EXCEEDED"
                    raise ProbeError(self.failure_code)
                if attempt > 1:
                    if self.reserved_bytes + length > self.limit_bytes:
                        self.failure_code = "READ_BUDGET_EXCEEDED"
                        raise ProbeError(self.failure_code)
                    self.reserved_bytes += length
                    self.retry_reserved_bytes += length
                    self.retry_count += 1
                self.get_attempts += 1
            try:
                data = self.fetch(key[0], key[1], self.deadline)
                break
            except ProbeError as error:
                with self.lock:
                    self.received_bytes += error.received_bytes
                    if attempt > 1:
                        self.retry_received_bytes += error.received_bytes
                    if len(self.transport_diagnostics) < 32:
                        self.transport_diagnostics.append({"rangeStart": start, "rangeEnd": key[1], "attempt": attempt,
                            "code": str(error), **_diagnostic(error.diagnostic)})
                if attempt < 3 and _retryable(error) and not self.stopped:
                    delay = 0.05 * attempt
                    if time.monotonic() + delay >= self.deadline:
                        with self.lock:
                            self.failure_code = "PROBE_DEADLINE_EXCEEDED"
                        raise ProbeError(self.failure_code) from None
                    time.sleep(delay)
                    continue
                with self.lock:
                    if not (self.stopped and str(error) == "PROBE_STOPPED"):
                        self.failure_code = str(error)
                raise
            except Exception:
                with self.lock:
                    self.failure_code = "UPSTREAM_READ_FAILED"
                raise ProbeError("UPSTREAM_READ_FAILED") from None
        with self.lock:
            self.received_bytes += len(data)
            if attempt > 1:
                self.retry_received_bytes += len(data)
            if len(data) != length:
                self.failure_code = "UPSTREAM_RANGE_INVALID"
                raise ProbeError(self.failure_code)
            self.ranges.append({"start": start, "endInclusive": key[1], "bytes": length, "sha256": hashlib.sha256(data).hexdigest()})
            self.cache[key] = data
            self.cache_bytes += len(data)
            while self.cache_bytes > self.cache_capacity_bytes:
                _, removed = self.cache.popitem(last=False)
                self.cache_bytes -= len(removed)
        return data

    def proof(self):
        with self.lock:
            return {"limitBytes": self.limit_bytes, "reservedBytes": self.reserved_bytes,
                "receivedBytes": self.received_bytes, "ranges": list(self.ranges), "wholeSourceSha256": None,
                "hashScope": "DOWNLOADED_RANGES_ONLY", "failureCode": self.failure_code,
                "byteCountComplete": self.active_reads == 0,
                "cacheBlockBytes": self.cache_block_bytes, "cacheCapacityBytes": self.cache_capacity_bytes,
                "getAttemptCount": self.get_attempts, "transportRetryCount": self.retry_count,
                "retryReservedBytes": self.retry_reserved_bytes, "retryReceivedBodyBytes": self.retry_received_bytes,
                "transportDiagnostics": list(self.transport_diagnostics), "getMaxAttemptsPerRange": 3,
                "presign": getattr(self, "presign_proof", None),
                "unhashedReceivedBytes": self.received_bytes - sum(item["bytes"] for item in self.ranges)}


class LocalRangeProxy(AbstractContextManager):
    def __init__(self, reader, chunk_bytes=1024 * 1024):
        self.reader = reader
        self.chunk_bytes = chunk_bytes
        self.path = "/_probe/" + secrets.token_hex(24)
        if type(chunk_bytes) is not int or not 1 <= chunk_bytes <= 1024 * 1024:
            raise ProbeError("CHUNK_LIMIT_INVALID")

    def __enter__(self):
        proxy = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_HEAD(self):
                if self.path != proxy.path:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(proxy.reader.size))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Connection", "close")
                self.end_headers()

            def do_GET(self):
                if self.path != proxy.path:
                    self.send_error(404)
                    return
                raw = self.headers.get("Range")
                start, end = 0, proxy.reader.size - 1
                if raw:
                    if len(raw) > 128:
                        self.send_error(416)
                        return
                    match = re.fullmatch(r"bytes=(\d*)-(\d*)", raw)
                    if not match or not any(match.groups()):
                        self.send_error(416)
                        return
                    if match.group(1):
                        start = int(match.group(1))
                        end = int(match.group(2)) if match.group(2) else end
                    else:
                        start = max(0, proxy.reader.size - int(match.group(2)))
                    end = min(end, proxy.reader.size - 1)
                if start > end or start >= proxy.reader.size:
                    self.send_error(416)
                    return
                self.send_response(206 if raw else 200)
                self.send_header("Content-Length", str(end - start + 1))
                if raw:
                    self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, proxy.reader.size))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                while start <= end:
                    try:
                        data = proxy.reader.read(start, min(proxy.chunk_bytes, end - start + 1))
                        self.connection.settimeout(max(0.001, min(1, proxy.reader.deadline - time.monotonic())))
                        self.wfile.write(data)
                        self.wfile.flush()
                        start += len(data)
                    except (ProbeError, OSError):
                        self.close_connection = True
                        return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()
        return "http://127.0.0.1:%d%s" % (self.server.server_port, self.path)

    def __exit__(self, *args):
        self.reader.stop()
        self.reader.wait_until_idle()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)


def project_metadata(raw, *, complete):
    stream_fields = {"index", "codec_type", "codec_name", "width", "height", "pix_fmt", "field_order", "r_frame_rate", "avg_frame_rate",
        "sample_aspect_ratio", "time_base", "start_time", "duration", "nb_frames", "sample_rate", "channels", "channel_layout", "color_space", "color_transfer", "color_primaries"}
    format_fields = {"format_name", "start_time", "duration"}
    streams = [{key: value for key, value in item.items() if key in stream_fields and isinstance(value, (str, int, float))}
        for item in raw.get("streams", []) if isinstance(item, dict)][:128]
    video = [stream for stream in streams if stream.get("codec_type") == "video"]
    audio = [stream for stream in streams if stream.get("codec_type") == "audio"]
    assessment = "UNRESOLVED"
    if complete:
        assessment = "VIDEO_PRESENT" if video else "AUDIO_ONLY_CONFIRMED" if audio else "NO_MEDIA_STREAMS"
    return {"streams": streams, "format": {key: value for key, value in raw.get("format", {}).items()
        if key in format_fields and isinstance(value, (str, int, float))}, "assessment": assessment,
        "clockScope": "ORIGINAL_HEADER_PRESENTATION_METADATA_NOT_NORMALIZED_CFR", "normalizedClock": None}


class HTTPSRangeFetcher:
    def __init__(self, url, source, connection_factory=http.client.HTTPSConnection):
        self.parts = urlsplit(validate_source_url(url, source))
        self.source, self.connection_factory = source, connection_factory
        self.lock, self.active, self.stopped = threading.Lock(), set(), False

    def stop(self):
        with self.lock:
            self.stopped = True
            active = list(self.active)
        for connection in active:
            connection.close()

    def __call__(self, start, end, deadline):
        connection = response = None
        data = bytearray()
        phase = "CONNECT"
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProbeError("PROBE_DEADLINE_EXCEEDED")
            connection = self.connection_factory(self.parts.hostname, timeout=remaining, context=ssl.create_default_context())
            with self.lock:
                if self.stopped:
                    raise ProbeError("PROBE_STOPPED")
                self.active.add(connection)
            target = self.parts.path + ("?" + self.parts.query if self.parts.query else "")
            connection.request("GET", target, headers={"Range": "bytes=%d-%d" % (start, end), "If-Match": self.source["etag"]})
            phase = "HEADERS"
            response = connection.getresponse()
            if response.status in {500, 502, 503, 504}:
                raise ProbeError("UPSTREAM_TRANSIENT_HTTP", diagnostic={"httpStatus": response.status, "phase": phase})
            if response.status == 403:
                raise ProbeError("UPSTREAM_ACCESS_DENIED", diagnostic={"httpStatus": 403, "phase": phase})
            if response.status == 412:
                raise ProbeError("SOURCE_CHANGED")
            length = end - start + 1
            if (response.status != 206
                or response.getheader("Content-Range") != "bytes %d-%d/%d" % (start, end, self.source["sizeBytes"])
                or response.getheader("Content-Length") != str(length)
                or response.getheader("ETag") != self.source["etag"]):
                raise ProbeError("UPSTREAM_RANGE_INVALID")
            phase = "BODY"
            while len(data) < length:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ProbeError("PROBE_DEADLINE_EXCEEDED")
                # HTTPConnection detaches/closes its socket for Connection:
                # close while HTTPResponse's file object remains readable.
                if connection.sock is not None:
                    connection.sock.settimeout(remaining)
                part = response.read1(min(65536, length - len(data)))
                if not part:
                    raise ProbeError("PROBE_STOPPED" if self.stopped else "UPSTREAM_READ_FAILED", diagnostic={"exceptionType": "IncompleteRead", "phase": phase})
                data.extend(part)
            return bytes(data)
        except ProbeError as error:
            raise ProbeError(str(error), len(data), error.diagnostic) from None
        except Exception as error:
            detail = {"exceptionType": type(error).__name__, "osCode": errno.errorcode.get(getattr(error, "errno", None)),
                "phase": phase, "connectionClose": bool(response and (response.getheader("Connection") or "").lower() == "close"),
                "connectionSocketPresent": bool(connection and connection.sock is not None)}
            raise ProbeError("PROBE_STOPPED" if self.stopped else "UPSTREAM_READ_FAILED", len(data), detail) from None
        finally:
            if response:
                response.close()
            if connection:
                connection.close()
                with self.lock:
                    self.active.discard(connection)
