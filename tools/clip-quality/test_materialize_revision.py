import copy
from pathlib import Path
import tempfile
import unittest

from corpus import digest
import materialize_revision as revision
from test_corpus import build


def fixture(root):
    manifest = build()
    asset = next(a for a in manifest["assets"] if a["selected"])
    probe = {"ok": True, "assetId": asset["assetId"], "source": copy.deepcopy(asset["source"]),
        "result": {"metadata": {"assessment": "VIDEO_PRESENT"}}}
    ledger = {"schemaVersion": "clip-quality-cumulative-read-ledger-v4", "globalLimitBytes": 12 * 1024**3,
        "chargedBytes": 11350494474, "remainingBytes": 1534407414}
    value = {"schemaVersion": "clip-quality-materialize-revision-v2", "revisionId": "b6c25b73-1b5e-4f57-b4f2-facff08f494c",
        "assetId": asset["assetId"], "manifestPath": str(root / "manifest.json"), "manifestSha256": "a" * 64,
        "probePath": str(root / "probe.json"), "probeSha256": "b" * 64,
        "priorLedgerPath": str(root / "ledger.json"), "priorLedgerSha256": "c" * 64,
        "previousChargedBytes": 11350494474, "globalLimitBytes": 20 * 1024**3, "perAssetLimitBytes": 6 * 1024**3,
        "deadlineSeconds": 900, "cacheBlockBytes": 8 * 1024**2, "cacheCapacityBytes": 32 * 1024**2,
        "maximumAdditionalAttempts": 1, "outputDirectory": str(root / "new-output"),
        "recipeHash": "d" * 64, "requestedDurationUs": 180000000,
        "reason": "Explicit single LIVE retry; same 180 second transform and prior quota retained"}
    return value, manifest, probe, ledger


def validate(values):
    return revision.validate_revision(*values, manifest_sha256="a" * 64, probe_sha256="b" * 64,
        ledger_sha256="c" * 64, recipe_hash="d" * 64, recipe_duration_us=180000000)


