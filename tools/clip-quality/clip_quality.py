#!/usr/bin/env python3
"""Operator CLI. Customer inventories, media, URLs and transcripts stay private."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

from corpus import CorpusError, REPOSITORY_ROOT, build_corpus, digest, private_write_json, public_summary
from execution import OperationError, excerpt_recipe, materialize_worker, probe_worker, run_isolated
from finalization import finalize_worker, validate_partial_reuse
from materialize_revision import FIELDS as REVISION_FIELDS, RevisionError, claim_revision, validate_revision


def _json(path):
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise CorpusError("JSON_OBJECT_REQUIRED")
    return value


def _sha(path):
    sha = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def _tools(*, include_aws=True):
    versions = {}
    for tool in (("ffprobe", "ffmpeg", "aws") if include_aws else ("ffprobe", "ffmpeg")):
        path = shutil.which(tool)
        if not path:
            raise OperationError("LOCAL_TOOL_UNAVAILABLE")
        version = subprocess.run([path, "--version" if tool == "aws" else "-version"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=False)
        text = (version.stdout or version.stderr).decode("utf-8", errors="replace").splitlines()
        if version.returncode or not text:
            raise OperationError("LOCAL_TOOL_UNAVAILABLE")
        versions[tool] = {"version": text[0][:300], "binarySha256": _sha(path)}
    versions["operatorCodeSha256"] = _operator_code_hash()
    return versions


def _operator_code_hash():
    return digest({path.name: _sha(path) for path in sorted(Path(__file__).parent.glob("*.py")) if not path.name.startswith("test_")})


def asset_read_limit(asset_id, default, overrides, remaining):
    override = overrides.get(asset_id)
    limit = default
    if override:
        limit = override.get("limitBytes")
        if not isinstance(override.get("reason"), str) or not 1 <= len(override["reason"]) <= 300:
            raise OperationError("ASSET_READ_LIMIT_INVALID")
    if type(limit) is not int or not 0 < limit <= 4 * 1024 ** 3:
        raise OperationError("ASSET_READ_LIMIT_INVALID")
    return min(limit, remaining)


def operation_charge(outcome, limit, launched):
    proof = (outcome.get("result") or {}).get("readProof")
    if proof:
        reserved = proof.get("reservedBytes")
        if type(reserved) is not int or not 0 <= reserved <= limit:
            raise OperationError("READ_PROOF_INVALID")
        return reserved
    return limit if launched else 0


def _directory(path, intent):
    path = Path(path).absolute()
    if path.exists() or path.is_symlink() or path.resolve().is_relative_to(REPOSITORY_ROOT):
        raise CorpusError("OUTPUT_DIRECTORY_UNSAFE_OR_EXISTS")
    private_write_json(path / "intent.json", intent)
    return path


def _manifest(path, *, document=None):
    value = _json(path) if document is None else document
    if value.get("schemaVersion") != "clip-quality-corpus-v1":
        raise CorpusError("MANIFEST_INVALID")
    seen = set()
    for asset in value.get("assets", []):
        source = asset.get("source", {})
        alias = asset.get("assetId", "")
        if (not isinstance(alias, str) or not re.fullmatch(r"asset-[a-f0-9]{24}", alias)
            or alias in seen or alias != "asset-" + digest(source)[:24]
            or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", source.get("bucket", ""))
            or not re.fullmatch(r"[a-z]{2}-[a-z]+-\d", source.get("region", ""))
            or not isinstance(source.get("key"), str) or any(ord(c) < 32 for c in source["key"])
            or not isinstance(source.get("etag"), str) or any(ord(c) < 32 for c in source["etag"])
            or type(source.get("sizeBytes")) is not int or source["sizeBytes"] < 0):
            raise CorpusError("MANIFEST_ASSET_INVALID")
        seen.add(alias)
    return value


def _selected(manifest, selection_file):
    if selection_file:
        chosen = _json(selection_file).get("assetIds")
        if not isinstance(chosen, list) or not chosen or len(chosen) != len(set(chosen)):
            raise CorpusError("ASSET_SELECTION_INVALID")
        known = {asset["assetId"] for asset in manifest["assets"]}
        if not set(chosen) <= known:
            raise CorpusError("ASSET_SELECTION_INVALID")
        by_id = {asset["assetId"]: asset for asset in manifest["assets"]}
        return [by_id[alias] for alias in chosen]
    return [asset for asset in manifest["assets"] if asset["selected"]]


def _print_alias_summary(asset, outcome):
    result = outcome.get("result") or {}
    proof = result.get("readProof") or {}
    metadata = result.get("metadata") or {}
    summary = {"assetId": asset["assetId"], "ok": outcome.get("ok", False), "error": outcome.get("error"),
        "assessment": metadata.get("assessment"), "receivedBytes": proof.get("receivedBytes"),
        "elapsedMs": result.get("elapsedMs"), "cleanupConfirmed": outcome.get("cleanupConfirmed", False)}
    print(json.dumps(summary), flush=True)


def _finalize(args):
    if not 0 < args.deadline_seconds <= 600:
        raise OperationError("OPERATION_LIMIT_INVALID")
    manifest = _manifest(args.manifest)
    operation, probe = _json(args.source_receipt), _json(args.source_probe)
    asset = next((a for a in manifest["assets"] if a["assetId"] == operation.get("assetId")), None)
    partial = Path(args.partial).absolute()
    source_receipt = Path(args.source_receipt).absolute()
    if (not asset or not asset["selected"] or operation.get("source") != asset["source"]
        or operation.get("corpusId") != manifest["corpusId"] or operation.get("manifestSha256") != _sha(args.manifest)
        or operation.get("workId") != asset["workId"] or operation.get("split") != asset["split"]
        or partial.parent.resolve() != source_receipt.parent.resolve()):
        raise OperationError("PARTIAL_REUSE_NOT_BOUND")
    validate_partial_reuse(operation, probe, _sha(args.source_probe), partial, args.partial_sha256)
    tools = _tools(include_aws=False)
    original_receipt_sha = _sha(source_receipt)
    source_recipe = excerpt_recipe(probe["result"]["metadata"])
    lineage = {"sourceOperationReceiptSha256": original_receipt_sha, "sourcePartialSha256": args.partial_sha256,
        "sourceProbeSha256": _sha(args.source_probe), "sourceOperatorCodeSha256": operation["toolIdentity"]["operatorCodeSha256"],
        "sourceRecipe": source_recipe, "sourceRecipeReconstruction": "PINNED_PROBE_AND_UNCHANGED_V1_TRANSFORM_RULE",
        "sourceOffsetUs": source_recipe["sourceOffsetUs"], "originalFailurePreserved": True,
        "originalClockProof": "REQUESTED_SEEK_NOT_EXACT_FRAME_MAPPING", "networkOperations": 0}
    root = _directory(args.out_dir, {"operation": "finalize", "corpusId": manifest["corpusId"],
        "assetId": asset["assetId"], "lineage": lineage, "tools": tools, "deadlineSeconds": args.deadline_seconds})
    outcome = run_isolated(finalize_worker, {"partial": str(partial), "partialSha256": args.partial_sha256,
        "sourceMetadata": probe["result"]["metadata"], "outputDirectory": str(root), "deadlineSeconds": args.deadline_seconds},
        timeout_seconds=args.deadline_seconds)
    if _sha(source_receipt) != original_receipt_sha or _sha(args.source_probe) != lineage["sourceProbeSha256"]:
        outcome = {"ok": False, "error": "ORIGINAL_RECEIPT_CHANGED_DURING_FINALIZATION",
            "cleanupConfirmed": outcome.get("cleanupConfirmed", False)}
    receipt = {"schemaVersion": "clip-quality-offline-finalization-v2", "corpusId": manifest["corpusId"],
        "manifestSha256": _sha(args.manifest), "assetId": asset["assetId"], "workId": asset["workId"], "split": asset["split"],
        "source": asset["source"], "lineage": lineage, "toolIdentity": tools, "chargedBytes": 0, **outcome}
    private_write_json(root / "finalize.json", receipt)
    _print_alias_summary(asset, outcome)
    return 0 if outcome.get("ok") else 2


def _revision_json(path, maximum=2 * 1024**2):
    path = Path(path)
    try:
        if (not path.is_absolute() or path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid()
            or path.stat().st_mode & 0o077 or not 0 < path.stat().st_size <= maximum
            or path.resolve().is_relative_to(REPOSITORY_ROOT)):
            raise RevisionError("REVISION_INVALID")
        raw = path.read_bytes()
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise RevisionError("REVISION_INVALID")
        return value, hashlib.sha256(raw).hexdigest()
    except (OSError, ValueError, TypeError):
        raise RevisionError("REVISION_INVALID") from None


def _materialize_revision(args):
    value, revision_file_sha = _revision_json(args.revision_file, 65536)
    if set(value) != REVISION_FIELDS:
        raise RevisionError("REVISION_INVALID")
    raw_manifest, manifest_sha = _revision_json(value["manifestPath"])
    manifest = _manifest(value["manifestPath"], document=raw_manifest)
    probe, probe_sha = _revision_json(value["probePath"])
    ledger, ledger_sha = _revision_json(value["priorLedgerPath"])
    recipe = excerpt_recipe((probe.get("result") or {}).get("metadata") or {})
    plan = validate_revision(value, manifest, probe, ledger, manifest_sha256=manifest_sha, probe_sha256=probe_sha,
        ledger_sha256=ledger_sha, recipe_hash=digest(recipe), recipe_duration_us=recipe["requestedDurationUs"])
    output = Path(value["outputDirectory"])
    if output.exists() or output.is_symlink():
        raise RevisionError("REVISION_OUTPUT_EXISTS")
    # A failed/aborted operation never removes this fixed asset+policy claim.
    claim = claim_revision(value, plan)
    tools = _tools()
    root = _directory(output, {"operation": "materialize-revision", "corpusId": manifest["corpusId"],
        "assetId": value["assetId"], "revision": value, "revisionFileSha256": revision_file_sha,
        "claimPath": str(claim), "tools": tools})
    asset = next(a for a in manifest["assets"] if a["assetId"] == value["assetId"])
    payload = {**plan, "assetId": asset["assetId"], "source": asset["source"], "metadata": probe["result"]["metadata"],
        "sourceProbeSha256": probe_sha, "toolIdentity": tools, "outputDirectory": str(root)}
    try:
        outcome = run_isolated(materialize_worker, payload, timeout_seconds=plan["deadlineSeconds"])
    except KeyboardInterrupt:
        # Cleanup was attempted by run_isolated; no returned proof can establish completion here.
        outcome = {"ok": False, "error": "OPERATION_INTERRUPTED", "cleanupConfirmed": False, "byteCountComplete": False}
    inputs = [(args.revision_file, revision_file_sha), (value["manifestPath"], manifest_sha),
        (value["probePath"], probe_sha), (value["priorLedgerPath"], ledger_sha)]
    try:
        unchanged = all(_sha(path) == expected for path, expected in inputs)
    except OSError:
        unchanged = False
    if not unchanged:
        outcome = {**outcome, "ok": False, "error": "REVISION_INPUT_CHANGED_DURING_OPERATION"}
    try:
        charged = operation_charge(outcome, plan["limitBytes"], True)
    except OperationError:
        charged = plan["limitBytes"]
        outcome = {**outcome, "ok": False, "error": "READ_PROOF_INVALID"}
    accounting = {"revisionSha256": digest(value), "revisionFileSha256": revision_file_sha,
        "claimPath": str(claim), "claimSha256": _sha(claim), "maximumAdditionalAttempts": 1,
        "priorLedgerSha256": ledger_sha, "previousChargedBytes": plan["previousChargedBytes"],
        "cumulativeChargedBytes": plan["previousChargedBytes"] + charged, "globalLimitBytes": value["globalLimitBytes"],
        "remainingGlobalBytes": value["globalLimitBytes"] - plan["previousChargedBytes"] - charged,
        "attemptRemainsClaimedOnFailure": True}
    receipt = {"schemaVersion": "clip-quality-operation-v1", "corpusId": manifest["corpusId"],
        "manifestSha256": manifest_sha, "assetId": asset["assetId"], "workId": asset["workId"], "split": asset["split"],
        "source": asset["source"], "sourceProbeSha256": probe_sha, "toolIdentity": tools, "chargedBytes": charged,
        "budgetAccounting": accounting, **outcome}
    private_write_json(root / "materialize.json", receipt)
    _print_alias_summary(asset, outcome)
    return 0 if outcome.get("ok") else 2


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description="Private clip-quality corpus/probe/excerpt operator")
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("manifest")
    for name in ("inventory", "work-map", "bucket", "out"):
        build.add_argument("--" + name, required=True)
    build.add_argument("--region", default="ap-northeast-1")
    build.add_argument("--split-seed", required=True)
    build.add_argument("--holdout-count", type=int, required=True)
    build.add_argument("--maximum-works", type=int, default=12)
    for command in ("probe", "materialize"):
        item = commands.add_parser(command)
        item.add_argument("--manifest", required=True)
        item.add_argument("--out-dir", required=True)
        item.add_argument("--selection-file")
        item.add_argument("--limit-bytes", type=int, default=64 * 1024 * 1024 if command == "probe" else 2 * 1024 * 1024 * 1024)
        item.add_argument("--deadline-seconds", type=float, default=45 if command == "probe" else 600)
        if command == "materialize":
            item.add_argument("--probes-dir", required=True)
            item.add_argument("--total-limit-bytes", type=int, default=12 * 1024 * 1024 * 1024)
            item.add_argument("--asset-limits-file")
    finalize = commands.add_parser("finalize", help="Offline, new artifact from an explicitly bound completed private partial")
    for name in ("manifest", "source-receipt", "source-probe", "partial", "partial-sha256", "out-dir"):
        finalize.add_argument("--" + name, required=True)
    finalize.add_argument("--deadline-seconds", type=float, default=600)
    revised = commands.add_parser("materialize-revision", help="One explicitly pinned LIVE budget revision; no implicit retry")
    revised.add_argument("--revision-file", required=True)
    args = parser.parse_args(argv)
    if args.command == "materialize-revision":
        return _materialize_revision(args)
    if args.command == "finalize":
        return _finalize(args)
    if args.command == "manifest":
        inventory, work_map = _json(args.inventory), _json(args.work_map)
        manifest = build_corpus(inventory, work_map, bucket=args.bucket, region=args.region, split_seed=args.split_seed,
            holdout_count=args.holdout_count, maximum_works=args.maximum_works,
            created_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
        manifest["inputArtifactHashes"] = {"inventoryFileSha256": _sha(args.inventory), "workMapFileSha256": _sha(args.work_map)}
        private_write_json(Path(args.out), manifest)
        print(json.dumps(public_summary(manifest)))
        return 0
    probe = args.command == "probe"
    if not (0 < args.limit_bytes <= (64 * 1024 * 1024 if probe else 2 * 1024 * 1024 * 1024)
        and 0 < args.deadline_seconds <= (45 if probe else 600)):
        raise OperationError("OPERATION_LIMIT_INVALID")
    total_limit = args.limit_bytes * 100 if probe else args.total_limit_bytes
    if not probe and not 0 < total_limit <= 12 * 1024 * 1024 * 1024:
        raise OperationError("TOTAL_READ_LIMIT_INVALID")
    manifest = _manifest(args.manifest)
    selected = _selected(manifest, args.selection_file)
    if len(selected) > 100:
        raise OperationError("ASSET_COUNT_LIMIT_INVALID")
    if probe:
        total_limit = args.limit_bytes * len(selected)
    overrides = _json(args.asset_limits_file).get("assetLimits", {}) if not probe and args.asset_limits_file else {}
    if not isinstance(overrides, dict) or not set(overrides) <= {asset["assetId"] for asset in selected}:
        raise OperationError("ASSET_READ_LIMIT_INVALID")
    for alias in overrides:
        asset_read_limit(alias, args.limit_bytes, overrides, total_limit)
    tools = _tools()
    root = _directory(args.out_dir, {"operation": args.command, "corpusId": manifest["corpusId"],
        "manifestSha256": _sha(args.manifest), "limits": {"perAssetBytes": args.limit_bytes,
        "totalBytes": total_limit, "perAssetDeadlineSeconds": args.deadline_seconds, "assetOverrides": overrides}, "tools": tools})
    charged, outcomes, interrupted = 0, [], False
    for asset in selected:
        if _operator_code_hash() != tools["operatorCodeSha256"]:
            raise OperationError("SOURCE_CODE_CHANGED_DURING_BATCH")
        asset_root = _directory(root / asset["assetId"], {"assetId": asset["assetId"], "operation": args.command})
        limit = asset_read_limit(asset["assetId"], args.limit_bytes, overrides, total_limit - charged)
        payload = {"assetId": asset["assetId"], "source": asset["source"], "limitBytes": limit,
            "deadlineSeconds": args.deadline_seconds, "toolIdentity": tools, "outputDirectory": str(asset_root)}
        launched = False
        if limit <= 0:
            outcome = {"ok": False, "error": "TOTAL_READ_BUDGET_EXCEEDED", "cleanupConfirmed": True}
        elif not probe:
            previous = _json(Path(args.probes_dir) / asset["assetId"] / "probe.json")
            metadata = (previous.get("result") or {}).get("metadata")
            if (previous.get("assetId") != asset["assetId"] or previous.get("source") != asset["source"]
                or not previous.get("ok") or not metadata or metadata.get("assessment") != "VIDEO_PRESENT"):
                outcome = {"ok": False, "error": "SOURCE_PROBE_NOT_BOUND", "cleanupConfirmed": True}
            else:
                payload["metadata"] = metadata
                payload["sourceProbeSha256"] = _sha(Path(args.probes_dir) / asset["assetId"] / "probe.json")
                launched = True
        else:
            launched = True
        if launched:
            try:
                outcome = run_isolated(probe_worker if probe else materialize_worker, payload,
                    timeout_seconds=args.deadline_seconds)
            except KeyboardInterrupt:
                # No returned proof means neither byte completion nor cleanup is
                # attestable here. Debit the allocated quota and stop this batch.
                interrupted = True
                outcome = {"ok": False, "error": "OPERATION_INTERRUPTED", "cleanupConfirmed": False,
                    "byteCountComplete": False}
        proof = (outcome.get("result") or {}).get("readProof")
        charged_this = operation_charge(outcome, limit, launched)
        charged += charged_this
        receipt = {"schemaVersion": "clip-quality-operation-v1", "corpusId": manifest["corpusId"],
            "manifestSha256": _sha(args.manifest), "assetId": asset["assetId"], "workId": asset["workId"],
            "split": asset["split"], "source": asset["source"], "toolIdentity": tools,
            "chargedBytes": charged_this, "sourceProbeSha256": payload.get("sourceProbeSha256"), **outcome}
        private_write_json(asset_root / ("probe.json" if probe else "materialize.json"), receipt)
        outcomes.append({"assetId": asset["assetId"], "ok": outcome.get("ok", False), "error": outcome.get("error"), "chargedBytes": charged_this})
        _print_alias_summary(asset, outcome)
        if interrupted:
            break
    private_write_json(root / "batch-result.json", {"corpusId": manifest["corpusId"], "operation": args.command,
        "chargedBytes": charged, "totalLimitBytes": total_limit, "outcomes": outcomes,
        "humanGolden": "PENDING", "externalLlmUsed": False, "interrupted": interrupted,
        "notStartedAssetCount": len(selected) - len(outcomes)})
    return 0 if all(outcome["ok"] for outcome in outcomes) else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (CorpusError, OperationError, RevisionError) as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        raise SystemExit(1)
    except Exception:
        print(json.dumps({"ok": False, "error": "OPERATOR_FAILED"}))
        raise SystemExit(1)
