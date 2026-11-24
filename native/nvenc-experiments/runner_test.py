import hashlib
import json
import os
import shutil
import subprocess
import sys
import unittest
from dataclasses import replace
from decimal import Decimal
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import runner

from runner import (
    RunnerError,
    encode_options,
    parse_frames,
    parse_measurement,
    observed_gop,
    parse_packet_sizes,
    parse_sdk_probe,
    parse_trial,
    parse_vmaf,
    reference_filter,
    validate_timeline,
)


def request():
    return {
        "schemaVersion": 1,
        "sourcePath": "/var/media/example.mkv",
        "trial": {
            "sourceId": "source-1",
            "window": {
                "timeBase": {"num": 1, "den": 90000},
                "startPts": "3000",
                "endPtsExclusive": "12000",
            },
            "codec": "HEVC",
            "preset": "P4",
            "tuning": "HIGH_QUALITY",
            "config": {
                "gopLength": 2,
                "frameIntervalP": 1,
                "rcParams": {
                    "rateControlMode": "VBR",
                    "averageBitRate": 2400000,
                    "enableAQ": False,
                    "enableTemporalAQ": True,
                    "lookaheadDepth": 0,
                },
            },
        },
    }


def log(label, points, keys=(0,), timebase="1/1000", pix_fmt="yuv420p"):
    config = f"[showinfo@{label} @ 0xab] config in time_base: {timebase}, frame_rate: 30/1"
    rows = []
    for index, pts in enumerate(points):
        key = int(index in keys)
        rows.append(
            f"[showinfo@{label} @ 0xab] n: {index} pts: {pts} pts_time:0 "
            f"duration:33 duration_time:0.033 fmt:{pix_fmt} cl:left sar:1/1 s:1920x1080 "
            f"i:P iskey:{key} type:P"
        )
        rows.append(
            f"[showinfo@{label} @ 0xab] color_range:tv color_space:bt709 "
            "color_primaries:bt709 color_trc:bt709"
        )
    return "\n".join([config, *rows])


