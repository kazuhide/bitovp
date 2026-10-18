import type BitmovinApi from "@bitmovin/api-sdk";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import {
	createUsageStatisticsProvider,
	localCalendarDay,
	sweepUsageStatistics,
	USAGE_SWEEP_CHUNK_DAYS,
	type UsageStatisticsProvider,
	usageSweepFrom,
} from "./statistics-sweep";

/**
 *  / rev426. The sweep backfills the retention window for every
 * account × kind that has no cursor, re-reads the trailing days behind the
 * cursor otherwise, chunks every date-range call to ≤25 days, upserts on
 * account × date × kind, advances the cursor only after a chunk is stored
 * (R1: a failed live read never hides behind a stored VOD day), skips a
 * provider row without a date, and stops the tick on a 429 while a plain
 * failure only skips that account × kind. The provider seam hands the SDK
 * local-calendar dates (R3) and refuses a truncated page (O1).
 */
type Row = Record<string, unknown>;
function fakePrisma(
	accounts: string[],
	stored: Row[] = [],
	cursors: Row[] = [],
) {
	const rows: Row[] = [...stored];
	const cursorRows: Row[] = [...cursors];
	const upserts: Row[] = [];
	const cursorOf = (accountId: string, kind: string) =>
		cursorRows.find(
			(c) => c.bitmovinAccountId === accountId && c.kind === kind,
		);
	return {
		rows,
		cursorRows,
		upserts,
		prisma: {
			bitmovinAccount: { findMany: async () => accounts.map((id) => ({ id })) },
			usageSweepCursor: {
				updateMany: async (args: {
					where: {
						bitmovinAccountId: string;
						kind: string;
						sweptThrough: { lte: Date };
						sweptAt: { lte: Date };
					};
					data: Row;
				}) => {
					const c = cursorOf(args.where.bitmovinAccountId, args.where.kind);
					if (
						!c ||
						(c.sweptThrough as Date).getTime() >
							args.where.sweptThrough.lte.getTime() ||
						(c.sweptAt as Date).getTime() > args.where.sweptAt.lte.getTime()
					)
						return { count: 0 };
					Object.assign(c, args.data);
					return { count: 1 };
				},
				findUnique: async (args: {
					where: {
						bitmovinAccountId_kind: { bitmovinAccountId: string; kind: string };
					};
				}) => {
					const k = args.where.bitmovinAccountId_kind;
					const c = cursorOf(k.bitmovinAccountId, k.kind);
					return c ? { sweptThrough: c.sweptThrough } : null;
				},
				upsert: async (args: {
					where: {
						bitmovinAccountId_kind: { bitmovinAccountId: string; kind: string };
					};
					create: Row;
					update: Row;
				}) => {
					const k = args.where.bitmovinAccountId_kind;
					const c = cursorOf(k.bitmovinAccountId, k.kind);
					if (c) Object.assign(c, args.update);
					else cursorRows.push({ ...args.create });
					return c ?? args.create;
				},
			},
			usageDailyStatistic: {
				upsert: async (args: {
					where: { bitmovinAccountId_date_kind: Row };
					create: Row;
					update: Row;
				}) => {
					upserts.push(args.create);
					const key = args.where.bitmovinAccountId_date_kind;
					const existing = rows.find(
						(r) =>
							r.bitmovinAccountId === key.bitmovinAccountId &&
							(r.date as Date).getTime() === (key.date as Date).getTime() &&
							r.kind === key.kind,
					);
					if (existing) Object.assign(existing, args.update);
					else rows.push({ ...args.create });
					return existing ?? args.create;
				},
			},
		} as unknown as AppPrismaClient,
	};
}
const NOW = new Date("2026-09-06T12:00:00Z");
const day = (key: string) => new Date(`${key}T00:00:00.000Z`);
const keyOf = (d: unknown) => (d as Date).toISOString().slice(0, 10);

describe("usageSweepFrom", () => {
	it("backfills the retention window without a cursor and re-reads the trailing days behind one, never before the edge", () => {
		expect(usageSweepFrom("2026-09-06", null)).toBe("2026-06-09");
		expect(usageSweepFrom("2026-09-06", "2026-09-05")).toBe("2026-09-02");
		expect(usageSweepFrom("2026-09-06", "2026-06-10")).toBe("2026-06-09");
	});
});

