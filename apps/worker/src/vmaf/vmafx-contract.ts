import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { VmafCommandOptions } from "@bitovp/core";

/** External implementation pin; receipt validation does not establish CPU parity. */
export const VMAFX_REVISION = "f69ae15fd834c71c366b64b26db5133884674e88";

// Same bytes as docker/vmaf-models.sha256 at the existing Netflix model pin.
// The manifest drift test must pass before changing either side of this contract.
const MODEL_SHA256: Readonly<Record<string, string>> = Object.freeze({
	"vmaf_v1.0.16_3d0h":
		"e4cf8c147e1368b35497d772920bc92f98c1ad7853c1033d8a836947f427140e",
	"vmaf_v1.0.16_3d0h_2160":
		"77f552fd8d5b6c6a2166bfc4470c9368ec68d2425ed40f1cc235b0cc500f33c2",
	"vmaf_v1.0.16_5d0h":
		"64e12d9c1e4ed5d79da7fa515b82fac7247a9e2ccc91e0ebce31d05489500385",
	"vmaf_v1.0.16_1d5h_2160":
		"634d36e0502cb797384726cdd1a106a2c207827595a9e4958d3dae1bd517b139",
	"vmaf_v1.0.16_hfr_3d0h":
		"dcfdfab1c00685c1e5f75b6f1078bb4a44c722654e4de090fa5c66784c75241b",
	"vmaf_v1.0.16_hfr_3d0h_2160":
		"1bc502f00aeee11433e2d09468186bbf1bbce56ee650c9bade06c7435ebdd4db",
	"vmaf_v1.0.16_hfr_5d0h":
		"590f612c87df94badca58e563b318fa9958eac631ab8aadd73bff8cc1adfc515",
	"vmaf_v1.0.16_hfr_1d5h_2160":
		"0371db55d3de81a760125f6d65eb4386f1d38af6cf1d00c2f48158e3596246d4",
});
const V1_EXTRACTORS = [
	"cambi_cuda",
	"speed_chroma_cuda",
	"adm_cuda",
	"motion_cuda",
] as const;

