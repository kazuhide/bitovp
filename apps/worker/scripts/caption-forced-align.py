"""Offline, CPU-only caption alignment worker. Actual invocation belongs to BitOVP UI jobs."""
import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import re
import time
import wave
import unicodedata
from array import array

REVISION = "c7cbfc2048c462b0d63a45797104fc9db3ad62b7"
MODEL_WEIGHTS_BYTES = 1835544544
MIN_MEMORY_HEADROOM_BYTES = 1073741824
NATIVE_OUTPUT_REASONS = frozenset([
    "NATIVE_RESULT_COUNT", "NATIVE_ITEM_SHAPE", "NATIVE_ITEM_TEXT",
    "NATIVE_ITEM_TIME_TYPE", "NATIVE_ITEM_NEGATIVE_TIME", "NATIVE_ITEM_NONMONOTONIC",
    "NATIVE_ITEM_ZERO_DURATION", "NATIVE_ITEM_REVERSED_TIME", "NATIVE_ITEM_OUT_OF_WINDOW",
    "NATIVE_DECODER_SHAPE", "NATIVE_DECODER_COUNT", "NATIVE_DECODER_NONFINITE",
    "NATIVE_DECODER_GRID", "NATIVE_DECODER_LEXICAL", "NATIVE_DECODER_PARAGRAPH", "NATIVE_DECODER_ANCHOR",
])
for key in ["HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"]:
    os.environ[key] = "1"
os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["HIP_VISIBLE_DEVICES"] = ""
os.environ["OMP_NUM_THREADS"] = "4"
os.environ["MKL_NUM_THREADS"] = "4"
os.environ["TOKENIZERS_PARALLELISM"] = "false"


class AlignmentError(Exception):
    def __init__(self, code, reason=None, window_index=None, item_index=None):
        self.code = code; self.reason = reason
        self.window_index = window_index; self.item_index = item_index


def error_payload(error):
    payload = {"error": error.code}
    if error.code == "CAPTION_ALIGNMENT_OUTPUT_INVALID" and isinstance(error.reason, str) and error.reason in NATIVE_OUTPUT_REASONS:
        payload["reason"] = error.reason
        if type(error.window_index) is int and 0 <= error.window_index < 80:
            payload["windowIndex"] = error.window_index
            if type(error.item_index) is int and 0 <= error.item_index < 30000:
                payload["itemIndex"] = error.item_index
    return payload


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""): value.update(chunk)
    return value.hexdigest()


def verify_files(root, pins):
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise AlignmentError("CAPTION_ALIGNMENT_MODEL_MISMATCH")
    for pin in pins:
        name = pin["name"]
        if Path(name).name != name: raise AlignmentError("CAPTION_ALIGNMENT_MODEL_MISMATCH")
        path = root / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size != pin["size"] or digest(path) != pin["sha256"]:
            raise AlignmentError("CAPTION_ALIGNMENT_MODEL_MISMATCH")


def require_available_memory():
    # A point-in-time lower bound, not an OOM guarantee: other VM processes
    # can allocate after this check. Keeping learned weights in BF16 is the
    # primary mitigation; unknown availability must never trigger a guess.
    try:
        text = Path("/proc/meminfo").read_text(encoding="ascii")
    except (OSError, UnicodeError):
        raise AlignmentError("CAPTION_ALIGNMENT_UNAVAILABLE") from None
    rows = [line for line in text.splitlines() if line.split(":", 1)[0].strip() == "MemAvailable"]
    match = re.fullmatch(r"MemAvailable:[ \t]+([0-9]{1,16})[ \t]+kB[ \t]*", rows[0]) if len(rows) == 1 else None
    if match is None:
        raise AlignmentError("CAPTION_ALIGNMENT_UNAVAILABLE")
    available_kib = int(match.group(1))
    if available_kib > (2 ** 63 - 1) // 1024 or available_kib * 1024 < MODEL_WEIGHTS_BYTES + MIN_MEMORY_HEADROOM_BYTES:
        raise AlignmentError("CAPTION_ALIGNMENT_UNAVAILABLE")


GRID_US = 80000


def output_invalid(reason, window_index=None, item_index=None):
    raise AlignmentError("CAPTION_ALIGNMENT_OUTPUT_INVALID", reason, window_index, item_index)


