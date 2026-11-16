import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import {
	buildHdrVmafCommand,
	HDR_LIBVMAF_REVISION,
	HDR_VMAF_MODELS,
	type HdrInput,
	type HdrReferenceColor,
	hdrInputFromProbe,
	hdrMeasurementSchema,
	type LocalVmafExecution,
} from "@bitovp/core";
import type { ProcessRunner } from "../feeder/supervisor";
import { hdrReferenceInputOptions } from "./hdr-reference-input";

const object = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

/** No fps filter, hidden dropped frames, repeats or timestamp repair in HDR.
 * Frame N must be the same presentation slot on both complete input timelines. */
export function validateHdrFrameTimeline(
	text: string,
	input: HdrInput,
): number {
	if (Buffer.byteLength(text) > 64 * 1024 * 1024)
		throw new Error("HDR_TIMING_LIMIT");
	const data = object(JSON.parse(text));
	const streams = data?.streams;
	const timeBase = Array.isArray(streams)
		? object(streams[0])?.time_base
		: undefined;
	const match =
		typeof timeBase === "string" ? /^(\d+)\/(\d+)$/.exec(timeBase) : null;
	const tick = Number(match?.[1]) / Number(match?.[2]);
	const frames = data?.frames;
	if (
		!match ||
		!Number.isFinite(tick) ||
		tick <= 0 ||
		!Array.isArray(frames) ||
		!frames.length ||
		frames.length > 500_000
	)
		throw new Error("HDR_FRAME_TIMING_REQUIRED");
	const [rateNumerator = 0n, rateDenominator = 0n] = input.frameRate
		.split("/")
		.map((part) => BigInt(part));
	const stepNumerator = rateDenominator * BigInt(match[2] ?? "0");
	const stepDenominator = rateNumerator * BigInt(match[1] ?? "0");
	if (
		stepDenominator <= 0n ||
		stepNumerator < stepDenominator ||
		(stepNumerator % stepDenominator !== 0n &&
			stepNumerator < 2n * stepDenominator)
	)
		throw new Error("HDR_FRAME_TIMING_REQUIRED");
	const floorDuration = stepNumerator / stepDenominator;
	const ceilDuration = (stepNumerator + stepDenominator - 1n) / stepDenominator;
	const declaredRgbReference =
		input.attributeSource === "P3_D65_PQ_RGB_FULL" &&
		["rgb48le", "gbrp12le", "gbrp16le"].includes(input.pixelFormat) &&
		input.primaries === "smpte432" &&
		input.transfer === "smpte2084" &&
		input.range === "full" &&
		input.matrix === "gbr";
	const colorMatches = (actual: unknown, expected: string) =>
		actual === expected || (declaredRgbReference && actual === undefined);
	let origin: number | undefined;
	let previousPts: number | undefined;
	for (const [index, value] of frames.entries()) {
		const f = object(value);
		const pts = Number(f?.best_effort_timestamp);
		const duration = Number(f?.duration ?? f?.pkt_duration);
		if (
			!Number.isSafeInteger(pts) ||
			!Number.isSafeInteger(duration) ||
			duration <= 0
		)
			throw new Error("HDR_FRAME_TIMING_REQUIRED");
		origin ??= pts;
		// CFR timestamps/durations can alternate between adjacent clock ticks
		// (e.g. 24000/1001 fps at 90 kHz). Bound each complete slot using the
		// exact rational clock, without accumulating drift or accepting repeats.
		const expected = BigInt(index) * stepNumerator;
		const floorPts = expected / stepDenominator;
		const ceilPts = (expected + stepDenominator - 1n) / stepDenominator;
		const relativePts = BigInt(pts) - BigInt(origin);
		if (
			(previousPts !== undefined && pts <= previousPts) ||
			relativePts < floorPts ||
			relativePts > ceilPts ||
			BigInt(duration) < floorDuration ||
			BigInt(duration) > ceilDuration
		)
			throw new Error("HDR_FRAME_CADENCE");
		previousPts = pts;
		if (
			f?.width !== input.width ||
			f?.height !== input.height ||
			f?.pix_fmt !== input.pixelFormat ||
			f?.sample_aspect_ratio !== "1:1" ||
			!colorMatches(f?.color_primaries, input.primaries) ||
			!colorMatches(f?.color_transfer, input.transfer) ||
			(f.color_range !== undefined &&
				f.color_range !== (input.range === "limited" ? "tv" : "pc")) ||
			(f.color_space !== undefined && f.color_space !== input.matrix) ||
			(!declaredRgbReference &&
				(f.color_range === undefined || f.color_space === undefined)) ||
			["crop_top", "crop_bottom", "crop_left", "crop_right"].some(
				(key) => f?.[key] !== undefined && f[key] !== 0,
			) ||
			(Array.isArray(f?.side_data_list) &&
				f.side_data_list.some((s) =>
					[
						"Display Matrix",
						"Frame Cropping",
						"Stereo 3D",
						"Spherical Mapping",
					].includes(String(object(s)?.side_data_type)),
				))
		)
			throw new Error("HDR_FRAME_FORMAT_CHANGED");
	}
	return frames.length;
}