describe("sweepUsageStatistics", () => {
	it("maintenance rereads the bounded retention window for all accounts/kinds despite current cursors", async () => {
		const accounts = ["acct", "second"];
		const db = fakePrisma(
			accounts,
			[],
			accounts.flatMap((bitmovinAccountId) =>
				["VOD", "LIVE"].map((kind) => ({
					bitmovinAccountId,
					kind,
					sweptThrough: day("2026-09-06"),
					sweptAt: NOW,
				})),
			),
		);
		const calls: { account: string; kind: string; from: string; to: string }[] =
			[];
		const result = await sweepUsageStatistics({
			prisma: db.prisma,
			rereadRetentionWindow: true,
			now: () => NOW,
			log: () => {},
			providerFor: async (account) => ({
				listDaily: async (kind, from, to) => {
					calls.push({ account, kind, from, to });
					return [
						{
							date: from,
							billableEncodingMinutes: [
								{ codec: "H264", billableMinutes: { HD: 2 } },
							],
						},
					];
				},
			}),
		});
		expect(result).toMatchObject({ accounts: 2, rowsUpserted: 16, errors: [] });
		for (const account of accounts)
			for (const kind of ["VOD", "LIVE"]) {
				const windows = calls.filter(
					(call) => call.account === account && call.kind === kind,
				);
				expect(windows.map(({ from, to }) => [from, to])).toEqual([
					["2026-06-09", "2026-07-03"],
					["2026-07-04", "2026-07-28"],
					["2026-07-29", "2026-08-22"],
					["2026-08-23", "2026-09-06"],
				]);
			}
		for (const row of db.rows)
			expect(row.breakdown).toHaveProperty("encodingClasses", [
				{ codec: "H264", resolution: "HD", billableMinutes: 2 },
			]);
		expect(db.cursorRows.map((row) => keyOf(row.sweptThrough))).toEqual([
			"2026-09-06",
			"2026-09-06",
			"2026-09-06",
			"2026-09-06",
		]);
	});
	it("maintenance stops on 429 without regressing an existing later cursor", async () => {
		const db = fakePrisma(
			["acct", "later"],
			[],
			[
				{
					bitmovinAccountId: "acct",
					kind: "VOD",
					sweptThrough: day("2026-09-06"),
					sweptAt: NOW,
				},
			],
		);
		const calls: string[] = [];
		const result = await sweepUsageStatistics({
			prisma: db.prisma,
			rereadRetentionWindow: true,
			now: () => NOW,
			log: () => {},
			providerFor: async (account) => ({
				listDaily: async (kind, from) => {
					calls.push(`${account}/${kind}/${from}`);
					if (calls.length === 2)
						throw Object.assign(new Error("rate limited"), {
							httpStatusCode: 429,
						});
					return [];
				},
			}),
		});
		expect(result.errors).toEqual(["acct/VOD: rate limited"]);
		expect(calls).toEqual(["acct/VOD/2026-06-09", "acct/VOD/2026-07-04"]);
		expect(db.cursorRows.map((row) => keyOf(row.sweptThrough))).toEqual([
			"2026-09-06",
		]);
	});
	it("maintenance does not claim a later cursor when a cursor write fails", async () => {
		const db = fakePrisma(["acct"]);
		vi.spyOn(db.prisma.usageSweepCursor, "upsert").mockRejectedValueOnce(
			new Error("cursor write failed"),
		);
		const calls: string[] = [];
		const result = await sweepUsageStatistics({
			prisma: db.prisma,
			rereadRetentionWindow: true,
			now: () => NOW,
			log: () => {},
			providerFor: async () => ({
				listDaily: async (kind, from) => {
					calls.push(`${kind}/${from}`);
					return [];
				},
			}),
		});
		expect(result.errors).toEqual(["acct/VOD: cursor write failed"]);
		expect(calls.filter((call) => call.startsWith("VOD"))).toHaveLength(1);
		expect(
			db.cursorRows.map((row) => [row.kind, keyOf(row.sweptThrough)]),
		).toEqual([["LIVE", "2026-09-06"]]);
	});
	it("chunks the backfill into ≤25-day calls per kind, upserts one row per provider day, skips a row without a date, and leaves both cursors at today", async () => {
		const calls: { kind: string; from: string; to: string }[] = [];
		const provider: UsageStatisticsProvider = {
			listDaily: async (kind, from, to) => {
				calls.push({ kind, from, to });
				const covers = from <= "2026-09-04" && to >= "2026-09-04";
				return kind === "VOD" && covers
					? [
							{
								date: day("2026-09-04"),
								bytesEncoded: 10,
								billableEncodingMinutes: [{ billableMinutes: { HD: 2 } }],
							},
							{ bytesEncoded: 5 }, // no date
						]
					: [];
			},
		};
		const db = fakePrisma(["acct"]);
		const stats = await sweepUsageStatistics({
			prisma: db.prisma,
			providerFor: async () => provider,
			now: () => NOW,
			log: () => {},
		});
		expect(stats).toEqual({
			accounts: 1,
			rowsUpserted: 1,
			skippedNoDate: 1,
			errors: [],
		});
		const vodCalls = calls.filter((c) => c.kind === "VOD");
		expect(vodCalls[0]).toEqual({
			kind: "VOD",
			from: "2026-06-09",
			to: "2026-07-03",
		});
		expect(vodCalls[vodCalls.length - 1]).toEqual({
			kind: "VOD",
			from: "2026-08-23",
			to: "2026-09-06",
		});
		for (const c of calls) {
			const span =
				(day(c.to).getTime() - day(c.from).getTime()) / 86_400_000 + 1;
			expect(span).toBeLessThanOrEqual(USAGE_SWEEP_CHUNK_DAYS);
		}
		expect(calls.filter((c) => c.kind === "LIVE")).toHaveLength(
			vodCalls.length,
		);
		expect(db.rows[0]).toMatchObject({
			bitmovinAccountId: "acct",
			kind: "VOD",
			billableMinutes: 2,
			bytesEncoded: 10,
			fetchedAt: NOW,
		});
		expect(
			db.cursorRows.map((c) => [c.kind, keyOf(c.sweptThrough), c.sweptAt]),
		).toEqual([
			["VOD", "2026-09-06", NOW],
			["LIVE", "2026-09-06", NOW],
		]);
	});

	it.each([
		undefined,
		false,
	])("with maintenance=%s, only trailing days are re-read and an existing day is updated in place", async (rereadRetentionWindow) => {
		const db = fakePrisma(
			["acct"],
			[
				{
					bitmovinAccountId: "acct",
					date: day("2026-09-05"),
					kind: "VOD",
					billableMinutes: 1,
					fetchedAt: new Date("2026-09-05T00:00:00Z"),
				},
			],
			[
				{
					bitmovinAccountId: "acct",
					kind: "VOD",
					sweptThrough: day("2026-09-05"),
					sweptAt: day("2026-09-05"),
				},
				{
					bitmovinAccountId: "acct",
					kind: "LIVE",
					sweptThrough: day("2026-09-05"),
					sweptAt: day("2026-09-05"),
				},
			],
		);
		const calls: string[] = [];
		const provider: UsageStatisticsProvider = {
			listDaily: async (kind, from, to) => {
				calls.push(`${kind} ${from}..${to}`);
				return kind === "VOD"
					? [
							// descending provider order is stored all the same (O2)
							{
								date: day("2026-09-06"),
								billableEncodingMinutes: [{ billableMinutes: { SD: 1 } }],
							},
							{
								date: day("2026-09-05"),
								billableEncodingMinutes: [{ billableMinutes: { SD: 7 } }],
							},
						]
					: [];
			},
		};
		await sweepUsageStatistics({
			prisma: db.prisma,
			rereadRetentionWindow,
			providerFor: async () => provider,
			now: () => NOW,
			log: () => {},
		});
		expect(calls).toEqual([
			"VOD 2026-09-02..2026-09-06",
			"LIVE 2026-09-02..2026-09-06",
		]);
		expect(db.rows).toHaveLength(2);
		expect(db.rows[0]).toMatchObject({ billableMinutes: 7, fetchedAt: NOW });
		expect(
			db.cursorRows.map((c) => [c.kind, keyOf(c.sweptThrough), c.sweptAt]),
		).toEqual([
			["VOD", "2026-09-06", NOW],
			["LIVE", "2026-09-06", NOW],
		]);
	});

	it("rev426 R1: a live read that fails after the VOD read stored today does not hide the live days — the next tick still backfills LIVE from the edge", async () => {
		const db = fakePrisma(["acct"]);
		let liveFails = true;
		const calls: string[] = [];
		const provider: UsageStatisticsProvider = {
			listDaily: async (kind, from, to) => {
				calls.push(`${kind} ${from}..${to}`);
				if (kind === "LIVE" && liveFails)
					throw Object.assign(new Error("Too Many Requests"), {
						httpStatusCode: 429,
					});
				return [
					{
						date: day(to),
						billableEncodingMinutes: [{ billableMinutes: { HD: 1 } }],
					},
				];
			},
		};
		const tick = () =>
			sweepUsageStatistics({
				prisma: db.prisma,
				providerFor: async () => provider,
				now: () => NOW,
				log: () => {},
			});
		const first = await tick();
		expect(first.errors).toEqual(["acct/LIVE: Too Many Requests"]);
		// VOD stored through today; LIVE has no cursor at all
		expect(db.cursorRows.map((c) => [c.kind, keyOf(c.sweptThrough)])).toEqual([
			["VOD", "2026-09-06"],
		]);
		calls.length = 0;
		liveFails = false;
		const second = await tick();
		expect(second.errors).toEqual([]);
		expect(calls.filter((c) => c.startsWith("VOD"))).toEqual([
			"VOD 2026-09-03..2026-09-06",
		]);
		const live = calls.filter((c) => c.startsWith("LIVE"));
		expect(live[0]).toBe("LIVE 2026-06-09..2026-07-03");
		expect(live[live.length - 1]).toBe("LIVE 2026-08-23..2026-09-06");
		const liveDays = db.rows.filter((r) => r.kind === "LIVE").length;
		expect(liveDays).toBe(live.length);
		expect(db.cursorRows.map((c) => [c.kind, keyOf(c.sweptThrough)])).toEqual([
			["VOD", "2026-09-06"],
			["LIVE", "2026-09-06"],
		]);
	});

	it("a failure mid-backfill leaves the cursor at the last STORED chunk, and a 429 stops the whole tick", async () => {
		const db = fakePrisma(["acct", "later"]);
		let vodCalls = 0;
		const provider: UsageStatisticsProvider = {
			listDaily: async (kind) => {
				if (kind === "VOD" && ++vodCalls === 2)
					throw Object.assign(new Error("Too Many Requests"), {
						httpStatusCode: 429,
					});
				return [];
			},
		};
		const seen: string[] = [];
		const stats = await sweepUsageStatistics({
			prisma: db.prisma,
			providerFor: async (id) => {
				seen.push(id);
				return provider;
			},
			now: () => NOW,
			log: () => {},
		});
		expect(stats.errors).toEqual(["acct/VOD: Too Many Requests"]);
		expect(db.cursorRows.map((c) => [c.kind, keyOf(c.sweptThrough)])).toEqual([
			["VOD", "2026-07-03"],
		]);
		expect(seen).toEqual(["acct"]);
	});

	it("a failing account is skipped and reported; a plain failure of one kind still sweeps the other", async () => {
		const providerFor = async (
			id: string,
		): Promise<UsageStatisticsProvider> => {
			if (id === "boom") throw new Error("key decrypt failed");
			return {
				listDaily: async (kind) => {
					if (id === "half" && kind === "VOD") throw new Error("vod disabled");
					return [];
				},
			};
		};
		const db = fakePrisma(["boom", "half", "ok"]);
		const stats = await sweepUsageStatistics({
			prisma: db.prisma,
			providerFor,
			now: () => NOW,
			log: () => {},
		});
		expect(stats.errors).toEqual([
			"boom: key decrypt failed",
			"half/VOD: vod disabled",
		]);
		expect(stats.accounts).toBe(3);
		expect(
			db.cursorRows.map((c) => `${c.bitmovinAccountId}/${c.kind}`),
		).toEqual(["half/LIVE", "ok/VOD", "ok/LIVE"]);
	});
});

