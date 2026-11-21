import json
import unittest
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory

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


if __name__ == "__main__":
    unittest.main()
