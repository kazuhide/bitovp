import { createHash, randomUUID } from "node:crypto";
import {
	compileLiveRunStepLog,
	deriveProviderLifecycle,
	isLiveRunStatus,
	type LiveEffectAction,
	type LiveEffectIntent,
	liveChannelPlanSchema,
	liveEffectIntentSchema,
	liveResetTimeshiftParamsSchema,
	liveRtmpIngestParamsSchema,
	liveScte35ParamsSchema,
	MslEncoderVersionError,
	masterKeyFromEnv,
	PROVISION_LEASE_RELEASE,
	type ProviderLifecycleView,
	providerEffectRefusal,
	reseedFailedSteps,
	selectRtmpIngestPoints,
	stepLogSchema,
} from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import { DB_NULL } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	type CustomerErrorCode,
	customerErrorDetails,
} from "@/lib/customer-error";
import { getServerContext } from "@/lib/server/context";
import {
	invalidIdResponse,
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { getLiveChannelQueue } from "@/lib/server/queue";

type RouteParams = { params: Promise<{ id: string }> };

/**
 *  (audit 5c3d97ca BLOCKER-1): the provider-lifecycle columns a
 * run carries, read wherever this route decides between revive and re-air
 * or admits a new provider/ingest effect.
 */
const PROVIDER_LIFECYCLE_SELECT = {
	providerStatus: true,
	providerStatusObservedAt: true,
	providerUnknownSince: true,
	providerTerminalAt: true,
} as const;

/**
 * The refusal a new provider/ingest effect (restart, SCTE-35, timeshift)
 * gets from the channel's CURRENT run's persisted provider view — UNKNOWN
 * (the read is failing; retryable) or TERMINAL (the encoder is gone; start a
 * fresh run). Null = admit. Read before any claim, so a refusal parks nothing
 * in PROVISIONING and enqueues nothing.
 */
type EffectPlan = {
	cancelRequested?: boolean;
	runId: string;
	providerEncodingId: string;
	providerRefusal: string | null;
	providerRefusalCode: CustomerErrorCode | null;
};

type EffectPlanFailure = { error: string; code: CustomerErrorCode };

function providerRefusalCode(
	view: ProviderLifecycleView,
): CustomerErrorCode | null {
	switch (view) {
		case "RUNNING":
			return null;
		case "TRANSITIONAL":
			return "LIVE_ACTION_PROVIDER_TRANSITIONAL";
		case "UNOBSERVED":
			return "LIVE_ACTION_PROVIDER_UNOBSERVED";
		case "UNKNOWN":
			return "LIVE_ACTION_PROVIDER_UNKNOWN";
		case "TERMINAL":
			return "LIVE_ACTION_PROVIDER_TERMINAL";
	}
}

function codedError(
	status: number,
	error: string,
	code: CustomerErrorCode,
	details: Readonly<Record<string, string | number | boolean | null>> = {},
) {
	return jsonError(status, error, customerErrorDetails(code, details));
}

async function effectPlan(
	prisma: Pick<AppPrismaClient, "liveChannelRun">,
	liveChannelId: string,
	channelEncodingId: string | null,
): Promise<EffectPlan | EffectPlanFailure> {
	const latest = await prisma.liveChannelRun.findFirst({
		where: { liveChannelId },
		orderBy: { seq: "desc" },
		select: {
			id: true,
			bitmovinEncodingId: true,
			cancelRequested: true,
			...PROVIDER_LIFECYCLE_SELECT,
		},
	});
	if (!latest) {
		return {
			error: "the channel has no current live run",
			code: "LIVE_ACTION_CURRENT_RUN_MISSING",
		};
	}
	const providerEncodingId = latest.bitmovinEncodingId ?? channelEncodingId;
	if (!providerEncodingId) {
		return {
			error: "the current live run has no provider encoding",
			code: "LIVE_ACTION_PROVIDER_ENCODING_MISSING",
		};
	}
	const lifecycle = deriveProviderLifecycle(latest, Date.now());
	return {
		runId: latest.id,
		cancelRequested: latest.cancelRequested,
		providerEncodingId,
		providerRefusal: providerEffectRefusal(lifecycle),
		providerRefusalCode: providerRefusalCode(lifecycle),
	};
}

function effectIntent(
	plan: EffectPlan,
	action: LiveEffectAction,
	admissionFenceVersion: number,
	targetId?: string,
	idempotencyKey = `manual:${action.toLowerCase()}:${randomUUID()}`,
	requestSha256?: string,
): LiveEffectIntent {
	return {
		idempotencyKey,
		...(requestSha256 ? { requestSha256 } : {}),
		liveChannelRunId: plan.runId,
		providerEncodingId: plan.providerEncodingId,
		admissionFenceVersion,
		action,
		...(targetId ? { targetId } : {}),
	};
}

/** Sentinels for the start transaction . */
class StartNotClaimableError extends Error {}
class RunAlreadyLiveError extends Error {}
const SETTLED_QUEUE_JOB_STATES = new Set(["failed", "completed"]);
const IN_PROGRESS_QUEUE_JOB_STATES = new Set([
	"active",
	"waiting",
	"delayed",
	"waiting-children",
	"prioritized",
]);
const MANUAL_STOP_SUCCESS_SCHEMA = z
	.object({
		acknowledged: z.literal(true),
		liveChannelId: z.uuid(),
		action: z.literal("stop"),
		status: z.literal("STOPPED"),
	})
	.strict();

type ManualStopQueueJob = {
	data: unknown;
	returnvalue?: unknown;
	getState(): Promise<string>;
	remove(): Promise<void>;
};

type ManualStopJobInspection =
	| { kind: "IN_PROGRESS" }
	| {
			kind: "SETTLED";
			exactIdentity: boolean;
			confirmedStopSuccess: boolean;
			state: string;
	  }
	| { kind: "REFUSED"; reason: string };

type ManualStopAdmission =
	| { kind: "ENQUEUED" | "REPLAYED" }
	| { kind: "REFUSED"; reason: string };

type ManualStopClaimInspection =
	| { kind: "NONE" | "FAILED" }
	| { kind: "OPEN"; state: "CLAIMED" | "DISPATCHING" }
	| { kind: "ACKED" }
	| { kind: "REFUSED"; reason: string };

function hasExactManualStopIdentity(
	data: unknown,
	liveChannelId: string,
	plan: EffectPlan,
): boolean {
	const queuedData =
		typeof data === "object" && data !== null
			? (data as {
					liveChannelId?: unknown;
					action?: unknown;
					effect?: unknown;
					params?: unknown;
					attemptId?: unknown;
					liveChannelRunId?: unknown;
					encodingId?: unknown;
					plannedLiveChannelRunId?: unknown;
				})
			: null;
	const parsedEffect = liveEffectIntentSchema.safeParse(queuedData?.effect);
	if (!parsedEffect.success) {
		return false;
	}
	const effect = parsedEffect.data;
	return (
		queuedData?.liveChannelId === liveChannelId &&
		queuedData.action === "stop" &&
		queuedData.params === undefined &&
		queuedData.attemptId === undefined &&
		queuedData.liveChannelRunId === undefined &&
		queuedData.encodingId === undefined &&
		queuedData.plannedLiveChannelRunId === undefined &&
		effect.idempotencyKey === `manual:stop:${liveChannelId}:${plan.runId}` &&
		effect.liveChannelRunId === plan.runId &&
		effect.providerEncodingId === plan.providerEncodingId &&
		effect.action === "STOP" &&
		effect.scheduleId === undefined &&
		effect.targetId === undefined &&
		effect.requestSha256 === undefined
	);
}

async function inspectManualStopClaim(
	prisma: Pick<AppPrismaClient, "liveEffectClaim">,
	liveChannelId: string,
	plan: EffectPlan,
): Promise<ManualStopClaimInspection> {
	const claim = await prisma.liveEffectClaim.findUnique({
		where: {
			idempotencyKey: `manual:stop:${liveChannelId}:${plan.runId}`,
		},
		select: {
			liveChannelId: true,
			requestSha256: true,
			liveChannelRunId: true,
			providerEncodingId: true,
			action: true,
			scheduleId: true,
			targetId: true,
			state: true,
		},
	});
	if (!claim) {
		return { kind: "NONE" };
	}
	if (
		claim.liveChannelId !== liveChannelId ||
		claim.requestSha256 !== null ||
		claim.liveChannelRunId !== plan.runId ||
		claim.providerEncodingId !== plan.providerEncodingId ||
		claim.action !== "STOP" ||
		claim.scheduleId !== null ||
		claim.targetId !== null
	) {
		return {
			kind: "REFUSED",
			reason:
				"the durable claim does not match the current manual stop identity",
		};
	}
	switch (claim.state) {
		case "FAILED":
			return { kind: "FAILED" };
		case "CLAIMED":
		case "DISPATCHING":
			return { kind: "OPEN", state: claim.state };
		case "ACKED":
			return { kind: "ACKED" };
		case "AMBIGUOUS":
			return {
				kind: "REFUSED",
				reason:
					"the durable stop claim is ambiguous and requires exact readback or operator resolution",
			};
		case "RESOLVED":
			return {
				kind: "REFUSED",
				reason: "the durable stop claim has already been resolved",
			};
		default:
			return {
				kind: "REFUSED",
				reason: "the durable stop claim has an unknown state",
			};
	}
}

async function inspectManualStopJob(
	job: ManualStopQueueJob,
	liveChannelId: string,
	plan: EffectPlan,
): Promise<ManualStopJobInspection> {
	const state = await job.getState();
	const exactIdentity = hasExactManualStopIdentity(
		job.data,
		liveChannelId,
		plan,
	);
	if (SETTLED_QUEUE_JOB_STATES.has(state)) {
		const success = MANUAL_STOP_SUCCESS_SCHEMA.safeParse(job.returnvalue);
		return {
			kind: "SETTLED",
			exactIdentity,
			confirmedStopSuccess:
				success.success && success.data.liveChannelId === liveChannelId,
			state,
		};
	}
	if (!IN_PROGRESS_QUEUE_JOB_STATES.has(state)) {
		return {
			kind: "REFUSED",
			reason: "the deterministic handoff has an unknown queue state",
		};
	}
	if (!exactIdentity) {
		return {
			kind: "REFUSED",
			reason:
				"the deterministic handoff does not match the current run and encoding",
		};
	}
	return { kind: "IN_PROGRESS" };
}

/**
 * Admit one deterministic manual STOP handoff without trusting BullMQ job-id
 * deduplication as an identity check. A retained in-progress job is reusable
 * only when its schema-valid provider-effect identity is exact. After add we
 * re-read Redis because a concurrent writer can win the job-id race while
 * `Queue.add` still resolves successfully with the caller's (losing) payload.
 */
async function admitManualStop(
	prisma: Pick<AppPrismaClient, "liveEffectClaim">,
	liveChannelId: string,
	plan: EffectPlan,
	admissionFenceVersion: number,
	mode: "ENQUEUE_OR_REPLAY" | "REPLAY_ONLY",
): Promise<ManualStopAdmission> {
	const queue = getLiveChannelQueue();
	const jobId = `manual-stop-${liveChannelId}-${plan.runId}`;
	const claim = await inspectManualStopClaim(prisma, liveChannelId, plan);
	if (claim.kind === "REFUSED") {
		return claim;
	}
	if (claim.kind === "ACKED") {
		return {
			kind: "REFUSED",
			reason:
				"the durable stop claim is already acknowledged; verify the channel state before retrying",
		};
	}
	const existing = await queue.getJob(jobId);
	if (existing) {
		const inspection = await inspectManualStopJob(
			existing,
			liveChannelId,
			plan,
		);
		if (inspection.kind === "IN_PROGRESS") {
			const replayClaim = await inspectManualStopClaim(
				prisma,
				liveChannelId,
				plan,
			);
			if (replayClaim.kind === "REFUSED") {
				return replayClaim;
			}
			if (replayClaim.kind === "ACKED") {
				return {
					kind: "REFUSED",
					reason:
						"the durable stop claim became acknowledged before the queue produced a confirmed STOPPED result",
				};
			}
			if (claim.kind === "OPEN" && replayClaim.kind !== "OPEN") {
				return {
					kind: "REFUSED",
					reason:
						"the durable stop claim changed while its queue replay was admitted",
				};
			}
			return { kind: "REPLAYED" };
		}
		if (inspection.kind === "REFUSED") {
			return inspection;
		}
		if (claim.kind === "OPEN") {
			return {
				kind: "REFUSED",
				reason: `the durable stop claim is ${claim.state.toLowerCase()} but its exact in-progress queue job is missing`,
			};
		}
		if (mode === "REPLAY_ONLY") {
			return {
				kind: "REFUSED",
				reason: "the matching handoff is no longer in progress",
			};
		}
		// A retained terminal id would make Queue.add a silent no-op. Reclaim it
		// before adding the fresh, exact intent; removal errors propagate.
		await existing.remove();
	} else if (claim.kind === "OPEN") {
		return {
			kind: "REFUSED",
			reason: `the durable stop claim is ${claim.state.toLowerCase()} but its exact in-progress queue job is missing`,
		};
	} else if (mode === "REPLAY_ONLY") {
		return {
			kind: "REFUSED",
			reason: "no matching in-progress handoff exists",
		};
	}

	const intent = effectIntent(
		plan,
		"STOP",
		admissionFenceVersion,
		undefined,
		`manual:stop:${liveChannelId}:${plan.runId}`,
	);
	await queue.add(
		"live-channel",
		{ liveChannelId, action: "stop", effect: intent },
		{
			jobId,
			attempts: 5,
			backoff: { type: "exponential", delay: 5_000 },
			removeOnComplete: 1000,
			removeOnFail: 1000,
		},
	);

	const winner = await queue.getJob(jobId);
	if (!winner) {
		return {
			kind: "REFUSED",
			reason: "the queued handoff could not be verified",
		};
	}
	const winnerInspection = await inspectManualStopJob(
		winner,
		liveChannelId,
		plan,
	);
	const winnerClaim = await inspectManualStopClaim(prisma, liveChannelId, plan);
	if (winnerClaim.kind === "REFUSED") {
		return winnerClaim;
	}
	if (winnerInspection.kind === "IN_PROGRESS") {
		if (winnerClaim.kind === "ACKED") {
			return {
				kind: "REFUSED",
				reason:
					"the durable stop claim is acknowledged but the queue has no confirmed STOPPED result",
			};
		}
		return { kind: "ENQUEUED" };
	}
	if (
		winnerInspection.kind === "SETTLED" &&
		winnerInspection.state === "completed" &&
		winnerInspection.exactIdentity &&
		winnerInspection.confirmedStopSuccess &&
		winnerClaim.kind === "ACKED"
	) {
		// The newly admitted exact job may finish before the producer re-reads it.
		return { kind: "ENQUEUED" };
	}
	if (
		winnerInspection.kind === "SETTLED" &&
		winnerInspection.state === "failed" &&
		winnerInspection.exactIdentity
	) {
		return {
			kind: "REFUSED",
			reason: "the queued handoff failed before it could be verified",
		};
	}
	if (
		winnerInspection.kind === "SETTLED" &&
		winnerInspection.state === "completed" &&
		winnerInspection.exactIdentity
	) {
		return {
			kind: "REFUSED",
			reason: "the completed handoff has no exact acknowledged STOPPED result",
		};
	}
	return {
		kind: "REFUSED",
		reason:
			winnerInspection.kind === "REFUSED"
				? winnerInspection.reason
				: "another payload won the deterministic handoff race",
	};
}
/** review-161-162 M6: a refusal thrown inside the start transaction that
 * must surface as its own message, not "no longer startable". */
class ActionRefused extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code: CustomerErrorCode,
	) {
		super(message);
		this.name = "ActionRefused";
	}
}