class MaterializeRevisionTests(unittest.TestCase):
    def test_revision_carries_prior_failed_debit_into_one_six_gib_attempt(self):
        with tempfile.TemporaryDirectory() as path:
            values = fixture(Path(path))
            plan = validate(values)
            self.assertEqual(plan["previousChargedBytes"], 11350494474)
            self.assertEqual(plan["remainingGlobalBytes"], 10124342006)
            self.assertEqual(plan["limitBytes"], 6442450944)
            self.assertEqual(plan["deadlineSeconds"], 900)
            self.assertEqual(plan["cacheBlockBytes"], 8 * 1024**2)
            self.assertEqual(plan["cacheCapacityBytes"], 32 * 1024**2)

    def test_changed_hash_asset_recipe_duration_and_weakened_stop_limits_fail_before_io(self):
        with tempfile.TemporaryDirectory() as path:
            values = fixture(Path(path))
            changes = [{"manifestSha256": "e" * 64}, {"probeSha256": "e" * 64}, {"priorLedgerSha256": "e" * 64},
                {"assetId": "asset-" + "0" * 24}, {"recipeHash": "e" * 64}, {"requestedDurationUs": 179000000},
                {"perAssetLimitBytes": 7 * 1024**3}, {"globalLimitBytes": 21 * 1024**3},
                {"deadlineSeconds": 901}, {"maximumAdditionalAttempts": 2}, {"cacheCapacityBytes": 64 * 1024**2},
                {"unexpected": "not admitted"}]
            for change in changes:
                altered = copy.deepcopy(values)
                altered[0].update(change)
                with self.subTest(change=change), self.assertRaisesRegex(revision.RevisionError, "REVISION_INVALID"):
                    validate(altered)
            altered = copy.deepcopy(values)
            altered[2]["source"]["etag"] = "different"
            with self.assertRaisesRegex(revision.RevisionError, "REVISION_INVALID"):
                validate(altered)

    def test_prior_debit_reset_inconsistent_ledger_and_insufficient_global_budget_are_rejected(self):
        with tempfile.TemporaryDirectory() as path:
            for ledger_patch, revision_patch in [
                ({"chargedBytes": 0}, {}), ({"remainingBytes": 0}, {}),
                ({"globalLimitBytes": 20 * 1024**3, "chargedBytes": 19 * 1024**3, "remainingBytes": 1024**3},
                 {"previousChargedBytes": 19 * 1024**3})]:
                values = fixture(Path(path))
                values[3].update(ledger_patch)
                values[0].update(revision_patch)
                with self.assertRaisesRegex(revision.RevisionError, "REVISION_INVALID"):
                    validate(values)

    def test_fixed_asset_policy_claim_prevents_second_attempt_even_with_another_output_directory(self):
        with tempfile.TemporaryDirectory() as path:
            values = fixture(Path(path))
            plan = validate(values)
            claim = revision.claim_revision(values[0], plan)
            self.assertTrue(claim.is_file())
            before = claim.read_bytes()
            second = copy.deepcopy(values)
            second[0]["outputDirectory"] = str(Path(path) / "another-output")
            second[0]["revisionId"] = "f682fc3f-6b0e-4084-9154-30350149ed21"
            with self.assertRaisesRegex(revision.RevisionError, "REVISION_ATTEMPT_ALREADY_CLAIMED"):
                revision.claim_revision(second[0], validate(second))
            self.assertEqual(claim.read_bytes(), before)
            self.assertEqual(claim.stat().st_mode & 0o777, 0o600)

    def test_manifest_wide_claim_rejects_another_asset_using_the_same_old_global_debit(self):
        with tempfile.TemporaryDirectory() as path:
            first = fixture(Path(path))
            claim = revision.claim_revision(first[0], validate(first))
            old_claim = claim.read_bytes()
            second = copy.deepcopy(first)
            other = next(a for a in second[1]["assets"] if a["selected"] and a["assetId"] != first[0]["assetId"])
            second[0].update({"assetId": other["assetId"], "outputDirectory": str(Path(path) / "other-asset"),
                "revisionId": "f682fc3f-6b0e-4084-9154-30350149ed21"})
            second[2].update({"assetId": other["assetId"], "source": copy.deepcopy(other["source"])})
            with self.assertRaisesRegex(revision.RevisionError, "REVISION_ATTEMPT_ALREADY_CLAIMED"):
                revision.claim_revision(second[0], validate(second))
            self.assertEqual(claim.read_bytes(), old_claim)

    def test_worker_new_limits_require_explicit_validated_revision_identity(self):
        normal = {"limitBytes": 2 * 1024**3, "deadlineSeconds": 600}
        self.assertEqual(revision.materialize_policy(normal), {"cacheBlockBytes": 1024**2, "cacheCapacityBytes": 8 * 1024**2})
        for bad in [{**normal, "deadlineSeconds": 900}, {**normal, "limitBytes": 6 * 1024**3},
                    {**normal, "cacheBlockBytes": 8 * 1024**2}]:
            with self.assertRaisesRegex(revision.RevisionError, "MATERIALIZE_LIMIT_INVALID"):
                revision.materialize_policy(bad)
        current = {"limitBytes": 6 * 1024**3, "deadlineSeconds": 900, "cacheBlockBytes": 8 * 1024**2,
            "cacheCapacityBytes": 32 * 1024**2,
            "budgetRevision": {"version": "clip-quality-materialize-revision-v2", "sha256": "f" * 64}}
        self.assertEqual(revision.materialize_policy(current)["cacheCapacityBytes"], 32 * 1024**2)
        for change in [{"deadlineSeconds": 901}, {"limitBytes": 6 * 1024**3 + 1},
                       {"cacheBlockBytes": 4 * 1024**2}, {"budgetRevision": {"version": "unknown", "sha256": "f" * 64}}]:
            with self.assertRaisesRegex(revision.RevisionError, "MATERIALIZE_LIMIT_INVALID"):
                revision.materialize_policy({**current, **change})


if __name__ == "__main__":
    unittest.main()
