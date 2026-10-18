import { expect, it } from "vitest";
import { usageBackfillJobSchema } from "./backfill";
import {
	usageRefreshIsFresh,
	usageRefreshRange,
	usageStatisticsRequestSchema,
} from "./refresh";

const now = new Date("2026-10-16T00:00:00Z");
const accountId = "11111111-1111-4111-8111-111111111111";
it("accepts automatic intent without client dates and retains legacy manual requests", () => {
	expect(
		usageStatisticsRequestSchema.parse({ accountId, mode: "automatic" }),
	).toEqual({ accountId, mode: "automatic" });
	expect(
		usageStatisticsRequestSchema.parse({
			accountId,
			from: "2024-01-01",
			to: "2024-01-02",
		}),
	).toMatchObject({ from: "2024-01-01" });
	for (const request of [
		{ accountId, mode: "automatic", from: "2013-01-01" },
		{ accountId, mode: "other", from: "2024-01-01", to: "2024-01-02" },
	])
		expect(usageStatisticsRequestSchema.safeParse(request).success).toBe(false);
});
it("marks only automatic queued data without changing old job compatibility", () => {
	const base = {
		accountId,
		from: "2024-01-01",
		to: "2024-01-02",
		generation: accountId,
	};
	expect(
		usageBackfillJobSchema.parse({ ...base, automatic: true }).automatic,
	).toBe(true);
	expect(usageBackfillJobSchema.parse(base).automatic).toBeUndefined();
});
it("uses UTC today, a missing-kind initial window, and the whole older-cursor gap", () => {
	expect(usageRefreshRange(now, [])).toEqual({
		from: "2026-07-19",
		to: "2026-10-16",
	});
	expect(
		usageRefreshRange(now, [
			{
				kind: "VOD",
				sweptThrough: new Date("2014-01-01"),
				sweptAt: new Date(0),
			},
		]).from,
	).toBe("2013-12-29");
	expect(
		usageRefreshRange(now, [
			{
				kind: "LIVE",
				sweptThrough: new Date("2013-01-01"),
				sweptAt: new Date(0),
			},
		]).from,
	).toBe("2013-01-01");
});
it("requires both kinds to cover the current UTC day and expire the success TTL at fifteen minutes", () => {
	const fresh = ["VOD", "LIVE"].map((kind) => ({
		kind: kind as "VOD" | "LIVE",
		sweptThrough: now,
		sweptAt: now,
	}));
	expect(usageRefreshIsFresh(now, fresh)).toBe(true);
	expect(usageRefreshIsFresh(now, fresh.slice(0, 1))).toBe(false);
	expect(
		usageRefreshIsFresh(new Date(now.getTime() + 15 * 60_000), fresh),
	).toBe(false);
	expect(usageRefreshIsFresh(new Date("2026-10-17"), fresh)).toBe(false);
});