/**
 * Channel lifecycle actions, routed to the live-channel worker via the
 * queue (the encoding-jobs pattern). STOP/restart are API actions on the
 * persisted channel — never compiled steps (COVERAGE P3 batch 1).
 *
 * start      CREATED|ERROR  → re-enqueue provisioning (ERROR resets failed
 *                             steps to PENDING, the VOD retry pattern)
 * stop       RUNNING|ERROR  → durable handoff, STOPPING projection → STOPPED
 * restart    RUNNING|STOPPED|ERROR → worker → PROVISIONING → RUNNING
 * reset-timeshift / scte35   RUNNING only, params validated here AND in
 *                             the worker (queue payloads cross processes)
 */
const actionSchema = z.discriminatedUnion("action", [
	z.strictObject({
		action: z.literal("update-rtmp-ingest"),
		runId: z.uuid(),
		requestId: z.uuid(),
		...liveRtmpIngestParamsSchema.shape,
	}),
	z.object({ action: z.literal("start") }),
	z.strictObject({
		action: z.literal("cancel-start"),
		generation: z.number().int().min(0),
		runId: z.uuid().optional(),
	}),
	z.object({ action: z.literal("stop") }),
	z.object({ action: z.literal("restart") }),
	z.object({
		action: z.literal("reset-timeshift"),
		...liveResetTimeshiftParamsSchema.shape,
	}),
	z.object({
		action: z.literal("scte35"),
		requestId: z.uuid(),
		...liveScte35ParamsSchema.shape,
	}),
]);

