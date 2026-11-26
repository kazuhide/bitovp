import {
	type LiveEffectIntent,
	liveChannelJobSchema,
	publicStorageDiagnostic,
	redactSecrets,
	scheduledStopJobId,
	scheduledStopScheduleId,
} from "@bitovp/core";
import {
	type AppPrismaClient,
	competingScheduledStop,
	isLiveStopAdmissionFence,
	settleExhaustedStopSchedules,
} from "@bitovp/db";
import { feederLeaseIsFresh } from "../feeder/ownership";
import { HEARTBEAT_SWEEP_JOB } from "../handlers";
import type { EmitProductEvent } from "../notify/emitter";
import {
	recordScheduleOutcome,
	recordScheduleOutcomeBestEffort,
	type ScheduleOutcome,
	type ScheduleOutcomeTarget,
	scheduledStartScheduleId,
} from "../scheduler/schedule-outcome";
import { recordScheduledStopHandoff } from "../scheduler/stop-handoff";
import {
	recordRetainedScheduledStart,
	resolveProvisionAdmission,
} from "./provision-admission";
import { PROVISION_LEASE_MS } from "./provision-lease";
import { recordExpiredProvisionFailure } from "./reconcile-stranded-runs";

/**
 *  — what a liveChannel job that died OUTSIDE its processor means
 * for the schedule row that fired it.
 *
 * WHY THIS IS A MODULE AND NOT FOUR MORE `if`s IN `index.ts`.
 *
 * The `worker.on("failed", …)` body is a closure inside a `map` over the queue
 * keys in `apps/worker/src/index.ts`, and nothing imports that file: it is the
 * process entry point, so importing it starts workers, opens Redis and reads
 * the environment. Review of the first cut proved the consequence rather than
 * asserting it — flipping the insert-content branch's verdict from UNKNOWN to
 * FAILED left the ENTIRE worker suite green. Every branch below was therefore
 * unreachable by any test, which is how the provision/stop branch came to flip
 * the channel to ERROR while writing nothing at all to the schedule row: a
 * scheduled STOP whose job died sat FIRED/PENDING forever, rendering "Fired —
 * outcome not confirmed yet" beside a channel that was a confirmed ERROR, and
 * the dangling row was then resolved later by an unrelated stop.
 *
 * So the DECISION is a pure function over the job, and `index.ts` keeps one
 * call per handler.
 *
 * WHY EVERY BRANCH IS `UNKNOWN`.
 *
 * A job dying outside its processor is evidence about the JOB, never about
 * the world the job was acting on. The provider may have accepted the slate
 * (the whole slate idempotency guard exists because a POST can land and its
 * response be lost); the channel may have reached RUNNING a moment before the
 * lock was lost; and per the 2026-08-29 audit's CRITICAL-2 a dead feeder-start
 * job can leave an ORPHANED ffmpeg still pushing — a feed that is live and
 * billing. `FAILED` on any of those is a claim we cannot make. `UNKNOWN` is
 * the true one: it fired, and nobody is coming back to look. What will later
 * tell the truth about the orphaned process is the reclaim work tracked
 * separately , not this handler.
 *
 * The channel-status side of the same handler is deliberately NOT here: a dead
 * provision/stop job DOES prove the channel is wedged mid-transition, so
 * flipping it to ERROR is a claim about the row this handler owns. Only the
 * schedule row's DELIVERY is unknowable from here.
 */

/** The job shape this reads — BullMQ's `Job`, narrowed to what matters. */
export type DeadLiveJob =
	| {
			id?: string;
			name?: string;
			data?: unknown;
			attemptsMade?: number;
			finishedOn?: number;
			timestamp?: number;
			opts?: { attempts?: number };
	  }
	| undefined;

function boundStopIntent(job: DeadLiveJob) {
	const parsed = liveChannelJobSchema.safeParse(job?.data);
	if (
		!parsed.success ||
		parsed.data.action !== "stop" ||
		parsed.data.effect?.action !== "STOP"
	) {
		return null;
	}
	const { effect } = parsed.data;
	if (
		effect.stopDeliveryToken &&
		(!effect.scheduleId ||
			job?.id !==
				scheduledStopJobId(effect.scheduleId, effect.stopDeliveryToken))
	)
		return null;
	return {
		liveChannelId: parsed.data.liveChannelId,
		...parsed.data.effect,
	};
}

/** BullMQ emits `failed` after incrementing attemptsMade on every delivery. */
export function isRunBoundStopJob(job: DeadLiveJob): boolean {
	return boundStopIntent(job) !== null;
}

