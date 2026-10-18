import { usageSeriesSchema } from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * . The route shapes stored rows only (no provider call), scopes by
 * account, answers every day of the period, and rejects unreadable stored
 * breakdowns rather than reporting false measured zero usage.
 */
type Row = Record<string, unknown>;
let rows: Row[] = [];
let cursors: Row[] = [];
const scoped = (rowsOf: () => Row[]) =>
	vi.fn(async (args: { where?: Row }) => {
		const acct = (args.where as { bitmovinAccountId?: string } | undefined)
			?.bitmovinAccountId;
		return rowsOf().filter((r) => !acct || r.bitmovinAccountId === acct);
	});
const findMany = scoped(() => rows);
const findCursors = scoped(() => cursors);
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			bitmovinAccount: {
				findMany: async () => [
					{ id: "11111111-1111-4111-8111-111111111111", label: "main" },
					{ id: "22222222-2222-4222-8222-222222222222", label: "second" },
				],
			},
			usageDailyStatistic: { findMany },
			usageSweepCursor: { findMany: findCursors },
		},
	}),
}));

import { GET } from "./route";

const day = (key: string) => new Date(`${key}T00:00:00.000Z`);
const breakdown = {
	buckets: { SD: 0, HD: 3, UHD: 0, AUDIO: 0, UNKNOWN: 0 },
	transmuxingMinutes: 0,
	featureMinutes: 0,
	streams: [
		{
			codec: "H264",
			resolution: "1920x1080",
			encodedSeconds: 180,
			billableMinutes: 3,
		},
	],
	features: [],
	egress: [],
};
function request(query: string): Request {
	return new Request(`http://test/api/dashboard/usage${query}`);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-06T12:00:00Z"));
	findMany.mockClear();
	rows = [
		{
			bitmovinAccountId: "11111111-1111-4111-8111-111111111111",
			date: day("2026-09-05"),
			kind: "VOD",
			bytesEncoded: 100,
			timeEncodedS: 180,
			bytesEgress: 10,
			billableMinutes: 3,
			breakdown,
		},
		{
			bitmovinAccountId: "22222222-2222-4222-8222-222222222222",
			date: day("2026-09-05"),
			kind: "LIVE",
			bytesEncoded: 50,
			timeEncodedS: 600,
			bytesEgress: 0,
			billableMinutes: 10,
			breakdown: {
				...breakdown,
				buckets: { SD: 0, HD: 10, UHD: 0, AUDIO: 0, UNKNOWN: 0 },
				streams: [
					{
						codec: "H264",
						resolution: "1920x1080",
						encodedSeconds: 600,
						billableMinutes: 10,
					},
				],
			},
		},
	];
	const cursor = (acct: string, kind: string, through: string, at: string) => ({
		bitmovinAccountId: acct,
		kind,
		sweptThrough: day(through),
		sweptAt: new Date(at),
	});
	cursors = [
		cursor(
			"11111111-1111-4111-8111-111111111111",
			"VOD",
			"2026-09-06",
			"2026-09-06T06:00:00Z",
		),
		cursor(
			"11111111-1111-4111-8111-111111111111",
			"LIVE",
			"2026-09-06",
			"2026-09-06T06:00:00Z",
		),
		cursor(
			"22222222-2222-4222-8222-222222222222",
			"VOD",
			"2026-09-05",
			"2026-09-06T05:00:00Z",
		),
		cursor(
			"22222222-2222-4222-8222-222222222222",
			"LIVE",
			"2026-09-05",
			"2026-09-06T05:00:00Z",
		),
	];
});

