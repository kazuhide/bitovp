import { describe, expect, it } from "vitest";
import {
	buildUsageSeries,
	summarizeProviderDay,
	usageBreakdownSchema,
	usageSeriesSchema,
} from "./statistics";

function row(account: string, date: string, units?: number) {
	const value = summarizeProviderDay("LIVE", {
		date,
		...(units === undefined ? {} : { liveHdUnits: units }),
	});
	if (!value) throw new Error("Invalid fixture date");
	return {
		...value,
		bitmovinAccountId: account,
	};
}
function series(rows: ReturnType<typeof row>[]) {
	return buildUsageSeries({
		from: "2026-09-07",
		to: "2026-09-08",
		accounts: [],
		accountIds: ["a", "b"],
		cursors: [],
		rows,
	});
}
describe("Live HD usage provenance", () => {
	it("sums independent account units, preserves zero, and never converts encoding minutes", () => {
		const rows = [
			row("a", "2026-09-07", 56),
			row("b", "2026-09-07", 2),
			row("a", "2026-09-08", 0),
			row("b", "2026-09-08", 0),
		];
		expect(usageBreakdownSchema.parse(rows[0]?.breakdown).liveHdUnits).toBe(56);
		const result = series(rows);
		expect(result.liveHd).toEqual({
			totalUnits: 58,
			missingDays: 0,
			days: [
				{ date: "2026-09-07", units: 58 },
				{ date: "2026-09-08", units: 0 },
			],
		});
		expect(result.totals.LIVE.billableEncodingMinutes).toBe(0);
		expect(usageSeriesSchema.safeParse(result).success).toBe(true);
	});
	it("does not call a partial multi-account or legacy period total zero", () => {
		const result = series([
			row("a", "2026-09-07", 56),
			row("b", "2026-09-07", 2),
			row("a", "2026-09-08", 0),
			row("b", "2026-09-08"),
		]);
		expect(result.liveHd).toEqual({
			totalUnits: null,
			missingDays: 1,
			days: [
				{ date: "2026-09-07", units: 58 },
				{ date: "2026-09-08", units: null },
			],
		});
	});
	it("requires identity and ignores unselected accounts without masking missing selected rows", () => {
		expect(
			series([row("a", "2026-09-07", 56), row("other", "2026-09-07", 3)]).liveHd
				?.days[0]?.units,
		).toBeNull();
	});
	it("does not multiply a duplicated account snapshot", () => {
		expect(
			series([
				row("a", "2026-09-07", 56),
				row("a", "2026-09-07", 56),
				row("b", "2026-09-07", 2),
			]).liveHd?.days[0]?.units,
		).toBeNull();
	});
});
