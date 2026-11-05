#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Verify actual model-free CAMBI, EOF coverage, PTS/duration and atomic output."""
import argparse
import hashlib
import json
import math
import subprocess
import tempfile
import unittest
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--binary", type=Path, required=True)
parser.add_argument("--ffmpeg", default="ffmpeg")
parser.add_argument("--backend", choices=("cpu", "cuda", "vulkan"), default="cpu")
parser.add_argument("--vendor", choices=("amd", "nvidia"))
args, remaining = parser.parse_known_args()

class BandingRunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="bitovp-native-banding-")
        cls.root = Path(cls.directory.name)
        for bits in (8, 10, 12):
            source = f"nullsrc=s=640x360:r=25:d=0.24,format=yuv420p{str(bits)+'le' if bits>8 else ''}"
            # Six finite frames; EOF is the scorer boundary, with no output-side -frames lookahead.
            subprocess.run([args.ffmpeg, "-v", "error", "-nostdin", "-f", "lavfi", "-i", source,
                            "-vf", f"geq=lum='{16*(1 << (bits-8))}+floor(X/8)*{1 << (bits-8)}':cb={128*(1 << (bits-8))}:cr={128*(1 << (bits-8))}",
                            "-c:v", "ffv1", str(cls.root / f"gradient-{bits}.mkv")],
                           check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        subprocess.run([args.ffmpeg, "-v", "error", "-nostdin", "-i", str(cls.root/"gradient-8.mkv"),
                        "-vf", "setpts='PTS+if(gte(N,3),0.12/TB,0)'", "-fps_mode", "passthrough",
                        "-c:v", "ffv1", str(cls.root/"gap.mkv")], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        for name, extra in (
            ("hdr.mkv", ["-color_trc", "smpte2084", "-color_primaries", "bt2020", "-colorspace", "bt2020nc"]),
            ("sar.mkv", ["-vf", "setsar=2"]),
            ("rgb.mkv", ["-pix_fmt", "bgr0"]),
            ("full-range.mkv", ["-color_range", "pc"]),
            ("duplicate-pts.mkv", ["-vf", "setpts=0", "-fps_mode", "passthrough"]),
            ("two-videos.mkv", ["-map", "0:v", "-map", "0:v"]),
        ):
            subprocess.run([args.ffmpeg, "-v", "error", "-nostdin", "-i", str(cls.root/"gradient-8.mkv"),
                            *extra, "-c:v", "ffv1", str(cls.root/name)], check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        subprocess.run([args.ffmpeg, "-v", "error", "-nostdin", "-i", str(cls.root/"gradient-8.mkv"),
                        "-vf", "setpts='(N+floor(N/2))/(25*TB)'", "-fps_mode", "vfr", "-c:v", "libx264",
                        "-bf", "0", "-video_track_timescale", "1000", str(cls.root/"vfr.mp4")],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def score(self, name, source="gradient-8.mkv", extra=()):
        output = self.root/name
        command = [str(args.binary), "--metric", "cambi", "--distorted", str(self.root/source),
                   "--output", str(output), "--backend", args.backend]
        if args.backend != "cpu":
            command += ["--verify-cpu"]
        if args.vendor:
            command += ["--vendor", args.vendor]
        run = subprocess.run([*command, *extra], text=True, capture_output=True, timeout=120)
        return run, output

    def test_capabilities_are_separate_and_bound_to_binary(self):
        run = subprocess.run([str(args.binary), "--capabilities"], text=True, capture_output=True, check=True)
        value = json.loads(run.stdout)
        self.assertEqual(set(value), {"schemaVersion", "kind", "sourceSha256", "binarySha256",
                                     "officialSourceRevision", "metrics", "backends", "bandingReceiptSchemaVersion"})
        self.assertEqual(value["schemaVersion"], 1)
        self.assertEqual(value["kind"], "bitovp-native-capabilities")
        self.assertEqual(value["binarySha256"], hashlib.sha256(args.binary.read_bytes()).hexdigest())
        self.assertIn("CAMBI_NR", value["metrics"])
        self.assertIn(args.backend, value["backends"])
        version = subprocess.check_output([str(args.binary), "--version"], text=True)
        self.assertRegex(version, r"^bitovp-vmaf 0\.1 owned CUDA/Vulkan; official=[0-9a-f]{40}; source=[0-9a-f]{64}\n$")

    def test_complete_model_free_original_precision_and_positive_scores(self):
        for bits in (8, 10):
            run, path = self.score(f"complete-{bits}.json", source=f"gradient-{bits}.mkv")
            self.assertEqual(run.returncode, 0, run.stderr)
            value = json.loads(path.read_text())
            self.assertEqual(value["metric"], "CAMBI_NR")
            self.assertEqual(value["schemaVersion"], 1)
            self.assertEqual(value["input"], {"sha256": hashlib.sha256((self.root/f"gradient-{bits}.mkv").read_bytes()).hexdigest(),
                                            "width": 640, "height": 360, "bitDepth": bits})
            self.assertEqual(value["backend"], args.backend)
            self.assertNotIn("models", value)
            self.assertEqual(value["coverage"]["decodedFrames"], 6)
            self.assertEqual(value["coverage"]["scoredFrames"], 6)
            self.assertTrue(value["coverage"]["complete"])
            self.assertEqual(len(value["frames"]), 6)
            self.assertEqual(value["extractor"]["options"]["cambi_max_val"], "1000")
            self.assertEqual(value["extractor"]["options"]["enc_bitdepth"], str(bits))
            self.assertTrue(all(f["index"] == i for i, f in enumerate(value["frames"])))
            self.assertTrue(all(math.isfinite(f["rawScore"]) and f["rawScore"] >= 0 for f in value["frames"]))
            self.assertGreater(max(f["cpuReferenceScore"] for f in value["frames"]), 0)
            for i, frame in enumerate(value["frames"]):
                self.assertAlmostEqual(frame["timeSeconds"], i*0.04, places=9)
                self.assertAlmostEqual(frame["durationSeconds"], 0.04, places=9)
                self.assertLessEqual(abs(frame["rawScore"]-frame["cpuReferenceScore"]),
                                     1e-6+1e-7*abs(frame["cpuReferenceScore"]))
            self.assertAlmostEqual(value["coverage"]["endTimeSeconds"], 0.24, places=9)
            self.assertEqual(value["cpuParity"]["checked"], args.backend != "cpu")
            self.assertEqual(value["cpuParity"]["frameCount"], 6 if args.backend != "cpu" else 0)
            self.assertEqual(value["cpuParity"]["absoluteTolerance"], 1e-6)
            self.assertEqual(value["cpuParity"]["relativeTolerance"], 1e-7)
            self.assertGreater(value["memory"]["maxRssBytes"], 0)
            if args.backend == "cpu":
                self.assertIsNone(value["device"])
            else:
                self.assertGreater(value["memory"]["gpuAllocatedBytes"], 0)
                self.assertEqual(len(value["device"]["uuid"]), 32)

    def test_presentation_gap_is_preserved_without_inventing_coverage(self):
        run, path = self.score("gap.json", source="gap.mkv")
        self.assertEqual(run.returncode, 0, run.stderr)
        frames = json.loads(path.read_text())["frames"]
        self.assertEqual(len(frames), 6)
        self.assertAlmostEqual(frames[2]["timeSeconds"] + frames[2]["durationSeconds"], 0.12, places=9)
        self.assertAlmostEqual(frames[3]["timeSeconds"], 0.24, places=9)
        self.assertAlmostEqual(frames[3]["durationSeconds"], 0.04, places=9)

    def test_vfr_h264_uses_each_actual_presentation_duration(self):
        run, path = self.score("vfr.json", source="vfr.mp4")
        self.assertEqual(run.returncode, 0, run.stderr)
        value = json.loads(path.read_text())
        self.assertEqual(len(value["frames"]), 6)
        for frame, time, duration in zip(value["frames"], [0, 0.04, 0.12, 0.16, 0.24, 0.28],
                                         [0.04, 0.08, 0.04, 0.08, 0.04, 0.04]):
            self.assertAlmostEqual(frame["timeSeconds"], time, places=9)
            self.assertAlmostEqual(frame["durationSeconds"], duration, places=9)
        self.assertAlmostEqual(value["coverage"]["endTimeSeconds"], 0.32, places=9)

    def test_precision_loss_and_partial_limits_fail_without_result(self):
        for name, source, extra in (("12bit.json", "gradient-12.mkv", ()),
                                   ("limited.json", "gradient-8.mkv", ("--max-frames", "2"))):
            run, path = self.score(name, source, extra)
            self.assertNotEqual(run.returncode, 0)
            self.assertFalse(path.exists())
            self.assertEqual(list(self.root.glob(name+".partial.*")), [])

    def test_existing_receipt_is_preserved(self):
        target = self.root/"existing.json"
        target.write_text("original")
        run, _ = self.score(target.name)
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(target.read_text(), "original")

    def test_unsupported_color_sampling_stream_selection_and_duplicate_pts_fail_closed(self):
        for source in ("hdr.mkv", "sar.mkv", "rgb.mkv", "full-range.mkv", "two-videos.mkv", "duplicate-pts.mkv"):
            run, path = self.score(source+".json", source=source)
            self.assertNotEqual(run.returncode, 0, source)
            self.assertFalse(path.exists(), source)
            self.assertEqual(list(self.root.glob(source+".json.partial.*")), [])

unittest.main(argv=[__file__, *remaining])
