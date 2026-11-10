import { readFile, rm, writeFile } from "node:fs/promises";
import {
	localVmafExecutionSchema,
	sampleAspectRatioFromProbe,
	type VmafCommandOptions,
} from "@bitovp/core";
import type { ProcessRunner } from "../feeder/supervisor";
import { parseFrameRate } from "./geometry";
import {
	type DecodePolicy,
	presentationTransformReason,
} from "./hardware-decode";
import {
	hashNativeFile,
	nativeSourceFromVersion,
	prepareNativeModel,
	verifyNativeReceipt,
} from "./native-contract";
import { resourceVideoFromProbe } from "./resource-plan";

export type NativeScoreContext = {
	signal?: AbortSignal;
	referenceProbe?: string;
	distortedProbe?: string;
	/** Binds an explicitly prepared reference's verified bytes to native scoring. */
	expectedReferenceSha256?: string;
	/** Internal scheduling controls; never alter a completed measurement's frame set. */
	nativeInflightFrames?: 1 | 2 | 4;
	/** Calibration-only prefix, written only to the caller's disposable directory. */
	calibrationFrames?: number;
};
export type NativeResourceSnapshot = {
	maxRssBytes: number;
	gpuOwnedBytes: number;
	scope: "before-result-serialization";
};

function probeInput(text: string) {
	let parsed: { streams?: Record<string, unknown>[] };
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("NATIVE_UNSUPPORTED_PROBE");
	}
	const videos = Array.isArray(parsed?.streams)
		? parsed.streams.filter((stream) => stream?.codec_type === "video")
		: [];
	const [video] = videos;
	if (videos.length !== 1 || !video)
		throw new Error("NATIVE_UNSUPPORTED_VIDEO_STREAM_SELECTION");
	if (presentationTransformReason(video))
		throw new Error("NATIVE_UNSUPPORTED_PRESENTATION_TRANSFORM");
	const sar = sampleAspectRatioFromProbe(video.sample_aspect_ratio);
	if (sar !== undefined && sar !== "1:1")
		throw new Error("NATIVE_UNSUPPORTED_SAMPLE_ASPECT_RATIO");
	if (
		["smpte2084", "arib-std-b67", "smpte428"].includes(
			String(video.color_transfer),
		) ||
		String(video.color_primaries).startsWith("bt2020") ||
		String(video.color_space).startsWith("bt2020")
	)
		throw new Error("NATIVE_UNSUPPORTED_HDR_COLOR");
	const metadata = resourceVideoFromProbe(text);
	if (
		!metadata.bitDepth ||
		![8, 10, 12, 16].includes(metadata.bitDepth) ||
		![metadata.width, metadata.height].every(
			(value) => Number.isSafeInteger(value) && value > 0 && value <= 16384,
		)
	)
		throw new Error("NATIVE_UNSUPPORTED_INPUT_FORMAT");
	const rate =
		parseFrameRate(
			typeof video.avg_frame_rate === "string"
				? video.avg_frame_rate
				: undefined,
		) ??
		parseFrameRate(
			typeof video.r_frame_rate === "string" ? video.r_frame_rate : undefined,
		);
	if (!rate) throw new Error("NATIVE_UNSUPPORTED_FRAME_RATE");
	return { ...metadata, rate };
}

/** Initial owned path deliberately has no implicit CPU fallback or geometry,
 * cadence, crop, rotation, or method substitution. The native runner checks
 * decoded frame counts, timestamp drift, and GPU/CPU numerical parity again. */
