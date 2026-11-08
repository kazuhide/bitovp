import hashlib
import time
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import bounded_probe as probe


class FakeFetch:
    def __init__(self, data=b"abcdefghij"):
        self.data = data
        self.calls = []

    def __call__(self, start, end, deadline):
        self.calls.append((start, end))
        return self.data[start:end + 1]


class ProbeTests(unittest.TestCase):
    def reader(self, limit=10, data=b"abcdefghij"):
        fetch = FakeFetch(data)
        reader = probe.BoundedReader(len(data), fetch, limit_bytes=limit, deadline=time.monotonic() + 5)
        return reader, fetch

    def test_materialize_large_clusters_return_identical_bytes_with_bounded_lru_and_exact_quota(self):
        mib = 1024**2
        data = b"".join(bytes([index]) * mib for index in range(32))
        hashes = []
        for cluster in (mib, 4 * mib, 8 * mib):
            fetch = FakeFetch(data)
            reader = probe.BoundedReader(len(data), fetch, limit_bytes=len(data), deadline=time.monotonic() + 5,
                cache_block_bytes=cluster, cache_capacity_bytes=32 * mib)
            output = hashlib.sha256()
            for start in range(0, len(data), mib):
                output.update(reader.read(start, mib))
            hashes.append(output.hexdigest())
            self.assertEqual(len(fetch.calls), len(data) // cluster)
            self.assertEqual(reader.proof()["reservedBytes"], len(data))
            self.assertEqual(reader.proof()["receivedBytes"], len(data))
            self.assertEqual(reader.proof()["cacheCapacityBytes"], 32 * mib)
            self.assertLessEqual(reader.cache_bytes, 32 * mib)
            self.assertIsNone(reader.proof()["wholeSourceSha256"])
        self.assertEqual(hashes, [hashlib.sha256(data).hexdigest()] * 3)

    def test_large_cluster_lru_retains_interleaved_video_audio_and_rejects_overfetch_before_get(self):
        mib = 1024**2
        data = b"".join(bytes([index]) * mib for index in range(32))
        fetch = FakeFetch(data)
        reader = probe.BoundedReader(len(data), fetch, limit_bytes=16 * mib, deadline=time.monotonic() + 5,
            cache_block_bytes=8 * mib, cache_capacity_bytes=32 * mib)
        for _ in range(6):
            for start in (123, 16 * mib + 123):
                self.assertEqual(reader.read(start, 100), data[start:start + 100])
        self.assertEqual(len(fetch.calls), 2)
        self.assertEqual(reader.proof()["receivedBytes"], 16 * mib)
        fetch = FakeFetch(data)
        too_small = probe.BoundedReader(len(data), fetch, limit_bytes=4 * mib, deadline=time.monotonic() + 5,
            cache_block_bytes=8 * mib, cache_capacity_bytes=32 * mib)
        with self.assertRaisesRegex(probe.ProbeError, "READ_BUDGET_EXCEEDED"):
            too_small.read(1, 1)
        self.assertEqual(fetch.calls, [])

    def test_large_cluster_retry_reserves_again_and_reader_refuses_above_explicit_six_gib_ceiling(self):
        mib = 1024**2
        calls = []
        def fetch(start, end, deadline):
            calls.append((start, end))
            if len(calls) == 1:
                raise probe.ProbeError("UPSTREAM_TRANSIENT_HTTP", diagnostic={"httpStatus": 503})
            return b"x" * (end - start + 1)
        reader = probe.BoundedReader(8 * mib, fetch, limit_bytes=16 * mib, deadline=time.monotonic() + 5,
            cache_block_bytes=8 * mib, cache_capacity_bytes=32 * mib)
        self.assertEqual(reader.read(0, 1), b"x")
        self.assertEqual(calls, [(0, 8 * mib - 1)] * 2)
        self.assertEqual(reader.proof()["reservedBytes"], 16 * mib)
        self.assertEqual(reader.proof()["retryReservedBytes"], 8 * mib)
        with self.assertRaisesRegex(probe.ProbeError, "READ_LIMIT_INVALID"):
            probe.BoundedReader(10, fetch, limit_bytes=6 * 1024**3 + 1, deadline=time.monotonic() + 5)

    def test_read_budget_is_reserved_before_network_and_fragment_sha_is_not_whole_hash(self):
        reader, fetch = self.reader(limit=6)
        self.assertEqual(reader.read(0, 4), b"abcd")
        with self.assertRaisesRegex(probe.ProbeError, "READ_BUDGET_EXCEEDED"):
            reader.read(4, 4)
        self.assertEqual(fetch.calls, [(0, 3)])
        proof = reader.proof()
        self.assertEqual(proof["receivedBytes"], 4)
        self.assertEqual(proof["ranges"][0]["sha256"], hashlib.sha256(b"abcd").hexdigest())
        self.assertIsNone(proof["wholeSourceSha256"])

    def test_fixed_block_cache_reuses_overlapping_audio_video_seeks_instead_of_redownloading(self):
        reader, fetch = self.reader(limit=8)
        reader.cache_block_bytes = 4
        self.assertEqual(reader.read(1, 5), b"bcdef")
        self.assertEqual(reader.read(2, 5), b"cdefg")
        self.assertEqual(fetch.calls, [(0, 3), (4, 7)])
        self.assertEqual(reader.proof()["receivedBytes"], 8)

    def test_concurrent_reads_of_the_same_block_share_one_reserved_fetch(self):
        started, release = threading.Event(), threading.Event()
        calls, results, errors = [], [], []
        def fetch(start, end, deadline):
            calls.append((start, end))
            started.set()
            release.wait(1)
            return b"abcd"
        reader = probe.BoundedReader(4, fetch, limit_bytes=4, deadline=time.monotonic() + 2, cache_block_bytes=4)
        def read():
            try: results.append(reader.read(0, 4))
            except probe.ProbeError as error: errors.append(str(error))
        one, two = threading.Thread(target=read), threading.Thread(target=read)
        one.start()
        self.assertTrue(started.wait(1))
        two.start()
        time.sleep(0.01)
        release.set()
        one.join(1)
        two.join(1)
        self.assertEqual(errors, [])
        self.assertEqual(results, [b"abcd", b"abcd"])
        self.assertEqual(calls, [(0, 3)])

    def test_same_get_transient_retry_is_three_attempts_max_and_reserves_every_attempt(self):
        calls = []
        def fetch(start, end, deadline):
            calls.append((start, end))
            if len(calls) < 3:
                error = probe.ProbeError("UPSTREAM_READ_FAILED")
                error.diagnostic = {"httpStatus": 503}
                raise error
            return b"data"
        reader = probe.BoundedReader(4, fetch, limit_bytes=12, deadline=time.monotonic() + 2)
        self.assertEqual(reader.read(0, 4), b"data")
        self.assertEqual(calls, [(0, 3)] * 3)
        self.assertEqual(reader.proof()["reservedBytes"], 12)
        self.assertEqual(reader.proof()["transportRetryCount"], 2)
        self.assertEqual(reader.proof()["retryReservedBytes"], 8)

    def test_auth_source_mismatch_unknown_errors_and_retry_budget_exhaustion_fail_closed(self):
        for code, diagnostic in [("SOURCE_CHANGED", {"httpStatus": 412}), ("UPSTREAM_RANGE_INVALID", {"httpStatus": 206}),
                                 ("UPSTREAM_READ_FAILED", {"httpStatus": 403}), ("UPSTREAM_READ_FAILED", {"exceptionType": "SSLError"})]:
            calls = []
            def fetch(*args):
                calls.append(args)
                error = probe.ProbeError(code)
                error.diagnostic = diagnostic
                raise error
            reader = probe.BoundedReader(4, fetch, limit_bytes=12, deadline=time.monotonic() + 2)
            with self.assertRaises(probe.ProbeError): reader.read(0, 4)
            self.assertEqual(len(calls), 1)
        calls = []
        def transient(*args):
            calls.append(args)
            error = probe.ProbeError("UPSTREAM_READ_FAILED")
            error.diagnostic = {"httpStatus": 503}
            raise error
        reader = probe.BoundedReader(4, transient, limit_bytes=4, deadline=time.monotonic() + 2)
        with self.assertRaisesRegex(probe.ProbeError, "READ_BUDGET_EXCEEDED"): reader.read(0, 4)
        self.assertEqual(len(calls), 1)

    def test_deadline_and_invalid_ranges_do_not_start_a_fetch(self):
        reader, fetch = self.reader()
        reader.deadline = time.monotonic() - 1
        with self.assertRaisesRegex(probe.ProbeError, "PROBE_DEADLINE_EXCEEDED"):
            reader.read(0, 1)
        self.assertEqual(fetch.calls, [])
        reader, fetch = self.reader()
        for start, length in [(-1, 1), (0, 0), (9, 2), (True, 1)]:
            with self.assertRaisesRegex(probe.ProbeError, "RANGE_INVALID"):
                reader.read(start, length)
        self.assertEqual(fetch.calls, [])

    def test_bad_upstream_length_is_not_accepted_or_cached(self):
        reader = probe.BoundedReader(10, lambda *args: b"too much data", limit_bytes=10, deadline=time.monotonic() + 5)
        with self.assertRaisesRegex(probe.ProbeError, "UPSTREAM_RANGE_INVALID"):
            reader.read(0, 2)
        self.assertEqual(reader.proof()["ranges"], [])

    def test_inflight_reads_are_not_reported_as_complete_byte_counts(self):
        started, release = threading.Event(), threading.Event()
        def delayed(*args):
            started.set()
            release.wait(1)
            return b"x"
        reader = probe.BoundedReader(1, delayed, limit_bytes=1, deadline=time.monotonic() + 2)
        thread = threading.Thread(target=reader.read, args=(0, 1))
        thread.start()
        try:
            self.assertTrue(started.wait(1))
            self.assertFalse(reader.proof()["byteCountComplete"])
        finally:
            release.set()
            thread.join(1)
        self.assertTrue(reader.proof()["byteCountComplete"])

    def test_unknown_transport_error_text_cannot_escape_into_private_or_public_diagnostics(self):
        reader = probe.BoundedReader(10, lambda *args: (_ for _ in ()).throw(probe.ProbeError("https://SECRET")),
            limit_bytes=10, deadline=time.monotonic() + 1)
        with self.assertRaises(probe.ProbeError) as error:
            reader.read(0, 1)
        self.assertNotIn("SECRET", str(error.exception))
        self.assertNotIn("SECRET", str(reader.proof()))

    def test_loopback_proxy_handles_tail_ranges_without_downloading_an_entire_object(self):
        data = b"x" * 10000 + b"footer"
        reader, fetch = self.reader(limit=12, data=data)
        with probe.LocalRangeProxy(reader, chunk_bytes=6) as url:
            with urlopen(Request(url, headers={"Range": "bytes=10000-10005"}), timeout=2) as response:
                self.assertEqual(response.status, 206)
                self.assertEqual(response.headers["Content-Range"], "bytes 10000-10005/10006")
                self.assertEqual(response.read(), b"footer")
            with self.assertRaises(HTTPError) as error:
                urlopen(url + "/wrong", timeout=2)
            self.assertEqual(error.exception.code, 404)
        self.assertEqual(fetch.calls, [(10000, 10005)])

    def test_url_validation_binds_exact_https_host_bucket_key_and_never_echoes_secret(self):
        source = {"bucket": "example-bucket", "region": "ap-northeast-1", "key": "private/movie.mp4"}
        valid = "https://example-bucket.s3.ap-northeast-1.amazonaws.com/private/movie.mp4?X-Amz-Signature=SECRET"
        self.assertEqual(probe.validate_source_url(valid, source), valid)
        for url in [valid.replace("https:", "http:"), valid.replace("example-bucket.s3", "attacker.s3"),
                    valid.replace("private/movie.mp4", "private/other.mp4"), "https://127.0.0.1/?SECRET"]:
            with self.assertRaises(probe.ProbeError) as error:
                probe.validate_source_url(url, source)
            self.assertEqual(str(error.exception), "SOURCE_URL_NOT_ALLOWED")
            self.assertNotIn("SECRET", str(error.exception))

    def test_probe_projection_distinguishes_audio_only_from_failed_or_incomplete_analysis(self):
        audio = {"streams": [{"codec_type": "audio", "codec_name": "pcm_s24le", "sample_rate": "48000", "channels": 8}],
                 "format": {"duration": "10.000", "filename": "https://SECRET", "tags": {"private": "SECRET"}}}
        successful = probe.project_metadata(audio, complete=True)
        self.assertEqual(successful["assessment"], "AUDIO_ONLY_CONFIRMED")
        self.assertNotIn("SECRET", str(successful))
        self.assertEqual(probe.project_metadata(audio, complete=False)["assessment"], "UNRESOLVED")
        video = {"streams": [{"codec_type": "video", "codec_name": "h264", "width": 1280, "height": 720,
                              "r_frame_rate": "30000/1001", "avg_frame_rate": "30000/1001"}], "format": {"duration": "60"}}
        self.assertEqual(probe.project_metadata(video, complete=True)["assessment"], "VIDEO_PRESENT")
        self.assertEqual(probe.project_metadata({}, complete=True)["assessment"], "NO_MEDIA_STREAMS")

    def test_https_fetch_requires_exact_etag_content_range_and_206_without_redirect_or_body_overread(self):
        source = {"bucket": "example-bucket", "region": "ap-northeast-1", "key": "private/movie.mp4", "sizeBytes": 10, "etag": '"opaque"'}
        url = "https://example-bucket.s3.ap-northeast-1.amazonaws.com/private/movie.mp4?SECRET"

        class Response:
            status = 206
            headers = {"Content-Range": "bytes 2-5/10", "Content-Length": "4", "ETag": '"opaque"'}
            reads = []
            def getheader(self, key): return self.headers.get(key)
            def read1(self, size): self.reads.append(size); return b"cdef"
            def close(self): pass

        class Connection:
            sock = None
            def __init__(self, *args, **kwargs): self.response = Response()
            def request(self, method, target, headers): self.requested = (method, target, headers)
            def getresponse(self): return self.response
            def close(self): pass

        good = Connection()
        fetch = probe.HTTPSRangeFetcher(url, source, connection_factory=lambda *args, **kwargs: good)
        self.assertEqual(fetch(2, 5, time.monotonic() + 1), b"cdef")
        self.assertEqual(good.requested[2], {"Range": "bytes=2-5", "If-Match": '"opaque"'})
        self.assertEqual(good.response.reads, [4])
        for status, changed_header in [(302, None), (200, None), (412, None), (206, "ETag"), (206, "Content-Range"), (206, "Content-Length")]:
            bad = Connection()
            bad.response.status = status
            bad.response.headers = dict(Response.headers)
            bad.response.reads = []
            if changed_header: bad.response.headers[changed_header] = "wrong"
            fetch = probe.HTTPSRangeFetcher(url, source, connection_factory=lambda *args, **kwargs: bad)
            with self.assertRaises(probe.ProbeError): fetch(2, 5, time.monotonic() + 1)
            self.assertEqual(bad.response.reads, [])

    def test_intentional_stop_during_an_unused_response_eof_is_not_a_source_failure(self):
        source = {"bucket": "example-bucket", "region": "ap-northeast-1", "key": "private/movie.mp4", "sizeBytes": 4, "etag": "opaque"}
        class Response:
            status = 206
            def getheader(self, key): return {"Content-Range": "bytes 0-3/4", "Content-Length": "4", "ETag": "opaque"}.get(key)
            def read1(self, size): fetch.stop(); return b""
            def close(self): pass
        class Connection:
            sock = None
            def __init__(self, *args, **kwargs): pass
            def request(self, *args, **kwargs): pass
            def getresponse(self): return Response()
            def close(self): pass
        fetch = probe.HTTPSRangeFetcher("https://example-bucket.s3.ap-northeast-1.amazonaws.com/private/movie.mp4?SECRET", source, Connection)
        with self.assertRaisesRegex(probe.ProbeError, "^PROBE_STOPPED$"):
            fetch(0, 3, time.monotonic() + 1)

    def test_connection_close_response_remains_readable_after_httpconnection_detaches_its_socket(self):
        source = {"bucket": "example-bucket", "region": "ap-northeast-1", "key": "private/movie.mp4", "sizeBytes": 4, "etag": '"opaque"'}
        class DetachedSocket:
            def settimeout(self, value): raise OSError(9, "closed descriptor SECRET")
        class Response:
            status = 206
            def getheader(self, key): return {"Content-Range": "bytes 0-3/4", "Content-Length": "4", "ETag": '"opaque"', "Connection": "close"}.get(key)
            def read1(self, size): return b"data"
            def close(self): pass
        class Connection:
            def __init__(self, *args, **kwargs): self.sock = DetachedSocket()
            def request(self, *args, **kwargs): pass
            def getresponse(self): self.sock = None; return Response()
            def close(self): pass
        fetch = probe.HTTPSRangeFetcher("https://example-bucket.s3.ap-northeast-1.amazonaws.com/private/movie.mp4?SECRET", source, Connection)
        self.assertEqual(fetch(0, 3, time.monotonic() + 1), b"data")


if __name__ == "__main__":
    unittest.main()