async function enqueue(
	liveChannelId: string,
	action: string,
	params?: Record<string, unknown>,
	effect?: LiveEffectIntent,
	delivery: {
		jobId?: string;
		attempts?: number;
		backoff?: { type: "exponential"; delay: number };
	} = {},
): Promise<void> {
	const queue = getLiveChannelQueue();
	const { jobId } = delivery;
	if (jobId) {
		/**
		 * BullMQ dedupes against retained FAILED/COMPLETED jobs too. A
		 * deterministic action that failed before claiming its effect must be able
		 * to retry, so reclaim only a settled copy. Manual STOP uses the stricter
		 * identity-aware admission helper above instead of this generic path.
		 */
		const existing = await queue.getJob(jobId);
		if (existing && SETTLED_QUEUE_JOB_STATES.has(await existing.getState())) {
			// A failed remove may leave the terminal id in Redis, in which case add
			// would be silently deduped and no worker would run. Propagate instead:
			// this path has not touched channel state, so the operator can retry.
			await existing.remove();
		}
	}
	await queue.add(
		"live-channel",
		{
			liveChannelId,
			action,
			...(params ? { params } : {}),
			...(effect ? { effect } : {}),
		},
		{
			// Most actions remain unique per attempt. Callers that need retry-stable
			// identity supply a deterministic id after settling a terminal copy.
			jobId: jobId ?? `${liveChannelId}-${action}-${Date.now()}`,
			...(delivery.attempts ? { attempts: delivery.attempts } : {}),
			...(delivery.backoff ? { backoff: delivery.backoff } : {}),
			removeOnComplete: 1000,
			removeOnFail: 1000,
		},
	);
}

