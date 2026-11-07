import { describe, expect, it, vi } from "vitest";
import {
	clampMomentSeek,
	createBoundedMomentPlayback,
	resolveMomentPlaybackRange,
} from "./playback";

const origin = 1_790_000_000_000;
const moment = { startInSeconds: 12, endInSeconds: 18, anchorInSeconds: 15 };
const fragments = [
	{ start: 0, programDateTime: origin + 10_000, duration: 5 },
	{ start: 5, programDateTime: origin + 15_000, duration: 5 },
];

describe("AISA recording clock mapping", () => {
	it("uses PDT instead of assuming analysis seconds equal video seconds", () => {
		expect(resolveMomentPlaybackRange(moment, origin, fragments)).toEqual({
			start: 2,
			end: 8,
			anchor: 5,
		});
	});
	it("prefers declared EXTINF duration to a decoder-adjusted duration", () => {
		expect(
			resolveMomentPlaybackRange(
				moment,
				origin,
				fragments.map((fragment) => ({
					...fragment,
					duration: 4.9,
					tagList: [["INF", "5.000000"]],
				})),
			),
		).toEqual({ start: 2, end: 8, anchor: 5 });
	});
	it("requires the complete interval and rejects source gaps or absent clock data", () => {
		expect(
			resolveMomentPlaybackRange(moment, origin, fragments.slice(0, 1)),
		).toBeNull();
		expect(
			resolveMomentPlaybackRange(moment, origin, [
				{ start: 0, programDateTime: origin + 10_000, duration: 5 },
				{ start: 5, duration: 5, programDateTime: origin + 16_000 },
			]),
		).toBeNull();
		expect(
			resolveMomentPlaybackRange(moment, origin, [{ start: 0, duration: 20 }]),
		).toBeNull();
	});
	it("rejects an interval crossing an EXT-X-GAP even when its anchor is present", () => {
		const missingMedia = fragments.map((fragment, index) => ({
			...fragment,
			gap: index === 1,
		}));
		expect(
			resolveMomentPlaybackRange(
				{ ...moment, anchorInSeconds: 14 },
				origin,
				missingMedia,
			),
		).toBeNull();
	});
	it("rejects an interval and anchor contained in an EXT-X-GAP", () => {
		const missingMedia = fragments.map((fragment, index) => ({
			...fragment,
			gap: index === 1,
		}));
		expect(
			resolveMomentPlaybackRange(
				{ startInSeconds: 16, endInSeconds: 18, anchorInSeconds: 17 },
				origin,
				missingMedia,
			),
		).toBeNull();
	});
	it("preserves complete intervals before and after an unrelated EXT-X-GAP", () => {
		const missingMedia = [
			...fragments.map((fragment, index) => ({
				...fragment,
				gap: index === 1,
			})),
			{ start: 10, programDateTime: origin + 20_000, duration: 5 },
		];
		expect(
			resolveMomentPlaybackRange(
				{ startInSeconds: 10, endInSeconds: 15, anchorInSeconds: 12 },
				origin,
				missingMedia,
			),
		).toEqual({ start: 0, end: 5, anchor: 2 });
		expect(
			resolveMomentPlaybackRange(
				{ startInSeconds: 21, endInSeconds: 24, anchorInSeconds: 22 },
				origin,
				missingMedia,
			),
		).toEqual({ start: 11, end: 14, anchor: 12 });
	});
	it("accepts fragment boundary end points and maps the actual anchor", () => {
		expect(
			resolveMomentPlaybackRange(
				{ startInSeconds: 10, endInSeconds: 20, anchorInSeconds: 18 },
				origin,
				fragments,
			),
		).toEqual({ start: 0, end: 10, anchor: 8 });
	});
	it("does not invent an interval for invalid or out-of-range moments", () => {
		expect(
			resolveMomentPlaybackRange(
				{ ...moment, endInSeconds: 12 },
				origin,
				fragments,
			),
		).toBeNull();
		expect(
			resolveMomentPlaybackRange(
				{ ...moment, anchorInSeconds: 21 },
				origin,
				fragments,
			),
		).toBeNull();
		expect(
			resolveMomentPlaybackRange(
				{ ...moment, startInSeconds: 9 },
				origin,
				fragments,
			),
		).toBeNull();
	});
	it("clamps seeks inside the selected moment and keeps the endpoint exclusive", () => {
		const range = { start: 2, end: 8, anchor: 5 };
		expect(clampMomentSeek(-100, range)).toBe(2);
		expect(clampMomentSeek(4, range)).toBe(4);
		expect(clampMomentSeek(100, range)).toBeLessThan(8);
	});

	it("starts at the range, clamps seeks, pauses at its end and replays from its start", async () => {
		const video = document.createElement("video");
		let paused = true;
		Object.defineProperties(video, {
			readyState: { value: 2 },
			paused: { get: () => paused },
		});
		vi.spyOn(video, "pause").mockImplementation(() => {
			paused = true;
		});
		vi.spyOn(video, "play").mockImplementation(async () => {
			paused = false;
		});
		const changed = vi.fn();
		const controller = createBoundedMomentPlayback(
			video,
			() => ({ start: 2, end: 8, anchor: 5 }),
			changed,
		);
		controller.play();
		expect(video.currentTime).toBe(2);
		expect(paused).toBe(false);
		controller.seek(-20);
		expect(video.currentTime).toBe(2);
		controller.seek(20);
		expect(video.currentTime).toBeLessThan(8);
		video.currentTime = 8.1;
		video.dispatchEvent(new Event("timeupdate"));
		expect(paused).toBe(true);
		expect(video.currentTime).toBeLessThan(8);
		expect(changed.mock.calls.at(-1)?.[0].ended).toBe(true);
		controller.play();
		expect(video.currentTime).toBe(2);
		expect(paused).toBe(false);
		controller.destroy();
		video.currentTime = 20;
		video.dispatchEvent(new Event("timeupdate"));
		expect(video.currentTime).toBe(20);
	});
});
