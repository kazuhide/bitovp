import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { readWeeklyOperationAnalytics } from "./operation-analytics";

const organizationId = "00000000-0000-4000-8000-000000000123";
const now = new Date("2026-11-16T00:05:00.000Z");

describe("readWeeklyOperationAnalytics", () => {
	it("queries a single organization's UTC window and preserves empty weeks", async () => {
		const query = vi.fn().mockResolvedValue([]);
		const weeks = await readWeeklyOperationAnalytics(
			{ $queryRaw: query } as Pick<AppPrismaClient, "$queryRaw">,
			organizationId,
			now,
		);

		expect(weeks.map(({ weekStart }) => weekStart)).toEqual([
			"2026-09-28",
			"2026-10-05",
			"2026-10-12",
			"2026-10-19",
			"2026-10-26",
			"2026-11-02",
			"2026-11-09",
			"2026-11-16",
		]);
		expect(weeks.filter(({ isPartial }) => isPartial)).toEqual([
			{
				weekStart: "2026-11-16",
				isPartial: true,
				started: 0,
				firstFrame: 0,
				failed: 0,
				canceled: 0,
				unconfirmed: 0,
				pending: 0,
				firstFrameShare: null,
				p50Ms: null,
				p95Ms: null,
			},
		]);
		expect(query).toHaveBeenCalledTimes(1);
		const [sql, ...values] = query.mock.calls[0] ?? [];
		const statement = (sql as TemplateStringsArray).join("?");
		expect(statement).toContain('"organizationId" = ?::uuid');
		expect(statement).toContain(
			"\"startedAt\" >= (?::timestamptz AT TIME ZONE 'UTC')",
		);
		expect(statement).toContain("percentile_cont(0.95)");
		expect(statement).not.toContain("ownerDigest");
		expect(values).toContain(organizationId);
		expect(values).toContain("2026-09-28T00:00:00.000Z");
		expect(values).toContain(now.toISOString());
		expect(values).toContain("2026-11-15T23:54:00.000Z");
	});

	it("preserves zero duration, unconfirmed attempts and a null share when all attempts are pending", async () => {
		const query = vi.fn().mockResolvedValue([
			{
				weekStart: "2026-11-09",
				started: 5n,
				firstFrame: 2n,
				failed: 1n,
				canceled: 1n,
				pending: 0n,
				p50Ms: 0,
				p95Ms: 0,
			},
			{
				weekStart: "2026-11-16",
				started: 3n,
				firstFrame: 0n,
				failed: 0n,
				canceled: 0n,
				pending: 3n,
				p50Ms: null,
				p95Ms: null,
			},
		]);
		const weeks = await readWeeklyOperationAnalytics(
			{ $queryRaw: query } as Pick<AppPrismaClient, "$queryRaw">,
			organizationId,
			now,
		);
		expect(weeks.at(-2)).toMatchObject({
			isPartial: false,
			firstFrameShare: 0.4,
			unconfirmed: 1,
			p50Ms: 0,
			p95Ms: 0,
		});
		expect(weeks.at(-1)).toMatchObject({
			firstFrameShare: null,
			unconfirmed: 0,
			pending: 3,
			p50Ms: null,
			p95Ms: null,
		});
	});
});
