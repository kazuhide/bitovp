import {
	liveChannelPlanSchema,
	resolveStartupRegion,
	type StepLogEntry,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";

/**
 * Startup-time sampling .
 *
 * One sample per RUN, keyed by the unique `liveChannelRunId`:
 * - the SUCCESS writer (provision finalize, and ONLY there — the restart
 *   path reuses a live encoding and measures nothing) UPSERTS, so it wins
 *   over any provisional FAILED row a reconciler wrote while the run was
 *   still fighting through the queue (the OneFootball tail: stuck 20 min,
 *   then RUNNING — the final truth is RUNNING with a 20-min queueSeconds);
 * - the FAILURE writers CREATE-IF-ABSENT, never overwriting anything.
 *
 * Every write here is best-effort by design: a statistics row must never
 * break a RUNNING transition or a sweep tick. Failures are logged, not
 * thrown — the reconciler re-covers anything a lost write missed.
 */

/** queue = the AWAIT pair (Bitmovin's allocation time, isolated from our
 * ~29 resource-creation calls); total = end-to-end from THIS ATTEMPT's start.
 *
 * `entries[0].startedAt` alone is a cross-attempt clock —
 * a resumed provision keeps its DONE entries' original timestamps (the retry
 * path reseeds FAILED→PENDING without touching stamps), so a channel retried
 * the next morning would record totalSeconds ≈ 20 h. The caller passes the
 * attempt's own start; the max keeps the first attempt exact (the handler
 * enters milliseconds before step 1 stamps). */
export function startupSecondsFromLog(
	entries: readonly StepLogEntry[],
	attemptStartedAt?: string,
): {
	queueSeconds: number | null;
	totalSeconds: number | null;
} {
	const awaitEntry = entries.find((e) => e.kind === "AWAIT_LIVE_RUNNING");
	const first = entries[0];
	const queue =
		awaitEntry?.startedAt && awaitEntry.finishedAt
			? Math.round(
					(Date.parse(awaitEntry.finishedAt) -
						Date.parse(awaitEntry.startedAt)) /
						1000,
				)
			: null;
	const startMs =
		first?.startedAt !== undefined && first?.startedAt !== null
			? Math.max(
					Date.parse(first.startedAt),
					attemptStartedAt
						? Date.parse(attemptStartedAt)
						: Number.NEGATIVE_INFINITY,
				)
			: null;
	const total =
		awaitEntry?.finishedAt && startMs !== null
			? Math.round((Date.parse(awaitEntry.finishedAt) - startMs) / 1000)
			: null;
	return {
		queueSeconds: queue !== null && queue >= 0 ? queue : null,
		totalSeconds: total !== null && total >= 0 ? total : null,
	};
}

async function sampleContext(
	prisma: AppPrismaClient,
	liveChannelId: string,
	runId?: string,
) {
	const row = await prisma.liveChannel.findUnique({
		where: { id: liveChannelId },
		select: { plan: true, bitmovinAccountId: true, purpose: true },
	});
	// The caller that KNOWS its run (the reconciler) names it; the in-job
	// writers read the latest, which their claim discipline makes current —
	// a re-air cannot mint a newer run while the channel is claimed.
	const run = runId
		? { id: runId }
		: await prisma.liveChannelRun.findFirst({
				where: { liveChannelId },
				orderBy: { seq: "desc" },
				select: { id: true },
			});
	if (!row || !run) {
		return null;
	}
	const plan = liveChannelPlanSchema.safeParse(row.plan);
	if (!plan.success) {
		return null;
	}
	const region = resolveStartupRegion(plan.data);
	return {
		runId: run.id,
		region,
		bitmovinAccountId: row.bitmovinAccountId,
		encoderVersion: plan.data.bitmovin.encoderVersion,
		// #160 PR4: a probe channel's samples are a separate population by
		// design — a probe's 1-rendition plan must never launder a real
		// channel's tail (the profiles route keeps the buckets apart).
		source: row.purpose === "PROBE" ? ("PROBE" as const) : ("CHANNEL" as const),
	};
}

/** The provision-finalize writer — the ONLY success sampler (never restart).
 * The caller threads the run id it already holds and
 * this attempt's start time (#3). */
export async function recordRunningStartupSample(
	prisma: AppPrismaClient,
	liveChannelId: string,
	entries: readonly StepLogEntry[],
	opts: { runId?: string; attemptStartedAt?: string } = {},
): Promise<void> {
	try {
		const ctx = await sampleContext(prisma, liveChannelId, opts.runId);
		if (!ctx) {
			return;
		}
		const { queueSeconds, totalSeconds } = startupSecondsFromLog(
			entries,
			opts.attemptStartedAt,
		);
		await prisma.startupSample.upsert({
			where: { liveChannelRunId: ctx.runId },
			create: {
				cloudRegion: ctx.region.region,
				infrastructureId: ctx.region.infrastructureId,
				bitmovinAccountId: ctx.bitmovinAccountId,
				source: ctx.source,
				outcome: "RUNNING",
				queueSeconds,
				totalSeconds,
				encoderVersion: ctx.encoderVersion,
				liveChannelRunId: ctx.runId,
			},
			update: {
				outcome: "RUNNING",
				failedPhase: null,
				queueSeconds,
				totalSeconds,
			},
		});
		await prisma.liveChannelRun.update({
			where: { id: ctx.runId },
			data: { queueSeconds },
		});
	} catch (err) {
		console.error(
			`startup sample (RUNNING) failed for ${liveChannelId}:`,
			err instanceof Error ? err.message : err,
		);
	}
}

/** Provision-failure writer — create-if-absent (a lost write is re-covered
 * by the reconciler; an existing row is never overwritten). Returns whether
 * a row was actually created, so the reconciler does not count skipped rows
 * as work. */
export async function recordFailedStartupSample(
	prisma: AppPrismaClient,
	liveChannelId: string,
	failedPhase: string,
	runId?: string,
): Promise<boolean> {
	try {
		const ctx = await sampleContext(prisma, liveChannelId, runId);
		if (!ctx) {
			return false;
		}
		const existing = await prisma.startupSample.findUnique({
			where: { liveChannelRunId: ctx.runId },
			select: { id: true },
		});
		if (existing) {
			return false;
		}
		await prisma.startupSample.create({
			data: {
				cloudRegion: ctx.region.region,
				infrastructureId: ctx.region.infrastructureId,
				bitmovinAccountId: ctx.bitmovinAccountId,
				source: ctx.source,
				outcome: "FAILED",
				failedPhase,
				encoderVersion: ctx.encoderVersion,
				liveChannelRunId: ctx.runId,
			},
		});
		return true;
	} catch (err) {
		console.error(
			`startup sample (FAILED) failed for ${liveChannelId}:`,
			err instanceof Error ? err.message : err,
		);
		return false;
	}
}

/**
 * The sweep-side reconciler (review-160 M10): the in-job FAILED write dies
 * with the job it rides — a stalled provision in the worst region records
 * NOTHING in-job, and the worst region reads 0% failures. This sweeps runs
 * stuck in PROVISIONING beyond the deadline and records a provisional
 * FAILED sample ("stuck-provisioning"); if the run later reaches RUNNING,
 * the success upsert overwrites it with the real number — which is exactly
 * the tail measurement the feature exists for.
 */
export async function reconcileStartupSamples(
	prisma: AppPrismaClient,
	now: Date,
	deadlineMinutes = 30,
): Promise<number> {
	const cutoff = new Date(now.getTime() - deadlineMinutes * 60 * 1000);
	const stuck = await prisma.liveChannelRun.findMany({
		where: { status: "PROVISIONING", createdAt: { lt: cutoff } },
		select: { id: true, liveChannelId: true },
		// NEWEST first, deliberately: nothing transitions
		// a stuck PROVISIONING run out of this scan's population, so already-
		// sampled rows accumulate forever. Once they exceed the take, oldest-
		// first would let that permanent backlog starve every NEW stuck run;
		// newest-first samples new arrivals immediately and only starves rows
		// older than the newest 100 — which are already sampled in steady
		// state (the bounded gap is legacy rows on first deploy).
		orderBy: { createdAt: "desc" },
		take: 100,
	});
	let recorded = 0;
	for (const run of stuck) {
		const existing = await prisma.startupSample.findUnique({
			where: { liveChannelRunId: run.id },
			select: { id: true },
		});
		if (existing) {
			continue;
		}
		// Name the STUCK run explicitly — the latest-run read would attach
		// the sample to a newer re-air when the stuck one is not the latest.
		// (In practice the partial unique index LiveChannelRun_one_live_per_
		// channel makes a stuck run ALSO the latest — one non-terminal run
		// per channel — but naming it removes the reliance on an invariant
		// held two modules away.)
		const created = await recordFailedStartupSample(
			prisma,
			run.liveChannelId,
			"stuck-provisioning",
			run.id,
		);
		if (created) {
			recorded += 1;
		}
	}
	return recorded;
}
