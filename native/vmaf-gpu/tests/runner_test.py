#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Exercise actual demux/decode, temporal flush and result publication."""
import argparse
import errno
import hashlib
import json
import math
import os
import subprocess
import tempfile
import time
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

    def score_command(self, name, *, reference=None, distorted=None, model=None, extra=()):
        output = self.root / name
        command = [str(args.binary), "--reference", str(reference or self.reference),
                   "--distorted", str(distorted or self.distorted), "--output", str(output),
                   "--model", f"test={model or self.model}", *extra]
        return command, output

    def score(self, name, **options):
        command, output = self.score_command(name, **options)
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

    def test_nvenc_experiment_aligns_absolute_pts_and_requires_exact_coverage(self):
        reference = self.root / "experiment-reference.mp4"
        selected = self.root / "experiment-selected.mkv"
        late = self.root / "experiment-late.mkv"
        colors = ["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]
        commands = [
            # Video frame one starts at PTS 33 on a 1/1005 clock, exactly half a tick early.
            ["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-frames:v", "6", "-vf",
             "settb=1/1005,setpts=floor(N*67/2),setsar=1", "-c:v", "libx264", "-preset", "ultrafast",
             "-threads", "1", "-bf", "0", "-enc_time_base", "1:1005", "-fps_mode", "passthrough",
             "-video_track_timescale", "1005", *colors, str(reference)],
            ["-i", str(reference), "-vf", "trim=start_frame=1:end_frame=3,settb=1/30,setpts=N", "-c:v", "ffv1",
             "-threads", "1", "-fps_mode", "passthrough", *colors, str(selected)],
            ["-i", str(selected), "-c", "copy", "-output_ts_offset", "0.033", str(late)],
        ]
        for command in commands:
            subprocess.run([args.ffmpeg, "-v", "error", "-nostdin", *command], check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)

        ordinary, ordinary_output = self.score("experiment-ordinary.json", reference=selected, distorted=selected)
        self.assertEqual(ordinary.returncode, 0, ordinary.stderr)
        expected = json.loads(ordinary_output.read_text())
        self.assertNotIn("experimentWindow", expected)
        self.assertNotIn("referenceDecodeBackend", expected)
        window = ("--experiment-window", "--reference-start-frame", "1", "--frame-count")
        run, output = self.score("experiment-window.json", reference=reference, distorted=selected, extra=(*window, "2"))
        self.assertEqual(run.returncode, 0, run.stderr)
        result = json.loads(output.read_text())
        self.assertEqual(result["experimentWindow"], {"startFrame": 1, "frameCount": 2})
        self.assertEqual(result["referenceDecodeBackend"], "cpu")
        self.assertEqual(result["decodeBackend"], "cpu")
        self.assertEqual(result["frames"], 2)
        self.assertEqual(result["features"], expected["features"])
        self.assertEqual(result["models"], expected["models"])

        for name, distorted, frame_count in (("extra", selected, "1"), ("short", selected, "3"), ("late", late, "2")):
            with self.subTest(name=name):
                run, output = self.score(
                    f"experiment-{name}.json", reference=reference, distorted=distorted, extra=(*window, frame_count),
                )
                self.assertNotEqual(run.returncode, 0, name)
                self.assertIn("distorted", run.stderr.lower(), name)
                self.assertFalse(output.exists(), name)

    def test_only_the_opened_mov_demuxer_attests_local_inputs(self):
        direct = self.root / "direct.mp4"
        renamed = self.root / "matroska.mp4"
        renamed.write_bytes(self.reference.read_bytes())
        subprocess.run([args.ffmpeg, "-v", "error", "-nostdin", "-i", str(self.reference),
                        "-c:v", "mpeg4", str(direct)], check=True, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, timeout=60)
        cases = (
            ("mov", direct, direct, True),
            ("mixed", direct, renamed, False),
        )
        for name, reference, distorted, eligible in cases:
            with self.subTest(name=name):
                run, output = self.score(f"attested-{name}.json", reference=reference,
                                         distorted=distorted, extra=("--attest-decoder-runtime",))
                self.assertEqual(run.returncode, 0, run.stderr)
                receipt = json.loads(output.read_text())
                self.assertEqual(receipt["frames"], 6)
                self.assertEqual(receipt.get("selfContainedMovInputs") is True, eligible)

    def test_attested_score_uses_the_model_bytes_hashed_before_path_replacement(self):
        baseline, baseline_output = self.score("model-baseline.json")
        self.assertEqual(baseline.returncode, 0, baseline.stderr)
        expected = json.loads(baseline_output.read_text())["models"][0]

        original = self.model.read_bytes()
        model = self.root / "replaceable-model.json"
        model.write_bytes(original)
        replacement = self.root / "model-replacement.json"
        replacement.write_bytes(b"invalid model")
        second = self.root / "second-model.json"
        os.mkfifo(second)
        ready_second = self.root / "ready-second-model.json"
        ready_second.write_bytes(original)
        command, output = self.score_command("snapshotted-model.json", model=model, extra=(
            "--attest-decoder-runtime", "--model", f"second={second}",
        ))
        # Opening the second model for hashing proves the first model was read.
        # Keep its FIFO open until both path replacements have finished.
        with subprocess.Popen(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as run:
            try:
                deadline = time.monotonic() + 10
                while True:
                    try:
                        writer_fd = os.open(second, os.O_WRONLY | os.O_NONBLOCK)
                        break
                    except OSError as error:
                        if error.errno != errno.ENXIO:
                            raise
                        if run.poll() is not None or time.monotonic() >= deadline:
                            self.fail("Scorer did not reach the second model")
                        time.sleep(0.01)
                with os.fdopen(writer_fd, "wb") as writer:
                    os.set_blocking(writer.fileno(), True)
                    replacement.replace(model)
                    ready_second.replace(second)
                    writer.write(original)
                _, stderr = run.communicate(timeout=120)
            finally:
                if run.poll() is None:
                    run.kill()
        self.assertEqual(run.returncode, 0, stderr)
        self.assertEqual(json.loads(output.read_text())["models"][0], expected)

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
        self.assertIn("bitovp-vmaf: Comparison inputs have different frame counts", run.stderr)
        self.assertFalse(output.exists())

    def test_inputs_that_leave_out_the_same_frames_fail_without_publishing_a_result(self):
        # Matroska keeps the times of the frames that a file holds, and ffprobe
        # gives such a file the frame rate of the others. FFmpeg's libvmaf
        # filter, as the ordinary method runs it, repeats the frame before in
        # the left-out slot of each input; this scorer would score the held
        # frames once, so it refuses the pair.
        gaps = self.root / "gaps.mkv"
        gaps_distorted = self.root / "gaps-distorted.mkv"
        late = self.root / "late.mkv"
        commands = [
            ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-frames:v", "8",
             "-vf", r"select='not(eq(n\,3))'", "-fps_mode", "passthrough", "-c:v", "ffv1", str(gaps)],
            ["-i", str(gaps), "-vf", "eq=brightness=0.03", "-fps_mode", "passthrough",
             "-c:v", "ffv1", str(gaps_distorted)],
            # Every frame half a slot late as a whole: the scorer times each
            # input from its first frame, and so does the ordinary method.
            ["-i", str(self.reference), "-c", "copy", "-output_ts_offset", "0.021", str(late)],
        ]
        for command in commands:
            subprocess.run([args.ffmpeg, "-v", "error", "-nostdin", *command], check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        for label, distorted in (("same", gaps), ("encoded", gaps_distorted)):
            run, output = self.score(f"gaps-{label}.json", reference=gaps, distorted=distorted)
            self.assertNotEqual(run.returncode, 0, label)
            self.assertIn("bitovp-vmaf: Comparison frame times do not follow the frame rate", run.stderr, label)
            self.assertFalse(output.exists(), label)
        run, output = self.score("late.json", reference=late, distorted=late)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(output.read_text())["frames"], 6)

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

    def test_nvenc_experiment_cli_rejects_partial_or_conflicting_window_options(self):
        window = ("--experiment-window", "--reference-start-frame", "0", "--frame-count", "1")
        for index, extra in enumerate((
            window[1:],
            window[:-2],
            (*window[:-1], "0"),
            (*window[:-1], "3601"),
            ("--experiment-window", "--reference-start-frame", "2147483647", "--frame-count", "1"),
            (*window, "--max-frames", "0"),
            (*window, "--bit-depth", "10"),
            (*window, "--width", "640", "--height", "360"),
            (*window, "--decode", "cpu", "--backend", "cuda"),
        )):
            with self.subTest(extra=extra):
                run, output = self.score(f"experiment-invalid-{index}.json", extra=extra)
                self.assertNotEqual(run.returncode, 0)
                self.assertRegex(run.stderr.lower(), r"experiment|--frame-count")
                self.assertFalse(output.exists())


unittest.main(argv=[__file__, *remaining])
