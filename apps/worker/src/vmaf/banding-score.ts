import { readFile, rm } from "node:fs/promises";
import { sampleAspectRatioFromProbe } from "@bitovp/core";
import { type BandingFrame, canonicalBandingScore } from "@bitovp/core/banding";
import type { ProcessRunner } from "../feeder/supervisor";
import { presentationTransformReason } from "./hardware-decode";
import { resourceVideoFromProbe } from "./resource-plan";

export type BandingTiming = {
	frameNum: number;
	timestampSeconds: number;
	durationSeconds: number;
};
export type MeasuredBandingFrame = BandingFrame;
type BandingInput = {
	width: number;
	height: number;
	bitDepth: number;
	frames?: number;
};

/** Mirrors shared CUDA/Vulkan CambiParameters with the official standalone
 * defaults (window_size=65, cambi_high_res_speedup=0). CPU has no GPU LUT. */
export function assertBandingGpuGeometry(input: {
	width: number;
	height: number;
}): void {
	if (
		![input.width, input.height].every(
			(value) => Number.isSafeInteger(value) && value > 0 && value <= 7680,
		)
	)
		throw new Error("BANDING_GPU_GEOMETRY_INVALID");
	const window =
		(Math.floor((65 * (input.width + input.height)) / 375) >>> 4) | 1;
	if (window * window >= 4226)
		throw new Error(
			`BANDING_GPU_GEOMETRY_UNSUPPORTED: ${input.width}x${input.height} requires CAMBI window ${window}, exceeding the GPU lookup table; select Local CPU to measure this input.`,
		);
}

export function bandingInputFromProbe(text: string) {
	const data = object(JSON.parse(text));
	const videos = Array.isArray(data?.streams)
		? data.streams
				.map(object)
				.filter((stream) => stream?.codec_type === "video")
		: [];
	const video = videos[0];
	if (videos.length !== 1 || !video)
		throw new Error("BANDING_VIDEO_SELECTION_UNSUPPORTED");
	const input = resourceVideoFromProbe(text);
	if (input.frames !== undefined && !Number.isSafeInteger(input.frames))
		throw new Error("BANDING_INPUT_FRAME_COUNT_INVALID");
	if (
		!input.bitDepth ||
		![8, 10].includes(input.bitDepth) ||
		!["yuv420p", "yuv420p10le"].includes(String(video.pix_fmt)) ||
		[input.width, input.height].some(
			(dimension) => dimension < 144 || dimension > 7680 || dimension % 2 !== 0,
		) ||
		(input.width < 216 && input.height < 216)
	)
		throw new Error("BANDING_INPUT_FORMAT_UNSUPPORTED");
	const sar = sampleAspectRatioFromProbe(video.sample_aspect_ratio);
	if (
		(sar !== undefined && sar !== "1:1") ||
		presentationTransformReason(video)
	)
		throw new Error("BANDING_PRESENTATION_TRANSFORM_UNSUPPORTED");
	if (
		video.color_range !== undefined &&
		!["tv", "mpeg", "unknown", "unspecified"].includes(
			String(video.color_range),
		)
	)
		throw new Error("BANDING_FULL_RANGE_UNSUPPORTED");
	if (
		["smpte2084", "arib-std-b67", "smpte428"].includes(
			String(video.color_transfer),
		) ||
		String(video.color_primaries).startsWith("bt2020") ||
		String(video.color_space).startsWith("bt2020")
	)
		throw new Error("BANDING_HDR_UNSUPPORTED");
	return { ...input, bitDepth: input.bitDepth };
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function integer(value: unknown): bigint | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value))
		return BigInt(value);
	if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
}

