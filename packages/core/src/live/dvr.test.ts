import { describe, expect, it } from "vitest";
import {
	LIVE_MANIFEST_ELEMENT_BUDGET,
	manifestElementEstimate,
	recommendedMaxTimeshiftSec,
} from "./dvr";

describe("manifestElementEstimate (C8)", () => {
	const cases: {
		name: string;
		timeshiftSec: number;
		segmentLengthSec: number;
		renditionCount: number;
		segmentsPerRendition: number;
		totalElements: number;
		level: "ok" | "warning" | "over";
	}[] = [
		{
			// The COVERAGE §0 reference case: 3h DVR, 6s segments, 10 renditions.
			name: "3h / 6s / 10 renditions (reference)",
			timeshiftSec: 10800,
			segmentLengthSec: 6,
			renditionCount: 10,
			segmentsPerRendition: 1800,
			totalElements: 18000,
			level: "ok",
		},
		{
			name: "ceil on non-divisible timeshift",
			timeshiftSec: 100,
			segmentLengthSec: 6,
			renditionCount: 1,
			segmentsPerRendition: 17,
			totalElements: 17,
			level: "ok",
		},
		{
			name: "zero timeshift = no DVR window",
			timeshiftSec: 0,
			segmentLengthSec: 6,
			renditionCount: 10,
			segmentsPerRendition: 0,
			totalElements: 0,
			level: "ok",
		},
		{
			// 1800 × 24 = 43200 = exactly 80% — warning is EXCLUSIVE (> 0.8).
			name: "exactly 0.8 utilization stays ok",
			timeshiftSec: 10800,
			segmentLengthSec: 6,
			renditionCount: 24,
			segmentsPerRendition: 1800,
			totalElements: 43200,
			level: "ok",
		},
		{
			name: "above 0.8 utilization warns",
			timeshiftSec: 10800,
			segmentLengthSec: 6,
			renditionCount: 25,
			segmentsPerRendition: 1800,
			totalElements: 45000,
			level: "warning",
		},
		{
			// 1800 × 30 = 54000 = exactly the budget — over is EXCLUSIVE (> 1).
			name: "exactly the budget stays warning",
			timeshiftSec: 10800,
			segmentLengthSec: 6,
			renditionCount: 30,
			segmentsPerRendition: 1800,
			totalElements: 54000,
			level: "warning",
		},
		{
			name: "over the budget",
			timeshiftSec: 10800,
			segmentLengthSec: 6,
			renditionCount: 31,
			segmentsPerRendition: 1800,
			totalElements: 55800,
			level: "over",
		},
		{
			name: "long 2s-segment ladder blows the budget",
			timeshiftSec: 21600,
			segmentLengthSec: 2,
			renditionCount: 6,
			segmentsPerRendition: 10800,
			totalElements: 64800,
			level: "over",
		},
	];

	for (const c of cases) {
		it(c.name, () => {
			const estimate = manifestElementEstimate({
				timeshiftSec: c.timeshiftSec,
				segmentLengthSec: c.segmentLengthSec,
				renditionCount: c.renditionCount,
			});
			expect(estimate.segmentsPerRendition).toBe(c.segmentsPerRendition);
			expect(estimate.totalElements).toBe(c.totalElements);
			expect(estimate.budget).toBe(LIVE_MANIFEST_ELEMENT_BUDGET);
			expect(estimate.utilization).toBeCloseTo(
				c.totalElements / LIVE_MANIFEST_ELEMENT_BUDGET,
				10,
			);
			expect(estimate.level).toBe(c.level);
		});
	}

	it("never clamps — over-budget numbers come back verbatim", () => {
		const estimate = manifestElementEstimate({
			timeshiftSec: 108000,
			segmentLengthSec: 1,
			renditionCount: 10,
		});
		expect(estimate.totalElements).toBe(1080000);
		expect(estimate.utilization).toBe(20);
		expect(estimate.level).toBe("over");
	});

	it("rejects non-positive segment lengths and rendition counts", () => {
		expect(() =>
			manifestElementEstimate({
				timeshiftSec: 60,
				segmentLengthSec: 0,
				renditionCount: 1,
			}),
		).toThrow(RangeError);
		expect(() =>
			manifestElementEstimate({
				timeshiftSec: 60,
				segmentLengthSec: 6,
				renditionCount: 0,
			}),
		).toThrow(RangeError);
		expect(() =>
			manifestElementEstimate({
				timeshiftSec: 60,
				segmentLengthSec: 6,
				renditionCount: 1.5,
			}),
		).toThrow(RangeError);
		expect(() =>
			manifestElementEstimate({
				timeshiftSec: -1,
				segmentLengthSec: 6,
				renditionCount: 1,
			}),
		).toThrow(RangeError);
	});
});

describe("recommendedMaxTimeshiftSec", () => {
	const cases: {
		name: string;
		segmentLengthSec: number;
		renditionCount: number;
		expected: number;
	}[] = [
		// floor(54000 / 10) × 6 = 32400s (9h fits the budget at 6s segments).
		{
			name: "6s / 10 renditions",
			segmentLengthSec: 6,
			renditionCount: 10,
			expected: 32400,
		},
		// floor(54000 / 30) × 6 = 10800s — the 3h recommendation emerges.
		{
			name: "6s / 30 renditions",
			segmentLengthSec: 6,
			renditionCount: 30,
			expected: 10800,
		},
		{
			name: "2s / 9 renditions",
			segmentLengthSec: 2,
			renditionCount: 9,
			expected: 12000,
		},
		// More renditions than budget elements: zero DVR is the honest answer.
		{
			name: "ladder larger than the budget",
			segmentLengthSec: 6,
			renditionCount: 54001,
			expected: 0,
		},
	];

	for (const c of cases) {
		it(c.name, () => {
			expect(
				recommendedMaxTimeshiftSec({
					segmentLengthSec: c.segmentLengthSec,
					renditionCount: c.renditionCount,
				}),
			).toBe(c.expected);
		});
	}

	it("round-trips under the budget through manifestElementEstimate", () => {
		const segmentLengthSec = 6;
		const renditionCount = 10;
		const timeshiftSec = recommendedMaxTimeshiftSec({
			segmentLengthSec,
			renditionCount,
		});
		const estimate = manifestElementEstimate({
			timeshiftSec,
			segmentLengthSec,
			renditionCount,
		});
		expect(estimate.totalElements).toBeLessThanOrEqual(
			LIVE_MANIFEST_ELEMENT_BUDGET,
		);
		// One more segment per rendition would not fit.
		expect(
			(estimate.segmentsPerRendition + 1) * renditionCount,
		).toBeGreaterThan(LIVE_MANIFEST_ELEMENT_BUDGET);
	});

	it("rejects invalid inputs", () => {
		expect(() =>
			recommendedMaxTimeshiftSec({ segmentLengthSec: 0, renditionCount: 1 }),
		).toThrow(RangeError);
		expect(() =>
			recommendedMaxTimeshiftSec({ segmentLengthSec: 6, renditionCount: 0 }),
		).toThrow(RangeError);
	});
});
