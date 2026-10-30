import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVmafJson, type VmafCommandOptions } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	prepareVmafxModel,
	VMAFX_REVISION,
	verifyVmafxReceipt,
} from "./vmafx-contract";

const HASH = "e4cf8c147e1368b35497d772920bc92f98c1ad7853c1033d8a836947f427140e";
const EXPECTED = {
	model: "vmaf_v1.0.16_3d0h",
	modelSha256: HASH,
	width: 640,
	height: 360,
	psnr: true,
	distortedOriginal: { width: 320, height: 180, bitdepth: 8 },
};
const FEATURES = [
	"cambi_cuda",
	"speed_chroma_cuda",
	"adm_cuda",
	"motion_cuda",
	"psnr_cuda",
];
const FAMILY_KEYS = [
	"cambi_hrs_1080_cmxv_17_vlt_0.06_encbd_8_ench_180_encw_320",
	"speed_chroma_uv_mxv_45_nnf_0.1_snn_0.19_wvm_5",
	"integer_adm3_csf_2_dlmw_0.7_egl_1_min_0.5_nw_0.02",
	"integer_motion3_mmxv_18",
] as const;
const OPTIONS: VmafCommandOptions = {
	referencePath: "/work/reference.mp4",
	distortedPath: "/work/distorted.mp4",
	model: EXPECTED.model,
	modelPath: `/models/${EXPECTED.model}.json`,
	logPath: "/work/scores.json",
	scaleToReference: { width: EXPECTED.width, height: EXPECTED.height },
	distortedOriginal: EXPECTED.distortedOriginal,
	psnr: true,
};

function metrics(vmaf: number, psnr: number) {
	return {
		vmaf,
		psnr_y: psnr,
		psnr_cb: psnr - 1,
		psnr_cr: psnr + 1,
		[FAMILY_KEYS[0]]: 0.3,
		[FAMILY_KEYS[1]]: 0.00001,
		[FAMILY_KEYS[2]]: 0.9999,
		[FAMILY_KEYS[3]]: 2.2,
	};
}

/** Synthetic CUDA subset of the pinned filter's actual CPU report shape.
 * This is a validator test, not evidence of CUDA execution or score parity. */
function receipt() {
	return {
		backend_used: "cuda",
		feature_backends: FEATURES.map((extractor) => ({
			extractor,
			backend: "cuda",
		})),
		provenance: {
			active_backend: "cuda",
			commit: "f69ae15fd834c71c366b64b26db5133884674e88",
			n_extractors: 5,
			n_models: 1,
			gpumask: "0",
			cpumask: "0",
			n_subsample: 1,
			frame_width: 640,
			frame_height: 360,
			bpc: 10,
			n_frames: "2",
			models: [
				{
					name: "vmaf",
					version: "/private/model/location.json",
					sha256: HASH,
					flags: "0",
					overrides:
						"cambi.enc_width=320:cambi.enc_height=180:cambi.enc_bitdepth=8",
				},
			] satisfies [unknown],
		},
		frames: [
			{ frameNum: 0, metrics: metrics(97, 42) },
			{ frameNum: 1, metrics: metrics(95, 40) },
		] satisfies [unknown, unknown],
	};
}

