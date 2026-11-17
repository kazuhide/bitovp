import { describe, expect, it } from "vitest";
import { createVideoStatistics } from "./video-statistics";

function fixture() {
	let clock = 100;
	let total = 0;
	let dropped = 0;
	const video = document.createElement("video");
	Object.defineProperties(video, {
		videoWidth: { value: 640 },
		videoHeight: { value: 360 },
		webkitDecodedFrameCount: { get: () => total },
	});
	Object.assign(video, {
		getVideoPlaybackQuality: () => ({
			totalVideoFrames: total,
			droppedVideoFrames: dropped,
		}),
	});
	return {
		video,
		now: () => clock,
		advance: (ms: number, count: number, lost = 0) => {
			clock += ms;
			total = count;
			dropped = lost;
			video.currentTime = clock / 1000;
		},
	};
}
describe("measured MoQ video statistics", () => {
	it("requires rendered frames for fallback startup and latency freshness", () => {
		const f = fixture();
		const stats = createVideoStatistics(
			0,
			() => ({ getLatency: () => 0.4 }),
			f.now,
		);
		stats.setVideo(f.video);
		f.advance(100, 3, 3);
		expect(stats.frame()).toBe(false);
		expect(stats.snapshot()).toMatchObject({
			startupMs: null,
			latencySeconds: null,
		});
		f.advance(100, 4, 3);
		expect(stats.frame()).toBe(true);
		expect(stats.snapshot().latencySeconds).toBe(0.4);
		f.advance(1001, 6, 5);
		expect(stats.frame()).toBe(false);
		expect(stats.snapshot().latencySeconds).toBeNull();
	});
	it("measures frame rate from counter deltas and wall time, plus first observed frame startup", () => {
		const f = fixture();
		const stats = createVideoStatistics(0, () => undefined, f.now);
		stats.setVideo(f.video);
		f.advance(100, 1);
		stats.frame(1, 0);
		expect(stats.snapshot()).toMatchObject({
			resolution: "640×360",
			startupMs: 200,
			presentedFrames: 1,
			decodedFrames: 1,
			droppedFrames: 0,
			fps: null,
		});
		f.advance(1000, 31, 2);
		stats.frame(31, 1);
		expect(stats.snapshot()).toMatchObject({
			fps: 30,
			presentedFrames: 31,
			decodedFrames: 31,
			droppedFrames: 2,
			startupMs: 200,
		});
	});
	it("reports verified SDK seconds with their source and requires fresh frames for barcode latency", () => {
		const f = fixture();
		const stats = createVideoStatistics(
			0,
			() => ({ getLatency: () => 0.45, getBufferLevel: () => 1.2 }),
			f.now,
		);
		stats.setVideo(f.video);
		expect(stats.snapshot().latencySeconds).toBeNull();
		f.advance(100, 1);
		stats.frame(1, 0);
		expect(stats.snapshot()).toMatchObject({
			latencySeconds: 0.45,
			bufferSeconds: 1.2,
			bufferSource: "player",
		});
		f.advance(1001, 1);
		expect(stats.snapshot().latencySeconds).toBeNull();
	});
	it("uses only a buffered range containing currentTime when the SDK buffer API is unavailable", () => {
		const f = fixture();
		f.video.currentTime = 3;
		Object.defineProperty(f.video, "buffered", {
			value: {
				length: 2,
				start: (i: number) => [0, 8][i],
				end: (i: number) => [5, 10][i],
			},
		});
		const stats = createVideoStatistics(0, () => undefined, f.now);
		stats.setVideo(f.video);
		expect(stats.snapshot()).toMatchObject({
			bufferSeconds: 2,
			bufferSource: "video",
		});
		f.video.currentTime = 6;
		expect(stats.snapshot()).toMatchObject({
			bufferSeconds: null,
			bufferSource: null,
		});
	});
	it("keeps absent, nonfinite, negative, or throwing metrics unknown rather than zero", () => {
		const video = document.createElement("video");
		Object.assign(video, {
			getVideoPlaybackQuality: () => ({
				totalVideoFrames: Number.NaN,
				droppedVideoFrames: -1,
			}),
		});
		const stats = createVideoStatistics(
			0,
			() => ({
				getLatency: () => Number.POSITIVE_INFINITY,
				getBufferLevel: () => {
					throw new Error("private-url");
				},
			}),
			() => 10,
		);
		stats.setVideo(video);
		expect(stats.snapshot()).toEqual({
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
	});
	it("resets counters when the video disappears and does not compare different video counters", () => {
		const f = fixture();
		const stats = createVideoStatistics(0, () => undefined, f.now);
		stats.setVideo(f.video);
		f.advance(100, 1);
		stats.frame(1, 0);
		stats.snapshot();
		stats.setVideo(null);
		expect(
			Object.values(stats.snapshot()).every((value) => value === null),
		).toBe(true);
		stats.setVideo(document.createElement("video"));
		expect(stats.snapshot().fps).toBeNull();
	});
	it("keeps only public quality names and dimensions, without inferring bitrate or FPS", () => {
		const f = fixture();
		const stats = createVideoStatistics(
			0,
			() => ({
				getVideoQuality: () => ({
					name: "360p",
					width: 640,
					height: 360,
					bitrate: 800000,
					fps: 30,
					url: "https://private-token",
				}),
				getAvailableVideoQualities: () => [
					{ name: "720p", width: 1280, height: 720 },
					{ name: "https://private-token", width: Number.NaN, height: -1 },
				],
			}),
			f.now,
		);
		stats.setVideo(f.video);
		expect(stats.snapshot()).toMatchObject({
			currentQuality: { name: "360p", width: 640, height: 360 },
			availableQualities: [{ name: "720p", width: 1280, height: 720 }],
		});
		expect(JSON.stringify(stats.snapshot())).not.toMatch(
			/private-token|bitrate/,
		);
	});
});