describe("GET /api/dashboard/usage (row #314)", () => {
	it("reads a historical range without joining local encoding jobs", async () => {
		const res = await GET(
			request(
				"?from=2020-01-01&to=2020-01-03&accountId=11111111-1111-4111-8111-111111111111",
			),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.from).toBe("2020-01-01");
		expect(body.to).toBe("2020-01-03");
		expect(body.days).toHaveLength(3);
		expect(body.coverage.missingDays).toBe(3);
		expect(findMany.mock.calls[0]?.[0]).toMatchObject({
			where: {
				bitmovinAccountId: "11111111-1111-4111-8111-111111111111",
				date: { gte: day("2020-01-01"), lte: day("2020-01-03") },
			},
		});
	});
	it.each([
		"?from=2020-01-01",
		"?to=2020-01-01",
		"?from=2020-02-30&to=2020-03-01",
		"?from=2020-02-02&to=2020-02-01",
		"?from=2012-01-01&to=2020-01-01",
		"?from=2026-09-06&to=2026-09-07",
	])("rejects incomplete, invalid or future history ranges: %s", async (query) => {
		expect((await GET(request(query))).status).toBe(400);
	});
	it("rejects an unknown selected account instead of showing an empty account", async () => {
		expect(
			(await GET(request("?accountId=33333333-3333-4333-8333-333333333333")))
				.status,
		).toBe(404);
	});
	it("preserves account identity for Units and never treats an unselected account as coverage", async () => {
		rows[1] = {
			...rows[1],
			breakdown: { ...(rows[1]?.breakdown as object), liveHdUnits: 56 },
		};
		const all = await (await GET(request("?days=7"))).json();
		expect(
			all.liveHd.days.find((day: { date: string }) => day.date === "2026-09-05")
				.units,
		).toBeNull();
		const selected = await (
			await GET(
				request("?days=7&accountId=22222222-2222-4222-8222-222222222222"),
			)
		).json();
		expect(
			selected.liveHd.days.find(
				(day: { date: string }) => day.date === "2026-09-05",
			).units,
		).toBe(56);
		expect(selected.liveHd.totalUnits).toBeNull();
		expect(selected.liveHd.missingDays).toBe(6);
		expect(findMany.mock.calls.at(-1)?.[0]).toMatchObject({
			select: { bitmovinAccountId: true },
		});
	});
	it.each([
		"garbage",
		null,
		undefined,
		{},
	])("fails closed for invalid stored breakdown %j without exposing row data or zero totals", async (invalid) => {
		rows[1] = { ...rows[1], breakdown: invalid };
		const res = await GET(request(""));
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "Stored usage unavailable" });
	});
	it("a corrupt account fails its own selection but does not poison another account", async () => {
		rows[1] = { ...rows[1], breakdown: "garbage" };
		const bad = await GET(
			request("?accountId=22222222-2222-4222-8222-222222222222"),
		);
		expect(bad.status).toBe(500);
		const good = await GET(
			request("?accountId=11111111-1111-4111-8111-111111111111"),
		);
		expect(good.status).toBe(200);
		const body = await good.json();
		expect(body.totals.VOD.billableEncodingMinutes).toBe(3);
		expect(body.totals.LIVE.billableEncodingMinutes).toBe(0);
	});
	it("answers the shared series contract for the default 30 days, all accounts summed, the OLDEST cursor as freshness", async () => {
		const res = await GET(request(""));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(usageSeriesSchema.safeParse(body).success).toBe(true);
		expect(body.days).toHaveLength(30);
		expect(body.from).toBe("2026-08-08");
		expect(body.to).toBe("2026-09-06");
		const sept5 = body.days.find(
			(d: { date: string }) => d.date === "2026-09-05",
		);
		expect(sept5.VOD.billableMinutes).toBe(3);
		expect(sept5.LIVE.billableMinutes).toBe(10);
		expect(sept5.LIVE.billableEncodingMinutes).toBe(10);
		expect(body.accounts.map((a: { label: string }) => a.label)).toEqual([
			"main",
			"second",
		]);
		// account 2's cursors are the older ones: their time, and their one
		// day still ahead of them (Sept 6) — quiet days are NOT pending (rev426 R2)
		expect(body.refreshedAt).toBe("2026-09-06T05:00:00.000Z");
		expect(
			body.breakdown.codecResolution.find(
				(row: { kind: string }) => row.kind === "VOD",
			),
		).toMatchObject({
			kind: "VOD",
			codec: "H264",
			billableMinutes: 3,
		});
		expect(body.breakdown.buckets.LIVE).toEqual({
			SD: 0,
			HD: 10,
			UHD: 0,
			AUDIO: 0,
			UNKNOWN: 0,
		});
		expect(body.pendingDays).toBe(1);
	});

	it("names no freshness while a selected account × kind has never been swept", async () => {
		cursors = cursors.filter(
			(c) =>
				c.kind !== "LIVE" ||
				c.bitmovinAccountId !== "22222222-2222-4222-8222-222222222222",
		);
		const all = await (await GET(request("?days=7"))).json();
		expect(all.refreshedAt).toBeNull();
		expect(all.pendingDays).toBe(7);
		// … but the other account, filtered, is fully swept
		const one = await (
			await GET(
				request("?days=7&accountId=11111111-1111-4111-8111-111111111111"),
			)
		).json();
		expect(one.refreshedAt).toBe("2026-09-06T06:00:00.000Z");
		expect(one.pendingDays).toBe(0);
		expect(findCursors.mock.calls.at(-1)?.[0]).toMatchObject({
			where: { bitmovinAccountId: "11111111-1111-4111-8111-111111111111" },
		});
	});

	it("scopes by accountId and honours the 7-day period", async () => {
		const res = await GET(
			request("?days=7&accountId=22222222-2222-4222-8222-222222222222"),
		);
		const body = await res.json();
		expect(body.days).toHaveLength(7);
		expect(body.totals.VOD.billableMinutes).toBe(0);
		expect(body.totals.LIVE.billableMinutes).toBe(10);
		expect(findMany.mock.calls[0]?.[0]).toMatchObject({
			where: { bitmovinAccountId: "22222222-2222-4222-8222-222222222222" },
		});
	});

	it("refuses a period outside 7/30/90 and a malformed account id with 400", async () => {
		expect((await GET(request("?days=12"))).status).toBe(400);
		expect((await GET(request("?accountId=not-a-uuid"))).status).toBe(400);
	});
});
