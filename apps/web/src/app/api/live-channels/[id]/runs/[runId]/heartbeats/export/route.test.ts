import { matchesWhere } from "@bitovp/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runFindFirst = vi.fn();
const heartbeatFindMany = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			liveChannelRun: { findFirst: runFindFirst },
			liveHeartbeat: { findMany: heartbeatFindMany },
		},
	}),
}));

import { GET, HEARTBEAT_EXPORT_BATCH } from "./route";

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000c1";
const RUN_ID = "00000000-0000-4000-8000-0000000000c2";
const T0 = Date.parse("2026-09-02T07:44:30.000Z");
const ctx = () => ({
	params: Promise.resolve({ id: CHANNEL_ID, runId: RUN_ID }),
});

/** A row of ANOTHER run on the same channel, interleaved by `at` (rev409 R1). */
const OTHER_RUN_ID = "00000000-0000-4000-8000-0000000000c3";
const FOREIGN_ROW_ID = "00000000-0000-4000-8000-ffffffffffff";

function storeRows(count: number) {
	const rows = Array.from({ length: count }, (_, i) => ({
		id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
		at: new Date(T0 + i * 30_000),
		liveChannelId: CHANNEL_ID,
		liveChannelRunId: RUN_ID,
		raw: {
			ingest: {
				status: "CONNECTED",
				// The persisted rows are already redacted by the worker; the
				// export passes them through and adds nothing.
				rtmpUserIngestInfo: { streamKey: "[REDACTED]" },
			},
		},
		deltas: { droppedPacketsVideo: i },
	}));
	// The store holds every run of the channel; the export must select ITS
	// run. A double that ignored `where` could not see a lost run filter
	// (rev409 R1), so this one honours it, and a foreign-run row sits in
	// the middle of the `at` order where a lost filter would surface it.
	const foreign = {
		id: FOREIGN_ROW_ID,
		at: new Date(T0 + 15_000),
		liveChannelId: CHANNEL_ID,
		liveChannelRunId: OTHER_RUN_ID,
		raw: { ingest: { status: "CONNECTED" } },
		deltas: { droppedPacketsVideo: 424_242 },
	};
	const store = [...rows.slice(0, 1), foreign, ...rows.slice(1)];
	heartbeatFindMany.mockImplementation(
		async (args: {
			where: Record<string, unknown>;
			take: number;
			cursor?: { id: string };
			skip?: number;
		}) => {
			// The shared reading of `where` (rev409 R1): a lost run filter, or a
			// shape this double does not understand, cannot pass silently.
			let list = store.filter((row) => matchesWhere(row, args.where));
			if (args.cursor) {
				const index = list.findIndex((row) => row.id === args.cursor?.id);
				list = index >= 0 ? list.slice(index + (args.skip ?? 0)) : [];
			}
			return list.slice(0, args.take);
		},
	);
	return rows;
}

beforeEach(() => {
	vi.clearAllMocks();
	runFindFirst.mockResolvedValue({
		id: RUN_ID,
		seq: 7,
		status: "STOPPED",
		bitmovinEncodingId: "enc-1",
		createdAt: new Date(T0 - 60_000),
		runningSince: new Date(T0),
		endedAt: new Date(T0 + 3_600_000),
		heartbeatSummary: null,
	});
});

describe("GET …/runs/[runId]/heartbeats/export — the whole run as one JSON file", () => {
	it("streams EVERY row across batches, oldest first, as a download", async () => {
		const total = HEARTBEAT_EXPORT_BATCH * 2 + 3;
		const rows = storeRows(total);
		const res = await GET(new Request("http://test"), ctx());
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(res.headers.get("content-disposition")).toBe(
			`attachment; filename="heartbeats-${CHANNEL_ID.slice(0, 8)}-run7.json"`,
		);
		const text = await res.text();
		const body = JSON.parse(text) as {
			channelId: string;
			run: { id: string; seq: number; summary: unknown };
			rows: { id: string; at: string; raw: unknown; deltas: unknown }[];
		};
		expect(body.channelId).toBe(CHANNEL_ID);
		expect(body.run).toMatchObject({ id: RUN_ID, seq: 7, summary: null });
		expect(body.rows).toHaveLength(total);
		// rev409 R1: the export is scoped to THIS run — the other run's row
		// (in the `at` order between rows 0 and 1) never reaches the file,
		// and the filter the store saw is exactly channel + run.
		expect(body.rows.map((row) => row.id)).not.toContain(FOREIGN_ROW_ID);
		expect(text).not.toContain('droppedPacketsVideo":424242');
		expect(heartbeatFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { liveChannelId: CHANNEL_ID, liveChannelRunId: RUN_ID },
			}),
		);
		expect(body.rows[0]).toEqual({
			id: rows[0]?.id,
			at: new Date(T0).toISOString(),
			raw: rows[0]?.raw,
			deltas: { droppedPacketsVideo: 0 },
		});
		expect(body.rows[total - 1]?.id).toBe(rows[total - 1]?.id);
		// Three round-trips: two full batches and the short tail, each keyed
		// by the previous batch's last id.
		expect(heartbeatFindMany).toHaveBeenCalledTimes(3);
		expect(heartbeatFindMany).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				cursor: { id: rows[HEARTBEAT_EXPORT_BATCH - 1]?.id },
				skip: 1,
				take: HEARTBEAT_EXPORT_BATCH,
			}),
		);
		// Nothing un-redacted was invented on the way out.
		expect(text).not.toMatch(/streamKey":"(?!\[REDACTED\])/);
	});

	it("a run with no rows is a valid empty document", async () => {
		storeRows(0);
		const res = await GET(new Request("http://test"), ctx());
		const body = JSON.parse(await res.text()) as { rows: unknown[] };
		expect(body.rows).toEqual([]);
		expect(heartbeatFindMany).toHaveBeenCalledTimes(1);
	});

	it("404s a run that is not on this channel", async () => {
		runFindFirst.mockResolvedValue(null);
		const res = await GET(new Request("http://test"), ctx());
		expect(res.status).toBe(404);
		expect(heartbeatFindMany).not.toHaveBeenCalled();
	});

	it("400s a malformed id", async () => {
		const res = await GET(new Request("http://test"), {
			params: Promise.resolve({ id: "x", runId: RUN_ID }),
		});
		expect(res.status).toBe(400);
	});
});
