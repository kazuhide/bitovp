import copy
import json
from pathlib import Path
import stat
import tempfile
import unittest

import corpus


def fixture():
    objects = [
        {"Key": "private/proxies/Story_A_720_480.mp4", "Size": 1000, "ETag": '"' + "a" * 32 + '"'},
        {"Key": "private/originals/Story_A_1920_1080.mov", "Size": 9000, "ETag": '"' + "b" * 32 + '"'},
        {"Key": "private/Story_B.mov", "Size": 2000, "ETag": '"' + "c" * 32 + '"'},
        {"Key": "private/Story_C.mxf", "Size": 3000, "ETag": '"' + "d" * 32 + '-3"'},
        {"Key": "private/audio_candidate.mxf", "Size": 4000, "ETag": '"' + "e" * 32 + '"'},
        {"Key": "private/colorbar.mov", "Size": 5000, "ETag": '"' + "f" * 32 + '"'},
        {"Key": "private/notes.txt", "Size": 20, "ETag": '"' + "0" * 32 + '"'},
    ]
    mapping = {"schemaVersion": "clip-quality-work-map-v1", "works": [
        {"workKey": "a", "category": "ANIMATION", "selected": True, "assets": [
            {"key": objects[0]["Key"], "representation": "PROXY"},
            {"key": objects[1]["Key"], "representation": "ORIGINAL"}]},
        {"workKey": "b", "category": "DRAMA", "selected": True,
         "assets": [{"key": objects[2]["Key"], "representation": "ORIGINAL"}]},
        {"workKey": "c", "category": "NATURE_4K", "selected": True,
         "assets": [{"key": objects[3]["Key"], "representation": "ORIGINAL"}]},
        {"workKey": "audio", "category": "UNKNOWN", "selected": False,
         "assets": [{"key": objects[4]["Key"], "representation": "ORIGINAL"}]},
        {"workKey": "bars", "category": "TEST_PATTERN", "selected": False,
         "assets": [{"key": objects[5]["Key"], "representation": "ORIGINAL", "excludeReason": "TEST_PATTERN_PURPOSE"}]},
    ]}
    return {"Contents": objects, "IsTruncated": False}, mapping


def build(inventory=None, mapping=None):
    original, work_map = fixture()
    return corpus.build_corpus(inventory or original, mapping or work_map,
        bucket="example-test-bucket", region="ap-northeast-1", split_seed="fixed-test-seed",
        holdout_count=1, maximum_works=12, created_at="2026-11-06T00:00:00Z")


class CorpusTests(unittest.TestCase):
    def test_resolution_variants_share_work_and_split_and_only_proxy_is_selected(self):
        manifest = build()
        assets = manifest["assets"]
        low, high = assets[0], assets[1]
        self.assertEqual(low["workId"], high["workId"])
        self.assertEqual(low["split"], high["split"])
        self.assertTrue(low["selected"])
        self.assertFalse(high["selected"])
        self.assertEqual(high["exclusionReason"], "ALTERNATE_REPRESENTATION")
        self.assertEqual(len(manifest["cases"]), 9)
        self.assertEqual({c["requestedDurationUs"] for c in manifest["cases"]}, {15000000, 30000000, 60000000})
        self.assertEqual(len({w["workId"] for w in manifest["works"] if w["split"] == "HOLDOUT"}), 1)

    def test_manifest_and_case_ids_are_deterministic_and_bound_to_source_and_recipe(self):
        first = build()
        self.assertEqual(first, build())
        inventory, mapping = fixture()
        inventory["Contents"][0]["ETag"] = '"' + "9" * 32 + '"'
        second = build(inventory, mapping)
        self.assertNotEqual(first["corpusId"], second["corpusId"])
        self.assertNotEqual(first["cases"][0]["caseId"], second["cases"][0]["caseId"])

    def test_source_etag_and_range_hash_are_not_claimed_as_whole_source_sha_or_verified_clock(self):
        manifest = build()
        for asset in manifest["assets"]:
            self.assertIsNone(asset["source"]["sha256"])
        for case in manifest["cases"]:
            self.assertIsNone(case["normalizationClock"])
            self.assertIsNone(case["recipeIdentity"])
            self.assertIsNone(case["modelIdentity"])
            self.assertEqual(case["humanReview"]["status"], "PENDING")
            self.assertEqual(case["annotationProvenance"], [])

    def test_audio_filename_does_not_prove_absence_of_video_and_colorbar_exclusion_is_explicit(self):
        assets = build()["assets"]
        self.assertEqual(assets[4]["mediaAssessment"]["status"], "PROBE_PENDING")
        self.assertNotEqual(assets[4]["exclusionReason"], "AUDIO_ONLY_CONFIRMED")
        self.assertEqual(assets[5]["exclusionReason"], "TEST_PATTERN_PURPOSE")
        self.assertEqual(assets[6]["exclusionReason"], "NON_VIDEO_EXTENSION")

    def test_conflicting_work_groups_missing_keys_and_unmapped_selected_assets_fail_closed(self):
        inventory, mapping = fixture()
        conflict = copy.deepcopy(mapping)
        conflict["works"][1]["assets"].append(conflict["works"][0]["assets"][0])
        with self.assertRaisesRegex(corpus.CorpusError, "ASSET_WORK_CONFLICT"):
            build(inventory, conflict)
        missing = copy.deepcopy(mapping)
        missing["works"][0]["assets"][0]["key"] = "unknown-object.mp4"
        with self.assertRaisesRegex(corpus.CorpusError, "WORK_MAP_SOURCE_MISSING"):
            build(inventory, missing)

    def test_public_summary_contains_only_aliases_counts_and_pending_labels(self):
        summary = corpus.public_summary(build())
        serialized = json.dumps(summary)
        for forbidden in ["private/", "Story_A", "example-test-bucket", '"a' + 'a' * 31]:
            self.assertNotIn(forbidden, serialized)
        self.assertEqual(summary["cases"], 9)
        self.assertEqual(summary["humanGolden"], "PENDING")

    def test_explicit_work_splits_keep_unmaterialized_holdout_and_reject_mixed_assignments(self):
        inventory, mapping = fixture()
        for work in mapping["works"]:
            if work["selected"]:
                work["split"] = "HOLDOUT" if work["workKey"] == "c" else "DEV"
        manifest = build(inventory, mapping)
        self.assertEqual(manifest["splitPolicy"]["method"], "EXPLICIT_WORK_SPLIT_V1")
        self.assertEqual([w["category"] for w in manifest["works"] if w["split"] == "HOLDOUT"], ["NATURE_4K"])
        del mapping["works"][0]["split"]
        with self.assertRaisesRegex(corpus.CorpusError, "SPLIT_ASSIGNMENT_INCOMPLETE"):
            build(inventory, mapping)

    def test_private_outputs_are_exclusive_0600_under_0700_and_never_written_into_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "private" / "manifest.json"
            corpus.private_write_json(path, {"private": True})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            with self.assertRaisesRegex(corpus.CorpusError, "OUTPUT_EXISTS"):
                corpus.private_write_json(path, {})
            with self.assertRaisesRegex(corpus.CorpusError, "OUTPUT_IN_REPOSITORY"):
                corpus.private_write_json(root / "source" / "customer.json", {}, repository_root=root)


if __name__ == "__main__":
    unittest.main()
