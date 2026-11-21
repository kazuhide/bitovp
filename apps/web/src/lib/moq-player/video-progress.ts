import {
	createMoqCanvasSurface,
	type MoqCanvasSurface,
} from "./canvas-surface";
import type { MoqPlaybackStage } from "./observations";
import type { MoqSource } from "./types";
import {
	createVideoStatistics,
	type MoqVideoStatistics,
} from "./video-statistics";

const FRAME_GAP_MS = 3000;
const FRAME_OBSERVATION_BOUNDARIES = [
	"pause",
	"play",
	"seeking",
	"seeked",
	"ended",
] as const;
type Telemetry = {
	startedAt: number;
	onFirstVisibleFrame?(): void;
	onStatistics(value: MoqVideoStatistics): void;
	onStage?(type: MoqPlaybackStage): void;
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
	let hasFrameGap = false;
	let observedSince = performance.now();
	const ownerDocument = host.ownerDocument;
	const onStage = telemetry?.onStage;
	let onFirstVisibleFrame = telemetry?.onFirstVisibleFrame;
	const statistics = createVideoStatistics(
		telemetry?.startedAt ?? performance.now(),
		() => telemetry?.source(),
	);
	function resetObservationWindow() {
		observedSince = performance.now();
	}
	function canObserveFrames() {
		return (
			video &&
			!video.paused &&
			!video.seeking &&
			!video.ended &&
			ownerDocument.visibilityState === "visible"
		);
	}
	function observeFrameGap() {
		if (!onStage) return;
		if (!canObserveFrames()) {
			resetObservationWindow();
			return;
		}
		const lastFrameAt = statistics.lastFrameAt();
		if (
			!hasFrameGap &&
			lastFrameAt !== null &&
			performance.now() - Math.max(lastFrameAt, observedSince) >= FRAME_GAP_MS
		) {
			hasFrameGap = true;
			onStage(surface ? "canvas-unchanged" : "frame-gap");
		}
	}
	function reportFirstVisibleFrame() {
		const report = onFirstVisibleFrame;
		onFirstVisibleFrame = undefined;
		try {
			report?.();
		} catch {
			// Operation analytics cannot interrupt playback or observation.
		}
	}
	function sample(
		presented?: number,
		mediaTime?: number,
		canvasFrameObserved = false,
	) {
		if (stopped || !video) return;
		if (surface) {
			const changed = surface.changed();
			if (
				onFirstVisibleFrame &&
				canvasFrameObserved &&
				video.videoWidth > 0 &&
				video.videoHeight > 0 &&
				surface.hasVisibleImage()
			)
				reportFirstVisibleFrame();
			if (!changed) return;
		}
		const previous = hasFrameGap ? statistics.lastFrameAt() : null;
		if (statistics.frame(presented, mediaTime)) {
			if (!surface) reportFirstVisibleFrame();
			progress(video);
		}
		if (
			hasFrameGap &&
			previous !== statistics.lastFrameAt() &&
			canObserveFrames()
		) {
			hasFrameGap = false;
			onStage?.(surface ? "canvas-updated" : "frame-resumed");
		}
	}
	function onTime() {
		if (!video?.requestVideoFrameCallback) sample(undefined, undefined, true);
	}
	function frame(_now: number, metadata: VideoFrameCallbackMetadata) {
		sample(
			metadata.presentedFrames,
			metadata.mediaTime,
			metadata.presentedFrames > 0,
		);
		if (!stopped && video?.requestVideoFrameCallback)
			callback = video.requestVideoFrameCallback(frame);
	}
	function detach() {
		if (onStage)
			for (const type of FRAME_OBSERVATION_BOUNDARIES)
				video?.removeEventListener(type, resetObservationWindow);
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
		resetObservationWindow();
		statistics.setVideo(video, surface ? "canvas" : "video");
		if (!video) return;
		video.muted = true;
		video.defaultMuted = true;
		video.playsInline = true;
		video.controls = !surface;
		video.addEventListener("timeupdate", onTime);
		video.addEventListener("error", failure);
		if (onStage)
			for (const type of FRAME_OBSERVATION_BOUNDARIES)
				video.addEventListener(type, resetObservationWindow);
		if (video.requestVideoFrameCallback)
			callback = video.requestVideoFrameCallback(frame);
		else sample();
	}
	const observer = new MutationObserver(findVideo);
	observer.observe(host, { childList: true, subtree: true });
	findVideo();
	if (onStage)
		ownerDocument.addEventListener("visibilitychange", resetObservationWindow);
	const timer = telemetry
		? window.setInterval(() => {
				if (!stopped) {
					observeFrameGap();
					telemetry.onStatistics(statistics.snapshot());
				}
			}, 1000)
		: undefined;
	function stop() {
		stopped = true;
		observer.disconnect();
		if (onStage)
			ownerDocument.removeEventListener(
				"visibilitychange",
				resetObservationWindow,
			);
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