describe("VMAFx model preparation", () => {
	it.each([
		{ model: "vmaf_v0.6.1" },
		{ model: "vmaf_v1.0.16_3d0h.json" },
		{ model: "vmaf_v1.0.16_3d0h_modified" },
		{ model: "toString" },
		{ modelPath: undefined },
		{ modelPath: "" },
	])("requires an explicit approved v1 model file: %j", async (change) => {
		await expect(prepareVmafxModel({ ...OPTIONS, ...change })).rejects.toThrow(
			"VMAFX_REQUIRES_V1_MODEL_FILE",
		);
	});
	it.each([
		undefined,
		{ width: 0, height: 360 },
		{ width: 640, height: Number.NaN },
		{ width: 640.5, height: 360 },
	])("requires a known comparison canvas: %j", async (scaleToReference) => {
		await expect(
			prepareVmafxModel({ ...OPTIONS, scaleToReference }),
		).rejects.toThrow("VMAFX_REQUIRES_COMPARISON_GEOMETRY");
	});
	it.each([
		undefined,
		{ width: 0, height: 180, bitdepth: 8 },
		{ width: 320, height: 180.5, bitdepth: 8 },
		{ width: 320, height: 180, bitdepth: 9 },
	])("requires the original distorted CAMBI geometry: %j", async (distortedOriginal) => {
		await expect(
			prepareVmafxModel({ ...OPTIONS, distortedOriginal }),
		).rejects.toThrow("VMAFX_REQUIRES_DISTORTED_ORIGINAL");
	});
	it("rejects modified bytes and hides the model path on read failure", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bitovp-vmafx-model-"));
		const modelPath = join(dir, "private-model.json");
		try {
			await writeFile(modelPath, '{"tampered":true}');
			await expect(
				prepareVmafxModel({ ...OPTIONS, modelPath }),
			).rejects.toThrow(/^VMAFX_MODEL_SHA256_MISMATCH$/);
			await rm(modelPath);
			await expect(
				prepareVmafxModel({ ...OPTIONS, modelPath }),
			).rejects.toThrow(/^VMAFX_MODEL_UNREADABLE$/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("pins all eight SDR/HFR model hashes to the image manifest", async () => {
		const manifest = await readFile(
			new URL("../../../../docker/vmaf-models.sha256", import.meta.url),
			"utf8",
		);
		const v1 = manifest.split("\n").flatMap((line) => {
			const match =
				/^([a-f0-9]{64}) {2}(vmaf_v1\.0\.16_(?:hfr_)?(?:3d0h(?:_2160)?|5d0h|1d5h_2160))\.json$/.exec(
					line,
				);
			return match
				? [{ hash: match[1] as string, model: match[2] as string }]
				: [];
		});
		expect(v1).toHaveLength(8);
		for (const { hash, model } of v1) {
			const raw = receipt();
			raw.provenance.models[0].sha256 = hash;
			expect(
				verifyVmafxReceipt(raw, { ...EXPECTED, model, modelSha256: hash })
					.model,
			).toBe(model);
		}
	});
});

describe("VMAFx CUDA receipt verification", () => {
	it("returns only fixed safe metadata and leaves the report untouched", () => {
		const raw = receipt();
		const before = structuredClone(raw);
		expect(verifyVmafxReceipt(raw, EXPECTED)).toEqual({
			backend: "cuda",
			implementation: "vmafx",
			model: EXPECTED.model,
			modelSha256: HASH,
			bitDepth: 10,
			revision: "f69ae15fd834c71c366b64b26db5133884674e88",
			features: FEATURES,
			distortedOriginal: EXPECTED.distortedOriginal,
		});
		expect(VMAFX_REVISION).toBe("f69ae15fd834c71c366b64b26db5133884674e88");
		expect(raw).toEqual(before);
		expect(JSON.stringify(verifyVmafxReceipt(raw, EXPECTED))).not.toContain(
			"/private/",
		);
	});
	it("copies only the three validated original input fields into metadata", () => {
		const expected = {
			...EXPECTED,
			distortedOriginal: {
				...EXPECTED.distortedOriginal,
				privatePath: "/private/input/location.mp4",
			},
		};
		expect(verifyVmafxReceipt(receipt(), expected).distortedOriginal).toEqual(
			EXPECTED.distortedOriginal,
		);
	});
	it("accepts any extractor order but returns a stable order", () => {
		const raw = receipt();
		raw.feature_backends.reverse();
		expect(verifyVmafxReceipt(raw, EXPECTED).features).toEqual(FEATURES);
	});
	it("requires exactly the four v1 extractors when PSNR was not requested", () => {
		const raw = receipt();
		raw.feature_backends.pop();
		raw.provenance.n_extractors = 4;
		expect(
			verifyVmafxReceipt(raw, { ...EXPECTED, psnr: false }).features,
		).toEqual(FEATURES.slice(0, -1));
		expect(() => verifyVmafxReceipt(raw, EXPECTED)).toThrow(
			"VMAFX_RECEIPT_FEATURE_MISMATCH",
		);
		expect(() =>
			verifyVmafxReceipt(receipt(), { ...EXPECTED, psnr: false }),
		).toThrow("VMAFX_RECEIPT_FEATURE_MISMATCH");
	});
	it.each([
		null,
		[],
		{},
		{ ...receipt(), backend_used: "cpu" },
		{ ...receipt(), provenance: undefined },
	])("rejects an absent or non-CUDA receipt: %j", (raw) => {
		expect(() => verifyVmafxReceipt(raw, EXPECTED)).toThrow(/^VMAFX_RECEIPT_/);
	});
	it.each([
		["active_backend", "cpu"],
		["commit", "40e87b159d37d312066fef83047ae7c64d4ac3b4"],
		["n_extractors", 4],
		["n_models", 2],
		["gpumask", "1"],
		["gpumask", 0],
		["n_subsample", 2],
		["n_subsample", "1"],
		["frame_width", 320],
		["frame_height", 180],
		["bpc", 8],
	])("rejects mismatched provenance %s=%j", (key, value) => {
		const raw = receipt();
		Object.assign(raw.provenance, { [key as string]: value });
		expect(() => verifyVmafxReceipt(raw, EXPECTED)).toThrow(/^VMAFX_RECEIPT_/);
	});
	it.each([
		[],
		[{ extractor: "cambi_cuda", backend: "cuda" }],
		FEATURES.map((extractor) => ({ extractor, backend: "cpu" })),
		[...FEATURES, "ssim_cuda"].map((extractor) => ({
			extractor,
			backend: "cuda",
		})),
		[...FEATURES.slice(0, -1), "cambi_cuda"].map((extractor) => ({
			extractor,
			backend: "cuda",
		})),
		FEATURES.map((extractor) => ({
			extractor: extractor === "adm_cuda" ? "adm" : extractor,
			backend: "cuda",
		})),
	])("rejects incomplete, mixed, duplicate, or extra extractors: %j", (feature_backends) => {
		expect(() =>
			verifyVmafxReceipt({ ...receipt(), feature_backends }, EXPECTED),
		).toThrow("VMAFX_RECEIPT_FEATURE_MISMATCH");
	});
	it.each([
		["name", "other"],
		["sha256", "0".repeat(64)],
		["flags", "1"],
		["flags", 0],
		["overrides", ""],
		["overrides", null],
		[
			"overrides",
			"cambi.enc_width=640:cambi.enc_height=360:cambi.enc_bitdepth=10",
		],
		[
			"overrides",
			"cambi.enc_width=320:cambi.enc_height=180:cambi.enc_bitdepth=8:adm.enhn_gain_limit=1",
		],
	])("rejects model identity, flags, or override mismatch %s=%j", (key, value) => {
		const raw = receipt();
		Object.assign(raw.provenance.models[0], { [key as string]: value });
		expect(() => verifyVmafxReceipt(raw, EXPECTED)).toThrow(
			"VMAFX_RECEIPT_MODEL_MISMATCH",
		);
	});
	it.each([
		undefined,
		[],
		[null],
		[{ name: "vmaf" }],
	])("rejects a missing model receipt: %j", (models) => {
		const raw = receipt();
		Object.assign(raw.provenance, { models });
		expect(() => verifyVmafxReceipt(raw, EXPECTED)).toThrow(
			"VMAFX_RECEIPT_MODEL_MISMATCH",
		);
	});
	it("rejects extra models even with a matching first model", () => {
		const raw = receipt();
		raw.provenance.models.push({ ...raw.provenance.models[0] });
		expect(() => verifyVmafxReceipt(raw, EXPECTED)).toThrow(
			"VMAFX_RECEIPT_MODEL_MISMATCH",
		);
	});
	it.each([
		0,
		"0",
		"1",
		"3",
		"02",
		"2.0",
		"9007199254740993",
		null,
	])("requires the exact positive 64-bit string frame count: %j", (n_frames) => {
		const raw = receipt();
		Object.assign(raw.provenance, { n_frames });
		expect(() => verifyVmafxReceipt(raw, EXPECTED)).toThrow(
			"VMAFX_RECEIPT_FRAME_MISMATCH",
		);
	});
	it("rejects empty, missing, skipped, duplicated, or reordered frames", () => {
		for (const frames of [
			undefined,
			[],
			receipt().frames.slice(0, 1),
			receipt().frames.toReversed(),
			[
				{ frameNum: 0, metrics: metrics(97, 42) },
				{ frameNum: 0, metrics: metrics(95, 40) },
			],
			[{ metrics: metrics(97, 42) }, { frameNum: 1, metrics: metrics(95, 40) }],
		]) {
			expect(() =>
				verifyVmafxReceipt({ ...receipt(), frames }, EXPECTED),
			).toThrow("VMAFX_RECEIPT_FRAME_MISMATCH");
		}
	});
	it.each([
		undefined,
		null,
		"97",
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("requires finite numeric VMAF on every frame: %j", (vmaf) => {
		const raw = receipt();
		Object.assign(raw.frames[1].metrics, { vmaf });
		expect(() => verifyVmafxReceipt(raw, EXPECTED)).toThrow(
			"VMAFX_RECEIPT_METRIC_MISMATCH",
		);
	});
	it.each([
		undefined,
		null,
		"40",
	])("requires numeric PSNR on every requested frame: %j", (psnr_y) => {
		const raw = receipt();
		Object.assign(raw.frames[1].metrics, { psnr_y });
		expect(() => verifyVmafxReceipt(raw, EXPECTED)).toThrow(
			"VMAFX_RECEIPT_METRIC_MISMATCH",
		);
	});
	it("retains the core parser's numeric PSNR capping contract", () => {
		const raw = receipt();
		raw.frames[0].metrics.psnr_y = Number.POSITIVE_INFINITY;
		expect(verifyVmafxReceipt(raw, EXPECTED).backend).toBe("cuda");
		expect(parseVmafJson(raw).frames[0]?.psnr).toBe(100);
	});
	it("accepts the HFR motion3 option suffix from the pinned report shape", () => {
		const raw = receipt();
		const hash =
			"dcfdfab1c00685c1e5f75b6f1078bb4a44c722654e4de090fa5c66784c75241b";
		raw.provenance.models[0].sha256 = hash;
		for (const frame of raw.frames) {
			const values: Record<string, unknown> = frame.metrics;
			delete values.integer_motion3_mmxv_18;
			values.integer_motion3_mffw_mmxv_18_mma = 2.2;
		}
		expect(
			verifyVmafxReceipt(raw, {
				...EXPECTED,
				model: "vmaf_v1.0.16_hfr_3d0h",
				modelSha256: hash,
			}).backend,
		).toBe("cuda");
	});
	it.each(
		FAMILY_KEYS.flatMap((key) =>
			([0, 1] as const).map((index) => ({ key, index })),
		),
	)("requires $key on boundary frame $index", ({ key, index }) => {
		const raw = receipt();
		const values: Record<string, unknown> = raw.frames[index].metrics;
		delete values[key];
		expect(() => verifyVmafxReceipt(raw, EXPECTED)).toThrow(
			"VMAFX_RECEIPT_METRIC_MISMATCH",
		);
	});
	it.each(
		FAMILY_KEYS.flatMap((key) =>
			[null, "0.99", Number.NaN, Number.POSITIVE_INFINITY].map((value) => ({
				key,
				value,
			})),
		),
	)("requires finite numeric $key=$value", ({ key, value }) => {
		const raw = receipt();
		Object.assign(raw.frames[1].metrics, { [key]: value });
		expect(() => verifyVmafxReceipt(raw, EXPECTED)).toThrow(
			"VMAFX_RECEIPT_METRIC_MISMATCH",
		);
	});
	it("does not accept the separate SPEED chroma U/V metrics in place of UV", () => {
		const raw = receipt();
		const values: Record<string, unknown> = raw.frames[1].metrics;
		delete values[FAMILY_KEYS[1]];
		values["speed_chroma_u_mxv_45_nnf_0.1_snn_0.19_wvm_5"] = 0.00001;
		values["speed_chroma_v_mxv_45_nnf_0.1_snn_0.19_wvm_5"] = 0.00001;
		expect(() => verifyVmafxReceipt(raw, EXPECTED)).toThrow(
			"VMAFX_RECEIPT_METRIC_MISMATCH",
		);
	});
	it.each(
		["psnr_y", "psnr_cb", "psnr_cr"].flatMap((key) =>
			[undefined, null, "40", Number.NaN].map((value) => ({ key, value })),
		),
	)("requires each requested PSNR channel to be numeric and non-NaN: $key=$value", ({
		key,
		value,
	}) => {
		const raw = receipt();
		Object.assign(raw.frames[1].metrics, { [key]: value });
		expect(() => verifyVmafxReceipt(raw, EXPECTED)).toThrow(
			"VMAFX_RECEIPT_METRIC_MISMATCH",
		);
	});
	it.each([
		{ model: "vmaf_v0.6.1" },
		{ modelSha256: "0".repeat(64) },
		{ width: 0 },
		{ height: Number.NaN },
		{ distortedOriginal: { width: 320, height: 180, bitdepth: 9 } },
	])("rejects an invalid expected identity or geometry: %j", (change) => {
		expect(() =>
			verifyVmafxReceipt(receipt(), { ...EXPECTED, ...change }),
		).toThrow("VMAFX_RECEIPT_EXPECTATION_INVALID");
	});
});