/** No average-FPS fallback: these are decoded presentation intervals. */
export function parseBandingTiming(
	value: unknown,
	input?: BandingInput,
): BandingTiming[] {
	const frames = object(value)?.frames;
	const streams = object(value)?.streams;
	const base = Array.isArray(streams)
		? object(streams[0])?.time_base
		: undefined;
	const rational =
		typeof base === "string" ? /^(\d+)\/(\d+)$/.exec(base) : null;
	if (
		!rational ||
		BigInt(rational[1] ?? "0") <= 0n ||
		BigInt(rational[2] ?? "0") <= 0n
	)
		throw new Error("BANDING_TIMING_TIME_BASE");
	const tickSeconds = Number(rational[1]) / Number(rational[2]);
	if (!Number.isFinite(tickSeconds) || tickSeconds <= 0)
		throw new Error("BANDING_TIMING_TIME_BASE");
	if (!Array.isArray(frames) || frames.length === 0)
		throw new Error("BANDING_TIMING_MISSING");
	if (input?.frames !== undefined && frames.length !== input.frames)
		throw new Error("BANDING_FRAME_COVERAGE");
	let origin: bigint | undefined;
	let previous: BandingTiming | undefined;
	return frames.map((raw, frameNum) => {
		const frame = object(raw);
		if (input) {
			if (
				!frame ||
				frame.width !== input.width ||
				frame.height !== input.height ||
				frame.pix_fmt !== (input.bitDepth === 8 ? "yuv420p" : "yuv420p10le")
			)
				throw new Error("BANDING_FRAME_FORMAT_CHANGED");
			const sar = sampleAspectRatioFromProbe(frame.sample_aspect_ratio);
			if (
				(sar !== undefined && sar !== "1:1") ||
				presentationTransformReason(frame) ||
				["crop_top", "crop_bottom", "crop_left", "crop_right"].some(
					(key) => frame[key] !== undefined && frame[key] !== 0,
				) ||
				(frame.color_range !== undefined &&
					!["tv", "mpeg", "unknown", "unspecified"].includes(
						String(frame.color_range),
					)) ||
				["smpte2084", "arib-std-b67", "smpte428"].includes(
					String(frame.color_transfer),
				) ||
				String(frame.color_primaries).startsWith("bt2020") ||
				String(frame.color_space).startsWith("bt2020")
			)
				throw new Error("BANDING_FRAME_PRESENTATION_CHANGED");
		}
		const pts = integer(frame?.best_effort_timestamp);
		const duration = integer(frame?.duration ?? frame?.pkt_duration);
		if (pts === undefined || duration === undefined || duration <= 0n)
			throw new Error("BANDING_TIMING_INVALID");
		origin ??= pts;
		const timestampSeconds = Number(pts - origin) * tickSeconds;
		const durationSeconds = Number(duration) * tickSeconds;
		if (!Number.isFinite(timestampSeconds) || !Number.isFinite(durationSeconds))
			throw new Error("BANDING_TIMING_INVALID");
		if (
			previous &&
			(timestampSeconds <= previous.timestampSeconds ||
				timestampSeconds <
					previous.timestampSeconds + previous.durationSeconds - 1e-7)
		)
			throw new Error("BANDING_TIMING_OVERLAP");
		previous = { frameNum, timestampSeconds, durationSeconds };
		return previous;
	});
}