export function isFinalStopFailure(job: DeadLiveJob): boolean {
	return boundStopIntent(job) !== null && isTerminalDelivery(job);
}

function isTerminalDelivery(job: DeadLiveJob): boolean {
	// BullMQ stamps finishedOn before emitting `failed` for every terminal
	// failure, including stalled-limit, UnrecoverableError, discard and a
	// backoff strategy that refuses another delivery. Those paths may stop
	// before attemptsMade reaches opts.attempts.
	if (typeof job?.finishedOn === "number" && Number.isFinite(job.finishedOn)) {
		return true;
	}
	const configured = job?.opts?.attempts;
	const attempts =
		typeof configured === "number" && Number.isFinite(configured)
			? Math.max(1, Math.floor(configured))
			: 1;
	return (job?.attemptsMade ?? 0) >= attempts;
}

export async function recordFinalProvisionFailure(
	prisma: AppPrismaClient,
	job: DeadLiveJob,
	message: string,
	at = new Date(),
): Promise<boolean> {
	if (!job || !isTerminalDelivery(job)) return false;
	const parsed = liveChannelJobSchema.safeParse(job.data);
	if (
		!parsed.success ||
		parsed.data.action !== "provision" ||
		parsed.data.params ||
		parsed.data.effect
	)
		return false;
	const data = parsed.data;
	const admission = await resolveProvisionAdmission(
		prisma,
		data.liveChannelId,
		data,
		job.id,
		job.timestamp,
	);
	if (!admission) return false;
	const scheduleId = scheduledStartScheduleId(
		job.id,
		data.provisionFenceVersion,
	);
	if (scheduleId && job.id && "runId" in admission) {
		// Save the exact terminal evidence before attempting to retire the
		// channel. A failed retirement must not enable replay after eviction.
		const recorded = await recordRetainedScheduledStart(
			prisma,
			{
				id: scheduleId,
				liveChannelId: data.liveChannelId,
				liveChannelRunId: admission.runId,
				startAdmissionFenceVersion: admission.generation,
			},
			{ id: job.id, state: "failed" },
			at,
		);
		if (!recorded) return false;
	}
	return recordExpiredProvisionFailure(
		prisma,
		data.liveChannelId,
		redactSecrets(message),
		new Date(at.getTime() - PROVISION_LEASE_MS),
		at,
		admission,
		scheduleId,
	);
}

/** RESTART may only retire the exact PROVISIONING admission it stranded. */
export async function recordFinalRestartFailure(
	prisma: AppPrismaClient,
	job: DeadLiveJob,
	message: string,
	at = new Date(),
	emitEvent?: EmitProductEvent,
): Promise<boolean> {
	const parsed = liveChannelJobSchema.safeParse(job?.data);
	if (
		!isTerminalDelivery(job) ||
		!parsed.success ||
		parsed.data.action !== "restart" ||
		parsed.data.effect?.action !== "RESTART"
	)
		return false;
	return retireRestartAdmission(
		prisma,
		parsed.data.liveChannelId,
		parsed.data.effect,
		"FINAL_FAILURE",
		message,
		at,
		emitEvent,
	);
}

/** A queue callback can run before its worker lease expires. Expiry fences
 * provider work; retire only the same still-unowned provisioning projection. */
export function createExpiredRestartReconciler(
	prisma: AppPrismaClient,
	emitEvent?: EmitProductEvent,
) {
	let after: string | undefined;
	return async (at = new Date()) => {
		const claims = await prisma.liveEffectClaim.findMany({
			where: {
				action: "RESTART",
				state: { in: ["DISPATCHING", "AMBIGUOUS"] },
				expiresAt: { lte: at },
				liveChannel: { status: "PROVISIONING", provisionClaimedAt: null },
				...(after ? { id: { gt: after } } : {}),
			},
			orderBy: { id: "asc" },
			take: 4,
		});
		after = claims.length === 4 ? claims.at(-1)?.id : undefined;
		let retired = 0;
		for (const claim of claims)
			if (
				await retireRestartAdmission(
					prisma,
					claim.liveChannelId,
					{
						action: "RESTART",
						liveChannelRunId: claim.liveChannelRunId,
						providerEncodingId: claim.providerEncodingId,
						idempotencyKey: claim.idempotencyKey,
						admissionFenceVersion: claim.generation,
					},
					"FINAL_FAILURE",
					"Restart worker expired without a confirmed provider result. Check the encoder or use Stop.",
					at,
					emitEvent,
					claim.id,
				)
			)
				retired++;
		return retired;
	};
}

