import { beforeEach, describe, expect, it, vi } from "vitest";

const runFindFirst = vi.fn();
const heartbeatFindMany = vi.fn();
const heartbeatFindFirst = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			liveChannelRun: { findFirst: runFindFirst },
			liveHeartbeat: {
				findMany: heartbeatFindMany,
				findFirst: heartbeatFindFirst,
			},
		},
	}),
}));

import {
	GET,
	HEARTBEAT_LOG_PAGE_MAX,
	type HeartbeatLogResponse,
} from "./route";

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000c1";
const RUN_ID = "00000000-0000-4000-8000-0000000000c2";
const T0 = Date.parse("2026-09-02T07:44:30.000Z");
const ctx = () => ({
	params: Promise.resolve({ id: CHANNEL_ID, runId: RUN_ID }),
});
const get = (query = "") =>
	GET(
		new Request(
			`http://test/api/live-channels/${CHANNEL_ID}/runs/${RUN_ID}/heartbeats${query}`,
		),
		ctx(),
	);

/** An HONEST store: applies where/orderBy/take/cursor over the rows it holds. */
function storeRows(count: number) {
	const rows = Array.from({ length: count }, (_, i) => ({
		id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
		at: new Date(T0 + i * 30_000),
		raw: {
			ingest: { status: i < 2 ? "WAITING_FOR_FIRST_CONNECT" : "CONNECTED" },
			events:
				i >= 2
					? [
							{
								time: "2026-09-02T07:45:19.000Z",
								details: { eventType: "FIRST_CONNECT", message: null },
							},
						]
					: [],
		},
		deltas: { droppedPacketsAudio: i },
	}));
	heartbeatFindMany.mockImplementation(
		async (args: {
			where: { at?: { gte?: Date; lte?: Date } };
			orderBy: unknown;
			take: number;
			cursor?: { id: string };
			skip?: number;
		}) => {
			let list = rows.filter((row) => {
				const gte = args.where.at?.gte;
				const lte = args.where.at?.lte;
				return (
					(!gte || row.at.getTime() >= gte.getTime()) &&
					(!lte || row.at.getTime() <= lte.getTime())
				);
			});
			if (args.cursor) {
				const index = list.findIndex((row) => row.id === args.cursor?.id);
				list = index >= 0 ? list.slice(index + (args.skip ?? 0)) : [];
			}
			return list.slice(0, args.take);
		},
	);
	heartbeatFindFirst.mockImplementation(
		async () => rows[rows.length - 1] ?? null,
	);
	return rows;
}

beforeEach(() => {
	vi.clearAllMocks();
	runFindFirst.mockResolvedValue({
		id: RUN_ID,
		seq: 3,
		status: "STOPPED",
		createdAt: new Date(T0 - 60_000),
		endedAt: new Date(T0 + 3_600_000),
		heartbeatSummary: null,
	});
	heartbeatFindMany.mockResolvedValue([]);
	heartbeatFindFirst.mockResolvedValue(null);
});

