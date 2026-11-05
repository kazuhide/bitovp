import { readFile, rm } from "node:fs/promises";
import { NATIVE_OFFICIAL_REVISION, nativeDeviceInfoSchema } from "@bitovp/core";
import {
	BANDING_DECISION_PRECISION,
	canonicalBandingScore,
} from "@bitovp/core/banding";
import { z } from "zod";
import type { ProcessRunner } from "../feeder/supervisor";
import {
	assertBandingGpuGeometry,
	type BandingTiming,
	type MeasuredBandingFrame,
	probeBandingTiming,
} from "./banding-score";
import type { NativeLocalSelection } from "./local-selection";
import { resolveNativeExecutable } from "./native-auto-device";
import { hashNativeFile } from "./native-contract";

const nonnegative = z.number().finite().nonnegative();
const count = nonnegative.int().safe();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const capabilitySchema = z.strictObject({
	schemaVersion: z.literal(1),
	kind: z.literal("bitovp-native-capabilities"),
	sourceSha256: sha,
	binarySha256: sha,
	officialSourceRevision: z.literal(NATIVE_OFFICIAL_REVISION),
	metrics: z
		.array(z.enum(["VMAF_V1", "CAMBI_NR"]))
		.min(1)
		.max(2),
	backends: z
		.array(z.enum(["cpu", "cuda", "vulkan"]))
		.min(1)
		.max(3),
	bandingReceiptSchemaVersion: z.literal(1),
});
const receiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	metric: z.literal("CAMBI_NR"),
	implementation: z.literal("bitovp-owned"),
	officialSourceRevision: z.literal(NATIVE_OFFICIAL_REVISION),
	sourceSha256: sha,
	binarySha256: sha,
	supervisorBinarySha256: sha,
	backend: z.enum(["cuda", "vulkan"]),
	decodeBackend: z.literal("cpu"),
	cpuThreads: count.positive().max(256),
	decodeThreads: count.positive().max(256),
	inflightFrames: z.literal(1),
	requestedDeviceIndex: count.max(256),
	input: z.strictObject({
		sha256: sha,
		width: count.positive(),
		height: count.positive(),
		bitDepth: z.union([z.literal(8), z.literal(10)]),
	}),
	extractor: z.strictObject({
		name: z.literal("cambi"),
		featureName: z.string().min(1),
		options: z.record(z.string(), z.string()),
	}),
	device: nativeDeviceInfoSchema.shape.device,
	coverage: z.strictObject({
		complete: z.literal(true),
		decodedFrames: count.positive(),
		scoredFrames: count.positive(),
		startTimeSeconds: z.literal(0),
		endTimeSeconds: nonnegative.positive(),
		timingSource: z.literal("PRESENTATION_TIMESTAMPS_AND_FRAME_DURATION"),
	}),
	frames: z
		.array(
			z.strictObject({
				index: count,
				timeSeconds: nonnegative,
				durationSeconds: nonnegative.positive(),
				rawScore: nonnegative,
				cpuReferenceScore: nonnegative,
			}),
		)
		.min(1),
	cpuParity: z.strictObject({
		checked: z.literal(true),
		frameCount: count.positive(),
		maxAbsoluteError: nonnegative,
		absoluteTolerance: z.literal(1e-6),
		relativeTolerance: z.literal(1e-7),
	}),
	timingMs: z.strictObject({
		wall: nonnegative,
		initialize: nonnegative,
		decode: nonnegative,
		conform: nonnegative,
		extract: nonnegative,
		cpuReference: nonnegative,
		finish: nonnegative,
		upload: nonnegative,
		kernel: nonnegative,
		download: nonnegative,
		cpuPostprocess: nonnegative,
	}),
	extractorKernelMs: z.record(
		z
			.string()
			.max(32)
			.regex(/^cambi(?:\.stage\.\d+)?$/),
		nonnegative,
	),
	memory: z.strictObject({
		maxRssBytes: count.positive(),
		gpuAllocatedBytes: count.positive(),
		hostCopiedInputBytes: count,
		hostReadbackBytes: count,
		deviceCopyBytes: count,
	}),
	resourceSnapshotScope: z.literal("before-result-serialization"),
});