export function validateHdrVmafLog(raw: unknown, frameCount: number): void {
	const log = object(raw);
	if (log?.version !== HDR_LIBVMAF_REVISION.slice(0, 7))
		throw new Error("HDR_RUNTIME_REVISION_MISMATCH");
	const frames = log.frames;
	if (!Array.isArray(frames) || frames.length !== frameCount)
		throw new Error("HDR_SCORE_FRAME_COVERAGE");
	for (const [index, rawFrame] of frames.entries()) {
		const frame = object(rawFrame),
			score = object(frame?.metrics)?.vmaf;
		if (
			frame?.frameNum !== index ||
			typeof score !== "number" ||
			!Number.isFinite(score)
		)
			throw new Error("HDR_SCORE_FRAME_COVERAGE");
	}
}

export async function runHdrVmafScore(
	deps: { runner: ProcessRunner; ffmpegPath: string; ffprobePath: string },
	request: {
		referencePath: string;
		distortedPath: string;
		logPath: string;
		model: string;
		modelPath: string;
		referenceProbe: string;
		distortedProbe: string;
		referenceColor?: HdrReferenceColor;
		threads?: number;
		decoderThreads?: number;
		signal: AbortSignal;
	},
) {
	const { signal } = request;
	signal.throwIfAborted();
	const reference = hdrInputFromProbe(
		request.referenceProbe,
		"reference",
		request.referenceColor,
	);
	const distorted = hdrInputFromProbe(request.distortedProbe, "distorted");
	const referenceInputOptions = await hdrReferenceInputOptions(
		request.referencePath,
		request.referenceColor,
		signal,
	);
	const referenceMetadata = object(JSON.parse(request.referenceProbe));
	const referenceStreams = referenceMetadata?.streams;
	const referenceStream = Array.isArray(referenceStreams)
		? referenceStreams
				.map(object)
				.find((stream) => stream?.codec_type === "video")
		: undefined;
	const nominalMxfClock =
		reference.attributeSource === "P3_D65_PQ_RGB_FULL" &&
		object(referenceMetadata?.format)?.format_name === "mxf" &&
		referenceStream?.avg_frame_rate === "0/0";
	if (nominalMxfClock && referenceInputOptions.length === 0)
		throw new Error("HDR_REFERENCE_CONTAINER_MISMATCH");
	if (referenceInputOptions.length)
		console.info(
			`[worker:vmaf] HDR sequential MXF reference; ${nominalMxfClock ? "nominal" : "reported"} clock ${reference.frameRate} requires complete frame validation`,
		);
	const model = HDR_VMAF_MODELS.find((entry) => entry.id === request.model);
	if (!model) throw new Error("HDR_MODEL_UNSUPPORTED");
	const file = await readFile(request.modelPath, { signal });
	if (
		file.byteLength > 1024 * 1024 ||
		createHash("sha256").update(file).digest("hex") !== model.sha256
	)
		throw new Error("HDR_MODEL_HASH_MISMATCH");
	const probe = async (
		path: string,
		input: HdrInput,
		inputOptions: string[] = [],
	) => {
		signal.throwIfAborted();
		const run = await deps.runner.run(
			deps.ffprobePath,
			[
				"-v",
				"error",
				"-err_detect",
				"explode",
				"-threads",
				String(request.decoderThreads ?? 1),
				"-select_streams",
				"v:0",
				"-show_frames",
				"-show_streams",
				"-show_entries",
				"stream=time_base:frame=best_effort_timestamp,duration,pkt_duration,width,height,pix_fmt,sample_aspect_ratio,color_range,color_space,color_primaries,color_transfer,crop_top,crop_bottom,crop_left,crop_right:frame_side_data=side_data_type,rotation",
				"-of",
				"json",
				...inputOptions,
				path,
			],
			{ signal, abortKillAfterMs: 250 },
		);
		signal.throwIfAborted();
		if (run.code !== 0 || run.stderr.trim())
			throw new Error("HDR_TIMING_PROBE_FAILED");
		return validateHdrFrameTimeline(run.stdout, input);
	};
	// Keep admission held; probes and scorer are sequential and abortable.
	const frameCount = await probe(
		request.referencePath,
		reference,
		referenceInputOptions,
	);
	if (nominalMxfClock && frameCount !== referenceStream?.duration_ts)
		throw new Error("HDR_REFERENCE_FRAME_COVERAGE");
	if (nominalMxfClock)
		console.info(
			`[worker:vmaf] HDR nominal MXF clock verified over all ${frameCount} reference frames at ${reference.frameRate}`,
		);
	if ((await probe(request.distortedPath, distorted)) !== frameCount)
		throw new Error("HDR_INPUT_FRAME_COUNT_MISMATCH");
	const args = buildHdrVmafCommand({ ...request, reference, distorted });
	if (referenceInputOptions.length) {
		const referenceIndex = args.lastIndexOf("-i");
		if (
			referenceIndex < 0 ||
			args[referenceIndex + 1] !== request.referencePath
		)
			throw new Error("HDR_MEASUREMENT_CONTRACT_INVALID");
		args.splice(referenceIndex, 0, ...referenceInputOptions);
	}
	await rm(request.logPath, { force: true });
	const run = await deps.runner.run(deps.ffmpegPath, args, {
		signal,
		abortKillAfterMs: 250,
	});
	signal.throwIfAborted();
	if (run.code !== 0)
		throw new Error(
			`HDR_SCORING_FAILED (${run.code}): ${run.stderr.slice(-1600)}`,
		);
	const log: unknown = JSON.parse(
		await readFile(request.logPath, { encoding: "utf8", signal }),
	);
	validateHdrVmafLog(log, frameCount);
	const hdrMeasurement = hdrMeasurementSchema.parse({
		version: 1,
		method: "HDR_VMAF_PQ_ICTCP_16",
		scope: "HDR_BASE_LAYER",
		dolbyRpuApplied: false,
		model: model.id,
		modelSha256: model.sha256,
		libvmafRevision: HDR_LIBVMAF_REVISION,
		normalization: "ZIMG_BT2020_PQ_YUV444_16",
		comparison: "LIMITED_BT2020_PQ_ICTCP420_16_DISPLAY2160",
		reference,
		distorted,
		frameCount,
		...([reference.transfer, distorted.transfer].includes("arib-std-b67")
			? {
					hlgReferenceDisplay: {
						peakNits: 1000,
						blackNits: 0,
						systemGamma: 1.2,
						approximateGamma: false,
					},
				}
			: {}),
	});
	const execution: LocalVmafExecution = {
		version: 1,
		requestedDecode: "cpu",
		decode: { reference: { backend: "cpu" }, distorted: { backend: "cpu" } },
		scoring: { backend: "cpu", implementation: "libvmaf", model: model.id },
		attempts: 1,
	};
	return { run, log, execution, hdrMeasurement };
}
