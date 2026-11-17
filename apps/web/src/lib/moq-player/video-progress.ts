import {
	createMoqCanvasSurface,
	type MoqCanvasSurface,
} from "./canvas-surface";
import type { MoqSource } from "./types";
import {
	createVideoStatistics,
	type MoqVideoStatistics,
} from "./video-statistics";

type Telemetry = {
	startedAt: number;
	onStatistics(value: MoqVideoStatistics): void;
	source():
		| Pick<
				MoqSource,
				| "getLatency"
				| "getBufferLevel"
				| "getVideoQuality"
				| "getAvailableVideoQualities"
		  >
		| undefined;
};
/** Frame bookkeeping is internal; React receives at most one snapshot per second. */
export function observeMoqVideo(
	host: HTMLElement,
	progress: (video: HTMLVideoElement) => void,
	failure: () => void,
	telemetry?: Telemetry,
) {
	let video: HTMLVideoElement | null = null;
	let canvas: HTMLCanvasElement | null = null;
	let surface: MoqCanvasSurface | null = null;
	let callback: number | undefined;
	let stopped = false;
	const statistics = createVideoStatistics(
		telemetry?.startedAt ?? performance.now(),
		() => telemetry?.source(),
	);
	function sample(presented?: number, mediaTime?: number) {
		if (stopped) return;
		if (surface && !surface.changed()) return;
		if (!stopped && video && statistics.frame(presented, mediaTime))
			progress(video);
	}
	function onTime() {
		if (!video?.requestVideoFrameCallback) sample();
	}
	function frame(_now: number, metadata: VideoFrameCallbackMetadata) {
		sample(metadata.presentedFrames, metadata.mediaTime);
		if (!stopped && video?.requestVideoFrameCallback)
			callback = video.requestVideoFrameCallback(frame);
	}
	function detach() {
		video?.removeEventListener("timeupdate", onTime);
		video?.removeEventListener("error", failure);
		if (callback !== undefined) video?.cancelVideoFrameCallback?.(callback);
		callback = undefined;
	}
	function findVideo() {
		if (stopped) return;
		const found = host.querySelector<HTMLVideoElement>(
			"video:not([data-bitovp-moq-canvas-mirror])",
		);
		const foundCanvas = found ? null : host.querySelector("canvas");
		if (
			found
				? found === video && !surface
				: foundCanvas === canvas &&
					(surface ? video === surface.video : video === null)
		)
			return;
		detach();
		surface?.dispose();
		canvas = foundCanvas;
		surface = canvas ? createMoqCanvasSurface(canvas, host) : null;
		video = found ?? surface?.video ?? null;
		statistics.setVideo(video, surface ? "canvas" : "video");
		if (!video) return;
		video.muted = true;
		video.defaultMuted = true;
		video.playsInline = true;
		video.controls = !surface;
		video.addEventListener("timeupdate", onTime);
		video.addEventListener("error", failure);
		if (video.requestVideoFrameCallback)
			callback = video.requestVideoFrameCallback(frame);
		else sample();
	}
	const observer = new MutationObserver(findVideo);
	observer.observe(host, { childList: true, subtree: true });
	findVideo();
	const timer = telemetry
		? window.setInterval(() => {
				if (!stopped) telemetry.onStatistics(statistics.snapshot());
			}, 1000)
		: undefined;
	function stop() {
		stopped = true;
		observer.disconnect();
		if (timer !== undefined) window.clearInterval(timer);
		detach();
	}
	function disposeSurface() {
		stop();
		surface?.dispose();
		surface = null;
		canvas = null;
		video = null;
		statistics.setVideo(null);
	}
	return { stop, disposeSurface };
}
