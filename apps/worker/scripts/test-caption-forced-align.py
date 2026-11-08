"""Synthetic unit tests only: never imports or runs an actual alignment model."""
import importlib.util
import hashlib
import json
import tempfile
import unittest
import wave
import sys
import types
import itertools
import random
from unittest.mock import MagicMock, patch
from pathlib import Path
from contextlib import contextmanager, nullcontext

SPEC = importlib.util.spec_from_file_location("caption_alignment", Path(__file__).with_name("caption-forced-align.py"))
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


@contextmanager
def fake_runtime(model_dtype="bfloat16", parameter_dtype="bfloat16", parameter_device="cpu"):
    candidate_reads = []
    row_memory = {"forbid_full_mask": False, "full_mask_reads": 0, "views": [], "index_selections": []}
    class Vector:
        def __init__(self, values): self.values = values; self.shape = (len(values),)
        def __eq__(self, value): return Mask([item == value for item in self.values])
        def __getitem__(self, key): return Vector([item for item, keep in zip(self.values, key.values) if keep]) if isinstance(key, Mask) else self.values[key]
        def __mul__(self, value): return Vector([item * value for item in self.values])
        def to(self, *_, **__): return self
        def numpy(self): return self
        def tolist(self): return self.values
    class Mask(Vector):
        def sum(self): return types.SimpleNamespace(item=lambda: sum(self.values))
        def nonzero(self, as_tuple=False):
            if as_tuple: raise AssertionError("expected explicit positional indices")
            return Positions([index for index, keep in enumerate(self.values) if keep])
    class Positions:
        def __init__(self, values): self.values = values
        def flatten(self): return self
        def __getitem__(self, key): return Positions(self.values[key])
    class BatchVector(list):
        @property
        def shape(self): return (len(self), len(self[0].values))
    class Rows:
        def __init__(self, values): self.values = values; self.shape = (len(values), len(values[0]) if values else 0)
        def __getitem__(self, key):
            if isinstance(key, Mask):
                row_memory["full_mask_reads"] += 1
                if row_memory["forbid_full_mask"]: raise AssertionError("full timestamp rows times vocabulary were materialized")
                return Rows([row for row, keep in zip(self.values, key.values) if keep])
            rows, columns = key; return Rows([row[columns] for row in self.values[rows]])
        def index_select(self, dimension, positions):
            if dimension != 0 or (row_memory["forbid_full_mask"] and self.shape[1] != 13): raise AssertionError("only bounded-bin row selection is allowed")
            row_memory["index_selections"].append((dimension, positions.values, self.shape[1]))
            return Rows([self.values[index] for index in positions.values])
        def detach(self): return self
        def to(self, *_, **__): return self
        def tolist(self): candidate_reads.append(self.shape); return self.values
    class Logits:
        def __init__(self): self.values = [[10.0 if index == target else 0.0 for index in range(13)] for target in [1, 2, 3, 4]]
        @property
        def shape(self): return (1, len(self.values), len(self.values[0]))
        def argmax(self, dim): return BatchVector([Vector([max(range(len(row)), key=lambda index: row[index]) for row in self.values])])
        def __getitem__(self, index):
            if isinstance(index, tuple):
                batch, rows, columns = index
                if batch != 0: raise AssertionError("single batch only")
                result = Rows([row[columns] for row in self.values[rows]])
                row_memory["views"].append(result.shape)
                return result
            return Rows(self.values)
    class Batch(dict):
        def to(self, *_, **__): return self
    class Samples:
        def astype(self, _): return self
        def __truediv__(self, _): return self
    class Parameter:
        dtype = parameter_dtype
        device = types.SimpleNamespace(type=parameter_device)
        def is_floating_point(self): return True
    class Model:
        dtype = model_dtype
        device = types.SimpleNamespace(type="cpu")
        def parameters(self):
            first = types.SimpleNamespace(dtype="bfloat16", device=types.SimpleNamespace(type="cpu"), is_floating_point=lambda: True)
            return iter([first, Parameter()])
        # The official model has non-parameter positional/RoPE buffers and
        # intentionally uses float32 math; their dtype must not be forced.
        def buffers(self):
            return iter([types.SimpleNamespace(dtype="float32", device=types.SimpleNamespace(type="cpu"), is_floating_point=lambda: True, numel=lambda: 64)])
    auto_model = MagicMock(); auto_model.from_pretrained.return_value = Model()
    auto_processor = MagicMock()
    torch = types.SimpleNamespace(float32="float32", bfloat16="bfloat16", set_num_threads=MagicMock(), set_num_interop_threads=MagicMock(), inference_mode=MagicMock(return_value=nullcontext()))
    backend = types.SimpleNamespace(Qwen3ASRConfig=type("Config", (), {}), Qwen3ASRForConditionalGeneration=Model, Qwen3ASRProcessor=type("Processor", (), {}))
    native = types.SimpleNamespace(Qwen3ForcedAligner=MagicMock(), Qwen3ForceAlignProcessor=MagicMock())
    logits = Logits(); batch = Batch(input_ids=BatchVector([Vector([10, 10, 10, 10])]))
    model = auto_model.from_pretrained.return_value; model.thinker = MagicMock(return_value=types.SimpleNamespace(logits=logits))
    auto_processor.from_pretrained.return_value.return_value = batch
    wrapper = native.Qwen3ForcedAligner.return_value
    wrapper.model = model; wrapper.processor = auto_processor.from_pretrained.return_value; wrapper.aligner_processor = native.Qwen3ForceAlignProcessor.return_value
    wrapper.timestamp_token_id = 10; wrapper.timestamp_segment_time = 80.0
    wrapper.aligner_processor.encode_timestamp.return_value = (["前", "次"], "encoded")
    wrapper.aligner_processor.parse_timestamp.side_effect = lambda words, stamps: [{"text": word, "start_time": stamps.values[2 * index], "end_time": stamps.values[2 * index + 1]} for index, word in enumerate(words)]
    wrapper._to_structured_items.side_effect = lambda parsed: types.SimpleNamespace(items=[types.SimpleNamespace(**item) for item in parsed])
    normalize = MagicMock(return_value=["normalized"])
    modules = {"numpy": types.SimpleNamespace(frombuffer=MagicMock(return_value=Samples()), float32="float32"), "torch": torch, "transformers": types.SimpleNamespace(AutoConfig=MagicMock(), AutoModel=auto_model, AutoProcessor=auto_processor), "qwen_asr": types.ModuleType("qwen_asr"), "qwen_asr.core": types.ModuleType("core"), "qwen_asr.core.transformers_backend": backend, "qwen_asr.inference": types.ModuleType("inference"), "qwen_asr.inference.qwen3_forced_aligner": native, "qwen_asr.inference.utils": types.SimpleNamespace(normalize_audios=normalize)}
    with patch.dict(sys.modules, modules):
        yield types.SimpleNamespace(auto_model=auto_model, auto_processor=auto_processor, native=native, torch=torch, batch=batch, logits=logits, model=model, candidate_reads=candidate_reads, normalize=normalize, row_memory=row_memory)