def validate_native_items(items, duration_us, window_index=None):
    if not isinstance(items, list): output_invalid("NATIVE_DECODER_COUNT", window_index)
    if len(items) > 30000: raise AlignmentError("CAPTION_ALIGNMENT_LIMIT")
    previous_end = 0
    for item_index, item in enumerate(items):
        reason = None
        if not isinstance(item, dict) or set(item) != {"text", "startUs", "endUs"}: reason = "NATIVE_ITEM_SHAPE"
        elif not isinstance(item["text"], str) or not item["text"]: reason = "NATIVE_ITEM_TEXT"
        elif type(item["startUs"]) is not int or type(item["endUs"]) is not int: reason = "NATIVE_ITEM_TIME_TYPE"
        elif item["startUs"] < previous_end: reason = "NATIVE_ITEM_NEGATIVE_TIME" if item["startUs"] < 0 else "NATIVE_ITEM_NONMONOTONIC"
        elif item["endUs"] < item["startUs"]: reason = "NATIVE_ITEM_REVERSED_TIME"
        elif item["endUs"] > duration_us: reason = "NATIVE_ITEM_OUT_OF_WINDOW"
        if reason: output_invalid(reason, window_index, item_index)
        previous_end = item["endUs"]


def lexical(text):
    return [char for char in text if char == "'" or unicodedata.category(char)[0] in "LN"]


def paragraph_owners(items, paragraphs, window_index=None):
    if not isinstance(paragraphs, list) or not 1 <= len(paragraphs) <= 5000 or any(not isinstance(text, str) or not text for text in paragraphs): output_invalid("NATIVE_DECODER_PARAGRAPH", window_index)
    pieces = [lexical(text) for text in paragraphs]
    expected = [char for piece in pieces for char in piece]
    ends = []; total = 0
    for piece in pieces: total += len(piece); ends.append(total)
    cursor = 0; owner = 0; owners = []
    for item_index, item in enumerate(items):
        chars = lexical(item["text"])
        if not chars or expected[cursor:cursor + len(chars)] != chars: output_invalid("NATIVE_DECODER_LEXICAL", window_index, item_index)
        while owner < len(ends) and cursor >= ends[owner]: owner += 1
        if owner == len(ends) or cursor + len(chars) > ends[owner]: output_invalid("NATIVE_DECODER_PARAGRAPH", window_index, item_index)
        owners.append(owner); cursor += len(chars)
    if cursor != len(expected): output_invalid("NATIVE_DECODER_LEXICAL", window_index)
    return owners


def eligible_zero_groups(items, owners, limit_us, grid_us=GRID_US):
    if grid_us != GRID_US or type(limit_us) is not int or not 0 <= limit_us <= 60000000: output_invalid("NATIVE_DECODER_GRID")
    positive_paragraphs = {owner for item, owner in zip(items, owners) if item["endUs"] > item["startUs"]}
    groups = []; index = 0
    while index < len(items):
        if items[index]["endUs"] > items[index]["startUs"]: index += 1; continue
        end = index + 1
        while end < len(items) and owners[end] == owners[index] and items[end]["startUs"] == items[end]["endUs"]: end += 1
        # Other-paragraph neighbors constrain order, but are never acoustic
        # anchors for an all-zero paragraph.
        lower = items[index - 1]["endUs"] if index else 0
        upper = min(items[end]["startUs"] if end < len(items) else limit_us, limit_us)
        first_bin = (lower + grid_us - 1) // grid_us; last_bin = upper // grid_us
        if owners[index] in positive_paragraphs and last_bin - first_bin >= end - index:
            groups.append((index, end, first_bin, last_bin))
        index = end
    return groups


def validate_score_rows(items, owners, scores, limit_us, grid_us=GRID_US):
    groups = eligible_zero_groups(items, owners, limit_us, grid_us)
    required = {index for start, end, _, _ in groups for index in range(start, end)}
    if not isinstance(scores, dict) or any(type(index) is not int for index in scores) or set(scores) != required: output_invalid("NATIVE_DECODER_COUNT")
    bins = limit_us // grid_us + 1
    for pair in scores.values():
        if not isinstance(pair, list) or len(pair) != 2: output_invalid("NATIVE_DECODER_SHAPE")
        for row in pair:
            if not isinstance(row, (list, array)) or len(row) != bins: output_invalid("NATIVE_DECODER_SHAPE")
            for value in row:
                try: finite = type(value) in (int, float) and math.isfinite(value)
                except (OverflowError, ValueError): finite = False
                if not finite: output_invalid("NATIVE_DECODER_NONFINITE")
    return groups, bins


