import hashlib
import json
import os
import subprocess
import sys
import unittest
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory
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

    def resolve_fixture(self, root, change_during_probe=None, runner_link=None):
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
            runtime = runner.resolve_runtime(runner_source, invocation_path)
        return runtime, paths, model

    @staticmethod
    def replace_file(path):
        before = path.stat()
        replacement = path.with_name(path.name + ".new")
        replacement.write_bytes(b"X" * before.st_size)
        os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
        replacement.replace(path)

    def measure_fixture(self, runtime, root, change_during_score=None):
        source = root / "example.mkv"
        source.touch()
        item = request()
        item["sourcePath"] = str(source)
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


if __name__ == "__main__":
    unittest.main()