export async function retireRestartAdmission(
	prisma: AppPrismaClient,
	liveChannelId: string,
	effect: LiveEffectIntent,
	cause: "FINAL_FAILURE" | "INACTIVE_ORGANIZATION",
	message: string,
	at: Date,
	emitEvent?: EmitProductEvent,
	expiredClaimId?: string,
): Promise<boolean> {
	if (effect.action !== "RESTART") return false;
	const error = redactSecrets(message);
	const projected = await prisma.$transaction(async (tx) => {
		// Lock in the same order as STOP admission and re-air. A run can change
		// while the failed callback is queued, even if the channel ID survives.
		const [channel] = await tx.$queryRaw<
			{ name: string }[]
		>`SELECT name FROM "LiveChannel" WHERE id = ${liveChannelId}::uuid FOR UPDATE`;
		if (!channel) return false;
		const latest = await tx.liveChannelRun.findFirst({
			where: { liveChannelId },
			orderBy: { seq: "desc" },
			select: { id: true, bitmovinEncodingId: true },
		});
		if (
			latest?.id !== effect.liveChannelRunId ||
			(latest.bitmovinEncodingId !== null &&
				latest.bitmovinEncodingId !== effect.providerEncodingId)
		)
			return false;
		const claim = await tx.liveEffectClaim.findUnique({
			where: { idempotencyKey: effect.idempotencyKey },
		});
		if (
			expiredClaimId &&
			(claim?.id !== expiredClaimId ||
				claim.generation !== effect.admissionFenceVersion ||
				!["DISPATCHING", "AMBIGUOUS"].includes(claim.state) ||
				claim.expiresAt > at)
		)
			return false;
		if (claim) {
			if (cause === "INACTIVE_ORGANIZATION") return false;
			const canRetire =
				claim.state === "FAILED" ||
				claim.state === "AMBIGUOUS" ||
				(claim.state === "DISPATCHING" && claim.expiresAt <= at);
			if (
				!canRetire ||
				claim.action !== "RESTART" ||
				claim.liveChannelId !== liveChannelId ||
				claim.liveChannelRunId !== latest.id ||
				claim.providerEncodingId !== effect.providerEncodingId
			)
				return false;
		}
		const projected = await tx.liveChannel.updateMany({
			where: {
				id: liveChannelId,
				status: "PROVISIONING",
				// RESTART owns the route's null lease. A non-null token belongs to a
				// provision worker or to the separate exact-token expiry sweep.
				provisionClaimedAt: null,
				bitmovinEncodingId: effect.providerEncodingId,
				liveEffectFenceVersion:
					claim?.generation ?? effect.admissionFenceVersion,
			},
			data: { status: "ERROR", error },
		});
		if (projected.count !== 1) return false;
		if (claim?.state === "DISPATCHING") {
			const stopped = await tx.liveEffectClaim.updateMany({
				where: {
					id: claim.id,
					token: claim.token,
					state: "DISPATCHING",
					expiresAt: { lte: at },
				},
				data: { state: "AMBIGUOUS", failure: error },
			});
			if (stopped.count !== 1)
				throw new Error(
					"RESTART ownership changed while retiring its expired worker",
				);
		}
		// RUNNING describes a possibly billing encoder; keep that historical
		// state unless this run really remained in its startup transition.
		const retired = await tx.liveChannelRun.updateMany({
			where: { id: latest.id, status: { in: ["CREATED", "PROVISIONING"] } },
			data: { status: "ERROR", error },
		});
		if (retired.count)
			await tx.liveChannelRun.updateMany({
				where: { id: latest.id, endedAt: null },
				data: { endedAt: at },
			});
		return channel;
	});
	if (!projected) return false;
	await emitEvent?.(
		{
			kind: "CHANNEL_ERROR",
			liveChannelId,
			name: projected.name,
			error,
			path: `/live/${liveChannelId}`,
		},
		at,
	);
	return true;
}

/**
 * A run-bound STOP that exhausts every delivery before crossing the provider
 * boundary must not disappear behind the route's earlier 202. Project an
 * operator-visible ERROR only while this exact run/provider/fence still owns
 * the channel. A newer run, generation, ACK or unresolved send boundary wins
 * and is never overwritten by this failed-job callback.
 */