export function officialCambiOptions(input: {
	width: number;
	height: number;
	bitDepth: number;
}) {
	return {
		cambi_eotf: "bt1886",
		cambi_high_res_speedup: "0",
		cambi_max_val: "1000",
		cambi_topk: "0.59999999999999998",
		cambi_vis_lum_threshold: "0",
		enc_bitdepth: String(input.bitDepth),
		enc_height: String(input.height),
		enc_width: String(input.width),
		eotf: "bt1886",
		full_ref: "false",
		heatmaps_path: "",
		max_log_contrast: "2",
		src_height: "0",
		src_width: "0",
		topk: "0.59999999999999998",
		tvi_threshold: "0.019",
		window_size: "65",
	};
}
const equalMap = (
	first: Record<string, string>,
	second: Record<string, string>,
) =>
	JSON.stringify(Object.entries(first).sort()) ===
	JSON.stringify(Object.entries(second).sort());
export function verifyBandingCapabilities(
	raw: unknown,
	selected: NativeLocalSelection,
): boolean {
	const parsed = capabilitySchema.safeParse(raw);
	if (!parsed.success) throw new Error("BANDING_CAPABILITY_SCHEMA");
	const report = parsed.data;
	if (
		report.sourceSha256 !== selected.identity.sourceSha256 ||
		report.binarySha256 !== selected.identity.binarySha256
	)
		throw new Error("BANDING_CAPABILITY_BUILD_MISMATCH");
	if (
		new Set(report.metrics).size !== report.metrics.length ||
		new Set(report.backends).size !== report.backends.length
	)
		throw new Error("BANDING_CAPABILITY_SCHEMA");
	return (
		report.metrics.includes("CAMBI_NR") &&
		report.backends.includes(selected.backend)
	);
}
export type BandingNativeExpected = {
	selected: NativeLocalSelection;
	inputSha256: string;
	width: number;
	height: number;
	bitDepth: number;
	timing: BandingTiming[];
	threads: number;
	decodeThreads: number;
};

export function verifyBandingReceipt(
	raw: unknown,
	expected: BandingNativeExpected,
) {
	assertBandingGpuGeometry(expected);
	const parsed = receiptSchema.safeParse(raw);
	if (!parsed.success) throw new Error("BANDING_RECEIPT_SCHEMA");
	const report = parsed.data,
		selected = expected.selected;
	if (
		report.sourceSha256 !== selected.identity.sourceSha256 ||
		report.binarySha256 !== selected.identity.binarySha256 ||
		report.supervisorBinarySha256 !==
			selected.identity.supervisorBinarySha256 ||
		report.backend !== selected.backend ||
		report.requestedDeviceIndex !== selected.device ||
		report.device.index !== selected.device ||
		report.device.uuid !== selected.identity.deviceUuid ||
		report.device.vendorId !==
			(selected.backend === "cuda" ? 0x10de : 0x1002) ||
		report.input.sha256 !== expected.inputSha256 ||
		report.input.width !== expected.width ||
		report.input.height !== expected.height ||
		report.input.bitDepth !== expected.bitDepth ||
		report.cpuThreads !== expected.threads ||
		report.decodeThreads !== expected.decodeThreads
	)
		throw new Error("BANDING_RECEIPT_IDENTITY");
	if (
		!equalMap(report.extractor.options, officialCambiOptions(expected)) ||
		report.extractor.featureName !==
			`cambi_encbd_${expected.bitDepth}_ench_${expected.height}_encw_${expected.width}`
	)
		throw new Error("BANDING_RECEIPT_EXTRACTOR_OPTIONS");
	const total = expected.timing.length;
	if (
		!total ||
		report.frames.length !== total ||
		report.coverage.decodedFrames !== total ||
		report.coverage.scoredFrames !== total ||
		report.cpuParity.frameCount !== total
	)
		throw new Error("BANDING_RECEIPT_COVERAGE");
	let maxError = 0;
	const frames: MeasuredBandingFrame[] = report.frames.map((frame, index) => {
		const time = expected.timing[index];
		if (
			!time ||
			frame.index !== index ||
			Math.abs(frame.timeSeconds - time.timestampSeconds) > 1e-7 ||
			Math.abs(frame.durationSeconds - time.durationSeconds) > 1e-7
		)
			throw new Error("BANDING_RECEIPT_TIMING");
		const error = Math.abs(frame.rawScore - frame.cpuReferenceScore);
		if (error > 1e-6 + 1e-7 * Math.abs(frame.cpuReferenceScore))
			throw new Error("BANDING_RECEIPT_PARITY");
		maxError = Math.max(maxError, error);
		return {
			...time,
			cambi: canonicalBandingScore(frame.cpuReferenceScore),
			cpuReferenceCambi: frame.cpuReferenceScore,
			computedCambi: frame.rawScore,
		};
	});
	const last = frames[total - 1];
	if (
		!last ||
		Math.abs(
			report.coverage.endTimeSeconds -
				last.timestampSeconds -
				last.durationSeconds,
		) > 1e-7 ||
		Math.abs(report.cpuParity.maxAbsoluteError - maxError) > 1e-12
	)
		throw new Error("BANDING_RECEIPT_COVERAGE_OR_PARITY");
	const { frames: _frames, ...metadata } = report;
	return {
		frames,
		execution: {
			...metadata,
			version: 1 as const,
			scoringVersion: 1,
			decisionSource: "CPU_REFERENCE" as const,
			decisionPrecision: BANDING_DECISION_PRECISION,
		},
	};
}

