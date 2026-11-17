import { afterEach, describe, expect, it, vi } from "vitest";
import { observeMoqVideo } from "./video-progress";

afterEach(() => vi.useRealTimers());
describe("MoQ telemetry publication cadence", () => {
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
		stop();
		vi.advanceTimersByTime(3000);
		expect(statistics).toHaveBeenCalledOnce();
	});
});