export async function recordFinalStopFailure(
	prisma: AppPrismaClient,
	job: DeadLiveJob,
	message: string,
	emitEvent?: EmitProductEvent,
	unboundSchedule = false,
): Promise<boolean> {
	const intent = boundStopIntent(job);
	if (!intent || !isFinalStopFailure(job)) return false;
	const error = redactSecrets(
		`Live stop delivery exhausted before the provider send was confirmed — retry Stop. ${message}`,
	);

	const result = await prisma.$transaction(async (tx) => {
		// A refire reuses the job key. Read its receipt under the same channel
		// lock that guards schedule admission and effect generation changes.
		const scheduleId = intent.scheduleId;
		if (scheduleId) {
			await tx.$queryRaw`SELECT id FROM "LiveChannel" WHERE id = ${intent.liveChannelId}::uuid FOR UPDATE`;
			await tx.$queryRaw`SELECT id FROM "LiveSchedule" WHERE id = ${scheduleId}::uuid FOR UPDATE`;
		}
		const [channel, currentRun, claim, schedule] = await Promise.all([
			tx.liveChannel.findUnique({
				where: { id: intent.liveChannelId },
				select: {
					name: true,
					status: true,
					liveEffectFenceVersion: true,
					legacyAdmissionFenceVersion: true,
					bitmovinEncodingId: true,
				},
			}),
			tx.liveChannelRun.findFirst({
				where: { liveChannelId: intent.liveChannelId },
				orderBy: { seq: "desc" },
				select: {
					id: true,
					bitmovinEncodingId: true,
					status: true,
					endedAt: true,
				},
			}),
			tx.liveEffectClaim.findUnique({
				where: { idempotencyKey: intent.idempotencyKey },
				select: {
					state: true,
					scheduleId: true,
					generation: true,
					attempt: true,
					liveChannelId: true,
					liveChannelRunId: true,
					providerEncodingId: true,
					action: true,
				},
			}),
			scheduleId
				? tx.liveSchedule.findUnique({
						where: { id: scheduleId },
						select: {
							liveChannelId: true,
							liveChannelRunId: true,
							action: true,
							stopAdmissionFenceVersion: true,
							stopProviderEncodingId: true,
							stopDeliveryToken: true,
						},
					})
				: null,
		]);
		const stamped =
			schedule?.stopAdmissionFenceVersion != null ||
			schedule?.stopProviderEncodingId != null;
		if (
			!channel ||
			currentRun?.id !== intent.liveChannelRunId ||
			channel.bitmovinEncodingId !== intent.providerEncodingId ||
			!["RUNNING", "STOPPING", "ERROR"].includes(currentRun.status) ||
			(currentRun.bitmovinEncodingId ?? channel.bitmovinEncodingId) !==
				intent.providerEncodingId ||
			(schedule &&
				(schedule.liveChannelId !== intent.liveChannelId ||
					schedule.liveChannelRunId !== currentRun.id ||
					schedule.action !== "STOP" ||
					schedule.stopDeliveryToken !== (intent.stopDeliveryToken ?? null) ||
					(stamped &&
						(schedule.stopAdmissionFenceVersion !==
							intent.admissionFenceVersion ||
							schedule.stopProviderEncodingId !== intent.providerEncodingId))))
		) {
			return { projected: false as const };
		}

		let ownedFence = intent.admissionFenceVersion;
		if (claim) {
			const oldAdmission =
				unboundSchedule &&
				!!intent.scheduleId &&
				channel.legacyAdmissionFenceVersion === intent.admissionFenceVersion &&
				claim.generation < intent.admissionFenceVersion;
			if (
				claim.state !== "FAILED" ||
				(claim.scheduleId ?? null) !== (intent.scheduleId ?? null) ||
				claim.action !== "STOP" ||
				claim.liveChannelId !== intent.liveChannelId ||
				claim.liveChannelRunId !== intent.liveChannelRunId ||
				(!oldAdmission &&
					claim.providerEncodingId !== intent.providerEncodingId) ||
				// The legacy queue has no admission stamp. Each reattempt advances
				// both counters from the original generation on a scheduled key.
				(scheduleId &&
					!unboundSchedule &&
					!stamped &&
					claim.generation - claim.attempt !== intent.admissionFenceVersion)
			) {
				return { projected: false as const };
			}
			if (!oldAdmission) ownedFence = claim.generation;
		}
		if (channel.liveEffectFenceVersion !== ownedFence) {
			return { projected: false as const };
		}
		const at = new Date();
		const admissionFence = channel.legacyAdmissionFenceVersion;
		const settleSiblings = async () => {
			if (
				isLiveStopAdmissionFence(
					admissionFence,
					ownedFence,
					claim?.generation === ownedFence ? claim : undefined,
				)
			) {
				await settleExhaustedStopSchedules(tx, {
					liveChannelId: intent.liveChannelId,
					liveChannelRunId: currentRun.id,
					providerEncodingId: intent.providerEncodingId,
					admissionFence,
					at,
				});
			}
		};
		if (
			channel.status === "ERROR" &&
			currentRun.status === "ERROR" &&
			claim?.generation === ownedFence
		) {
			const [held] = await tx.$queryRaw<{ id: string }[]>`
				SELECT id FROM "LiveChannel"
				WHERE id = ${intent.liveChannelId}::uuid AND status = 'ERROR'
					AND "liveEffectFenceVersion" = ${ownedFence}
					AND "bitmovinEncodingId" = ${intent.providerEncodingId}
				FOR UPDATE`;
			if (held) await settleSiblings();
			return { projected: false as const };
		}

		const projected = await tx.liveChannel.updateMany({
			where: {
				id: intent.liveChannelId,
				status: { in: ["RUNNING", "STOPPING"] },
				bitmovinEncodingId: intent.providerEncodingId,
				liveEffectFenceVersion: ownedFence,
				...(unboundSchedule && intent.scheduleId
					? {
							effectClaims: {
								none: {
									action: "STOP",
									liveChannelRunId: currentRun.id,
									generation: ownedFence,
									state: { in: ["CLAIMED", "DISPATCHING", "AMBIGUOUS"] },
								},
							},
							schedules: {
								some: {
									id: intent.scheduleId,
									liveChannelRunId: currentRun.id,
									action: "STOP",
									status: "FIRED",
									outcome: { in: ["PENDING", "UNKNOWN"] },
								},
								none: competingScheduledStop(
									intent.scheduleId,
									currentRun.id,
									ownedFence,
								),
							},
						}
					: {}),
			},
			data: {
				status: "ERROR",
				error,
			},
		});
		if (projected.count !== 1) return { projected: false as const };
		const run = await tx.liveChannelRun.updateMany({
			where: {
				id: currentRun.id,
				liveChannelId: intent.liveChannelId,
				bitmovinEncodingId: currentRun.bitmovinEncodingId,
				status: currentRun.status,
				endedAt: currentRun.endedAt,
			},
			data: {
				status: "ERROR",
				error,
				endedAt: currentRun.endedAt ?? new Date(),
			},
		});
		if (run.count !== 1)
			throw new Error(
				"Live STOP failure lost its exact airing during projection",
			);
		if (
			intent.scheduleId &&
			job?.id ===
				scheduledStopJobId(intent.scheduleId, intent.stopDeliveryToken) &&
			intent.idempotencyKey === `schedule:${intent.scheduleId}:stop`
		) {
			await recordScheduleOutcome(
				tx,
				{
					scheduledStop: {
						id: intent.scheduleId,
						liveChannelId: intent.liveChannelId,
						liveChannelRunId: currentRun.id,
					},
				},
				"UNKNOWN",
				error,
				at,
				"JOB_TERMINAL_UNKNOWN",
			);
		}
		await settleSiblings();
		return { projected: true as const, channelName: channel.name };
	});
	if (!result.projected) return false;
	await emitEvent?.({
		kind: "CHANNEL_ERROR",
		liveChannelId: intent.liveChannelId,
		name: result.channelName,
		error,
		path: `/live/${intent.liveChannelId}`,
	});
	return true;
}

