import os
import datetime
import threading
import time
import unittest

import execution


def stalled_worker(connection, payload):
    time.sleep(10)


def safe_worker(connection, payload):
    connection.send({"ok": True, "result": {"alias": "asset-test", "receivedBytes": 0}})
    connection.close()


class ExecutionTests(unittest.TestCase):
    def test_entry_waits_for_parent_ownership_before_worker_can_launch_native_children(self):
        from unittest.mock import patch
        events = []
        class Connection:
            def send(self, value): events.append(value["kind"])
            def close(self): events.append("closed")
        class Gate:
            def wait(self): events.append("ownership-allowed")
        def worker(connection, payload):
            self.assertEqual(events, ["session", "ready", "ownership-allowed"])
            events.append("worker")
        with patch("execution.os.setsid", side_effect=lambda: events.append("session")):
            execution._entry(worker, Connection(), {}, Gate())
        self.assertEqual(events, ["session", "ready", "ownership-allowed", "worker", "closed"])

    def test_interrupt_during_start_or_send_close_cleans_partial_start_and_both_pipes(self):
        from unittest.mock import patch
        for stage in ("start_before_pid", "start_after_pid", "send_close"):
            with self.subTest(stage=stage):
                class Process:
                    pid = None
                    alive, closed = False, False
                    def start(self):
                        if stage == "start_before_pid": raise KeyboardInterrupt()
                        self.pid, self.alive = 123456, True
                        if stage == "start_after_pid": raise KeyboardInterrupt()
                    def is_alive(self): return self.alive
                    def join(self, timeout):
                        if self.pid is None: raise AssertionError("cannot join an unstarted process")
                    def terminate(self): self.alive = False
                    def kill(self): self.alive = False
                    def close(self): self.closed = True
                class Pipe:
                    closed, close_calls = False, 0
                    def close(self):
                        self.close_calls += 1
                        if self is send and stage == "send_close" and self.close_calls == 1:
                            raise KeyboardInterrupt()
                        self.closed = True
                    def poll(self, timeout): return False
                child, receive, send = Process(), Pipe(), Pipe()
                class Context:
                    def Pipe(self, duplex): return receive, send
                    def Event(self): return threading.Event()
                    def Process(self, **kwargs): return child
                with patch("execution.multiprocessing.get_context", return_value=Context()), \
                    patch("execution.os.getpgid", return_value=123456), \
                    patch("execution.os.killpg", side_effect=lambda *args: setattr(child, "alive", False)) as killed:
                    with self.assertRaises(KeyboardInterrupt):
                        execution.run_isolated(stalled_worker, {}, timeout_seconds=1)
                self.assertFalse(child.alive)
                self.assertTrue(child.closed)
                self.assertTrue(receive.closed)
                self.assertTrue(send.closed)
                self.assertEqual(killed.call_count, 0 if stage == "start_before_pid" else 2)

    def test_startup_sigint_is_deferred_until_the_created_pid_is_retained(self):
        from unittest.mock import patch
        class Process:
            pid, alive, closed, finished_start = None, False, False, False
            def start(self):
                execution.signal.raise_signal(execution.signal.SIGINT)
                self.pid, self.alive, self.finished_start = 123456, True, True
            def is_alive(self): return self.alive
            def join(self, timeout): pass
            def terminate(self): self.alive = False
            def kill(self): self.alive = False
            def close(self): self.closed = True
        class Pipe:
            closed = False
            def close(self): self.closed = True
            def poll(self, timeout): return False
        child, receive, send = Process(), Pipe(), Pipe()
        class Context:
            def Pipe(self, duplex): return receive, send
            def Event(self): return threading.Event()
            def Process(self, **kwargs): return child
        original_mask = execution.signal.pthread_sigmask(execution.signal.SIG_BLOCK, set())
        with patch("execution.multiprocessing.get_context", return_value=Context()), \
            patch("execution.os.getpgid", return_value=123456), \
            patch("execution.os.killpg", side_effect=lambda *args: setattr(child, "alive", False)):
            with self.assertRaises(KeyboardInterrupt):
                execution.run_isolated(stalled_worker, {}, timeout_seconds=1)
        self.assertTrue(child.finished_start)
        self.assertFalse(child.alive)
        self.assertTrue(child.closed and receive.closed and send.closed)
        self.assertEqual(execution.signal.pthread_sigmask(execution.signal.SIG_BLOCK, set()), original_mask)

    def test_fresh_presign_lifetime_covers_the_operation_without_persisting_url_or_credentials(self):
        now = datetime.datetime(2026, 11, 6, tzinfo=datetime.timezone.utc)
        url = "https://bucket.s3.ap-northeast-1.amazonaws.com/private?X-Amz-Date=20261106T000000Z&X-Amz-Expires=1200&X-Amz-Credential=SECRET&X-Amz-Signature=SECRET"
        proof = execution.presign_lifetime_proof(url, 600, now)
        self.assertEqual(proof["lifetimeSeconds"], 1200)
        self.assertTrue(proof["coversDeclaredOperationDeadline"])
        self.assertNotIn("SECRET", str(proof))
        with self.assertRaisesRegex(execution.OperationError, "PRESIGN_LIFETIME_TOO_SHORT"):
            execution.presign_lifetime_proof(url.replace("1200", "60"), 600, now)
    def test_parent_deadline_terminates_only_the_owned_worker_process_group(self):
        start = time.monotonic()
        result = execution.run_isolated(stalled_worker, {}, timeout_seconds=0.3)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "OPERATION_DEADLINE_EXCEEDED")
        self.assertTrue(result["cleanupConfirmed"])
        self.assertLess(time.monotonic() - start, 3)

    def test_success_requires_worker_exit_and_returns_projected_result(self):
        result = execution.run_isolated(safe_worker, {}, timeout_seconds=5)
        self.assertTrue(result["ok"])
        self.assertTrue(result["cleanupConfirmed"])
        self.assertEqual(result["result"], {"alias": "asset-test", "receivedBytes": 0})

    def test_operator_interrupt_cleans_the_owned_worker_before_propagating(self):
        from unittest.mock import patch
        class Process:
            pid = 123456
            alive, closed, terminated = True, False, False
            def start(self): pass
            def is_alive(self): return self.alive
            def join(self, timeout): pass
            def terminate(self): self.terminated, self.alive = True, False
            def kill(self): self.alive = False
            def close(self): self.closed = True
        class Pipe:
            closed = False
            def close(self): self.closed = True
            def poll(self, timeout): raise KeyboardInterrupt()
        child, receive, send = Process(), Pipe(), Pipe()
        class Context:
            def Pipe(self, duplex): return receive, send
            def Event(self): return threading.Event()
            def Process(self, **kwargs): return child
        with patch("execution.multiprocessing.get_context", return_value=Context()), patch("execution.os.killpg") as kill_group:
            with self.assertRaises(KeyboardInterrupt):
                execution.run_isolated(stalled_worker, {}, timeout_seconds=1)
        self.assertFalse(child.alive)
        self.assertTrue(child.terminated)
        self.assertTrue(child.closed)
        self.assertTrue(receive.closed)
        kill_group.assert_not_called()

    def test_interrupt_before_ready_is_received_still_closes_only_its_created_child_session(self):
        from unittest.mock import patch
        class Process:
            pid = 123456
            alive, closed = True, False
            def start(self): pass
            def is_alive(self): return self.alive
            def join(self, timeout): pass
            def terminate(self): raise AssertionError("must stop the owned session, not leave its native child")
            def kill(self): self.alive = False
            def close(self): self.closed = True
        class Pipe:
            def close(self): pass
            def poll(self, timeout): raise KeyboardInterrupt()
        child, receive, send = Process(), Pipe(), Pipe()
        class Context:
            def Pipe(self, duplex): return receive, send
            def Event(self): return threading.Event()
            def Process(self, **kwargs): return child
        signals = []
        def kill_group(pid, number):
            signals.append((pid, number))
            child.alive = False
        with patch("execution.multiprocessing.get_context", return_value=Context()), \
            patch("execution.os.getpgid", return_value=child.pid), patch("execution.os.killpg", side_effect=kill_group):
            with self.assertRaises(KeyboardInterrupt):
                execution.run_isolated(stalled_worker, {}, timeout_seconds=1)
        self.assertFalse(child.alive)
        self.assertTrue(child.closed)
        self.assertEqual(signals, [(child.pid, execution.signal.SIGTERM), (child.pid, execution.signal.SIGKILL)])

    def test_revised_materialize_admits_900s_only_after_policy_guard_before_any_fetch(self):
        from unittest.mock import patch
        import tempfile
        metadata = {"assessment": "VIDEO_PRESENT", "format": {"duration": "600"}, "streams": [{"codec_type": "video"}]}
        with tempfile.TemporaryDirectory() as directory:
            payload = {"limitBytes": 6 * 1024**3, "deadlineSeconds": 900, "metadata": metadata, "toolIdentity": {},
                "outputDirectory": directory, "source": {}, "assetId": "asset-test", "cacheBlockBytes": 8 * 1024**2,
                "cacheCapacityBytes": 32 * 1024**2,
                "budgetRevision": {"version": "clip-quality-materialize-revision-v2", "sha256": "f" * 64}}
            with patch("execution._reader", side_effect=RuntimeError("ADMITTED_REVISED_POLICY")) as reader:
                with self.assertRaisesRegex(RuntimeError, "ADMITTED_REVISED_POLICY"):
                    execution.materialize_worker(None, payload)
                self.assertTrue(reader.call_args.kwargs["materialize"])
            payload.pop("budgetRevision")
            with patch("execution._reader") as reader:
                with self.assertRaisesRegex(execution.OperationError, "MATERIALIZE_LIMIT_INVALID"):
                    execution.materialize_worker(None, payload)
                reader.assert_not_called()

    def test_metadata_probe_reader_stays_1mib_8mib_and_materialize_revision_uses_8mib_32mib(self):
        from unittest.mock import patch
        payload = {"limitBytes": 64 * 1024**2, "deadlineSeconds": 45, "cacheBlockBytes": 8 * 1024**2,
            "cacheCapacityBytes": 32 * 1024**2,
            "budgetRevision": {"version": "clip-quality-materialize-revision-v2", "sha256": "f" * 64}}
        with patch("execution.signed_source_url", return_value="unused private URL"), \
            patch("execution.presign_lifetime_proof", return_value={}), \
            patch("execution.HTTPSRangeFetcher", return_value=lambda *args: b""):
            probe_reader = execution._reader({"sizeBytes": 100}, payload, time.monotonic() + 5, None)
            self.assertEqual(probe_reader.proof()["cacheBlockBytes"], 1024**2)
            self.assertEqual(probe_reader.proof()["cacheCapacityBytes"], 8 * 1024**2)
            revised_reader = execution._reader({"sizeBytes": 100}, payload, time.monotonic() + 5, None, materialize=True)
            self.assertEqual(revised_reader.proof()["cacheBlockBytes"], 8 * 1024**2)
            self.assertEqual(revised_reader.proof()["cacheCapacityBytes"], 32 * 1024**2)

    def test_excerpt_recipe_has_independent_zero_clock_and_bounded_source_window(self):
        metadata = {"assessment": "VIDEO_PRESENT", "streams": [{"codec_type": "video", "color_transfer": "bt709", "field_order": "tt"}],
                    "format": {"duration": "1200.5", "start_time": "3600"}}
        recipe = execution.excerpt_recipe(metadata)
        self.assertEqual(recipe["sourceOffsetUs"], 300000000)
        self.assertEqual(recipe["requestedDurationUs"], 180000000)
        self.assertEqual(recipe["outputClock"]["startUs"], 0)
        self.assertEqual(recipe["outputClock"]["fps"], {"num": 30, "den": 1})
        self.assertEqual(recipe["sourceHeaderStartSeconds"], "3600")
        self.assertEqual(recipe["sourceOffsetPrecision"], "REQUESTED_SEEK_WITH_DECODER_FRAME_ROUNDING")
        self.assertIn("bwdif", recipe["videoFilter"])
        self.assertIn("setpts=PTS-STARTPTS", recipe["videoFilter"])
        self.assertEqual(execution.excerpt_recipe({**metadata, "format": {"duration": "90"}})["sourceOffsetUs"], 0)
        self.assertEqual(execution.excerpt_recipe({**metadata, "format": {"duration": "200.5"}})["sourceOffsetUs"], 20000000)

    def test_hdr_unknown_duration_and_audio_only_are_not_silently_normalized(self):
        video = {"assessment": "VIDEO_PRESENT", "streams": [{"codec_type": "video", "color_transfer": "smpte2084"}], "format": {"duration": "600"}}
        with self.assertRaisesRegex(execution.OperationError, "HDR_REQUIRES_EXPLICIT_TONEMAP_POLICY"):
            execution.excerpt_recipe(video)
        with self.assertRaisesRegex(execution.OperationError, "SOURCE_DURATION_UNAVAILABLE"):
            execution.excerpt_recipe({**video, "streams": [{"codec_type": "video"}], "format": {}})
        with self.assertRaisesRegex(execution.OperationError, "VIDEO_NOT_CONFIRMED"):
            execution.excerpt_recipe({"assessment": "AUDIO_ONLY_CONFIRMED"})


if __name__ == "__main__":
    unittest.main()