export async function bandingNativeAvailable(
	deps: { runner: ProcessRunner; nativePath: string },
	selected: NativeLocalSelection,
	signal: AbortSignal,
) {
	const executable = await resolveNativeExecutable(deps.nativePath);
	if (
		(await hashNativeFile(executable, signal)) !==
		selected.identity.binarySha256
	)
		throw new Error("BANDING_CAPABILITY_BUILD_MISMATCH");
	const run = await deps.runner.run(deps.nativePath, ["--capabilities"], {
		signal,
		abortKillAfterMs: 250,
	});
	signal.throwIfAborted();
	if (run.code !== 0) {
		if (
			/unknown|unrecognized|unsupported/i.test(run.stderr) &&
			run.stderr.includes("--capabilities")
		)
			return false;
		throw new Error("BANDING_CAPABILITY_UNAVAILABLE");
	}
	return verifyBandingCapabilities(JSON.parse(run.stdout), selected);
}

export async function runNativeBandingScore(
	deps: { runner: ProcessRunner; nativePath: string; ffprobePath: string },
	input: string,
	receiptPath: string,
	expected: Omit<BandingNativeExpected, "timing">,
	signal: AbortSignal,
) {
	try {
		assertBandingGpuGeometry(expected);
		const timing = await probeBandingTiming(deps, input, signal, expected);
		if ((await hashNativeFile(input, signal)) !== expected.inputSha256)
			throw new Error("BANDING_INPUT_CHANGED");
		if (!(await bandingNativeAvailable(deps, expected.selected, signal)))
			throw new Error("BANDING_NATIVE_UNAVAILABLE");
		await rm(receiptPath, { force: true });
		const selected = expected.selected;
		const run = await deps.runner.run(
			deps.nativePath,
			[
				"--metric",
				"cambi",
				"--distorted",
				input,
				"--output",
				receiptPath,
				"--backend",
				selected.backend,
				"--vendor",
				selected.backend === "cuda" ? "nvidia" : "amd",
				"--device",
				String(selected.device),
				"--threads",
				String(expected.threads),
				"--decode-threads",
				String(expected.decodeThreads),
				"--verify-cpu",
			],
			{ signal, abortKillAfterMs: 250 },
		);
		signal.throwIfAborted();
		if (run.code !== 0)
			throw new Error(`BANDING_NATIVE_SCORING_FAILED (${run.code})`);
		if ((await hashNativeFile(input, signal)) !== expected.inputSha256)
			throw new Error("BANDING_INPUT_CHANGED");
		return verifyBandingReceipt(
			JSON.parse(await readFile(receiptPath, "utf8")),
			{ ...expected, timing },
		);
	} finally {
		await rm(receiptPath, { force: true });
	}
}