export async function POST(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	const body = actionSchema.safeParse(await readJson(req));
	if (!body.success) {
		return validationError(body.error);
	}
	const action = body.data;
	try {
		// Fail fast: every action needs the worker to decrypt the account
		// API key — with a broken MASTER_KEY the job would just wedge.
		masterKeyFromEnv();
		const ctx = await getServerContext();
		const row = await ctx.prisma.liveChannel.findUnique({ where: { id } });
		if (!row) {
			return jsonError(404, "Not found");
		}

		switch (action.action) {
			case "start": {
				//  PR3 (closes #110 and #48's duplicate-encoding
				// half): START creates or revives the RUN, and STOPPED joins
				// the startable set — a re-air is a NEW run with a FRESH
				// encoding (C30: the finished one is unrecoverable and never
				// touched), not the restart the vendor cannot do.
				if (
					row.status !== "CREATED" &&
					row.status !== "ERROR" &&
					row.status !== "STOPPED"
				) {
					return jsonError(
						409,
						`Only CREATED, ERROR or STOPPED channels can be started (status: ${row.status})`,
						customerErrorDetails("LIVE_ACTION_NOT_STARTABLE", {
							status: row.status,
						}),
					);
				}
				// Pre-minted so the run's id can be baked into the #155 rebased
				// paths BEFORE the row exists (the id names the subtree).
				const freshRunId = randomUUID();
				try {
					await ctx.prisma.$transaction(async (tx) => {
						// The latest run FIRST: the refusal and the re-air
						// decision both read it, and reading before the claim
						// keeps the (channel ERROR × latest STOPPED) cell from
						// reseeding a FINISHED encoding's step log (review-244
						// K3 — unreachable as traced, moot by construction).
						const latest = await tx.liveChannelRun.findFirst({
							where: { liveChannelId: id },
							orderBy: { seq: "desc" },
							select: {
								id: true,
								seq: true,
								status: true,
								cancelRequested: true,
								...PROVIDER_LIFECYCLE_SELECT,
							},
						});
						// K2: ONE definition of "live" — core's, pinned to the
						// migration's index predicate by #240's test.
						if (latest?.cancelRequested && latest.status !== "STOPPED")
							throw new StartNotClaimableError();
						if (latest && isLiveRunStatus(latest.status)) {
							// A live run already exists — the partial unique
							// index would refuse the insert below; answer the
							// same refusal BEFORE paying for it (#48).
							throw new RunAlreadyLiveError();
						}
						/**
						 *  (audit 5c3d97ca BLOCKER-1): a run the PROVIDER
						 * ended is never revived. The audited sequence was exactly
						 * this arm — channel ERROR × run ERROR after a Restart 409 —
						 * and the revive replayed the FINISHED encoding's DONE step
						 * log, reused its id and ingest coordinates, and wrote
						 * RUNNING over a dead encoder. A terminal provider view
						 * makes the start a RE-AIR: seq+1, fresh compile, fresh
						 * encoding, fresh prefix, fresh coordinates, channel
						 * columns cleared. (The worker's provision entry re-reads
						 * the provider for a revive whose columns are still null,
						 * so a legacy row cannot slip through on UNOBSERVED.)
						 */
						const latestProviderTerminal =
							latest !== null &&
							deriveProviderLifecycle(latest, Date.now()) === "TERMINAL";
						const isReair =
							row.status === "STOPPED" ||
							latest?.status === "STOPPED" ||
							(latest?.status === "ERROR" && latestProviderTerminal);
						// Resume REVIVES the latest run — same airing, same
						// encoding, same row (#108 PR3); the revive-vs-create
						// decision below and the corpse compile both key on it.
						const isRevive =
							row.status === "ERROR" &&
							latest?.status === "ERROR" &&
							!latestProviderTerminal;
						// ERROR resume: FAILED/RUNNING steps reset to PENDING;
						// DONE steps keep their resource ids so the worker
						// resumes instead of recreating (VOD retry pattern).
						// A re-air gets a FRESH COMPILED log — the worker's
						// provision EXECUTES the row's log and never compiles
						// (the first cut wrote [] believing otherwise; found by
						// the first real re-air, 2026-08-21 — run #2 of channel
						// edc041f5, every test having started from CREATED,
						// whose log the create route had compiled). Since #155
						// the fresh log is compiled PER RUN: seq ≥ 2 rebases
						// into the run's own subtree so a re-air cannot write
						// over the previous airing's segments (design §4).
						const reseeded = reseedFailedSteps(
							stepLogSchema.parse(row.stepLog),
						);
						// An EMPTY log also compiles on the resume arm: there is
						// nothing to resume, and reseeding [] reproduces the
						// re-air death above on any row the old bug stranded
						// (channel ERROR, run ERROR, log []) — the resume would
						// walk zero steps and die at finalize again, forever.
						// The compile targets the run this start CONTINUES OR
						// CREATES: the revived latest run's own coordinates on
						// the corpse arm, the fresh row's otherwise.
						const runForCompile =
							isRevive && latest
								? { seq: latest.seq, runId: latest.id }
								: { seq: (latest?.seq ?? 0) + 1, runId: freshRunId };
						const compiled =
							isReair || reseeded.length === 0
								? compileLiveRunStepLog(
										liveChannelPlanSchema.parse(row.plan),
										runForCompile,
									)
								: null;
						const entries = compiled ? compiled.entries : reseeded;
						// Atomic claim — the status transition is the lock: a
						// second concurrent start matches zero rows and 409s.
						const { count } = await tx.liveChannel.updateMany({
							where: {
								id,
								liveEffectFenceVersion: row.liveEffectFenceVersion ?? 0,
								runs: {
									none: { cancelRequested: true, status: { not: "STOPPED" } },
								},
								effectClaims: {
									none: {
										state: {
											in: ["CLAIMED", "DISPATCHING", "AMBIGUOUS"],
										},
									},
								},
								// Same as the scheduler's claim: a STOPPED row
								// carrying an error is a stop that never
								// confirmed, and re-airing it would clear the
								// evidence, the pointer and the step log — the
								// warning AND its remedy — then start a second
								// encoding beside a possibly-live first one.
								// ERROR and CREATED are unaffected; only the
								// STOPPED arm gains the condition.
								OR: [
									{ status: { in: ["CREATED", "ERROR"] } },
									{ status: "STOPPED", error: null },
								],
							},
							data: {
								status: "PROVISIONING",
								liveEffectFenceVersion: { increment: 1 },
								error: null,
								// Release any previous run's provisioning lease in
								// the SAME atomic claim (AKR-E57-003). One shared
								// constant because there are THREE doors that claim
								// a channel into PROVISIONING and the first cut
								// released the lease in only this one.
								...PROVISION_LEASE_RELEASE,
								stepLog: entries as unknown as Prisma.InputJsonValue,
								// A re-air frees the per-run channel columns so
								// provision builds a FRESH encoding; the old
								// run row keeps the history (already mirrored).
								...(isReair
									? {
											bitmovinEncodingId: null,
											encoderIp: null,
											streamKey: null,
											lastHeartbeat: DB_NULL,
											liveToVod: DB_NULL,
										}
									: {}),
							},
						});
						if (count === 0) {
							throw new StartNotClaimableError();
						}
						if (isRevive && latest) {
							// Resume REVIVES the run — the same airing
							// continuing on the same encoding, not a new one.
							// endedAt clears WITH the revival (review-259
							// 116-A2): leaving the old ERROR stamp while the
							// restart rewrites runningSince fresh produced a
							// run that "ended" before it began — runs-panel
							// showed the bogus end time, and any reader
							// treating endedAt as authoritative (airtime)
							// counted an on-air channel as zero.
							await tx.liveChannelRun.update({
								where: { id: latest.id },
								data: {
									status: "PROVISIONING",
									error: null,
									endedAt: null,
									// rev431: the revived run restarts the SAME encoding —
									// a CREATED confirmation for it is void from here.
									encoderStoppedConfirmedFor: null,
									// The heartbeat summary clears with endedAt — the
									// lock, so the resumed airing is summarized again
									// over all its rows when it really ends, and the
									// JSON, so the RUNNING revived run does not serve
									// the aborted airing's figures meanwhile (rev405 R4).
									heartbeatSummary: DB_NULL,
									heartbeatSummaryAt: null,
									// The corpse arm recompiled this run's log —
									// stamp the subtree it now writes under
									// (#155); a plain resume keeps its prefix.
									...(compiled ? { outputPrefix: compiled.outputPrefix } : {}),
								},
							});
						} else {
							// First start (no run) or re-air (terminal run):
							// a NEW run row. A concurrent creator loses on the
							// partial unique index (P2002 → the catch below).
							// A re-air row carries the PRE-MINTED id its
							// compiled step log's paths already name, and the
							// prefix the compile derived (#155); a first start
							// writes at the plan's own paths (prefix "").
							await tx.liveChannelRun.create({
								data: {
									...(compiled ? { id: runForCompile.runId } : {}),
									liveChannelId: id,
									seq: runForCompile.seq,
									status: "PROVISIONING",
									outputPrefix: compiled ? compiled.outputPrefix : "",
								},
							});
						}
					});
				} catch (err) {
					if (err instanceof MslEncoderVersionError) {
						return jsonError(400, "Live channel plan validation failed", {
							issues: [err.issue],
						});
					}
					if (err instanceof ActionRefused) {
						return codedError(
							err.status,
							"This deployment does not allow the channel plan",
							err.code,
						);
					}
					if (err instanceof StartNotClaimableError) {
						return codedError(
							409,
							"Channel is no longer startable",
							"LIVE_ACTION_STATE_CHANGED",
						);
					}
					if (
						err instanceof RunAlreadyLiveError ||
						(err as { code?: string }).code === "P2002"
					) {
						return codedError(
							409,
							"A run is already live for this channel — one channel, one live run",
							"LIVE_ACTION_RUN_ALREADY_ACTIVE",
						);
					}
					throw err;
				}
				try {
					await enqueue(id, "provision");
				} catch (enqueueErr) {
					await ctx.prisma.liveChannel.update({
						where: { id },
						data: { status: "ERROR", error: "Enqueue failed — start again" },
					});
					throw enqueueErr;
				}
				return NextResponse.json({
					id,
					action: "start",
					status: "PROVISIONING",
				});
			}
			case "cancel-start": {
				let runId!: string;
				for (let attempt = 0; attempt < 2; attempt++) {
					try {
						runId = await ctx.prisma.$transaction(async (tx) => {
							const current = await tx.liveChannel.findUnique({
								where: { id },
							});
							if (
								!current ||
								(current.liveEffectFenceVersion ?? 0) !== action.generation
							)
								throw new StartNotClaimableError();
							const latest = await tx.liveChannelRun.findFirst({
								where: { liveChannelId: id },
								orderBy: { seq: "desc" },
							});
							if (action.runId && latest?.id !== action.runId)
								throw new StartNotClaimableError();
							const replay =
								latest?.cancelRequested === true &&
								["STOPPING", "ERROR"].includes(current.status);
							if (
								!replay &&
								!["CREATED", "PROVISIONING", "RUNNING"].includes(current.status)
							)
								throw new StartNotClaimableError();
							const claimed = await tx.liveChannel.updateMany({
								where: {
									id,
									status: current.status,
									liveEffectFenceVersion: action.generation,
								},
								data: { status: "STOPPING" },
							});
							if (claimed.count !== 1) throw new StartNotClaimableError();
							if (latest) {
								await tx.liveChannelRun.update({
									where: { id: latest.id },
									data: { cancelRequested: true, status: "STOPPING" },
								});
								return latest.id;
							}
							const created = await tx.liveChannelRun.create({
								data: {
									liveChannelId: id,
									seq: 1,
									status: "STOPPING",
									outputPrefix: "",
									cancelRequested: true,
									stepLog: current.stepLog as Prisma.InputJsonValue,
								},
							});
							return created.id;
						});
						break;
					} catch (error) {
						if ((error as { code?: string })?.code === "P2002" && attempt === 0)
							continue;
						if (error instanceof StartNotClaimableError)
							return codedError(
								409,
								"The start attempt changed before cancellation",
								"LIVE_ACTION_STATE_CHANGED",
							);
						throw error;
					}
				}
				// The run flag is the durable intent. Redis failure is recovered by the
				// worker sweep; never roll it back or claim that resources are stopped.
				try {
					await enqueue(id, "provision", { cancelRunId: runId }, undefined, {
						jobId: `cancel-start-${id}-${runId}`,
					});
				} catch {
					/* durable DB intent remains for automatic recovery */
				}
				return NextResponse.json(
					{
						id,
						action: "cancel-start",
						runId,
						status: "STOPPING",
						cancellationRequested: true,
					},
					{ status: 202 },
				);
			}
			case "stop": {
				if (!row.bitmovinEncodingId) {
					return codedError(
						409,
						"Channel has no Bitmovin encoding to stop",
						"LIVE_ACTION_NO_ENCODING",
					);
				}
				const retryingUnconfirmedStop =
					row.status === "STOPPED" &&
					row.error !== null &&
					row.error !== undefined;
				if (row.status === "STOPPING") {
					const replayPlan = await effectPlan(
						ctx.prisma,
						id,
						row.bitmovinEncodingId,
					);
					if ("error" in replayPlan) {
						return codedError(
							409,
							`Stop replay refused — ${replayPlan.error}`,
							replayPlan.code,
						);
					}
					/**
					 * Validate admissionFenceVersion through the effect schema, but do not
					 * compare it with the STOPPING row's fence. Durable manual STOP adopts
					 * the current generation when it claims and increments it atomically;
					 * therefore the persisted STOPPING fence is intentionally newer than
					 * the route's admission observation.
					 */
					const admission = await admitManualStop(
						ctx.prisma,
						id,
						replayPlan,
						row.liveEffectFenceVersion ?? 0,
						"REPLAY_ONLY",
					);
					if (admission.kind === "REFUSED") {
						return codedError(
							409,
							`Stop replay refused because ${admission.reason}`,
							"LIVE_ACTION_STOP_HANDOFF_MISSING",
						);
					}
					return NextResponse.json(
						{
							id,
							action: "stop",
							status: row.status,
							handoffStatus: "QUEUED",
							idempotentReplay: true,
						},
						{ status: 202 },
					);
				}
				if (
					row.status !== "RUNNING" &&
					row.status !== "ERROR" &&
					!retryingUnconfirmedStop
				) {
					return codedError(
						409,
						`Only RUNNING or ERROR channels can be stopped, or a STOPPED one whose stop never confirmed (status: ${row.status})`,
						"LIVE_ACTION_NOT_STOPPABLE",
						{ status: row.status },
					);
				}
				const stopPlan = await effectPlan(
					ctx.prisma,
					id,
					row.bitmovinEncodingId,
				);
				if ("error" in stopPlan) {
					return codedError(
						409,
						`Stop refused — ${stopPlan.error}`,
						stopPlan.code,
					);
				}
				/**
				 * Queue FIRST. The former ordering committed STOPPING and advanced
				 * the fence before `queue.add`; a process death in that gap left no
				 * durable stop job and no route that would accept the STOPPING row.
				 *
				 * The handoff is bound to the pre-enqueue run and provider. The fence is
				 * an admission observation; the worker re-reads and supersedes any
				 * intervening effect only while that exact run/provider remains current.
				 * Its deterministic ids collapse an accepted-but-response-lost retry,
				 * while the worker's generation CAS is the final exactly-once rail.
				 */
				const admissionFenceVersion = row.liveEffectFenceVersion ?? 0;
				const admission = await admitManualStop(
					ctx.prisma,
					id,
					stopPlan,
					admissionFenceVersion,
					"ENQUEUE_OR_REPLAY",
				);
				if (admission.kind === "REFUSED") {
					return codedError(
						409,
						`Stop refused because ${admission.reason}`,
						"LIVE_ACTION_STOP_HANDOFF_MISSING",
					);
				}
				/**
				 * The worker is the sole STOPPING writer. Even a post-add CAS here can
				 * race with a job that dies before claiming its effect: the dead-job
				 * handler sees the still-RUNNING row and correctly leaves it retryable,
				 * only for the route to repaint it STOPPING after the job is already
				 * terminal. Keeping the row unchanged until the worker starts means a
				 * retained failed job can always be reclaimed by the next stop request.
				 * That includes 's STOPPED-with-unconfirmed-error retry.
				 */
				return NextResponse.json(
					{
						id,
						action: "stop",
						// The route has durably handed off, but the worker is the sole
						// STOPPING writer. Report the persisted state rather than claiming a
						// transition that may not have happened yet.
						status: row.status,
						handoffStatus: "QUEUED",
						...(admission.kind === "REPLAYED"
							? { idempotentReplay: true }
							: {}),
					},
					{ status: 202 },
				);
			}
			case "restart": {
				if (!row.bitmovinEncodingId) {
					return codedError(
						409,
						"Channel has no Bitmovin encoding to restart",
						"LIVE_ACTION_NO_ENCODING",
					);
				}
				/**
				 * STOPPED is NOT restartable, and never was: `stopChannel`
				 * calls `stopLiveEncoding`, so a stopped channel's encoding is
				 * FINISHED, and Bitmovin refuses a terminal encoding with
				 * `409 … code 2028` (a finished live encoding's infrastructure
				 * is deallocated; the recovery is a NEW encoding (C30 — the vendor's docs assistant confirms it; no public state matrix exists) —
				 * Duplicate). We offered the button anyway on the strength of
				 * a comment in the worker that claimed the opposite, until an
				 * operator hit the 409 on 2026-08-16 .
				 *
				 * ERROR stays claimable: the channel row goes ERROR for
				 * failures that leave the ENCODING running (the lifecycle
				 * strip already says "may still be up on Bitmovin"), and that
				 * is exactly when a restart is the right recovery.
				 */
				if (row.status !== "RUNNING" && row.status !== "ERROR") {
					return codedError(
						409,
						row.status === "STOPPED"
							? "A stopped channel's encoding is FINISHED on Bitmovin and cannot be restarted — START the channel to begin a new run with a fresh encoding"
							: `Only RUNNING or ERROR channels can be restarted (status: ${row.status})`,
						row.status === "STOPPED"
							? "LIVE_ACTION_RESTART_REQUIRES_NEW_RUN"
							: "LIVE_ACTION_NOT_RESTARTABLE",
						{ status: row.status },
					);
				}
				/**
				 *  (audit 5c3d97ca BLOCKER-1): the provider's view of the
				 * run's encoding decides BEFORE the claim. A TERMINAL run gets the
				 * same guidance a STOPPED channel does (the encoder is gone; the
				 * remedy is a fresh Start), and an UNKNOWN one — the read is
				 * failing — is refused retryably: the vendor is never asked to
				 * restart an encoding we cannot see. Zero provider calls, zero
				 * claims, zero enqueues on either refusal. The worker re-reads
				 * the provider at its own entry for a run with no view yet.
				 */
				const restartPlan = await effectPlan(
					ctx.prisma,
					id,
					row.bitmovinEncodingId,
				);
				if (!("error" in restartPlan) && restartPlan.cancelRequested)
					return codedError(
						409,
						"Startup cancellation is pending",
						"LIVE_ACTION_STATE_CHANGED",
					);
				const restartRefusal =
					"error" in restartPlan
						? { message: restartPlan.error, code: restartPlan.code }
						: restartPlan.providerRefusal && restartPlan.providerRefusalCode
							? {
									message: restartPlan.providerRefusal,
									code: restartPlan.providerRefusalCode,
								}
							: null;
				if (restartRefusal) {
					return codedError(
						409,
						`Restart refused — ${restartRefusal.message}. If the encoding has ended, START the channel to begin a new run with a fresh encoding`,
						restartRefusal.code,
					);
				}
				// Atomic claim, same transition-is-the-lock pattern as start: a
				// second concurrent restart matches zero rows and 409s instead
				// of enqueueing a duplicate (= a second stream interruption).
				const { count } = await ctx.prisma.liveChannel.updateMany({
					where: {
						id,
						status: { in: ["RUNNING", "ERROR"] },
						liveEffectFenceVersion: row.liveEffectFenceVersion ?? 0,
						runs: {
							none: { cancelRequested: true, status: { not: "STOPPED" } },
						},
						effectClaims: {
							none: {
								state: { in: ["CLAIMED", "DISPATCHING", "AMBIGUOUS"] },
							},
						},
					},
					// The third door (run-rebase.ts): a restart's claim releases
					// any stale lease too, so the worker's claim never sees a
					// token some earlier provision left behind (review-336 S2).
					data: {
						status: "PROVISIONING",
						liveEffectFenceVersion: { increment: 1 },
						error: null,
						...PROVISION_LEASE_RELEASE,
					},
				});
				if (count === 0) {
					return codedError(
						409,
						"Channel is no longer restartable",
						"LIVE_ACTION_STATE_CHANGED",
					);
				}
				try {
					await enqueue(
						id,
						"restart",
						undefined,
						effectIntent(
							restartPlan as EffectPlan,
							"RESTART",
							(row.liveEffectFenceVersion ?? 0) + 1,
						),
					);
				} catch (enqueueErr) {
					await ctx.prisma.liveChannel.update({
						where: { id },
						data: { status: "ERROR", error: "Enqueue failed — restart again" },
					});
					throw enqueueErr;
				}
				return NextResponse.json({
					id,
					action: "restart",
					status: "PROVISIONING",
				});
			}
			case "update-rtmp-ingest": {
				const plan = await effectPlan(ctx.prisma, id, row.bitmovinEncodingId);
				if ("error" in plan) return codedError(409, plan.error, plan.code);
				if (action.runId !== plan.runId || row.status !== "RUNNING")
					return codedError(
						409,
						"RTMP update requires the current RUNNING run",
						"LIVE_ACTION_REQUEST_CONFLICT",
					);
				if (plan.providerRefusal && plan.providerRefusalCode)
					return codedError(
						409,
						plan.providerRefusal,
						plan.providerRefusalCode,
					);
				const params = liveRtmpIngestParamsSchema.parse({
					pointIndexes: action.pointIndexes,
				});
				const parsedPlan = liveChannelPlanSchema.safeParse(row.plan);
				if (!parsedPlan.success)
					return jsonError(409, "Channel plan is unavailable");
				let points: ReturnType<typeof selectRtmpIngestPoints>;
				try {
					points = selectRtmpIngestPoints(parsedPlan.data, params);
				} catch {
					return jsonError(
						422,
						"Select declared dynamic redundant RTMP ingest points",
					);
				}
				const requestSha256 = createHash("sha256")
					.update(
						JSON.stringify({
							runId: plan.runId,
							...params,
							ingestPoints: points,
						}),
					)
					.digest("hex");
				const idempotencyKey = `manual:rtmp-ingest:${id}:${action.requestId}`;
				const existing = await ctx.prisma.liveEffectClaim.findUnique({
					where: { idempotencyKey },
				});
				if (
					existing &&
					(existing.requestSha256 !== requestSha256 ||
						existing.liveChannelRunId !== plan.runId ||
						existing.providerEncodingId !== plan.providerEncodingId ||
						existing.action !== "RTMP_INGEST_UPDATE")
				)
					return codedError(
						409,
						"Request ID is bound to another RTMP update",
						"LIVE_ACTION_REQUEST_CONFLICT",
					);
				if (existing?.state === "ACKED")
					return NextResponse.json({
						id,
						action: action.action,
						acknowledged: true,
						idempotentReplay: true,
					});
				if (existing && existing.state !== "FAILED")
					return codedError(
						409,
						"RTMP update is pending or requires effect resolution",
						existing.state === "AMBIGUOUS"
							? "LIVE_ACTION_REQUEST_AMBIGUOUS"
							: "LIVE_ACTION_REQUEST_IN_PROGRESS",
					);
				const intent = effectIntent(
					plan,
					"RTMP_INGEST_UPDATE",
					row.liveEffectFenceVersion ?? 0,
					undefined,
					idempotencyKey,
					requestSha256,
				);
				const jobId = `${id}-rtmp-ingest-${action.requestId}`;
				const queue = getLiveChannelQueue();
				const matchesRequest = (raw: unknown) => {
					const data = raw as {
						action?: unknown;
						effect?: unknown;
						params?: unknown;
						liveChannelId?: unknown;
					} | null;
					const queuedEffect = liveEffectIntentSchema.safeParse(data?.effect);
					return (
						queuedEffect.success &&
						data?.liveChannelId === id &&
						data.action === action.action &&
						JSON.stringify(data.params) === JSON.stringify(params) &&
						queuedEffect.data.idempotencyKey === intent.idempotencyKey &&
						queuedEffect.data.requestSha256 === requestSha256 &&
						queuedEffect.data.liveChannelRunId === plan.runId &&
						queuedEffect.data.providerEncodingId === plan.providerEncodingId &&
						queuedEffect.data.action === intent.action
					);
				};
				const queued = await queue.getJob(jobId);
				if (queued && !SETTLED_QUEUE_JOB_STATES.has(await queued.getState())) {
					if (
						!IN_PROGRESS_QUEUE_JOB_STATES.has(await queued.getState()) ||
						!matchesRequest(queued.data)
					)
						return codedError(
							409,
							"Queued RTMP update identity conflicts",
							"LIVE_ACTION_REQUEST_CONFLICT",
						);
					return NextResponse.json(
						{
							id,
							action: action.action,
							handoffStatus: "QUEUED",
							idempotentReplay: true,
						},
						{ status: 202 },
					);
				}
				await enqueue(id, action.action, params, intent, { jobId });
				const winner = await queue.getJob(jobId);
				if (!winner || !matchesRequest(winner.data))
					return codedError(
						409,
						"Queued RTMP update identity conflicts",
						"LIVE_ACTION_REQUEST_CONFLICT",
					);
				return NextResponse.json(
					{ id, action: action.action, handoffStatus: "QUEUED" },
					{ status: 202 },
				);
			}
			case "reset-timeshift": {
				if (row.status !== "RUNNING") {
					return codedError(
						409,
						`Timeshift can only be reset on a RUNNING channel (status: ${row.status})`,
						"LIVE_ACTION_TIMESHIFT_REQUIRES_RUNNING",
						{ status: row.status },
					);
				}
				//  item 4: a new encoder effect waits for a confirmed
				// provider view (the worker re-checks the same view at execution).
				const timeshiftPlan = await effectPlan(
					ctx.prisma,
					id,
					row.bitmovinEncodingId,
				);
				const timeshiftRefusal =
					"error" in timeshiftPlan
						? { message: timeshiftPlan.error, code: timeshiftPlan.code }
						: timeshiftPlan.providerRefusal && timeshiftPlan.providerRefusalCode
							? {
									message: timeshiftPlan.providerRefusal,
									code: timeshiftPlan.providerRefusalCode,
								}
							: null;
				if (timeshiftRefusal) {
					return codedError(
						409,
						`Timeshift reset refused — ${timeshiftRefusal.message}`,
						timeshiftRefusal.code,
					);
				}
				const { action: _action, ...timeshiftParams } = action;
				await enqueue(
					id,
					"reset-timeshift",
					timeshiftParams,
					effectIntent(
						timeshiftPlan as EffectPlan,
						"TIMESHIFT_RESET",
						row.liveEffectFenceVersion ?? 0,
					),
				);
				return NextResponse.json({
					id,
					action: "reset-timeshift",
					status: row.status,
				});
			}
			case "scte35": {
				const { action: _action, requestId, ...cueParams } = action;
				const requestSha256 = createHash("sha256")
					.update(
						JSON.stringify({
							cueDuration: cueParams.cueDuration,
							manifestIds: cueParams.manifestIds
								? [...cueParams.manifestIds].sort()
								: [],
						}),
					)
					.digest("hex");
				const idempotencyKey = `manual:scte35:${id}:${requestId}`;
				const existing = await ctx.prisma.liveEffectClaim.findUnique({
					where: { idempotencyKey },
					select: {
						requestSha256: true,
						liveChannelRunId: true,
						providerEncodingId: true,
						action: true,
						state: true,
						providerResultId: true,
					},
				});
				if (existing && existing.requestSha256 !== requestSha256) {
					return codedError(
						409,
						"This request ID is already bound to a different SCTE-35 cue",
						"LIVE_ACTION_REQUEST_CONFLICT",
					);
				}
				//  item 4: same gate as timeshift — a cue is signalling
				// into an encoder we must be able to see.
				const cuePlan = await effectPlan(
					ctx.prisma,
					id,
					row.bitmovinEncodingId,
				);
				if ("error" in cuePlan) {
					return codedError(
						409,
						`SCTE-35 cue refused — ${cuePlan.error}`,
						cuePlan.code,
					);
				}
				if (
					existing &&
					(existing.liveChannelRunId !== cuePlan.runId ||
						existing.providerEncodingId !== cuePlan.providerEncodingId ||
						existing.action !== "SCTE35")
				) {
					return codedError(
						409,
						"This request ID is already bound to a different SCTE-35 cue",
						"LIVE_ACTION_REQUEST_CONFLICT",
					);
				}
				if (existing?.state === "ACKED") {
					return NextResponse.json({
						id,
						action: "scte35",
						status: row.status,
						requestId,
						acknowledged: true,
						idempotentReplay: true,
						...(existing.providerResultId
							? { providerResultId: existing.providerResultId }
							: {}),
					});
				}
				if (existing?.state === "AMBIGUOUS") {
					return codedError(
						409,
						"This SCTE-35 request may already have been applied; resolve the live effect before retrying",
						"LIVE_ACTION_REQUEST_AMBIGUOUS",
					);
				}
				if (existing && existing.state !== "FAILED") {
					return codedError(
						409,
						`This SCTE-35 request is already ${existing.state.toLowerCase()} and cannot be queued again`,
						"LIVE_ACTION_REQUEST_IN_PROGRESS",
					);
				}
				if (row.status !== "RUNNING") {
					return codedError(
						409,
						`SCTE-35 cues need a RUNNING channel (status: ${row.status})`,
						"LIVE_ACTION_CUE_REQUIRES_RUNNING",
						{ status: row.status },
					);
				}
				if (cuePlan.providerRefusal && cuePlan.providerRefusalCode) {
					return codedError(
						409,
						`SCTE-35 cue refused — ${cuePlan.providerRefusal}`,
						cuePlan.providerRefusalCode,
					);
				}
				const jobId = `${id}-scte35-${requestId}`;
				const intent = effectIntent(
					cuePlan,
					"SCTE35",
					row.liveEffectFenceVersion ?? 0,
					undefined,
					idempotencyKey,
					requestSha256,
				);
				const matchesQueuedRequest = (data: unknown): boolean => {
					const queuedData = data as {
						liveChannelId?: unknown;
						action?: unknown;
						effect?: Partial<LiveEffectIntent>;
					};
					return (
						queuedData.liveChannelId === id &&
						queuedData.action === "scte35" &&
						queuedData.effect?.idempotencyKey === intent.idempotencyKey &&
						queuedData.effect?.requestSha256 === intent.requestSha256 &&
						queuedData.effect?.liveChannelRunId === intent.liveChannelRunId &&
						queuedData.effect?.providerEncodingId ===
							intent.providerEncodingId &&
						queuedData.effect?.action === intent.action
					);
				};
				const queued = await getLiveChannelQueue().getJob(jobId);
				if (queued && !matchesQueuedRequest(queued.data)) {
					return codedError(
						409,
						"This request ID is already queued with a different SCTE-35 cue",
						"LIVE_ACTION_REQUEST_CONFLICT",
					);
				}
				const queuedState = queued ? await queued.getState() : null;
				if (!queued || SETTLED_QUEUE_JOB_STATES.has(queuedState ?? "")) {
					await enqueue(id, "scte35", cueParams, intent, { jobId });
					const winner = await getLiveChannelQueue().getJob(jobId);
					if (!winner || !matchesQueuedRequest(winner.data)) {
						return codedError(
							409,
							"This request ID was concurrently bound to a different SCTE-35 cue",
							"LIVE_ACTION_REQUEST_CONFLICT",
						);
					}
				}
				return NextResponse.json({
					id,
					action: "scte35",
					status: row.status,
					requestId,
					idempotentReplay: queued !== null,
				});
			}
			default: {
				const exhaustive: never = action;
				return jsonError(400, `Unknown action ${String(exhaustive)}`);
			}
		}
	} catch (err) {
		return routeError(err);
	}
}
