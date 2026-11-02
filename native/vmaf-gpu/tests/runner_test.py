#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Exercise actual demux/decode, temporal flush and result publication."""
import argparse
import hashlib
import json
import math
import subprocess
import tempfile
import unittest
from pathlib import Path


parser = argparse.ArgumentParser()
parser.add_argument("--binary", required=True, type=Path)
parser.add_argument("--models", required=True, type=Path)
parser.add_argument("--ffmpeg", default="ffmpeg")
args, remaining = parser.parse_known_args()


class RunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="bitovp-native-test-")
        cls.root = Path(cls.directory.name)
        cls.reference = cls.root / "reference.mkv"
        cls.distorted = cls.root / "distorted.mkv"
        cls.short = cls.root / "short.mkv"
        cls.model = args.models / "vmaf_v1.0.16/vmaf_v1.0.16_3d0h.json"
        commands = [
            ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-frames:v", "6", "-c:v", "ffv1", str(cls.reference)],
            ["-i", str(cls.reference), "-vf", "eq=brightness=0.03", "-c:v", "ffv1", str(cls.distorted)],
            ["-i", str(cls.reference), "-frames:v", "2", "-c:v", "ffv1", str(cls.short)],
        ]
        for command in commands:
            subprocess.run([args.ffmpeg, "-v", "error", "-nostdin", *command], check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def score(self, name, *, reference=None, distorted=None, extra=()):
        output = self.root / name
        command = [str(args.binary), "--reference", str(reference or self.reference),
                   "--distorted", str(distorted or self.distorted), "--output", str(output),
                   "--model", f"test={self.model}", *extra]
        run = subprocess.run(command, text=True, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, timeout=120)
        return run, output

    def test_actual_cpu_result_has_complete_unrounded_features_and_hashes(self):
        run, output = self.score("cpu.json")
        self.assertEqual(run.returncode, 0, run.stderr)
        receipt = json.loads(output.read_text())
        self.assertEqual(receipt["frames"], 6)
        self.assertEqual(receipt["referenceSha256"], hashlib.sha256(self.reference.read_bytes()).hexdigest())
        self.assertEqual(receipt["models"][0]["sha256"], hashlib.sha256(self.model.read_bytes()).hexdigest())
        self.assertEqual(receipt["backend"], "cpu")
        self.assertEqual(len(receipt["models"][0]["frames"]), 6)
        required = {name for spec in receipt["extractors"] for name in spec["features"]}
        series = {(feature["name"], feature["index"]) for feature in receipt["features"]}
        self.assertEqual(series, {(name, i) for name in required for i in range(6)})
        self.assertEqual(len(series), len(receipt["features"]))
        for feature in receipt["features"]:
            self.assertTrue(math.isfinite(feature["value"]))
        self.assertFalse(receipt["cpuParity"]["checked"])
        self.assertGreater(receipt["timingMs"]["wall"], 0)
        self.assertGreater(receipt["memory"]["maxRssBytes"], 0)

    def test_identical_input_uses_official_finite_psnr_caps(self):
        for bits in (8, 10):
            run, output = self.score(f"identical-{bits}.json", distorted=self.reference,
                                     extra=("--bit-depth", str(bits)))
            self.assertEqual(run.returncode, 0, run.stderr)
            psnr = [f["value"] for f in json.loads(output.read_text())["features"]
                    if f["name"] in ("psnr_y", "psnr_cb", "psnr_cr")]
            self.assertEqual(len(psnr), 18)
            self.assertEqual(set(psnr), {6 * bits + 12})

    def test_partial_comparison_is_explicit_and_flushes_temporal_features(self):
        run, output = self.score("limited.json", extra=("--max-frames", "2"))
        self.assertEqual(run.returncode, 0, run.stderr)
        receipt = json.loads(output.read_text())
        self.assertEqual(receipt["frames"], 2)
        self.assertEqual(len(receipt["models"][0]["frames"]), 2)

    def test_different_input_lengths_fail_without_publishing_a_result(self):
        run, output = self.score("mismatched.json", distorted=self.short)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("different frame counts", run.stderr)
        self.assertFalse(output.exists())

    def test_invalid_backend_never_falls_back_to_cpu(self):
        run, output = self.score("backend.json", extra=("--backend", "nvenc"))
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("--backend", run.stderr)
        self.assertFalse(output.exists())

    def test_existing_results_are_never_overwritten(self):
        target = self.root / "existing.json"
        target.write_text("original result")
        run, _ = self.score(target.name)
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(target.read_text(), "original result")

    def test_unknown_duplicate_and_unsafe_numeric_options_fail(self):
        for index, extra in enumerate((("--threads", "-1"), ("--width", "640"),
                                       ("--backend", "cpu", "--backend", "cuda"),
                                       ("--decode-threads", "9999"), ("--unknown", "value"))):
            run, output = self.score(f"invalid-{index}.json", extra=extra)
            self.assertNotEqual(run.returncode, 0)
            self.assertFalse(output.exists())


unittest.main(argv=[__file__, *remaining])
