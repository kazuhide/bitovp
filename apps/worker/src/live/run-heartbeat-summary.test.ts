import { describe, expect, it, vi } from "vitest";
import {
	createRunHeartbeatSummarizer,
	RUN_SUMMARY_BATCH,
	RUN_SUMMARY_MAX_ROWS,
} from "./run-heartbeat-summary";

/**
 * The write-once summary of an ended run. The store applies the where
 * clauses it is given (the honest-double discipline): a candidate query
 * that forgot `heartbeatSummaryAt: null` would re-summarize every ended run
 * forever, and a CAS that forgot it would double-write — both are red here.
 */

type RunRow = {
	id: string;
	endedAt: Date | null;
	lastHeartbeatAt: Date | null;
	heartbeatSummary?: unknown;
	heartbeatSummaryAt?: Date | null;
};

const ROW_AT = new Date("2026-09-02T09:31:01.000Z");

function makeStore(over: {
	runs: RunRow[];
	heartbeats?: Record<string, { at: Date; raw: unknown; deltas: unknown }[]>;
}) {
	const runs = over.runs.map((run) => ({
		heartbeatSummaryAt: null,
		...run,
	}));
	const prisma = {
		liveChannelRun: {
			findMany: vi.fn(
				async (args: {
					where: { endedAt: { not: null }; heartbeatSummaryAt: null };
					orderBy: { endedAt: "asc" };
					take: number;
				}) =>
					runs
						.filter((run) =>
							"endedAt" in args.where ? run.endedAt !== null : true,
						)
						.filter((run) =>
							"heartbeatSummaryAt" in args.where
								? run.heartbeatSummaryAt === null
								: true,
						)
						.sort(
							(a, b) =>
								(a.endedAt?.getTime() ?? 0) - (b.endedAt?.getTime() ?? 0),
						)
						.slice(0, args.take)
						.map((run) => ({
							id: run.id,
							endedAt: run.endedAt,
							lastHeartbeatAt: run.lastHeartbeatAt,
						})),
			),
			updateMany: vi.fn(
				async (args: {
					where: { id: string; endedAt: Date; heartbeatSummaryAt: null };
					data: { heartbeatSummary: unknown; heartbeatSummaryAt: Date };
				}) => {
					let count = 0;
					for (const run of runs) {
						if (
							run.id === args.where.id &&
							run.endedAt?.getTime() === args.where.endedAt.getTime() &&
							run.heartbeatSummaryAt === null
						) {
							run.heartbeatSummary = args.data.heartbeatSummary;
							run.heartbeatSummaryAt = args.data.heartbeatSummaryAt;
							count += 1;
						}
					}
					return { count };
				},
			),
		},
		liveHeartbeat: {
			findMany: vi.fn(
				async (args: {
					where: { liveChannelRunId: string };
					orderBy: { at: "desc" };
					take: number;
				}) =>
					(over.heartbeats?.[args.where.liveChannelRunId] ?? [])
						.slice()
						.sort((a, b) => b.at.getTime() - a.at.getTime())
						.slice(0, args.take),
			),
		},
	};
	return { prisma, runs };
}

const connectedRow = (at: Date) => ({
	at,
	raw: {
		ingest: { status: "CONNECTED", healthy: true },
		events: [
			{
				time: "2026-09-02T07:49:51.000Z",
				details: { eventType: "WARNING", message: "key-frame interval" },
			},
		],
	},
	deltas: { droppedPacketsAudio: 1 },
});

