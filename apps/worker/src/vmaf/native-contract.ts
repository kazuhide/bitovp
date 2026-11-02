import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	type LocalVmafExecution,
	NATIVE_OFFICIAL_REVISION,
	nativeVmafReceiptSchema,
} from "@bitovp/core";

export { NATIVE_OFFICIAL_REVISION } from "@bitovp/core";
// Official model bytes remain pinned independently of the native source build.
export const NATIVE_MODEL_SHA256: Readonly<Record<string, string>> =
	Object.freeze({
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

export async function hashNativeFile(
	path: string,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	const hash = createHash("sha256");
	for await (const bytes of createReadStream(path, { signal }))
		hash.update(bytes);
	signal?.throwIfAborted();
	return hash.digest("hex");
}

export async function prepareNativeModel(
	options: { model: string; modelPath?: string },
	signal?: AbortSignal,
) {
	const approved = Object.hasOwn(NATIVE_MODEL_SHA256, options.model)
		? NATIVE_MODEL_SHA256[options.model]
		: undefined;
	if (!approved || !options.modelPath?.trim())
		throw new Error("NATIVE_REQUIRES_PINNED_V1_MODEL_FILE");
	let actual: string;
	try {
		actual = await hashNativeFile(options.modelPath, signal);
	} catch (error) {
		signal?.throwIfAborted();
		throw new Error("NATIVE_MODEL_UNREADABLE", { cause: error });
	}
	if (actual !== approved) throw new Error("NATIVE_MODEL_SHA256_MISMATCH");
	return { modelSha256: actual };
}

export function nativeSourceFromVersion(stdout: string): string {
	const version =
		/^bitovp-vmaf 0\.1 owned CUDA\/Vulkan; official=([a-f0-9]{40}); source=([a-f0-9]{64})\s*$/.exec(
			stdout,
		);
	const source = version?.[2];
	if (!version || version[1] !== NATIVE_OFFICIAL_REVISION || !source)
		throw new Error("NATIVE_BINARY_REVISION_MISMATCH");
	return source;
}

export type NativeExpected = {
	model: string;
	modelSha256: string;
	backend: "cuda" | "vulkan";
	device: number;
	sourceSha256: string;
	width: number;
	height: number;
	distortedOriginal: { width: number; height: number; bitdepth: number };
	referenceSha256: string;
	distortedSha256: string;
	frameCount?: number;
	psnr: boolean;
};
type OwnedScoring = Extract<
	LocalVmafExecution["scoring"],
	{ implementation: "bitovp-owned" }
>;
const fail = (code: string): never => {
	throw new Error(`NATIVE_RECEIPT_${code}`);
};
const families: Record<string, RegExp> = {
	cambi: /^(?:cambi(?:_|$)|Cambi_feature_cambi_score$)/,
	speed_chroma:
		/^(?:speed_chroma_uv(?:_|$)|Speed_chroma_feature_speed_chroma_uv_score$)/,
	adm: /^(?:integer_adm3(?:_|$)|VMAF_integer_feature_adm3_score$)/,
	motion: /^(?:integer_motion3(?:_|$)|VMAF_integer_feature_motion3_score$)/,
};

/** A receipt is accepted only for this invocation's inputs, model, device and
 * source build. Runtime CPU comparison remains mandatory until qualification
 * manifests replace it. This parser never authorizes a different runner. */
export function verifyNativeReceipt(
	raw: unknown,
	expected: NativeExpected,
): {
	scoring: OwnedScoring;
	log: {
		frames: { frameNum: number; metrics: { vmaf: number; psnr_y?: number } }[];
		pooled_metrics: {
			vmaf: { min: number; max: number; mean: number; harmonic_mean: number };
		};
	};
} {
	const parsed = nativeVmafReceiptSchema.safeParse(raw);
	if (!parsed.success) return fail("SCHEMA_MISMATCH");
	const report = parsed.data;
	if (
		report.backend !== expected.backend ||
		report.sourceSha256 !== expected.sourceSha256 ||
		report.width !== expected.width ||
		report.height !== expected.height ||
		report.referenceSha256 !== expected.referenceSha256 ||
		report.distortedSha256 !== expected.distortedSha256 ||
		report.distortedOriginal.width !== expected.distortedOriginal.width ||
		report.distortedOriginal.height !== expected.distortedOriginal.height ||
		report.distortedOriginal.bitdepth !== expected.distortedOriginal.bitdepth
	)
		return fail("PROVENANCE_MISMATCH");
	if (
		report.requestedDeviceIndex !== expected.device ||
		report.device.index !== expected.device ||
		report.device.vendorId !== (expected.backend === "cuda" ? 0x10de : 0x1002)
	)
		return fail("DEVICE_MISMATCH");
	const [model] = report.models;
	if (!model) return fail("MODEL_MISMATCH");
	if (
		model.id !== expected.model ||
		model.sha256 !== expected.modelSha256 ||
		NATIVE_MODEL_SHA256[expected.model] !== expected.modelSha256
	)
		return fail("MODEL_MISMATCH");
	if (
		(expected.frameCount !== undefined &&
			report.frames !== expected.frameCount) ||
		model.frames.length !== report.frames
	)
		return fail("FRAME_MISMATCH");
	const required = new Set<string>();
	const providers = new Set<string>();
	for (const extractor of report.extractors) {
		const family = Object.hasOwn(families, extractor.name)
			? families[extractor.name]
			: undefined;
		const [featureName] = extractor.features;
		if (providers.has(extractor.name)) return fail("FEATURE_MISMATCH");
		providers.add(extractor.name);
		if (extractor.name === "psnr") {
			if (
				extractor.features.length !== 3 ||
				["psnr_y", "psnr_cb", "psnr_cr"].some(
					(name) => !extractor.features.includes(name),
				)
			)
				return fail("FEATURE_MISMATCH");
		} else if (
			!family ||
			!featureName ||
			extractor.features.length !== 1 ||
			!family.test(featureName)
		)
			return fail("FEATURE_MISMATCH");
		for (const name of extractor.features) {
			if (required.has(name)) return fail("FEATURE_MISMATCH");
			required.add(name);
		}
	}
	if (
		required.size !== 7 ||
		report.features.length !== required.size * report.frames ||
		report.cpuParity.featureCount !== report.features.length ||
		report.cpuParity.scoreCount !== report.frames
	)
		return fail("FEATURE_MISMATCH");
	const seen = new Set<string>(),
		psnr = new Map<number, number>();
	let largest = 0;
	for (const feature of report.features) {
		const key = `${feature.index}\0${feature.name}`;
		if (
			feature.index >= report.frames ||
			!required.has(feature.name) ||
			seen.has(key)
		)
			return fail("FEATURE_MISMATCH");
		seen.add(key);
		largest = Math.max(largest, Math.abs(feature.value));
		if (feature.name === "psnr_y") psnr.set(feature.index, feature.value);
	}
	if (report.cpuParity.maxFeatureError > 1e-6 + (1e-7 * largest) / (1 - 1e-7))
		return fail("CPU_PARITY_MISMATCH");
	let minimum = Infinity,
		maximum = -Infinity,
		sum = 0,
		inverse = 0;
	for (const value of model.frames) {
		if (value < 0 || value > 110) return fail("SCORE_MISMATCH");
		minimum = Math.min(minimum, value);
		maximum = Math.max(maximum, value);
		sum += value;
		inverse += 1 / (value + 1);
	}
	const derived = {
		min: minimum,
		max: maximum,
		mean: sum / report.frames,
		harmonicMean: report.frames / inverse - 1,
	};
	for (const key of ["min", "max", "mean", "harmonicMean"] as const)
		if (Math.abs(model.pooled[key] - derived[key]) > 1e-9)
			return fail("POOLING_MISMATCH");
	const { memoryBudgetBytes: _memoryBudget, ...device } = report.device;
	return {
		scoring: {
			backend: report.backend,
			implementation: "bitovp-owned",
			model: model.id,
			modelSha256: model.sha256,
			features: [...required].sort(),
			bitDepth: 10,
			distortedOriginal: report.distortedOriginal,
			officialRevision: report.officialRevision,
			sourceSha256: report.sourceSha256,
			device,
			cpuParity: report.cpuParity,
		},
		log: {
			frames: model.frames.map((vmaf, frameNum) => {
				const psnrY = psnr.get(frameNum);
				if (expected.psnr && psnrY === undefined)
					return fail("FEATURE_MISMATCH");
				return {
					frameNum,
					metrics: { vmaf, ...(expected.psnr ? { psnr_y: psnrY } : {}) },
				};
			}),
			pooled_metrics: {
				vmaf: {
					min: model.pooled.min,
					max: model.pooled.max,
					mean: model.pooled.mean,
					harmonic_mean: model.pooled.harmonicMean,
				},
			},
		},
	};
}
