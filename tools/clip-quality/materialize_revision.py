"""Explicit private single-attempt revision; ordinary/probe policies stay unchanged."""
from __future__ import annotations

import datetime
import math
from pathlib import Path
import re
import uuid

from corpus import CorpusError, REPOSITORY_ROOT, digest, private_write_json

VERSION = "clip-quality-materialize-revision-v2"
GIB, MIB = 1024**3, 1024**2
FIELDS = {"schemaVersion", "revisionId", "assetId", "manifestPath", "manifestSha256", "probePath", "probeSha256",
    "priorLedgerPath", "priorLedgerSha256", "previousChargedBytes", "globalLimitBytes", "perAssetLimitBytes",
    "deadlineSeconds", "cacheBlockBytes", "cacheCapacityBytes", "maximumAdditionalAttempts", "outputDirectory",
    "recipeHash", "requestedDurationUs", "reason"}
SHA = re.compile(r"^[a-f0-9]{64}$")


class RevisionError(ValueError):
    pass


def _require(value):
    if not value:
        raise RevisionError("REVISION_INVALID")


def validate_revision(value, manifest, probe, ledger, *, manifest_sha256, probe_sha256, ledger_sha256,
                      recipe_hash, recipe_duration_us):
    try:
        _require(isinstance(value, dict) and set(value) == FIELDS and value["schemaVersion"] == VERSION)
        _require(str(uuid.UUID(value["revisionId"])) == value["revisionId"])
        _require(isinstance(value["reason"], str) and 1 <= len(value["reason"]) <= 400)
        for key in ("manifestPath", "probePath", "priorLedgerPath", "outputDirectory"):
            path = value[key]
            _require(isinstance(path, str) and Path(path).is_absolute() and not any(ord(c) < 32 for c in path)
                     and not Path(path).resolve().is_relative_to(REPOSITORY_ROOT))
        for key, expected in (("manifestSha256", manifest_sha256), ("probeSha256", probe_sha256),
                              ("priorLedgerSha256", ledger_sha256), ("recipeHash", recipe_hash)):
            _require(isinstance(value[key], str) and SHA.fullmatch(value[key]) and value[key] == expected)
        _require(re.fullmatch(r"asset-[a-f0-9]{24}", value["assetId"]) is not None)
        asset = next((a for a in manifest["assets"] if a["assetId"] == value["assetId"]), None)
        _require(asset is not None and asset["selected"] and probe["ok"] is True
                 and probe["assetId"] == asset["assetId"] and probe["source"] == asset["source"]
                 and probe["result"]["metadata"]["assessment"] == "VIDEO_PRESENT")
        _require(ledger["schemaVersion"].startswith("clip-quality-cumulative-read-ledger-v"))
        charged, remaining, old_limit = ledger["chargedBytes"], ledger["remainingBytes"], ledger["globalLimitBytes"]
        _require(all(type(x) is int for x in (charged, remaining, old_limit)) and charged >= 0 and remaining >= 0
                 and charged + remaining == old_limit)
        _require(type(value["previousChargedBytes"]) is int and value["previousChargedBytes"] == charged)
        fixed = {"globalLimitBytes": 20 * GIB, "perAssetLimitBytes": 6 * GIB, "deadlineSeconds": 900,
            "cacheBlockBytes": 8 * MIB, "cacheCapacityBytes": 32 * MIB, "maximumAdditionalAttempts": 1,
            "requestedDurationUs": 180000000}
        _require(all(type(value[k]) is int and value[k] == expected for k, expected in fixed.items()))
        _require(recipe_duration_us == 180000000 and charged + value["perAssetLimitBytes"] <= value["globalLimitBytes"])
        return {"previousChargedBytes": charged, "remainingGlobalBytes": value["globalLimitBytes"] - charged,
            "limitBytes": value["perAssetLimitBytes"], "deadlineSeconds": value["deadlineSeconds"],
            "cacheBlockBytes": value["cacheBlockBytes"], "cacheCapacityBytes": value["cacheCapacityBytes"],
            "budgetRevision": {"version": VERSION, "sha256": digest(value)}}
    except (ValueError, TypeError, KeyError, StopIteration, AttributeError):
        raise RevisionError("REVISION_INVALID") from None


def revision_claim_path(value):
    scope = digest({"manifestSha256": value["manifestSha256"], "policy": VERSION})[:24]
    return Path(value["manifestPath"]).resolve().parent / ".materialize-revision-claims" / (scope + "-v2.json")


def claim_revision(value, plan):
    # One additional attempt for the entire manifest/policy, across every asset/output/UUID.
    path = revision_claim_path(value)
    claim = {"version": VERSION, "manifestSha256": value["manifestSha256"],
        "assetId": value["assetId"], "revisionSha256": digest(value),
        "revisionId": value["revisionId"], "priorLedgerSha256": value["priorLedgerSha256"],
        "previousChargedBytes": plan["previousChargedBytes"], "reservedMaximumBytes": plan["limitBytes"],
        "outputDirectory": value["outputDirectory"], "maximumAdditionalAttempts": 1,
        "claimedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "failureOrCancellationConsumesAttempt": True}
    try:
        private_write_json(path, claim)
    except CorpusError as error:
        raise RevisionError("REVISION_ATTEMPT_ALREADY_CLAIMED" if str(error) == "OUTPUT_EXISTS" else "REVISION_CLAIM_FAILED") from None
    return path


def materialize_policy(payload):
    identity = payload.get("budgetRevision")
    revised = (isinstance(identity, dict) and set(identity) == {"version", "sha256"}
        and identity["version"] == VERSION and isinstance(identity["sha256"], str) and SHA.fullmatch(identity["sha256"]))
    if identity is not None and not revised:
        raise RevisionError("MATERIALIZE_LIMIT_INVALID")
    block, capacity = (8 * MIB, 32 * MIB) if revised else (MIB, 8 * MIB)
    limit, deadline = payload.get("limitBytes"), payload.get("deadlineSeconds")
    if (type(limit) is not int or not 0 < limit <= (6 * GIB if revised else 4 * GIB)
        or type(deadline) not in (int, float) or not math.isfinite(deadline) or not 0 < deadline <= (900 if revised else 600)
        or payload.get("cacheBlockBytes", block) != block or payload.get("cacheCapacityBytes", capacity) != capacity):
        raise RevisionError("MATERIALIZE_LIMIT_INVALID")
    return {"cacheBlockBytes": block, "cacheCapacityBytes": capacity}