describe("createRunHeartbeatSummarizer", () => {
	const now = () => "2026-09-02T09:32:00.000Z";

	it("writes the summary ONCE for an ended run and stamps the lock", async () => {
		const store = makeStore({
			runs: [
				{ id: "run-1", endedAt: ROW_AT, lastHeartbeatAt: ROW_AT },
				// Still live: no endedAt → never a candidate.
				{ id: "run-live", endedAt: null, lastHeartbeatAt: ROW_AT },
			],
			heartbeats: {
				"run-1": [
					connectedRow(new Date("2026-09-02T09:30:31.000Z")),
					connectedRow(ROW_AT),
				],
			},
		});
		const summarize = createRunHeartbeatSummarizer({
			prisma: store.prisma as never,
			now,
		});
		await expect(summarize()).resolves.toEqual({ summarized: 1 });
		const run = store.runs.find((row) => row.id === "run-1");
		expect(run?.heartbeatSummaryAt).toEqual(new Date(now()));
		expect(run?.heartbeatSummary).toMatchObject({
			version: 1,
			computedAt: now(),
			sampleCount: 2,
			rowsPruned: false,
			ingest: { connectedPolls: 2, connectedSpanMs: 30_000 },
			packets: { droppedAudio: 2 },
			events: { warning: 1, lastFault: { message: "key-frame interval" } },
		});
		expect(
			store.runs.find((row) => row.id === "run-live")?.heartbeatSummaryAt,
		).toBeNull();

		// Second pass: the lock is set, the candidate query finds nothing, and
		// no second write happens.
		store.prisma.liveChannelRun.updateMany.mockClear();
		await expect(summarize()).resolves.toEqual({ summarized: 0 });
		expect(store.prisma.liveChannelRun.updateMany).not.toHaveBeenCalled();
	});

	it("a run whose rows were already pruned is summarized as rowsPruned, not as a silent run", async () => {
		const store = makeStore({
			runs: [{ id: "run-old", endedAt: ROW_AT, lastHeartbeatAt: ROW_AT }],
		});
		const summarize = createRunHeartbeatSummarizer({
			prisma: store.prisma as never,
			now,
		});
		await summarize();
		expect(store.runs[0]?.heartbeatSummary).toMatchObject({
			sampleCount: 0,
			rowsPruned: true,
		});
	});

	it("a run that never recorded a heartbeat is summarized as empty, with rowsPruned false", async () => {
		const store = makeStore({
			runs: [{ id: "run-never", endedAt: ROW_AT, lastHeartbeatAt: null }],
		});
		const summarize = createRunHeartbeatSummarizer({
			prisma: store.prisma as never,
			now,
		});
		await summarize();
		expect(store.runs[0]?.heartbeatSummary).toMatchObject({
			sampleCount: 0,
			rowsPruned: false,
		});
	});

	it("a revive between the read and the write (endedAt cleared) lands nowhere", async () => {
		const store = makeStore({
			runs: [{ id: "run-1", endedAt: ROW_AT, lastHeartbeatAt: ROW_AT }],
		});
		store.prisma.liveHeartbeat.findMany.mockImplementationOnce(async () => {
			const run = store.runs[0];
			if (run) {
				run.endedAt = null;
			}
			return [];
		});
		const summarize = createRunHeartbeatSummarizer({
			prisma: store.prisma as never,
			now,
		});
		await expect(summarize()).resolves.toEqual({ summarized: 0 });
		expect(store.runs[0]?.heartbeatSummaryAt).toBeNull();
	});

	it("drains a backlog oldest-ending first, RUN_SUMMARY_BATCH per tick, reading at most RUN_SUMMARY_MAX_ROWS newest rows", async () => {
		const runs: RunRow[] = Array.from(
			{ length: RUN_SUMMARY_BATCH + 2 },
			(_, i) => ({
				id: `run-${i}`,
				endedAt: new Date(ROW_AT.getTime() - i * 60_000),
				lastHeartbeatAt: null,
			}),
		);
		const store = makeStore({ runs });
		const summarize = createRunHeartbeatSummarizer({
			prisma: store.prisma as never,
			now,
		});
		await expect(summarize()).resolves.toEqual({
			summarized: RUN_SUMMARY_BATCH,
		});
		// The two NEWEST endings (run-0 ended last, run-1 just before it) are
		// the ones left for the next tick.
		expect(
			store.runs
				.filter((run) => run.heartbeatSummaryAt === null)
				.map((run) => run.id),
		).toEqual(["run-0", "run-1"]);
		expect(store.prisma.liveHeartbeat.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				orderBy: { at: "desc" },
				take: RUN_SUMMARY_MAX_ROWS,
			}),
		);
		await expect(summarize()).resolves.toEqual({ summarized: 2 });
	});
});