def decode_anchored_zero_logits(items, paragraph_texts, scores, duration_us, audio_duration_us=None, grid_us=GRID_US):
    if type(duration_us) is not int or not 0 < duration_us <= 60000000: output_invalid("NATIVE_DECODER_GRID")
    if audio_duration_us is None: audio_duration_us = duration_us
    if type(audio_duration_us) is not int or audio_duration_us < 0: output_invalid("NATIVE_DECODER_GRID")
    validate_native_items(items, duration_us)
    owners = paragraph_owners(items, paragraph_texts)
    groups, bins = validate_score_rows(items, owners, scores, min(duration_us, audio_duration_us), grid_us)
    if not groups: return items
    result = [dict(item) for item in items]
    for start, end, lower, upper in groups:
        # A preceding repaired paragraph may tighten this order bound. The
        # preceding group's upper bound was this group's raw first zero, so
        # an infeasible group can still retain all its raw zeros safely.
        if start: lower = max(lower, (result[start - 1]["endUs"] + grid_us - 1) // grid_us)
        if upper - lower < end - start: continue
        rows = [row for index in range(start, end) for row in scores[index]]
        previous = [None] * bins
        for value in range(lower, upper + 1): previous[value] = float(rows[0][value])
        backpointers = []
        for row_index, row in enumerate(rows[1:], 1):
            current = [None] * bins; parent = array("i", [-1]) * bins
            best = None; best_index = -1
            for value in range(lower, upper + 1):
                before = value - (1 if row_index % 2 else 0)
                if before >= lower and previous[before] is not None and (best is None or previous[before] > best):
                    best = previous[before]; best_index = before
                if best is not None:
                    total = best + float(row[value])
                    if not math.isfinite(total): output_invalid("NATIVE_DECODER_NONFINITE")
                    current[value] = total; parent[value] = best_index
            backpointers.append(parent); previous = current
        best_value = None; best_index = -1
        for value in range(lower, upper + 1):
            if previous[value] is not None and (best_value is None or previous[value] > best_value): best_value = previous[value]; best_index = value
        if best_index < 0: output_invalid("NATIVE_DECODER_ANCHOR")
        path = [best_index]
        for parent in reversed(backpointers): path.append(parent[path[-1]])
        path.reverse()
        for offset, index in enumerate(range(start, end)):
            result[index] = {**items[index], "startUs": path[2 * offset] * grid_us, "endUs": path[2 * offset + 1] * grid_us}
    validate_native_items(result, duration_us)
    for original, restored in zip(items, result):
        if original["text"] != restored["text"] or (original["endUs"] > original["startUs"] and original != restored): output_invalid("NATIVE_DECODER_ANCHOR")
    return result


def load_aligner(model_path):
    import numpy as np
    import torch
    from transformers import AutoConfig, AutoModel, AutoProcessor
    from qwen_asr.core.transformers_backend import Qwen3ASRConfig, Qwen3ASRForConditionalGeneration, Qwen3ASRProcessor
    from qwen_asr.inference.qwen3_forced_aligner import Qwen3ForcedAligner, Qwen3ForceAlignProcessor
    from qwen_asr.inference.utils import normalize_audios
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    AutoConfig.register("qwen3_asr", Qwen3ASRConfig)
    AutoModel.register(Qwen3ASRConfig, Qwen3ASRForConditionalGeneration)
    AutoProcessor.register(Qwen3ASRConfig, Qwen3ASRProcessor)
    require_available_memory()
    model = AutoModel.from_pretrained(str(model_path), local_files_only=True, trust_remote_code=False, dtype=torch.bfloat16, device_map="cpu", low_cpu_mem_usage=True, attn_implementation="eager")
    if not isinstance(model, Qwen3ASRForConditionalGeneration) or model.device.type != "cpu" or model.dtype != torch.bfloat16:
        raise AlignmentError("CAPTION_ALIGNMENT_RUNTIME_MISMATCH")
    floating_parameters = False
    # Check every learned parameter, not just model.dtype (the first one).
    # Do not cast or reject Qwen's non-parameter positional/RoPE buffers:
    # their float32 math is intentional and is not FP32 checkpoint expansion.
    for parameter in model.parameters():
        floating = parameter.is_floating_point()
        if parameter.device.type != "cpu" or (floating and parameter.dtype != torch.bfloat16):
            raise AlignmentError("CAPTION_ALIGNMENT_RUNTIME_MISMATCH")
        floating_parameters = floating_parameters or floating
    if not floating_parameters:
        raise AlignmentError("CAPTION_ALIGNMENT_RUNTIME_MISMATCH")
    processor = AutoProcessor.from_pretrained(str(model_path), local_files_only=True, trust_remote_code=False, fix_mistral_regex=True)
    native = Qwen3ForcedAligner(model=model, processor=processor, aligner_processor=Qwen3ForceAlignProcessor())
    def align(pcm, text, language, duration_us, paragraphs):
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        # Same single-window preprocessing, forward and package LIS parser as
        # qwen-asr0.0.6 align(): retain full-vocabulary argmax before any repair.
        with torch.inference_mode():
            audios = normalize_audios((samples, 16000))
            word_list, encoded = native.aligner_processor.encode_timestamp(text, language)
            inputs = native.processor(text=[encoded], audio=audios, return_tensors="pt", padding=True)
            inputs = inputs.to(native.model.device).to(native.model.dtype)
            logits = native.model.thinker(**inputs).logits
            limit_us = min(duration_us, (len(pcm) // 2) * 1000000 // 16000)
            bins = limit_us // GRID_US + 1
            if native.timestamp_segment_time != 80.0: output_invalid("NATIVE_DECODER_GRID")
            if len(logits.shape) != 3 or logits.shape[0] != 1 or logits.shape[1] != inputs["input_ids"].shape[1] or logits.shape[2] < bins: output_invalid("NATIVE_DECODER_SHAPE")
            output_ids = logits.argmax(dim=-1)
            mask = inputs["input_ids"][0] == native.timestamp_token_id
            if int(mask.sum().item()) != 2 * len(word_list): output_invalid("NATIVE_DECODER_COUNT")
            timestamp_ms = (output_ids[0][mask] * native.timestamp_segment_time).to("cpu").numpy()
            parsed = native.aligner_processor.parse_timestamp(word_list, timestamp_ms)
            for item in parsed:
                item["start_time"] = round(item["start_time"] / 1000.0, 3)
                item["end_time"] = round(item["end_time"] / 1000.0, 3)
            result = native._to_structured_items(parsed)
            items = [{"text": item.text, "startUs": round(item.start_time * 1000000), "endUs": round(item.end_time * 1000000)} for item in result.items]
            if len(items) != len(word_list): output_invalid("NATIVE_DECODER_COUNT")
            validate_native_items(items, duration_us)
            owners = paragraph_owners(items, paragraphs)
            groups = eligible_zero_groups(items, owners, limit_us)
            required = [index for start, end, _, _ in groups for index in range(start, end)]
            scores = {}
            if required:
                positions = mask.nonzero(as_tuple=False).flatten()
                bounded_logits = logits[0, :, :bins]
                for index in required:
                    pair = bounded_logits.index_select(0, positions[2 * index:2 * index + 2])
                    scores[index] = [array("f", row) for row in pair.detach().to(device="cpu", dtype=torch.float32).tolist()]
            validate_score_rows(items, owners, scores, limit_us)
            return {"items": items, "scores": scores}
    return align


def align_windows(request, loader=load_aligner):
    if set(request) != {"version", "modelPath", "language", "windows"} or request["version"] != "caption-alignment-request-v2":
        raise AlignmentError("CAPTION_ALIGNMENT_INPUT_INVALID")
    if request["language"] not in ["ja", "en"]: raise AlignmentError("CAPTION_ALIGNMENT_LANGUAGE_UNSUPPORTED")
    model_path = Path(request["modelPath"])
    windows = request["windows"]
    if not model_path.is_absolute() or not isinstance(windows, list) or not 1 <= len(windows) <= 80:
        raise AlignmentError("CAPTION_ALIGNMENT_INPUT_INVALID")
    total = 0; total_text = 0
    for window in windows:
        if set(window) != {"audioPath", "durationUs", "text", "paragraphTexts", "pcmSha256"}: raise AlignmentError("CAPTION_ALIGNMENT_INPUT_INVALID")
        duration = window["durationUs"]
        if type(duration) is not int or not 0 < duration <= 60000000 or not isinstance(window["text"], str) or not 0 < len(window["text"]) <= 32000 or not Path(window["audioPath"]).is_absolute():
            raise AlignmentError("CAPTION_ALIGNMENT_INPUT_INVALID")
        paragraphs = window["paragraphTexts"]
        if not isinstance(paragraphs, list) or not 1 <= len(paragraphs) <= 5000 or any(not isinstance(text, str) or not text for text in paragraphs) or window["text"] != " ".join(paragraphs): raise AlignmentError("CAPTION_ALIGNMENT_INPUT_INVALID")
        total += duration; total_text += len(window["text"])
    if total > 240000000 or total_text > 200000: raise AlignmentError("CAPTION_ALIGNMENT_LIMIT")
    payloads = []
    for window in windows:
        path = Path(window["audioPath"])
        if path.is_symlink() or not path.is_file() or path.stat().st_size > math.ceil(window["durationUs"] * .032) + 4096:
            raise AlignmentError("CAPTION_ALIGNMENT_INPUT_INVALID")
        with wave.open(str(path), "rb") as f:
            if f.getnchannels() != 1 or f.getsampwidth() != 2 or f.getframerate() != 16000 or abs(f.getnframes() - round(window["durationUs"] * .016)) > 2:
                raise AlignmentError("CAPTION_ALIGNMENT_INPUT_INVALID")
            pcm = f.readframes(f.getnframes())
        if hashlib.sha256(pcm).hexdigest() != window["pcmSha256"]: raise AlignmentError("CAPTION_ALIGNMENT_INPUT_INVALID")
        payloads.append(pcm)
    start = time.monotonic(); aligner = loader(model_path); model_load_ms = (time.monotonic() - start) * 1000
    start = time.monotonic(); validated = []; item_count = 0
    for window_index, (window, pcm) in enumerate(zip(windows, payloads)):
        try:
            raw = aligner(pcm, window["text"], "Japanese" if request["language"] == "ja" else "English", window["durationUs"], window["paragraphTexts"])
            if not isinstance(raw, dict) or set(raw) != {"items", "scores"}: output_invalid("NATIVE_DECODER_SHAPE")
            items = raw["items"]
            validate_native_items(items, window["durationUs"], window_index)
            owners = paragraph_owners(items, window["paragraphTexts"], window_index)
            audio_duration_us = (len(pcm) // 2) * 1000000 // 16000
            validate_score_rows(items, owners, raw["scores"], min(window["durationUs"], audio_duration_us))
        except AlignmentError as error:
            if error.code == "CAPTION_ALIGNMENT_OUTPUT_INVALID": error.window_index = window_index
            raise
        item_count += len(items)
        if item_count > 30000: raise AlignmentError("CAPTION_ALIGNMENT_LIMIT")
        validated.append((window, raw, audio_duration_us))
    # No window is repaired until every raw window, score shape, lexical
    # projection, paragraph owner and the complete raw budget has passed.
    results = []
    for window, raw, audio_duration_us in validated:
        results.append({"items": decode_anchored_zero_logits(raw["items"], window["paragraphTexts"], raw["scores"], window["durationUs"], audio_duration_us)})
    return {"windows": results, "modelLoadMs": model_load_ms, "alignmentMs": (time.monotonic() - start) * 1000}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True); parser.add_argument("--request", required=True)
    args = parser.parse_args()
    try:
        manifest_path = Path(args.manifest); request_path = Path(args.request)
        if manifest_path.stat().st_size > 65536 or request_path.stat().st_size > 2000000: raise AlignmentError("CAPTION_ALIGNMENT_LIMIT")
        manifest = json.loads(manifest_path.read_text()); request = json.loads(request_path.read_text())
        if manifest["revision"] != REVISION or manifest["runtime"]["scriptSha256"] != digest(Path(__file__)):
            raise AlignmentError("CAPTION_ALIGNMENT_RUNTIME_MISMATCH")
        if manifest["runtime"]["device"] != "cpu" or manifest["runtime"]["dtype"] != "bfloat16" or manifest["runtime"]["threads"] != 4:
            raise AlignmentError("CAPTION_ALIGNMENT_RUNTIME_MISMATCH")
        if platform.python_version_tuple()[:2] != ("3", "11"): raise AlignmentError("CAPTION_ALIGNMENT_RUNTIME_MISMATCH")
        for name in ["torch", "qwen-asr", "transformers", "nagisa", "accelerate"]:
            if importlib.metadata.version(name) != manifest["runtime"][name]: raise AlignmentError("CAPTION_ALIGNMENT_RUNTIME_MISMATCH")
        root = Path(request["modelPath"]); verify_files(root, manifest["files"])
        result = align_windows(request)
        verify_files(root, manifest["files"])
        model_hash = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        print(json.dumps({"version": "caption-alignment-output-v1", "engineVersion": "0.0.6", "modelManifestHash": model_hash, **result}, ensure_ascii=False))
    except AlignmentError as error: print(json.dumps(error_payload(error)))
    except Exception: print(json.dumps({"error": "CAPTION_ALIGNMENT_RUNTIME_FAILED"}))


if __name__ == "__main__": main()
