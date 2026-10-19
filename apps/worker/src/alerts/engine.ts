import {
	type AlertMetric,
	evaluateAlertRules,
	type HeartbeatObservation,
	METRIC_CLASS,
} from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import type { EmitProductEvent } from "../notify/emitter";

/**
 * Alert transition engine . The heartbeat sweep calls this per
 * RUNNING channel AFTER its poll attempt — success or failure, because
 * HEARTBEAT_STALE exists precisely for channels whose polls keep failing.
 *
 * Judgment is core's pure evaluateAlertRules; THIS module owns the
 * transitions: insert-open races are settled by the partial unique index
 * (the loser's P2002 means "already open" — the DB, not a read, dedups),
 * resolve is a guarded updateMany, and both edges emit product events.
 * Edge-triggered by construction: state lives in rows, so a worker
 * restart re-notifies nothing.
 */

const MAX_WINDOW_POLLS = 20;
type AlertDb = Pick<
	AppPrismaClient,
	| "alertRule"
	| "alertEvent"
	| "liveChannel"
	| "liveChannelRun"
	| "liveHeartbeat"
>;

export function createAlertEngine(deps: {
	prisma: AppPrismaClient;
	emitEvent?: EmitProductEvent;
	now(): Date;
	sweepIntervalMs: number;
}) {
	return async function evaluateChannel(
		liveChannelId: string,
		channelStatus: string,
		lastTouchedAt?: string,
		/**
		 * The scheduled program window , threaded from the caller's
		 * OWN channel read (review-223 F10) — the heartbeat sweep already holds
		 * the row, so a per-channel-per-tick re-read here bought nothing.
		 * Callers without the row omit it and the engine reads it itself.
		 */
		programWindow?: {
			programStartAt: Date | null;
			programEndAt: Date | null;
		},
		/**
		 * The CURRENT run this evaluation belongs to , threaded on
		 * the same terms as `programWindow` above: the heartbeat sweep loads
		 * this exact row ONE statement earlier for the stale anchor, so the
		 * engine's own read was a second query per channel per tick for a row
		 * the caller already held (review-347).
		 *
		 * Three-valued on purpose. `undefined` = "I did not look, you look" and
		 * takes the self-read fallback; `null` = "I LOOKED and this channel has
		 * no run row" (pre-#108) and must NOT trigger a second query that would
		 * return null again. Collapsing those two would either re-read on every
		 * unscoped channel or silently drop the scope.
		 */
		runScope?: { id: string; createdAt: Date } | null,
		/** The heartbeat poll whose sample this evaluation is allowed to judge. */
		pollToken?: { runId: string; encodingId: string; epoch: number } | null,
	): Promise<{ opened: number; resolved: number }> {
		const evaluate = async (
			prisma: AlertDb,
		): Promise<{ opened: number; resolved: number }> => {
			const allRules = await prisma.alertRule.findMany({
				where: {
					enabled: true,
					OR: [{ liveChannelId: null }, { liveChannelId }],
				},
			});
			//  §3 C3 — evaluation is PARTITIONED by metric ownership:
			// this engine rides the HEARTBEAT sweep and owns only what the
			// heartbeat can witness (METRIC_CLASS subject INGEST); the origin
			// sweep applies the mirror-image filter over DELIVERY. Today core's
			// evaluator ALSO ignores metrics it has no case for (#83's
			// unknown-neither contract), so this filter is the second layer —
			// load-bearing the day anyone teaches the evaluator an origin metric
			// (the flap the design's C3 measured would otherwise return: the
			// wrong sweep resolving the primary signal's alerts every tick).
			const rules = allRules.filter(
				(rule) =>
					METRIC_CLASS[rule.metric as AlertMetric]?.subject === "INGEST",
			);
			if (rules.length === 0) {
				return { opened: 0, resolved: 0 };
			}
			const windowSize = Math.min(
				MAX_WINDOW_POLLS,
				Math.max(...rules.map((rule) => rule.windowPolls), 1),
			);
			const [openEvents, channelWindow, currentRun] = await Promise.all([
				prisma.alertEvent.findMany({
					where: { liveChannelId, resolvedAt: null },
					select: { ruleId: true },
				}),
				programWindow !== undefined
					? Promise.resolve(programWindow)
					: prisma.liveChannel.findUnique({
							where: { id: liveChannelId },
							select: { programStartAt: true, programEndAt: true },
						}),
				// which
				// RUN the window belongs to. Threaded from the caller when it has
				// the row (the sweep does, one statement earlier), self-read when
				// it does not — the same shape as `programWindow`, and the same
				// safety: OMITTING it costs a query, never the scope.
				runScope !== undefined
					? Promise.resolve(runScope)
					: prisma.liveChannelRun.findFirst({
							where: { liveChannelId },
							orderBy: { seq: "desc" },
							select: { id: true, createdAt: true },
						}),
			]);
			// Scope the window to the CURRENT run. Read by liveChannelId alone,
			// a re-air evaluated run N+1 over run N's samples: the previous
			// airing's final rows are still the newest rows in the table on the
			// first ticks of the new one, so INPUT_DISCONNECTED could open on a
			// disconnect that belonged to a run that has already ended (and,
			// symmetrically, an old CONNECTED tail could pad the window and mask
			// the new run's own disconnect).
			//
			// The lower bound is the run's `createdAt`, NOT its `runningSince`:
			// createdAt is immutable per run, so it excludes exactly the previous
			// run and nothing else, whereas runningSince is REWRITTEN in place by
			// a restart (live-processor's restart arm mirrors a fresh epoch onto
			// the same row) — bounding on it would empty the window on the first
			// post-restart tick while HEARTBEAT_STALE's anchor kept pointing at
			// the pre-restart sample, manufacturing an instant stale CRIT out of
			// a healthy restart.
			//
			// The run-id arm is the second, narrower leak: the previous run's
			// in-flight poll can land AFTER the new run row exists, and
			// appendHeartbeatHistory stamps it with the OLD run (it matches the
			// run by the ENCODING the sample was fetched for, review-242 A3), so
			// its timestamp alone would not exclude it. Rows with a NULL run id
			// stay in: the column is nullable through #108's two-step move and
			// null means "no run carried this encoding", not "another run's".
			//
			// No run row at all (pre-#108 channels) ⇒ no scoping, exactly as
			// before: there is no run boundary to honour.
			//
			// ONE row more than the widest window (PROVIDER_WARNING): that rule
			// reads the provider's cumulative `events[]` as a DIFFERENCE between
			// consecutive samples, so the oldest observation any rule can judge
			// needs its predecessor in hand. The other rules slice their own
			// tail and never see the extra row. When FEWER rows come back than
			// asked, the window reaches the run's first sample and that sample's
			// events are new by definition (`windowStartsAtRunStart`).
			const fetchSize = windowSize + 1;
			const heartbeats = await prisma.liveHeartbeat.findMany({
				where: {
					liveChannelId,
					...(currentRun
						? {
								at: { gte: currentRun.createdAt },
								OR: [
									{ liveChannelRunId: currentRun.id },
									{ liveChannelRunId: null },
								],
							}
						: {}),
				},
				orderBy: { at: "desc" },
				take: fetchSize,
				select: { at: true, raw: true },
			});
			const windowStartsAtRunStart = heartbeats.length < fetchSize;
			// The evaluator wants newest LAST.
			const window: HeartbeatObservation[] = heartbeats
				.reverse()
				.map((row) => ({
					at: row.at.toISOString(),
					raw: (row.raw ?? {}) as HeartbeatObservation["raw"],
				}));
			const evaluation = evaluateAlertRules({
				rules,
				window,
				windowStartsAtRunStart,
				openRuleIds: new Set(openEvents.map((event) => event.ruleId)),
				channel: {
					status: channelStatus,
					// review-83b I3: anchors HEARTBEAT_STALE when no sample ever
					// landed (the first poll failed) — same grace as everyone.
					...(lastTouchedAt !== undefined ? { lastTouchedAt } : {}),
					programStartAt: channelWindow?.programStartAt?.toISOString() ?? null,
					programEndAt: channelWindow?.programEndAt?.toISOString() ?? null,
				},
				now: deps.now().toISOString(),
				sweepIntervalMs: deps.sweepIntervalMs,
			});

			let opened = 0;
			for (const breach of evaluation.open) {
				try {
					const event = await prisma.alertEvent.create({
						data: {
							ruleId: breach.ruleId,
							liveChannelId,
							openedAt: deps.now(),
							context: breach.context as Prisma.InputJsonValue,
						},
					});
					opened += 1;
					await deps.emitEvent?.({
						kind: "ALERT_OPENED",
						alertId: event.id,
						liveChannelId,
						rule: breach.metric,
						// #161 §2: provenance rides every alert signal.
						...(METRIC_CLASS[breach.metric as AlertMetric] ?? {}),
						path: `/live/${liveChannelId}`,
					});
				} catch (err) {
					// P2002 on the partial unique index: another sweep opened it in
					// the same instant — already open is the DESIRED state.
					if (
						typeof err === "object" &&
						err !== null &&
						(err as { code?: string }).code === "P2002"
					) {
						continue;
					}
					throw err;
				}
			}

			let resolved = 0;
			for (const ruleId of evaluation.resolve) {
				const rule = rules.find((candidate) => candidate.id === ruleId);
				// Read the open event's id first (the partial unique index means
				// there is at most one), then claim by ID — the emit carries the
				// REAL event id, and a racing resolver loses on count 0.
				const openEvent = await prisma.alertEvent.findFirst({
					where: { ruleId, liveChannelId, resolvedAt: null },
					select: { id: true },
				});
				if (!openEvent) {
					continue;
				}
				const { count } = await prisma.alertEvent.updateMany({
					where: { id: openEvent.id, resolvedAt: null },
					data: { resolvedAt: deps.now() },
				});
				if (count > 0) {
					resolved += count;
					await deps.emitEvent?.({
						kind: "ALERT_RESOLVED",
						alertId: openEvent.id,
						liveChannelId,
						rule: rule?.metric ?? "unknown",
						...(METRIC_CLASS[rule?.metric as AlertMetric] ?? {}),
						path: `/live/${liveChannelId}`,
					});
				}
			}
			return { opened, resolved };
		};
		if (!pollToken) {
			return evaluate(deps.prisma);
		}
		return deps.prisma.$transaction(async (tx) => {
			// Match heartbeat and provider persistence: lock the run before the
			// channel. A deadline can start this evaluation while an aborted poll
			// is still finishing its channel update and rolling its run write back.
			const { count } = await tx.liveChannelRun.updateMany({
				where: {
					id: pollToken.runId,
					liveChannelId,
					bitmovinEncodingId: pollToken.encodingId,
					heartbeatPollEpoch: pollToken.epoch,
				},
				data: { heartbeatPollEpoch: pollToken.epoch },
			});
			if (count !== 1) {
				return { opened: 0, resolved: 0 };
			}
			// Channel transitions claim this row. Holding it through evaluation
			// makes STOP and re-air serialize with the alert transition.
			const channel = await tx.liveChannel.updateMany({
				where: {
					id: liveChannelId,
					status: "RUNNING",
					bitmovinEncodingId: pollToken.encodingId,
				},
				data: { status: "RUNNING" },
			});
			if (channel.count !== 1) return { opened: 0, resolved: 0 };
			const latest = await tx.liveChannelRun.findFirst({
				where: { liveChannelId },
				orderBy: { seq: "desc" },
				select: { id: true },
			});
			if (latest?.id !== pollToken.runId) return { opened: 0, resolved: 0 };
			return evaluate(tx);
		});
	};
}

