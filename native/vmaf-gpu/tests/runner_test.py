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

    def test_a_scaled_pair_declares_nothing_of_the_encode_to_cambi(self):
        # A score has to be the one of `ffmpeg -lavfi libvmaf` for the same
        # pictures, and that filter tells CAMBI nothing of the encode before
        # scaling. The worker reads these options from the receipt and takes no
        # result from a scorer that declares the encode.
        small = self.root / "small.mkv"
        subprocess.run([args.ffmpeg, "-v", "error", "-nostdin", "-i", str(self.reference), "-vf",
                        "scale=320:180,eq=brightness=0.03", "-c:v", "ffv1", str(small)], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        for bits in (8, 10):
            run, output = self.score(f"scaled-{bits}.json", distorted=small,
                                     extra=("--width", "640", "--height", "360", "--bit-depth", str(bits)))
            self.assertEqual(run.returncode, 0, run.stderr)
            receipt = json.loads(output.read_text())
            self.assertEqual((receipt["width"], receipt["height"], receipt["bitDepth"]), (640, 360, bits))
            self.assertEqual(receipt["distortedOriginal"], {"width": 320, "height": 180, "bitdepth": 8})
            cambi = [spec["options"] for spec in receipt["extractors"] if spec["name"] == "cambi"]
            self.assertEqual(len(cambi), 1)
            for option in ("enc_width", "enc_height", "enc_bitdepth"):
                self.assertEqual(cambi[0].get(option, "0"), "0", option)

    def test_a_full_range_picture_is_widened_as_the_scale_filter_widens_it(self):
        # A decoder names a full-range 8-bit picture `yuvj420p` (MJPEG, H.264)
        # or `yuv420p` with a full range (FFV1, AV1). FFmpeg's scale filter
        # widens a picture that it does not scale to 10 bits by copying each
        # plane, and it repeats the top bits of full-range luma. The scorer
        # has to as well: it once kept swscale's general scaler for the first
        # name, and a pair of one size then scored 0.4 away from
        # `ffmpeg -lavfi libvmaf`.
        named = self.root / "full-range-j.mkv"
        plain = self.root / "full-range-plain.mkv"
        wide = self.root / "full-range-10.mkv"
        # Both ranges are named for the filter, so that FFmpeg 6.1 copies the
        # planes as well; the FFmpeg whose score the worker gives, n8.1.3,
        # does so unasked.
        same_range = "scale=in_range=full:out_range=full"
        commands = [
            ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-frames:v", "3",
             "-vf", "scale=out_range=full,format=yuvj420p", "-c:v", "mjpeg", "-q:v", "2", str(named)],
            # The same pictures under the other name.
            ["-i", str(named), "-vf", f"{same_range},format=yuv420p",
             "-c:v", "ffv1", "-color_range", "pc", str(plain)],
            # The filter's 10-bit pictures.
            ["-i", str(named), "-vf", f"{same_range},format=yuv420p10le",
             "-c:v", "ffv1", "-color_range", "pc", str(wide)],
        ]
        for command in commands:
            subprocess.run([args.ffmpeg, "-v", "error", "-nostdin", *command], check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        cases = [
            # The scorer's pictures of either name are the filter's.
            ("filter-j", wide, named, 10),
            ("filter-plain", wide, plain, 10),
            # And the two names give one picture at either bit depth.
            ("names-8", plain, named, 8),
            ("names-10", plain, named, 10),
        ]
        for label, reference, distorted, bits in cases:
            run, output = self.score(f"full-range-{label}.json", reference=reference,
                                     distorted=distorted, extra=("--bit-depth", str(bits)))
            self.assertEqual(run.returncode, 0, run.stderr)
            psnr = [f["value"] for f in json.loads(output.read_text())["features"]
                    if f["name"] in ("psnr_y", "psnr_cb", "psnr_cr")]
            self.assertEqual(len(psnr), 9, label)
            self.assertEqual(set(psnr), {6 * bits + 12}, label)

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