type DistortedOriginal = {
	width: number;
	height: number;
	bitdepth: 8 | 10 | 12 | 16;
};
type ExpectedReceipt = {
	model: string;
	modelSha256: string;
	width: number;
	height: number;
	psnr: boolean;
	distortedOriginal: { width: number; height: number; bitdepth: number };
};
type VerifiedScoring = {
	backend: "cuda";
	implementation: "vmafx";
	model: string;
	modelSha256: string;
	bitDepth: 10;
	revision: typeof VMAFX_REVISION;
	features: string[];
	distortedOriginal: DistortedOriginal;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasDimensions(
	value: unknown,
): value is { width: number; height: number } {
	return (
		isRecord(value) &&
		[value.width, value.height].every(
			(dimension) =>
				typeof dimension === "number" &&
				Number.isSafeInteger(dimension) &&
				dimension > 0,
		)
	);
}

function hasDistortedOriginal(value: unknown): value is DistortedOriginal {
	return (
		isRecord(value) &&
		typeof value.bitdepth === "number" &&
		[8, 10, 12, 16].includes(value.bitdepth) &&
		hasDimensions(value)
	);
}

function approvedHash(model: string): string | undefined {
	return Object.hasOwn(MODEL_SHA256, model) ? MODEL_SHA256[model] : undefined;
}

/** Option suffixes vary by SDR/HFR model, but these four score families do not.
 * Check each frame's metrics once; do not allocate another full-frame report. */
function hasV1MetricFamilies(metrics: Record<string, unknown>): boolean {
	let present = 0;
	for (const key of Object.keys(metrics)) {
		const value = metrics[key];
		if (typeof value !== "number" || !Number.isFinite(value)) continue;
		if (key === "cambi" || key.startsWith("cambi_")) present |= 1;
		else if (key === "speed_chroma_uv" || key.startsWith("speed_chroma_uv_"))
			present |= 2;
		else if (key === "integer_adm3" || key.startsWith("integer_adm3_"))
			present |= 4;
		else if (key === "integer_motion3" || key.startsWith("integer_motion3_"))
			present |= 8;
	}
	return present === 15;
}

/** Read the requested file as bytes; never replace a model to obtain CUDA support. */
export async function prepareVmafxModel(
	options: VmafCommandOptions,
): Promise<{ modelSha256: string }> {
	const expectedHash = approvedHash(options.model);
	if (
		!expectedHash ||
		typeof options.modelPath !== "string" ||
		!options.modelPath.trim()
	)
		throw new Error("VMAFX_REQUIRES_V1_MODEL_FILE");
	if (!hasDimensions(options.scaleToReference))
		throw new Error("VMAFX_REQUIRES_COMPARISON_GEOMETRY");
	if (!hasDistortedOriginal(options.distortedOriginal))
		throw new Error("VMAFX_REQUIRES_DISTORTED_ORIGINAL");
	let bytes: Buffer;
	try {
		bytes = await readFile(options.modelPath);
	} catch {
		throw new Error("VMAFX_MODEL_UNREADABLE");
	}
	const modelSha256 = createHash("sha256").update(bytes).digest("hex");
	if (modelSha256 !== expectedHash)
		throw new Error("VMAFX_MODEL_SHA256_MISMATCH");
	return { modelSha256 };
}

/** Validate in place without copying the potentially large full-frame report.
 * Pinned VMAFx serializes uint64 fields as decimal strings, not JSON numbers. */
export function verifyVmafxReceipt(
	raw: unknown,
	expected: ExpectedReceipt,
): VerifiedScoring {
	const modelHash = approvedHash(expected.model);
	if (
		!modelHash ||
		modelHash !== expected.modelSha256 ||
		!hasDimensions(expected) ||
		!hasDistortedOriginal(expected.distortedOriginal) ||
		typeof expected.psnr !== "boolean"
	)
		throw new Error("VMAFX_RECEIPT_EXPECTATION_INVALID");
	if (
		!isRecord(raw) ||
		raw.backend_used !== "cuda" ||
		!isRecord(raw.provenance)
	)
		throw new Error("VMAFX_RECEIPT_BACKEND_MISMATCH");
	const provenance = raw.provenance;
	if (provenance.active_backend !== "cuda")
		throw new Error("VMAFX_RECEIPT_BACKEND_MISMATCH");
	if (provenance.commit !== VMAFX_REVISION)
		throw new Error("VMAFX_RECEIPT_REVISION_MISMATCH");
	const features: string[] = [
		...V1_EXTRACTORS,
		...(expected.psnr ? ["psnr_cuda"] : []),
	];
	if (
		!Array.isArray(raw.feature_backends) ||
		raw.feature_backends.length !== features.length ||
		provenance.n_extractors !== features.length
	)
		throw new Error("VMAFX_RECEIPT_FEATURE_MISMATCH");
	const remaining = new Set(features);
	for (const feature of raw.feature_backends) {
		if (
			!isRecord(feature) ||
			feature.backend !== "cuda" ||
			typeof feature.extractor !== "string" ||
			!remaining.delete(feature.extractor)
		)
			throw new Error("VMAFX_RECEIPT_FEATURE_MISMATCH");
	}
	if (
		provenance.gpumask !== "0" ||
		provenance.n_subsample !== 1 ||
		provenance.bpc !== 10 ||
		provenance.frame_width !== expected.width ||
		provenance.frame_height !== expected.height ||
		provenance.n_models !== 1
	)
		throw new Error("VMAFX_RECEIPT_PROVENANCE_MISMATCH");
	const original = expected.distortedOriginal;
	const overrides = `cambi.enc_width=${original.width}:cambi.enc_height=${original.height}:cambi.enc_bitdepth=${original.bitdepth}`;
	const models = provenance.models;
	if (
		!Array.isArray(models) ||
		models.length !== 1 ||
		!isRecord(models[0]) ||
		models[0].name !== "vmaf" ||
		models[0].sha256 !== expected.modelSha256 ||
		models[0].flags !== "0" ||
		models[0].overrides !== overrides
	)
		throw new Error("VMAFX_RECEIPT_MODEL_MISMATCH");
	const frames = raw.frames;
	if (
		!Array.isArray(frames) ||
		frames.length === 0 ||
		provenance.n_frames !== String(frames.length)
	)
		throw new Error("VMAFX_RECEIPT_FRAME_MISMATCH");
	for (let index = 0; index < frames.length; index++) {
		const frame: unknown = frames[index];
		if (!isRecord(frame) || frame.frameNum !== index)
			throw new Error("VMAFX_RECEIPT_FRAME_MISMATCH");
		const metrics = frame.metrics;
		if (
			!isRecord(metrics) ||
			typeof metrics.vmaf !== "number" ||
			!Number.isFinite(metrics.vmaf) ||
			!hasV1MetricFamilies(metrics) ||
			(expected.psnr &&
				["psnr_y", "psnr_cb", "psnr_cr"].some(
					(key) =>
						typeof metrics[key] !== "number" || Number.isNaN(metrics[key]),
				))
		)
			throw new Error("VMAFX_RECEIPT_METRIC_MISMATCH");
	}
	return {
		backend: "cuda",
		implementation: "vmafx",
		model: expected.model,
		modelSha256: expected.modelSha256,
		bitDepth: 10,
		revision: VMAFX_REVISION,
		features,
		distortedOriginal: {
			width: original.width,
			height: original.height,
			bitdepth: original.bitdepth,
		},
	};
}
