import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeMoqVideo } from "./video-progress";

const mocks = vi.hoisted(() => ({ surface: vi.fn() }));
vi.mock("./canvas-surface", () => ({ createMoqCanvasSurface: mocks.surface }));
beforeEach(() => {
	vi.resetAllMocks();
	mocks.surface.mockReturnValue(null);
});

afterEach(() => vi.useRealTimers());
describe("MoQ telemetry publication cadence", () => {
	it("observes native frame gaps and resumption while excluding pause, seeking and hidden time", () => {
		vi.useFakeTimers();
		const host = document.createElement("div");
		const video = document.createElement("video");
		host.append(video);
		let paused = false;
		let seeking = false;
		let count = 0;
		const visibility = vi.spyOn(document, "visibilityState", "get");
		visibility.mockReturnValue("visible");
		Object.defineProperties(video, {
			paused: { get: () => paused },
			seeking: { get: () => seeking },
			videoWidth: { value: 640 },
			videoHeight: { value: 360 },
		});
		Object.assign(video, {
			getVideoPlaybackQuality: () => ({
				totalVideoFrames: count,
				droppedVideoFrames: 0,
			}),
		});
		const progress = vi.fn();
		const stage = vi.fn();
		const observer = observeMoqVideo(host, progress, vi.fn(), {
			startedAt: performance.now(),
			onStatistics: vi.fn(),
			onStage: stage,
			source: () => undefined,
		});
		function emit() {
			video.currentTime = ++count / 30;
			video.dispatchEvent(new Event("timeupdate"));
		}
		try {
			vi.advanceTimersByTime(4000);
			expect(stage).not.toHaveBeenCalled();
			emit();
			expect(progress).toHaveBeenCalledOnce();
			paused = true;
			video.dispatchEvent(new Event("pause"));
			vi.advanceTimersByTime(6000);
			paused = false;
			vi.advanceTimersByTime(1000);
			seeking = true;
			video.dispatchEvent(new Event("seeking"));
			vi.advanceTimersByTime(6000);
			seeking = false;
			visibility.mockReturnValue("hidden");
			document.dispatchEvent(new Event("visibilitychange"));
			vi.advanceTimersByTime(6000);
			visibility.mockReturnValue("visible");
			document.dispatchEvent(new Event("visibilitychange"));
			vi.advanceTimersByTime(2000);
			expect(stage).not.toHaveBeenCalled();
			emit();
			vi.advanceTimersByTime(3000);
			expect(stage.mock.calls).toEqual([["frame-gap"]]);
			vi.advanceTimersByTime(3000);
			expect(stage).toHaveBeenCalledOnce();
			emit();
			expect(stage.mock.calls).toEqual([["frame-gap"], ["frame-resumed"]]);
			expect(progress).toHaveBeenCalledOnce();
		} finally {
			observer.disposeSurface();
			visibility.mockRestore();
		}
	});
	it("observes the owned canvas mirror only on distinct pixels and retains it until recording finalization", async () => {
		vi.useFakeTimers();
		const host = document.createElement("div");
		const canvas = document.createElement("canvas");
		host.append(canvas);
		const mirror = document.createElement("video");
		mirror.dataset.bitovpMoqCanvasMirror = "true";
		Object.defineProperties(mirror, {
			videoWidth: { value: 640 },
			videoHeight: { value: 360 },
		});
		let callback: VideoFrameRequestCallback | undefined;
		Object.assign(mirror, {
			requestVideoFrameCallback: vi.fn((value: VideoFrameRequestCallback) => {
				callback = value;
				return 1;
			}),
			cancelVideoFrameCallback: vi.fn(),
		});
		const changed = vi.fn().mockReturnValue(false),
			dispose = vi.fn();
		mocks.surface.mockImplementation(() => {
			host.append(mirror);
			return { video: mirror, changed, dispose };
		});
		const visibility = vi.spyOn(document, "visibilityState", "get");
		visibility.mockReturnValue("visible");
		Object.defineProperty(mirror, "paused", { value: false });
		const progress = vi.fn(),
			statistics = vi.fn(),
			stage = vi.fn();
		const observer = observeMoqVideo(host, progress, vi.fn(), {
			startedAt: performance.now(),
			onStatistics: statistics,
			onStage: stage,
			source: () => ({ getLatency: () => 0.25 }),
		});
		await Promise.resolve();
		expect(mocks.surface).toHaveBeenCalledExactlyOnceWith(canvas, host);
		const emit = (count: number) =>
			callback?.(performance.now(), {
				presentedFrames: count,
				mediaTime: count / 25,
				presentationTime: performance.now(),
				expectedDisplayTime: performance.now(),
				width: 640,
				height: 360,
			});
		emit(1);
		vi.advanceTimersByTime(1000);
		expect(progress).not.toHaveBeenCalled();
		expect(statistics.mock.calls.at(-1)?.[0]).toMatchObject({
			renderingSource: "canvas",
			fps: null,
			latencySeconds: null,
		});
		changed.mockReturnValueOnce(true);
		emit(2);
		expect(progress).toHaveBeenCalledExactlyOnceWith(mirror);
		emit(3);
		vi.advanceTimersByTime(2000);
		expect(statistics.mock.calls.at(-1)?.[0]).toMatchObject({
			fps: null,
			latencySeconds: null,
			decodedFrames: null,
			totalFrames: null,
		});
		expect(stage).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1000);
		expect(stage.mock.calls).toEqual([["canvas-unchanged"]]);
		changed.mockReturnValueOnce(true);
		emit(4);
		expect(stage.mock.calls).toEqual([
			["canvas-unchanged"],
			["canvas-updated"],
		]);
		visibility.mockRestore();
		observer.stop();
		expect(dispose).not.toHaveBeenCalled();
		const stoppedReads = changed.mock.calls.length;
		emit(4);
		expect(changed).toHaveBeenCalledTimes(stoppedReads);
		observer.disposeSurface();
		observer.disposeSurface();
		expect(dispose).toHaveBeenCalledOnce();
		expect(mirror.cancelVideoFrameCallback).toHaveBeenCalled();
	});
	it("prefers an SDK video over a canvas and never treats a mirror as a native video", () => {
		const host = document.createElement("div");
		host.append(
			document.createElement("canvas"),
			document.createElement("video"),
		);
		const observer = observeMoqVideo(host, vi.fn(), vi.fn());
		expect(mocks.surface).not.toHaveBeenCalled();
		observer.stop();
		observer.disposeSurface();
	});
	it("publishes at most once a second, records the first frame once, and cancels its timer", () => {
		vi.useFakeTimers();
		const host = document.createElement("div");
		const video = document.createElement("video");
		host.append(video);
		Object.defineProperties(video, {
			videoWidth: { value: 640 },
			videoHeight: { value: 360 },
		});
		let count = 0;
		Object.assign(video, {
			getVideoPlaybackQuality: () => ({
				totalVideoFrames: count,
				droppedVideoFrames: 0,
			}),
		});
		const progress = vi.fn();
		const statistics = vi.fn();
		const stop = observeMoqVideo(host, progress, vi.fn(), {
			startedAt: performance.now(),
			onStatistics: statistics,
			source: () => undefined,
		});
		for (let i = 1; i <= 30; i++) {
			count = i;
			video.currentTime = i / 30;
			video.dispatchEvent(new Event("timeupdate"));
		}
		expect(progress).toHaveBeenCalledOnce();
		expect(statistics).not.toHaveBeenCalled();
		vi.advanceTimersByTime(999);
		expect(statistics).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(statistics).toHaveBeenCalledOnce();
		stop.stop();
		stop.disposeSurface();
		vi.advanceTimersByTime(3000);
		expect(statistics).toHaveBeenCalledOnce();
	});
});