class AnchoredZeroDecoder(unittest.TestCase):
    @staticmethod
    def item(text, start, end): return {"text": text, "startUs": start, "endUs": end}

    def test_prefix_dp_matches_bruteforce_optimum_and_is_deterministic(self):
        rng = random.Random(197)
        items = [self.item("a", 0, 80000), self.item("b", 160000, 160000), self.item("c", 240000, 240000), self.item("d", 400000, 480000)]
        before = json.dumps(items)
        for _ in range(12):
            rows = [[rng.randrange(-3, 4) for _ in range(7)] for _ in range(4)]
            scores = {1: rows[:2], 2: rows[2:]}
            result = M.decode_anchored_zero_logits(items, ["abcd"], scores, 480000)
            bins = [result[index][key] // 80000 for index in [1, 2] for key in ["startUs", "endUs"]]
            candidates = [path for path in itertools.product(range(1, 6), repeat=4) if path[0] < path[1] <= path[2] < path[3]]
            best = max(sum(row[value] for row, value in zip(rows, path)) for path in candidates)
            self.assertEqual(sum(row[value] for row, value in zip(rows, bins)), best)
            self.assertEqual(result, M.decode_anchored_zero_logits(items, ["abcd"], scores, 480000))
            self.assertEqual(result[0], items[0]); self.assertEqual(result[3], items[3])
            self.assertEqual(json.dumps(items), before)

    def test_anchors_keep_exact_non_grid_endpoints_and_audio_limit_is_inward(self):
        items = [self.item("a", 0, 80001), self.item("b", 160000, 160000), self.item("c", 319999, 400010)]
        result = M.decode_anchored_zero_logits(items, ["abc"], {1: [[0] * 5, [0] * 5]}, 400010, audio_duration_us=399999)
        self.assertEqual(result, [items[0], self.item("b", 160000, 240000), items[2]])

    def test_all_positive_all_zero_and_impossible_groups_are_exactly_unchanged(self):
        cases = [
            ([self.item("a", 1, 80001), self.item("b", 160001, 240001)], ["ab"]),
            ([self.item("a", 80000, 80000), self.item("b", 160000, 160000)], ["ab"]),
            ([self.item("a", 0, 160000), self.item("b", 160000, 160000), self.item("c", 160000, 320000)], ["abc"]),
            ([self.item("a", 0, 80000), self.item("b", 160000, 160000), self.item("c", 240000, 320000)], ["a", "b", "c"]),
        ]
        for items, paragraphs in cases:
            with self.subTest(paragraphs=paragraphs): self.assertEqual(json.dumps(M.decode_anchored_zero_logits(items, paragraphs, {}, 400000)), json.dumps(items))

    def test_leading_and_trailing_zero_use_one_own_anchor_without_moving_it(self):
        for items, zero_index, expected in [
            ([self.item("a", 0, 0), self.item("b", 160000, 240000)], 0, self.item("a", 0, 80000)),
            ([self.item("a", 0, 80000), self.item("b", 160000, 160000)], 1, self.item("b", 80000, 160000)),
        ]:
            result = M.decode_anchored_zero_logits(items, ["ab"], {zero_index: [[0] * 4, [0] * 4]}, 240000)
            self.assertEqual(result[zero_index], expected)
            self.assertEqual(result[1 - zero_index], items[1 - zero_index])

    def test_nonfinite_shape_count_and_wrong_grid_are_strict(self):
        items = [self.item("a", 0, 80000), self.item("b", 160000, 160000)]
        for scores, options in [({}, {}), ({1: [[0] * 3, [0] * 4]}, {}), ({1: [[float("nan")] * 4, [0] * 4]}, {}), ({1: [[float("inf")] * 4, [0] * 4]}, {}), ({1: [[1e308] * 4, [1e308] * 4]}, {}), ({1: [[0] * 4, [0] * 4]}, {"grid_us": 40000})]:
            with self.subTest(options=options), self.assertRaises(M.AlignmentError): M.decode_anchored_zero_logits(items, ["ab"], scores, 240000, **options)

    def test_invalid_raw_timing_and_cross_paragraph_word_are_never_repaired(self):
        for items, paragraphs in [
            ([self.item("a", -1, -1), self.item("b", 80000, 160000)], ["ab"]),
            ([self.item("a", 0, 160000), self.item("b", 80000, 80000)], ["ab"]),
            ([self.item("a", 0, 80000), self.item("b", 400001, 400001)], ["ab"]),
            ([self.item("ab", 80000, 80000)], ["a", "b"]),
        ]:
            with self.subTest(paragraphs=paragraphs), self.assertRaises(M.AlignmentError): M.decode_anchored_zero_logits(items, paragraphs, {}, 400000)

    def test_adjacent_paragraph_repairs_never_overlap_and_impossible_remainder_stays_raw(self):
        items = [self.item("a", 0, 80000), self.item("b", 160000, 160000), self.item("c", 320000, 320000), self.item("d", 400000, 480000)]
        scores = {1: [[0] * 7, [0, 0, 0, 0, 10, 0, 0]], 2: [[0, 0, 10, 0, 0, 0, 0], [0] * 7]}
        result = M.decode_anchored_zero_logits(items, ["ab", "cd"], scores, 480000)
        self.assertLessEqual(result[1]["endUs"], result[2]["startUs"])
        self.assertEqual(result[0], items[0]); self.assertEqual(result[3], items[3])

    def test_maximum_grid_is_751_bins_and_raw_budget_is_not_reduced_by_zero_repair(self):
        items = [self.item("a", 0, 80000), self.item("b", 80000, 80000)]
        result = M.decode_anchored_zero_logits(items, ["ab"], {1: [[0] * 751, [0] * 751]}, 60000000)
        self.assertEqual(result[1], self.item("b", 80000, 160000))
        with self.assertRaises(M.AlignmentError) as caught: M.validate_native_items([self.item("a", 0, 0)] * 30001, 60000000)
        self.assertEqual(caught.exception.code, "CAPTION_ALIGNMENT_LIMIT")


class AlignmentProtocol(unittest.TestCase):
    def test_native_result_count_has_a_finite_reason_without_model_execution(self):
        with fake_runtime() as runtime, patch.object(M.Path, "read_text", return_value="MemAvailable: 4194304 kB\n"):
            runtime.batch["input_ids"][0].values[-1] = 0
            align = M.load_aligner(Path("/synthetic-model"))
            with self.assertRaises(M.AlignmentError) as caught:
                align(b"\0\0" * 16000, "前次", "Japanese", 1000000, ["前次"])
            self.assertEqual(caught.exception.code, "CAPTION_ALIGNMENT_OUTPUT_INVALID")
            self.assertEqual(getattr(caught.exception, "reason", None), "NATIVE_DECODER_COUNT")
            runtime.model.thinker.assert_called_once()

    def test_one_forward_uses_package_preprocessing_parser_and_preserves_positive_bytes(self):
        with fake_runtime() as runtime, patch.object(M.Path, "read_text", return_value="MemAvailable: 4194304 kB\n"):
            result = M.load_aligner(Path("/synthetic-model"))(b"\0\0" * 16000, "前次", "Japanese", 1000000, ["前次"])
            self.assertEqual(result, {"items": [{"text": "前", "startUs": 80000, "endUs": 160000}, {"text": "次", "startUs": 240000, "endUs": 320000}], "scores": {}})
            runtime.model.thinker.assert_called_once(); runtime.normalize.assert_called_once(); runtime.torch.inference_mode.assert_called_once()
            runtime.native.Qwen3ForcedAligner.return_value.aligner_processor.encode_timestamp.assert_called_once_with("前次", "Japanese")
            self.assertEqual(runtime.native.Qwen3ForcedAligner.return_value.aligner_processor.parse_timestamp.call_args.args[1].tolist(), [80.0, 160.0, 240.0, 320.0])
            self.assertEqual(runtime.candidate_reads, [])

    def test_one_forward_extracts_only_bounded_zero_rows_and_keeps_raw_items_before_decode(self):
        with fake_runtime() as runtime, patch.object(M.Path, "read_text", return_value="MemAvailable: 4194304 kB\n"):
            runtime.logits.values[3] = runtime.logits.values[2].copy()
            result = M.load_aligner(Path("/synthetic-model"))(b"\0\0" * 16000, "前次", "Japanese", 1000000, ["前次"])
            self.assertEqual(result["items"][1]["startUs"], result["items"][1]["endUs"])
            self.assertEqual(set(result["scores"]), {1}); self.assertEqual(runtime.candidate_reads, [(2, 13)])
            decoded = M.decode_anchored_zero_logits(result["items"], ["前次"], result["scores"], 1000000)
            self.assertGreater(decoded[1]["endUs"], decoded[1]["startUs"]); self.assertEqual(decoded[0], result["items"][0])
            runtime.model.thinker.assert_called_once()

    def test_sparse_zero_rows_never_materialize_all_timestamp_rows_or_5000_classes(self):
        with fake_runtime() as runtime, patch.object(M.Path, "read_text", return_value="MemAvailable: 4194304 kB\n"):
            runtime.batch["input_ids"][0].values = [0, 10, 0, 10, 0, 10, 0, 10]
            targets = {1: 1, 3: 2, 5: 3, 7: 3}
            runtime.logits.values = [[10.0 if column == targets.get(row, 0) else 0.0 for column in range(5000)] for row in range(8)]
            runtime.row_memory["forbid_full_mask"] = True
            result = M.load_aligner(Path("/synthetic-model"))(b"\0\0" * 16000, "前次", "Japanese", 1000000, ["前次"])
            self.assertEqual([list(row) for row in result["scores"][1]], [runtime.logits.values[5][:13], runtime.logits.values[7][:13]])
            self.assertEqual(runtime.row_memory["full_mask_reads"], 0)
            self.assertEqual(runtime.row_memory["views"], [(8, 13)])
            self.assertEqual(runtime.row_memory["index_selections"], [(0, [5, 7], 13)])
            self.assertEqual(runtime.candidate_reads, [(2, 13)])
            runtime.model.thinker.assert_called_once()

    def test_foreign_positive_paragraph_is_not_an_anchor_or_a_reason_to_copy_scores(self):
        with fake_runtime() as runtime, patch.object(M.Path, "read_text", return_value="MemAvailable: 4194304 kB\n"):
            runtime.logits.values[1] = runtime.logits.values[0].copy()
            result = M.load_aligner(Path("/synthetic-model"))(b"\0\0" * 16000, "前 次", "Japanese", 1000000, ["前", "次"])
            self.assertEqual(result["items"][0]["startUs"], result["items"][0]["endUs"])
            self.assertEqual(result["scores"], {}); self.assertEqual(runtime.candidate_reads, [])
            runtime.model.thinker.assert_called_once()

    def test_later_invalid_window_prevents_every_decoder_call(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "audio.wav"
            with wave.open(str(path), "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\0\0" * 16000)
            base = {"audioPath": str(path), "durationUs": 1000000, "text": "ab", "paragraphTexts": ["ab"], "pcmSha256": hashlib.sha256(b"\0\0" * 16000).hexdigest()}
            request = {"version": "caption-alignment-request-v2", "modelPath": d, "language": "en", "windows": [base, base]}
            for bad in [[{"text": "ab", "startUs": -1, "endUs": -1}], [{"text": "wrong", "startUs": 0, "endUs": 80000}]]:
                outputs = iter([{"items": [{"text": "a", "startUs": 0, "endUs": 80000}, {"text": "b", "startUs": 160000, "endUs": 160000}], "scores": {1: [[0] * 13, [0] * 13]}}, {"items": bad, "scores": {}}])
                with patch.object(M, "decode_anchored_zero_logits", wraps=M.decode_anchored_zero_logits) as decoder, self.assertRaises(M.AlignmentError):
                    M.align_windows(request, lambda _: lambda *_: next(outputs))
                decoder.assert_not_called()

    def test_native_output_reasons_preserve_strict_rejection_and_only_bounded_indices(self):
        valid = {"text": "synthetic-private", "startUs": 100000, "endUs": 500000}
        cases = [
            ([{**valid, "private": "synthetic-secret"}], "NATIVE_ITEM_SHAPE", 0),
            ([{**valid, "text": ""}], "NATIVE_ITEM_TEXT", 0),
            ([{**valid, "startUs": 1.5}], "NATIVE_ITEM_TIME_TYPE", 0),
            ([{**valid, "startUs": -1}], "NATIVE_ITEM_NEGATIVE_TIME", 0),
            ([valid, {**valid, "startUs": 400000, "endUs": 800000}], "NATIVE_ITEM_NONMONOTONIC", 1),
            ([{**valid, "endUs": 99999}], "NATIVE_ITEM_REVERSED_TIME", 0),
            ([{**valid, "endUs": 1000001}], "NATIVE_ITEM_OUT_OF_WINDOW", 0),
        ]
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "audio.wav"
            with wave.open(str(path), "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\0\0" * 16000)
            request = {"version": "caption-alignment-request-v2", "modelPath": d, "language": "ja", "windows": [{"audioPath": str(path), "durationUs": 1000000, "text": "synthetic-private", "paragraphTexts": ["synthetic-private"], "pcmSha256": hashlib.sha256(b"\0\0" * 16000).hexdigest()}]}
            for items, reason, item_index in cases:
                with self.subTest(reason=reason), self.assertRaises(M.AlignmentError) as caught:
                    M.align_windows(request, lambda _: lambda *_: {"items": items, "scores": {}})
                self.assertEqual(caught.exception.code, "CAPTION_ALIGNMENT_OUTPUT_INVALID")
                self.assertEqual(getattr(caught.exception, "reason", None), reason)
                self.assertEqual(M.error_payload(caught.exception), {"error": "CAPTION_ALIGNMENT_OUTPUT_INVALID", "reason": reason, "windowIndex": 0, "itemIndex": item_index})

    def test_raw_zero_duration_items_are_preserved_for_paragraph_owned_node_grouping(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "audio.wav"
            with wave.open(str(path), "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\0\0" * 16000)
            request = {"version": "caption-alignment-request-v2", "modelPath": d, "language": "ja", "windows": [{"audioPath": str(path), "durationUs": 1000000, "text": "ここには次", "paragraphTexts": ["ここには次"], "pcmSha256": hashlib.sha256(b"\0\0" * 16000).hexdigest()}]}
            items = [{"text": "ここ", "startUs": 100000, "endUs": 200000}, {"text": "に", "startUs": 200000, "endUs": 200000}, {"text": "は", "startUs": 200000, "endUs": 200000}, {"text": "次", "startUs": 200000, "endUs": 800000}]
            result = M.align_windows(request, lambda _: lambda *_: {"items": items, "scores": {}})
            self.assertEqual(result["windows"], [{"items": items}])

    def test_error_payload_preserves_legacy_shape_and_omits_untrusted_diagnostics(self):
        self.assertEqual(M.error_payload(M.AlignmentError("CAPTION_ALIGNMENT_UNAVAILABLE")), {"error": "CAPTION_ALIGNMENT_UNAVAILABLE"})
        error = M.AlignmentError("CAPTION_ALIGNMENT_OUTPUT_INVALID")
        error.reason = "synthetic-private /source token=secret"; error.window_index = 10 ** 30; error.item_index = -1
        self.assertEqual(M.error_payload(error), {"error": "CAPTION_ALIGNMENT_OUTPUT_INVALID"})
        error.reason = "NATIVE_ITEM_ZERO_DURATION"
        self.assertEqual(M.error_payload(error), {"error": "CAPTION_ALIGNMENT_OUTPUT_INVALID", "reason": "NATIVE_ITEM_ZERO_DURATION"})

    def test_runtime_uses_only_explicit_offline_cpu_loaders(self):
        with fake_runtime() as runtime, patch.object(M.Path, "read_text", return_value="MemAvailable: 4194304 kB\n"):
            M.load_aligner(Path("/synthetic-model"))
            for kwargs in [runtime.auto_model.from_pretrained.call_args.kwargs, runtime.auto_processor.from_pretrained.call_args.kwargs]:
                self.assertTrue(kwargs["local_files_only"]); self.assertFalse(kwargs["trust_remote_code"])
            kwargs = runtime.auto_model.from_pretrained.call_args.kwargs
            self.assertEqual(kwargs["device_map"], "cpu")
            self.assertEqual(kwargs["dtype"], runtime.torch.bfloat16)
            self.assertTrue(kwargs["low_cpu_mem_usage"])
            self.assertEqual(kwargs["attn_implementation"], "eager")
            self.assertEqual(M.os.environ["HF_HUB_OFFLINE"], "1")
            runtime.torch.set_num_threads.assert_called_once_with(4)
            runtime.torch.set_num_interop_threads.assert_called_once_with(1)
            runtime.native.Qwen3ForcedAligner.return_value.align.assert_not_called()

    def test_rejects_promoted_model_or_any_promoted_or_non_cpu_learned_parameter(self):
        for kwargs in [{"model_dtype": "float32"}, {"parameter_dtype": "float32"}, {"parameter_device": "meta"}]:
            with self.subTest(**kwargs), fake_runtime(**kwargs) as runtime, patch.object(M.Path, "read_text", return_value="MemAvailable: 4194304 kB\n"):
                with self.assertRaises(M.AlignmentError) as caught:
                    M.load_aligner(Path("/synthetic-model"))
                self.assertEqual(caught.exception.code, "CAPTION_ALIGNMENT_RUNTIME_MISMATCH")
                runtime.auto_processor.from_pretrained.assert_not_called()
                runtime.native.Qwen3ForcedAligner.assert_not_called()

    def test_memory_preflight_accepts_first_kib_boundary_at_weights_plus_one_gib(self):
        # The safetensors file includes its header, so using its published byte
        # length is slightly more conservative than tensor payload bytes alone.
        minimum_kib = (1835544544 + 1073741824 + 1023) // 1024
        with fake_runtime() as runtime, patch.object(M.Path, "read_text", return_value=f"MemTotal: 8388608 kB\nMemAvailable: {minimum_kib} kB\n"):
            M.load_aligner(Path("/synthetic-model"))
            runtime.auto_model.from_pretrained.assert_called_once()

    def test_insufficient_missing_invalid_or_unreadable_memory_never_loads_weights(self):
        minimum_kib = (1835544544 + 1073741824 + 1023) // 1024
        cases = [f"MemAvailable: {minimum_kib - 1} kB\n", "MemAvailable: 0 kB\n", "MemFree: 9999999 kB\n", "MemAvailable: -1 kB\n", "MemAvailable: 9999999 MB\n", "MemAvailable: 9999999.0 kB\n", "MemAvailable: 9999999 kB trailing\n", "MemAvailable: 9999999 kB\nMemAvailable: 9999999 kB\n", "MemAvailable: 999999999999999999999999999999 kB\n"]
        for text in cases:
            with self.subTest(text=text), fake_runtime() as runtime, patch.object(M.Path, "read_text", return_value=text):
                with self.assertRaises(M.AlignmentError) as caught:
                    M.load_aligner(Path("/synthetic-model"))
                self.assertEqual(caught.exception.code, "CAPTION_ALIGNMENT_UNAVAILABLE")
                runtime.auto_model.from_pretrained.assert_not_called()
                runtime.auto_processor.from_pretrained.assert_not_called()
        for error in [FileNotFoundError(), PermissionError(), UnicodeError()]:
            with self.subTest(error=type(error).__name__), fake_runtime() as runtime, patch.object(M.Path, "read_text", side_effect=error):
                with self.assertRaises(M.AlignmentError) as caught:
                    M.load_aligner(Path("/synthetic-model"))
                self.assertEqual(caught.exception.code, "CAPTION_ALIGNMENT_UNAVAILABLE")
                runtime.auto_model.from_pretrained.assert_not_called()

    def test_stub_alignment_runs_each_full_window_once_with_one_model_load(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "audio.wav"
            with wave.open(str(path), "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
                w.writeframes(b"\0\0" * 16000)
            calls = []
            def load(_):
                calls.append("load")
                def align(pcm, text, language, duration_us, paragraphs):
                    calls.append((len(pcm), text, language))
                    self.assertEqual(duration_us, 1000000); self.assertEqual(paragraphs, ["次。"])
                    return {"items": [{"text": "次", "startUs": 300000, "endUs": 800000}], "scores": {}}
                return align
            request = {"version": "caption-alignment-request-v2", "modelPath": d, "language": "ja", "windows": [{"audioPath": str(path), "durationUs": 1000000, "text": "次。", "paragraphTexts": ["次。"], "pcmSha256": hashlib.sha256(b"\0\0" * 16000).hexdigest()}]}
            result = M.align_windows(request, load)
            self.assertEqual(calls, ["load", (32000, "次。", "Japanese")])
            self.assertEqual(result["windows"][0]["items"][0]["startUs"], 300000)
            for bad in [{**request, "version": "caption-alignment-request-v1"}, {**request, "windows": [{**request["windows"][0], "paragraphTexts": ["mismatch"]}]}]:
                with self.assertRaises(M.AlignmentError): M.align_windows(bad, lambda _: self.fail("must not load invalid protocol"))

    def test_invalid_window_and_language_never_load_a_model(self):
        for change in [{"language": "auto"}, {"windows": [{"audioPath": "https://invalid", "durationUs": 1, "text": "x"}]}, {"windows": [{"audioPath": "/a.wav", "durationUs": 60000001, "text": "x"}]}]:
            request = {"version": "caption-alignment-request-v2", "modelPath": "/models", "language": "ja", "windows": []}
            request.update(change)
            with self.assertRaises(M.AlignmentError):
                M.align_windows(request, lambda _: self.fail("must not load"))

    def test_manifest_files_are_hash_verified_and_symlinks_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); path = root / "config.json"; path.write_bytes(b"stub")
            pin = {"name": path.name, "size": 4, "sha256": hashlib.sha256(b"stub").hexdigest()}
            M.verify_files(root, [pin])
            path.write_bytes(b"evil")
            with self.assertRaises(M.AlignmentError): M.verify_files(root, [pin])
            path.unlink(); path.symlink_to(root / "other")
            with self.assertRaises(M.AlignmentError): M.verify_files(root, [pin])


if __name__ == "__main__": unittest.main()
