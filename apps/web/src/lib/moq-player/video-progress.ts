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
	let callback: number | undefined;
	let stopped = false;
	const statistics = createVideoStatistics(
		telemetry?.startedAt ?? performance.now(),
		() => telemetry?.source(),
	);
	function sample(presented?: number, mediaTime?: number) {
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
		const found = host.querySelector("video");
		if (found === video) return;
		detach();
		video = found;
		statistics.setVideo(found);
		if (!video) return;
		video.muted = true;
		video.defaultMuted = true;
		video.playsInline = true;
		video.controls = true;
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
	return () => {
		stopped = true;
		observer.disconnect();
		if (timer !== undefined) window.clearInterval(timer);
		detach();
	};
}
