import { describe, expect, it } from "vitest";
import {
	formatMomentTime,
	layoutMomentTracks,
	recordingTimeWindows,
} from "./timeline-layout";

const moment = (id: string, start: number, end: number, anchor = start) => ({
	id,
	startInSeconds: start,
	endInSeconds: end,
	anchorInSeconds: anchor,
});

describe("moment timeline geometry", () => {
	it("shows discontinuous recording coverage as separate windows", () => {
		const origin = 1790000000000;
		expect(
			recordingTimeWindows(
				[
					{ start: 0, duration: 5, programDateTime: origin + 10000 },
					{ start: 5, duration: 5, programDateTime: origin + 15000 },
					{
						start: 10,
						duration: 5,
						programDateTime: origin + 20000,
						gap: true,
					},
					{ start: 15, duration: 5, programDateTime: origin + 25000 },
				],
				origin,
			),
		).toEqual([
			{ start: 10, end: 20 },
			{ start: 25, end: 30 },
		]);
	});

	it("keeps exact time positions while separating dense hit areas", () => {
		const input = [
			moment("a", 8100, 8110, 8105),
			moment("b", 8110, 8120, 8115),
			moment("c", 8112, 8130, 8120),
		];
		const result = layoutMomentTracks(input, 10000);
		expect(result.moments.map((item) => item.id)).toEqual(["a", "b", "c"]);
		expect(new Set(result.moments.map((item) => item.lane)).size).toBe(3);
		expect(result.moments[0]?.anchorPercent).toBeCloseTo(81.05);
		expect(result.moments[0]?.endPercent).toBeCloseTo(81.1);
	});

	it("reuses a lane after its previous interval and hit area end", () => {
		const result = layoutMomentTracks(
			[moment("a", 0, 10), moment("b", 500, 510)],
			1000,
		);
		expect(result.lanes).toBe(1);
	});

	it("keeps edge hit targets inside the axis without shifting their time", () => {
		const result = layoutMomentTracks(
			[moment("start", 0, 2, 0), moment("end", 98, 100, 100)],
			100,
		);
		expect(result.moments[0]?.anchorPercent).toBe(0);
		expect(result.moments[1]?.anchorPercent).toBe(100);
		for (const item of result.moments) {
			expect(item.hitLeftPercent).toBeGreaterThanOrEqual(0);
			expect(item.hitLeftPercent + item.hitWidthPercent).toBeLessThanOrEqual(
				100,
			);
		}
	});

	it("retains every overlapping moment instead of hiding or merging it", () => {
		const input = Array.from({ length: 25 }, (_, i) =>
			moment(`m-${i}`, 25, 75, 50),
		);
		const result = layoutMomentTracks(input, 100);
		expect(result.moments).toHaveLength(25);
		expect(result.lanes).toBe(25);
	});

	it("formats media times with hours and bounded tenths rather than raw seconds", () => {
		expect(formatMomentTime(9089.8)).toBe("2:31:29.8");
		expect(formatMomentTime(59.99999999)).toBe("1:00.0");
		expect(formatMomentTime(0)).toBe("0:00.0");
	});
});