/** libvmaf's model= disables model prediction; split feeds the same decoded frame. */
export function buildCpuBandingCommand(
	input: string,
	logPath: string,
	threads = 1,
	original?: BandingInput,
): string[] {
	if (!Number.isSafeInteger(threads) || threads < 1 || threads > 256)
		throw new Error("BANDING_THREADS_INVALID");
	// This is FFmpeg filter escaping, not shell escaping (the runner uses argv).
	const escaped = logPath.replace(/([\\':,;[\]])/g, "\\$1");
	const feature = original
		? `'name=cambi\\:enc_width=${original.width}\\:enc_height=${original.height}\\:enc_bitdepth=${original.bitDepth}'`
		: "name=cambi";
	return [
		"-hide_banner",
		"-nostdin",
		"-v",
		"error",
		"-xerror",
		"-err_detect",
		"explode",
		"-noautorotate",
		"-threads",
		String(threads),
		"-i",
		input,
		"-filter_complex_threads",
		"1",
		"-filter_complex",
		`[0:v:0]split=2[dist][ref];[dist][ref]libvmaf=model=:feature=${feature}:log_fmt=json:log_path='${escaped}':n_threads=${threads}:n_subsample=1[out]`,
		"-map",
		"[out]",
		"-an",
		"-fps_mode",
		"passthrough",
		"-f",
		"null",
		"-",
	];
}

export function parseCpuBandingLog(
	value: unknown,
	timing: BandingTiming[],
	featureName = "cambi",
): MeasuredBandingFrame[] {
	const frames = object(value)?.frames;
	if (!Array.isArray(frames) || frames.length !== timing.length)
		throw new Error("BANDING_FRAME_COVERAGE");
	return timing.map((interval, index) => {
		const frame = object(frames[index]);
		if (frame?.frameNum !== index) throw new Error("BANDING_FRAME_COVERAGE");
		const score = object(frame.metrics)?.[featureName];
		if (typeof score !== "number" || !Number.isFinite(score) || score < 0)
			throw new Error("BANDING_FRAME_SCORE");
		return { ...interval, cambi: canonicalBandingScore(score) };
	});
}

export async function probeBandingTiming(
	deps: { runner: ProcessRunner; ffprobePath: string },
	input: string,
	signal: AbortSignal,
	original?: BandingInput,
) {
	signal.throwIfAborted();
	const probe = await deps.runner.run(
		deps.ffprobePath,
		[
			"-v",
			"error",
			"-err_detect",
			"explode",
			"-select_streams",
			"v:0",
			"-show_frames",
			"-show_streams",
			"-show_entries",
			"stream=time_base:frame=best_effort_timestamp,duration,pkt_duration,width,height,pix_fmt,sample_aspect_ratio,color_range,color_space,color_primaries,color_transfer,crop_top,crop_bottom,crop_left,crop_right:frame_side_data",
			"-of",
			"json",
			input,
		],
		{ signal, abortKillAfterMs: 250 },
	);
	signal.throwIfAborted();
	if (probe.code !== 0 || probe.stderr.trim())
		throw new Error("BANDING_TIMING_PROBE_FAILED");
	return parseBandingTiming(JSON.parse(probe.stdout), original);
}

export async function runCpuBandingScore(
	deps: {
		runner: ProcessRunner;
		ffmpegPath: string;
		ffprobePath: string;
	},
	input: string,
	logPath: string,
	signal: AbortSignal,
	threads = 1,
	inputProbe?: string,
) {
	try {
		signal.throwIfAborted();
		let probe = inputProbe;
		if (probe === undefined) {
			const result = await deps.runner.run(
				deps.ffprobePath,
				["-v", "error", "-show_streams", "-of", "json", input],
				{ signal, abortKillAfterMs: 250 },
			);
			signal.throwIfAborted();
			if (result.code !== 0) throw new Error("BANDING_INPUT_PROBE_FAILED");
			probe = result.stdout;
		}
		const original = bandingInputFromProbe(probe);
		const timing = await probeBandingTiming(deps, input, signal, original);
		await rm(logPath, { force: true });
		const run = await deps.runner.run(
			deps.ffmpegPath,
			buildCpuBandingCommand(input, logPath, threads, original),
			{ signal, abortKillAfterMs: 250 },
		);
		signal.throwIfAborted();
		if (run.code !== 0)
			throw new Error(`BANDING_CPU_SCORING_FAILED (${run.code})`);
		const log: unknown = JSON.parse(await readFile(logPath, "utf8"));
		const version = object(log)?.version;
		if (
			typeof version !== "string" ||
			!/^\d+\.\d+\.\d+(?:[-+._a-zA-Z0-9]*)$/.test(version)
		)
			throw new Error("BANDING_CPU_VERSION_MISSING");
		const featureName = `cambi_encbd_${original.bitDepth}_ench_${original.height}_encw_${original.width}`;
		return {
			frames: parseCpuBandingLog(log, timing, featureName),
			libvmafVersion: version,
			featureName,
		};
	} finally {
		await rm(logPath, { force: true });
	}
}