export async function runNativeVmafScore(
	deps: {
		runner: ProcessRunner;
		ffprobePath: string;
		nativePath?: string;
		decodePolicy?: DecodePolicy;
	},
	options: VmafCommandOptions,
	context: NativeScoreContext,
) {
	const { signal } = context,
		scoring = options.scoring;
	signal?.throwIfAborted();
	const frameLimit = context.calibrationFrames;
	if (
		frameLimit !== undefined &&
		(!Number.isSafeInteger(frameLimit) || frameLimit < 1 || frameLimit > 256)
	)
		throw new Error("NATIVE_CALIBRATION_FRAME_LIMIT_INVALID");
	if (
		context.nativeInflightFrames !== undefined &&
		![1, 2, 4].includes(context.nativeInflightFrames)
	)
		throw new Error("NATIVE_PIPELINE_DEPTH_INVALID");
	if ((scoring as { backend?: string } | undefined)?.backend === "vmafx-cuda")
		throw new Error(
			"VMAFx scoring is retired; select cuda or vulkan and create a new measurement",
		);
	if (
		!scoring ||
		!["cuda", "vulkan"].includes(scoring.backend) ||
		!Number.isSafeInteger(scoring.device) ||
		scoring.device < 0 ||
		scoring.device > 256
	)
		throw new Error("NATIVE_UNSUPPORTED_SCORING_OPTIONS");
	if (!deps.nativePath?.trim()) throw new Error("NATIVE_PATH_REQUIRED");
	if ((deps.decodePolicy?.backend ?? "cpu") !== "cpu" || options.decode)
		throw new Error("NATIVE_UNSUPPORTED_HARDWARE_DECODE");
	if (
		(options.subsample ?? 1) !== 1 ||
		options.fpsConform !== undefined ||
		(options.alignFrames ?? 0) !== 0 ||
		options.measurementMethod ||
		options.filterComplexThreads !== undefined ||
		options.features?.some((name) => name !== "psnr")
	)
		throw new Error("NATIVE_UNSUPPORTED_TRANSFORM_OR_FEATURE");
	const size = options.scaleToReference;
	if (
		!size ||
		![size.width, size.height].every(
			(value) =>
				Number.isSafeInteger(value) &&
				value > 0 &&
				value <= 16384 &&
				value % 2 === 0,
		)
	)
		throw new Error("NATIVE_UNSUPPORTED_COMPARISON_GEOMETRY");
	for (const value of [options.threads ?? 1, options.decoderThreads ?? 1])
		if (!Number.isSafeInteger(value) || value < 1 || value > 256)
			throw new Error("NATIVE_UNSUPPORTED_THREADS");
	const probe = async (path: string, existing: string | undefined) => {
		if (existing !== undefined) return existing;
		const result = await deps.runner.run(
			deps.ffprobePath,
			["-v", "error", "-show_streams", "-of", "json", path],
			{ signal, abortKillAfterMs: 250 },
		);
		signal?.throwIfAborted();
		if (result.code !== 0) throw new Error("NATIVE_UNSUPPORTED_INPUT_PROBE");
		return result.stdout;
	};
	const reference = probeInput(
		await probe(options.referencePath, context.referenceProbe),
	);
	const distorted = probeInput(
		await probe(options.distortedPath, context.distortedProbe),
	);
	if (Math.abs(reference.rate - distorted.rate) > 1e-6)
		throw new Error("NATIVE_UNSUPPORTED_FRAME_RATE_CONVERSION");
	if (reference.width !== size.width || reference.height !== size.height)
		throw new Error("NATIVE_UNSUPPORTED_REFERENCE_GEOMETRY");
	if (
		frameLimit === undefined &&
		reference.frames !== undefined &&
		distorted.frames !== undefined &&
		reference.frames !== distorted.frames
	)
		throw new Error("NATIVE_UNSUPPORTED_FRAME_COUNT_MISMATCH");
	if (
		frameLimit !== undefined &&
		[reference.frames, distorted.frames].some(
			(n) => n !== undefined && n < frameLimit,
		)
	)
		throw new Error("NATIVE_CALIBRATION_INPUT_TOO_SHORT");
	const original = options.distortedOriginal;
	if (
		!original ||
		original.width !== distorted.width ||
		original.height !== distorted.height ||
		original.bitdepth !== distorted.bitDepth
	)
		throw new Error("NATIVE_UNSUPPORTED_DISTORTED_ORIGINAL");
	const model = await prepareNativeModel(options, signal);
	const referenceSha256 = await hashNativeFile(options.referencePath, signal);
	if (
		context.expectedReferenceSha256 !== undefined &&
		(!/^[a-f0-9]{64}$/.test(context.expectedReferenceSha256) ||
			context.expectedReferenceSha256 !== referenceSha256)
	)
		throw new Error("NATIVE_REFERENCE_PREPARATION_SHA256_MISMATCH");
	const distortedSha256 = await hashNativeFile(options.distortedPath, signal);
	const version = await deps.runner.run(deps.nativePath, ["--version"], {
		signal,
		abortKillAfterMs: 250,
	});
	signal?.throwIfAborted();
	if (version.code !== 0) throw new Error("NATIVE_BINARY_UNAVAILABLE");
	const sourceSha256 = nativeSourceFromVersion(version.stdout);
	const receiptPath = `${options.logPath}.native.json`;
	await rm(receiptPath, { force: true });
	try {
		const args = [
			"--reference",
			options.referencePath,
			"--distorted",
			options.distortedPath,
			"--model",
			`${options.model}=${options.modelPath}`,
			"--output",
			receiptPath,
			"--backend",
			scoring.backend,
			"--vendor",
			scoring.backend === "vulkan" ? "amd" : "nvidia",
			"--device",
			String(scoring.device),
			"--bit-depth",
			"10",
			"--width",
			String(size.width),
			"--height",
			String(size.height),
			"--threads",
			String(options.threads ?? 1),
			"--decode-threads",
			String(options.decoderThreads ?? 1),
			"--verify-cpu",
			...(context.nativeInflightFrames === undefined
				? []
				: ["--inflight-frames", String(context.nativeInflightFrames)]),
			...(frameLimit === undefined ? [] : ["--max-frames", String(frameLimit)]),
		];
		signal?.throwIfAborted();
		const run = await deps.runner.run(deps.nativePath, args, {
			signal,
			abortKillAfterMs: 250,
		});
		signal?.throwIfAborted();
		if (run.code !== 0)
			throw new Error(`NATIVE_SCORING_FAILED (${run.code}): ${run.stderr}`);
		const raw: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
		const verified = verifyNativeReceipt(raw, {
			model: options.model,
			modelSha256: model.modelSha256,
			backend: scoring.backend,
			device: scoring.device,
			sourceSha256,
			...size,
			distortedOriginal: original,
			referenceSha256,
			distortedSha256,
			frameCount: frameLimit ?? reference.frames ?? distorted.frames,
			psnr:
				options.psnr === true || options.features?.includes("psnr") === true,
		});
		const metadata = raw as Record<string, unknown>;
		if (
			context.nativeInflightFrames !== undefined &&
			metadata.inflightFrames !== context.nativeInflightFrames
		)
			throw new Error("NATIVE_PIPELINE_DEPTH_MISMATCH");
		let resourceSnapshot: NativeResourceSnapshot | undefined;
		if (frameLimit !== undefined) {
			const memory = metadata.memory as Record<string, unknown> | undefined;
			if (
				metadata.resourceSnapshotScope !== "before-result-serialization" ||
				metadata.cpuThreads !== (options.threads ?? 1) ||
				metadata.decodeThreads !== (options.decoderThreads ?? 1) ||
				!memory ||
				![memory.maxRssBytes, memory.gpuAllocatedBytes].every(
					(n) => typeof n === "number" && Number.isSafeInteger(n) && n > 0,
				)
			)
				throw new Error("NATIVE_RESOURCE_SNAPSHOT_INVALID");
			resourceSnapshot = {
				maxRssBytes: memory.maxRssBytes as number,
				gpuOwnedBytes: memory.gpuAllocatedBytes as number,
				scope: "before-result-serialization",
			};
		}
		signal?.throwIfAborted();
		const execution = localVmafExecutionSchema.parse({
			version: 1,
			requestedDecode: "cpu",
			device: scoring.device,
			decode: { reference: { backend: "cpu" }, distorted: { backend: "cpu" } },
			scoring: verified.scoring,
			attempts: 1,
		});
		await writeFile(options.logPath, JSON.stringify(verified.log));
		signal?.throwIfAborted();
		return {
			run,
			execution,
			log: verified.log,
			...(resourceSnapshot ? { resourceSnapshot } : {}),
		};
	} finally {
		await rm(receiptPath, { force: true });
		signal?.throwIfAborted();
	}
}
