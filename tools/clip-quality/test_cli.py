import json
from pathlib import Path
import tempfile
import unittest

import clip_quality
import corpus
from test_corpus import build


class CliTests(unittest.TestCase):
    def test_regular_probe_and_materialize_interrupt_save_full_debit_and_never_start_next_asset(self):
        from unittest.mock import patch
        from contextlib import redirect_stdout
        import io
        for command, limit, cancel_after in (("probe", 64 * 1024**2, 0), ("probe", 64 * 1024**2, 1),
            ("materialize", 2 * 1024**3, 0), ("materialize", 2 * 1024**3, 1)):
            with self.subTest(command=command, cancel_after=cancel_after), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                manifest = build()
                selected = [a for a in manifest["assets"] if a["selected"]]
                self.assertGreaterEqual(len(selected), 2)
                manifest_path, output, probes = root / "manifest.json", root / "out", root / "probes"
                manifest_path.write_text(json.dumps(manifest))
                for asset in selected:
                    target = probes / asset["assetId"]
                    target.mkdir(parents=True)
                    (target / "probe.json").write_text(json.dumps({"ok": True, "assetId": asset["assetId"],
                        "source": asset["source"], "result": {"metadata": {"assessment": "VIDEO_PRESENT"}}}))
                args = [command, "--manifest", str(manifest_path), "--out-dir", str(output)]
                if command == "materialize": args += ["--probes-dir", str(probes)]
                tools = {"operatorCodeSha256": "f" * 64}
                with patch("clip_quality._tools", return_value=tools), \
                    patch("clip_quality._operator_code_hash", return_value="f" * 64), \
                    patch("clip_quality.run_isolated", side_effect=[{"ok": True, "cleanupConfirmed": True,
                        "result": {"readProof": {"reservedBytes": 17}}}] * cancel_after + [KeyboardInterrupt()]) as worker, \
                    redirect_stdout(io.StringIO()):
                    try:
                        status = clip_quality.main(args)
                    except KeyboardInterrupt:
                        self.fail("interrupted ordinary batch must save its conservative receipt before returning")
                self.assertEqual(status, 2)
                self.assertEqual(worker.call_count, 1 + cancel_after)
                receipt = json.loads((output / selected[cancel_after]["assetId"] / (command + ".json")).read_text())
                self.assertEqual(receipt["error"], "OPERATION_INTERRUPTED")
                self.assertFalse(receipt["cleanupConfirmed"])
                self.assertFalse(receipt["byteCountComplete"])
                self.assertEqual(receipt["chargedBytes"], limit)
                batch = json.loads((output / "batch-result.json").read_text())
                self.assertEqual(batch["chargedBytes"], limit + 17 * cancel_after)
                self.assertEqual(len(batch["outcomes"]), 1 + cancel_after)
                self.assertTrue(batch["interrupted"])
                self.assertEqual(batch["notStartedAssetCount"], len(selected) - 1 - cancel_after)
                self.assertFalse((output / selected[cancel_after + 1]["assetId"]).exists())

    def test_launched_operation_without_complete_proof_never_resets_charged_quota_to_zero(self):
        self.assertEqual(clip_quality.operation_charge({"ok": False, "error": "OPERATION_FAILED"}, 100, True), 100)
        self.assertEqual(clip_quality.operation_charge({"ok": False, "error": "SOURCE_PROBE_NOT_BOUND"}, 100, False), 0)
        self.assertEqual(clip_quality.operation_charge({"result": {"readProof": {"reservedBytes": 40}}}, 100, True), 40)
    def test_one_explicit_large_asset_override_preserves_other_limits_and_total_budget(self):
        gib = 1024 ** 3
        override = {"asset-one": {"limitBytes": 4 * gib, "reason": "Explicit operator budget for high bitrate reference"}}
        self.assertEqual(clip_quality.asset_read_limit("asset-one", 2 * gib, override, 12 * gib), 4 * gib)
        self.assertEqual(clip_quality.asset_read_limit("asset-two", 2 * gib, override, 12 * gib), 2 * gib)
        self.assertEqual(clip_quality.asset_read_limit("asset-one", 2 * gib, override, gib), gib)
        with self.assertRaisesRegex(clip_quality.OperationError, "ASSET_READ_LIMIT_INVALID"):
            clip_quality.asset_read_limit("asset-one", 2 * gib, {"asset-one": {"limitBytes": 5 * gib, "reason": "too large"}}, 12 * gib)
    def test_forged_asset_path_or_unbound_source_identity_is_refused_before_io(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            manifest = build()
            manifest["assets"][0]["assetId"] = "../../escape"
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(corpus.CorpusError, "MANIFEST_ASSET_INVALID"):
                clip_quality._manifest(path)
            manifest = build()
            manifest["assets"][0]["source"]["key"] = "different-object.mp4"
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(corpus.CorpusError, "MANIFEST_ASSET_INVALID"):
                clip_quality._manifest(path)

    def test_offline_finalization_rejects_unbound_receipt_before_tools_or_processes(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = build()
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(manifest))
            receipt_path, probe_path = root / "materialize.json", root / "probe.json"
            receipt_path.write_text(json.dumps({"ok": False, "error": "OUTPUT_VALIDATION_FAILED",
                "assetId": manifest["assets"][0]["assetId"], "source": manifest["assets"][0]["source"],
                "corpusId": manifest["corpusId"], "manifestSha256": "0" * 64}))
            probe_path.write_text("{}")
            with patch("clip_quality._tools") as tools, patch("clip_quality.run_isolated") as isolated:
                with self.assertRaisesRegex(clip_quality.OperationError, "PARTIAL_REUSE_NOT_BOUND"):
                    clip_quality.main(["finalize", "--manifest", str(manifest_path), "--source-receipt", str(receipt_path),
                        "--source-probe", str(probe_path), "--partial", str(root / "excerpt.partial.mp4"),
                        "--partial-sha256", "0" * 64, "--out-dir", str(root / "new")])
                tools.assert_not_called()
                isolated.assert_not_called()

    def test_offline_finalization_writes_new_zero_network_receipt_without_changing_failure(self):
        from unittest.mock import patch
        from contextlib import redirect_stdout
        import io
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = build()
            asset = next(a for a in manifest["assets"] if a["selected"])
            manifest_path, receipt_path, probe_path = root / "manifest.json", root / "materialize.json", root / "probe.json"
            manifest_path.write_text(json.dumps(manifest))
            probe = {"ok": True, "assetId": asset["assetId"], "source": asset["source"],
                "result": {"metadata": {"assessment": "VIDEO_PRESENT", "format": {"duration": "180"},
                    "streams": [{"codec_type": "video", "color_transfer": "bt709"}]}}}
            probe_path.write_text(json.dumps(probe))
            receipt = {"ok": False, "error": "OUTPUT_VALIDATION_FAILED", "cleanupConfirmed": True,
                "assetId": asset["assetId"], "source": asset["source"], "corpusId": manifest["corpusId"],
                "workId": asset["workId"], "split": asset["split"],
                "manifestSha256": clip_quality._sha(manifest_path), "sourceProbeSha256": clip_quality._sha(probe_path),
                "toolIdentity": {"operatorCodeSha256": "a" * 64},
                "result": {"nativeReturnCode": 0, "readProof": {"byteCountComplete": True, "failureCode": None}}}
            receipt_path.write_text(json.dumps(receipt))
            original_bytes = receipt_path.read_bytes()
            partial = root / "excerpt.partial.mp4"
            partial.write_bytes(b"synthetic complete private proxy")
            output = root / "new-artifact"
            with patch("clip_quality._tools", return_value={"operatorCodeSha256": "b" * 64}) as tools, \
                patch("clip_quality.run_isolated", return_value={"ok": True, "error": None, "cleanupConfirmed": True,
                    "result": {"networkOperations": 0, "originalFailurePreserved": True}}) as isolated, redirect_stdout(io.StringIO()):
                result = clip_quality.main(["finalize", "--manifest", str(manifest_path), "--source-receipt", str(receipt_path),
                    "--source-probe", str(probe_path), "--partial", str(partial),
                    "--partial-sha256", clip_quality._sha(partial), "--out-dir", str(output)])
            self.assertEqual(result, 0)
            tools.assert_called_once_with(include_aws=False)
            self.assertEqual(isolated.call_args.args[1]["partialSha256"], clip_quality._sha(partial))
            saved = json.loads((output / "finalize.json").read_text())
            self.assertEqual(saved["chargedBytes"], 0)
            self.assertTrue(saved["lineage"]["originalFailurePreserved"])
            self.assertEqual(saved["lineage"]["sourceOperationReceiptSha256"], clip_quality._sha(receipt_path))
            self.assertEqual(receipt_path.read_bytes(), original_bytes)
            self.assertEqual(partial.read_bytes(), b"synthetic complete private proxy")

    def test_single_revision_failed_attempt_stays_claimed_and_missing_proof_debits_full_six_gib(self):
        from unittest.mock import patch
        from contextlib import redirect_stdout
        from test_materialize_revision import fixture
        import io
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            value, manifest, probe, ledger = fixture(root)
            probe["result"]["metadata"].update({"format": {"duration": "600"}, "streams": [{"codec_type": "video"}]})
            for key, document in [("manifestPath", manifest), ("probePath", probe), ("priorLedgerPath", ledger)]:
                path = Path(value[key]); path.write_text(json.dumps(document)); path.chmod(0o600)
            value["manifestSha256"] = clip_quality._sha(value["manifestPath"])
            value["probeSha256"] = clip_quality._sha(value["probePath"])
            value["priorLedgerSha256"] = clip_quality._sha(value["priorLedgerPath"])
            value["recipeHash"] = corpus.digest(clip_quality.excerpt_recipe(probe["result"]["metadata"]))
            revision_path = root / "revision.json"
            revision_path.write_text(json.dumps(value)); revision_path.chmod(0o600)
            with patch("clip_quality._tools", return_value={"operatorCodeSha256": "f" * 64}) as tools, \
                patch("clip_quality.run_isolated", return_value={"ok": False, "error": "MATERIALIZE_FAILED",
                    "cleanupConfirmed": True, "byteCountComplete": False}) as worker, redirect_stdout(io.StringIO()):
                status = clip_quality.main(["materialize-revision", "--revision-file", str(revision_path)])
                self.assertEqual(status, 2)
                payload = worker.call_args.args[1]
                self.assertEqual(payload["deadlineSeconds"], 900)
                self.assertEqual(payload["limitBytes"], 6 * 1024**3)
                self.assertEqual(payload["cacheBlockBytes"], 8 * 1024**2)
                receipt = json.loads((Path(value["outputDirectory"]) / "materialize.json").read_text())
                self.assertEqual(receipt["chargedBytes"], 6 * 1024**3)
                self.assertEqual(receipt["budgetAccounting"]["previousChargedBytes"], 11350494474)
                self.assertEqual(receipt["budgetAccounting"]["cumulativeChargedBytes"], 17792945418)
                self.assertEqual(receipt["budgetAccounting"]["remainingGlobalBytes"], 3681891062)
                claim = Path(receipt["budgetAccounting"]["claimPath"])
                original_claim = claim.read_bytes()
                value["outputDirectory"] = str(root / "another-output")
                revision_path.write_text(json.dumps(value))
                with self.assertRaisesRegex(clip_quality.RevisionError, "REVISION_ATTEMPT_ALREADY_CLAIMED"):
                    clip_quality.main(["materialize-revision", "--revision-file", str(revision_path)])
                self.assertEqual(worker.call_count, 1)
                self.assertEqual(tools.call_count, 1)
                self.assertEqual(claim.read_bytes(), original_claim)
                other = next(a for a in manifest["assets"] if a["selected"] and a["assetId"] != value["assetId"])
                other_probe = {**probe, "assetId": other["assetId"], "source": dict(other["source"])}
                other_probe_path = root / "other-probe.json"
                other_probe_path.write_text(json.dumps(other_probe)); other_probe_path.chmod(0o600)
                value.update({"assetId": other["assetId"], "probePath": str(other_probe_path),
                    "probeSha256": clip_quality._sha(other_probe_path), "outputDirectory": str(root / "other-asset-output"),
                    "revisionId": "f682fc3f-6b0e-4084-9154-30350149ed21"})
                revision_path.write_text(json.dumps(value))
                with self.assertRaisesRegex(clip_quality.RevisionError, "REVISION_ATTEMPT_ALREADY_CLAIMED"):
                    clip_quality.main(["materialize-revision", "--revision-file", str(revision_path)])
                self.assertEqual(worker.call_count, 1)
                self.assertEqual(tools.call_count, 1)
                self.assertEqual(claim.read_bytes(), original_claim)

    def test_revision_preflight_hash_failure_never_launches_or_claims_an_attempt(self):
        from unittest.mock import patch
        from test_materialize_revision import fixture
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            value, manifest, probe, ledger = fixture(root)
            probe["result"]["metadata"].update({"format": {"duration": "600"}, "streams": [{"codec_type": "video"}]})
            for key, document in [("manifestPath", manifest), ("probePath", probe), ("priorLedgerPath", ledger)]:
                path = Path(value[key]); path.write_text(json.dumps(document)); path.chmod(0o600)
            revision_path = root / "revision.json"
            revision_path.write_text(json.dumps(value)); revision_path.chmod(0o600)
            with patch("clip_quality._tools") as tools, patch("clip_quality.run_isolated") as worker:
                with self.assertRaisesRegex(clip_quality.RevisionError, "REVISION_INVALID"):
                    clip_quality.main(["materialize-revision", "--revision-file", str(revision_path)])
                tools.assert_not_called(); worker.assert_not_called()
            self.assertFalse((root / ".materialize-revision-claims").exists())

    def test_interrupted_revision_keeps_claim_and_saves_unknown_cleanup_with_full_debit(self):
        from unittest.mock import patch
        from contextlib import redirect_stdout
        from test_materialize_revision import fixture
        import io
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            value, manifest, probe, ledger = fixture(root)
            probe["result"]["metadata"].update({"format": {"duration": "600"}, "streams": [{"codec_type": "video"}]})
            for key, document in [("manifestPath", manifest), ("probePath", probe), ("priorLedgerPath", ledger)]:
                path = Path(value[key]); path.write_text(json.dumps(document)); path.chmod(0o600)
            value["manifestSha256"] = clip_quality._sha(value["manifestPath"])
            value["probeSha256"] = clip_quality._sha(value["probePath"])
            value["priorLedgerSha256"] = clip_quality._sha(value["priorLedgerPath"])
            value["recipeHash"] = corpus.digest(clip_quality.excerpt_recipe(probe["result"]["metadata"]))
            revision_path = root / "revision.json"
            revision_path.write_text(json.dumps(value)); revision_path.chmod(0o600)
            with patch("clip_quality._tools", return_value={"operatorCodeSha256": "f" * 64}), \
                patch("clip_quality.run_isolated", side_effect=KeyboardInterrupt()), redirect_stdout(io.StringIO()):
                status = clip_quality.main(["materialize-revision", "--revision-file", str(revision_path)])
            self.assertEqual(status, 2)
            receipt = json.loads((Path(value["outputDirectory"]) / "materialize.json").read_text())
            self.assertEqual(receipt["error"], "OPERATION_INTERRUPTED")
            self.assertFalse(receipt["cleanupConfirmed"])
            self.assertFalse(receipt["byteCountComplete"])
            self.assertEqual(receipt["chargedBytes"], 6 * 1024**3)
            self.assertTrue(Path(receipt["budgetAccounting"]["claimPath"]).exists())

    def test_public_cli_summary_does_not_print_private_source_or_native_exception_content(self):
        from contextlib import redirect_stdout
        import io
        manifest = build()
        stream = io.StringIO()
        with redirect_stdout(stream):
            clip_quality._print_alias_summary(manifest["assets"][0], {"ok": False, "error": "FFPROBE_FAILED", "cleanupConfirmed": True})
        self.assertNotIn("private/", stream.getvalue())
        self.assertNotIn("Story_A", stream.getvalue())


if __name__ == "__main__":
    unittest.main()
