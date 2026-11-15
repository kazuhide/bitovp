import { describe, expect, it } from "vitest";
import { vodInputTimelineFrameCount } from "./model";

describe("one program frame clock", () => {
	it("does not accumulate a rounded frame per 117ms clip", () => {
		const fps = { num: 30, den: 1 };
		const counts = Array.from({ length: 13 }, (_, index) =>
			vodInputTimelineFrameCount(index * 117, 117, fps),
		);
		expect(counts.reduce((sum, count) => sum + count, 0)).toBe(46);
		expect(counts).toContain(3);
		expect(counts).toContain(4);
	});
	it("identifies intervals that cannot occupy one global output frame", () => {
		expect(vodInputTimelineFrameCount(0, 1, { num: 30, den: 1 })).toBe(0);
		expect(vodInputTimelineFrameCount(0, 1001, { num: 30000, den: 1001 })).toBe(
			30,
		);
	});
});
