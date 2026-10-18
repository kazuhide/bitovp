import type { ContainerLoopProbe } from "@bitovp/core";
import type { ProcessRunner } from "../feeder/supervisor";
import { parseFrameRate } from "./geometry";

/**
 *  — what the feeder's `-stream_loop -1 … -c copy` actually repeats:
 * the CONTAINER's span, not the video's frame count. This probe reads the
 * three numbers `timelineFromContainerProbe` needs — the container duration,
 * the video stream's start time and its duration — so a session without a
 * normalized profile still gets the pushed period and the video-less holes.
 */

type FfprobeJson = {
	format?: { duration?: string | number; start_time?: string | number };
	streams?: {
		codec_type?: string;
		start_time?: string | number;
		duration?: string | number;
		nb_frames?: string | number;
		r_frame_rate?: string;
		avg_frame_rate?: string;
	}[];
};

function num(value: string | number | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : undefined;
}

/** Parses `ffprobe -show_format -show_streams` JSON into the loop probe. */
export function containerLoopFromProbe(stdout: string): ContainerLoopProbe {
	let parsed: FfprobeJson;
	try {
		parsed = JSON.parse(stdout) as FfprobeJson;
	} catch {
		throw new Error("ffprobe produced no parseable JSON output");
	}
	const video = (parsed.streams ?? []).find((s) => s.codec_type === "video");
	if (!video) {
		throw new Error("ffprobe reported no video stream");
	}
	const durationSec = num(parsed.format?.duration);
	if (durationSec === undefined || durationSec <= 0) {
		throw new Error("ffprobe reported no container duration");
	}
	// Relative to the container start (rev427 re-review R2): an MPEG-TS source
	// starts both at ≈ 1.4 s and has no hole; an MP4's format start is ≈ 0.
	const containerStartSec = num(parsed.format?.start_time) ?? 0;
	const videoStartSec =
		(num(video.start_time) ?? containerStartSec) - containerStartSec;
	// Prefer the stream's own duration; fall back to frames ÷ rate.
	let videoDurationSec = num(video.duration);
	if (videoDurationSec === undefined) {
		const frames = num(video.nb_frames);
		const rate =
			parseFrameRate(video.r_frame_rate) ??
			parseFrameRate(video.avg_frame_rate);
		if (frames !== undefined && rate !== undefined && rate > 0) {
			videoDurationSec = frames / rate;
		}
	}
	if (videoDurationSec === undefined) {
		throw new Error("ffprobe reported no video duration");
	}
	return { durationSec, videoStartSec, videoDurationSec };
}

/** Runs ffprobe on the looped source and returns the container loop probe. */
export async function probeContainerLoop(args: {
	runner: ProcessRunner;
	ffprobePath: string;
	path: string;
}): Promise<ContainerLoopProbe> {
	const run = await args.runner.run(args.ffprobePath, [
		"-v",
		"error",
		"-print_format",
		"json",
		"-show_format",
		"-show_streams",
		args.path,
	]);
	if (run.code !== 0) {
		throw new Error(
			`ffprobe failed on the live reference source (code ${run.code}): ${run.stderr.trim().split("\n").at(-1) ?? "no output"}`,
		);
	}
	return containerLoopFromProbe(run.stdout);
}
