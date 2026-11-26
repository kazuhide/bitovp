import json
from pathlib import Path
import subprocess
import unittest


BINARY = Path(__file__).resolve().parent / ".lake/build/bin/bitovp-quality-select"
PROFILE = "vmaf-cuda:v0.6.1"
DIGEST = "0123456789abcdef" * 4


def trial(trial_id, **fields):
    return {
        "trialId": trial_id,
        "codec": "HEVC",
        "scoringProfileId": PROFILE,
        **fields,
    }


def request(candidates, **fields):
    return {
        "schemaVersion": 1,
        "evaluation": "measured",
        "scoringProfileId": PROFILE,
        "candidateSetSha256": DIGEST,
        "constraints": {},
        "candidates": candidates,
        **fields,
    }


def run_cli(data):
    return subprocess.run(
        [BINARY],
        input=json.dumps(data),
        encoding="utf-8",
        capture_output=True,
        timeout=10,
        check=False,
    )


class QualitySelectionCLI(unittest.TestCase):
    def assert_result(self, data, decision):
        run = run_cli(data)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stderr, "")
        self.assertEqual(
            json.loads(run.stdout),
            {
                "schemaVersion": 1,
                "evaluation": data["evaluation"],
                "scoringProfileId": data["scoringProfileId"],
                "candidateSetSha256": data["candidateSetSha256"],
                "candidateCount": len(data["candidates"]),
                **decision,
            },
        )

    def test_uses_exact_rate_ratio_and_applies_all_requested_constraints(self):
        limit = 9_007_199_254_740_991
        self.assert_result(
            request(
                [
                    trial("at-limit", scoreMilli=94000, gopFrames=60, encodeMs=2000,
                          rate={"numerator": str(limit * 3), "denominator": "3"}),
                    trial("fraction-over", scoreMilli=99000, gopFrames=60, encodeMs=500,
                          rate={"numerator": str(limit * 3 + 1), "denominator": "3"}),
                    trial("wrong-codec", codec="H264", scoreMilli=100000),
                    trial("wrong-gop", scoreMilli=100000, gopFrames=59),
                    trial("too-slow", scoreMilli=100000, encodeMs=2001),
                    trial("missing-time", scoreMilli=100000, gopFrames=60,
                          rate={"numerator": "1", "denominator": "1"}),
                ],
                constraints={
                    "codec": "HEVC",
                    "bitrateLimitBps": limit,
                    "encodeTimeLimitMs": 2000,
                    "gopFrames": 60,
                },
            ),
            {
                "status": "selected", "trialId": "at-limit",
                "eligibleCount": 1, "ineligibleCount": 4, "incompleteCount": 1,
            },
        )

    def test_negative_score_and_stable_trial_id_tie(self):
        candidates = [
            trial("z", scoreMilli=-5),
            trial("a", scoreMilli=-5),
            trial("low", scoreMilli=-10),
            trial("missing-score"),
        ]
        decision = {
            "status": "selected", "trialId": "a",
            "eligibleCount": 3, "ineligibleCount": 0, "incompleteCount": 1,
        }
        for rows in (candidates, list(reversed(candidates))):
            self.assert_result(request(rows, evaluation="predicted"), decision)

    def test_selects_measured_vp9_software_trial(self):
        profile = "official-vmaf-cpu-0.6.1"
        candidates = [
            trial("vp9", codec="VP9", scoringProfileId=profile, scoreMilli=90000),
            trial("h264", codec="H264", scoringProfileId=profile, scoreMilli=95000),
        ]
        self.assert_result(request(candidates, scoringProfileId=profile, constraints={"codec": "VP9"}), {
            "status": "selected", "trialId": "vp9",
            "eligibleCount": 1, "ineligibleCount": 1, "incompleteCount": 0,
        })

    def test_zero_is_a_measured_value(self):
        self.assert_result(
            request(
                [trial("zero", scoreMilli=0, encodeMs=0,
                       rate={"numerator": "0", "denominator": "1"})],
                constraints={"encodeTimeLimitMs": 0, "bitrateLimitBps": 0},
            ),
            {
                "status": "selected", "trialId": "zero",
                "eligibleCount": 1, "ineligibleCount": 0, "incompleteCount": 0,
            },
        )

    def test_missing_evidence_and_known_failures_are_distinct(self):
        data = request(
            [
                trial("unknown-rate", scoreMilli=94000),
                trial("over-rate", rate={"numerator": "4000001", "denominator": "1"}),
            ],
            constraints={"bitrateLimitBps": 4000000},
        )
        self.assert_result(data, {
            "status": "insufficient_evidence",
            "eligibleCount": 0, "ineligibleCount": 1, "incompleteCount": 1,
        })
        data["candidates"].pop(0)
        self.assert_result(data, {
            "status": "no_feasible_candidate",
            "eligibleCount": 0, "ineligibleCount": 1, "incompleteCount": 0,
        })
        self.assert_result(request([]), {
            "status": "no_feasible_candidate",
            "eligibleCount": 0, "ineligibleCount": 0, "incompleteCount": 0,
        })

    def test_rejects_duplicate_keys_and_trailing_input(self):
        valid = json.dumps(request([]))
        duplicate_version = valid.replace('"schemaVersion": 1', '"schemaVersion": 2, "schemaVersion": 1')
        for raw in (duplicate_version, valid + " {}", "{"):
            with self.subTest(raw=raw):
                run = subprocess.run(
                    [BINARY], input=raw, encoding="utf-8", capture_output=True,
                    timeout=10, check=False,
                )
                self.assertEqual(run.returncode, 2)
                self.assertEqual(run.stdout, "")
                self.assertTrue(run.stderr)

    def test_rejects_invalid_requests_without_emitting_a_result(self):
        invalid = {
            "unsupported version": request([], schemaVersion=2),
            "unsupported evaluation": request([], evaluation="estimated"),
            "invalid profile": request([], scoringProfileId=" "),
            "bad digest": request([], candidateSetSha256=DIGEST.upper()),
            "unknown constraint": request([], constraints={"bitratLimitBps": 3500000}),
            "unsupported constraint codec": request([], constraints={"codec": "VP8"}),
            "unsupported candidate codec": request([trial("x", codec="VP8")]),
            "mixed profiles": request([trial("x", scoringProfileId="v1")]),
            "duplicate trial IDs": request([trial("X"), trial("X")]),
            "blank ID": request([trial(" ")]),
            "unsafe integer": request([trial("X", scoreMilli=9_007_199_254_740_992)]),
            "unsafe signed integer": request([trial("X", scoreMilli=-9_007_199_254_740_992)]),
            "unsafe budget": request([], constraints={"bitrateLimitBps": 9_007_199_254_740_992}),
            "negative budget": request([], constraints={"bitrateLimitBps": -1}),
            "boolean score": request([trial("X", scoreMilli=True)]),
            "fractional score": request([trial("X", scoreMilli=1.1)]),
            "present null score": request([trial("X", scoreMilli=None)]),
            "zero denominator": request([trial("X", rate={"numerator": "1", "denominator": "0"})]),
            "unsafe rate type": request([trial("X", rate={"numerator": 1, "denominator": "2"})]),
            "invalid decimal": request([trial("X", rate={"numerator": "0x1", "denominator": "1"})]),
            "negative decimal": request([trial("X", rate={"numerator": "-1", "denominator": "1"})]),
        }
        for why, data in invalid.items():
            with self.subTest(why=why):
                run = run_cli(data)
                self.assertNotEqual(run.returncode, 0)
                self.assertEqual(run.stdout, "")
                self.assertTrue(run.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
