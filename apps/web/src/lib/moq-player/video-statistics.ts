import type { MoqSource } from "./types";

export type MoqVideoQuality = {
	name: string | null;
	width: number | null;
	height: number | null;
};
export type MoqVideoStatistics = {
	fps: number | null;
	resolution: string | null;
	droppedFrames: number | null;
	bufferSeconds: number | null;
	bufferSource: "player" | "video" | null;
	startupMs: number | null;
	decodedFrames: number | null;
	presentedFrames: number | null;
	totalFrames: number | null;
	latencySeconds: number | null;
	currentQuality: MoqVideoQuality | null;
	availableQualities: MoqVideoQuality[] | null;
};
export const EMPTY_MOQ_VIDEO_STATISTICS: MoqVideoStatistics = Object.freeze({
	fps: null,
	resolution: null,
	droppedFrames: null,
	bufferSeconds: null,
	bufferSource: null,
	startupMs: null,
	decodedFrames: null,
	presentedFrames: null,
	totalFrames: null,
	latencySeconds: null,
	currentQuality: null,
	availableQualities: null,
});
const finite = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
function quality(video: HTMLVideoElement) {
	try {
		const value = video.getVideoPlaybackQuality?.();
		return {
			total: finite(value?.totalVideoFrames),
			dropped: finite(value?.droppedVideoFrames),
		};
	} catch {
		return { total: null, dropped: null };
	}
}
function videoBuffer(video: HTMLVideoElement): number | null {
	try {
		const time = finite(video.currentTime);
		if (time === null) return null;
		for (let i = 0; i < video.buffered.length; i++) {
			const start = finite(video.buffered.start(i));
			const end = finite(video.buffered.end(i));
			if (start !== null && end !== null && start <= time && time <= end)
				return end - time;
		}
	} catch {
		/* Unsupported or changing ranges remain unknown. */
	}
	return null;
}
type SourceMetrics = Pick<
	MoqSource,
	| "getLatency"
	| "getBufferLevel"
	| "getVideoQuality"
	| "getAvailableVideoQualities"
>;
function publicQuality(value: unknown): MoqVideoQuality | null {
	if (typeof value !== "object" || value === null) return null;
	const name = Reflect.get(value, "name");
	const width = finite(Reflect.get(value, "width"));
	const height = finite(Reflect.get(value, "height"));
	const safeName =
		typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_. -]{0,63}$/.test(name)
			? name
			: null;
	if (!safeName && !(width && height)) return null;
	return {
		name: safeName,
		width: width && height ? width : null,
		height: width && height ? height : null,
	};
}
/** No timers or React work per frame; the owner publishes snapshots once a second. */
export function createVideoStatistics(
	startedAt: number,
	source: () => SourceMetrics | undefined,
	now: () => number = () => performance.now(),
) {
	let video: HTMLVideoElement | null = null;
	let presented: number | null = null;
	let firstFrame: number | null = null;
	let lastFrame: number | null = null;
	let previousFrames = 0;
	let previousTime = 0;
	let baseline: { at: number; count: number; kind: string } | null = null;
	function setVideo(value: HTMLVideoElement | null) {
		if (value === video) return;
		video = value;
		presented = null;
		lastFrame = null;
		previousFrames = 0;
		previousTime = 0;
		baseline = null;
	}
	function frame(presentedFrames?: number, mediaTime?: number): boolean {
		if (!video) return false;
		const explicit = finite(presentedFrames);
		const counters = quality(video);
		const rendered =
			counters.total !== null &&
			counters.dropped !== null &&
			counters.total >= counters.dropped
				? counters.total - counters.dropped
				: null;
		const count = explicit ?? rendered;
		const time = finite(mediaTime ?? video.currentTime);
		if (count === null || time === null) return false;
		const advanced =
			count > previousFrames &&
			(explicit !== null || firstFrame === null || time > previousTime);
		if (explicit !== null) presented = explicit;
		previousFrames = count;
		previousTime = time;
		if (!advanced || video.videoWidth <= 0 || video.videoHeight <= 0)
			return false;
		const at = finite(now());
		if (at === null) return false;
		lastFrame = at;
		if (firstFrame !== null) return false;
		firstFrame = at;
		return true;
	}
	function snapshot(): MoqVideoStatistics {
		if (!video) return { ...EMPTY_MOQ_VIDEO_STATISTICS };
		const at = finite(now());
		const counters = quality(video);
		const rendered =
			counters.total !== null &&
			counters.dropped !== null &&
			counters.total >= counters.dropped
				? counters.total - counters.dropped
				: null;
		const counter = presented ?? rendered;
		const kind = presented !== null ? "presented" : "quality";
		let fps: number | null = null;
		if (at !== null && counter !== null) {
			if (
				baseline &&
				baseline.kind === kind &&
				at > baseline.at &&
				counter >= baseline.count
			)
				fps = finite(((counter - baseline.count) * 1000) / (at - baseline.at));
			baseline = { at, count: counter, kind };
		}
		let latency: number | null = null;
		let buffer: number | null = null;
		try {
			latency = finite(source()?.getLatency?.());
		} catch {
			/* No barcode evidence. */
		}
		try {
			buffer = finite(source()?.getBufferLevel?.());
		} catch {
			/* Use video ranges if observable. */
		}
		const fromPlayer = buffer !== null;
		buffer ??= videoBuffer(video);
		const width = finite(video.videoWidth);
		const height = finite(video.videoHeight);
		let currentQuality: MoqVideoQuality | null = null;
		let availableQualities: MoqVideoQuality[] | null = null;
		let decoded: number | null = null;
		try {
			decoded = finite(Reflect.get(video, "webkitDecodedFrameCount"));
		} catch {
			/* Unsupported getter. */
		}
		try {
			currentQuality = publicQuality(source()?.getVideoQuality?.());
		} catch {
			/* Unavailable. */
		}
		try {
			const available = source()?.getAvailableVideoQualities?.();
			if (Array.isArray(available))
				availableQualities = available
					.slice(0, 16)
					.map(publicQuality)
					.filter((value) => value !== null);
		} catch {
			/* Unavailable. */
		}
		return {
			fps,
			resolution: width && height ? `${width}×${height}` : null,
			droppedFrames: counters.dropped,
			bufferSeconds: buffer,
			bufferSource: buffer === null ? null : fromPlayer ? "player" : "video",
			startupMs: firstFrame === null ? null : finite(firstFrame - startedAt),
			decodedFrames: decoded,
			presentedFrames: presented,
			totalFrames: counters.total,
			latencySeconds:
				at !== null &&
				lastFrame !== null &&
				at >= lastFrame &&
				at - lastFrame < 1000
					? latency
					: null,
			currentQuality,
			availableQualities,
		};
	}
	return { setVideo, frame, snapshot };
}
