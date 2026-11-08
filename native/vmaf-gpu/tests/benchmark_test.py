#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
import importlib.util
import copy
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location("native_benchmark", Path(__file__).parents[1] / "benchmark.py")
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class BenchmarkProcessTests(unittest.TestCase):
    def test_pooling_is_verified_in_addition_to_matching_frame_scores(self):
        expected = {key: "identity" for key in ("referenceSha256", "distortedSha256", "officialRevision", "sourceSha256")}
        expected.update(frames=2, width=640, height=360, bitDepth=10,
                        features=[{"name": "feature", "index": i, "value": 1.0} for i in range(2)],
                        models=[{"id": "model", "sha256": "modelhash", "frames": [90.0, 92.0],
                                 "pooled": {"mean": 91.0, "min": 90.0, "max": 92.0, "harmonicMean": 90.98913043478261}}])
        actual = copy.deepcopy(expected)
        benchmark.verify(expected, actual)
        actual["models"][0]["pooled"]["mean"] = 80.0
        with self.assertRaisesRegex(ValueError, "Pooled VMAF parity failed"):
            benchmark.verify(expected, actual)

    def test_complete_process_captures_exit_and_output(self):
        result = benchmark.run_measured([sys.executable, "-c", "print('complete')"], 10)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "complete\n")

    @unittest.skipUnless(sys.platform == "linux", "checks Linux descendant process state")
    def test_timeout_stops_wrapper_and_native_descendant_with_open_pipes(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "owned-child.pid"
            program = ("import pathlib,subprocess,sys,time; "
                       "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); "
                       "pathlib.Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(60)")
            start = time.monotonic()
            with self.assertRaises(subprocess.TimeoutExpired):
                benchmark.run_measured([sys.executable, "-c", program, str(pid_file)], 0.5)
            self.assertLess(time.monotonic() - start, 8)
            self.assertTrue(pid_file.exists())
            child = int(pid_file.read_text())
            state = Path(f"/proc/{child}/stat")
            try:
                status = state.read_text()
            except FileNotFoundError:
                return  # Already reaped by init.
            # A killed descendant can briefly await reaping by init.
            self.assertEqual(status.split(") ", 1)[1].split()[0], "Z")


if __name__ == "__main__":
    unittest.main()
