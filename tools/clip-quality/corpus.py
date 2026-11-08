"""Private evaluation manifests. No customer fixture belongs in this repository."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mxf", ".mkv", ".avi", ".mpg", ".mpeg", ".ts", ".m2ts"}
CATEGORIES = {"ANIMATION", "LIVE_ACTION_FILM", "DRAMA", "TOKUSATSU", "LIVE_PERFORMANCE", "NATURE_4K", "OTHER", "UNKNOWN", "TEST_PATTERN"}
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


class CorpusError(Exception):
    """Fixed diagnostics only: never include a source key, URL, or subprocess text."""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def require(condition, code):
    if not condition:
        raise CorpusError(code)


def private_write_json(path, value, repository_root=REPOSITORY_ROOT):
    path = Path(path).absolute()
    resolved = path.resolve()
    require(not resolved.is_relative_to(Path(repository_root).resolve()), "OUTPUT_IN_REPOSITORY")
    require(not path.exists() and not path.is_symlink(), "OUTPUT_EXISTS")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(path.parent.stat().st_uid == os.getuid(), "OUTPUT_OWNER_MISMATCH")
    path.parent.chmod(0o700)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError:
        raise CorpusError("OUTPUT_CREATE_FAILED") from None
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def resolution_hint(key):
    pairs = re.findall(r"(?:^|[_-])(3840|4096|1920|1280|720)[_-](2160|1080|720|576|480)(?:[_\W]|$)", key)
    if pairs:
        width, height = pairs[-1]
        return {"width": int(width), "height": int(height), "provenance": "FILENAME_HINT"}
    match = re.search(r"(?:^|[_\W])(2160|1080|720|576|480)[pi](?:[_\W]|$)", key, re.I)
    return {"width": None, "height": int(match.group(1)) if match else None, "provenance": "FILENAME_HINT"}


def build_corpus(inventory, work_map, *, bucket, region, split_seed, holdout_count, maximum_works, created_at):
    require(isinstance(bucket, str) and re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket), "BUCKET_INVALID")
    require(isinstance(region, str) and re.fullmatch(r"[a-z]{2}-[a-z]+-\d", region), "REGION_INVALID")
    require(isinstance(split_seed, str) and 1 <= len(split_seed) <= 200, "SPLIT_SEED_INVALID")
    require(type(maximum_works) is int and 1 <= maximum_works <= 100, "WORK_LIMIT_INVALID")
    require(isinstance(inventory, dict) and isinstance(inventory.get("Contents"), list), "INVENTORY_INVALID")
    require(not inventory.get("IsTruncated", False), "INVENTORY_TRUNCATED")
    require(work_map.get("schemaVersion") == "clip-quality-work-map-v1", "WORK_MAP_INVALID")
    source_by_key = {}
    for item in inventory["Contents"]:
        require(isinstance(item, dict) and isinstance(item.get("Key"), str), "INVENTORY_INVALID")
        key = item["Key"]
        require(key not in source_by_key and len(key) <= 4096 and not any(ord(c) < 32 for c in key), "INVENTORY_KEY_INVALID")
        require(type(item.get("Size")) is int and item["Size"] >= 0, "INVENTORY_SIZE_INVALID")
        etag = item.get("ETag")
        require(isinstance(etag, str) and 1 <= len(etag) <= 256 and not any(ord(c) < 32 for c in etag), "INVENTORY_ETAG_INVALID")
        source_by_key[key] = item
    require(len(source_by_key) <= 10000, "INVENTORY_TOO_LARGE")
    assignments, works = {}, []
    seen_work_keys, declared_splits = set(), {}
    for declared in work_map.get("works", []):
        work_key = declared.get("workKey")
        require(isinstance(work_key, str) and 1 <= len(work_key) <= 300 and work_key not in seen_work_keys, "WORK_MAP_INVALID")
        seen_work_keys.add(work_key)
        category = declared.get("category", "UNKNOWN")
        require(category in CATEGORIES and type(declared.get("selected", False)) is bool, "WORK_MAP_INVALID")
        work_id = "work-" + digest({"namespace": "clip-quality-work-v1", "workKey": work_key})[:20]
        if "split" in declared:
            require(declared["split"] in {"DEV", "HOLDOUT"}, "SPLIT_ASSIGNMENT_INVALID")
            declared_splits[work_id] = declared["split"]
        works.append({"workId": work_id, "category": category, "selected": declared.get("selected", False),
            "split": "UNASSIGNED", "groupingProvenance": {"kind": "OPERATOR_FILENAME_METADATA", "humanVideoReview": "PENDING"}})
        for member in declared.get("assets", []):
            key = member.get("key")
            require(key in source_by_key, "WORK_MAP_SOURCE_MISSING")
            require(key not in assignments, "ASSET_WORK_CONFLICT")
            representation = member.get("representation", "ORIGINAL")
            require(representation in {"PROXY", "ORIGINAL", "REFERENCE"}, "REPRESENTATION_INVALID")
            reason = member.get("excludeReason")
            require(reason in {None, "TEST_PATTERN_PURPOSE", "UNSUPPORTED_MEDIA", "OPERATOR_EXCLUDED"}, "EXCLUSION_INVALID")
            assignments[key] = {"workId": work_id, "representation": representation, "excluded": reason}
    selected = [work for work in works if work["selected"]]
    require(1 <= len(selected) <= maximum_works, "SELECTED_WORK_COUNT_INVALID")
    require(type(holdout_count) is int and 0 < holdout_count < len(selected), "HOLDOUT_COUNT_INVALID")
    ordered = sorted(selected, key=lambda work: digest({"seed": split_seed, "workId": work["workId"]}))
    holdout = {work["workId"] for work in ordered[:holdout_count]}
    explicit_splits = any(work["workId"] in declared_splits for work in selected)
    if explicit_splits:
        require(all(work["workId"] in declared_splits for work in selected), "SPLIT_ASSIGNMENT_INCOMPLETE")
        holdout = {work["workId"] for work in selected if declared_splits[work["workId"]] == "HOLDOUT"}
        require(len(holdout) == holdout_count, "HOLDOUT_COUNT_INVALID")
    work_by_id = {work["workId"]: work for work in works}
    for work in selected:
        work["split"] = "HOLDOUT" if work["workId"] in holdout else "DEV"
    assets = []
    for item in inventory["Contents"]:
        key = item["Key"]
        assignment = assignments.get(key)
        work_id = assignment["workId"] if assignment else None
        candidate = PurePosixPath(key).suffix.lower() in VIDEO_EXTENSIONS
        reason = (assignment or {}).get("excluded")
        if not candidate:
            reason = reason or "NON_VIDEO_EXTENSION"
        elif not assignment:
            reason = "WORK_GROUP_UNCONFIRMED"
        elif not work_by_id[work_id]["selected"]:
            reason = reason or "WORK_NOT_SELECTED"
        source = {"bucket": bucket, "region": region, "key": key, "sizeBytes": item["Size"],
            "etag": item["ETag"], "lastModified": item.get("LastModified"), "sha256": None,
            "hashStatus": "WHOLE_SOURCE_NOT_DOWNLOADED"}
        assets.append({"assetId": "asset-" + digest(source)[:24], "workId": work_id,
            "split": work_by_id[work_id]["split"] if work_id else "UNASSIGNED", "source": source,
            "representation": (assignment or {}).get("representation", "UNKNOWN"),
            "resolutionHint": resolution_hint(key), "selected": False,
            "exclusionReason": reason, "mediaAssessment": {"status": "PROBE_PENDING" if candidate else "NOT_VIDEO_CANDIDATE"}})
    for work in selected:
        candidates = [asset for asset in assets if asset["workId"] == work["workId"] and not asset["exclusionReason"]]
        require(bool(candidates), "SELECTED_WORK_HAS_NO_VIDEO_CANDIDATE")
        chosen = min(candidates, key=lambda asset: (
            {"PROXY": 0, "REFERENCE": 1, "ORIGINAL": 2}[asset["representation"]],
            asset["resolutionHint"]["height"] or 100000, asset["source"]["sizeBytes"], asset["assetId"]))
        chosen["selected"] = True
        for asset in candidates:
            if asset is not chosen:
                asset["exclusionReason"] = "ALTERNATE_REPRESENTATION"
    identity = {"version": "clip-quality-corpus-v1", "inventoryHash": digest(inventory), "workMapHash": digest(work_map),
        "splitSeed": split_seed, "holdoutCount": holdout_count, "durationsUs": [15000000, 30000000, 60000000]}
    corpus_id = "corpus-" + digest(identity)[:24]
    cases = []
    for asset in assets:
        if asset["selected"]:
            for duration in identity["durationsUs"]:
                case_identity = {"corpusId": corpus_id, "assetId": asset["assetId"], "durationUs": duration}
                cases.append({"caseId": "case-" + digest(case_identity)[:24], "workId": asset["workId"],
                    "assetId": asset["assetId"], "split": asset["split"], "requestedDurationUs": duration,
                    "status": "SOURCE_PROBE_PENDING", "normalizationClock": None, "recipeIdentity": None,
                    "modelIdentity": None, "annotationProvenance": [], "humanReview": {"status": "PENDING", "reviewer": None},
                    "measurements": None})
    return {"schemaVersion": "clip-quality-corpus-v1", "corpusId": corpus_id, "createdAt": created_at,
        "identity": identity, "splitPolicy": {"method": "EXPLICIT_WORK_SPLIT_V1" if explicit_splits else "WORK_LEVEL_SHA256_ORDER_V1", "seed": split_seed,
            "holdoutCount": holdout_count, "scope": "DECLARED_WORK_IDS_ONLY", "unrecognizedAliases": "HUMAN_REVIEW_PENDING"},
        "evaluationPolicy": {"externalLlmAllowed": False, "humanGolden": "PENDING", "llmSelfAssessmentIsHumanGolden": False},
        "works": works, "assets": assets, "cases": cases}


def public_summary(manifest):
    selected = [asset for asset in manifest["assets"] if asset["selected"]]
    return {"corpusId": manifest["corpusId"], "objects": len(manifest["assets"]), "selectedWorks": len(selected),
        "cases": len(manifest["cases"]), "devWorks": sum(asset["split"] == "DEV" for asset in selected),
        "holdoutWorks": sum(asset["split"] == "HOLDOUT" for asset in selected), "humanGolden": "PENDING",
        "assetAliases": [asset["assetId"] for asset in selected]}