export type AlertEngine = ReturnType<typeof createAlertEngine>;

/**
 * review-83b C1: the engine above is only ever called for RUNNING channels
 * with ENABLED, in-scope rules — so an open event whose channel stopped,
 * whose rule was disabled (the Settings UI presents Disable as the SAFE
 * alternative to Delete), or whose rule was re-scoped to another channel
 * was stranded OPEN forever: permanent CRIT banner, dashboard error tone,
 * and no escape short of deleting the rule (which cascade-deletes its
 * whole history). This pass resolves every open event the engine can no
 * longer reach. Passing the real status instead would NOT fix it — the
 * reviewer probed INPUT_DISCONNECTED still breaching off the stale window
 * with "STOPPED" passed — the transition has to be explicit.
 */
export function createOrphanResolver(deps: {
	prisma: AppPrismaClient;
	emitEvent?: EmitProductEvent;
	now(): Date;
}) {
	return async function resolveOrphanedAlerts(
		runningChannelIds: ReadonlySet<string>,
	): Promise<{ resolved: number }> {
		const open = await deps.prisma.alertEvent.findMany({
			where: { resolvedAt: null },
			select: {
				id: true,
				liveChannelId: true,
				rule: {
					select: { enabled: true, liveChannelId: true, metric: true },
				},
			},
		});
		let resolved = 0;
		for (const event of open) {
			const orphaned =
				!runningChannelIds.has(event.liveChannelId) ||
				!event.rule.enabled ||
				(event.rule.liveChannelId !== null &&
					event.rule.liveChannelId !== event.liveChannelId);
			if (!orphaned) {
				continue;
			}
			// CAS: a racing engine-resolve or a second sweep loses on count 0.
			const { count } = await deps.prisma.alertEvent.updateMany({
				where: { id: event.id, resolvedAt: null },
				data: { resolvedAt: deps.now() },
			});
			if (count > 0) {
				resolved += count;
				await deps.emitEvent?.({
					kind: "ALERT_RESOLVED",
					alertId: event.id,
					liveChannelId: event.liveChannelId,
					rule: event.rule.metric,
					...(METRIC_CLASS[event.rule.metric as AlertMetric] ?? {}),
					path: `/live/${event.liveChannelId}`,
				});
			}
		}
		return { resolved };
	};
}

export type OrphanResolver = ReturnType<typeof createOrphanResolver>;
