import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import corpus
import finalization
from execution import OperationError


def header(frames=5390):
    return {"streams": [
        {"codec_type": "video", "codec_name": "h264", "width": 872, "height": 480,
         "r_frame_rate": "30/1", "avg_frame_rate": "30/1", "sample_aspect_ratio": "1:1",
         "time_base": "1/30000", "start_pts": 0, "duration_ts": frames * 1000, "nb_frames": str(frames)},
        {"codec_type": "audio", "codec_name": "aac", "sample_rate": "48000", "channels": 2,
         "time_base": "1/48000", "start_pts": 0, "duration_ts": frames * 1600}]}


class FinalizationTests(unittest.TestCase):
    def test_short_video_drives_clock_without_extending_or_duplicating_frames(self):
        source = {"format": {"start_time": "0"}, "streams": [
            {"codec_type": "video", "start_time": "0.032000"},
            {"codec_type": "audio", "start_time": "0.000000"}]}
        recipe = finalization.finalization_recipe(header(), source)
        self.assertEqual(recipe["frameCount"], 5390)
        self.assertEqual(recipe["duration"], {"num": 5390, "den": 30})
        self.assertEqual(recipe["audioEndSample"], 8624000)
        self.assertEqual(recipe["videoPolicy"], "COPY_EXISTING_CFR30_BITSTREAM_WITHOUT_EXTENSION")
        self.assertEqual(recipe["originalStreamStartSeconds"], {"video": ["0.032000"], "audio": ["0.000000"]})

    def test_non_cfr_shorter_than_60s_over_180s_and_invalid_clock_are_refused(self):
        for value in [header(1799), header(5401)]:
            with self.assertRaisesRegex(OperationError, "PARTIAL_VIDEO_CLOCK_INVALID"):
                finalization.finalization_recipe(value, {})
        for field, bad in [("r_frame_rate", "30000/1001"), ("time_base", "1/90000"), ("start_pts", 1)]:
            value = header()
            value["streams"][0][field] = bad
            with self.assertRaisesRegex(OperationError, "PARTIAL_VIDEO_CLOCK_INVALID"):
                finalization.finalization_recipe(value, {})

    def test_every_decoded_frame_timestamp_and_duration_must_match_the_cfr_clock(self):
        frames = [{"best_effort_timestamp": i * 1000, "duration": 1000} for i in range(1800)]
        proof = finalization.validate_video_frames(frames, 1800)
        self.assertEqual(proof["decodedFrameCount"], 1800)
        self.assertEqual(proof["timestampSequence"], "0_PLUS_INDEX_TIMES_1000_IN_1_30000")
        for index, field, bad in [(1, "best_effort_timestamp", 0), (700, "duration", 999)]:
            changed = copy.deepcopy(frames)
            changed[index][field] = bad
            with self.assertRaisesRegex(OperationError, "VIDEO_DECODE_CLOCK_INVALID"):
                finalization.validate_video_frames(changed, 1800)
        with self.assertRaisesRegex(OperationError, "VIDEO_DECODE_CLOCK_INVALID"):
            finalization.validate_video_frames(frames[:-1], 1800)

    def test_audio_presentation_clock_is_exact_and_aac_decode_padding_is_explicit(self):
        value = header(1800)["streams"][1]
        proof = finalization.validate_audio_clock(value, 1800 * 1600 + 768, 1800)
        self.assertEqual(proof["presentationSampleCount"], 2880000)
        self.assertEqual(proof["decodedTailPaddingSamples"], 768)
        for decoded in [2879999, 2881024]:
            with self.assertRaisesRegex(OperationError, "AUDIO_DECODE_CLOCK_INVALID"):
                finalization.validate_audio_clock(value, decoded, 1800)
        changed = {**value, "duration_ts": 2880001}
        with self.assertRaisesRegex(OperationError, "AUDIO_DECODE_CLOCK_INVALID"):
            finalization.validate_audio_clock(changed, 2880001, 1800)

    def test_reuse_binds_failed_native_completion_source_probe_and_explicit_partial_sha(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            partial = root / "excerpt.partial.mp4"
            partial.write_bytes(b"synthetic completed private output")
            probe = {"ok": True, "assetId": "asset-test", "source": {"etag": "opaque"},
                     "result": {"metadata": {"assessment": "VIDEO_PRESENT"}}}
            probe_bytes = json.dumps(probe).encode()
            probe_sha = hashlib.sha256(probe_bytes).hexdigest()
            operation = {"ok": False, "error": "OUTPUT_VALIDATION_FAILED", "cleanupConfirmed": True,
                         "assetId": "asset-test", "source": probe["source"], "sourceProbeSha256": probe_sha,
                         "result": {"nativeReturnCode": 0, "readProof": {"byteCountComplete": True, "failureCode": None}}}
            sha = hashlib.sha256(partial.read_bytes()).hexdigest()
            finalization.validate_partial_reuse(operation, probe, probe_sha, partial, sha)
            for patch in [{"ok": True}, {"cleanupConfirmed": False}, {"error": "READ_BUDGET_EXCEEDED"},
                          {"sourceProbeSha256": "0" * 64},
                          {"result": {"nativeReturnCode": None, "readProof": {"byteCountComplete": True}}}]:
                with self.assertRaisesRegex(OperationError, "PARTIAL_REUSE_NOT_BOUND"):
                    finalization.validate_partial_reuse({**operation, **patch}, probe, probe_sha, partial, sha)
            with self.assertRaisesRegex(OperationError, "PARTIAL_SHA_MISMATCH"):
                finalization.validate_partial_reuse(operation, probe, probe_sha, partial, "0" * 64)
            self.assertEqual(partial.read_bytes(), b"synthetic completed private output")


if __name__ == "__main__":
    unittest.main()