export type DeadJobScheduleWrite = {
	target: ScheduleOutcomeTarget;
	outcome: Exclude<ScheduleOutcome, "PENDING">;
	/**
	 * Operator-facing, and RAW here so the decision stays exactly testable —
	 * `recordDeadJobScheduleOutcomes` redacts on the way to the column, which
	 * is the one place that can neither be skipped nor duplicated.
	 */
	note: string;
};

type LiveJobData = {
	liveChannelId?: string;
	action?: string;
	plannedLiveChannelRunId?: string;
	provisionFenceVersion?: number;
	params?: { scheduleId?: string };
	effect?: { action?: string; scheduleId?: string; liveChannelRunId?: string };
};

/**
 * Which schedule rows a dead liveChannel job closes, and how.
 *
 * Returns an array so a future action can close more than one row, and an
 * EMPTY array for every job that closes none — which is the common case:
 * the heartbeat sweep, parameter actions (reset-timeshift / scte35 /
 * heartbeat), live-to-VOD, and any manual action on a channel that has no
 * fired row (the reverse lookups simply match nothing).
 */
export function deadJobScheduleWrites(
	job: DeadLiveJob,
	message: string,
): DeadJobScheduleWrite[] {
	// Durable manual STOP has its own run/provider/fence-bound failure
	// projection. It never owns a LiveSchedule row; reverse-looking up the
	// channel here could corrupt an unrelated FIRED scheduled STOP as UNKNOWN.
	const intent = boundStopIntent(job);
	if (intent && !intent.scheduleId) {
		return [];
	}
	// The repeatable heartbeat sweep rides the same queue with no channel id
	// and no action; it owns no schedule row and must never close one.
	if (job?.name === HEARTBEAT_SWEEP_JOB) {
		return [];
	}
	const data = (job?.data ?? {}) as LiveJobData;
	// `liveChannelJobSchema.action` defaults to "provision" (packages/core
	// queues.ts), and the create path enqueues without one — so an absent
	// action IS a provision here, exactly as the channel-status arm reads it.
	const action = data.action ?? "provision";
	const scheduleId = data.params?.scheduleId;

	switch (action) {
		case "provision": {
			const id = scheduledStartScheduleId(job?.id, data.provisionFenceVersion);
			if (
				!data.liveChannelId ||
				!id ||
				!isTerminalDelivery(job) ||
				(data.provisionFenceVersion !== undefined &&
					!data.plannedLiveChannelRunId)
			)
				return [];
			return [
				{
					target: {
						scheduledStart: {
							id,
							liveChannelId: data.liveChannelId,
							dispatchJobId: job?.id,
							...(data.plannedLiveChannelRunId
								? { liveChannelRunId: data.plannedLiveChannelRunId }
								: {}),
							// A reused queue key gives a legacy job no evidence about a
							// later generation of the same scheduled START.
							startAdmissionFenceVersion: data.provisionFenceVersion ?? null,
						},
					},
					outcome: "UNKNOWN",
					note: `the scheduled start's job died before it could report a result: ${message}`,
				},
			];
		}
		case "stop": {
			if (job?.attemptsMade !== undefined && !isTerminalDelivery(job))
				return [];
			// A bare legacy job's queue key cannot identify its admission.
			const id = intent?.scheduleId;
			if (!data.liveChannelId || !id) return [];
			return [
				{
					target: {
						scheduledStop: {
							id,
							liveChannelId: data.liveChannelId,
							...(intent && {
								admission: {
									providerEncodingId: intent.providerEncodingId,
									admissionFenceVersion: intent.admissionFenceVersion,
									...(intent.stopDeliveryToken && {
										stopDeliveryToken: intent.stopDeliveryToken,
									}),
								},
							}),
							...((intent?.liveChannelRunId ?? data.plannedLiveChannelRunId)
								? {
										liveChannelRunId:
											intent?.liveChannelRunId ?? data.plannedLiveChannelRunId,
									}
								: {}),
						},
					},
					outcome: "UNKNOWN",
					note: `the scheduled stop's job died before it could report a result: ${message}`,
				},
			];
		}
		case "insert-content": {
			if (!scheduleId) {
				return [];
			}
			return [
				{
					target: { scheduleId },
					outcome: "UNKNOWN",
					note: `the slate job died before the provider's answer could be read: ${message}`,
				},
			];
		}
		case "feeder-start":
		case "feeder-switch":
		// : a dead COMMIT is the same shape — the request may or may
		// not have been written before the job died, and the held session's
		// own transitions will say DELIVERED or FAILED over this UNKNOWN.
		case "feeder-commit": {
			if (!scheduleId) {
				return [];
			}
			return [
				{
					target: { scheduleId },
					outcome: "UNKNOWN",
					// CRITICAL-2 is why this is not FAILED: the ffmpeg the dead job
					// spawned can outlive it and keep pushing.
					note: `the scheduled feeder job died; its push may have been orphaned rather than stopped: ${message}`,
				},
			];
		}
		// : a dead PRE-STAGE closes no row — the row has not fired.
		// Its stage claim is released by `releaseDeadStageClaim` so the next
		// tick can stage again while the lead lasts.
		case "feeder-stage":
			return [];
		// restart is never scheduled (the sweep enqueues provision/stop/
		// insert-content/feeder-*/register-slate-content and nothing else), and
		// the remaining actions own no schedule row.
		default:
			return [];
	}
}

