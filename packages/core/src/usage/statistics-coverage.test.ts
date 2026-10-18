import { describe, expect, it } from "vitest";
import { buildUsageSeries, summarizeProviderDay } from "./statistics";

describe("historical statistics coverage", () => {
	const zero = (account: string, kind: "VOD" | "LIVE", date = "2020-01-01") => {
		const row = summarizeProviderDay(kind, { date, liveHdUnits: 0 });
		if (!row) throw new Error("Invalid fixture date");
		return { ...row, bitmovinAccountId: account };
	};
	const build = (rows: ReturnType<typeof zero>[]) =>
		buildUsageSeries({
			from: "2020-01-01",
			to: "2020-01-02",
			accounts: [],
			accountIds: ["a"],
			rows,
			cursors: [
				{
					bitmovinAccountId: "a",
					kind: "VOD",
					sweptThrough: "2026-09-21",
					sweptAt: new Date(),
				},
			],
		});
	it("distinguishes successfully read quiet days from absent historical snapshots", () => {
		expect(build([zero("a", "VOD"), zero("a", "LIVE")]).coverage).toEqual({
			missingDays: 1,
			days: [
				{ date: "2020-01-01", VOD: true, LIVE: true },
				{ date: "2020-01-02", VOD: false, LIVE: false },
			],
		});
	});
	it("another account and duplicate snapshots cannot establish completeness", () => {
		expect(
			build([zero("b", "VOD"), zero("a", "LIVE"), zero("a", "LIVE")]).coverage
				?.days[0],
		).toEqual({ date: "2020-01-01", VOD: false, LIVE: false });
	});
});