class RunnerTest(unittest.TestCase):
    def test_standalone_primary_measurement_discovers_the_runtime(self):
        with TemporaryDirectory() as folder:
            request_path = Path(folder) / "trial.json"
            request_path.write_text(json.dumps(request()))
            runtime = object()
            args = ["runner.py", "measure", "--request-file", str(request_path)]
            with patch.object(sys, "argv", args), patch("builtins.print"), \
                    patch.object(runner, "resolve_runtime", return_value=runtime) as resolve, \
                    patch.object(runner, "measure", return_value={}) as measure:
                self.assertEqual(runner.main(object()), 0)
            self.assertIsNone(resolve.call_args.kwargs["expected_runtime"])
            self.assertTrue(resolve.call_args.kwargs["probe_vmaf_v1"])
            self.assertFalse(measure.call_args.args[1].measure_vmaf_v1)

    def test_managed_primary_measurement_uses_only_the_admitted_runtime(self):
        with TemporaryDirectory() as folder:
            request_path = Path(folder) / "trial.json"
            request_path.write_text(json.dumps(request()))
            expected = {"runtimeId": "c" * 64}
            args = ["runner.py", "measure", "--request-file", str(request_path)]
            with patch.object(sys, "argv", args), patch("builtins.print"), \
                    patch.dict(os.environ, {"BITOVP_NVENC_EXPECTED_RUNTIME": json.dumps(expected)}), \
                    patch.object(runner, "resolve_runtime") as resolve, patch.object(runner, "measure", return_value={}):
                self.assertEqual(runner.main(object()), 0)
            self.assertEqual(resolve.call_args.kwargs["expected_runtime"], expected)
            self.assertFalse(resolve.call_args.kwargs["probe_vmaf_v1"])

    def test_managed_runtime_keeps_sdk_catalog_attestation(self):
        expected = {"runtimeId": "a" * 64, "nvencSdk": {"version": "13.0", "catalogSha256": "b" * 64}}
        self.assertEqual(runner.parse_expected_runtime(json.dumps(expected)), expected)
        expected["nvencSdk"]["catalogSha256"] = "c" * 63
        with self.assertRaisesRegex(RunnerError, "INVALID_REQUEST"):
            runner.parse_expected_runtime(json.dumps(expected))

    def test_sdk_manifest_is_canonical_with_exact_zero_and_false(self):
        item = request()
        item["trial"]["sdk"] = {
            "version": "13.0",
            "session": {"NV_ENC_RC_PARAMS.lookaheadDepth": 0, "NV_ENC_RC_PARAMS.enableAQ": False},
            "pictures": [
                {"frameIndex": 2, "fields": {"NV_ENC_PIC_PARAMS_HEVC.sliceModeData": 3}},
                {"frameIndex": 0, "fields": {"NV_ENC_PIC_PARAMS.encodePicFlags": 2}},
            ],
        }
        trial = parse_trial(item)
        self.assertEqual(
            trial.sdk.manifest_bytes(),
            b"init\tNV_ENC_RC_PARAMS.enableAQ\t0\n"
            b"init\tNV_ENC_RC_PARAMS.lookaheadDepth\t0\n"
            b"picture\t0\tNV_ENC_PIC_PARAMS.encodePicFlags\t2\n"
            b"picture\t2\tNV_ENC_PIC_PARAMS_HEVC.sliceModeData\t3\n",
        )
        digest = hashlib.sha256(trial.sdk.manifest_bytes()).hexdigest()
        self.assertEqual(trial.sdk.expected_receipt(), f"bitovp-nvenc-settings-v2\t2\t2\t{digest}\n".encode())

    def test_sdk_rejects_ambiguous_or_out_of_window_writes(self):
        item = request()
        picture = {"frameIndex": 0, "fields": {"NV_ENC_PIC_PARAMS.encodePicFlags": 2}}
        for invalid in (
            {},
            {"version": "13.0"},
            {"version": "13.0", "session": {"NV_ENC_RC_PARAMS.enableAQ\t": True}},
            {"version": "13.0", "session": {"NV_ENC_RC_PARAMS.aqStrength": 2.5}},
            {"version": "13.0", "pictures": [picture, picture]},
            {"version": "13.0", "pictures": [{**picture, "frameIndex": 3}]},
        ):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(RunnerError, "INVALID_REQUEST"):
                item["trial"]["sdk"] = invalid
                parse_trial(item)

    def test_runtime_discovers_a_consistent_sdk_binding_from_each_encoder(self):
        digest = "b" * 64
        listing = "  -bitovp-nvenc-settings-v2 <string> E..V....... sdk-receipt-version=2 sdk-catalog-sha256=" + digest
        binary = Path("/runtime/bin/ffmpeg")
        codecs = ["H264", "HEVC", "AV1"]
        with patch.object(runner, "capture", return_value=(listing, "")) as capture:
            self.assertEqual(
                runner.discover_sdk_settings(binary, codecs),
                {"version": "13.0", "catalogSha256": digest},
            )
            self.assertEqual([call.args[0][-1] for call in capture.call_args_list],
                             ["encoder=h264_nvenc", "encoder=hevc_nvenc", "encoder=av1_nvenc"])
        with patch.object(runner, "capture", side_effect=[(listing, ""), ("", ""), (listing, "")]):
            self.assertIsNone(runner.discover_sdk_settings(binary, codecs))
        with patch.object(runner, "capture", side_effect=[(listing, ""), (listing.replace(digest, "c" * 64), ""), (listing, "")]):
            self.assertIsNone(runner.discover_sdk_settings(binary, codecs))
        for stale in (
            listing.replace("-bitovp-nvenc-settings-v2 ", "-bitovp-nvenc-settings "),
            listing.replace("sdk-receipt-version=2 ", ""),
            listing.replace("receipt-version=2", "receipt-version=1"),
            listing.replace("receipt-version=2", "receipt-version=2-beta"),
        ):
            with self.subTest(stale=stale), patch.object(runner, "capture", return_value=(stale, "")):
                self.assertIsNone(runner.discover_sdk_settings(binary, codecs))

    def test_sdk_scheduled_reconfigure_picture_and_qp_map_have_one_manifest_order(self):
        item = request()
        qp_map = "fd" * 2040
        frame = {
            "frameIndex": 1, "qpMap": qp_map,
            "reconfigure": {"NV_ENC_RECONFIGURE_PARAMS.forceIDR": False, "NV_ENC_RC_PARAMS.averageBitRate": 1000000},
            "fields": {"NV_ENC_PIC_PARAMS_HEVC.sliceModeData": 1},
            "metadata": [{"type": 5, "payload": "0011"}, {"type": 4, "payload": "aa"}],
        }
        sdk = {"version": "13.0", "session": {"NV_ENC_RC_PARAMS.qpMapMode": 2}, "pictures": [frame]}
        item["trial"]["sdk"] = sdk
        trial = parse_trial(item)
        self.assertEqual(trial.sdk.manifest_bytes().decode("ascii").splitlines(), [
            "init\tNV_ENC_RC_PARAMS.qpMapMode\t2",
            "reconfigure\t1\tNV_ENC_RC_PARAMS.averageBitRate\t1000000",
            "reconfigure\t1\tNV_ENC_RECONFIGURE_PARAMS.forceIDR\t0",
            "picture\t1\tNV_ENC_PIC_PARAMS_HEVC.sliceModeData\t1",
            "qpmap\t1\t" + qp_map,
            "metadata\t1\t5\t0011",
            "metadata\t1\t4\taa",
        ])
        digest = hashlib.sha256(trial.sdk.manifest_bytes()).hexdigest()
        self.assertEqual(trial.sdk.expected_receipt(), f"bitovp-nvenc-settings-v2\t1\t6\t{digest}\n".encode())
        for invalid in (
            {**sdk, "session": {}},
            {**sdk, "session": {"NV_ENC_RC_PARAMS.qpMapMode": 1}},
            {**sdk, "pictures": [{**frame, "qpMap": "00"}]},
            {**sdk, "pictures": [{**frame, "reconfigure": {"NV_ENC_CONFIG.gopLength": 2}}]},
            {**sdk, "pictures": [{**frame, "metadata": [{"type": 4, "payload": "AA"}]}]},
            {**sdk, "pictures": [{**frame, "metadata": [{"type": -1, "payload": "aa"}]}]},
        ):
            with self.subTest(session=invalid["session"]), self.assertRaisesRegex(RunnerError, "INVALID_REQUEST"):
                item["trial"]["sdk"] = invalid
                parse_trial(item)

    def test_encode_demands_receipt_for_all_sdk_writes(self):
        item = request()
        item["trial"]["sdk"] = {"version": "13.0", "session": {"NV_ENC_RC_PARAMS.aqStrength": 5}}
        trial = parse_trial(item)
        with TemporaryDirectory() as directory:
            work = Path(directory)
            runtime = SimpleNamespace(ffmpeg=Path("/runtime/bin/ffmpeg"), gpu_index=0)

            def capture(args, stage, cwd, timeout):
                self.assertEqual(stage, "ENCODE")
                manifest = Path(args[args.index("-bitovp-nvenc-settings-v2") + 1])
                self.assertEqual(manifest.read_bytes(), trial.sdk.manifest_bytes())
                self.assertTrue(manifest.is_relative_to(work))
                return "", ""

            with patch.object(runner, "capture", side_effect=capture), \
                    patch.object(runner, "validate_timeline") as timeline:
                with self.assertRaisesRegex(RunnerError, "NVENC_SDK_SETTINGS_NOT_APPLIED"):
                    runner.encode(runtime, trial, Path("/source.mkv"), Fraction(1, 1000), work)
                timeline.assert_not_called()

                receipt = work / (runner.SDK_SETTINGS_FILE + ".receipt")
                receipt.write_bytes(b"bitovp-nvenc-settings-v2\t1\t0\t" + b"f" * 64 + b"\n")
                with self.assertRaisesRegex(RunnerError, "NVENC_SDK_SETTINGS_NOT_APPLIED"):
                    runner.encode(runtime, trial, Path("/source.mkv"), Fraction(1, 1000), work)
                timeline.assert_not_called()

                receipt.write_bytes(trial.sdk.expected_receipt())
                encoded, _ = runner.encode(runtime, trial, Path("/source.mkv"), Fraction(1, 1000), work)
                self.assertEqual(encoded, work / "encoded.mkv")
                timeline.assert_called_once()
        self.assertEqual(trial.sdk.applied(), {
            "fieldCount": 1,
            "manifestSha256": hashlib.sha256(b"init\tNV_ENC_RC_PARAMS.aqStrength\t5\n").hexdigest(),
        })

    def test_secondary_model_is_explicit_and_unique(self):
        item = request()
        self.assertFalse(parse_trial(item).measure_vmaf_v1)
        profile = "bitovp-vmaf-cuda-1.0.16-3d0h"
        item["trial"]["additionalScoringProfiles"] = [profile]
        self.assertTrue(parse_trial(item).measure_vmaf_v1)
        for invalid in ([], [profile, profile], ["official-vmaf-cuda-0.6.1"], profile):
            with self.subTest(invalid=invalid), self.assertRaises(RunnerError):
                item["trial"]["additionalScoringProfiles"] = invalid
                parse_trial(item)

    def test_v1_scores_are_bound_to_the_selected_window_model_and_device(self):
        item = request()
        trial = parse_trial(item)
        profile = {
            "scoringProfileId": "bitovp-vmaf-cuda-1.0.16-3d0h",
            "scorerSha256": "a" * 64,
            "modelSha256": "b" * 64,
            "sourceSha256": "c" * 64,
            "officialRevision": "d" * 40,
            "decoderRuntimeSha256": "f" * 64,
        }
        uuid = "eb576a3f5b2d4be7863c742308e386e7"
        runtime = SimpleNamespace(
            gpu_index=0,
            capabilities={
                "gpuUuid": "GPU-eb576a3f-5b2d-4be7-863c-742308e386e7",
                "driverVersion": "580.178.04",
            },
            vmaf_v1=SimpleNamespace(profile=profile),
        )
        report = {
            "schema": 1, "implementation": "bitovp-owned", "backend": "cuda",
            "referenceDecodeBackend": "cpu", "decodeBackend": "cuda",
            "experimentWindow": {"startFrame": 1, "frameCount": 3},
            "frames": 3, "width": 1920, "height": 1080, "bitDepth": 8,
            "sourceSha256": profile["sourceSha256"], "officialRevision": profile["officialRevision"],
            "decoderRuntimeSha256": profile["decoderRuntimeSha256"],
            "device": {"uuid": uuid, "index": 0},
            "gpuDriver": {"driverVersion": "580.178.04;cuda-api=13000"},
            "models": [{
                "id": "vmaf_v1.0.16_3d0h", "sha256": profile["modelSha256"],
                "pooled": {"mean": Decimal("101.125")},
                "frames": [Decimal("101.125")] * 3,
            }],
        }
        self.assertEqual(runner.parse_vmaf_v1(report, runtime, trial, False), (101.125, 101125))
        for invalid in (
            {**report, "decodeBackend": "cpu"},
            {**report, "referenceDecodeBackend": "cuda"},
            {**report, "device": {"uuid": "e" * 32, "index": 0}},
            {**report, "gpuDriver": {"driverVersion": "580.178.05;cuda-api=13000"}},
            {**report, "gpuDriver": {"driverVersion": "580.178.04;cuda-api=unknown"}},
            {**report, "decoderRuntimeSha256": "a" * 64},
            {**report, "experimentWindow": {"startFrame": 0, "frameCount": 3}},
            {**report, "models": [{**report["models"][0], "sha256": "e" * 64}]},
            {**report, "models": [{**report["models"][0], "frames": [101]}]},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(RunnerError):
                runner.parse_vmaf_v1(invalid, runtime, trial, False)

    def test_v1_requires_a_pinned_model_and_matching_cuda_identity(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            tool = root / "bitovp-vmaf"
            tool.write_bytes(b"owned scorer")
            tool.chmod(0o700)
            model = root / (runner.VMAF_V1_MODEL_ID + ".json")
            model.write_bytes(b"pinned model")
            model_sha = hashlib.sha256(model.read_bytes()).hexdigest()
            report = {
                "schemaVersion": 1, "backend": "cuda", "sourceSha256": "a" * 64,
                "officialSourceRevision": "b" * 40,
                "binarySha256": hashlib.sha256(tool.read_bytes()).hexdigest(),
                "decoderRuntimeSha256": "d" * 64,
                "experimentCudaDecoders": ["HEVC", "AV1"],
                "device": {
                    "uuid": "eb576a3f5b2d4be7863c742308e386e7", "index": 0,
                    "driverVersionKnown": True, "driverVersion": "580.178.04;cuda-api=13000",
                },
            }
            env = {"VMAF_NATIVE_PATH": str(tool), "VMAF_MODEL_DIR": str(root)}
            gpu = "GPU-eb576a3f-5b2d-4be7-863c-742308e386e7"
            with patch.dict(os.environ, env), patch.object(runner, "VMAF_V1_MODEL_SHA256", model_sha), \
                    patch.object(runner, "capture", return_value=(json.dumps(report), "")) as capture:
                scorer = runner.discover_vmaf_v1(0, gpu, "580.178.04", ["HEVC", "AV1"])
                self.assertEqual(scorer.profile["modelSha256"], model_sha)
                self.assertEqual(scorer.profile["decoderRuntimeSha256"], report["decoderRuntimeSha256"])
                self.assertEqual(scorer.model_bytes, b"pinned model")
                self.assertIn("--experiment-window", capture.call_args.args[0])
                self.assertIsNone(runner.discover_vmaf_v1(1, gpu, "580.178.04", ["HEVC"]))
                self.assertIsNone(runner.discover_vmaf_v1(0, gpu, "999.0", ["HEVC"]))
                self.assertIsNone(runner.discover_vmaf_v1(0, gpu, "580.178.04", ["HEVC", "H264"]))
                with patch.dict(os.environ, {"BITOVP_NVENC_RUNNER_DEADLINE_NS": str(40 * 10**9)}), \
                        patch.object(runner, "monotonic_ns", return_value=35 * 10**9) as clock:
                    self.assertIsNotNone(runner.discover_vmaf_v1(0, gpu, "580.178.04", ["HEVC"]))
                    self.assertEqual(capture.call_args.kwargs["timeout"], 3)
                    clock.side_effect = [35 * 10**9, 39 * 10**9]
                    capture.reset_mock()
                    self.assertIsNone(runner.discover_vmaf_v1(0, gpu, "580.178.04", ["HEVC"]))
                    capture.assert_not_called()
                model.write_bytes(b"another model")
                self.assertIsNone(runner.discover_vmaf_v1(0, gpu, "580.178.04", ["HEVC"]))

    def test_optional_model_fifo_cannot_block_official_capability_discovery(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            tool = root / "bitovp-vmaf"
            tool.write_bytes(b"owned scorer")
            tool.chmod(0o700)
            fifo = root / "model.pipe"
            os.mkfifo(fifo)
            (root / (runner.VMAF_V1_MODEL_ID + ".json")).symlink_to(fifo)
            env = {**os.environ, "VMAF_NATIVE_PATH": str(tool), "VMAF_MODEL_DIR": str(root)}
            env.pop("BITOVP_NVENC_RUNNER_DEADLINE_NS", None)
            probe = (
                "import runner\n"
                'assert runner.discover_vmaf_v1(0, "GPU-eb576a3f-5b2d-4be7-863c-742308e386e7",'
                ' "580.178.04", ["HEVC"]) is None'
            )
            completed = subprocess.run(
                [sys.executable, "-B", "-c", probe],
                cwd=Path(runner.__file__).parent, env=env, capture_output=True, text=True, timeout=2,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_sdk_hardware_attestation_cannot_name_another_device(self):
        gpu = "GPU-eb576a3f-5b2d-4be7-863c-742308e386e7"
        report = {
            "schemaVersion": 1, "deviceIndex": 0, "gpuUuid": gpu, "maxNvencApiVersion": 208,
            "sdkApiVersion": {"major": 13, "minor": 0},
            "encoders": [
                {"codec": "H264", "inputFormats": [1, 16]},
                {"codec": "HEVC", "inputFormats": [16]},
                {"codec": None, "inputFormats": [1]},
            ],
        }
        self.assertEqual(parse_sdk_probe(report, 0, gpu), (208, {"H264"}))
        for invalid in (
            {**report, "deviceIndex": 1},
            {**report, "gpuUuid": gpu.upper()},
            {**report, "maxNvencApiVersion": 207},
            {**report, "encoders": [{"codec": "H264", "inputFormats": [True]}]},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(RunnerError):
                parse_sdk_probe(invalid, 0, gpu)

    def test_exact_frame_window_and_options_do_not_omit_zero_or_false(self):
        trial = parse_trial(request())
        self.assertEqual((trial.start_frame, trial.frame_count), (1, 3))
        args = encode_options(trial)
        self.assertEqual(args[args.index("-c:v") + 1], "hevc_nvenc")
        for option, value in {"-bf": "0", "-spatial-aq": "0", "-temporal-aq": "1", "-rc-lookahead": "0"}.items():
            self.assertEqual(args[args.index(option) + 1], value)
        self.assertNotIn("-maxrate:v", args)

    def test_non_grid_non_positive_overlong_and_noncanonical_windows_fail(self):
        for start, end in [("3001", "12000"), ("3000", "3000"), ("3000", "10806000"), ("03000", "12000")]:
            with self.subTest(start=start, end=end):
                item = request()
                item["trial"]["window"].update(startPts=start, endPtsExclusive=end)
                with self.assertRaises(RunnerError):
                    parse_trial(item)

    def test_rejects_unknown_fields_and_boolean_aliases(self):
        for fields in [{"output": "abc"}, {"averageBitRate": True}, {"enableAQ": 0}]:
            with self.subTest(fields=fields):
                item = request()
                item["trial"]["config"]["rcParams"].update(fields)
                with self.assertRaises(RunnerError):
                    parse_trial(item)

    def test_vbv_fields_use_the_signed_ffmpeg_option_limit(self):
        for name in ("maxBitRate", "vbvBufferSize"):
            with self.subTest(field=name):
                item = request()
                rate = item["trial"]["config"]["rcParams"]
                rate[name] = (1 << 31) - 1
                self.assertEqual(parse_trial(item).rate[name], (1 << 31) - 1)
                rate[name] = 1 << 31
                with self.assertRaises(RunnerError):
                    parse_trial(item)
        item = request()
        item["trial"]["config"]["rcParams"]["averageBitRate"] = (1 << 32) - 1
        self.assertEqual(parse_trial(item).rate["averageBitRate"], (1 << 32) - 1)

    def test_only_accepts_qualified_stream_properties(self):
        probe = {
            "streams": [{
                "codec_type": "video", "width": 1920, "height": 1080, "pix_fmt": "yuv420p",
                "sample_aspect_ratio": "1:1", "avg_frame_rate": "30/1", "time_base": "1/1000",
                "color_range": "tv", "color_space": "bt709", "color_transfer": "bt709",
                "color_primaries": "bt709", "start_pts": 0,
            }],
        }
        self.assertEqual(parse_measurement(probe), Fraction(1, 1000))
        for fields in [{"pix_fmt": "yuv420p10le"}, {"color_range": "pc"}, {"start_pts": 100}, {"avg_frame_rate": "30000/1001"}]:
            with self.subTest(fields=fields):
                altered = {"streams": [{**probe["streams"][0], **fields}]}
                with self.assertRaises(RunnerError):
                    parse_measurement(altered)

    def test_reference_and_cuda_pts_tolerance_is_half_a_container_tick(self):
        self.assertEqual(validate_timeline(log("source", [33, 67, 100]), "source", 1, 3, "yuv420p"), (0,))
        self.assertEqual(validate_timeline(log("decoded", [0, 33, 67], (0, 2), pix_fmt="cuda"), "decoded", 0, 3, "cuda"), (0, 2))
        for points in ([33, 66, 100], [33, 67], [33, 67, 67], [33, 67, 100, 133]):
            with self.subTest(points=points):
                with self.assertRaises(RunnerError):
                    validate_timeline(log("source", points), "source", 1, 3, "yuv420p")

    def test_trim_uses_the_earliest_accepted_pts_at_each_boundary(self):
        item = request()
        item["trial"]["window"]["endPtsExclusive"] = "6000"
        clock = Fraction(1, 1005)
        trial = parse_trial(item)
        for pts in (33, 34):
            validate_timeline(log("source", [pts], timebase="1/1005"), "source", 1, 1, "yuv420p")
        self.assertTrue(reference_filter(trial, clock, "source").startswith("trim=start_pts=33:end_pts=67,"))
        item["trial"]["window"].update(startPts="0", endPtsExclusive="3000")
        self.assertTrue(reference_filter(parse_trial(item), clock, "source").startswith("trim=start_pts=0:end_pts=33,"))
        self.assertTrue(reference_filter(trial, Fraction(1, 3000), "source").startswith("trim=start_pts=100:end_pts=200,"))
        with self.assertRaises(RunnerError):
            validate_timeline(log("source", [0], timebase="1/100"), "source", 0, 1, "yuv420p")

    def test_cuda_frame_log_cannot_be_admitted_as_software_and_vice_versa(self):
        with self.assertRaises(RunnerError):
            validate_timeline(log("decoded", [0]), "decoded", 0, 1, "cuda")
        with self.assertRaises(RunnerError):
            parse_frames(log("source", [0]).replace("i:P", "i:T"), "source", "yuv420p")
        with self.assertRaises(RunnerError):
            parse_frames(log("source", [0]).replace("color_space:bt709", "color_space:bt2020nc"), "source", "yuv420p")

    def test_observed_gop_uses_packet_key_timestamps_in_presentation_order(self):
        probe = {
            "streams": [{"time_base": "1/1000"}],
            "packets": [
                {"pts": 1000, "flags": "K__"},
                {"pts": 966, "flags": "___"},
                {"pts": 0, "flags": "K__"},
                {"pts": 2000, "flags": "K__"},
            ],
        }
        self.assertEqual(observed_gop(probe, 90), 30)
        self.assertIsNone(observed_gop(probe, 91))
        self.assertIsNone(observed_gop({**probe, "packets": probe["packets"][:1]}, 90))

    def test_packet_sum_excludes_headers_and_rejects_empty_or_invalid_packets(self):
        self.assertEqual(parse_packet_sizes({"packets": [{"size": "13"}, {"size": "99"}]}), 112)
        for packets in ([], [{"size": "-1"}], [{"pts": 1}], [{"size": True}]):
            with self.subTest(packets=packets):
                with self.assertRaises(RunnerError):
                    parse_packet_sizes({"packets": packets})

    def test_vmaf_requires_complete_contiguous_series_and_consistent_mean(self):
        with TemporaryDirectory() as folder:
            output = Path(folder) / "score.json"
            frames = [
                {"frameNum": 0, "metrics": {"vmaf": 90.0005}},
                {"frameNum": 1, "metrics": {"vmaf": 90.0005}},
            ]
            good = {"frames": frames, "pooled_metrics": {"vmaf": {"mean": 90.0005}}}
            output.write_text(json.dumps(good))
            mean, milli, scores = parse_vmaf(output, 2)
            self.assertEqual((mean, milli, len(scores)), (90.0005, 90001, 2))
            for bad in (
                {**good, "frames": frames[:1]},
                {**good, "frames": [frames[0], frames[0]]},
                {**good, "pooled_metrics": {"vmaf": {"mean": 90.5}}},
                {**good, "frames": [{"frameNum": 0, "metrics": {"vmaf": float("nan")}}, frames[1]]},
            ):
                output.write_text(json.dumps(bad))
                with self.assertRaises(RunnerError):
                    parse_vmaf(output, 2)


class RuntimeIdentityTest(unittest.TestCase):
    def test_cli_reloads_the_exact_bytes_it_fingerprints_after_preload_swap(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            source = Path(runner.__file__).read_text()
            guard = 'if __name__ == "__main__":'
            self.assertEqual(source.count(guard), 1)
            model = root / runner.MODEL_NAME
            model.write_bytes(b"test model")
            gpu = "GPU-eb576a3f-5b2d-4be7-863c-742308e386e7"
            fake_hardware = f'''
MODEL_SHA256 = "{hashlib.sha256(model.read_bytes()).hexdigest()}"

def cuda_device(index):
    return "{gpu}", "test GPU"

def capture(args, stage):
    if stage == "GPU_QUERY":
        return "570.00", ""
    if stage == "NVENC_PROBE":
        return json.dumps({{
            "schemaVersion": 1, "deviceIndex": 0, "gpuUuid": "{gpu}", "maxNvencApiVersion": 208,
            "sdkApiVersion": {{"major": 13, "minor": 0}},
            "encoders": [{{"codec": "HEVC", "inputFormats": [1]}}],
        }}), ""
    return "V hevc_nvenc\\nV hevc_cuvid\\nT scale_cuda\\nT hwupload\\nT libvmaf_cuda", ""

'''
            source = source.replace(guard, fake_hardware + guard)
            original = root / "runner.py"
            replacement = root / "replacement.py"
            replacement_source = source.replace(runner.PROFILE_ID, "replacement-profile")
            replacement.write_text(replacement_source)
            expected = hashlib.sha256(replacement.read_bytes()).hexdigest()
            original.write_text(source.replace(guard, guard + f"\n    Path({str(replacement)!r}).replace(__file__)"))
            tool = root / "test-executable"
            tool.write_bytes(b"test executable")
            tool.chmod(0o700)
            env = {
                **os.environ,
                "BITOVP_NVENC_FFMPEG": str(tool),
                "BITOVP_NVENC_FFPROBE": str(tool),
                "BITOVP_NVENC_SDK_PROBE": str(tool),
                "BITOVP_NVENC_VMAF_MODEL": str(model),
                "BITOVP_NVENC_GPU_INDEX": "0",
            }
            completed = subprocess.run(
                [sys.executable, "-B", str(original), "probe"],
                env=env, capture_output=True, text=True, check=True,
            )
            data = json.loads(completed.stdout)
            self.assertEqual(data["runnerSha256"], expected)
            self.assertEqual(data["scoringProfileId"], "replacement-profile")

            with self.subTest(launcher="older snapshot"):
                replacement.write_text(replacement_source)
                previous = root / "previous.py"
                previous.write_text(f'''
import os
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

alias = Path(sys.argv[0])
new_link = alias.with_suffix(".new")
new_link.symlink_to({str(replacement)!r})
new_link.replace(alias)
path = alias.resolve(strict=True)
with path.open("rb") as handle:
    info = os.fstat(handle.fileno())
    identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    source = SimpleNamespace(path=path, identity=identity, contents=handle.read())
implementation = ModuleType("_bitovp_nvenc_runner_impl")
implementation.__file__ = str(path)
sys.modules[implementation.__name__] = implementation
exec(compile(source.contents, str(path), "exec", dont_inherit=True), implementation.__dict__)
sys.exit(implementation.main(source))
''')
                alias = root / "active.py"
                alias.symlink_to(previous)
                completed = subprocess.run(
                    [sys.executable, "-B", str(alias), "probe"],
                    env=env, capture_output=True, text=True,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertEqual(json.loads(completed.stdout), data)

    def test_snapshot_retains_alias_for_an_older_implementation(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            target = root / "runner.py"
            target.write_bytes(b"runner source")
            alias = root / "active.py"
            alias.symlink_to(target)
            snapshot = runner.read_runner_source(alias)
            self.assertEqual(snapshot.invocation_path, alias.absolute())
            self.assertEqual(snapshot.invocation_path.resolve(strict=True), snapshot.path)

    def resolve_fixture(self, root, change_during_probe=None, runner_link=None, **runtime_options):
        paths = {name: root / name for name in ("ffmpeg", "ffprobe", "sdk-probe", "runner.py")}
        for name, path in paths.items():
            path.write_bytes(name.encode())
            path.chmod(0o700)
        model = root / runner.MODEL_NAME
        model.write_bytes(b"validated model")
        gpu = "GPU-eb576a3f-5b2d-4be7-863c-742308e386e7"

        def capture(args, stage):
            if stage == "GPU_QUERY":
                return "570.00", ""
            if stage == "NVENC_PROBE":
                return json.dumps({
                    "schemaVersion": 1, "deviceIndex": 0, "gpuUuid": gpu, "maxNvencApiVersion": 208,
                    "sdkApiVersion": {"major": 13, "minor": 0},
                    "encoders": [{"codec": "HEVC", "inputFormats": [1]}],
                }), ""
            if change_during_probe and args[-1] == "-filters":
                self.replace_file(paths[change_during_probe])
            return "V hevc_nvenc\nV hevc_cuvid\nT scale_cuda\nT hwupload\nT libvmaf_cuda", ""

        env = {
            "BITOVP_NVENC_FFMPEG": str(paths["ffmpeg"]),
            "BITOVP_NVENC_FFPROBE": str(paths["ffprobe"]),
            "BITOVP_NVENC_SDK_PROBE": str(paths["sdk-probe"]),
            "BITOVP_NVENC_VMAF_MODEL": str(model),
            "BITOVP_NVENC_GPU_INDEX": "0",
        }
        if runner_link is not None:
            runner_link.symlink_to(paths["runner.py"])
        invocation_path = runner_link or paths["runner.py"]
        runner_source = runner.read_runner_source(invocation_path)
        with patch.dict(os.environ, env), \
                patch.object(runner, "MODEL_SHA256", hashlib.sha256(model.read_bytes()).hexdigest()), \
                patch.object(runner, "cuda_device", return_value=(gpu, "test GPU")), \
                patch.object(runner, "capture", side_effect=capture):
            runtime = runner.resolve_runtime(runner_source, invocation_path, **runtime_options)
        return runtime, paths, model

    @staticmethod
    def replace_file(path):
        before = path.stat()
        replacement = path.with_name(path.name + ".new")
        replacement.write_bytes(b"X" * before.st_size)
        os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
        replacement.replace(path)

    def measure_fixture(self, runtime, root, change_during_score=None, measure_vmaf_v1=False):
        source = root / "example.mkv"
        source.touch()
        item = request()
        item["sourcePath"] = str(source)
        if measure_vmaf_v1:
            item["trial"]["additionalScoringProfiles"] = ["bitovp-vmaf-cuda-1.0.16-3d0h"]
        trial = parse_trial(item)
        packet_probe = {"streams": [{"codec_name": "hevc", "time_base": "1/30"}],
                        "packets": [{"size": "10", "pts": 0, "flags": "K_"}]}

        def score(_runtime, _trial, _source, _clock, _encoded, work):
            self.assertEqual((work / runner.MODEL_NAME).read_bytes(), b"validated model")
            if change_during_score:
                change_during_score()
            return (90.0, 90000, [], 1)

        with patch.object(runner, "probe_media", side_effect=[{}, packet_probe]), \
                patch.object(runner, "parse_measurement", return_value=Fraction(1, 30)), \
                patch.object(runner, "encode", return_value=(source, 1)), \
                patch.object(runner, "score", side_effect=score), \
                patch.object(runner, "sha256_file", side_effect=AssertionError("unexpected second digest")):
            return runner.measure(runtime, trial, cpu_audit=False)

    def test_replacing_runtime_tool_during_probe_rejects_capabilities(self):
        for tool in ("sdk-probe", "runner.py"):
            with self.subTest(tool=tool), TemporaryDirectory() as folder, \
                    self.assertRaisesRegex(RunnerError, "RUNTIME_TOOL_CHANGED"):
                self.resolve_fixture(Path(folder), change_during_probe=tool)

    def test_replacing_source_after_snapshot_rejects_before_runtime_probe(self):
        with TemporaryDirectory() as folder:
            path = Path(folder) / "runner.py"
            path.write_bytes(b"snapshot source")
            source = runner.read_runner_source(path)
            self.replace_file(path)
            with patch.object(runner, "executable", side_effect=AssertionError("unexpected tool probe")), \
                    self.assertRaisesRegex(RunnerError, "RUNTIME_TOOL_CHANGED"):
                runner.resolve_runtime(source, path)

    def test_replacing_consumed_tool_during_measurement_rejects_receipt(self):
        for tool in ("ffmpeg", "ffprobe", "sdk-probe", "runner.py"):
            with self.subTest(tool=tool), TemporaryDirectory() as folder:
                root = Path(folder)
                runtime, paths, _ = self.resolve_fixture(root)
                with self.assertRaisesRegex(RunnerError, "RUNTIME_TOOL_CHANGED"):
                    self.measure_fixture(runtime, root, change_during_score=lambda: self.replace_file(paths[tool]))

    def test_retargeting_runner_link_after_snapshot_rejects_before_probe(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            original = root / "original.py"
            replacement = root / "replacement.py"
            link = root / "runner.py"
            original.write_bytes(b"original")
            replacement.write_bytes(b"replacement")
            link.symlink_to(original)
            source = runner.read_runner_source(link)
            self.retarget_link(link, replacement)
            with patch.object(runner, "executable", side_effect=AssertionError("unexpected tool probe")), \
                    self.assertRaisesRegex(RunnerError, "RUNTIME_TOOL_CHANGED"):
                runner.resolve_runtime(source, link)

    def test_retargeting_runner_link_during_measurement_rejects_receipt(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            link = root / "active-runner.py"
            replacement = root / "replacement.py"
            replacement.write_bytes(b"replacement")
            runtime, _, _ = self.resolve_fixture(root, runner_link=link)
            with self.assertRaisesRegex(RunnerError, "RUNTIME_TOOL_CHANGED"):
                self.measure_fixture(runtime, root, lambda: self.retarget_link(link, replacement))

    @staticmethod
    def retarget_link(link, replacement):
        new_link = link.with_suffix(".new")
        new_link.symlink_to(replacement)
        new_link.replace(link)

    def test_stable_runtime_reuses_prevalidated_model_and_digests(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            runtime, _, model = self.resolve_fixture(root)
            model.write_bytes(b"updated externally")
            result = self.measure_fixture(runtime, root)
            self.assertEqual(result["runtimeId"], runtime.capabilities["runtimeId"])

    def test_missing_optional_scorer_preserves_the_primary_measurement(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            runtime, _, _ = self.resolve_fixture(root)
            result = self.measure_fixture(runtime, root, measure_vmaf_v1=True)
            self.assertEqual(result["scoreMilli"], 90000)
            self.assertEqual(result["additionalScores"], [{
                "scoringProfileId": "bitovp-vmaf-cuda-1.0.16-3d0h",
                "status": "failed",
                "failureCode": "VMAF_V1_UNAVAILABLE",
            }])

    def test_claimed_runtime_keeps_official_measurement_when_v1_probe_fails(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            profile = {
                "scoringProfileId": runner.VMAF_V1_PROFILE_ID,
                "scorerSha256": "a" * 64,
                "modelSha256": runner.VMAF_V1_MODEL_SHA256,
                "sourceSha256": "b" * 64,
                "officialRevision": "c" * 40,
                "decoderRuntimeSha256": "d" * 64,
            }
            with patch.object(runner, "discover_vmaf_v1", return_value=SimpleNamespace(profile=profile)):
                admitted, _, _ = self.resolve_fixture(root)
            expected = {
                "runtimeId": admitted.capabilities["runtimeId"],
                "additionalScoringProfiles": [profile],
            }
            options = {"expected_runtime": runner.parse_expected_runtime(json.dumps(expected))}
            changed = SimpleNamespace(profile={**profile, "decoderRuntimeSha256": "e" * 64})
            for current in (None, changed):
                with self.subTest(current=current):
                    with patch.object(runner, "discover_vmaf_v1", return_value=current) as discover:
                        dual, _, _ = self.resolve_fixture(root, **options, probe_vmaf_v1=True)
                        discover.assert_called_once()
                    dual_result = self.measure_fixture(dual, root, measure_vmaf_v1=True)
                    self.assertEqual(dual_result["runtimeId"], expected["runtimeId"])
                    self.assertEqual(dual_result["scoreMilli"], 90000)
                    self.assertEqual(dual_result["additionalScores"][0]["failureCode"], "VMAF_V1_UNAVAILABLE")
            with patch.object(runner, "discover_vmaf_v1", side_effect=AssertionError("unexpected v1 probe")):
                primary, _, _ = self.resolve_fixture(root, **options, probe_vmaf_v1=False)
                primary_result = self.measure_fixture(primary, root)
                with self.assertRaisesRegex(RunnerError, "EXPERIMENT_RUNTIME_CHANGED"):
                    self.resolve_fixture(root, expected_runtime={**expected, "runtimeId": "0" * 64}, probe_vmaf_v1=False)
            self.assertEqual(primary_result["runtimeId"], expected["runtimeId"])
            self.assertNotIn("additionalScores", primary_result)

    def test_claimed_official_only_runtime_keeps_its_id_when_v1_becomes_available(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            with patch.object(runner, "discover_vmaf_v1", return_value=None):
                admitted, _, _ = self.resolve_fixture(root)
            expected = {"runtimeId": admitted.capabilities["runtimeId"]}
            with patch.object(runner, "discover_vmaf_v1", side_effect=AssertionError("unexpected v1 probe")):
                primary, _, _ = self.resolve_fixture(root, expected_runtime=expected, probe_vmaf_v1=False)
            result = self.measure_fixture(primary, root)
            self.assertEqual(result["runtimeId"], expected["runtimeId"])
            self.assertEqual(result["scoreMilli"], 90000)
            self.assertNotIn("additionalScores", result)

    def test_secondary_reserves_time_to_return_the_primary_receipt(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            runtime, _, _ = self.resolve_fixture(root)
            tool, identity = runtime.tool_identities[0]
            runtime = replace(runtime, vmaf_v1=runner.OwnedVmafV1(tool, tool, identity, b"model", {}))
            now = 755_000_000_000
            for remaining, expected_timeout in ((295, 280), (10, None)):
                with self.subTest(remaining=remaining), \
                        patch.dict(os.environ, {"BITOVP_NVENC_RUNNER_DEADLINE_NS": str(now + remaining * 10**9)}), \
                        patch.object(runner, "monotonic_ns", return_value=now), \
                        patch.object(runner, "capture", side_effect=RunnerError("VMAF_V1_SCORE_TIMEOUT")) as capture:
                    result = self.measure_fixture(runtime, root, measure_vmaf_v1=True)
                    self.assertEqual(result["scoreMilli"], 90000)
                    self.assertEqual(result["additionalScores"][0]["failureCode"], "VMAF_V1_SCORE_TIMEOUT")
                    if expected_timeout is None:
                        capture.assert_not_called()
                    else:
                        self.assertEqual(capture.call_args.kwargs["timeout"], expected_timeout)


class SoftwareRunnerTest(unittest.TestCase):
    def software_request(self, codec="H264", encoder="libx264", options=None):
        item = request()
        original = item["trial"]
        item["trial"] = {
            "sourceId": original["sourceId"], "window": original["window"], "codec": codec,
            "software": {"encoder": encoder, "options": options or {}},
        }
        return item

    def test_software_codec_and_runtime_must_match(self):
        for encoder, codec in runner.SOFTWARE_CODECS.items():
            trial = parse_trial(self.software_request(codec, encoder))
            self.assertIsInstance(trial, runner.SoftwareTrial)
            self.assertEqual(trial.frame_count, 3)
        with self.assertRaisesRegex(RunnerError, "INVALID_REQUEST"):
            parse_trial(self.software_request("AV1"))
        mixed = self.software_request()
        mixed["trial"]["preset"] = "P4"
        with self.assertRaisesRegex(RunnerError, "INVALID_REQUEST"):
            parse_trial(mixed)
        runtime = SimpleNamespace(tool_identities=(), invocation_path=Path(runner.__file__),
                                  runner_path=Path(runner.__file__), capabilities={"supportedCodecs": ["H264"]})
        with self.assertRaisesRegex(RunnerError, "UNSUPPORTED_RUNTIME_ENCODER"):
            runner.measure(runtime, parse_trial(self.software_request()), False)

    def test_soname_retarget_rejects_unchanged_old_library_file(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / "libx265.so.1.0"
            new = root / "libx265.so.1.1"
            old.write_bytes(b"previous")
            new.write_bytes(b"current")
            link = root / "libx265.so.1"
            link.symlink_to(old)
            binary = root / "ffmpeg"
            trace = f"libx265.so.1 => {link} (0xabcd)\n"
            with patch.object(sys, "platform", "linux"), patch.object(runner, "elf_interpreter", return_value=None), \
                    patch.object(runner, "capture", return_value=(trace, "")):
                expected = runner.software_dependencies(binary, binary)
                self.assertEqual(expected[binary], (runner.SoftwareLibrary(link.name, old.resolve()),))
                identity = runner.runtime_tool_identity(old)
                link.unlink()
                link.symlink_to(new)
                self.assertEqual(identity, runner.runtime_tool_identity(old))
                with self.assertRaisesRegex(RunnerError, "RUNTIME_TOOL_CHANGED"):
                    runner.require_software_dependencies(binary, binary, expected)

    def test_ffmpeg_and_ffprobe_cannot_exchange_libraries(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            ffmpeg, ffprobe = root / "ffmpeg", root / "ffprobe"
            first, second = root / "build-a", root / "build-b"
            first.touch()
            second.touch()
            targets = {ffmpeg: first, ffprobe: second}

            def trace(args, *_args, **_kwargs):
                return f"libx264.so.1 => {targets[Path(args[0])]} (0xabbc)\n", ""

            with patch.object(sys, "platform", "linux"), patch.object(runner, "elf_interpreter", return_value=None), \
                    patch.object(runner, "capture", side_effect=trace):
                pinned = runner.software_dependencies(ffmpeg, ffprobe)
                targets.update({ffmpeg: second, ffprobe: first})
                with self.assertRaisesRegex(RunnerError, "RUNTIME_TOOL_CHANGED"):
                    runner.require_software_dependencies(ffmpeg, ffprobe, pinned)

    def test_absent_loader_trace_only_qualifies_static_elf(self):
        # One ELF64 little-endian program header, first PT_INTERP then PT_LOAD.
        elf = bytearray(64 + 56)
        elf[:6] = b"\x7fELF\x02\x01"
        elf[32] = 64
        elf[54] = 56
        elf[56] = 1
        with TemporaryDirectory() as directory, patch.object(sys, "platform", "linux"), \
                patch.object(runner, "capture", return_value=("ffmpeg version 8", "")):
            program = Path(directory) / "ffmpeg"
            elf[64] = 3
            program.write_bytes(elf)
            with self.assertRaisesRegex(RunnerError, "INCOMPLETE_SOFTWARE_RUNTIME"):
                runner.software_library_paths(program)
            interpreter = Path(directory) / "ld-linux"
            interpreter.touch()
            path = os.fsencode(interpreter)
            for padding in (1, 33):
                segment = path + bytes(padding)
                elf[72:80] = len(elf).to_bytes(8, "little")
                elf[96:104] = len(segment).to_bytes(8, "little")
                program.write_bytes(elf + segment)
                self.assertEqual(runner.elf_interpreter(program), interpreter.resolve())
            elf[64] = 1
            program.write_bytes(elf)
            self.assertEqual(runner.software_library_paths(program), ())

    @unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("cc"), "requires Linux and a C compiler")
    def test_pinned_library_retains_its_private_origin_dependency(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            private = root / "private"
            private.mkdir()
            program = root / "ffmpeg"
            # The executable only knows libavcodec. libavcodec alone knows where
            # its private libopus lives, and no system library provides the symbol.
            opus = private / "libopus.so.0"
            codec = private / "libavcodec.so.99"
            # Private bundles can omit DT_SONAME. Keep the original DT_NEEDED
            # basename resolvable even when the object was preloaded by descriptor.
            subprocess.run(["cc", "-x", "c", "-", "-shared", "-fPIC", "-o", opus],
                           input="int private_opus(void) { return 73; }", text=True, check=True)
            subprocess.run(["cc", "-x", "c", "-", "-shared", "-fPIC", "-Wl,-soname," + codec.name,
                            "-Wl,-rpath,$ORIGIN", "-L" + str(private), "-l:" + opus.name, "-o", codec],
                           input="extern int private_opus(void); int codec(void) { return private_opus(); }",
                           text=True, check=True)
            subprocess.run(["cc", "-x", "c", "-", "-Wl,-rpath,$ORIGIN/private", "-L" + str(private),
                            "-l:" + codec.name, "-o", program], input='#include <stdio.h>\nextern int codec(void);\n'
                           'int main(void) { printf("%d\\n", codec()); }\n', text=True, check=True)
            self.assertEqual(subprocess.check_output([program], text=True), "73\n")
            bindings = runner.software_dependencies(program, program)
            paths = {program, *(entry.path for entry in bindings[program])}
            identities = {path: runner.runtime_tool_identity(path) for path in paths}
            output, _ = runner.capture_software([str(program)], "RUNTIME_PROBE", bindings, identities)
            self.assertEqual(output, "73\n")

    @unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("cc"), "requires Linux and a C compiler")
    def test_real_child_uses_pinned_library_across_transient_soname_retarget(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            program, library, alias = root / "tool", root / "old.so", root / "libx264.so.1"
            newer = root / "new.so"
            for path, number in ((library, 1), (newer, 2)):
                subprocess.run(["cc", "-x", "c", "-", "-shared", "-fPIC", "-Wl,-soname," + alias.name, "-o", path],
                               input=f"int version(void) {{ return {number}; }}", text=True, check=True)
            alias.symlink_to(library)
            subprocess.run(["cc", "-x", "c", "-", "-L" + directory, "-l:" + alias.name, "-Wl,-rpath," + directory,
                            "-o", program], input='#include <stdio.h>\nextern int version(void);\n'
                            'int main(void) { printf("%d\\n", version()); }\n', text=True, check=True)
            bindings = runner.software_dependencies(program, program)
            paths = {program, *(entry.path for entry in bindings[program])}
            identities = {path: runner.runtime_tool_identity(path) for path in paths}
            original_capture = runner.capture

            def swap_while_running(*args, **kwargs):
                alias.unlink()
                alias.symlink_to(newer)
                try:
                    self.assertEqual(subprocess.check_output([program], text=True), "2\n")
                    return original_capture(*args, **kwargs)
                finally:
                    alias.unlink()
                    alias.symlink_to(library)

            with patch.object(runner, "capture", side_effect=swap_while_running):
                output, _ = runner.capture_software([str(program)], "ENCODE", bindings, identities)
            self.assertEqual(output, "1\n")
            runner.require_software_dependencies(program, program, bindings)

    def test_software_rejects_ignored_native_settings(self):
        for warning in (
            "[libx264 @ 0x1] Error parsing option 'b-adapt = xyz'.",
            "[libx265 @ 0x1] Unknown option: bad-field.",
            "[libx265 @ 0x1] Invalid value for bframes: 30.",
            "[libsvtav1 @ 0x1] Error setting option aq-mode to value bad.",
        ):
            with self.subTest(warning=warning), self.assertRaisesRegex(RunnerError, "SOFTWARE_SETTING_NOT_APPLIED"):
                runner.check_software_report(warning)
        runner.check_software_report("    title: Error parsing option")

    def test_two_pass_requires_nonempty_statistics_before_encoding_output(self):
        item = self.software_request(options={"passes": "2", "b": "2000000"})
        runtime = SimpleNamespace(ffmpeg=Path("/ffmpeg"), capabilities={"softwareEncoders": []},
                                  software_catalog=SimpleNamespace(build_software_options=lambda *_: ["-c:v", "libx264"]))
        with TemporaryDirectory() as directory, patch.object(runner, "capture", return_value=("", "")) as capture, \
                patch.object(runner, "validate_timeline"):
            with self.assertRaisesRegex(RunnerError, "UNSUPPORTED_SOFTWARE_MULTIPASS"):
                runner.encode(runtime, parse_trial(item), Path("/source"), Fraction(1, 1000), Path(directory))
            capture.assert_called_once()
            self.assertIn("-passlogfile:v", capture.call_args.args[0])

    @unittest.skipUnless(os.environ.get("BITOVP_SOFTWARE_E2E") == "1", "requires FFmpeg, four software encoders and a pinned VMAF model")
    def test_real_cpu_encoder_passes_and_vmaf(self):
        env = {**os.environ, "BITOVP_EXPERIMENTS_BACKEND": "software"}
        command = [sys.executable, "-B", runner.__file__]
        runtime = json.loads(subprocess.check_output([*command, "probe"], env=env))
        self.assertEqual(runtime["runtimeKind"], "software")
        self.assertEqual({e["encoder"] for e in runtime["softwareEncoders"]}, set(runner.SOFTWARE_CODECS))
        env["BITOVP_NVENC_EXPECTED_RUNTIME"] = json.dumps({"runtimeId": runtime["runtimeId"]})
        with TemporaryDirectory() as folder:
            source = Path(folder) / "source.mp4"
            subprocess.run([
                env.get("BITOVP_SOFTWARE_FFMPEG", "ffmpeg"), "-v", "error", "-f", "lavfi", "-i",
                "testsrc2=s=1920x1080:r=30", "-vf",
                "setsar=1,setparams=range=limited:colorspace=bt709:color_trc=bt709:color_primaries=bt709",
                "-frames:v", "8", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709",
                "-color_trc", "bt709", "-c:v", "libx264", "-preset", "ultrafast", str(source),
            ], check=True)
            fast_options = {
                "libx264": {"preset": "ultrafast"}, "libx265": {"preset": "ultrafast"},
                "libvpx-vp9": {"deadline": "good", "cpu-used": "8"}, "libsvtav1": {"preset": "8"},
            }
            native_options = {
                "libx264": {"aq-mode": "1"}, "libx265": {"me": "hex"},
                "libvpx-vp9": {"ts_layering_mode": "0"}, "libsvtav1": {"aq-mode": "2"},
            }
            for encoder, codec in runner.SOFTWARE_CODECS.items():
                for passes in ("1", "2"):
                    with self.subTest(encoder=encoder, passes=passes):
                        item = self.software_request(codec, encoder, {"b": "2000000", "passes": passes, **fast_options[encoder]})
                        item["trial"]["software"]["nativeOptions"] = native_options[encoder]
                        item["sourcePath"] = str(source)
                        path = Path(folder) / "request.json"
                        path.write_text(json.dumps(item))
                        row = json.loads(subprocess.check_output([*command, "measure", "--request-file", str(path)], env=env))
                        self.assertEqual(row["runtimeId"], runtime["runtimeId"])
                        self.assertEqual(row["scoringProfileId"], runner.SOFTWARE_PROFILE_ID)
                        self.assertEqual(row["frameCount"], 3)
                        self.assertGreater(int(row["videoBytes"]), 0)
                        self.assertAlmostEqual(row["meanVmaf"], row["scoreMilli"] / 1000, delta=0.00051)


if __name__ == "__main__":
    unittest.main()