describe("createUsageStatisticsProvider", () => {
	function fakeApi(
		answer: (
			kind: string,
			from: Date,
			to: Date,
		) => { items?: unknown[]; totalCount?: number },
	) {
		const calls: { kind: string; from: Date; to: Date }[] = [];
		const daily = (kind: string) => ({
			listByDateRange: async (from: Date, to: Date) => {
				calls.push({ kind, from, to });
				return answer(kind, from, to);
			},
		});
		const api = {
			encoding: {
				statistics: {
					encodings: {
						vod: { daily: daily("VOD") },
						live: {
							daily: daily("LIVE"),
							options: {
								listByDateRange: async ({
									from,
									to,
								}: {
									from: Date;
									to: Date;
								}) => {
									const breakdown = [];
									for (
										let day = from.getTime();
										day <= to.getTime();
										day += 86400000
									)
										breakdown.push({
											date: new Date(day),
											hd: { unitsUsed: 0 },
										});
									return { summary: { hd: { unitsUsed: 0 } }, breakdown };
								},
							},
						},
					},
				},
			},
		} as unknown as BitmovinApi;
		return { api, calls };
	}
	const deps = {
		revealBitmovinAccount: async () => ({ apiKey: "k", tenantOrgId: null }),
	};
	it("stores separate provider HD units alongside live daily data, and uses UTC query dates", async () => {
		const { api } = fakeApi(() => ({
			items: [{ date: "2026-09-07", timeEncoded: 123000 }],
			totalCount: 1,
		}));
		const options = vi
			.spyOn(api.encoding.statistics.encodings.live.options, "listByDateRange")
			.mockResolvedValue({
				summary: { hd: { unitsUsed: 56 } },
				breakdown: [{ date: day("2026-09-07"), hd: { unitsUsed: 56 } }],
			});
		const provider = await createUsageStatisticsProvider({
			...deps,
			makeApi: () => api,
		})("acct");
		expect(
			await provider.listDaily("LIVE", "2026-09-07", "2026-09-07"),
		).toEqual([{ date: "2026-09-07", timeEncoded: 123000, liveHdUnits: 56 }]);
		expect(options).toHaveBeenCalledWith({
			from: day("2026-09-07"),
			to: day("2026-09-07"),
			limit: 100,
			offset: 0,
		});
	});
	it("does not advance a live cursor when options retrieval is rate limited", async () => {
		const { api } = fakeApi(() => ({ items: [], totalCount: 0 }));
		vi.spyOn(
			api.encoding.statistics.encodings.live.options,
			"listByDateRange",
		).mockRejectedValue(
			Object.assign(new Error("options rate limited"), { httpStatusCode: 429 }),
		);
		const db = fakePrisma(["acct"]);
		const result = await sweepUsageStatistics({
			prisma: db.prisma,
			providerFor: createUsageStatisticsProvider({
				...deps,
				makeApi: () => api,
			}),
			now: () => NOW,
			log: () => {},
		});
		expect(result.errors).toEqual(["acct/LIVE: options rate limited"]);
		expect(db.cursorRows.map((row) => row.kind)).toEqual(["VOD"]);
	});

	it("rev426 R3: hands the SDK local-calendar dates whose y/m/d ARE the day keys, whatever the host's zone", async () => {
		const { api, calls } = fakeApi(() => ({ items: [], totalCount: 0 }));
		const provider = await createUsageStatisticsProvider({
			...deps,
			makeApi: () => api,
		})("acct");
		await provider.listDaily("LIVE", "2026-08-23", "2026-09-06");
		expect(calls).toHaveLength(1);
		const { kind, from, to } = calls[0] as {
			kind: string;
			from: Date;
			to: Date;
		};
		expect(kind).toBe("LIVE");
		// the SDK's `prepareUrl` formats with getFullYear/getMonth/getDate
		expect([from.getFullYear(), from.getMonth() + 1, from.getDate()]).toEqual([
			2026, 8, 23,
		]);
		expect([to.getFullYear(), to.getMonth() + 1, to.getDate()]).toEqual([
			2026, 9, 6,
		]);
		expect(localCalendarDay("2026-01-01").getMonth()).toBe(0);
	});

	it("rev426 O1: refuses a page that holds fewer items than the provider's total, so a truncated window is never snapshotted", async () => {
		const { api } = fakeApi(() => ({
			items: [{ date: "2026-09-01" }],
			totalCount: 26,
		}));
		const provider = await createUsageStatisticsProvider({
			...deps,
			makeApi: () => api,
		})("acct");
		await expect(
			provider.listDaily("VOD", "2026-08-13", "2026-09-06"),
		).rejects.toThrow(/holds 26 records but answered 1/);
		const ok = fakeApi(() => ({
			items: [{ date: "2026-09-01" }],
			totalCount: 1,
		}));
		const fine = await createUsageStatisticsProvider({
			...deps,
			makeApi: () => ok.api,
		})("acct");
		await expect(
			fine.listDaily("VOD", "2026-08-13", "2026-09-06"),
		).resolves.toHaveLength(25);
	});
});

it.each([
	["2026-09-07", 0],
	["2026-09-06", 60_000],
] as const)("does not regress a concurrent cursor day/time (%s, %s)", async (through, elapsed) => {
	const cursor = {
		bitmovinAccountId: "acct",
		kind: "VOD",
		sweptThrough: day("2026-09-05"),
		sweptAt: day("2026-09-05"),
	};
	const db = fakePrisma(["acct"], [], [cursor]);
	const newer = new Date(NOW.getTime() + elapsed);
	await sweepUsageStatistics({
		prisma: db.prisma,
		now: () => NOW,
		log: () => {},
		providerFor: async () => ({
			listDaily: async (kind) => {
				if (kind === "VOD") {
					const row = db.cursorRows.find((row) => row.kind === "VOD");
					if (row) {
						row.sweptThrough = day(through);
						row.sweptAt = newer;
					}
				}
				return [];
			},
		}),
	});
	expect(db.cursorRows.find((row) => row.kind === "VOD")).toMatchObject({
		sweptThrough: day(through),
		sweptAt: newer,
	});
});
