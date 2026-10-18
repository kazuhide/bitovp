import { describe, expect, it } from "vitest";
import { mergeLiveOptionsStatistics } from "./live-options-statistics";

const options = () => ({
	summary: { hd: { unitsUsed: 56 } },
	breakdown: [
		{ date: new Date("2026-09-07T00:00:00Z"), hd: { unitsUsed: 56 } },
		{ date: new Date("2026-09-08T00:00:00Z"), hd: { unitsUsed: 0 } },
	],
});
describe("mergeLiveOptionsStatistics", () => {
	it("joins actual units by UTC day and retains quiet days without inventing minutes", () => {
		expect(
			mergeLiveOptionsStatistics(
				[{ date: "2026-09-07", timeEncoded: 123000 }],
				options(),
				"2026-09-07",
				"2026-09-08",
			),
		).toEqual([
			{ date: "2026-09-07", timeEncoded: 123000, liveHdUnits: 56 },
			{ date: "2026-09-08", liveHdUnits: 0 },
		]);
	});
	it.each([
		"missing",
		"duplicate",
		"outside",
		"negative",
		"nonfinite",
		"summary",
	])("rejects %s options data before storing a partial window", (problem) => {
		const value = options();
		const [first, second] = value.breakdown;
		if (!first || !second) throw new Error("Missing fixture day");
		if (problem === "missing") value.breakdown.pop();
		if (problem === "duplicate") value.breakdown[1] = first;
		if (problem === "outside") second.date = new Date("2026-09-09");
		if (problem === "negative") first.hd.unitsUsed = -56;
		if (problem === "nonfinite") first.hd.unitsUsed = NaN;
		if (problem === "summary") value.summary.hd.unitsUsed = 57;
		expect(() =>
			mergeLiveOptionsStatistics([], value, "2026-09-07", "2026-09-08"),
		).toThrow(/Live options/);
	});
	it("refuses duplicate or out-of-window daily rows instead of overwriting units", () => {
		for (const daily of [
			[{ date: "2026-09-06" }],
			[{ date: "2026-09-07" }, { date: "2026-09-07" }],
		]) {
			expect(() =>
				mergeLiveOptionsStatistics(
					daily,
					options(),
					"2026-09-07",
					"2026-09-08",
				),
			).toThrow(/Live daily/);
		}
	});
});