/**
 * Apply the decision above through the shared precedence writer. Best-effort
 * per write, like every other outcome writer: this runs in an event handler
 * that must not throw, and the row it could not write stays amber, which is
 * the honest reading of "we do not know".
 */
async function recordExhaustedScheduledStop(
	prisma: AppPrismaClient,
	job: DeadLiveJob,
	at: Date,
) {
	const parsed = liveChannelJobSchema.safeParse(job?.data);
	const id = scheduledStopScheduleId(job?.id);
	if (
		!id ||
		!parsed.success ||
		parsed.data.action !== "stop" ||
		!parsed.data.effect ||
		!isTerminalDelivery(job)
	)
		return;
	const { liveChannelId, plannedLiveChannelRunId, effect } = parsed.data;
	const expectedJobId = scheduledStopJobId(id, effect.stopDeliveryToken);
	if (
		effect.action !== "STOP" ||
		job?.id !== expectedJobId ||
		effect.scheduleId !== id ||
		effect.idempotencyKey !== `schedule:${id}:stop` ||
		(plannedLiveChannelRunId &&
			effect.liveChannelRunId !== plannedLiveChannelRunId)
	)
		return;
	const receipt = await prisma.liveSchedule.findFirst({
		where: {
			id,
			liveChannelId,
			action: "STOP",
			status: "FIRED",
			...(effect?.liveChannelRunId || plannedLiveChannelRunId
				? {
						liveChannelRunId:
							effect?.liveChannelRunId ?? plannedLiveChannelRunId,
					}
				: {}),
			OR: [{ dispatchJobId: null }, { dispatchJobId: expectedJobId }],
		},
		select: { liveChannelRunId: true },
	});
	if (!receipt?.liveChannelRunId) return;
	const liveChannelRunId = receipt.liveChannelRunId;
	// A native failed event for the exact retained queue ID is a queue receipt,
	// even when the consumer died before it could create a claim.
	await recordScheduledStopHandoff(
		prisma,
		{ id, liveChannelId, liveChannelRunId },
		at,
		effect,
	);
}

