import type { VodInputTimelineSourceFacts } from "@bitovp/core/vod-input-timeline";
import {
	MediaOperationError,
	type runMediaProcess,
} from "../library-editing/process";
import type { VodInputBrowserFactory } from "./range-bridge";

export const VOD_INPUT_PREVIEW_MAX_OUTPUT_BYTES = 64 * 1024 ** 2;
export const VOD_INPUT_PREVIEW_MAX_SOURCE_PIXELS = 4096 * 2160;
export type VodInputMediaDependencies = {
	browserFor: VodInputBrowserFactory;
	ffmpegPath?: string;
	ffprobePath?: string;
	signal: AbortSignal;
	timeoutMs?: number;
	execute?: typeof runMediaProcess;
};

/** Only bounded, non-playlist demuxers may read a registered loopback source. */
export function vodInputPreviewReadArgs(url: string): string[] {
	if (!/^http:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9]+\/\d+$/.test(url))
		throw new MediaOperationError("INVALID_SOURCE");
	return [
		"-threads",
		"1",
		"-protocol_whitelist",
		"http,tcp",
		"-format_whitelist",
		"mov,matroska,webm,mpegts,wav,mp3",
		"-rw_timeout",
		"15000000",
		"-probesize",
		"8388608",
		"-analyzeduration",
		"5000000",
		"-i",
		url,
	];
}

export function vodInputPreviewCanvas(
	width: number,
	height: number,
	displayAspectRatio?: { num: number; den: number },
) {
	if (
		![width, height].every((value) => Number.isSafeInteger(value) && value > 0)
	)
		throw new MediaOperationError("SOURCE_UNSUPPORTED");
	const aspect = displayAspectRatio ?? { num: width, den: height };
	if (
		![aspect.num, aspect.den].every(
			(value) => Number.isSafeInteger(value) && value > 0,
		)
	)
		throw new MediaOperationError("SOURCE_UNSUPPORTED");
	const scale = Math.min(640 / aspect.num, 360 / aspect.den);
	return {
		width: Math.max(2, Math.floor((aspect.num * scale) / 2) * 2),
		height: Math.max(2, Math.floor((aspect.den * scale) / 2) * 2),
	};
}

/** A full-resolution preparation is a separate, qualified SDR conversion. */
export function vodInputPreparationProfile(
	main: NonNullable<VodInputTimelineSourceFacts["video"]>,
	videos: NonNullable<VodInputTimelineSourceFacts["video"]>[],
) {
	for (const video of videos) {
		if (
			video.pixelFormat !== "yuv420p" ||
			video.colorTransfer !== "bt709" ||
			video.colorSpace !== "bt709" ||
			video.colorPrimaries !== "bt709" ||
			!video.displayAspectRatio ||
			video.displayAspectRatio.num * video.height !==
				video.displayAspectRatio.den * video.width
		)
			throw new MediaOperationError("PREPARATION_SOURCE_UNSUPPORTED");
	}
	if (
		!main.frameRate ||
		main.frameRate.num / main.frameRate.den > 120 ||
		main.frameRate.num / main.frameRate.den < 1 ||
		main.width % 2 ||
		main.height % 2
	)
		throw new MediaOperationError("PREPARATION_SOURCE_UNSUPPORTED");
	return {
		width: main.width,
		height: main.height,
		fps: `${main.frameRate.num}/${main.frameRate.den}`,
		frameMs: (1000 * main.frameRate.den) / main.frameRate.num,
		crf: "12",
		audioBitrate: "320k",
	};
}