describe("GET …/runs/[runId]/heartbeats — the per-run heartbeat log", () => {
	it("pages oldest-first by row id: limit+1 read, nextCursor on a full page, absent on the last", async () => {
		storeRows(5);
		const first = await get("?limit=2");
		expect(first.status).toBe(200);
		const page1 = (await first.json()) as HeartbeatLogResponse;
		expect(heartbeatFindMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: { liveChannelId: CHANNEL_ID, liveChannelRunId: RUN_ID },
				orderBy: [{ at: "asc" }, { id: "asc" }],
				take: 3,
				select: { id: true, at: true, raw: true, deltas: true },
			}),
		);
		expect(page1.rows.map((row) => row.at)).toEqual([
			new Date(T0).toISOString(),
			new Date(T0 + 30_000).toISOString(),
		]);
		expect(page1.nextCursor).toBe(page1.rows[1]?.id);
		// The row is the PERSISTED sample, deltas included, no projection.
		expect(page1.rows[0]).toMatchObject({
			raw: { ingest: { status: "WAITING_FOR_FIRST_CONNECT" } },
			deltas: { droppedPacketsAudio: 0 },
		});

		const second = await get(`?limit=2&cursor=${page1.nextCursor}`);
		const page2 = (await second.json()) as HeartbeatLogResponse;
		expect(heartbeatFindMany).toHaveBeenLastCalledWith(
			expect.objectContaining({ cursor: { id: page1.nextCursor }, skip: 1 }),
		);
		expect(page2.rows.map((row) => row.at)).toEqual([
			new Date(T0 + 60_000).toISOString(),
			new Date(T0 + 90_000).toISOString(),
		]);
		const third = await get(`?limit=2&cursor=${page2.nextCursor}`);
		const page3 = (await third.json()) as HeartbeatLogResponse;
		expect(page3.rows).toHaveLength(1);
		expect(page3.nextCursor).toBeUndefined();
	});

	it("sends the run header, its parsed summary, and the newest sample's event list with the FIRST page only", async () => {
		storeRows(3);
		runFindFirst.mockResolvedValue({
			id: RUN_ID,
			seq: 3,
			status: "STOPPED",
			createdAt: new Date(T0 - 60_000),
			endedAt: new Date(T0 + 3_600_000),
			heartbeatSummary: {
				version: 1,
				computedAt: "2026-09-02T09:32:00.000Z",
				sampleCount: 3,
				firstAt: null,
				lastAt: null,
				rowsPruned: false,
				ingest: {
					connectedPolls: 1,
					connectedSpans: 1,
					connectedSpanMs: 0,
					firstConnectedAt: null,
					lastConnectedAt: null,
					statusCounts: {},
				},
				output: { flowingPolls: 0, flowingSpanMs: 0 },
				packets: {
					droppedVideo: 0,
					droppedAudio: 3,
					corruptVideo: 0,
					corruptAudio: 0,
				},
				events: {
					total: 1,
					warning: 0,
					error: 0,
					firstConnect: 1,
					disconnect: 0,
					reconnect: 0,
					lastFault: null,
				},
			},
		});
		const first = (await (
			await get("?limit=2")
		).json()) as HeartbeatLogResponse;
		expect(first.run).toEqual({
			id: RUN_ID,
			seq: 3,
			status: "STOPPED",
			createdAt: new Date(T0 - 60_000).toISOString(),
			endedAt: new Date(T0 + 3_600_000).toISOString(),
			summary: expect.objectContaining({ sampleCount: 3 }),
		});
		expect(first.latestEvents).toEqual([
			expect.objectContaining({ eventType: "FIRST_CONNECT" }),
		]);
		expect(heartbeatFindFirst).toHaveBeenCalledTimes(1);
		const second = (await (
			await get(`?limit=2&cursor=${first.nextCursor}`)
		).json()) as HeartbeatLogResponse;
		expect(second.latestEvents).toBeUndefined();
		expect(heartbeatFindFirst).toHaveBeenCalledTimes(1);
	});

	it("a malformed summary column is null, never a 500", async () => {
		storeRows(1);
		runFindFirst.mockResolvedValue({
			id: RUN_ID,
			seq: 1,
			status: "STOPPED",
			createdAt: new Date(T0),
			endedAt: null,
			heartbeatSummary: { version: 99 },
		});
		const body = (await (await get()).json()) as HeartbeatLogResponse;
		expect(body.run.summary).toBeNull();
	});

	it("from/to window the poll time inclusively", async () => {
		storeRows(5);
		const from = new Date(T0 + 30_000).toISOString();
		const to = new Date(T0 + 90_000).toISOString();
		const body = (await (
			await get(
				`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
			)
		).json()) as HeartbeatLogResponse;
		expect(heartbeatFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					liveChannelId: CHANNEL_ID,
					liveChannelRunId: RUN_ID,
					at: { gte: new Date(from), lte: new Date(to) },
				},
			}),
		);
		expect(body.rows).toHaveLength(3);
	});

	it("refuses a page above the cap, a non-ISO window, an inverted window and a malformed cursor with 400", async () => {
		for (const query of [
			`?limit=${HEARTBEAT_LOG_PAGE_MAX + 1}`,
			"?limit=0",
			"?from=yesterday",
			`?from=${encodeURIComponent(new Date(T0 + 60_000).toISOString())}&to=${encodeURIComponent(new Date(T0).toISOString())}`,
			"?cursor=nope",
		]) {
			const res = await get(query);
			expect(res.status, query).toBe(400);
		}
		expect(heartbeatFindMany).not.toHaveBeenCalled();
	});

	it("404s a run that is not on this channel — the lookup carries BOTH ids", async () => {
		runFindFirst.mockResolvedValue(null);
		const res = await get();
		expect(res.status).toBe(404);
		expect(runFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: RUN_ID, liveChannelId: CHANNEL_ID },
			}),
		);
		expect(heartbeatFindMany).not.toHaveBeenCalled();
	});

	it("400s a non-UUID channel or run id before touching the store", async () => {
		const bad = await GET(new Request("http://test"), {
			params: Promise.resolve({ id: CHANNEL_ID, runId: "run-1" }),
		});
		expect(bad.status).toBe(400);
		expect(runFindFirst).not.toHaveBeenCalled();
	});
});