export async function recordDeadJobScheduleOutcomes(
	prisma: AppPrismaClient,
	job: DeadLiveJob,
	message: string,
	at: Date,
): Promise<void> {
	await recordExhaustedScheduledStop(prisma, job, at);
	for (const write of deadJobScheduleWrites(
		job,
		publicStorageDiagnostic(message),
	)) {
		await recordScheduleOutcomeBestEffort(
			prisma,
			write.target,
			write.outcome,
			// The note embeds `err.message`, which is arbitrary provider or
			// driver text — redacted here like every other persisted error
			// string, once, at the only site that writes it.
			redactSecrets(write.note),
			at,
			write.outcome === "FAILED" ? "EFFECT_FAILED" : "JOB_TERMINAL_UNKNOWN",
		);
	}
}

/**
 *  — a dead PRE-STAGE job releases its claim. The stage claim
 * (`stagedAt` with no `stageDispatchedAt`) is the outbox's half; a job that
 * WAS handed off and then died (the channel had no encoder IP for the whole
 * retry ladder, the database blinked) leaves a stamped claim and no session,
 * and nothing would ever stage the row again — it would reach its fire time
 * and be refused as "not staged" for a reason that had already passed.
 * Releasing both stamps puts the row back in the next tick's stage scan.
 * Guarded on `feederSessionId: null`: a stage that DID create its session
 * before dying has done its work, and releasing it would create a second one
 * .
 */
export async function releaseDeadStageClaim(
	prisma: AppPrismaClient,
	job: DeadLiveJob,
): Promise<number> {
	const data = (job?.data ?? {}) as LiveJobData;
	if (data.action !== "feeder-stage" || !data.params?.scheduleId) {
		return 0;
	}
	try {
		const { count } = await prisma.liveSchedule.updateMany({
			where: {
				id: data.params.scheduleId,
				status: "ARMED",
				feederSessionId: null,
			},
			data: { stagedAt: null, stageDispatchedAt: null },
		});
		return count;
	} catch (err) {
		console.error(
			`[worker:liveChannel] failed to release the pre-stage claim of ${data.params.scheduleId}:`,
			err instanceof Error ? err.message : err,
		);
		return 0;
	}
}

/**
 * THE FEEDER QUEUE's dead START job — moved here from `index.ts` for the same
 * reason as everything above, and carrying a second defect of its own
 * (review-351).
 *
 * What it always did: a start job that died OUTSIDE the processor lands the
 * session ERROR and KEEPS the recorded pid, because that pid is the only
 * forensic pointer to the ffmpeg that may still be pushing (audit CRITICAL-2).
 *
 * What it never did: NOTIFY. `markTerminal` in `feeder/processor.ts` emits
 * `FEEDER_ERROR` at the feeder's one in-process terminal-error choke point,
 * and this — the out-of-process death, which is the most common trigger of the
 * orphan-ffmpeg case — emitted nothing. 's instrument could not see
 * the hole either: `notify/emit-sites.test.ts` walks the worker source for
 * emit calls and set-equals what it finds against its own table, and
 * `index.ts` was in neither, so a terminal write with no emit lived in the one
 * file the guard's population excluded. This module IS in that table now.
 */
export type DeadFeederJobDeps = {
	prisma: AppPrismaClient;
	/** Best-effort by contract  — absent in tests that ignore it. */
	emitEvent?: EmitProductEvent;
	now?: () => Date;
};

