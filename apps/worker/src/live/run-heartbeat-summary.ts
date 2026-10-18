import { summarizeRunHeartbeats } from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";

/**
 * The per-run heartbeat summary writer (`LiveChannelRun.heartbeatSummary`).
 *
 * Heartbeat rows are retained for 7 days (`HEARTBEAT_RETENTION_MS`); a run
 * older than that keeps THIS instead — counts, first/last poll, the ingest
 * connected span, packet totals and the provider's WARNING/ERROR events
 * (core `summarizeRunHeartbeats`, the same derivations the run timeline
 * draws). It rides the heartbeat sweep rather than each run-end writer,
 * because a run ends in four places (the stop mirror, the provider
 * reconciler, the stranded-run boot sweep, the dead-job reaper) and a
 * summary hooked into three of them is a summary that silently misses the
 * fourth. Here the signature is one column pair: `endedAt` set and
 * `heartbeatSummaryAt` still null.
 *
 * Written ONCE per ending: the write is a compare-and-swap on
 * `heartbeatSummaryAt IS NULL`, so two workers sweeping the same tick cannot
 * both write, and a revive — which clears `endedAt` and this lock together —
 * gets a fresh summary when the resumed airing ends for real.
 *
 * Bounded per tick (`take`), oldest ending first: a backlog of ended runs
 * (a worker that was down) drains a few per sweep instead of scanning every
 * historical run's rows in one tick.
 */

/** Ended runs summarized per sweep tick. */
export const RUN_SUMMARY_BATCH = 5;
/**
 * Rows read per run. Far above what 7 days at the 30 s cadence can hold
 * (~20k); a run that somehow exceeds it is summarized from its NEWEST rows
 * and says so through `sampleCount` < what the operator expects — never
 * silently from the oldest.
 */
export const RUN_SUMMARY_MAX_ROWS = 50_000;

export function createRunHeartbeatSummarizer(deps: {
	prisma: Pick<AppPrismaClient, "liveChannelRun" | "liveHeartbeat">;
	now(): string;
	batch?: number;
}) {
	return async function summarizeEndedRuns(): Promise<{
		summarized: number;
	}> {
		const candidates = await deps.prisma.liveChannelRun.findMany({
			where: { endedAt: { not: null }, heartbeatSummaryAt: null },
			orderBy: { endedAt: "asc" },
			take: deps.batch ?? RUN_SUMMARY_BATCH,
			select: { id: true, endedAt: true, lastHeartbeatAt: true },
		});
		let summarized = 0;
		for (const run of candidates) {
			if (!run.endedAt) {
				continue;
			}
			const rows = await deps.prisma.liveHeartbeat.findMany({
				where: { liveChannelRunId: run.id },
				orderBy: { at: "desc" },
				take: RUN_SUMMARY_MAX_ROWS,
				select: { at: true, raw: true, deltas: true },
			});
			const computedAt = deps.now();
			const summary = summarizeRunHeartbeats(rows, {
				computedAt,
				// The run DID record heartbeats (the anchor says so) and none is
				// left: retention won — say so instead of writing a silent run.
				rowsPruned: rows.length === 0 && run.lastHeartbeatAt !== null,
			});
			const { count } = await deps.prisma.liveChannelRun.updateMany({
				// The CAS: still ended, still unsummarized. A revive between the
				// read and this write clears endedAt and the write lands nowhere.
				where: { id: run.id, endedAt: run.endedAt, heartbeatSummaryAt: null },
				data: {
					heartbeatSummary: summary as unknown as Prisma.InputJsonValue,
					heartbeatSummaryAt: new Date(computedAt),
				},
			});
			summarized += count;
		}
		return { summarized };
	};
}

export type RunHeartbeatSummarizer = ReturnType<
	typeof createRunHeartbeatSummarizer
>;