type DeadFeederJobData = { feederSessionId?: string; action?: string };

export async function recordDeadFeederJob(
	deps: DeadFeederJobDeps,
	job: DeadLiveJob,
	message: string,
): Promise<void> {
	const data = (job?.data ?? {}) as DeadFeederJobData;
	const feederSessionId = data.feederSessionId;
	// Scoped to dead START jobs: a failed STOP must never flip status — the
	// session may genuinely still be pushing, and flipping would lie.
	if (!feederSessionId || (data.action ?? "start") !== "start") {
		return;
	}
	const at = deps.now?.() ?? new Date();
	try {
		const row = await deps.prisma.feederSession.findUnique({
			where: { id: feederSessionId },
			select: {
				pid: true,
				liveChannelId: true,
				status: true,
				playbackMode: true,
				ownerLeaseAt: true,
				ownerGeneration: true,
			},
		});
		if (!row || !["CREATED", "DOWNLOADING", "PUSHING"].includes(row.status))
			return;
		// The exact retained job may be retried by a same-key request.
		// Keep an unclaimed single pass eligible for that admission.
		if (row.playbackMode === "ONCE" && row.status === "CREATED") return;
		/**
		 *  — the STALENESS GUARD, the shape #216 gave the live failed
		 * handler for the identical reason.
		 *
		 * A dead-START-job report is NOT ordered against a takeover, and the
		 * first version of this comment claimed it was (review-365 S-2). What
		 * is true: BullMQ's stalled ladder runs on its own cadence —
		 * `maxStalledCount` 5 (`stall-policy.ts`) × a 30s stalled interval —
		 * which is far longer than the 90s takeover window, and a stalled START
		 * job is moved back to WAIT and RE-RUN before it is ever failed. A
		 * re-run finds the row PUSHING, fails `start`'s CREATED claim and
		 * COMPLETES, so on a multi-worker install this handler often never
		 * fires for a resumed session at all.
		 *
		 * What the guard is for is the case where it DOES fire late: by then
		 * another worker may own the session, and without this check the report
		 * would flip a push that is fine to ERROR, and — the `count > 0` fence
		 * below being satisfied — raise an incident and write the schedule
		 * off.
		 *
		 * A fresh lease is the one thing that means "somebody owns this now".
		 * Null and stale both fall through to the write, which is exactly what
		 * this handler did before the lease existed.
		 */
		if (feederLeaseIsFresh(row?.ownerLeaseAt, at.getTime())) {
			console.warn(
				`[worker:feederManager] dead START job for session ${feederSessionId} ignored — another worker holds a fresh ownership lease on it`,
			);
			return;
		}
		const orphanNote =
			row?.pid != null
				? `a pushing ffmpeg may be orphaned at pid ${row.pid} — check it`
				: "no ffmpeg pid was recorded (the session never reached PUSHING)";
		const error = redactSecrets(
			`Worker lost the session (${message}) — ${orphanNote}`,
		);
		const { count } = await deps.prisma.feederSession.updateMany({
			where: {
				id: feederSessionId,
				status: row.status,
				ownerLeaseAt: row.ownerLeaseAt,
				ownerGeneration: row.ownerGeneration,
			},
			data: {
				status: "ERROR",
				stoppedAt: at,
				error,
			},
		});
		/**
		 * Everything below is fenced on having WON the transition — the same
		 * `if (count === 0) return` the channel arm in `index.ts` learned
		 * (review-336 C3). An unfenced emit here would raise an incident about
		 * a session another worker owns, or a second FEEDER_ERROR for one the
		 * processor already reported; the in-process `markTerminal` emit is
		 * unconditional only because its own write is.
		 */
		if (count === 0) {
			return;
		}
		// Same kind and payload shape as feeder/processor.ts's markTerminal.
		await deps.emitEvent?.({
			kind: "FEEDER_ERROR",
			feederSessionId,
			liveChannelId: row?.liveChannelId ?? "",
			error,
			path: `/live/${row?.liveChannelId ?? ""}`,
		});
		// And the schedule row that armed this session, if any: UNKNOWN, for
		// the CRITICAL-2 reason above — the push may be orphaned rather than
		// stopped, so "it failed to deliver" is not a claim this path can make.
		await recordScheduleOutcomeBestEffort(
			deps.prisma,
			{ feederSessionId },
			"UNKNOWN",
			error,
			at,
			"JOB_TERMINAL_UNKNOWN",
		);
	} catch (err) {
		console.error(
			`[worker:feederManager] failed to close dead session ${feederSessionId}:`,
			err instanceof Error ? err.message : err,
		);
	}
}
