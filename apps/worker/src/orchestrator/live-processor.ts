import { createHash, randomUUID } from "node:crypto";
import {
	classifyProviderLifecycle,
	deriveFeederRtmpTarget,
	deriveLiveToVodStatus,
	FEEDER_ACTIVE_STATUSES,
	FEEDER_MAX_ACTIVE_SESSIONS,
	type FeederJob,
	feederOccupancyWhere,
	isRuntimeRecordKind,
	isStaleGeneration,
	joinManifestPath,
	type LiveAutoShutdownUpdateParams,
	type LiveChannelAction,
	type LiveChannelJob,
	type LiveEffectIntent,
	type LiveFeederActionParams,
	type LiveFeederCommitParams,
	type LiveFeederStageParams,
	type LiveInsertContentParams,
	type LiveResetTimeshiftParams,
	type LiveRtmpIngestParams,
	type LiveScte35Params,
	type LiveToVodErrorCode,
	type LiveToVodFamily,
	type LiveToVodFamilyRecord,
	type LiveToVodParams,
	type LiveToVodProviderIdentity,
	type LiveToVodRecord,
	liveAutoShutdownFingerprint,
	liveAutoShutdownUpdateParamsSchema,
	liveAutoShutdownUpdateReceiptSchema,
	liveChannelJobSchema,
	liveChannelPlanSchema,
	liveFeederActionParamsSchema,
	liveFeederCommitParamsSchema,
	liveFeederStageParamsSchema,
	liveInsertContentParamsSchema,
	liveRegisterSlateParamsSchema,
	liveResetTimeshiftParamsSchema,
	liveRtmpIngestParamsSchema,
	liveScte35ParamsSchema,
	liveStartupCancelParamsSchema,
	liveToVodFamilyPlan,
	liveToVodFamilySupport,
	liveToVodManifestsOf,
	liveToVodParamsSchema,
	MIN_SLATE_FIRE_SECONDS,
	normalizeLiveToVodRecord,
	PROVIDER_UNKNOWN_GRACE_MS,
	type ProviderLifecycle,
	priorRollManifestFiles,
	providerUnknownPastGrace,
	readLiveAutoShutdownUpdate,
	redactSecrets,
	resolveLiveToVodTarget,
	type SlateSource,
	type StepLogEntry,
	selectRtmpIngestPoints,
	slateConversionDestination,
	stepLogSchema,
} from "@bitovp/core";
import type {
	AppPrismaClient,
	LiveEffectClaimHandle,
	Prisma,
} from "@bitovp/db";
import {
	appendLiveChannelStepLogEntry,
	appendLiveEffectStepLogEntry,
	assertLiveEffectCurrent,
	beginLiveEffect,
	bindLiveEffectTarget,
	LiveToVodFenceError,
	markLiveEffectAcked,
	markLiveEffectAmbiguous,
	markLiveEffectFailed,
	persistLiveToVodAttempt,
	resolveLiveEffectsAfterConfirmedStop,
} from "@bitovp/db";
import {
	heartbeatIngestMedia,
	type MediaAttributes,
	parseMediaAttributes,
} from "../feeder/command";
import {
	HEARTBEAT_SWEEP_CONCURRENCY,
	HEARTBEAT_SWEEP_PER_CHANNEL_TIMEOUT_MS,
} from "../heartbeat-cadence";
import type { BoundedObjectProbe } from "../inspect/processor";
import {
	heartbeatSampleRef,
	logHeartbeatStateChanges,
} from "../live/heartbeat-state-log";
import {
	createProviderLifecycleReconciler,
	type RunLifecycleRow,
} from "../live/provider-lifecycle";
import { PROVISION_LEASE_MS } from "../live/provision-lease";
import type { EmitProductEvent } from "../notify/emitter";
import {
	finishResetOwner,
	type ResetEncodingJournal,
	type ResetOwnerState,
} from "../reset/lost-encodings";
import {
	recordScheduleOutcomeBestEffort,
	transitionScheduleToStale,
} from "../scheduler/schedule-outcome";
import type { SlatePreparer } from "../slate/prepare";
import { executeStep, type ResolvedCredential } from "./executor";
import { VerificationProviderIdPersistenceError } from "./ops/encoding";
import { CancelRequested, LiveEncodingCanceled } from "./ops/exec-shared";
import {
	isBitmovinError,
	ManifestCreateNotAuthorizedError,
	ManifestIdentityAmbiguousError,
	ManifestIdentityLookupError,
	ManifestIdentityScanIncompleteError,
} from "./ops/shared";
import { pollSleepFor } from "./poll-sleep";
import {
	createHeartbeatDoor,
	createRunMirror,
	type HeartbeatPollToken,
} from "./run-mirror";
import type {
	EncodingMessage,
	LiveHeartbeatSample,
	SdkOps,
	TaskStatusResult,
} from "./sdk-ops";
import {
	providerReasonClause,
	selectProviderFailureReason,
} from "./slate-failure-reason";
import {
	preflightUnverifiedReason,
	registerSlateContent,
} from "./slate-register";
import {
	type CreateStamp,
	VerificationProviderIdDefinitelyNotPersistedError,
	VerificationProviderOwnershipLostError,
	verificationCreateIdentity,
} from "./stamping-fetch";
import type { StartRetryControl } from "./start-1004-retry";
import {
	recordFailedStartupSample,
	recordRunningStartupSample,
} from "./startup-sample";
import {
	CHANNEL_TIMED_OUT,
	createSingleFlightSweep,
	type HeartbeatSweepResult,
	runChannelsBounded,
} from "./sweep-runner";

/**
 * Live channel lifecycle worker (P3-PR2). Provisioning mirrors the VOD
 * orchestrator: replay the persisted step log (DONE steps skipped, state
 * persisted before/after each step, snapshots redacted — C7) — but the
 * terminal step is AWAIT_LIVE_RUNNING and RUNNING is the STEADY state the
 * channel then holds. There is exactly ONE encoding per channel, so there
 * is deliberately no stop-siblings handling here.
 *
 * STOP/restart/reset-timeshift/SCTE-35 are NOT compiled steps (COVERAGE
 * P3 batch 1 contract): they are direct API actions on the persisted
 * channel, dispatched through the same queue with an `action` field.
 *
 * Status machine: CREATED → PROVISIONING → RUNNING → STOPPING → STOPPED;
 * ERROR from any provisioning/action failure; restart: RUNNING|STOPPED|
 * ERROR → PROVISIONING → RUNNING.
 */

export type LiveChannelDeps = {
	journalResetEncoding?: ResetEncodingJournal;
	acknowledgeResetEntity?: (
		entityKey: string,
		ownerToken: string | null,
	) => Promise<void>;
	/**
	 * How often the provisioning lease is renewed DURING a long SDK call
	 * the poll seam renews between polls, but a create/start
	 * call that outlives the lease window had nothing renewing it. Test seam;
	 * defaults to a third of PROVISION_LEASE_MS.
	 */
	leaseRenewalIntervalMs?: number;
	/** Product-event emit ; never throws. */
	emitEvent?: EmitProductEvent;
	/** Webhook-driven early wake ; optional. */
	wakeSleep?(ms: number, interestedIds: () => string[]): Promise<void>;
	prisma: AppPrismaClient;
	revealBitmovinAccount(accountId: string): Promise<{
		apiKey: string;
		tenantOrgId: string | null;
	}>;
	resolveCredential(credentialId: string): Promise<ResolvedCredential>;
	makeSdk(args: {
		apiKey: string;
		tenantOrgId: string | null;
		bitmovinAccountId: string;
		/**
		 * The create stamp is typed here so index.ts's shared
		 * implementation cannot be assignability-masked into dropping it again
		 * (contravariance made tsc silent the first time — review of PR #163,
		 * C1). The PROVISION path passes one (job = the CHANNEL id; step
		 * identity is `step#attempt` so a stale-RTMP rebuild can never adopt
		 * the abandoned generation's resource). The actions/heartbeat call
		 * site stays stampless: it issues runtime actions and the LEGACY
		 * default-manifest flow, whose adoption keys on encodingId (S6),
		 * not on a stamp.
		 */
		stamp?: CreateStamp;
		monitoringSignal?: AbortSignal;
		startControl?: StartRetryControl;
	}): SdkOps;
	sleep(ms: number): Promise<void>;
	pollIntervalMs: number;
	pollTimeoutMs: number;
	now(): string;
	/**
	 * Producer for the feeder-manager queue (P3-PR3 lifecycle coupling):
	 * stopChannel enqueues a stop for every attached active feeder session.
	 */
	enqueueFeederJob(job: FeederJob): Promise<void>;
	/**
	 * Heartbeat-history retention window. Each sweep appends one LiveHeartbeat
	 * row per RUNNING channel and prunes that channel's rows older than this
	 * in capped batches; defaults to HEARTBEAT_RETENTION_MS (7 days ≈ 20k
	 * rows/channel/week @30s, bounded).
	 */
	heartbeatRetentionMs?: number;
	/**
	 *  — bounded ffprobe over one customer object
	 * (`createBoundedObjectProbe`). Slate registration uses it to check a clip
	 * against what the encoder is ingesting before creating anything at the
	 * provider. Optional: absent = the check stands down, which is what every
	 * test that is not about the check wants.
	 */
	probeStorageObject?: BoundedObjectProbe;
	/**
	 * the slate preparer (`createSlatePreparer`) — transcodes a
	 * scheduled slate to match the ingest before it is registered. Optional
	 * for the same reason as `probeStorageObject`.
	 */
	prepareSlate?: SlatePreparer;
};

/**
 * Default heartbeat-history retention: 7 days. At the 30s sweep cadence that
 * is ~20k rows per channel per week at ~1.1 KB of raw JSON each (measured:
 * 191 rows / 1,145 B average on 2026-09-02) — about 23 MB per always-on
 * channel, bounded. The 6h window this replaced could not answer the
 * question a run page exists for: what the encoder reported during
 * yesterday's broadcast. A run older than the window keeps its
 * `heartbeatSummary` (createRunHeartbeatSummarizer) instead of its rows.
 */
export const HEARTBEAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Rows deleted per prune call. The prune runs once per polled channel per
 * sweep and deletes THAT channel's rows past the cutoff through the
 * (liveChannelId, at) index — capped so a channel returning after a long
 * absence (its backlog is a whole window of rows) drains over a few sweeps
 * instead of one long DELETE holding the tick.
 */
export const HEARTBEAT_PRUNE_BATCH = 500;

export type LiveChannelResult = {
	acknowledged: true;
	liveChannelId: string;
	action: LiveChannelAction;
	status: string;
};

/**
 * The live-to-VOD record is core's `LiveToVodRecord` : per-family
 * status + manifest id/url/error, with the overall status DERIVED from the
 * families. Here it is held with `families` present — the worker always
 * writes the new shape.
 */
type LiveToVodWorkRecord = LiveToVodRecord & {
	attemptId: string;
	revision: number;
	liveChannelRunId: string;
	outputKey: string;
	families: LiveToVodFamilyRecord[];
};

type LiveToVodAttemptCoordinates = {
	attemptId: string;
	liveChannelRunId: string;
	encodingId: string;
};

type LiveToVodErrorFamily = Extract<LiveToVodFamilyRecord, { status: "ERROR" }>;

class LiveToVodStaleAttemptError extends Error {
	constructor() {
		super("live-to-VOD attempt lost its exact channel/run fence");
		this.name = "LiveToVodStaleAttemptError";
	}
}

function familyManifestId(family: LiveToVodFamilyRecord): string | undefined {
	return "manifestId" in family ? family.manifestId : undefined;
}

function familyProviderIdentity(
	family: LiveToVodFamilyRecord,
): LiveToVodProviderIdentity | undefined {
	return "providerIdentity" in family ? family.providerIdentity : undefined;
}

function liveToVodFamilyError(
	family: LiveToVodFamilyRecord,
	errorCode: LiveToVodErrorCode,
	technicalDetail: string,
	overrides: Partial<LiveToVodErrorFamily> = {},
): LiveToVodErrorFamily {
	const providerIdentity = familyProviderIdentity(family);
	const createIntent =
		"createIntent" in family ? family.createIntent : undefined;
	const manifestId = familyManifestId(family);
	const cleanup = "cleanup" in family ? family.cleanup : undefined;
	const url = "url" in family ? family.url : undefined;
	return {
		type: family.type,
		status: "ERROR",
		errorCode,
		technicalDetail,
		...(providerIdentity ? { providerIdentity } : {}),
		...(createIntent ? { createIntent } : {}),
		...(manifestId ? { manifestId } : {}),
		...(url ? { url } : {}),
		...(cleanup ? { cleanup } : {}),
		...overrides,
	};
}

/**
 * Polls one DEFAULT manifest's generation to FINISHED. Deliberately a local
 * helper rather than the executor's awaitTask: live-to-VOD is not a compiled
 * step (no CompiledOperation, no step log), and its terminal handling is the
 * simpler VOD-style one (FINISHED wins; ERROR/CANCELED fail).
 */
async function awaitManifest(
	family: LiveToVodFamily,
	manifestId: string,
	sdk: SdkOps,
	poll: {
		intervalMs: number;
		timeoutMs: number;
		sleep(ms: number): Promise<void>;
	},
	label: string,
): Promise<void> {
	const deadline = Date.now() + poll.timeoutMs;
	for (;;) {
		const task =
			family === "HLS"
				? await sdk.getHlsManifestStatus(manifestId)
				: await sdk.getDashManifestStatus(manifestId);
		if (task.status === "FINISHED") {
			return;
		}
		if (
			task.status === "ERROR" ||
			task.status === "CANCELED" ||
			task.status === "TRANSFER_ERROR"
		) {
			const detail = task.messages?.length
				? `: ${task.messages.join("; ")}`
				: "";
			throw new Error(`${label} ended ${task.status}${detail}`);
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`${label} timed out after ${Math.round(poll.timeoutMs / 1000)}s (last status ${task.status})`,
			);
		}
		await poll.sleep(poll.intervalMs);
	}
}

/**
 *  — what a SAVED manifest id reads back as at the provider, on a
 * retry after a start/poll failure or a lost response. The decision this
 * feeds is made BEFORE any new create: FINISHED is adopted as-is, CREATED is
 * started, RUNNING is polled, FAILED is deleted (terminal cleanup) and then
 * replaced, MISSING (404) is replaced. Any other readback failure propagates —
 * the family goes ERROR with its id retained for the next retry.
 */
type ManifestReadback =
	| { kind: "FINISHED" }
	| { kind: "CREATED" }
	| { kind: "RUNNING"; status: string }
	| { kind: "FAILED"; detail: string }
	| { kind: "MISSING" };

async function readbackManifest(
	family: LiveToVodFamily,
	manifestId: string,
	sdk: SdkOps,
): Promise<ManifestReadback> {
	let task: TaskStatusResult;
	try {
		task =
			family === "HLS"
				? await sdk.getHlsManifestStatus(manifestId)
				: await sdk.getDashManifestStatus(manifestId);
	} catch (err) {
		if (isBitmovinError(err) && err.httpStatusCode === 404) {
			return { kind: "MISSING" };
		}
		throw err;
	}
	switch (task.status) {
		case "FINISHED":
			return { kind: "FINISHED" };
		case "CREATED":
			return { kind: "CREATED" };
		case "ERROR":
		case "CANCELED":
		case "TRANSFER_ERROR":
			return {
				kind: "FAILED",
				detail: task.messages?.length
					? `${task.status}: ${task.messages.join("; ")}`
					: task.status,
			};
		default:
			return { kind: "RUNNING", status: task.status };
	}
}

/**
 *  — terminal cleanup of a default manifest this roll can no longer
 * use (for example, generation failed or the destination changed). The exact
 * provider id and DELETE_PENDING intent are persisted before this helper runs;
 * a rejected delete or non-404 readback leaves that identity unresolved and
 * blocks replacement. Returns true only after readback confirms it is gone.
 */
async function discardManifest(
	family: LiveToVodFamily,
	manifestId: string,
	sdk: SdkOps,
	why: string,
): Promise<boolean> {
	try {
		if (family === "HLS") {
			await sdk.deleteHlsManifest(manifestId);
		} else {
			await sdk.deleteDashManifest(manifestId);
		}
		const readback = await readbackManifest(family, manifestId, sdk);
		if (readback.kind === "MISSING") {
			return true;
		}
		console.error(
			`[live-channel] live-to-VOD delete of ${family} manifest ${manifestId} was not confirmed (${String(redactSecrets(why))}); readback is ${readback.kind}`,
		);
		return false;
	} catch (err) {
		const safeWhy = String(redactSecrets(why));
		const safeError = String(
			redactSecrets(err instanceof Error ? err.message : String(err)),
		);
		console.error(
			`[live-channel] live-to-VOD could not delete ${family} manifest ${manifestId} (${safeWhy}): ${safeError} — it is an ORPHAN at the provider until a retry deletes it`,
		);
		return false;
	}
}

/**
 * A live-to-VOD record write that FAILED (the DB, not the provider). Distinct
 * from a family failure on purpose: a family failure is recorded and the loop
 * moves on; a persist failure means nothing more can be recorded, so the roll
 * stops where it is. The create identity was persisted before the provider
 * POST, so a response that arrived after this failed write stays attributable
 * and a retry may only reconcile it; it is never deleted without a durable id.
 */
class LiveToVodPersistError extends Error {
	constructor(cause: unknown) {
		super(
			`live-to-VOD record could not be persisted: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
			{ cause },
		);
		this.name = "LiveToVodPersistError";
	}
}

/**
 * How far back a provider-side scheduled insertion still counts as "this
 * attempt's". BullMQ gives the insert 5 attempts with exponential backoff from
 * 5s (~75s worst case); five minutes is four times that.
 *
 * It was 15 minutes, justified by "nowhere near a separately-scheduled airing".
 * That was REFUTED (review-299): `liveScheduleArmSchema` REQUIRES a SLATE_IN
 * row to name existing READY content, and `POST /live-channels/[id]/schedules`
 * enforces only `fireAt > now` — no uniqueness, spacing or overlap check
 * between rows. So two manually-armed slate insertion naming one slate nine minutes apart
 * are legal, and ad-break/blackout covering recurs on exactly that cadence. The
 * width is no longer the thing keeping those apart — `explainedByPriorAiring`
 * below is — but a shorter window still shrinks what the fallback can reach.
 *
 * NOT a total bound on redelivery (review-299 S2): a STALL redelivery —
 * stalledInterval 30s × maxStalledCount, plus however long a worker takes to
 * come back — can land past this window, and a double insert is then possible
 * again. That is the original bug's direction and it is bounded, which is the
 * side to err on; widening the window to cover it would trade a bounded
 * double-cover for an unbounded risk of suppressing a later airing.
 */
const RETRY_WINDOW_MS = 5 * 60 * 1000;

/**
 *  — how long the slate action waits for the PROVIDER to say what
 * it did with the insertion, and how often it asks.
 *
 * Attempts × interval rather than a wall-clock deadline, matching the stop
 * path's poll two hundred lines up: `deps.now` is a fixed string in the
 * harness, so a clock-derived deadline is unreachable in a test and a bounded
 * attempt count is not.
 *
 * 6 × 5s = 30s. The bound is a queue-slot budget, not a guess at the
 * provider's latency: this job holds a liveChannel slot while it waits, and a
 * slate insertion that has not been armed within half a minute is news whether or not
 * it eventually arms. `scheduleInsertableContent` is already POSTed by then —
 * the wait only decides what we RECORD, never whether the slate fires.
 */
const SLATE_CONFIRM_ATTEMPTS = 6;
const SLATE_CONFIRM_INTERVAL_MS = 5_000;

/**
 * Scheduled-insertion statuses that END the confirmation poll, and what each
 * one means for the row.
 *
 * The SDK enum (`ScheduledInsertableContentStatus`, verified against
 * @bitmovin/api-sdk 1.278.0) is CREATED / SCHEDULED / TO_BE_DESCHEDULED /
 * DESCHEDULED / ERROR. There is NO "played" or "finished" member, so
 * "delivered" cannot mean "we saw it play" — the strongest thing the API can
 * tell us is that the encoder took the entry out of CREATED without erroring,
 * which is what SCHEDULED means and what the two deschedule states imply
 * happened earlier.
 *
 * CREATED is deliberately absent: it is the pre-acceptance state the POST
 * itself produces, so treating it as confirmation would re-create exactly the
 * bug this file is fixing — a verdict read off our own request.
 */
const SLATE_CONFIRMED_STATUSES: readonly string[] = [
	"SCHEDULED",
	"TO_BE_DESCHEDULED",
	"DESCHEDULED",
];

/**
 * Encoding statuses that END a stop poll — an OBSERVED terminal state, and the
 * whole basis for writing `STOPPED` with a null error. Deliberately does not
 * include the "unknown" sentinel the poll starts from: see the stop path.
 */
const STOP_TERMINAL_STATUSES: readonly string[] = [
	"FINISHED",
	"ERROR",
	"CANCELED",
	"TRANSFER_ERROR",
];

/**
 *  (§14.5 item 6): after an accepted Restart the channel stays
 * PROVISIONING until the EXACT encoding reads back RUNNING. Attempts ×
 * interval like the stop poll above (the harness clock is a fixed string, so
 * a wall-clock deadline is unreachable in a test): 12 × 5s = 60s, a
 * queue-slot budget — a restart that has not reported RUNNING in a minute is
 * news whether or not it eventually does, and Start is the honest retry.
 */
const RESTART_READBACK_ATTEMPTS = 12;
const RESTART_READBACK_INTERVAL_MS = 5_000;

/** What one channel's sweep tick observed and did . */
type SweepTickResult = {
	lifecycle: ProviderLifecycle | "UNOBSERVED";
	/** The provider readback was TERMINAL and THIS tick reconciled it. */
	terminal: boolean;
	pollFailed: boolean;
	/** The tick's token no longer matched — sample/history/alert dropped. */
	discarded: boolean;
	/** UNKNOWN only: when the window opened. */
	unknownSince: Date | null;
};

/** The four cumulative SDK packet counters we delta per poll. */
const HEARTBEAT_COUNTER_KEYS = [
	"droppedPacketsVideo",
	"droppedPacketsAudio",
	"corruptPacketsVideo",
	"corruptPacketsAudio",
] as const;

export type HeartbeatCounterDeltas = Partial<
	Record<(typeof HEARTBEAT_COUNTER_KEYS)[number], number>
>;

export type PersistedHeartbeat = {
	/** Poll request-start time (ours), distinct from the sample's timestamp. */
	at: string;
	raw: LiveHeartbeatSample;
	deltas: HeartbeatCounterDeltas;
};

/**
 * The SDK counters are CUMULATIVE since encoding start (research note §5)
 * — rate displays need per-poll deltas. First poll (no previous sample)
 * yields ZERO deltas: there is no observed interval yet, and reporting
 * the lifetime total as "this interval" would fake a packet-loss spike
 * (the totals stay readable in `raw`). Counter resets (current <
 * previous ⇒ the encoder restarted) count from the restart value.
 */
export function computeHeartbeatDeltas(
	previous: LiveHeartbeatSample | undefined,
	current: LiveHeartbeatSample,
): HeartbeatCounterDeltas {
	const deltas: HeartbeatCounterDeltas = {};
	for (const key of HEARTBEAT_COUNTER_KEYS) {
		const cur = current.ingest?.[key];
		if (typeof cur !== "number") {
			continue;
		}
		const prev = previous?.ingest?.[key];
		if (typeof prev !== "number") {
			deltas[key] = 0;
			continue;
		}
		deltas[key] = cur >= prev ? cur - prev : cur;
	}
	return deltas;
}

class ChannelStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChannelStateError";
	}
}

/**
 * the provider's lifecycle refused an action — a TERMINAL encoding
 * (already reconciled onto run + channel by the reconciler) or an UNKNOWN
 * readback (the channel was marked ERROR with a retryable message before the
 * throw). A SENTINEL so the catch arms that would otherwise `markError` again
 * — overwriting the terminal message and emitting a second CHANNEL_ERROR —
 * can rethrow it untouched.
 */
class ProviderLifecycleRefusal extends ChannelStateError {
	constructor(message: string) {
		super(message);
		this.name = "ProviderLifecycleRefusal";
	}
}

class LiveEffectFenceLostError extends ChannelStateError {
	constructor(message: string) {
		super(message);
		this.name = "LiveEffectFenceLostError";
	}
}

type LiveEffectFence = {
	claim: LiveEffectClaimHandle;
	readonly crossedSendBoundary: boolean;
	assertCurrent(label: string): Promise<void>;
	beforeSend(label: string): Promise<void>;
};

function liveEffectFence(
	prisma: AppPrismaClient,
	claim: LiveEffectClaimHandle,
	now: () => string,
): LiveEffectFence {
	let crossedSendBoundary = false;
	return {
		claim,
		get crossedSendBoundary() {
			return crossedSendBoundary;
		},
		async assertCurrent(label: string) {
			if (!(await assertLiveEffectCurrent(prisma, claim, new Date(now())))) {
				const reason = `${label} lost its exact run/generation fence before send`;
				if (crossedSendBoundary) {
					// A compound effect (notably STOP over every known encoding) may
					// cross one provider boundary before losing the fence at the next.
					// The earlier call may have landed, so FAILED would incorrectly make
					// the effect retryable. Once crossed, uncertainty is irreversible.
					await markLiveEffectAmbiguous(prisma, claim, reason);
				} else {
					await markLiveEffectFailed(prisma, claim, reason);
				}
				throw new LiveEffectFenceLostError(
					`${label} refused: the exact run/generation fence is no longer current`,
				);
			}
		},
		async beforeSend(label: string) {
			await this.assertCurrent(label);
			// Set immediately before invoking the provider/process API. From here
			// on, a thrown response is ambiguous and must never be blindly retried.
			crossedSendBoundary = true;
		},
	};
}

type LiveChannelRow = NonNullable<
	Awaited<ReturnType<AppPrismaClient["liveChannel"]["findUnique"]>>
>;

/**
 * channel product events. Loads the name lazily (terminal
 * transitions only — never on the poll path); best-effort by the emitter's
 * contract, so callers never guard it.
 */
async function emitChannelEvent(
	deps: LiveChannelDeps,
	kind: "CHANNEL_RUNNING" | "CHANNEL_ERROR" | "CHANNEL_STOPPED",
	liveChannelId: string,
	error?: string,
): Promise<void> {
	if (!deps.emitEvent) {
		return;
	}
	const row = await deps.prisma.liveChannel
		.findUnique({ where: { id: liveChannelId }, select: { name: true } })
		.catch(() => null);
	const name = row?.name ?? liveChannelId;
	const path = `/live/${liveChannelId}`;
	if (kind === "CHANNEL_ERROR") {
		await deps.emitEvent({
			kind,
			liveChannelId,
			name,
			error: error ?? "channel error",
			path,
		});
		return;
	}
	await deps.emitEvent({ kind, liveChannelId, name, path });
}

/**
 * What the channel's CURRENT run is ingesting , for readers
 * outside the feeder — today, slate registration.
 *
 * The same two instruments the feeder preflight uses, in the same order:
 * the reference a feeder recorded (ffprobe-derived, so it carries profile,
 * level and pixel format), then the encoder's own heartbeat (narrower, but
 * the ONLY reference for an external contribution, which is most of the
 * slate product). Run-first; the channel column is read only when there is
 * no run row at all, because a run's silence means "no proof for THIS run"
 * and never the previous airing's final sample (review-243 R1).
 *
 * Never throws: a reference that cannot be read is "no reference", and every
 * caller treats that as "no opinion".
 */
export async function loadChannelIngestMedia(
	prisma: AppPrismaClient,
	liveChannelId: string,
	channelHeartbeat: unknown,
): Promise<MediaAttributes | null> {
	const run = await prisma.liveChannelRun
		.findFirst({
			where: { liveChannelId },
			orderBy: { seq: "desc" },
			select: { ingestMedia: true, lastHeartbeat: true },
		})
		.catch(() => null);
	if (run) {
		return (
			parseMediaAttributes(run.ingestMedia) ??
			heartbeatIngestMedia(run.lastHeartbeat)
		);
	}
	return heartbeatIngestMedia(channelHeartbeat);
}

export function createLiveChannelActions(deps: LiveChannelDeps) {
	const runs = createRunMirror(deps.prisma);
	const heartbeatDoor = createHeartbeatDoor(deps.prisma);
	/**
	 * the provider-lifecycle reconciler. Every entry that can put a
	 * channel into RUNNING or act on its encoder — Start/revive, Restart, the
	 * heartbeat sweep, provision finalize — asks it first; the effect gates
	 * (slate, SCTE-35, timeshift, feeder start/commit) read its persisted view.
	 */
	const providerLifecycle = createProviderLifecycleReconciler({
		prisma: deps.prisma,
		now: deps.now,
		enqueueFeederJob: deps.enqueueFeederJob,
		emitChannel: (liveChannelId, error) =>
			emitChannelEvent(
				deps,
				error === null ? "CHANNEL_STOPPED" : "CHANNEL_ERROR",
				liveChannelId,
				error ?? undefined,
			),
	});
	/**
	 *  item 4: a NEW provider/ingest effect is refused while the
	 * provider cannot be seen (UNKNOWN) or has ended the encoding (TERMINAL).
	 * The persisted view only — the sweep keeps it fresh for RUNNING channels
	 * — so the gate costs one row read and no provider round-trip. Stop is
	 * deliberately NOT gated: a channel we cannot see must stay stoppable.
	 */
	type ProviderEffectIdentity = {
		runId: string | null;
		encodingId: string | null;
	};
	async function assertProviderEffectAllowed(
		liveChannelId: string,
		effect: string,
		expected?: ProviderEffectIdentity,
	): Promise<ProviderEffectIdentity> {
		const identity =
			expected ??
			(await (async () => {
				const [run, channel] = await Promise.all([
					providerLifecycle.loadCurrentRun(liveChannelId),
					deps.prisma.liveChannel.findUnique({
						where: { id: liveChannelId },
						select: { bitmovinEncodingId: true },
					}),
				]);
				return {
					runId: run?.id ?? null,
					encodingId: channel?.bitmovinEncodingId ?? null,
				};
			})());
		const refusal = await providerLifecycle.effectRefusal(
			liveChannelId,
			identity,
		);
		if (refusal) {
			throw new ChannelStateError(`${effect} refused: ${refusal}`);
		}
		return identity;
	}
	async function loadChannel(liveChannelId: string): Promise<LiveChannelRow> {
		const row = await deps.prisma.liveChannel.findUnique({
			where: { id: liveChannelId },
		});
		if (!row) {
			throw new ChannelStateError(`Live channel ${liveChannelId} not found`);
		}
		return row;
	}

	async function sdkFor(
		row: LiveChannelRow,
		monitoringSignal?: AbortSignal,
	): Promise<SdkOps> {
		const accountId =
			row.bitmovinAccountId ??
			(row.plan as { bitmovin?: { accountId?: string } } | null)?.bitmovin
				?.accountId;
		if (!accountId) {
			throw new ChannelStateError("Channel carries no Bitmovin account id");
		}
		const account = await deps.revealBitmovinAccount(accountId);
		monitoringSignal?.throwIfAborted();
		return deps.makeSdk({
			apiKey: account.apiKey,
			tenantOrgId: account.tenantOrgId,
			bitmovinAccountId: accountId,
			...(monitoringSignal ? { monitoringSignal } : {}),
		});
	}

	function encodingIdOf(row: LiveChannelRow): string {
		if (!row.bitmovinEncodingId) {
			throw new ChannelStateError(
				"Channel has no Bitmovin encoding yet — provision it first",
			);
		}
		return row.bitmovinEncodingId;
	}

	/**
	 * EVERY encoding this channel knows about — the column AND the step log.
	 *
	 * These can disagree, and when they do the consequence is a live encoding that bills forever.
	 * Observed: four channels whose rows all said STOPPED while Bitmovin had four DIFFERENT
	 * encodings RUNNING, the oldest for 7h19m. For `live-rtmp-simple` the column held
	 * `63c65f0d…` and the step log's `CREATE_ENCODING` held `f0c0e872…` — and `f0c0e872…` was the
	 * one running. Stop read the column, stopped something already terminal, and reported success.
	 *
	 * The comment at the restart path even states the assumption out loud: "stop/restart require
	 * RUNNING and read the column, not the step log". That is only safe while the two agree, and
	 * nothing enforced that they do.
	 *
	 * So teardown now targets the UNION. Stopping an already-terminal encoding is a no-op; failing
	 * to stop a running one is a bill, and the two errors are not remotely symmetrical.
	 */
	function allEncodingIdsOf(row: LiveChannelRow): string[] {
		const ids = new Set<string>();
		if (row.bitmovinEncodingId) {
			ids.add(row.bitmovinEncodingId);
		}
		try {
			for (const entry of stepLogSchema.parse(row.stepLog)) {
				if (entry.kind === "CREATE_ENCODING" && entry.resourceId) {
					ids.add(entry.resourceId);
				}
			}
		} catch {
			// An unparseable log must not stop us stopping what the column names — losing the
			// column's id here would reintroduce the exact leak this function exists to close.
		}
		return [...ids];
	}

	const emitChannel = (
		kind: "CHANNEL_RUNNING" | "CHANNEL_ERROR" | "CHANNEL_STOPPED",
		liveChannelId: string,
		error?: string,
	) => emitChannelEvent(deps, kind, liveChannelId, error);

	async function markError(liveChannelId: string, message: string) {
		await deps.prisma.liveChannel.update({
			where: { id: liveChannelId },
			data: { status: "ERROR", error: redactSecrets(message) },
		});
		// Dual-write : the run carries its own terminal state.
		await runs.mirror(liveChannelId, {
			status: "ERROR",
			error: redactSecrets(message),
		});
		await emitChannel("CHANNEL_ERROR", liveChannelId, redactSecrets(message));
	}

	/**
	 * Append one heartbeat sample to the time-series table and prune rows
	 * older than the retention window. Best-effort: a failure here is logged
	 * and swallowed so the caller's lastHeartbeat update and the surrounding
	 * sweep are never affected (the current-state panel keeps working even if
	 * history breaks). `sample` is ALREADY redacted by the caller.
	 */
	async function appendHeartbeatHistory(
		liveChannelId: string,
		encodingId: string,
		sample: PersistedHeartbeat,
	): Promise<void> {
		try {
			//  PR2: history rows belong to the RUN that produced
			// them — matched by the ENCODING the sample was fetched for
			// (review-242 A3), so a stop racing the poll cannot stamp a new
			// run with the old run's sample. Null only when no run carries
			// the id (pre-PR3 paths).
			const run = await deps.prisma.liveChannelRun.findFirst({
				where: { liveChannelId, bitmovinEncodingId: encodingId },
				select: { id: true },
			});
			await deps.prisma.liveHeartbeat.create({
				data: {
					liveChannelId,
					...(run ? { liveChannelRunId: run.id } : {}),
					at: new Date(sample.at),
					raw: sample.raw as unknown as Prisma.InputJsonValue,
					deltas: sample.deltas as unknown as Prisma.InputJsonValue,
				},
			});
		} catch (err) {
			console.error(
				`[live-channel] heartbeat history write for ${liveChannelId} failed:`,
				err instanceof Error ? err.message : err,
			);
		}
		await pruneHeartbeatHistory(liveChannelId, sample.at);
	}

	/**
	 * Prune THIS channel's rows older than the retention window, at most
	 * HEARTBEAT_PRUNE_BATCH per call: the candidates are read by id through
	 * the (liveChannelId, at) index, oldest first, and deleted by id — a
	 * bounded statement whatever the backlog. Best-effort: a failure here is
	 * logged and never reaches the poll that called it. Every run of the
	 * channel is covered (an ended run's rows age out under the next run's
	 * polls); the summarizer has already captured what they said.
	 */
	async function pruneHeartbeatHistory(
		liveChannelId: string,
		at: string,
	): Promise<void> {
		const retentionMs = deps.heartbeatRetentionMs ?? HEARTBEAT_RETENTION_MS;
		try {
			const stale = await deps.prisma.liveHeartbeat.findMany({
				where: {
					liveChannelId,
					at: { lt: new Date(Date.parse(at) - retentionMs) },
				},
				orderBy: { at: "asc" },
				take: HEARTBEAT_PRUNE_BATCH,
				select: { id: true },
			});
			if (stale.length === 0) {
				return;
			}
			await deps.prisma.liveHeartbeat.deleteMany({
				where: { id: { in: stale.map((row) => row.id) } },
			});
		} catch (err) {
			console.error(
				`[live-channel] heartbeat history prune for ${liveChannelId} failed:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	// review-226 suggestion: a closure-local self-reference — `this` was
	// correct but silently breaks the day someone destructures an action.
	const self = {
		/** RUNNING|STOPPING|ERROR or STOPPED+error → stop API → STOPPED. */
		async stopChannel(
			liveChannelId: string,
			effect?: LiveEffectFence,
		): Promise<void> {
			const row = await loadChannel(liveChannelId);
			// The guard IS the point: throws ChannelStateError for a channel that
			// was never provisioned. The binding was unused; the call must stay
			// ( sweep — deleting the "unused variable" would have
			// let stop flip an unprovisioned channel to STOPPING).
			encodingIdOf(row);
			const { count } = await deps.prisma.liveChannel.updateMany({
				where: {
					id: liveChannelId,
					// beginLiveEffect atomically puts a durable manual STOP into
					// STOPPING at this exact generation. Recheck that ownership before
					// feeder/provider effects; a later winner must make this delivery
					// fail and retry, never send under the stale prepared claim.
					...(effect
						? { liveEffectFenceVersion: effect.claim.generation }
						: {}),
					OR: [
						{ status: { in: ["RUNNING", "STOPPING", "ERROR"] } },
						// A queue-first manual stop can reach the worker before the
						// route's post-add STOPPING projection. Preserve the existing
						// retry remedy, but only for a stop that carries positive
						// evidence it never confirmed; a clean STOPPED row stays closed.
						{ status: "STOPPED", error: { not: null } },
					],
				},
				data: { status: "STOPPING" },
			});
			if (count === 0) {
				throw new ChannelStateError(
					effect
						? `Channel stop lost its prepared generation or cannot be stopped from status ${row.status}`
						: `Channel cannot be stopped from status ${row.status}`,
				);
			}
			await runs.mirror(liveChannelId, { status: "STOPPING" });
			// Feeder coupling contract (P3-PR3): a channel stop ALSO stops
			// every attached active feeder session — a feeder must never
			// outlive its channel's stop INTENT (it would keep pushing at a
			// dead ingest until its restart backoff exhausts). Enqueued right
			// after the STOPPING claim, before the API stop, so the intent
			// propagates even when the stop call below fails. Best-effort per
			// session: an enqueue failure logs and never blocks the channel
			// stop (the supervisor's own backoff converges an orphaned feed
			// to ERROR). jobId `<sessionId>:stop` collapses this with a
			// concurrent route-issued stop; a SETTLED job under that id is
			// removed before the add (`enqueueFeederJob`), so a re-stop of a
			// row that is terminal-but-still-holding-a-pid is deliverable —
			// the claim that used to sit here, "sessions are terminal after
			// one stop", stopped being true with audit 2026-08-29 CRITICAL-2.
			const feeders = await deps.prisma.feederSession.findMany({
				where: {
					liveChannelId,
					OR: [
						// LC-02: terminal held claims are just as important as
						// terminal pid pointers. Use core's complete occupancy
						// population so a channel stop reaches either orphan shape.
						feederOccupancyWhere(),
						// Every active row, staged holds INCLUDED — a channel stop
						// must stop a switch that is holding for it too (core's
						// list, so the three status copies collapse to one).
						{ status: { in: [...FEEDER_ACTIVE_STATUSES] } },
					],
				},
				select: { id: true },
			});
			// Row 268: a feeder stop we could not
			// enqueue is NOT swallowed. An enqueue that never lands leaves the
			// feeder's `-stream_loop -1` ffmpeg pushing into a now-dead ingest
			// with no stop intent to converge it, and logging-and-continuing
			// reported the channel torn down while that push kept running. The
			// failures are collected and folded into the channel's stop `error`
			// below — the same durable field the provider-stop confirmation
			// writes — so the operator sees it and the verify cleanup seal reads
			// it (an `error != null` channel is not a confirmed-clean teardown).
			// Best-effort per session still: it never BLOCKS the channel stop
			// (the encodings must still be stopped), it surfaces as evidence.
			const feederStopEnqueueFailures: string[] = [];
			for (const feeder of feeders) {
				try {
					await deps.enqueueFeederJob({
						feederSessionId: feeder.id,
						action: "stop",
					});
				} catch (enqueueErr) {
					const message =
						enqueueErr instanceof Error
							? enqueueErr.message
							: String(enqueueErr);
					console.error(
						`[live-channel] failed to enqueue feeder stop for ${feeder.id}:`,
						message,
					);
					feederStopEnqueueFailures.push(`${feeder.id}: ${message}`);
				}
			}
			try {
				const sdk = await sdkFor(row);
				/**
				 * Stop EVERY encoding this channel knows about, and CONFIRM each one.
				 *
				 * `await sdk.stopLiveEncoding(id)` returning is not an encoding that stopped, and
				 * this row said STOPPED for seven hours while a different encoding of the same
				 * channel kept running and billing. So the stop is followed by a status read, and a
				 * failure to reach a terminal state is reported rather than assumed away.
				 *
				 * Bounded: a handful of polls, because a channel stop that is still settling must
				 * not hold the queue slot — and `stopLiveEncoding` is idempotent, so the sweep can
				 * try again.
				 */
				const failures: string[] = [];
				const terminalReadbacks = new Map<string, string>();
				const ids = allEncodingIdsOf(row);
				for (const [index, id] of ids.entries()) {
					try {
						await effect?.beforeSend(`Stop encoding ${id}`);
						await sdk.stopLiveEncoding(id);
					} catch (stopErr) {
						/**
						 * The PRIMARY id's failure still throws, as it always did.
						 *
						 * A stop API that refuses must mark the channel ERROR and propagate — the
						 * existing behaviour, and two tests pin it. What is new is that a SECONDARY
						 * id (the step log's, when it differs from the column's) is best-effort: its
						 * failure is recorded loudly but must not convert a successful primary stop
						 * into an ERROR, because that would leave the channel unstoppable through
						 * the normal path.
						 */
						if (index === 0) {
							throw stopErr;
						}
						failures.push(
							`${id}: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`,
						);
						continue;
					}
					let last = "unknown";
					for (let attempt = 0; attempt < 6; attempt++) {
						try {
							last = String((await sdk.getEncodingStatus(id)).status);
						} catch {
							break;
						}
						if (STOP_TERMINAL_STATUSES.includes(last)) {
							break;
						}
						await deps.sleep(5_000);
					}
					if (last === "unknown") {
						/**
						 * `last` is still the initial value ⇔ NOT ONE status read
						 * succeeded: the only way out of the loop without assigning is
						 * the catch's `break`, on the very first attempt.
						 *
						 * "unknown" used to sit in the accepted-terminal list below, so
						 * this — the case with the least evidence of all — was recorded
						 * as a confirmed stop and written `error: null`. That is the
						 * exact lie the comment beneath this loop says the code no
						 * longer tells: `STOPPED` + null error is what the #130 reset
						 * reads as safe to delete, so a provider still billing per
						 * minute lost its only local record (#48). A stop we could not
						 * observe is unconfirmed BY DEFINITION.
						 */
						failures.push(
							`${id}: status could never be read after the stop was accepted — the encoding may still be running`,
						);
					} else if (!STOP_TERMINAL_STATUSES.includes(last)) {
						failures.push(`${id}: still ${last} after the stop was accepted`);
					} else {
						terminalReadbacks.set(id, last);
					}
				}
				if (effect) {
					const providerStatus = terminalReadbacks.get(
						effect.claim.providerEncodingId,
					);
					if (!providerStatus) {
						failures.push(
							`${effect.claim.providerEncodingId}: the exact claimed encoding has no terminal readback`,
						);
					} else {
						const observedAt = new Date(deps.now());
						const exactRun = {
							id: effect.claim.liveChannelRunId,
							liveChannelId,
							bitmovinEncodingId: effect.claim.providerEncodingId,
						};
						const persisted = await deps.prisma.liveChannelRun.updateMany({
							where: exactRun,
							data: {
								providerStatus,
								providerStatusObservedAt: observedAt,
								providerUnknownSince: null,
							},
						});
						if (persisted.count === 1) {
							// A cleanup read refreshes observation, never the first
							// provider end clock. CAS also preserves a concurrent stamp.
							await deps.prisma.liveChannelRun.updateMany({
								where: { ...exactRun, providerTerminalAt: null },
								data: { providerTerminalAt: observedAt },
							});
						}
						if (persisted.count !== 1) {
							failures.push(
								`${effect.claim.providerEncodingId}: terminal readback could not be bound to the exact live run`,
							);
						}
					}

					let occupyingFeeder: { id: string } | null = null;
					for (let attempt = 0; attempt < 6; attempt += 1) {
						occupyingFeeder = await deps.prisma.feederSession.findFirst({
							where: {
								...feederOccupancyWhere(liveChannelId),
								liveChannelRunId: effect.claim.liveChannelRunId,
							},
							select: { id: true },
						});
						if (!occupyingFeeder) break;
						if (attempt < 5) await deps.sleep(5_000);
					}
					if (occupyingFeeder) {
						failures.push(
							`feeder ${occupyingFeeder.id}: stop was enqueued but publisher termination was not confirmed`,
						);
					}
				}
				// LOUD. A leaked live encoding bills per minute, and "STOPPED" over
				// one is the most expensive lie this system can tell.
				//
				// It used to tell it: the console.error was the ONLY trace, and the
				// row was written `STOPPED` with `error` cleared to null — wiping
				// the one field that could have carried the evidence. 's
				// reset then classified those rows as safe to delete, which is #48
				// (a forgotten encoder is a bill) reached through a clean-looking
				// row. Reported by review-265 against #266.
				//
				// So the outcome is PERSISTED. `STOPPED` now means stopped-and-
				// confirmed exactly when `error` is null, which is what lets the
				// reset tell the two apart at all.
				// Row 268: a feeder stop that could not be ENQUEUED joins the
				// encodings that could not be CONFIRMED terminal — both are stops
				// that did not land, and both must poison `error` so `STOPPED` with
				// a null error keeps meaning stopped-and-confirmed-clean end to end.
				const stopFaults = [
					...failures,
					...feederStopEnqueueFailures.map(
						(f) =>
							`feeder stop could not be enqueued (${f}) — its push may still be running`,
					),
				];
				const unconfirmed =
					stopFaults.length > 0
						? `stop did not confirm — ${stopFaults.join("; ")}`
						: null;
				if (unconfirmed) {
					console.error(`[live-channel] ${liveChannelId}: ${unconfirmed}`);
				}
				await deps.prisma.liveChannel.update({
					where: { id: liveChannelId },
					data: { status: "STOPPED", error: unconfirmed },
				});
				await runs.mirror(liveChannelId, {
					status: "STOPPED",
					error: unconfirmed,
				});
				/**
				 * what the SCHEDULED stop delivered.
				 *
				 * The same evidence that decides `error` on the channel decides
				 * this — a stop whose encodings could not be OBSERVED terminal is
				 * `UNKNOWN`, not `DELIVERED`, because the encoder may still be up
				 * and billing (#48). Reading the row's `STOPPED` back as delivery
				 * would repeat the exact substitution this change removes: our own
				 * write standing in for the provider's answer.
				 */
				await recordScheduleOutcomeBestEffort(
					deps.prisma,
					{ channelStop: liveChannelId },
					unconfirmed === null ? "DELIVERED" : "UNKNOWN",
					unconfirmed === null ? null : redactSecrets(unconfirmed),
					new Date(deps.now()),
					unconfirmed === null
						? "PROVIDER_TERMINAL"
						: "PROVIDER_STATUS_UNKNOWN",
				);
				await emitChannel("CHANNEL_STOPPED", liveChannelId);
			} catch (err) {
				const message = err instanceof Error ? err.message : "stop failed";
				// Once the provider call was attempted, a thrown response does not
				// prove that the stop failed to land. Keep the schedule fail-closed as
				// UNKNOWN, matching the durable AMBIGUOUS claim; only a refusal before
				// the send boundary is evidence of FAILED.
				const crossedSendBoundary = effect?.crossedSendBoundary === true;
				await recordScheduleOutcomeBestEffort(
					deps.prisma,
					{ channelStop: liveChannelId },
					crossedSendBoundary ? "UNKNOWN" : "FAILED",
					redactSecrets(message),
					new Date(deps.now()),
					crossedSendBoundary ? "JOB_TERMINAL_UNKNOWN" : "EFFECT_FAILED",
				);
				await markError(liveChannelId, message);
				throw err;
			}
		},

		/**
		 * The actions route atomically claims RUNNING|ERROR (STOPPED refused since #107) →
		 * PROVISIONING (the lock); this handler verifies the claim is still
		 * held, calls the restart API and lands on RUNNING.
		 *
		 * CORRECTED 2026-08-16 (owner hit it): this comment used to claim "the
		 * SDK allows restart for RUNNING/FINISHED/CANCELED/ERROR live
		 * encodings". It does NOT. Bitmovin refuses a terminal encoding —
		 * `409 … code 2028: Restarting the encoding … is not possible in its
		 * current state 'FINISHED'` — because a finished live encoding's
		 * infrastructure is deallocated; the recovery is to CREATE
		 * A NEW ENCODING (which is what Duplicate does; C30 — confirmed via the
		 * vendor's docs assistant, no public state matrix exists). Restart is for an
		 * encoding that is still up. The false claim is why the UI offered
		 * the button on a STOPPED channel, whose encoding is FINISHED by
		 * construction — `stopChannel` calls `stopLiveEncoding` right above.
		 * A
		 * stalled duplicate arriving after completion sees RUNNING and bails
		 * here instead of interrupting the stream a second time. Ingest
		 * details may change across a restart, so they are required and any
		 * missing coordinate clears the previous value. Provider RUNNING is
		 * re-observed after that potentially slow GET, then provider evidence,
		 * run state and channel state commit atomically under the exact identity.
		 */
		async restartChannel(
			liveChannelId: string,
			effect?: LiveEffectFence,
		): Promise<void> {
			const row = await loadChannel(liveChannelId);
			const encodingId = encodingIdOf(row);
			let resetSdk: SdkOps | undefined;
			const restartEffectIsCurrent = async (): Promise<boolean> => {
				if (!effect) return true;
				try {
					return await assertLiveEffectCurrent(
						deps.prisma,
						effect.claim,
						new Date(deps.now()),
					);
				} catch {
					// A failed fence read grants no licence to overwrite another
					// effect's state. The caller rethrows its original provider/action
					// error so failLiveEffect retains the correct uncertainty boundary.
					return false;
				}
			};
			const markRestartErrorIfCurrent = async (
				message: string,
			): Promise<boolean> => {
				if (!(await restartEffectIsCurrent())) return false;
				if (!effect) {
					await markError(liveChannelId, message);
					return true;
				}
				const error = redactSecrets(message);
				// The assertion above checks the claim token/run/provider/expiry. This
				// write is the second, atomic half: STOP may win immediately after that
				// read, so ERROR itself must CAS the exact generation and restart state.
				const projected = await deps.prisma.liveChannel.updateMany({
					where: {
						id: liveChannelId,
						status: "PROVISIONING",
						liveEffectFenceVersion: effect.claim.generation,
					},
					data: { status: "ERROR", error },
				});
				if (projected.count !== 1) return false;
				await runs.mirror(liveChannelId, { status: "ERROR", error });
				await emitChannel("CHANNEL_ERROR", liveChannelId, error);
				return true;
			};
			const { count } = await deps.prisma.liveChannel.updateMany({
				where: {
					id: liveChannelId,
					status: { in: ["PROVISIONING"] },
				},
				data: { status: "PROVISIONING", error: null },
			});
			if (count === 0) {
				throw new ChannelStateError(
					`Channel is not claimed for restart (status ${row.status})`,
				);
			}
			// review-242 A1: without this the run kept a stale error after a
			// successful restart claim.
			await runs.mirror(liveChannelId, { error: null });
			try {
				const sdk = await sdkFor(row);
				resetSdk = sdk;
				/**
				 * ask the provider BEFORE
				 * asking it to restart. The audited run hit the vendor's 409 on a
				 * FINISHED encoding and landed local ERROR with nothing recording
				 * WHY — so the next Start revived the finished encoding. Now a
				 * TERMINAL readback reconciles run + channel (terminal stamp,
				 * coordinates cleared, feeders stopped) and the restart call is
				 * never made; an UNKNOWN readback refuses too, keeping every id,
				 * with a retryable message — the vendor is never asked to act on
				 * an encoding we cannot see.
				 */
				const run = await providerLifecycle.loadCurrentRun(liveChannelId);
				const before = await providerLifecycle.reconcile({
					channel: row,
					run,
					encodingId,
					sdk,
				});
				if (before.lifecycle === "TERMINAL") {
					const reason =
						before.reason ?? "the provider reports the encoding ended";
					if (!before.channelLanded) {
						// Already terminalised by an earlier entry (or the channel's
						// pointer drifted): the route's claim still holds the channel
						// in PROVISIONING, so it leaves through markError here.
						await markRestartErrorIfCurrent(reason);
					}
					throw new ProviderLifecycleRefusal(reason);
				}
				if (before.lifecycle === "UNKNOWN") {
					const reason = `Restart refused: ${before.refusal} (${before.reason})`;
					await markRestartErrorIfCurrent(reason);
					throw new ProviderLifecycleRefusal(reason);
				}
				await effect?.beforeSend("Restart encoding");
				await sdk.restartLiveEncoding(encodingId);
				/**
				 * §14.5 item 6: local stays PROVISIONING until the EXACT encoding
				 * reads back RUNNING and its fresh details are in hand. A 2xx on
				 * the restart call is acceptance, not a lifecycle observation.
				 */
				const readback = await providerLifecycle.awaitRunning({
					sdk,
					encodingId,
					attempts: RESTART_READBACK_ATTEMPTS,
					intervalMs: RESTART_READBACK_INTERVAL_MS,
					sleep: deps.sleep,
				});
				if (readback.lifecycle === "TERMINAL") {
					// The provider ended the encoding between admission and now (the
					// route-admission race). Reconcile it exactly as the entry does.
					const after = await providerLifecycle.reconcile({
						channel: row,
						run,
						encodingId,
						sdk,
						observation: {
							ok: true,
							status: readback.status ?? "FINISHED",
							observedAt: readback.observedAt,
						},
					});
					const reason =
						after.reason ??
						`restart was accepted but the encoding then reported ${readback.status}`;
					if (!after.channelLanded) {
						await markRestartErrorIfCurrent(reason);
					}
					throw new ProviderLifecycleRefusal(reason);
				}
				if (readback.lifecycle !== "RUNNING") {
					throw new Error(
						`restart was accepted but the encoding did not read back RUNNING within ${
							(RESTART_READBACK_ATTEMPTS * RESTART_READBACK_INTERVAL_MS) / 1000
						}s (last reading: ${readback.status ?? readback.reason ?? "none"}) — start the channel again to retry`,
					);
				}
				// REQUIRED, no longer best-effort: ingest coordinates can change
				// across a restart, and RUNNING with the previous run's IP is a
				// dead ingest presented as live. A failed read lands ERROR with
				// every id kept; Start (revive) re-reads them at finalize.
				const details = await sdk.getLiveEncodingDetails(encodingId);
				// The details GET can take long enough for an encoder to end. Its
				// earlier RUNNING word is no longer a licence once this read settles.
				const finalObservation = await providerLifecycle.observe(
					sdk,
					encodingId,
				);
				const finalLifecycle = classifyProviderLifecycle(
					finalObservation,
					new Date(finalObservation.observedAt).getTime(),
				);
				if (finalLifecycle !== "RUNNING") {
					const afterDetails = await providerLifecycle.reconcile({
						channel: row,
						run,
						encodingId,
						sdk,
						observation: finalObservation,
						channelWrite: {
							where: { status: { in: ["PROVISIONING"] } },
						},
					});
					const reason =
						afterDetails.lifecycle === "TERMINAL"
							? (afterDetails.reason ??
								"the provider reports the encoding ended after the details read")
							: `Restart refused after the details read: ${afterDetails.refusal ?? "provider status is not RUNNING"} (${afterDetails.reason ?? afterDetails.status ?? "no status"})`;
					if (afterDetails.lifecycle === "TERMINAL") {
						if (!afterDetails.channelLanded) {
							await markRestartErrorIfCurrent(reason);
						}
						throw new ProviderLifecycleRefusal(reason);
					}
					throw new Error(reason);
				}
				const committed = await providerLifecycle.commitRunning({
					channel: row,
					run,
					encodingId,
					observation: finalObservation,
					coordinates: details,
					provisionClaimedAt: null,
				});
				if (!committed) {
					throw new Error(
						"restart RUNNING commit lost the exact run, encoding, or channel claim",
					);
				}
				await emitChannel("CHANNEL_RUNNING", liveChannelId);
			} catch (err) {
				if (err instanceof ProviderLifecycleRefusal) {
					// Run + channel already carry the verdict; a second markError
					// would overwrite the terminal message and emit twice.
					throw err;
				}
				const message = err instanceof Error ? err.message : "restart failed";
				if (!(await markRestartErrorIfCurrent(message))) {
					// STOP (or another exact-generation winner) now owns the channel.
					// Preserve the original error for claim classification, but never
					// project ERROR over the winner's STOPPING/RUNNING state.
					throw err;
				}
				throw err;
			} finally {
				if (
					effect &&
					resetSdk &&
					deps.journalResetEncoding &&
					!(await deps.prisma.liveChannel.findUnique({
						where: { id: liveChannelId },
						select: { id: true },
					}))
				) {
					const accountId =
						row.bitmovinAccountId ??
						(row.plan as { bitmovin?: { accountId?: string } }).bitmovin
							?.accountId;
					if (
						accountId &&
						(await deps.journalResetEncoding(
							`liveEffectClaim:${effect.claim.id}`,
							encodingId,
							accountId,
						))
					) {
						try {
							await resetSdk.stopLiveEncoding(encodingId);
						} catch {
							/* receipt retries */
						}
					}
				}
			}
		},

		async updateRtmpIngest(
			liveChannelId: string,
			params: LiveRtmpIngestParams,
			requestSha256: string | undefined,
			effect: LiveEffectFence,
		): Promise<void> {
			const row = await loadChannel(liveChannelId);
			if (row.status !== "RUNNING")
				throw new ChannelStateError(
					"RTMP ingest update requires a RUNNING channel",
				);
			const encodingId = effect.claim.providerEncodingId;
			if (!encodingId || row.bitmovinEncodingId !== encodingId)
				throw new ChannelStateError(
					"RTMP ingest update channel encoding does not match its admitted claim",
				);
			const points = selectRtmpIngestPoints(
				liveChannelPlanSchema.parse(row.plan),
				params,
			);
			const digest = createHash("sha256")
				.update(
					JSON.stringify({
						runId: effect.claim.liveChannelRunId,
						...params,
						ingestPoints: points,
					}),
				)
				.digest("hex");
			if (!requestSha256 || digest !== requestSha256)
				throw new ChannelStateError(
					"RTMP ingest update request does not match its admitted plan",
				);
			await assertProviderEffectAllowed(liveChannelId, "RTMP ingest update", {
				runId: effect.claim.liveChannelRunId,
				encodingId: effect.claim.providerEncodingId,
			});
			const sdk = await sdkFor(row);
			await effect.beforeSend("RTMP ingest update");
			try {
				await sdk.updateLiveRtmpIngestPoints(encodingId, points);
			} catch {
				throw new Error("RTMP ingest update provider result is unknown");
			}
		},

		async updateAutoShutdown(
			liveChannelId: string,
			params: LiveAutoShutdownUpdateParams,
			requestSha256: string | undefined,
			effect: LiveEffectFence,
		): Promise<void> {
			const row = await loadChannel(liveChannelId);
			const encodingId = effect.claim.providerEncodingId;
			if (row.status !== "RUNNING" || row.bitmovinEncodingId !== encodingId)
				throw new ChannelStateError(
					"Automatic stop update requires the RUNNING channel encoding bound to its claim",
				);
			const currentRun = await deps.prisma.liveChannelRun.findFirst({
				where: { liveChannelId },
				orderBy: { seq: "desc" },
				select: { id: true, bitmovinEncodingId: true, stepLog: true },
			});
			if (
				currentRun?.id !== effect.claim.liveChannelRunId ||
				currentRun.bitmovinEncodingId !== encodingId
			)
				throw new ChannelStateError(
					"Automatic stop update no longer belongs to the current live run",
				);
			// The exact run retains late success receipts even when their expired
			// claim no longer owns the channel's display projection.
			const revision =
				readLiveAutoShutdownUpdate(currentRun.stepLog)?.requestId ?? null;
			if (revision !== (params.expectedRevision ?? null))
				throw new ChannelStateError(
					"Automatic stop settings changed after this request was prepared; reload before updating",
				);
			const digest = createHash("sha256")
				.update(
					liveAutoShutdownFingerprint(
						effect.claim.liveChannelRunId,
						params.configuration,
						params.expectedRevision,
					),
				)
				.digest("hex");
			if (!requestSha256 || digest !== requestSha256)
				throw new ChannelStateError(
					"Automatic stop update configuration does not match its admitted request",
				);
			await assertProviderEffectAllowed(
				liveChannelId,
				"Automatic stop update",
				{
					runId: effect.claim.liveChannelRunId,
					encodingId,
				},
			);
			const sdk = await sdkFor(row);
			await effect.beforeSend("Automatic stop update");
			const accepted = await sdk.updateLiveAutoShutdown(
				encodingId,
				params.configuration,
			);
			const at = deps.now();
			const receipt = liveAutoShutdownUpdateReceiptSchema.parse({
				...accepted,
				appliedAt: at,
				requestId: effect.claim.idempotencyKey,
			});
			const persisted = await appendLiveEffectStepLogEntry(
				deps.prisma,
				effect.claim,
				{
					step: `auto-shutdown:${effect.claim.id}`,
					kind: "LIVE_AUTO_SHUTDOWN_UPDATE",
					payload: receipt,
					refs: {},
					status: "DONE",
					startedAt: at,
					finishedAt: at,
				},
			);
			if (persisted.runUpdated !== 1)
				throw new Error(
					"Automatic stop was accepted but its exact run receipt could not be saved; do not resend",
				);
		},

		/** Shrinks the DVR window (C8 surface) — RUNNING channels only. */
		async resetTimeshift(
			liveChannelId: string,
			params: LiveResetTimeshiftParams,
			effect?: LiveEffectFence,
		): Promise<void> {
			const row = await loadChannel(liveChannelId);
			const encodingId = encodingIdOf(row);
			if (row.status !== "RUNNING") {
				throw new ChannelStateError(
					`Timeshift can only be reset on a RUNNING channel (status ${row.status})`,
				);
			}
			await assertProviderEffectAllowed(liveChannelId, "Timeshift reset");
			const sdk = await sdkFor(row);
			await effect?.beforeSend("Timeshift reset");
			await sdk.resetLiveManifestTimeshift(encodingId, params);
		},

		/** Inserts a SCTE-35 cue (ad break) — RUNNING channels only. */
		async insertScte35(
			liveChannelId: string,
			params: LiveScte35Params,
			effect: LiveEffectFence,
		): Promise<{ id: string | null }> {
			const row = await loadChannel(liveChannelId);
			const encodingId = encodingIdOf(row);
			if (row.status !== "RUNNING") {
				throw new ChannelStateError(
					`SCTE-35 cues need a RUNNING channel (status ${row.status})`,
				);
			}
			await assertProviderEffectAllowed(liveChannelId, "SCTE-35 cue");
			const sdk = await sdkFor(row);
			await effect.beforeSend("SCTE-35 cue");
			const providerCue = await sdk.insertScte35Cue(encodingId, params);
			// Record the fired cue so the UI can confirm it (C14). The provider call
			// crossed its irreversible boundary, so evidence belongs to the exact
			// claimed run even if STOP/re-air won while the response was in flight.
			// The helper atomically appends (never stale read-modify-write) and only
			// projects onto the channel while this effect still owns the generation.
			try {
				const at = deps.now();
				const entry = redactSecrets({
					step: `scte35-cue:${at}`,
					kind: "SCTE35_CUE",
					payload: {
						at,
						cueDuration: params.cueDuration,
						...(params.manifestIds ? { manifestIds: params.manifestIds } : {}),
						...(providerCue.id ? { providerEntryId: providerCue.id } : {}),
					},
					refs: {},
					status: "DONE",
					startedAt: at,
					finishedAt: at,
				}) as StepLogEntry;
				const persisted = await appendLiveEffectStepLogEntry(
					deps.prisma,
					effect.claim,
					entry,
				);
				if (persisted.runUpdated !== 1) {
					console.error(
						`[live-channel] ${liveChannelId}: SCTE-35 cue ${providerCue.id ?? "without provider id"} succeeded but could not be bound to claimed run ${effect.claim.liveChannelRunId}`,
					);
				}
			} catch (recordErr) {
				// Never turn a successful provider call into a retryable cue request.
				console.error(
					`[live-channel] ${liveChannelId}: SCTE-35 cue ${providerCue.id ?? "without provider id"} succeeded but its run-bound evidence could not be persisted:`,
					recordErr instanceof Error ? recordErr.message : recordErr,
				);
			}
			return providerCue;
		},

		/**
		 * Slate insertion : plays REGISTERED insertable
		 * content over the live stream for durationSeconds, immediately.
		 * RUNNING channels only — the scheduler's grace policy decides WHEN
		 * this fires; this action decides only WHETHER it can. The fired
		 * slate lands in the step log like SCTE-35 cues (C14 confirmation
		 * discipline), replay-skipped as status DONE.
		 */
		/**
		 * register a creation-time slate's content once the
		 * channel is RUNNING. Writes insertableContentId only when READY —
		 * which is the sweep's fire gate — and releases the registration
		 * claim instead of throwing when the channel is not there yet, so
		 * BullMQ attempts are never burned against provisioning time.
		 */
		async registerSlate(
			liveChannelId: string,
			params: { scheduleId: string; source: SlateSource },
			effect?: LiveEffectFence,
		): Promise<string> {
			const row = await loadChannel(liveChannelId);
			if (row.status !== "RUNNING") {
				await deps.prisma.liveSchedule.updateMany({
					where: { id: params.scheduleId, insertableContentId: null },
					data: { contentClaimedAt: null },
				});
				return "CHANNEL_NOT_RUNNING";
			}
			const result = await registerSlateContent(
				{
					prisma: deps.prisma,
					sdk: await sdkFor(row),
					resolveCredential: deps.resolveCredential,
					now: () => new Date(deps.now()),
					sleep: deps.sleep,
					pollIntervalMs: deps.pollIntervalMs,
					beforeProviderMutation: () =>
						effect?.beforeSend("Slate content registration") ??
						Promise.resolve(),
					// : what the encoder is actually ingesting, so the
					// clip can be checked against Bitmovin's own match rule.
					ingestMedia: await loadChannelIngestMedia(
						deps.prisma,
						liveChannelId,
						row.lastHeartbeat,
					),
					...(deps.prepareSlate
						? {
								prepareSlate: deps.prepareSlate,
								conversionDestination: slateConversionDestination(row.plan),
							}
						: {}),
					...(deps.probeStorageObject
						? {
								probeSlateSource: (source: SlateSource) =>
									(deps.probeStorageObject as BoundedObjectProbe)({
										label: `slate-${params.scheduleId}`,
										credentialId: source.credentialId,
										bucket: source.bucket,
										key: source.key,
									}),
							}
						: {}),
				},
				{
					scheduleId: params.scheduleId,
					source: params.source,
					encodingId: encodingIdOf(row),
				},
			);
			return result.outcome;
		},

		/**
		 *  — scheduled feeder start. Creates the FeederSession from
		 * the row's source, derives the RTMP push target from the channel's
		 * own plan + columns (the server-side twin of the panel's prefill),
		 * and hands the session to the feeder-manager queue. Refusals are
		 * written onto the SCHEDULE row so the timeline says why; a channel
		 * whose encoder IP is not known yet THROWS (BullMQ retries — the IP
		 * appears seconds after RUNNING).
		 *
		 * : `twoPhase` makes the created session a STAGED one — it
		 * carries its commit instant, downloads and gates its source, then
		 * holds instead of spawning until `commitRequestedAt` is written (see
		 * `feederCommit`). Pre-requesting the commit at creation is the
		 * immediate (lead 0) form: the feeder worker stages first, stops the
		 * predecessors only once the new source is READY, and spawns after
		 * they are gone.
		 */
		async feederStart(
			liveChannelId: string,
			params: LiveFeederActionParams,
			twoPhase?: { commitAt: Date; commitRequestedAt: Date | null },
			effect?: LiveEffectFence,
		): Promise<string> {
			/**
			 *  — the SAME job delivered twice must not create a second
			 * session. The row's `feederSessionId` is stamped only after the
			 * create and the enqueue below, and nothing here used to read it:
			 * a `feeder-start` job re-delivered after a worker death (this
			 * queue's default maxStalledCount is 1 — exactly one re-run), or
			 * re-added by the outbox once the completed job id was gone,
			 * created a second FeederSession with its own start job — two
			 * pushes at one ingest, and the feeder's own CAS could not help
			 * because they were different rows. So the row is read FIRST, and a
			 * non-terminal session it already names is the answer.
			 */
			const ownRow = await deps.prisma.liveSchedule.findUnique({
				where: { id: params.scheduleId },
				select: { fireAt: true, feederSessionId: true, status: true },
			});
			/**
			 * rev367 I-3: the row must still be LIVE in the state this job was
			 * dispatched for — ARMED for a pre-stage, FIRED for a start, a
			 * switch commit's start, or the immediate form. A stage job can
			 * arrive AFTER its row ended: the queue delayed it past fireAt, the
			 * pending-IP retry ladder carried it there, or the outbox re-added
			 * a stranded claim in the same tick the due scan refused the row —
			 * and this function then downloaded a whole source for a switch
			 * that can no longer happen and OVERWROTE the MISSED row's note
			 * with "staged". A terminal row's story stands; nothing is created.
			 */
			const expectedRowState =
				twoPhase && twoPhase.commitRequestedAt === null ? "ARMED" : "FIRED";
			if (ownRow && ownRow.status !== expectedRowState) {
				console.warn(
					`[live-channel] feeder job for schedule ${params.scheduleId} arrived after the row left ${expectedRowState} (now ${ownRow.status}) — creating nothing`,
				);
				return "ROW_ENDED";
			}
			if (ownRow?.feederSessionId) {
				const existing = await deps.prisma.feederSession.findUnique({
					where: { id: ownRow.feederSessionId },
					select: { status: true },
				});
				if (
					existing &&
					(existing.status === "CREATED" ||
						existing.status === "DOWNLOADING" ||
						existing.status === "PUSHING")
				) {
					return "ALREADY_STARTED";
				}
			}
			const row = await loadChannel(liveChannelId);
			if (row.status !== "RUNNING") {
				throw new ChannelStateError(
					`Scheduled feeders attach to RUNNING channels (status ${row.status})`,
				);
			}
			await assertProviderEffectAllowed(liveChannelId, "Feeder start");
			// review-226 I4: a feeder-start retry can outlive the SWITCH (the
			// F2 deadline lets FEEDER_START fire as late as air−5s, and the
			// pending-IP retry ladder spans ~75s). If a LATER feeder row on
			// this channel has already FIRED, this job is superseded — running
			// it would open a SECOND push against the same ingest, the
			// jammed-socket class #95 documented.
			if (ownRow) {
				const superseding = await deps.prisma.liveSchedule.findFirst({
					where: {
						liveChannelId,
						action: { in: ["FEEDER_START", "FEEDER_SWITCH"] },
						status: "FIRED",
						fireAt: { gt: ownRow.fireAt },
					},
					select: { id: true },
				});
				if (superseding) {
					await deps.prisma.liveSchedule.updateMany({
						where: { id: params.scheduleId },
						data: {
							note: `superseded by feeder row ${superseding.id} — not started`,
						},
					});
					return "SUPERSEDED";
				}
			}
			const plan = liveChannelPlanSchema.parse(row.plan);
			//  PR2b (R5 consumer move): the CURRENT RUN owns the
			// ingest coordinates — a restart provisions a fresh encoder with a
			// new IP and (for GENERATE) a new key on a NEW run row. The channel
			// columns stay dual-written for now, so they agree today; reading
			// the run makes it authoritative so the column drop is safe later.
			// One query serves both this read and the session stamp below.
			//
			// (row 266): this "latest run" IS the
			// job's planned run whenever a scheduled feeder reaches here — the
			// dispatch fence (`refuseStaleQueuedGeneration`) has already refused
			// any job whose planned run is not the current one, so a late retry
			// never re-targets a new airing through this derivation. The read
			// stays "latest" rather than "the payload's run id" only because
			// the fence makes the two identical on the path that proceeds.
			const currentRun = await deps.prisma.liveChannelRun.findFirst({
				where: { liveChannelId: row.id },
				orderBy: { seq: "desc" },
				select: { id: true, streamKey: true, encoderIp: true },
			});
			const target = deriveFeederRtmpTarget(
				plan,
				currentRun?.streamKey ?? row.streamKey,
				currentRun?.encoderIp ?? row.encoderIp,
			);
			if (target.ok === "pending") {
				// RUNNING but no IP yet — retry lands it moments later.
				throw new ChannelStateError(target.reason);
			}
			if (target.ok === false) {
				await deps.prisma.liveSchedule.updateMany({
					where: { id: params.scheduleId },
					data: { error: target.reason },
				});
				return "REFUSED";
			}
			/**
			 * a scheduled ordinary start had NO
			 * per-channel admission at all — only the global slot cap below — so
			 * a FEEDER_START firing while the channel's previous push was still
			 * alive (or merely unproven gone) created a second session whose
			 * worker would spawn beside it. An ordinary (single-phase) start is
			 * refused while the channel is OCCUPIED, read from core's one
			 * fragment: a held publisher claim, a process nobody has proven
			 * gone, or an active uncoordinated session. A two-phase stage /
			 * switch is exempt by design — it coordinates through the
			 * predecessor barrier and claims only at its commit, which is the
			 * path an operator should schedule over a running feed. Refused,
			 * not retried: the previous feed does not go away on a backoff, and
			 * the row's FAILED outcome names the occupant.
			 */
			if (!twoPhase) {
				const occupants = await deps.prisma.feederSession.findMany({
					where: feederOccupancyWhere(liveChannelId),
					select: { id: true, status: true, pid: true, ownerHost: true },
					take: 5,
				});
				if (occupants.length > 0) {
					const named = occupants
						.map(
							(occupant) =>
								`${occupant.id} (${occupant.status}${occupant.pid === null ? "" : `, pid ${occupant.pid} on ${occupant.ownerHost ?? "an unknown host"}`})`,
						)
						.join("; ");
					const note = redactSecrets(
						`channel occupied — feeder session ${named} still holds the ingest (a claim, or a process not proven gone); a scheduled FEEDER_START does not stop it. Stop that session, or arm a FEEDER_SWITCH, which stages and waits for it to be gone`,
					);
					await deps.prisma.liveSchedule.updateMany({
						where: { id: params.scheduleId },
						data: { error: note },
					});
					await recordScheduleOutcomeBestEffort(
						deps.prisma,
						{ scheduleId: params.scheduleId },
						"FAILED",
						note,
						new Date(deps.now()),
						"EFFECT_FAILED",
					);
					return "OCCUPIED";
				}
			}
			// The SLOT population — every active row, staged holds included: each
			// one's START job holds a worker slot for its whole life. It cannot be
			// replaced by publisher occupancy, which deliberately omits staged
			// holds; the separate global publisher-cap question follows below.
			const active = await deps.prisma.feederSession.count({
				where: { status: { in: [...FEEDER_ACTIVE_STATUSES] } },
			});
			if (active >= FEEDER_MAX_ACTIVE_SESSIONS) {
				// The cap protects the stop-slot guarantee; a scheduled start
				// retries on the queue's backoff and notes the wait.
				throw new ChannelStateError(
					`Active feeder session limit reached (${active}/${FEEDER_MAX_ACTIVE_SESSIONS})`,
				);
			}
			// The worker-slot cap above retains staged holds. LC-02 also caps
			// publisher occupancy globally: terminal rows with a held claim or an
			// unproven process use no queue slot, but admitting publishers without
			// counting them defeats the same capacity guard on this scheduler path.
			if (!twoPhase) {
				const publisherOccupancies = await deps.prisma.feederSession.count({
					where: feederOccupancyWhere(),
				});
				if (publisherOccupancies >= FEEDER_MAX_ACTIVE_SESSIONS) {
					throw new ChannelStateError(
						`Feeder publisher occupancy limit reached (${publisherOccupancies}/${FEEDER_MAX_ACTIVE_SESSIONS})`,
					);
				}
			}
			await effect?.assertCurrent("Feeder session start");
			//  PR2: the feeder fed a RUN; stamp which one (the run
			// was loaded above, alongside its ingest coordinates).
			const session = await deps.prisma.feederSession.create({
				data: {
					liveChannelId,
					...(currentRun ? { liveChannelRunId: currentRun.id } : {}),
					status: "CREATED",
					sourceCredentialId: params.source.credentialId,
					sourceBucket: params.source.bucket,
					sourceKey: params.source.key,
					// : carry the ARM-TIME seal onto the session, so the
					// download demands the bytes the operator scheduled rather
					// than whatever the key holds now. The create route captured
					// it; the sweep parsed it off the row into this payload.
					// Absent for rows armed before the seal existed, and for
					// drivers that cannot name a version.
					...(params.source.identity
						? {
								sourceEtag: params.source.identity.etag ?? null,
								sourceVersionId: params.source.identity.versionId ?? null,
								sourceGeneration: params.source.identity.generation ?? null,
								sourceSize: BigInt(params.source.identity.size),
							}
						: {}),
					// : the two-phase marker and, for the immediate form,
					// the commit request itself.
					...(twoPhase
						? {
								commitAt: twoPhase.commitAt,
								commitRequestedAt: twoPhase.commitRequestedAt,
							}
						: {}),
					protocol: "RTMP",
					target: {
						url: target.url,
						streamKey: target.streamKey,
					} as unknown as Prisma.InputJsonValue,
				},
				select: { id: true },
			});
			if (
				effect &&
				!(await bindLiveEffectTarget(deps.prisma, effect.claim, session.id))
			) {
				await deps.prisma.feederSession.update({
					where: { id: session.id },
					data: {
						status: "ERROR",
						error:
							"Feeder effect claim was lost before the session could be bound",
					},
				});
				throw new LiveEffectFenceLostError(
					"Feeder start refused: the durable effect claim was lost",
				);
			}
			try {
				await deps.enqueueFeederJob({
					feederSessionId: session.id,
					action: "start",
				});
			} catch (enqueueErr) {
				await deps.prisma.feederSession.update({
					where: { id: session.id },
					data: {
						status: "ERROR",
						error: "Enqueue failed — the schedule row can be re-armed",
					},
				});
				throw enqueueErr;
			}
			/**
			 * BIND the session to the row that created it.
			 *
			 * The note already named the session in prose, which no query can
			 * follow. The column is what lets the feeder's own status transitions
			 * — the only place that learns whether the feed actually connected —
			 * find this row by a single reverse lookup, instead of the schedule
			 * ledger's delivery depending on a dead-job handler that only ever
			 * fires when the job itself dies.
			 */
			await deps.prisma.liveSchedule.updateMany({
				// rev367 I-3: the stamp is a CAS on the state checked above — a
				// row that ended between the check and here keeps its own note
				// (a MISSED "not staged" must never be rewritten to "staged").
				// A session created under a lost CAS is bounded, not orphaned:
				// no row points at it, so its hold ends at the hold timeout
				// (STAGE_HOLD_TIMEOUT_MS past its commitAt) and the spool is
				// released; the row-#262 read above keeps a retry from
				// doubling it while a stamped session is live.
				where: { id: params.scheduleId, status: expectedRowState },
				data: {
					note: twoPhase
						? twoPhase.commitRequestedAt
							? `feeder session ${session.id} staged for an immediate switch`
							: `feeder session ${session.id} staged — commit planned for ${twoPhase.commitAt.toISOString()}`
						: `feeder session ${session.id} started`,
					feederSessionId: session.id,
				},
			});
			return session.id;
		},

		/**
		 *  — Phase A of the scheduled switch, fired by the sweep at
		 * fireAt − lead. Creates the STAGED session; the feeder worker
		 * downloads, probes and gates it, records READY and holds.
		 */
		async feederStage(
			liveChannelId: string,
			params: LiveFeederStageParams,
		): Promise<string> {
			return await self.feederStart(liveChannelId, params, {
				commitAt: new Date(params.commitAt),
				commitRequestedAt: null,
			});
		},

		/**
		 *  — Phase B, fired by the sweep at fireAt for a session it
		 * judged READY. ONE compare-and-swap requests the commit; the feeder
		 * worker that holds the session does the rest (stop the predecessors,
		 * wait for them to be gone, take the commit point, spawn). The CAS
		 * re-checks readiness itself: a takeover between the sweep's read and
		 * this write clears `readyAt`, and a request landing on a source
		 * nobody holds would be a switch to nothing.
		 *
		 * A CAS that matches nothing is either a retry of a request that
		 * already landed (idempotent, reported as such) or a session that is
		 * not READY — which is the schedule's FAILED outcome, "not staged",
		 * and the previous feed keeps pushing. Nothing is stopped here.
		 */
		async feederCommit(
			liveChannelId: string,
			params: LiveFeederCommitParams,
			effect?: LiveEffectFence,
		): Promise<string> {
			// : a switch commit is a new push at the ingest — refused
			// while the provider cannot be seen; the previous feed keeps pushing.
			await assertProviderEffectAllowed(liveChannelId, "Feeder switch commit");
			await effect?.assertCurrent("Feeder switch commit");
			const now = new Date(deps.now());
			const { count } = await deps.prisma.feederSession.updateMany({
				where: {
					id: params.feederSessionId,
					liveChannelId,
					status: "DOWNLOADING",
					readyAt: { not: null },
					commitRequestedAt: null,
				},
				data: { commitRequestedAt: now },
			});
			if (count === 1) {
				await deps.prisma.liveSchedule.updateMany({
					where: { id: params.scheduleId },
					data: {
						note: `switch committed to feeder session ${params.feederSessionId} at ${now.toISOString()} — the previous feed stops once the new source is spawned-ready`,
					},
				});
				return "COMMIT_REQUESTED";
			}
			const session = await deps.prisma.feederSession.findUnique({
				where: { id: params.feederSessionId },
				select: {
					status: true,
					readyAt: true,
					commitRequestedAt: true,
					error: true,
				},
			});
			if (session?.commitRequestedAt) {
				return "ALREADY_REQUESTED";
			}
			const reason = !session
				? "the staged session no longer exists"
				: session.readyAt === null
					? `the staged session is not READY (${session.status})`
					: `the staged session is ${session.status}${session.error ? `: ${session.error}` : ""}`;
			const note = redactSecrets(`not staged — ${reason}`);
			await deps.prisma.liveSchedule.updateMany({
				where: { id: params.scheduleId },
				data: { error: note },
			});
			await recordScheduleOutcomeBestEffort(
				deps.prisma,
				{ scheduleId: params.scheduleId },
				"FAILED",
				note,
				now,
				"EFFECT_FAILED",
			);
			return "NOT_READY";
		},

		/**
		 *  — the air-time switch, in its IMMEDIATE form :
		 * the program feed is staged with the commit pre-requested, so the
		 * feeder worker stops the active sessions (the pre-air slate loop)
		 * only once the new source is downloaded, probed and gated, waits for
		 * them to be gone, and then spawns. This used to enqueue the stops
		 * FIRST and create the replacement in the same breath — the seam was
		 * then dead air or a dual push depending on queue scheduling (audit
		 * 2026-08-29 HIGH-3). Kept under its old action name so a job queued
		 * before the two-phase model still runs, better than it would have.
		 */
		async feederSwitch(
			liveChannelId: string,
			params: LiveFeederActionParams,
			effect?: LiveEffectFence,
		): Promise<string> {
			const now = new Date(deps.now());
			return await self.feederStart(
				liveChannelId,
				params,
				{
					commitAt: now,
					commitRequestedAt: now,
				},
				effect,
			);
		},

		async insertContent(
			liveChannelId: string,
			params: LiveInsertContentParams,
			effect?: LiveEffectFence,
		): Promise<void> {
			const row = await loadChannel(liveChannelId);
			const encodingId = encodingIdOf(row);
			if (row.status !== "RUNNING") {
				throw new ChannelStateError(
					`Slate insertion needs a RUNNING channel (status ${row.status})`,
				);
			}
			const providerIdentity = await assertProviderEffectAllowed(
				liveChannelId,
				"Slate insertion",
			);
			const sdk = await sdkFor(row);
			// review-223 F6: the duration is derived HERE, at the moment of the
			// SDK call, when the row carries a program window — the sweep's
			// number is stale by however long queue retries took (attempts 5,
			// exponential backoff ≈ 75s worst case), and every stale second
			// would be slate covering the program. floor, never round, for the
			// same reason.
			let durationSeconds = params.durationSeconds;
			if (params.slateUntil !== undefined) {
				const remaining = Math.floor(
					(Date.parse(params.slateUntil) - Date.parse(deps.now())) / 1000,
				);
				if (remaining < MIN_SLATE_FIRE_SECONDS) {
					const note = `slate window closed before the insert could run (${remaining}s left at insert time)`;
					if (params.scheduleId !== undefined) {
						// review-223b minor: the row was FIRED when the sweep
						// enqueued this — a slate that never aired must not read
						// as success on the timeline. MISSED + the note says why.
						await deps.prisma.liveSchedule.updateMany({
							where: { id: params.scheduleId, status: "FIRED" },
							data: { status: "MISSED", note },
						});
					}
					return;
				}
				// Clamp to the schema's own ceiling (review-223b minor): a
				// >24h pre-air window is legal within the 30-day horizon, and
				// the re-derived number must not exceed what the enqueue-side
				// schema would have allowed.
				durationSeconds = Math.min(remaining, 86_400);
			}
			/**
			 * Ask the PROVIDER before inserting.
			 *
			 * `scheduleInsertableContent` is a POST, the queue retries it up to
			 * five times, and the history row below is written only AFTER it
			 * returns. So a provider that ACCEPTED the insertion and then lost
			 * the response left no local trace, and the retry covered the
			 * program with a second slate.
			 *
			 * The direction of the fallback is deliberate and is the whole
			 * reason this is a lookup rather than a local claim. slate insertion exists to
			 * keep something off air; a slate that never fires is worse than one
			 * that fires twice. So a claim written before the call — which would
			 * make a crash between claim and POST look like "already done" — is
			 * the wrong shape here. We only skip on POSITIVE evidence that the
			 * provider already holds this insertion, and if the lookup itself
			 * fails we insert anyway and say so.
			 *
			 * CREATED/SCHEDULED are the live states of
			 * `ScheduledInsertableContentStatus`; DESCHEDULED, TO_BE_DESCHEDULED
			 * and ERROR are not, and must not suppress a fresh insert. An
			 * operator deliberately double-covering while the first insertion is
			 * still pending is skipped too — the program is covered either way,
			 * which is the outcome the feature exists for.
			 */
			/**
			 * Does one of OUR OWN earlier airings account for a provider entry?
			 *
			 * This is what tells a lost response apart from a legitimate repeat.
			 * A retry has no local record — the record is written AFTER the SDK
			 * call, which is the whole reason a lost response is invisible. A
			 * second armed slate insertion of the same slate DOES have one, from the first
			 * airing. So a provider entry that a prior record explains is not
			 * evidence of anything, and we insert.
			 *
			 * Without this, the window alone had to carry the distinction, and it
			 * cannot: two SLATE_IN rows naming one slate nine minutes apart are
			 * legal (the arm route enforces no spacing) and are the normal
			 * ad-break shape, so the second was silently skipped in exactly the
			 * world the guard exists for.
			 */
			const inWindow = (at: string | null | undefined, nowMs: number) => {
				if (typeof at !== "string") {
					return false;
				}
				const age = nowMs - Date.parse(at);
				// `age >= 0` is load-bearing on BOTH sides: a future-dated stamp —
				// ours by clock change, the provider's by ordinary NTP drift —
				// explains nothing and must not suppress a slate.
				return age >= 0 && age <= RETRY_WINDOW_MS;
			};
			/**
			 * A step log we cannot read must fail toward COVERING — review-300 F5.
			 *
			 * The first version returned `[]` here and called that "costs us the
			 * memory, not the cover". Backwards: `[]` means nothing is accounted
			 * for, so any live provider entry is a surplus and the cover is
			 * SUPPRESSED. On a corrupt log the guard silently reverted to exactly
			 * the pre-fix behaviour this work exists to refute, while this same
			 * function states the opposite invariant four times over.
			 *
			 * `null` is therefore distinct from "no records": it means we cannot
			 * account for anything and must not draw a conclusion from that.
			 */
			const priorAirings = ((): StepLogEntry[] | null => {
				try {
					return stepLogSchema.parse(row.stepLog);
				} catch (parseErr) {
					console.error(
						`[live-channel] ${liveChannelId}: step log could not be parsed before firing a slate (inserting anyway — a missed 蓋被せ is worse than a doubled one):`,
						parseErr instanceof Error ? parseErr.message : parseErr,
					);
					return null;
				}
			})();
			// ONE instant for both counts — they are differenced, so reading the
			// clock twice (once outside the try, once in) made the comparison
			// span a gap for no reason.
			const firedAtMs = Date.parse(deps.now());
			const slateRecords = (priorAirings ?? []).filter((entry) => {
				if (entry.kind !== "SLATE_INSERTED") {
					return false;
				}
				const payload = entry.payload as { insertableContentId?: unknown };
				return payload.insertableContentId === params.insertableContentId;
			});
			/**
			 * THE IDEMPOTENCY KEY, which stall-policy.ts has been asking for by
			 * name: "Raise it here only once `insert-content`/`scte35` carry an
			 * idempotency key — the schedule row id is already in hand at enqueue
			 * time." It is in hand now: this branch's sweep puts `scheduleId` on
			 * every insert-content enqueue, and that is the only enqueue site.
			 *
			 * A schedule row fires ONCE (ARMED→FIRED), so a non-skipped record
			 * carrying OUR scheduleId can only be an earlier attempt of this same
			 * job. That is a stall redelivery, and re-inserting is a second slate
			 * on air — which stall-policy.ts:74-78 already warns about: the
			 * insert guards only on `row.status !== "RUNNING"`, and the channel
			 * stays RUNNING throughout, so a redelivered job inserts AGAIN.
			 *
			 * Counting alone could not see this (review-300): attempt 1's own
			 * record credits against attempt 1's own provider entry, the surplus
			 * is zero, and we insert. The count is fungible; the key is not.
			 *
			 * A SKIPPED record with our key is deliberately NOT a match — that
			 * attempt aired nothing, so this delivery still has work to do.
			 */
			const ourEarlierAttempt =
				params.scheduleId !== undefined &&
				slateRecords.some((entry) => {
					const payload = entry.payload as {
						scheduleId?: unknown;
						skipped?: unknown;
					};
					return (
						payload.scheduleId === params.scheduleId && payload.skipped !== true
					);
				});
			/**
			 * What OTHER airings can account for, when the key does not settle it.
			 *
			 * Skipped records from a DIFFERENT row are INCLUDED here, and that is
			 * the correction (review-300 Important 2). Excluding them meant a
			 * cover that was itself skipped left its provider entry unexplained,
			 * so the next legitimate cover saw a surplus it did not cause and was
			 * suppressed — the segment that must not air, airs. A skip still
			 * EVIDENCES that an insertion exists at the provider; that is why it
			 * skipped. It just is not evidence about THIS row, which the key
			 * above handles.
			 */
			/**
			 * WHICH provider entries are OURS — by ID, not by arithmetic.
			 *
			 * The previous shape subtracted a count of our airings from a count of
			 * the provider's LIVE entries, and review-300 showed that is not a
			 * well-formed operation: the two populations decay differently. Ours
			 * persist; theirs leave CREATED/SCHEDULED on playback, retirement or a
			 * deschedule. Every entry that leaves without a matching decrement on
			 * our side masks exactly one real surplus (double insert), and every
			 * record we cannot match inflates ours (false skip). Both directions
			 * failed, which is the signature of a modelling error rather than an
			 * off-by-one.
			 *
			 * The POST has always known the answer: it returns the created entry's
			 * id, which this codebase extracted for the audit snapshot and then
			 * discarded. Recorded, it turns "how many" into "which" — no window
			 * arithmetic, no assumption about retirement policy, no clock
			 * comparison across two authorities.
			 */
			/**
			 * A record of ours that claims NO entry — review-300 probe I.
			 *
			 * The null-id rule was applied to THEIR entries and not to OURS, which
			 * made it two opposite rules pointing in opposite directions:
			 *   · null id on the PROVIDER side → can never make anything
			 *     unaccounted → guard disabled → double insert. Tolerable, and the
			 *     trade this function states everywhere.
			 *   · null id on OUR side → the record claimed nothing → their entry
			 *     read as a stranger → every later cover SUPPRESSED → content airs.
			 *     Not tolerable, and the one direction this work rejects.
			 * So the same rule now holds on both sides: unidentifiable ⇒ ignore.
			 * If we hold a recent record we cannot match, we cannot conclude a
			 * stranger entry is not ours, and we cover the program.
			 *
			 * The sign handling differs between the two sides ON PURPOSE, and for
			 * one reason: each drops whichever way fails toward covering. A
			 * future-dated PROVIDER entry is dropped (fewer suppressors); a
			 * future-dated record of OURS is KEPT (more reasons not to suppress),
			 * which is also what keeps probe G shut — a web-stamped record running
			 * ahead of the worker's clock cannot be discarded into a false skip.
			 */
			const haveUnclaimedRecord = slateRecords.some((entry) => {
				const payload = entry.payload as {
					at?: unknown;
					providerEntryId?: unknown;
					skipped?: unknown;
				};
				if (typeof payload.providerEntryId === "string") {
					return false;
				}
				/**
				 * A SKIP makes no claim about any provider entry — review-300 probe
				 * J, where the guard's own success path was manufacturing the
				 * degradation this check exists to detect.
				 *
				 * A key-skip short-circuits before the provider lookup, so it has
				 * neither a created nor an attributed id and is unclaimable by
				 * construction. Counting it meant EVERY redelivery skip turned the
				 * guard off for the whole window — during exactly the queue
				 * turbulence in which a lost response is most likely, i.e. when the
				 * guard is most needed. It also made the degradation warning
				 * routine, which costs the signal: a message meaning "identity
				 * accounting has degraded to no protection" must not fire on
				 * ordinary redeliveries.
				 *
				 * Precise rather than broad: an UNACCOUNTED-skip carries
				 * `attributedEntryId`, so it is already excluded by the id check
				 * above; only key-skips reach here. Same reasoning that excludes
				 * skipped records from `ourEarlierAttempt` — a skip aired nothing.
				 */
				if (payload.skipped === true) {
					return false;
				}
				if (typeof payload.at !== "string") {
					// No id AND no timestamp: it can never be matched or aged out, so
					// treating it as claiming nothing would suppress forever.
					return true;
				}
				const age = firedAtMs - Date.parse(payload.at);
				// PROBE K: an unparseable `at` must fail the SAME way as a missing
				// one. `Math.abs(NaN) <= W` is false, so without this the same
				// unclaimable record covered when the field was absent and
				// suppressed when it was garbage — two rules pointing opposite ways,
				// one level below where they were just unified.
				if (!Number.isFinite(age)) {
					return true;
				}
				return Math.abs(age) <= RETRY_WINDOW_MS;
			});
			const ourEntryIds = new Set(
				slateRecords
					.map(
						(entry) =>
							(entry.payload as { providerEntryId?: unknown }).providerEntryId,
					)
					.filter((id): id is string => typeof id === "string"),
			);
			let attributedEntryId: string | null = null;
			let alreadyScheduled = ourEarlierAttempt;
			// `priorAirings === null` ⇒ our own records are unreadable, so we can
			// attribute nothing and a stranger entry proves nothing. Cover (F5).
			if (!ourEarlierAttempt && priorAirings !== null) {
				try {
					const scheduled =
						await sdk.listScheduledInsertableContent(encodingId);
					/**
					 * An entry we cannot claim, recent enough to be this attempt's.
					 *
					 * `id === null` is treated as ACCOUNTED, i.e. ignored. That is
					 * deliberate and is the fail-toward-covering direction: a
					 * provider that stops returning ids disables this guard rather
					 * than suppressing every slate on the channel.
					 *
					 * The window survives with a much narrower job than it had. It no
					 * longer separates a retry from a repeat — the id does that — it
					 * only bounds how old an UNCLAIMED entry may be and still be read
					 * as our own lost response. Without it, an insertion someone made
					 * from the Bitmovin dashboard hours ago would suppress our cover
					 * forever.
					 */
					const unaccounted = scheduled.find(
						(entry) =>
							entry.contentId === params.insertableContentId &&
							(entry.status === "CREATED" || entry.status === "SCHEDULED") &&
							entry.id !== null &&
							!ourEntryIds.has(entry.id) &&
							inWindow(entry.createdAt, firedAtMs),
					);
					if (unaccounted !== undefined && haveUnclaimedRecord) {
						// We hold a recent record that names no entry, so we cannot
						// prove this stranger is not it. Cover the program, and say
						// so — identity accounting has degraded to no protection here
						// and that must not be silent.
						console.warn(
							`[live-channel] ${liveChannelId}: a recent slate record claims no provider entry id, so insertion ${unaccounted.id} cannot be attributed — inserting rather than risk suppressing a 蓋被せ`,
						);
					}
					alreadyScheduled = unaccounted !== undefined && !haveUnclaimedRecord;
					// Skipping asserts "that entry is my lost response". Record WHICH
					// entry, so the assertion is not made twice: without this, the
					// same unclaimed entry suppresses every later cover of the slate
					// until it ages out — the false skip review-300 filed as Important
					// 2, arriving through identity instead of through counting.
					attributedEntryId = unaccounted?.id ?? null;
				} catch (lookupErr) {
					// Fail toward covering the program, loudly.
					console.warn(
						`[live-channel] ${liveChannelId}: could not read scheduled insertions before firing a slate (inserting anyway — a missed 蓋被せ is worse than a doubled one):`,
						lookupErr instanceof Error ? lookupErr.message : lookupErr,
					);
				}
			}
			let createdEntryId: string | null = null;
			if (alreadyScheduled) {
				console.warn(
					ourEarlierAttempt
						? `[live-channel] ${liveChannelId}: slate ${params.insertableContentId} was already fired by schedule row ${params.scheduleId} — this is a redelivery of that job; not inserting a second time`
						: `[live-channel] ${liveChannelId}: slate ${params.insertableContentId} is already scheduled at the provider and no airing of ours accounts for it — a previous attempt landed and its response was lost; not inserting a second time`,
				);
			} else {
				// Effect boundary: provider lookup/deduplication above can take long
				// enough for a stop, re-air or provider transition. Bind the POST to
				// the exact run+encoding admitted at entry and require a fresh
				// RUNNING observation again immediately before creating the effect.
				await assertProviderEffectAllowed(
					liveChannelId,
					"Slate insertion",
					providerIdentity,
				);
				await effect?.beforeSend("Slate insertion");
				createdEntryId = await sdk.scheduleInsertableContent(encodingId, {
					contentId: params.insertableContentId,
					durationSeconds,
				});
			}
			try {
				const at = deps.now();
				/**
				 * ATOMIC APPEND, not parse-push-overwrite — review-299 Q2.
				 *
				 * This used to re-parse the row loaded at the TOP of the action and
				 * write the whole `stepLog` column back from that snapshot. Two network
				 * round-trips sit between that read and this write (the scheduled-
				 * insertions list and the POST), and there is now a SECOND writer of
				 * this column: the direct schedule route appends atomically. Anything it
				 * landed inside that window was ERASED.
				 *
				 * packages/db/src/step-log.ts documents this hazard and says the
				 * read-modify-write "risked a FUTURE second writer" — the commit that
				 * added the direct route's record is what made that future arrive. The
				 * cost is no longer a missing timeline row: a deleted record is an
				 * insertion nothing can account for, so the next legitimate cover inside
				 * the window sees a surplus it did not cause and is SKIPPED.
				 *
				 * An append-only runtime record does not need the whole array. The
				 * helper is `jsonb ||` in raw SQL with no read, so it cannot lose a
				 * concurrent writer's entry.
				 */
				const entry = {
					step: `slate:${at}`,
					kind: "SLATE_INSERTED",
					payload: {
						at,
						insertableContentId: params.insertableContentId,
						durationSeconds,
						/**
						 * A SKIP must not read as an airing (review-299 S1/#3).
						 * MACHINE-traceable, not yet operator-visible — say only what
						 * this does (review-300 Important 3). Nothing renders these
						 * fields today: step-timeline.tsx does not read `payload`, so
						 * a skipped entry still draws as a DONE SLATE_INSERTED row,
						 * and the schedule row stays FIRED with SCHEDULE_FIRED already
						 * sent. Making a skip actually visible needs the sibling
						 * pattern this function already has — the window-closed path's
						 * status/note writeback that schedule-panel renders — and that
						 * is an operator-surface change, tracked separately.
						 *
						 * Until now the skip branch appended a plain SLATE_INSERTED
						 * and left the schedule row a clean FIRED, so the one
						 * outcome most in need of detection — a slate insertion that did not
						 * cover — was indistinguishable on the operator's timeline
						 * from one that did, with only a console.warn to say
						 * otherwise. It also carries the id of the row it was
						 * attributed to, so a wrong skip can be traced.
						 */
						...(alreadyScheduled
							? {
									skipped: true,
									skippedReason:
										"the provider already held this insertion and no prior airing of ours explained it — treated as a lost response",
								}
							: {}),
						...(params.scheduleId !== undefined
							? { scheduleId: params.scheduleId }
							: {}),
						// The provider's own id for the insertion this record is
						// about — what makes "ours" answerable by identity.
						...((createdEntryId ?? attributedEntryId) !== null
							? { providerEntryId: createdEntryId ?? attributedEntryId }
							: {}),
					},
					refs: {},
					/**
					 * RUNNING, not DONE — .
					 *
					 * This entry is written the instant the POST returns, which is
					 * before anyone knows what the provider did with it. In the
					 * 2026-08-29 audit's paid run #4 it sat here reading DONE while
					 * the provider's own scheduled entry was ERROR and the program
					 * aired uncovered. "The request left this system" is all it has
					 * ever known, and RUNNING is what that is: in flight. One of
					 * SLATE_CONFIRMED / SLATE_FAILED / SLATE_UNCONFIRMED closes it
					 * below, from the provider's answer rather than from our own
					 * request.
					 *
					 * Kind and payload are deliberately unchanged: the idempotency
					 * guard at the top of this action reads THIS record to decide
					 * whether a provider entry is one of ours, and it must land
					 * before the confirmation wait, not after it — an attempt that
					 * crashes mid-poll would otherwise leave its insertion
					 * unaccounted for, and the redelivery would read the provider's
					 * own entry as a stranger and SKIP the cover.
					 */
					status: "RUNNING",
					startedAt: at,
				} as StepLogEntry;
				await appendLiveChannelStepLogEntry(
					deps.prisma,
					liveChannelId,
					redactSecrets(entry) as StepLogEntry,
				);
				// review-242 A1: a KEY feature's history (slate insertion) was missing from the
				// run's replay record. RE-READ rather than mirroring the array we no
				// longer build — mirroring a stale snapshot would put the lost update
				// straight back, in the mirror instead of the row.
				const fresh = await deps.prisma.liveChannel.findUnique({
					where: { id: liveChannelId },
					select: { stepLog: true },
				});
				if (fresh) {
					await runs.mirror(liveChannelId, {
						stepLog: fresh.stepLog as Prisma.InputJsonValue,
					});
				}
			} catch (recordErr) {
				/**
				 * NO LONGER ADVISORY — review-299 I2.
				 *
				 * This comment used to say "the slate already fired; the record is
				 * advisory", and that was true right up until the record became
				 * the DISCRIMINATOR. It is now what tells a legitimate repeat from
				 * a lost response: lose it, and the next cover of the same slate
				 * inside the window finds nothing to account for the provider's
				 * entry and is SKIPPED — the false skip this whole change exists
				 * to remove, re-entered through a swallowed catch.
				 *
				 * Still not rethrown: the slate HAS fired, and failing the job
				 * would re-run an insert that already landed. But it is a
				 * correctness event now, not a cosmetic one, so it is loud.
				 *
				 * Deliberately NOT moved before the SDK call: a claim written
				 * first makes a crash between claim and call read as "already
				 * done" and drops the cover, which is the worse direction.
				 */
				console.error(
					`[live-channel] ${liveChannelId}: slate ${params.insertableContentId} FIRED but its step-log record could not be written — a later cover of the same slate within ${RETRY_WINDOW_MS / 60_000}min may be wrongly skipped:`,
					recordErr instanceof Error ? recordErr.message : recordErr,
				);
			}

			/**
			 * ASK THE PROVIDER WHAT HAPPENED — , audit HIGH-1.
			 *
			 * Everything above this line describes OUR request. Paid run #4 of the
			 * 2026-08-29 live audit fired a slate insertion, this code appended
			 * `SLATE_INSERTED / DONE`, the schedule row read FIRED and rendered
			 * green — and the provider's scheduled entry was ERROR the whole time
			 * while the program aired uncovered. `FIRED` is not `DELIVERED`.
			 *
			 * The read is the SAME op the guard above uses, for the same reason it
			 * exists: `listScheduledInsertableContent` is the only status surface
			 * the SDK offers for a scheduled insertion (no point-GET, verified in
			 * `ops/live.ts`). Selecting by the entry's own id is what makes the
			 * answer about OUR insertion rather than about the channel's history.
			 */
			const ourEntryId =
				createdEntryId ??
				attributedEntryId ??
				/**
				 * A redelivery that SKIPPED the POST still has an entry to ask
				 * about: the attempt it is a redelivery OF recorded the id. Without
				 * this, every stall redelivery of a slate would report UNKNOWN for
				 * an insertion the provider may well have confirmed.
				 */
				slateRecords
					.map((record) => {
						const payload = record.payload as {
							scheduleId?: unknown;
							skipped?: unknown;
							providerEntryId?: unknown;
						};
						return params.scheduleId !== undefined &&
							payload.scheduleId === params.scheduleId &&
							payload.skipped !== true &&
							typeof payload.providerEntryId === "string"
							? payload.providerEntryId
							: null;
					})
					.find((id): id is string => id !== null) ??
				null;

			let verdict: "CONFIRMED" | "FAILED" | "UNCONFIRMED" = "UNCONFIRMED";
			let verdictNote =
				"the provider returned no id for this insertion, so its status could never be read back";
			/**
			 * WP-A3: the provider's own words for a FAILED verdict. The scheduled
			 * entry carries a status and nothing else, so on ERROR the encoding's
			 * status messages are read and the ERROR/WARNING ones dated since the
			 * fire are attributed to this insertion (`selectProviderFailureReason`).
			 * The first rides the outcome note; all of them ride the closing
			 * step-log entry. Three honest answers, never a blank.
			 */
			let providerMessages: EncodingMessage[] = [];
			let warnedStillCreated = false;
			if (ourEntryId !== null) {
				const waitSeconds =
					(SLATE_CONFIRM_ATTEMPTS * SLATE_CONFIRM_INTERVAL_MS) / 1000;
				verdictNote = `the provider's entry ${ourEntryId} did not resolve within ${waitSeconds}s`;
				for (let attempt = 0; attempt < SLATE_CONFIRM_ATTEMPTS; attempt++) {
					let entries: Awaited<
						ReturnType<SdkOps["listScheduledInsertableContent"]>
					> | null = null;
					try {
						entries = await sdk.listScheduledInsertableContent(encodingId);
					} catch (pollErr) {
						// A read failure is not a verdict. Keep asking until the
						// attempts run out; the note then says we never got an
						// answer, which is exactly what happened.
						verdictNote = `the provider's entry ${ourEntryId} could not be read back: ${pollErr instanceof Error ? pollErr.message : String(pollErr)}`;
					}
					const hit = entries?.find((entry) => entry.id === ourEntryId);
					if (hit === undefined) {
						if (entries !== null) {
							verdictNote = `the provider does not list entry ${ourEntryId} for this insertion`;
						}
					} else if (hit.status === "ERROR") {
						verdict = "FAILED";
						let clause: string;
						try {
							const reason = selectProviderFailureReason(
								await sdk.getEncodingMessages(encodingId),
								firedAtMs,
							);
							providerMessages = reason.messages;
							clause = providerReasonClause({ kind: "messages", reason });
						} catch (reasonErr) {
							clause = providerReasonClause({
								kind: "unreadable",
								error:
									reasonErr instanceof Error
										? reasonErr.message
										: String(reasonErr),
							});
						}
						/**
						 * Connect the failure to the check that never ran. A slate
						 * registered while the compatibility preflight stood down
						 * carries `preflight UNVERIFIED (<reason>)` — on the schedule
						 * row's note when this worker registered it, on the provider
						 * content's description when the direct route did. Either is
						 * named here, so an operator reading the outcome sees why the
						 * mismatch was not caught earlier. Best-effort: a failed read
						 * costs the clause, never the verdict.
						 */
						let unverifiedClause = "";
						try {
							const notes: (string | null | undefined)[] = [];
							if (params.scheduleId !== undefined) {
								const row = await deps.prisma.liveSchedule.findUnique({
									where: { id: params.scheduleId },
									select: { note: true },
								});
								notes.push(row?.note);
							}
							const content = (
								await sdk.listLiveInsertableContent(encodingId)
							).find((item) => item.id === params.insertableContentId);
							notes.push(content?.description);
							const reason = notes
								.map((note) => preflightUnverifiedReason(note))
								.find((r): r is string => r !== null);
							if (reason !== undefined) {
								unverifiedClause = `; preflight UNVERIFIED (${reason}) — the compatibility check stood down when this slate was registered`;
							}
						} catch {
							// The clause is a courtesy; the provider's verdict stands.
						}
						verdictNote = `the provider's scheduled insertion ${ourEntryId} reached ERROR — the slate did not cover the program; ${clause}${unverifiedClause}`;
						// ONE line, so a failed slate insertion is findable in the worker log by
						// schedule id and entry id without opening the step log.
						console.warn(
							`[live-channel] ${liveChannelId}: slate ${params.insertableContentId} (schedule ${params.scheduleId ?? "none"}, provider entry ${ourEntryId}) reached ERROR — ${clause}`,
						);
						break;
					} else if (SLATE_CONFIRMED_STATUSES.includes(hit.status)) {
						verdict = "CONFIRMED";
						verdictNote = `the provider confirmed insertion ${ourEntryId} (${hit.status})`;
						break;
					} else {
						// CREATED: the provider holds it but has not armed it yet.
						// Worth distinguishing from "not listed" at the deadline —
						// the operator's next question differs.
						verdictNote = `the provider's entry ${ourEntryId} was still ${hit.status} after ${waitSeconds}s`;
						// Early warning, not a verdict (WP-0 A/B, 2026-09-02): a
						// compatible slate's entry was SCHEDULED immediately after the
						// POST in every arm, and every incompatible one sat in CREATED
						// until it flipped to ERROR ~22 s later. The verdict stays the
						// provider's status; this line is so the log reads the tell
						// before the 30 s deadline does.
						if (!warnedStillCreated) {
							warnedStillCreated = true;
							console.warn(
								`[live-channel] ${liveChannelId}: slate ${params.insertableContentId} (provider entry ${ourEntryId}) is still ${hit.status} ${((attempt + 1) * SLATE_CONFIRM_INTERVAL_MS) / 1000}s after the schedule POST — a compatible slate is SCHEDULED at once; still waiting for the provider's verdict`,
							);
						}
					}
					await deps.sleep(SLATE_CONFIRM_INTERVAL_MS);
				}
			}

			try {
				const closedAt = deps.now();
				const closing = {
					step: `slate-outcome:${closedAt}`,
					kind:
						verdict === "CONFIRMED"
							? "SLATE_CONFIRMED"
							: verdict === "FAILED"
								? "SLATE_FAILED"
								: "SLATE_UNCONFIRMED",
					payload: {
						at: closedAt,
						insertableContentId: params.insertableContentId,
						...(ourEntryId !== null ? { providerEntryId: ourEntryId } : {}),
						...(params.scheduleId !== undefined
							? { scheduleId: params.scheduleId }
							: {}),
						// WP-A3: the provider's attributable messages, every one
						// (the note quotes only the first). Absent when none were
						// read, so an older entry and a "no message" entry look the
						// same as they always did.
						...(providerMessages.length > 0 ? { providerMessages } : {}),
					},
					refs: {},
					/**
					 * DONE only for a CONFIRMED insertion. The other two are FAILED
					 * — including UNCONFIRMED, whose kind and `error` say plainly
					 * that we stopped waiting rather than that the provider refused.
					 * The timeline paints RUNNING and DONE the same green
					 * (`step-timeline.tsx`), so an unconfirmed slate insertion left at either
					 * would go back to reading like a success, which is the defect
					 * this whole path exists to remove.
					 */
					status: verdict === "CONFIRMED" ? "DONE" : "FAILED",
					...(verdict === "CONFIRMED" ? {} : { error: verdictNote }),
					startedAt: closedAt,
					finishedAt: closedAt,
				} as StepLogEntry;
				await appendLiveChannelStepLogEntry(
					deps.prisma,
					liveChannelId,
					redactSecrets(closing) as StepLogEntry,
				);
				const mirrored = await deps.prisma.liveChannel.findUnique({
					where: { id: liveChannelId },
					select: { stepLog: true },
				});
				if (mirrored) {
					await runs.mirror(liveChannelId, {
						stepLog: mirrored.stepLog as Prisma.InputJsonValue,
					});
				}
			} catch (closeErr) {
				console.error(
					`[live-channel] ${liveChannelId}: slate ${params.insertableContentId} outcome ${verdict} could not be recorded on the step log:`,
					closeErr instanceof Error ? closeErr.message : closeErr,
				);
			}

			if (params.scheduleId !== undefined) {
				await recordScheduleOutcomeBestEffort(
					deps.prisma,
					{ scheduleId: params.scheduleId },
					// a CONFIRMED verdict means the provider
					// ARMED the insertion — its entry reached SCHEDULED /
					// TO_BE_DESCHEDULED / DESCHEDULED. The SDK has no played/finished
					// status, so there is NO segment/frame witness that the slate
					// aired. `SLATE_ARMED`, not `DELIVERED`: an armed entry that
					// never loaded real media would otherwise render the same green
					// as one that covered the program. FAILED (the entry reached
					// ERROR) and UNKNOWN (we never got a resolving answer) are
					// unchanged.
					verdict === "CONFIRMED"
						? "SLATE_ARMED"
						: verdict === "FAILED"
							? "FAILED"
							: "UNKNOWN",
					redactSecrets(verdictNote),
					new Date(deps.now()),
					verdict === "CONFIRMED"
						? "SLATE_ARMED"
						: verdict === "FAILED"
							? "EFFECT_FAILED"
							: "JOB_TERMINAL_UNKNOWN",
				);
			}
		},

		/**
		 * live-to-VOD (P5): Bitmovin has NO live-to-VOD API. This generates
		 * DEFAULT VOD manifests over the channel's own STOPPED encoding —
		 * i.e. over the segments it already recorded — and starts them with
		 * **manifestGenerator LEGACY**, the single documented exception to
		 * C3's "always V2" (V2 refuses a live encoding's muxings).
		 *
		 * STOPPED-only by design: a RUNNING channel's recording is still
		 * growing, so a manifest generated now would be truncated and
		 * immediately stale. The output is REUSED from the channel's own step
		 * log (`output:<key>` → resourceId), so no new credentials are needed
		 * and the VOD manifest lands beside the recording it describes.
		 *
		 * WHERE it lands is a provider constraint, not a preference (C35): a
		 * default manifest's `outputPath` must be a PARENT of every muxing's,
		 * or the create is refused with `code 2701`. The destination is
		 * therefore DERIVED from the muxing paths in this channel's own step
		 * log, and an explicit `params.path` is held to the same rule here
		 * rather than at Bitmovin — see `resolveLiveToVodTarget`. Because that
		 * path is the same on every roll, a RETRY is separated by FILENAME:
		 * earlier rolls' manifests are read back from the records and the new
		 * one counts past them, so a re-run never overwrites a previous one.
		 *
		 * WHICH families is a property of the recording, not a preference either
		 * a DASH default manifest
		 * enumerates fMP4 muxings only, so the default over a segmented-TS
		 * recording is HLS alone (`liveToVodFamilySupport`). Each family is then
		 * processed INDEPENDENTLY with its own status, id, url and error on the
		 * record; the overall status is derived (FINISHED / PARTIAL / ERROR) and
		 * one family's failure never erases another's success. A retry (the
		 * route carries a PARTIAL/ERROR record forward) re-runs only the failed
		 * families, and a family whose id was saved is READ BACK — adopted,
		 * started, polled or cleaned up — before anything new is created.
		 *
		 * Progress/result live in `liveChannel.liveToVod`. This worker is NOT
		 * the only writer (the earlier "only writer" claim here is what made the
		 * blind update look safe): the route claims RUNNING first so a
		 * double-submit cannot start two runs, a scheduler/route re-air nulls
		 * the column as it mints a new run, and the dead-job reaper stamps
		 * ERROR. So every `save` below is FENCED on `bitmovinEncodingId`
		 *  — a write whose encoding is no longer the channel's current
		 * one is abandoned, never allowed to clobber the new run. Channel
		 * `status` is NEVER touched — a live-to-VOD failure is not a channel
		 * failure.
		 */
		async liveToVod(
			liveChannelId: string,
			params: LiveToVodParams,
			coordinates?: LiveToVodAttemptCoordinates,
		): Promise<void> {
			const row = await loadChannel(liveChannelId);
			const encodingId = encodingIdOf(row);
			const claimed = normalizeLiveToVodRecord(row.liveToVod);
			const attemptId = coordinates?.attemptId ?? claimed?.attemptId;
			const liveChannelRunId =
				coordinates?.liveChannelRunId ?? claimed?.liveChannelRunId;
			if (
				claimed === null ||
				attemptId === undefined ||
				liveChannelRunId === undefined ||
				claimed.attemptId !== attemptId ||
				claimed.liveChannelRunId !== liveChannelRunId ||
				claimed.revision === undefined ||
				(coordinates !== undefined && coordinates.encodingId !== encodingId)
			) {
				throw new ChannelStateError(
					"live-to-VOD queue identity does not match the exact claimed channel run",
				);
			}
			const retryableDelivery =
				claimed.status === "RUNNING" ||
				claimed.status === "ERROR" ||
				claimed.status === "PARTIAL";
			if (!retryableDelivery || claimed.errorCode === "L2V_RECORD_INVALID") {
				throw new ChannelStateError(
					claimed.errorCode === "L2V_RECORD_INVALID"
						? "live-to-VOD claimed record is invalid; provider reconciliation is required before another create"
						: `live-to-VOD queue attempt is no longer active (status: ${claimed.status})`,
				);
			}
			if (row.status !== "STOPPED") {
				throw new ChannelStateError(
					`live-to-VOD needs a STOPPED channel (status: ${row.status}) — a running recording would yield a truncated manifest`,
				);
			}
			const plan = liveChannelPlanSchema.parse(row.plan);
			const outputKey = claimed.outputKey;
			if (!outputKey) {
				throw new ChannelStateError(
					"live-to-VOD claim carries no exact output identity",
				);
			}
			if (params.outputKey !== undefined && params.outputKey !== outputKey) {
				throw new ChannelStateError(
					`Queued output "${params.outputKey}" does not match claimed output "${outputKey}"`,
				);
			}
			const target = plan.outputs.find((o) => o.key === outputKey);
			if (!target) {
				throw new ChannelStateError(
					`Output "${outputKey}" is not in the channel plan`,
				);
			}
			//  (review-4 #7). An Akamai MSL output is a LIVE
			// streaming destination addressed by streamId + eventName; it has
			// no bucket and no path, so writing a VOD asset "to <name>/vod"
			// into it is meaningless. It matters because the default is
			// `outputs[0]`, so an MSL-only channel would silently pick it and
			// build a request Akamai cannot honour.
			if (target.kind === "AKAMAI_MSL") {
				const usable = plan.outputs
					.filter((o) => o.kind !== "AKAMAI_MSL")
					.map((o) => `"${o.key}" (${o.kind})`);
				throw new ChannelStateError(
					`Output "${outputKey}" is an Akamai MSL live destination and cannot receive a live-to-VOD asset — ${
						usable.length > 0
							? `pick a storage output: ${usable.join(", ")}`
							: "this channel has no storage output to write one to"
					}`,
				);
			}
			// The Bitmovin output resource was created during provisioning —
			// its id lives in the step log, so live-to-VOD never re-creates it.
			const entries = stepLogSchema.parse(row.stepLog);
			const outputId = entries.find(
				(e) => e.step === `output:${outputKey}` && e.status === "DONE",
			)?.resourceId;
			if (!outputId) {
				throw new ChannelStateError(
					`Step log carries no provisioned output for "${outputKey}" — provision the channel first`,
				);
			}
			// C35 / : a DEFAULT manifest's outputPath must be a PARENT
			// of every muxing's outputPath, or the create is refused with
			// `code 2701 … not a sub path`. The old default `<run
			// outputPrefix>/vod`  and its `<name>/vod`
			// predecessor were SIBLINGS of the muxings, so every roll died at
			// the first manifest (measured against the real provider
			// 2026-08-29). Both the derived default and an explicit
			// `params.path` are resolved against the muxing paths the STEP LOG
			// records — see `resolveLiveToVodTarget` for why that source
			// cannot drift from what was sent. #155's re-air isolation
			// survives: for a run-scoped plan every recorded muxing path is
			// already inside the run's subtree, so their parent is too.
			//
			// A RETRY is the second half of the same rule (review-357). A
			// FINISHED or ERRORed roll does not block another one (the route's
			// 409 is RUNNING-only), and a second roll derives the SAME path, so
			// without the earlier rolls' filenames it would point a new manifest
			// resource at the file the first one wrote. They are NOT in the step
			// log — that describes provisioning, and a roll is not a step — so
			// they are read from the records: the run mirror keeps one per run,
			// and this MUST happen before the first `save`, which replaces the
			// latest run's record with this roll's RUNNING one. (The channel
			// column is read too, though by now the route has usually replaced
			// it with its claim — it costs nothing and covers a direct call.)
			const priorRolls = await deps.prisma.liveChannelRun.findMany({
				where: { liveChannelId },
				select: { liveToVod: true },
			});
			const resolved = resolveLiveToVodTarget(
				entries,
				params.path,
				priorRollManifestFiles([
					row.liveToVod,
					...priorRolls.map((run) => run.liveToVod),
				]),
			);
			if (!resolved.ok) {
				throw new ChannelStateError(resolved.reason);
			}
			const { path, nameFor } = resolved.target;
			// The DEFAULT family set is what
			// the RECORDED muxings can carry — a segmented-TS recording rolls HLS
			// alone. Asking the provider for a DASH default manifest over TS is
			// refused (400 / code 2700), and the previous `?? ["HLS", "DASH"]`
			// plus a sequential all-or-error loop then reported the DELIVERED HLS
			// as a whole-record ERROR with `manifests: []` (paid run 2026-08-30).
			// An explicit incompatible family is refused HERE before any provider
			// call; the route 422s it first, so this is the answer for a direct
			// call and the reason both give is the same function's.
			const support = liveToVodFamilySupport(entries);
			const explicit = params.manifests !== undefined;
			const requested: LiveToVodFamily[] =
				params.manifests ?? support.supported;
			const refused = support.unsupported.find((u) =>
				requested.includes(u.family),
			);
			if (refused) {
				throw new ChannelStateError(refused.reason);
			}
			if (requested.length === 0) {
				throw new ChannelStateError(
					"No manifest family is compatible with this recording's muxings",
				);
			}
			// What the route CLAIMED: a fresh roll (planned families PENDING), or a
			// RETRY carrying a PARTIAL/ERROR record's families forward so only the
			// failed ones run again (§14.6 LF-02 item 5). Those families are this
			// roll's own only at the destination they were created at; a
			// re-targeted roll cannot reuse their ids, so the ones that never
			// finished are cleaned up rather than left behind at the provider.
			const claimedFamilies = claimed?.families ?? [];
			const everyFamilyAtDestination = claimedFamilies.every((family) => {
				const identity = familyProviderIdentity(family);
				return (
					identity === undefined ||
					(identity.encodingId === encodingId &&
						identity.outputId === outputId &&
						identity.outputPath === path)
				);
			});
			const resumable =
				claimed !== null &&
				claimedFamilies.length > 0 &&
				claimed.outputId === outputId &&
				claimed.path === path &&
				everyFamilyAtDestination;
			let record: LiveToVodWorkRecord = {
				status: "RUNNING",
				attemptId,
				revision: claimed.revision,
				liveChannelRunId,
				outputKey,
				...(claimed.queueJobId ? { queueJobId: claimed.queueJobId } : {}),
				requestedAt: claimed.requestedAt ?? deps.now(),
				outputId,
				path,
				...(claimed.priorManifests && claimed.priorManifests.length > 0
					? { priorManifests: claimed.priorManifests }
					: {}),
				families: resumable
					? liveToVodFamilyPlan({
							requested,
							explicit,
							support,
							carried: claimedFamilies,
						})
					: claimedFamilies,
				manifests: [],
			};
			// : this roll's progress writes are FENCED on the encoding it
			// is archiving. A scheduler re-air of a STOPPED channel (sweep.ts case
			// "STOPPED", and the actions-route restart) nulls bitmovinEncodingId
			// and liveToVod and mints a new run in ONE claim; once it lands, this
			// roll belongs to a run that is gone, so a BLIND update (what this was)
			// would write the old run's record over the new run's PROVISIONING
			// state — the #216 blind-writer race, here for live-to-VOD. The token
			// is the encoding id (`encodingId`, read once at entry via
			// encodingIdOf): every re-air changes it, this roll never touches it
			// (so successive saves stay self-consistent, which an `updatedAt` token
			// could not — save itself bumps updatedAt), and it is @unique (so a
			// full re-air cycle back to STOPPED cannot ABA past a bare state-enum
			// token). A String identity match also dodges #254's SQL-NULL
			// `{ equals: DbNull }` sentinel trap. persistFenced's shape: fence the
			// channel write, and mirror to the run only when the fence held.
			// A family outcome is durable on every write, but the roll stays claimed
			// RUNNING until the one final save that also seals `finishedAt`. If the
			// last family made an intermediate save terminal, the route could accept a
			// retry while this worker still had a final write left and that stale write
			// could replace the retry's claim. Once settled, the overall status is
			// derived from the families and `manifests` is always their FINISHED
			// projection .
			const save = async (
				families: LiveToVodFamilyRecord[],
				options: {
					settled?: boolean;
					finishedAt?: string;
					errorCode?: LiveToVodErrorCode;
					technicalDetail?: string;
				} = {},
			): Promise<void> => {
				const next: LiveToVodWorkRecord = {
					...record,
					families,
					manifests: liveToVodManifestsOf(families),
					status: options.settled ? deriveLiveToVodStatus(families) : "RUNNING",
					...(options.finishedAt ? { finishedAt: options.finishedAt } : {}),
					...(options.errorCode ? { errorCode: options.errorCode } : {}),
					...(options.technicalDetail
						? { technicalDetail: options.technicalDetail }
						: {}),
				};
				try {
					record = (await persistLiveToVodAttempt(deps.prisma, {
						liveChannelId,
						liveChannelRunId,
						encodingId,
						attemptId,
						expectedRevision: record.revision,
						// Structural identity fields include names such as outputKey and
						// ownerToken. Generic object redaction treats those key names as
						// secrets and would destroy the CAS/reconciliation identity itself.
						// Provider prose is redacted before it enters technicalDetail.
						record: next,
					})) as LiveToVodWorkRecord;
				} catch (err) {
					if (err instanceof LiveToVodFenceError) {
						throw new LiveToVodStaleAttemptError();
					}
					throw new LiveToVodPersistError(err);
				}
			};
			const replaceFamily = (
				index: number,
				family: LiveToVodFamilyRecord,
			): LiveToVodFamilyRecord[] =>
				record.families.map((current, i) => (i === index ? family : current));
			const familyAt = (index: number): LiveToVodFamilyRecord => {
				const family = record.families[index];
				if (!family) {
					throw new Error(
						`live-to-VOD family index ${index} disappeared during the exact attempt`,
					);
				}
				return family;
			};
			const saveFinishedUnlessTerminal = async (
				families: LiveToVodFamilyRecord[],
			): Promise<void> => {
				const stillInFlight = families.some(
					(family) =>
						family.status === "PENDING" ||
						family.status === "CREATED" ||
						family.status === "RUNNING",
				);
				if (stillInFlight) {
					await save(families);
					return;
				}
				// Keep the last outcome in memory until the one settled write adds
				// finishedAt. Normalization derives overall status from families, so
				// persisting it one write earlier would expose a retryable terminal
				// record while this delivery still owns a final write.
				record = {
					...record,
					families,
					manifests: liveToVodManifestsOf(families),
				};
			};
			const sdk = await sdkFor(row);
			const poll = {
				intervalMs: deps.pollIntervalMs,
				timeoutMs: deps.pollTimeoutMs,
				sleep: deps.sleep,
			};
			const ownerToken = randomUUID();
			const manifestNameFor = (family: LiveToVodFamily): string =>
				nameFor(family);
			const createFor = async (
				identity: LiveToVodProviderIdentity,
				allowCreate: boolean,
			): Promise<string> => {
				const create = identity.manifestName.endsWith(".m3u8")
					? sdk.createDefaultHlsManifest
					: sdk.createDefaultDashManifest;
				return create({
					encodingId: identity.encodingId,
					manifestName: identity.manifestName,
					name: `${String(row.name ?? liveChannelId)} VOD ${identity.manifestName.endsWith(".m3u8") ? "HLS" : "DASH"}`,
					destination: {
						outputId: identity.outputId,
						outputPath: identity.outputPath,
					},
					strictIdentity: true,
					allowCreate,
				});
			};

			try {
				await save(record.families);

				// A destination change cannot inherit an unfinished provider object.
				// Persist DELETE_PENDING first and require a 404 readback before the
				// family plan is replaced at the new destination.
				if (!resumable) {
					for (let i = 0; i < record.families.length; i++) {
						const stale = familyAt(i);
						const staleId = familyManifestId(stale);
						if (stale.status === "FINISHED" || staleId === undefined) {
							continue;
						}
						if (!familyProviderIdentity(stale)) {
							const invalid = liveToVodFamilyError(
								stale,
								"L2V_RECORD_INVALID",
								"An unfinished legacy family has a provider id but no exact provider identity; automatic cleanup is unsafe",
							);
							await save(replaceFamily(i, invalid), {
								settled: true,
								finishedAt: deps.now(),
								errorCode: "L2V_RECORD_INVALID",
								technicalDetail: invalid.technicalDetail,
							});
							throw new Error(invalid.technicalDetail);
						}
						const pendingCleanup = liveToVodFamilyError(
							stale,
							"L2V_PROVIDER_DELETE_UNCONFIRMED",
							"Retargeted manifest cleanup is pending provider confirmation",
							{
								cleanup: {
									providerId: staleId,
									status: "DELETE_PENDING",
									requestedAt: deps.now(),
									errorCode: "L2V_PROVIDER_DELETE_UNCONFIRMED",
								},
							},
						);
						await save(replaceFamily(i, pendingCleanup));
						const gone = await discardManifest(
							stale.type,
							staleId,
							sdk,
							"the roll was re-targeted before it finished",
						);
						if (!gone) {
							await save(record.families, {
								settled: true,
								finishedAt: deps.now(),
								errorCode: "L2V_PROVIDER_DELETE_UNCONFIRMED",
								technicalDetail:
									"Retargeted manifest deletion was not confirmed by provider readback",
							});
							throw new Error(
								"Retargeted manifest deletion was not confirmed — no replacement is created",
							);
						}
						const persistedCleanup = familyAt(i);
						const confirmed = liveToVodFamilyError(
							persistedCleanup,
							"L2V_PROVIDER_DELETE_UNCONFIRMED",
							"Retargeted manifest deletion confirmed",
							{
								cleanup: {
									providerId: staleId,
									status: "DELETE_CONFIRMED",
									requestedAt:
										"cleanup" in persistedCleanup && persistedCleanup.cleanup
											? persistedCleanup.cleanup.requestedAt
											: deps.now(),
									confirmedAt: deps.now(),
								},
							},
						);
						await save(replaceFamily(i, confirmed));
					}
					await save(
						liveToVodFamilyPlan({
							requested,
							explicit,
							support,
							carried: [],
						}),
					);
				}
				// Families are INDEPENDENT (§14.6 LF-02 items 3–5): each runs in its
				// own try, records its own outcome, and the loop goes on to the next.
				// A FINISHED family (carried from a retry) and a SKIPPED one are never
				// touched; a carried family that was not requested keeps its history.
				const failures: Array<{
					code: LiveToVodErrorCode;
					detail: string;
				}> = [];
				for (let index = 0; index < record.families.length; index++) {
					let entry = familyAt(index);
					if (
						!requested.includes(entry.type) ||
						entry.status === "FINISHED" ||
						entry.status === "SKIPPED_UNSUPPORTED"
					) {
						continue;
					}
					const family = entry.type;
					const label = `live-to-vod:${family.toLowerCase()}`;
					let stage: "lookup" | "create" | "start" | "status" | "delete" =
						"lookup";
					try {
						const existingId = familyManifestId(entry);
						if (existingId !== undefined) {
							const identity = familyProviderIdentity(entry);
							if (!identity) {
								throw new Error(
									`${label} has a provider id without an exact provider identity`,
								);
							}
							// A retry over a SAVED id (item 4): read it back and decide —
							// adopt, reuse or clean up — before any create can happen.
							const seen = await readbackManifest(family, existingId, sdk);
							if (seen.kind === "FINISHED") {
								await saveFinishedUnlessTerminal(
									replaceFamily(index, {
										type: family,
										status: "FINISHED",
										providerIdentity: identity,
										manifestId: existingId,
										url: joinManifestPath(
											identity.outputPath,
											identity.manifestName,
										),
									}),
								);
								continue;
							}
							if (seen.kind === "RUNNING") {
								entry = {
									type: family,
									status: "RUNNING",
									providerIdentity: identity,
									manifestId: existingId,
								};
								await save(replaceFamily(index, entry));
							} else if (seen.kind === "CREATED") {
								entry = {
									type: family,
									status: "CREATED",
									providerIdentity: identity,
									manifestId: existingId,
								};
								await save(replaceFamily(index, entry));
							} else {
								if (seen.kind === "FAILED") {
									stage = "delete";
									const pendingCleanup = liveToVodFamilyError(
										entry,
										"L2V_PROVIDER_DELETE_UNCONFIRMED",
										`${label} ended ${seen.detail}; deletion is pending confirmation`,
										{
											cleanup: {
												providerId: existingId,
												status: "DELETE_PENDING",
												requestedAt: deps.now(),
												errorCode: "L2V_PROVIDER_DELETE_UNCONFIRMED",
											},
										},
									);
									await save(replaceFamily(index, pendingCleanup));
									const gone = await discardManifest(
										family,
										existingId,
										sdk,
										`its generation ended ${seen.detail}`,
									);
									if (!gone) {
										throw new Error(
											`${label} manifest ${existingId} ended ${seen.detail} and could not be deleted — no replacement is created until it is`,
										);
									}
									const requestedAt =
										pendingCleanup.cleanup?.requestedAt ?? deps.now();
									await save(
										replaceFamily(
											index,
											liveToVodFamilyError(
												pendingCleanup,
												"L2V_PROVIDER_DELETE_UNCONFIRMED",
												"Provider deletion confirmed",
												{
													cleanup: {
														providerId: existingId,
														status: "DELETE_CONFIRMED",
														requestedAt,
														confirmedAt: deps.now(),
													},
												},
											),
										),
									);
								}
								// Gone (deleted, or never there): this family starts over.
								// Its old url stays in the taken set through the claim the
								// route carried, so the replacement counts past it.
								entry = { type: family, status: "PENDING" };
								await save(replaceFamily(index, entry));
							}
						}
						entry = familyAt(index);
						if (familyManifestId(entry) === undefined) {
							// The VOD manifest now shares a directory with the LIVE
							// ones, so the FILENAME is what keeps them apart — the
							// live plan's own `stream.m3u8`/`stream.mpd` must not be
							// overwritten by the archive of the very run they describe.
							let identity = familyProviderIdentity(entry);
							let intent =
								"createIntent" in entry ? entry.createIntent : undefined;
							if (!identity || !intent) {
								identity = {
									attemptId,
									encodingId,
									outputId,
									outputPath: path,
									manifestName: manifestNameFor(family),
								};
								intent = {
									ownerToken,
									status: "CREATE_PENDING",
									requestedAt: deps.now(),
								};
								entry = {
									type: family,
									status: "PENDING",
									providerIdentity: identity,
									createIntent: intent,
								};
								await save(replaceFamily(index, entry));
							}
							const ownsCreate =
								identity.attemptId === attemptId &&
								intent.ownerToken === ownerToken;
							stage = ownsCreate ? "create" : "lookup";
							let manifestId: string;
							try {
								manifestId = await createFor(identity, ownsCreate);
							} catch (err) {
								if (
									err instanceof ManifestCreateNotAuthorizedError &&
									identity.attemptId !== attemptId
								) {
									identity = {
										attemptId,
										encodingId,
										outputId,
										outputPath: path,
										manifestName: manifestNameFor(family),
									};
									intent = {
										ownerToken,
										status: "CREATE_PENDING",
										requestedAt: deps.now(),
									};
									entry = {
										type: family,
										status: "PENDING",
										providerIdentity: identity,
										createIntent: intent,
									};
									await save(replaceFamily(index, entry));
									stage = "create";
									manifestId = await createFor(identity, true);
								} else {
									throw err;
								}
							}
							entry = {
								type: family,
								status: "CREATED",
								providerIdentity: identity,
								manifestId,
							};
							// Item 4: the id is DURABLE before start/poll. If this write
							// fails, the pre-POST create identity remains durable and the
							// retry becomes lookup-only; never delete an id the DB did not
							// successfully retain.
							await save(replaceFamily(index, entry));
						}
						entry = familyAt(index);
						if (entry.status === "CREATED") {
							stage = "start";
							// C3 exception: LEGACY is what can enumerate a live
							// encoding's recorded muxings.
							if (family === "HLS") {
								await sdk.startHlsManifest(entry.manifestId, {
									manifestGenerator: "LEGACY",
								});
							} else {
								await sdk.startDashManifest(entry.manifestId, {
									manifestGenerator: "LEGACY",
								});
							}
							entry = {
								type: family,
								status: "RUNNING",
								providerIdentity: entry.providerIdentity,
								manifestId: entry.manifestId,
							};
							await save(replaceFamily(index, entry));
						}
						entry = familyAt(index);
						if (entry.status !== "RUNNING") {
							throw new Error(
								`${label} did not reach a runnable provider state`,
							);
						}
						stage = "status";
						await awaitManifest(family, entry.manifestId, sdk, poll, label);
						await saveFinishedUnlessTerminal(
							replaceFamily(index, {
								type: family,
								status: "FINISHED",
								providerIdentity: entry.providerIdentity,
								manifestId: entry.manifestId,
								url: joinManifestPath(
									entry.providerIdentity.outputPath,
									entry.providerIdentity.manifestName,
								),
							}),
						);
					} catch (err) {
						if (err instanceof LiveToVodPersistError) {
							throw err;
						}
						// This family failed; the others still run, and whatever it
						// created stays recorded (manifestId/url) for the retry's readback.
						const message = String(
							redactSecrets(err instanceof Error ? err.message : String(err)),
						);
						const code: LiveToVodErrorCode =
							err instanceof ManifestIdentityAmbiguousError ||
							err instanceof ManifestIdentityScanIncompleteError
								? "L2V_PROVIDER_LOOKUP_AMBIGUOUS"
								: err instanceof ManifestIdentityLookupError
									? "L2V_PROVIDER_LOOKUP_FAILED"
									: err instanceof ManifestCreateNotAuthorizedError
										? "L2V_QUEUE_STATE_UNKNOWN"
										: stage === "delete"
											? "L2V_PROVIDER_DELETE_UNCONFIRMED"
											: stage === "start"
												? "L2V_PROVIDER_START_FAILED"
												: stage === "status"
													? "L2V_PROVIDER_STATUS_FAILED"
													: stage === "lookup"
														? "L2V_PROVIDER_LOOKUP_FAILED"
														: "L2V_PROVIDER_CREATE_FAILED";
						entry = familyAt(index);
						const failed = liveToVodFamilyError(entry, code, message, {
							...("createIntent" in entry && entry.createIntent
								? {
										createIntent: {
											...entry.createIntent,
											...(code === "L2V_PROVIDER_LOOKUP_FAILED" ||
											code === "L2V_PROVIDER_LOOKUP_AMBIGUOUS" ||
											code === "L2V_QUEUE_STATE_UNKNOWN"
												? {
														status: "LOOKUP_UNKNOWN" as const,
														errorCode: code,
														technicalDetail: message,
													}
												: {}),
										},
									}
								: {}),
						});
						failures.push({ code, detail: `${family}: ${message}` });
						await save(replaceFamily(index, failed));
					}
				}
				const detail = failures.map((failure) => failure.detail).join("; ");
				await save(record.families, {
					settled: true,
					finishedAt: deps.now(),
					...(failures[0] ? { errorCode: failures[0].code } : {}),
					...(detail ? { technicalDetail: detail } : {}),
				});
				if (failures.length > 0) {
					// FINISHED families are already on the record (PARTIAL keeps them);
					// the job still fails so the failure is visible where jobs are.
					throw new Error(`live-to-VOD ${record.status}: ${detail}`);
				}
			} catch (err) {
				if (err instanceof LiveToVodStaleAttemptError) {
					console.warn(
						`[live-channel] live-to-VOD attempt ${attemptId} lost its exact channel/run fence; abandoning stale delivery`,
					);
					return;
				}
				throw err;
			}
		},

		/**
		 * Polls the heartbeat and persists { at, raw, deltas }: the raw
		 * cumulative sample plus per-poll counter deltas (see
		 * computeHeartbeatDeltas). Called by the repeatable sweep.
		 */
		async pollHeartbeat(
			liveChannelId: string,
			opts: {
				/**
				 *  (MEDIUM-1): the sweep's poll token. The poll is bound
				 * to the encoding the token names, and the run write is a CAS on
				 * run id + encoding id + epoch; a late result whose token no longer
				 * matches is discarded WHOLE — no sample, no history row.
				 */
				token?: HeartbeatPollToken;
				sdk?: SdkOps;
				row?: LiveChannelRow;
				signal?: AbortSignal;
			} = {},
		): Promise<PersistedHeartbeat & { discarded?: true }> {
			const row = opts.row ?? (await loadChannel(liveChannelId));
			const encodingId = opts.token?.encodingId ?? encodingIdOf(row);
			const sdk = opts.sdk ?? (await sdkFor(row));
			// Timestamp the REQUEST, not its eventual response. A provider read can
			// start while an old feeder is still connected, then return after a new
			// feeder spawns. Stamping after await would make that predecessor result
			// look newer than the spawn and let it satisfy the new process's bind gate.
			const pollStartedAt = deps.now();
			const raw = await sdk.getLiveHeartbeat(encodingId);
			opts.signal?.throwIfAborted();
			const previous = (row.lastHeartbeat as PersistedHeartbeat | null)?.raw;
			const sample: PersistedHeartbeat = {
				at: pollStartedAt,
				raw,
				deltas: computeHeartbeatDeltas(previous, raw),
			};
			const redacted = redactSecrets(sample) as PersistedHeartbeat;
			// Dual-write : the run carries its own heartbeat —
			// and the run row's updatedAt moves with it, which is what the
			// HEARTBEAT_STALE anchor migrates to (a fresh run must not inherit
			// the previous run's staleness grace, R5/I3).
			// The staleness anchor — the ONE write that means "the encoder
			// spoke" — goes through the mirror's dedicated door; mirror's
			// explicit pick cannot write it (review-109pr1's pre-build catch,
			// hardened in round 6).
			//
			// : the run write goes FIRST because it is the fenced one.
			// Only a landed run write licenses the channel column and the
			// history row — otherwise a timed-out tick's late answer would still
			// repaint the current-state panel and the trend chart with a sample
			// older than the one that already landed.
			const landed = await heartbeatDoor.recordHeartbeat(
				liveChannelId,
				encodingId,
				new Date(sample.at),
				redacted as unknown as Prisma.InputJsonValue,
				opts.token,
				opts.token
					? {
							raw: redacted.raw as unknown as Prisma.InputJsonValue,
							deltas: redacted.deltas as unknown as Prisma.InputJsonValue,
						}
					: undefined,
				opts.signal,
			);
			opts.signal?.throwIfAborted();
			if (!landed) {
				console.warn(
					`[live-channel] heartbeat sample for ${liveChannelId} discarded — its poll token (run ${opts.token?.runId}, epoch ${opts.token?.epoch}) no longer matches`,
				);
				return { ...sample, discarded: true };
			}
			if (!opts.token) {
				await deps.prisma.liveChannel.update({
					where: { id: liveChannelId },
					data: {
						lastHeartbeat: redacted as unknown as Prisma.InputJsonValue,
					},
				});
			}
			// One line per STATE CHANGE against the sample that was persisted
			// before this one (the channel column the poll read), nothing per
			// poll — after the write landed, so a discarded late result never
			// narrates a transition the row does not carry.
			logHeartbeatStateChanges(
				liveChannelId,
				heartbeatSampleRef(row.lastHeartbeat),
				{ at: redacted.at, raw: redacted.raw },
			);
			// History (the dashboard trend chart): a fenced sweep already wrote
			// the history row atomically with both current-state projections in
			// recordHeartbeat; only its retention prune is best-effort here. The
			// unfenced/manual path keeps the legacy best-effort append because it
			// has no poll token whose all-or-nothing evidence tuple must be kept.
			if (opts.token) {
				await pruneHeartbeatHistory(liveChannelId, sample.at);
			} else {
				await appendHeartbeatHistory(liveChannelId, encodingId, redacted);
			}
			return sample;
		},

		/**
		 * one channel's sweep tick. Reconcile the provider's lifecycle
		 * for the run's EXACT encoding under the tick's token, then — unless the
		 * encoding has ended — poll the heartbeat under the same token. A
		 * channel whose run carries no encoding id (pre-#108 dual-write gap)
		 * has no identity to reconcile onto and takes the unfenced legacy poll.
		 */
		async sweepTick(
			liveChannelId: string,
			opts: {
				run: RunLifecycleRow | null;
				token: HeartbeatPollToken | null;
				signal?: AbortSignal;
			},
		): Promise<SweepTickResult> {
			const row = await loadChannel(liveChannelId);
			opts.signal?.throwIfAborted();
			const sdk = await sdkFor(row, opts.signal);
			let lifecycle: SweepTickResult["lifecycle"] = "UNOBSERVED";
			let unknownSince: Date | null = null;
			if (opts.token && opts.run) {
				const outcome = await providerLifecycle.reconcile({
					channel: row,
					run: opts.run,
					encodingId: opts.token.encodingId,
					sdk,
					fence: { epoch: opts.token.epoch },
					signal: opts.signal,
				});
				opts.signal?.throwIfAborted();
				lifecycle = outcome.lifecycle;
				unknownSince = outcome.unknownSince;
				if (outcome.lifecycle === "TERMINAL") {
					// The encoding is gone: nothing to poll, and a heartbeat of a
					// finished encoding must never repaint the panel as live.
					return {
						lifecycle,
						terminal: outcome.terminalised,
						pollFailed: false,
						discarded: !outcome.landed,
						unknownSince: null,
					};
				}
				if (!outcome.landed) {
					return {
						lifecycle,
						terminal: false,
						pollFailed: false,
						discarded: true,
						unknownSince: null,
					};
				}
			}
			try {
				const sample = await self.pollHeartbeat(liveChannelId, {
					token: opts.token ?? undefined,
					sdk,
					row,
					signal: opts.signal,
				});
				return {
					lifecycle,
					terminal: false,
					pollFailed: false,
					discarded: sample.discarded === true,
					unknownSince,
				};
			} catch (err) {
				if (opts.signal?.aborted) throw err;
				console.error(
					`[live-channel] heartbeat poll for ${liveChannelId} failed:`,
					err instanceof Error ? err.message : err,
				);
				return {
					lifecycle,
					terminal: false,
					pollFailed: true,
					discarded: false,
					unknownSince,
				};
			}
		},

		/** : the reconciler, for the processor's provision entry/finalize. */
		providerLifecycle,
	};
	return self;
}

export type LiveChannelActions = ReturnType<typeof createLiveChannelActions>;

/**
 * Repeatable-sweep entry point: polls every RUNNING channel once.
 * Per-channel failures are logged and skipped — one dead channel must not
 * starve the rest of the sweep.
 */
export function createLiveHeartbeatSweep(
	deps: LiveChannelDeps & {
		/**
		 * Alert transition engine  — evaluated per channel AFTER
		 * the poll attempt, success or failure: HEARTBEAT_STALE exists
		 * precisely for channels whose polls keep failing. Optional so the
		 * sweep's poll tests stay poll tests.
		 */
		alertEngine?: (
			liveChannelId: string,
			channelStatus: string,
			lastTouchedAt?: string,
			programWindow?: {
				programStartAt: Date | null;
				programEndAt: Date | null;
			},
			/**
			 * The current run  — this sweep already holds the row
			 * for the stale anchor, so it hands the engine the scope rather
			 * than making it re-read. `null` means "looked, no run row".
			 */
			runScope?: { id: string; createdAt: Date } | null,
			pollToken?: HeartbeatPollToken | null,
		) => Promise<{ opened: number; resolved: number }>;
		/**
		 * review-83b C1: resolves open alert events the engine can no longer
		 * reach (channel left RUNNING, rule disabled or re-scoped) — without
		 * it those events were stranded OPEN forever with no escape in the
		 * product. Runs once per sweep over the RUNNING id set.
		 */
		resolveOrphanedAlerts?: (
			runningChannelIds: ReadonlySet<string>,
		) => Promise<{ resolved: number }>;
		/**
		 * The per-run heartbeat summarizer (`createRunHeartbeatSummarizer`):
		 * writes `LiveChannelRun.heartbeatSummary` once for every run whose
		 * `endedAt` has landed, a few per tick. Rides this sweep — BEFORE the
		 * RUNNING-only channel query, like the terminal feeder-stop retry —
		 * because the runs it serves have, by definition, left RUNNING.
		 * Optional so the sweep's poll tests stay poll tests.
		 */
		summarizeEndedRuns?: () => Promise<{ summarized: number }>;
		/**
		 * Per-channel deadline + parallel lane count.
		 * Test seams; default to the shared cadence
		 * constants. A monitoring attempt that outlives `perChannelTimeoutMs`
		 * is cancelled before alert evaluation; `sweepConcurrency` caps how
		 * many channel attempts run at once.
		 */
		perChannelTimeoutMs?: number;
		sweepConcurrency?: number;
	},
) {
	const actions = createLiveChannelActions(deps);
	// Keep ownership across repeat ticks until the physical poll settles. An
	// injected transport may ignore abort; that must not create more requests.
	const pendingPolls = new Map<string, object>();
	const failedTick: SweepTickResult = {
		lifecycle: "UNOBSERVED",
		terminal: false,
		pollFailed: true,
		discarded: false,
		unknownSince: null,
	};
	const pollWithinBudget = async (
		liveChannelId: string,
		run: RunLifecycleRow | null,
		token: HeartbeatPollToken | null,
	): Promise<SweepTickResult> => {
		if (pendingPolls.has(liveChannelId)) return failedTick;
		const owner = {};
		const controller = new AbortController();
		pendingPolls.set(liveChannelId, owner);
		const pending = actions
			.sweepTick(liveChannelId, { run, token, signal: controller.signal })
			.catch((err) => {
				if (!controller.signal.aborted) {
					console.error(
						`[live-channel] heartbeat poll for ${liveChannelId} failed:`,
						err instanceof Error ? err.message : err,
					);
				}
				return failedTick;
			})
			.finally(() => {
				if (pendingPolls.get(liveChannelId) === owner) {
					pendingPolls.delete(liveChannelId);
				}
			});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<SweepTickResult>((resolve) => {
			timer = setTimeout(() => {
				controller.abort(new Error("Live monitoring deadline exceeded"));
				resolve(failedTick);
			}, deps.perChannelTimeoutMs ?? HEARTBEAT_SWEEP_PER_CHANNEL_TIMEOUT_MS);
		});
		try {
			return await Promise.race([pending, deadline]);
		} finally {
			clearTimeout(timer);
		}
	};
	// at most ONE sweep runs at a time
	// (the 30s repeat scheduler must never pile on), and every channel is polled
	// under a per-channel deadline with a bounded parallel lane count so one
	// hung provider cannot stall the other lanes. Alert finalization is awaited
	// after the poll deadline, so a timed-out poll still evaluates staleness.
	const runSweep = async (): Promise<HeartbeatSweepResult> => {
		// Terminal feeder-stop intent is a durable second phase. It must keep
		// retrying after the channel left RUNNING, so it rides this repeatable
		// sweep before the RUNNING-only channel query.
		try {
			await actions.providerLifecycle.retryPendingTerminalFeederStops();
		} catch (err) {
			console.error(
				"[live-channel] terminal feeder-stop retry scan failed:",
				err instanceof Error ? err.message : err,
			);
		}
		// Ended runs get their heartbeat summary here, on the same best-effort
		// terms: a failure is logged and the poll loop below still runs.
		try {
			await deps.summarizeEndedRuns?.();
		} catch (err) {
			console.error(
				"[live-channel] run heartbeat summary pass failed:",
				err instanceof Error ? err.message : err,
			);
		}
		const rows = await deps.prisma.liveChannel.findMany({
			where: { status: "RUNNING" },
			// programStartAt/programEndAt ride the sweep's own read (review-223
			// F10) — the engine used to re-read them per channel per tick.
			select: {
				id: true,
				updatedAt: true,
				programStartAt: true,
				programEndAt: true,
				purpose: true,
			},
		});
		let failed = 0;
		let terminal = 0;
		let discarded = 0;
		let claimSkipped = 0;
		type ChannelTickOutcome = {
			pollFailed: boolean;
			terminal?: true;
			discarded?: true;
			claimSkipped?: true;
		};
		// One channel's bounded poll followed by awaited alert finalization.
		const processChannel = async (
			row: (typeof rows)[number],
		): Promise<ChannelTickOutcome> => {
			/**
			 * the RUN first — it is the identity everything below is
			 * fenced on.  PR2 / #243 already read it for the stale
			 * anchor and the alert scope; it moved ahead of the poll so the poll
			 * itself can carry the token. Null = looked, no run row.
			 */
			let currentRun: RunLifecycleRow | null = null;
			try {
				currentRun = await actions.providerLifecycle.loadCurrentRun(row.id);
			} catch (err) {
				console.error(
					`[live-channel] run read for ${row.id} failed:`,
					err instanceof Error ? err.message : err,
				);
				return { pollFailed: true };
			}
			/**
			 * MEDIUM-1: claim this channel's tick by bumping the run's poll epoch
			 * with a compare-and-swap on the epoch just read. Two sweeps that
			 * read the same epoch — two worker processes, or a repeat tick that
			 * outran the single-flight guard — race here and exactly one wins;
			 * the loser polls nothing. The winner's token (run, encoding, new
			 * epoch) fences every write it makes, so a result that settles after
			 * a LATER sweep has claimed the channel is discarded whole. Not a
			 * time-based lease: a sweep that reads a fresher epoch may poll again
			 * inside the interval, but its write supersedes rather than clobbers.
			 */
			let token: HeartbeatPollToken | null = null;
			if (currentRun?.bitmovinEncodingId) {
				try {
					token =
						await actions.providerLifecycle.claimHeartbeatPoll(currentRun);
					if (!token) {
						return { pollFailed: false, claimSkipped: true };
					}
				} catch (err) {
					console.error(
						`[live-channel] poll claim for ${row.id} failed:`,
						err instanceof Error ? err.message : err,
					);
					return { pollFailed: true };
				}
			}
			const tick = await pollWithinBudget(row.id, currentRun, token);
			if (tick.terminal) {
				// Reconciled terminal: the channel left RUNNING under this tick;
				// the orphan resolver retires its open alerts on the next sweep.
				return { pollFailed: false, terminal: true };
			}
			if (tick.discarded) {
				// A fenced-out late result: no sample landed, so no alert
				// evaluation either — it would judge a window a newer tick owns.
				return { pollFailed: false, discarded: true };
			}
			const pollFailed = tick.pollFailed;
			/**
			 * UNKNOWN past grace (§14.5 item 3): alert ONCE, on the first tick
			 * whose clock is past `unknownSince + grace` — an edge one sweep
			 * interval wide, not a level, so a long outage does not page every
			 * 30 s. The customer strip shows the window itself from the columns.
			 */
			if (tick.lifecycle === "UNKNOWN" && tick.unknownSince) {
				const nowMs = new Date(deps.now()).getTime();
				if (providerUnknownPastGrace(tick.unknownSince, nowMs)) {
					const message = `provider status for this run's encoding has been unconfirmed since ${tick.unknownSince.toISOString()} (past the ${PROVIDER_UNKNOWN_GRACE_MS / 60_000}-minute grace) — the encoding may or may not be up; every id is kept and Stop remains available`;
					try {
						const claimed =
							currentRun !== null &&
							token !== null &&
							(await actions.providerLifecycle.claimUnknownAlert(
								currentRun,
								token,
								new Date(deps.now()),
							));
						if (claimed) {
							console.error(`[live-channel] ${row.id}: ${message}`);
							await emitChannelEvent(deps, "CHANNEL_ERROR", row.id, message);
						}
					} catch (err) {
						// No marker landed, so a later sweep retries instead of losing
						// the alert because one edge tick or DB write failed.
						console.error(
							`[live-channel] could not persist provider-unknown alert transition for ${row.id}:`,
							err instanceof Error ? err.message : err,
						);
					}
				}
			}
			// Best-effort by the #7 discipline: an evaluation error is logged
			// and never breaks heartbeat collection for the rest of the sweep.
			try {
				//  PR2 (reader move): the empty-window stale anchor
				// is the RUN's lastHeartbeatAt — the one timestamp only the
				// heartbeat path writes. The old anchor (channel updatedAt,
				// review-83b I3) moved on ANY write; with the run mirrors that
				// would reset the staleness clock on every provision step
				// (review-109pr1's pre-build catch). Null = no sample this
				// run → grace from the run's createdAt, so a fresh run never
				// inherits the previous run's grace (R5/I3).
				//
				// `id` rides the run read for  (review-347): the alert
				// engine scopes its heartbeat window to THIS run. One read (now
				// at the top of the tick) serves the token, the stale anchor and
				// the run scope.
				const lifeAnchor = currentRun
					? (currentRun.lastHeartbeatAt ?? currentRun.createdAt)
					: row.updatedAt;
				// review-161-162 m5: probes are POLLED (the batch runner watches
				// their status through these writes) but never ALERTED on — a
				// never-connected probe abandoned by a dead runner would open a
				// spurious INPUT_DISCONNECTED CRIT in its ~3 minutes of zombie
				// RUNNING before the reconciler stops it.
				if (row.purpose === "PROBE") {
					return { pollFailed };
				}
				const alertArgs = [
					row.id,
					"RUNNING",
					lifeAnchor.toISOString(),
					{
						programStartAt: row.programStartAt,
						programEndAt: row.programEndAt,
					},
					// : `createdAt`, NOT the lifeAnchor above. The
					// anchor is "when did this encoder last speak" and moves
					// with every sample; the run scope is "which rows belong to
					// this airing" and must be the run's own immutable birth
					// time — handing it the anchor would slide the window
					// forward until it excluded the very samples being judged.
					// A channel with no run row passes null (looked, found
					// none) so the engine does not re-read to learn the same.
					currentRun
						? { id: currentRun.id, createdAt: currentRun.createdAt }
						: null,
				] as const;
				if (token) {
					await deps.alertEngine?.(...alertArgs, token);
				} else {
					await deps.alertEngine?.(...alertArgs);
				}
			} catch (err) {
				console.error(
					`[alerts] evaluation for ${row.id} failed:`,
					err instanceof Error ? err.message : err,
				);
			}
			return { pollFailed };
		};
		await runChannelsBounded(rows, processChannel, {
			concurrency: deps.sweepConcurrency ?? HEARTBEAT_SWEEP_CONCURRENCY,
			onOutcome: (_row, outcome) => {
				if (outcome === CHANNEL_TIMED_OUT || outcome.pollFailed) {
					failed += 1;
				} else if (outcome.terminal) {
					terminal += 1;
				} else if (outcome.discarded) {
					discarded += 1;
				} else if (outcome.claimSkipped) {
					claimSkipped += 1;
				}
			},
		});
		// Best-effort like everything else in the sweep: a resolver failure
		// must not starve heartbeat collection.
		try {
			await deps.resolveOrphanedAlerts?.(new Set(rows.map((row) => row.id)));
		} catch (err) {
			console.error(
				"[alerts] orphan resolve failed:",
				err instanceof Error ? err.message : err,
			);
		}
		return {
			polled: rows.length - failed - terminal - discarded - claimSkipped,
			failed,
			...(terminal > 0 ? { terminal } : {}),
			...(discarded > 0 ? { discarded } : {}),
			...(claimSkipped > 0 ? { claimSkipped } : {}),
		};
	};
	return createSingleFlightSweep(runSweep);
}

/**
 * How long a provisioning lease survives WITHOUT A HEARTBEAT before another
 * worker may take it.
 *
 * This is a staleness window, not a provision budget, and the distinction is
 * the whole correction. The first cut set it to ten minutes and justified that
 * with "the corpus's slowest live provision is well under a minute" — a figure
 * that exists nowhere in this repo, for a corpus that contains ZERO live
 * scenarios (`2026-08-16-corpus-29-scenarios.md`: every live scenario is in the
 * SKIPs). What the repo actually measured, the day before, was Osaka:
 *
 *   AKAMAI_JP_OSA n=8 — 197 / 424 / 562 / 595 / 595 / 605 / 614 / 636 seconds
 *   median 589.5s, max 636s; the stored startup-profile policy therefore plans
 *   for 10–12 minutes.
 *
 * So three of eight real provisions in a region we actively sell into EXCEED a
 * ten-minute budget, and the median is 98% of it. A fixed window would hand the
 * lease to a second worker mid-provision — restoring the double-provision this
 * lease exists to prevent. This codebase has already deleted one fixed
 * ten-minute grace for exactly that reason (`sweep.ts`: "provisioning that took
 * 12 minutes killed a slate that still had 48 minutes of cover to give").
 *
 * The lease is therefore RENEWED on every poll tick (see `renewLease`), so an
 * alive worker holds it however long the vendor takes, and this window only
 * decides how long a DEAD worker's claim lingers. At a 10s poll interval that
 * is sixty missed heartbeats.
 */
export { PROVISION_LEASE_MS } from "../live/provision-lease";

/**
 * Raised when this worker's provisioning lease is taken by another worker.
 *
 * A SENTINEL, not an ordinary step failure, because the two demand opposite
 * handling. A step failure means the channel is broken: mark it ERROR, record a
 * failed startup sample, emit CHANNEL_ERROR. Losing the lease means the channel
 * is FINE — someone else is provisioning it correctly — and every one of those
 * actions would be aimed at a healthy channel that another worker is mid-way
 * through.
 *
 * The first cut threw a plain Error from inside `ctx.poll.sleep`, which is
 * inside `executeStep`, so the step loop's catch did all three anyway and then
 * rethrew into BullMQ's failed handler, which flips PROVISIONING → ERROR and
 * retires the run — the WINNER's row and the winner's run. `persist` also
 * wrote the loser's stale entries over the winner's step log. Review measured
 * the whole sequence: status writes PROVISIONING, PROVISIONING, ERROR.
 */
class ProvisionLeaseLostError extends Error {
	constructor(liveChannelId: string) {
		super(
			`live channel ${liveChannelId}: provisioning lease lost to another worker — stopping before this run creates a second encoding tree`,
		);
		this.name = "ProvisionLeaseLostError";
	}
}

/** The channel CAS landed; only the denormalized current-run mirror failed. */
class LiveRunMirrorAfterPrimaryPersistError extends Error {
	readonly primaryPersisted = true as const;
	constructor(cause: unknown) {
		super(
			"live channel primary write landed but current-run mirror persistence is unknown",
			{ cause },
		);
		this.name = "LiveRunMirrorAfterPrimaryPersistError";
	}
}

export function createLiveChannelProcessor(deps: LiveChannelDeps) {
	const runs = createRunMirror(deps.prisma);
	const emitChannel = (
		kind: "CHANNEL_RUNNING" | "CHANNEL_ERROR" | "CHANNEL_STOPPED",
		liveChannelId: string,
		error?: string,
	) => emitChannelEvent(deps, kind, liveChannelId, error);

	const actions = createLiveChannelActions(deps);

	async function acknowledgeResetEffect(fence: LiveEffectFence) {
		if (!deps.acknowledgeResetEntity) return;
		const row = await deps.prisma.liveEffectClaim.findUnique({
			where: { id: fence.claim.id },
			select: { id: true },
		});
		if (!row)
			await deps.acknowledgeResetEntity(
				`liveEffectClaim:${fence.claim.id}`,
				fence.claim.token,
			);
	}

	type PreparedLiveEffect =
		| { kind: "EXECUTE"; fence: LiveEffectFence }
		| { kind: "RETURN"; result: LiveChannelResult };

	const effectResult = (
		job: LiveChannelJob,
		status: string,
	): LiveChannelResult => ({
		acknowledged: true,
		liveChannelId: job.liveChannelId,
		action: job.action,
		status,
	});

	async function prepareLiveEffect(
		job: LiveChannelJob,
		expectedAction: LiveEffectIntent["action"],
		allowedChannelStatuses: readonly string[],
		options: { supersedeOpen?: boolean } = {},
	): Promise<PreparedLiveEffect> {
		const intent = job.effect;
		if (!intent || intent.action !== expectedAction) {
			const note = `refused before send: ${job.action} carries no matching run-bound durable effect intent`;
			const scheduleId =
				intent?.scheduleId ??
				(typeof job.params === "object" &&
				job.params !== null &&
				"scheduleId" in job.params &&
				typeof (job.params as { scheduleId?: unknown }).scheduleId === "string"
					? (job.params as { scheduleId: string }).scheduleId
					: undefined);
			if (scheduleId) {
				await recordScheduleOutcomeBestEffort(
					deps.prisma,
					{ scheduleId },
					"UNKNOWN",
					note,
					new Date(deps.now()),
					"JOB_TERMINAL_UNKNOWN",
				);
			}
			return { kind: "RETURN", result: effectResult(job, "EFFECT_REFUSED") };
		}
		const begun = await beginLiveEffect(deps.prisma, {
			idempotencyKey: intent.idempotencyKey,
			...(intent.requestSha256 ? { requestSha256: intent.requestSha256 } : {}),
			liveChannelId: job.liveChannelId,
			liveChannelRunId: intent.liveChannelRunId,
			providerEncodingId: intent.providerEncodingId,
			expectedFenceVersion: intent.admissionFenceVersion,
			action: intent.action,
			...(intent.scheduleId ? { scheduleId: intent.scheduleId } : {}),
			...(intent.targetId ? { targetId: intent.targetId } : {}),
			ownerId: `worker:${process.pid}:${randomUUID()}`,
			now: new Date(deps.now()),
			expiresAt: new Date(Date.parse(deps.now()) + 20 * 60_000),
			allowedChannelStatuses,
			...(options.supersedeOpen ? { supersedeOpen: true } : {}),
		});
		if (begun.kind === "EXECUTE") {
			return {
				kind: "EXECUTE",
				fence: liveEffectFence(deps.prisma, begun.claim, deps.now),
			};
		}
		if (begun.kind === "ACKED") {
			return {
				kind: "RETURN",
				result: effectResult(job, "EFFECT_ALREADY_ACKNOWLEDGED"),
			};
		}
		if (begun.kind === "STALE") {
			if (intent.scheduleId) {
				await transitionScheduleToStale(deps.prisma, {
					scheduleId: intent.scheduleId,
					note: begun.reason,
					at: new Date(deps.now()),
				});
			}
			return {
				kind: "RETURN",
				result: effectResult(job, "SKIPPED_STALE_GENERATION"),
			};
		}
		if (begun.kind === "CONFLICT") {
			return {
				kind: "RETURN",
				result: effectResult(job, "EFFECT_REQUEST_CONFLICT"),
			};
		}
		if (
			begun.kind === "BLOCKED" &&
			expectedAction === "STOP" &&
			(begun.state === "DISPATCHING" || begun.state === "AMBIGUOUS")
		) {
			const resolved = await resolveLiveEffectsAfterConfirmedStop(deps.prisma, {
				liveChannelId: job.liveChannelId,
				liveChannelRunId: intent.liveChannelRunId,
				providerEncodingId: intent.providerEncodingId,
				stopClaimId: begun.claimId,
				stopIdempotencyKey: intent.idempotencyKey,
				at: new Date(deps.now()),
			});
			if (resolved.kind === "RESOLVED") {
				return { kind: "RETURN", result: effectResult(job, "STOPPED") };
			}
			throw new Error(`LIVE_STOP_RECONCILIATION_BLOCKED: ${resolved.reason}`);
		}
		if (begun.state === "AMBIGUOUS" && intent.scheduleId) {
			await recordScheduleOutcomeBestEffort(
				deps.prisma,
				{ scheduleId: intent.scheduleId },
				"UNKNOWN",
				begun.reason,
				new Date(deps.now()),
				"JOB_TERMINAL_UNKNOWN",
			);
		}
		return {
			kind: "RETURN",
			result: effectResult(job, `EFFECT_${begun.state}`),
		};
	}

	async function finishLiveEffect(
		job: LiveChannelJob,
		fence: LiveEffectFence,
		status: string,
		evidence: { providerResultId?: string } = {},
	): Promise<LiveChannelResult> {
		const landed = await markLiveEffectAcked(
			deps.prisma,
			fence.claim,
			new Date(deps.now()),
			evidence,
		);
		return effectResult(job, landed ? status : "EFFECT_ACK_FENCE_LOST");
	}

	async function failLiveEffect(
		job: LiveChannelJob,
		fence: LiveEffectFence,
		err: unknown,
	): Promise<LiveChannelResult> {
		const reason = redactSecrets(
			err instanceof Error ? err.message : String(err),
		);
		if (!fence.crossedSendBoundary) {
			await markLiveEffectFailed(deps.prisma, fence.claim, reason);
			throw err;
		}
		await markLiveEffectAmbiguous(
			deps.prisma,
			fence.claim,
			`${reason}; the provider/process call crossed its send boundary, so exact readback or operator resolution is required before retry`,
		);
		if (job.effect?.scheduleId) {
			await recordScheduleOutcomeBestEffort(
				deps.prisma,
				{ scheduleId: job.effect.scheduleId },
				"UNKNOWN",
				reason,
				new Date(deps.now()),
				"JOB_TERMINAL_UNKNOWN",
			);
		}
		return effectResult(job, "EFFECT_AMBIGUOUS");
	}

	/**
	 * The fenced write . Every persist during
	 * a provision matches the row only while `provisionClaimedAt` is still the
	 * value THIS worker last wrote — the same compare-and-swap the renewal
	 * uses — and reports whether it landed. The first cut fenced the claim and
	 * the renewal but wrote the step log, the provider encoding id and the
	 * RUNNING / ERROR finalize unconditionally, so a worker whose lease had
	 * been taken during a long SDK call could still land its late response on
	 * the winner's row. Leaving PROVISIONING (RUNNING or ERROR) releases the
	 * lease, as the VOD twin (#200) does; the run mirror follows only a
	 * landed write.
	 */
	async function persistFenced(
		liveChannelId: string,
		entries: StepLogEntry[],
		extra: Record<string, unknown>,
		fence: { heldAt: Date | null; setHeld: (next: Date | null) => void },
	): Promise<boolean> {
		const leaving = ["RUNNING", "ERROR", "STOPPING", "STOPPED"].includes(
			String(extra.status),
		);
		const next = leaving ? null : new Date(new Date(deps.now()).getTime());
		const { count } = await deps.prisma.liveChannel.updateMany({
			where: { id: liveChannelId, provisionClaimedAt: fence.heldAt },
			data: {
				stepLog: entries as unknown as Prisma.InputJsonValue,
				...extra,
				provisionClaimedAt: next,
			},
		});
		if (count === 0) {
			return false;
		}
		fence.setHeld(next);
		// Dual-write : the step log is the run's replay
		// record; the extras that are run facts ride along, the rest (e.g.
		// bitmovinAccountId) stay channel-only.
		const runExtra: Record<string, unknown> = {};
		for (const key of [
			"status",
			"error",
			"encoderIp",
			"streamKey",
			"runningSince",
			"bitmovinEncodingId",
		]) {
			if (key in extra) {
				runExtra[key] = extra[key];
			}
		}
		try {
			await runs.mirror(liveChannelId, {
				stepLog: entries as unknown as Prisma.InputJsonValue,
				...runExtra,
			});
		} catch (err) {
			// The paid-resource ownership barrier is the channel row above. Do not
			// collapse a later mirror failure into "the id was never persisted":
			// doing so authorizes compensation to delete an encoding the primary
			// database already owns. The next fenced step write retries the mirror.
			throw new LiveRunMirrorAfterPrimaryPersistError(err);
		}
		return true;
	}

	/**
	 * Replays the compiled step log up to AWAIT_LIVE_RUNNING, then finalizes:
	 * live details (streamKey/encoderIp columns — the ledgered redaction
	 * exception) + the C7 start-request snapshot onto the await entry, and
	 * status RUNNING. Finalize re-runs on resume even when every step is
	 * already DONE, so a crash between the last step and the status flip
	 * cannot strand a provisioned channel.
	 */
	async function provision(liveChannelId: string, cancelRunId?: string) {
		const owner: ResetOwnerState = {
			entityKey: `liveChannel:${liveChannelId}`,
			ownerToken: null,
			entries: [],
		};
		try {
			return await provisionOwned(liveChannelId, owner, cancelRunId);
		} finally {
			await finishResetOwner(
				deps,
				owner,
				async () =>
					!(await deps.prisma.liveChannel.findUnique({
						where: { id: liveChannelId },
						select: { id: true },
					})),
			);
		}
	}
	async function provisionOwned(
		liveChannelId: string,
		resetOwner: ResetOwnerState,
		cancelRunId?: string,
	): Promise<string | { status: "STOPPED"; canceledRunId: string }> {
		let row = await deps.prisma.liveChannel.findUnique({
			where: { id: liveChannelId },
		});
		if (!row) {
			console.warn(
				`[live-channel] channel ${liveChannelId} not found — skipping`,
			);
			return "MISSING";
		}
		const pendingRun = await deps.prisma.liveChannelRun.findFirst({
			where: { liveChannelId },
			orderBy: { seq: "desc" },
		});
		if (
			cancelRunId &&
			(pendingRun?.id !== cancelRunId ||
				!pendingRun.cancelRequested ||
				pendingRun.status === "STOPPED")
		)
			return "STALE_CANCEL";
		const cancelling =
			pendingRun?.cancelRequested === true && pendingRun.status !== "STOPPED";
		if (
			!cancelling &&
			row.status !== "CREATED" &&
			row.status !== "PROVISIONING"
		) {
			// Provision only runs on rows the create route left in CREATED or
			// a start action atomically claimed into PROVISIONING. Everything
			// else is skipped: RUNNING/STOPPING/STOPPED must never be
			// resurrected (restart is explicit), and ERROR means a failure
			// path or the dead-job sweep already released the claim — a stale
			// job re-running it would be the double-provision race.
			return row.status;
		}

		/**
		 * Take the provisioning LEASE, atomically. AKR-E57-003.
		 *
		 * The status check above is READ-THEN-ACT, and it accepts BOTH of the
		 * states the two enqueue paths produce — so it could never separate
		 * them. create enqueues `jobId: <channelId>` and leaves the row CREATED;
		 * a start arriving before that job runs atomically claims the row into
		 * PROVISIONING and enqueues its OWN job under a timestamped id that
		 * BullMQ cannot dedupe against the first. Both jobs then read an
		 * acceptable status and ran every op from CREATE_ENCODING, at live
		 * concurrency 8 — two complete encoding trees on one channel, writing
		 * the same output prefix, both billed. Codex reproduced it against the
		 * real API.
		 *
		 * `updateMany` is the lock: exactly one caller matches and gets
		 * `count === 1`. The loser returns the row's status and does nothing,
		 * which is correct for either loser — both jobs were asking for the same
		 * work, and the winner re-reads the row (a re-air's start rewrites the
		 * step log inside its own claim, and the winner picks that up).
		 *
		 * The lease EXPIRES rather than being released by name: a worker killed
		 * mid-provision would otherwise wedge the channel until someone cleared
		 * a column by hand. The window is deliberately longer than a provision
		 * takes and shorter than an operator's patience.
		 */
		// `deps.now` is an ISO STRING here, not epoch millis — the injected
		// clock this file uses everywhere else.
		const nowMs = new Date(deps.now()).getTime();
		const leaseCutoff = new Date(nowMs - PROVISION_LEASE_MS);
		const claimed = await deps.prisma.liveChannel.updateMany({
			where: {
				id: liveChannelId,
				...(cancelling && pendingRun
					? {
							liveEffectFenceVersion: row.liveEffectFenceVersion,
							runs: {
								some: { id: pendingRun.id, cancelRequested: true },
								none: { seq: { gt: pendingRun.seq } },
							},
						}
					: {}),
				status: {
					in: cancelling
						? ["CREATED", "PROVISIONING", "STOPPING", "ERROR", "RUNNING"]
						: ["CREATED", "PROVISIONING"],
				},
				OR: [
					{ provisionClaimedAt: null },
					{ provisionClaimedAt: { lt: leaseCutoff } },
				],
			},
			data: {
				provisionClaimedAt: new Date(nowMs),
				status: cancelling ? "STOPPING" : "PROVISIONING",
			},
		});
		if (claimed.count === 0) {
			// Another worker holds a live lease on this channel.
			return row.status;
		}
		resetOwner.ownerToken = new Date(nowMs).toISOString();
		/**
		 * RE-READ after winning. The snapshot above was taken BEFORE the claim.
		 *
		 * The first cut asserted "the winner re-reads the row" in both the
		 * comment and the commit message, and it did not: there was one
		 * `findUnique`, before the claim, and everything below parsed the plan
		 * and step log out of that stale snapshot. The start action rewrites
		 * the step log inside its OWN claim, and a re-air gets a fresh log
		 * rebased into its own subtree (#155) — so a job that read the row
		 * before that claim and won the lease after it would replay the OLD
		 * log, writing the new run's segments under the previous airing's
		 * prefix. Exactly what #155 exists to prevent.
		 *
		 * Review found it with a Prisma fake returning DETACHED clones; the
		 * harness here hands back the same object reference, and says so in its
		 * own docstring, so it could not have seen this.
		 */
		const claimedRow = await deps.prisma.liveChannel.findUnique({
			where: { id: liveChannelId },
		});
		if (!claimedRow) {
			return "MISSING";
		}
		row = claimedRow;

		/**
		 * Renew the lease on every poll tick, with the timestamp itself as the
		 * fencing token.
		 *
		 * A bare "refresh the timestamp" would be incoherent: with no owner, a
		 * worker whose lease had already gone stale would happily extend the
		 * lease of whoever took it, and both would keep working. So the renewal
		 * is a COMPARE-AND-SWAP — it only matches the row while
		 * `provisionClaimedAt` is still the value WE last wrote. When it stops
		 * matching, someone else owns this channel and we stop.
		 */
		let heldAt: Date | null = new Date(nowMs);
		// Every mutation of the timestamp fence shares one queue. `renewLease`
		// already coalesced two renewals, but a provider-id persist could still
		// race a ticker renewal with the same old token: whichever landed first
		// made the other look like ownership loss. Serializing both operations
		// preserves the CAS meaning — count=0 now means an external owner won,
		// never that this worker raced itself.
		let fenceTail: Promise<void> = Promise.resolve();
		const withFenceWrite = <T>(operation: () => Promise<T>): Promise<T> => {
			const result = fenceTail.then(operation, operation);
			fenceTail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		};
		// ONE renewal at a time : the poll seam and the SDK-call
		// ticker below both renew, and two compare-and-swaps issued against the
		// same token would make the second one read as a lost lease.
		let renewing: Promise<boolean> | null = null;
		const renewLease = (): Promise<boolean> => {
			if (renewing) {
				return renewing;
			}
			renewing = withFenceWrite(async () => {
				if (heldAt === null) {
					return false;
				}
				const next = new Date(new Date(deps.now()).getTime());
				const { count } = await deps.prisma.liveChannel.updateMany({
					where: { id: liveChannelId, provisionClaimedAt: heldAt },
					data: { provisionClaimedAt: next },
				});
				if (count === 0) {
					return false;
				}
				heldAt = next;
				resetOwner.ownerToken = next.toISOString();
				return true;
			}).finally(() => {
				renewing = null;
			});
			return renewing;
		};
		const fence = {
			get heldAt() {
				return heldAt;
			},
			setHeld: (next: Date | null) => {
				heldAt = next;
				if (next) resetOwner.ownerToken = next.toISOString();
			},
		};
		const persist = async (
			entries: StepLogEntry[],
			extra: Record<string, unknown> = {},
		): Promise<void> => {
			if (
				!(await withFenceWrite(() =>
					persistFenced(liveChannelId, entries, extra, fence),
				))
			) {
				throw new ProvisionLeaseLostError(liveChannelId);
			}
		};
		/**
		 * Renew across a long SDK call . The poll seam renews
		 * between polls; a create/start call that outlives the window had
		 * nothing renewing it, so a healthy worker could lose its lease to a
		 * takeover while its own call was still in flight. `stop` awaits the
		 * in-flight renewal so no compare-and-swap is pending when the next
		 * fenced write reads the token.
		 */
		let activeLeaseTicker: { readonly lost: boolean } | undefined;
		const startLeaseTicker = () => {
			const state = { lost: false, renewalFailed: false };
			const timer = setInterval(
				() => {
					void renewLease()
						.then((ok) => {
							if (!ok) {
								state.lost = true;
							}
						})
						.catch(() => {
							// A rejected CAS has an unknown commit outcome. Consume the
							// rejection (never an unhandled process-level failure) and make
							// the post-SDK gate fail closed exactly like count=0.
							state.renewalFailed = true;
							state.lost = true;
						});
				},
				deps.leaseRenewalIntervalMs ?? PROVISION_LEASE_MS / 3,
			);
			timer.unref?.();
			return {
				get lost() {
					return state.lost;
				},
				stop: async () => {
					clearInterval(timer);
					if (renewing) {
						try {
							await renewing;
						} catch {
							state.renewalFailed = true;
							state.lost = true;
						}
					}
					if (state.renewalFailed) {
						throw new ProvisionLeaseLostError(liveChannelId);
					}
				},
			};
		};

		// A queued cancellation with no attempted encoding CREATE has no paid
		// provider work to reclaim and must not depend on deleted credentials.
		if (cancelling && pendingRun && !row.bitmovinEncodingId) {
			const untouched = stepLogSchema.parse(row.stepLog);
			if (
				!untouched.some(
					(entry) =>
						entry.kind === "CREATE_ENCODING" &&
						(entry.startedAt || entry.resourceId),
				)
			) {
				const current = await deps.prisma.liveChannelRun.findFirst({
					where: { liveChannelId },
					orderBy: { seq: "desc" },
				});
				if (current?.id !== pendingRun.id || !current.cancelRequested)
					return "STALE_CANCEL";
				const feeders = await deps.prisma.feederSession.findMany({
					where: { liveChannelId, ...feederOccupancyWhere() },
					select: { id: true },
				});
				for (const feeder of feeders)
					await deps.enqueueFeederJob({
						feederSessionId: feeder.id,
						action: "stop",
					});
				await persist(untouched, {
					status: feeders.length ? "STOPPING" : "STOPPED",
					error: null,
				});
				if (feeders.length) return "STOPPING";
				await emitChannel("CHANNEL_STOPPED", liveChannelId);
				return { status: "STOPPED", canceledRunId: pendingRun.id };
			}
		}

		// Failures before the first step (corrupt plan, deleted account,
		// MASTER_KEY problems) must not strand the row in CREATED.
		let entries: StepLogEntry[];
		let sdk: SdkOps;
		let accountId: string;
		// , live half: same lifecycle as the VOD processor's pair —
		// set at step start, cleared on success AND in the catch.
		let stampStep: string | undefined;
		let stampAdopt = false;
		let cancelRecovery = false;
		let activeEntry: StepLogEntry | undefined;
		let isVerificationRun = false;
		try {
			const plan = liveChannelPlanSchema.parse(row.plan);
			entries = stepLogSchema.parse(row.stepLog);
			resetOwner.entries = entries;
			const verification = verificationCreateIdentity(
				row.verificationKey,
				row.verificationRequestSha256,
			);
			isVerificationRun = verification !== undefined;
			const resolvedAccountId =
				plan.bitmovin.accountId ?? row.bitmovinAccountId;
			if (!resolvedAccountId) {
				throw new Error("Plan carries no Bitmovin account id");
			}
			accountId = resolvedAccountId;
			resetOwner.accountId = accountId;
			const account = await deps.revealBitmovinAccount(accountId);
			sdk = deps.makeSdk({
				startControl: {
					check: async (attempted) => {
						if (activeLeaseTicker?.lost)
							throw new ProvisionLeaseLostError(liveChannelId);
						if (!(await renewLease()) || activeLeaseTicker?.lost)
							throw new ProvisionLeaseLostError(liveChannelId);
						const canceled = await shouldCancel();
						if (activeLeaseTicker?.lost)
							throw new ProvisionLeaseLostError(liveChannelId);
						if (canceled)
							throw new CancelRequested(stampStep ?? "start", !attempted);
					},
					sleep: deps.sleep,
				},
				apiKey: account.apiKey,
				tenantOrgId: account.tenantOrgId,
				bitmovinAccountId: accountId,
				stamp: {
					jobId: liveChannelId,
					currentStep: () => stampStep,
					adoptWindow: () => stampAdopt,
					allowCreate: () => !cancelRecovery,
					...(verification
						? {
								verification,
								onEncodingCreated: async (
									providerId: string,
									source: "created" | "adopted",
								) => {
									if (
										activeEntry?.kind !== "CREATE_ENCODING" ||
										activeEntry.status !== "RUNNING"
									) {
										throw new Error(
											"VERIFICATION_PROVIDER_ID_WITHOUT_ACTIVE_CREATE_STEP",
										);
									}
									activeEntry.resourceId = providerId;
									activeEntry.response = redactSecrets({
										providerId,
										source,
										durability: "PROVIDER_ID_PERSISTED",
									});
									try {
										await persist(entries, {
											bitmovinEncodingId: providerId,
											// rev431: a (re)written pointer voids any stop/CREATED
											// confirmation for it (see reset.ts unconfirmedFor).
											encoderStoppedConfirmedFor: null,
										});
									} catch (err) {
										if (err instanceof LiveRunMirrorAfterPrimaryPersistError) {
											activeEntry.response = redactSecrets({
												providerId,
												source,
												durability: "PROVIDER_ID_PERSISTED",
												runMirror: "PERSISTENCE_UNKNOWN_RETRY_PENDING",
											});
											console.warn(
												`[live-channel] ${liveChannelId}: provider id landed on the channel row; current-run mirror failed and will be retried by the next fenced persist`,
											);
											return "PERSISTED" as const;
										}
										if (err instanceof ProvisionLeaseLostError) {
											return "OWNERSHIP_LOST" as const;
										}
										if ((err as { code?: unknown })?.code === "P1001") {
											throw new VerificationProviderIdDefinitelyNotPersistedError(
												err,
											);
										}
										throw err;
									}
									return "PERSISTED" as const;
								},
							}
						: {}),
				},
			});
			resetOwner.sdk = sdk;
		} catch (err) {
			const message = err instanceof Error ? err.message : "setup failed";
			// Fenced like every other write past the claim (review-336 C2): a
			// worker that stalled inside revealBitmovinAccount past the lease
			// window and then failed must not stamp its stale ERROR over a
			// channel another worker has since driven to RUNNING. The lease is
			// released in the same write, exactly as the finalize-ERROR path.
			const marked = await deps.prisma.liveChannel.updateMany({
				where: { id: liveChannelId, provisionClaimedAt: heldAt },
				data: {
					status: "ERROR",
					error: redactSecrets(message),
					provisionClaimedAt: null,
				},
			});
			if (marked.count === 0) {
				console.warn(new ProvisionLeaseLostError(liveChannelId).message);
				return "PROVISIONING";
			}
			heldAt = null;
			// The run dies with its setup . The dead-job reaper
			// retires runs only for a channel whose flip it WON (review-336 C3),
			// and this path already moved the channel, so it mirrors the
			// terminal state itself.
			await runs.mirror(liveChannelId, {
				status: "ERROR",
				error: redactSecrets(message),
			});
			await emitChannel("CHANNEL_ERROR", liveChannelId, redactSecrets(message));
			throw err;
		}

		// Dual-write : make sure THIS provision has a run row
		// (lazy for pre-PR3 start paths — PR3 moves creation to the routes) and
		// mirror the transition onto it. The id is kept for the startup
		// sampler (re-deriving "latest" there leaned on
		// the one-live-per-channel index two modules away), and the attempt
		// clock anchors totalSeconds to THIS attempt (#3 — a resume keeps the
		// prior attempt's DONE stamps, so entries[0] is a cross-attempt clock).
		const currentRunId =
			cancelling && pendingRun
				? pendingRun.id
				: await runs.ensureCurrentRun(liveChannelId);
		const shouldCancel = async () => {
			const current = await deps.prisma.liveChannelRun.findFirst({
				where: { liveChannelId },
				orderBy: { seq: "desc" },
			});
			if (current?.id !== currentRunId)
				throw new ProvisionLeaseLostError(liveChannelId);
			return current.cancelRequested === true;
		};

		const attemptStartedAt = deps.now();
		const started = await deps.prisma.liveChannel.updateMany({
			where: { id: liveChannelId, provisionClaimedAt: heldAt },
			data: {
				status: "PROVISIONING",
				bitmovinAccountId: accountId,
				error: null,
			},
		});
		if (started.count === 0) {
			// Taken between the claim and this write: the winner's row is theirs.
			console.warn(new ProvisionLeaseLostError(liveChannelId).message);
			return "PROVISIONING";
		}
		// A (re)start clears confirmation; cancellation only tears down the
		// current encoding and must retain its exact existing stop proof.
		await runs.mirror(liveChannelId, {
			status: "PROVISIONING",
			...(!cancelling ? { encoderStoppedConfirmedFor: null } : {}),
		});

		/**
		 * a REVIVE replays DONE steps, and
		 * the encoding those steps created may have ENDED at the provider — the
		 * audited auto-shutdown. Every DONE step then skips, finalize reads the
		 * finished encoding's details (the GET still answers) and writes
		 * RUNNING over a dead encoder. So before trusting the log, ask the
		 * provider for exactly that encoding:
		 *
		 * - TERMINAL: the reconciler terminalises run + channel (the channel
		 * write is fenced on THIS lease and releases it), stops the run's
		 * feeders and emits; this provision fails with the terminal message.
		 * The next Start is a RE-AIR (the route reads `providerTerminalAt`).
		 * - UNKNOWN: refused with a retryable message, every id kept — the
		 * step log is not replayed against an encoding we cannot see.
		 * - RUNNING / TRANSITIONAL: the replay proceeds as before.
		 *
		 * A first provision (no DONE CREATE_ENCODING) has nothing to ask about.
		 */
		const reviveEncodingId = entries.find(
			(e) => e.kind === "CREATE_ENCODING" && e.status === "DONE",
		)?.resourceId;
		if (reviveEncodingId && !(await shouldCancel())) {
			const reviveRun =
				await actions.providerLifecycle.loadCurrentRun(liveChannelId);
			const verdict = await actions.providerLifecycle.reconcile({
				channel: row,
				run: reviveRun,
				encodingId: reviveEncodingId,
				sdk,
				channelWrite: {
					where: { provisionClaimedAt: heldAt },
					data: { provisionClaimedAt: null },
				},
			});
			if (verdict.lifecycle === "TERMINAL" || verdict.lifecycle === "UNKNOWN") {
				if (verdict.lifecycle === "TERMINAL" && verdict.status === "CANCELED") {
					if (!verdict.channelLanded) return "PROVISIONING";
					heldAt = null;
					return { status: "STOPPED", canceledRunId: currentRunId };
				}
				const reason =
					verdict.lifecycle === "TERMINAL"
						? (verdict.reason ?? "the provider reports the encoding ended")
						: `Provision refused: ${verdict.refusal} (${verdict.reason})`;
				if (!verdict.channelLanded) {
					// UNKNOWN, an already-terminalised run, or a channel pointer
					// that drifted: the channel still holds this lease, so it
					// leaves PROVISIONING through the same fenced ERROR write the
					// setup and finalize failures use — the lease released with it.
					const marked = await deps.prisma.liveChannel.updateMany({
						where: { id: liveChannelId, provisionClaimedAt: heldAt },
						data: {
							status: "ERROR",
							error: redactSecrets(reason),
							provisionClaimedAt: null,
						},
					});
					if (marked.count === 0) {
						console.warn(new ProvisionLeaseLostError(liveChannelId).message);
						return "PROVISIONING";
					}
					await runs.mirror(liveChannelId, {
						status: "ERROR",
						error: redactSecrets(reason),
					});
					if (!verdict.terminalised) {
						// The reconciler emits when IT terminalises; this arm is the
						// one with no emit yet.
						await emitChannel(
							"CHANNEL_ERROR",
							liveChannelId,
							redactSecrets(reason),
						);
					}
				}
				heldAt = null;
				await recordFailedStartupSample(
					deps.prisma,
					liveChannelId,
					"provider-lifecycle",
					currentRunId,
				);
				throw new Error(reason);
			}
		}

		// Stale-input guard (Bitmovin error 2025 at live/start). A failed provision
		// freezes the resolved RTMP input id into the encoding's input streams; on
		// a resume/retry the account-default RTMP input can now resolve to a
		// DIFFERENT id (a tenant/org change, or the input was re-provisioned), so
		// the frozen encoding references an input that no longer exists and start
		// fails forever. Re-resolve the account RTMP input and — ONLY when it
		// actually changed — rebuild from the input step onward (a fresh encoding
		// against the fresh input). Unchanged ⇒ normal resume, so a channel that
		// merely timed out at AWAIT_LIVE_RUNNING keeps its already-running encoding
		// instead of being needlessly recreated and orphaned. (RTMP only — the
		// resolve-by-list input; SRT/Zixi/HLS created inputs are a separate case.)
		const rtmpStep = entries.find((e) => e.kind === "CREATE_INPUT_RTMP");
		if (
			rtmpStep?.status === "DONE" &&
			rtmpStep.resourceId &&
			!(await shouldCancel())
		) {
			let freshRtmpId: string | undefined;
			try {
				const inputs = await sdk.listRtmpInputs();
				freshRtmpId = inputs.length === 1 ? inputs[0]?.id : undefined;
			} catch (err) {
				console.warn(
					`[live-channel] RTMP re-resolution for ${liveChannelId} failed:`,
					err instanceof Error ? err.message : err,
				);
			}
			if (freshRtmpId && freshRtmpId !== rtmpStep.resourceId) {
				const from = entries.indexOf(rtmpStep);
				for (let i = from; i < entries.length; i += 1) {
					const entry = entries[i];
					if (entry) {
						entries[i] = {
							...entry,
							status: "PENDING",
							resourceId: undefined,
							error: undefined,
							startedAt: undefined,
							finishedAt: undefined,
							// New stamp generation: the abandoned resources keep the
							// old `step#attempt` identity and can never be adopted
							// by this rebuild's re-looks .
							// ORDERING CONSTRAINT (review of PR #172, forward note):
							// `attempt` is the one MUTABLE component of the stamp
							// identity, so its safety is a write order — the bump must
							// be durably persisted BEFORE any create that stamps with
							// it, or a crash after the create would resume on the OLD
							// attempt and adopt the ABANDONED generation's resource.
							// Satisfied twice: the persist directly below this loop,
							// and the per-step RUNNING persist that precedes every
							// executeStep (the same write crash-detection itself needs).
							// PRECISION (review follow-up): that redundancy fail-safes
							// part 1 only — losing the RUNNING persist kills the window
							// and with it window-gated adoption. Part 3's re-look is
							// UNCONDITIONAL by design (the stamp rode the failed POST)
							// and has no second gate: it reads whatever attempt was
							// last persisted. With BOTH persists gone, a resumed
							// create that FAILS re-looks on the stale attempt and
							// adopts the abandoned generation — fail-wrong, not
							// fail-safe. Do not remove these writes on the strength
							// of "the window breaks first"; it does not cover part 3.
							attempt: (entry.attempt ?? 0) + 1,
						};
					}
				}
				// Drop the stale encoding pointer; CREATE_ENCODING re-run resets it.
				// Crash-safe: the row stays PROVISIONING with a half-PENDING log and
				// a null encoding id — a crash here just re-resolves and continues on
				// the next resume, and no concurrent action can fire (stop/restart
				// require RUNNING and read the column, not the step log).
				await persist(entries, { bitmovinEncodingId: null });
			}
		}

		const ids = new Map<string, string>();
		for (const entry of entries) {
			if (entry.status === "DONE" && entry.resourceId) {
				ids.set(entry.step, entry.resourceId);
			}
		}

		const ctx = {
			sdk,
			ids,
			resolveCredential: deps.resolveCredential,
			shouldCancel,
			poll: {
				intervalMs: deps.pollIntervalMs,
				timeoutMs: deps.pollTimeoutMs,
				// Webhook wake  — same seam as the VOD
				// orchestrator; absent wakeSleep ⇒ identical fixed poll.
				// Built by the extracted seam (review-186 I1).
				// Heartbeat on the same tick the poll already waits for, so a
				// provision that legitimately runs past the staleness window
				// (Osaka's median is 589.5s; see PROVISION_LEASE_MS) keeps its
				// lease, while a dead worker's stops being renewed at once.
				sleep: (async (ms: number) => {
					await pollSleepFor(deps, ids)(ms);
					if (!(await renewLease())) {
						throw new ProvisionLeaseLostError(liveChannelId);
					}
				}) as (ms: number) => Promise<void>,
			},
		};

		const finishCancellation = async (): Promise<
			string | { status: "STOPPED"; canceledRunId: string }
		> => {
			try {
				if (!(await shouldCancel()) || !(await renewLease()))
					throw new ProvisionLeaseLostError(liveChannelId);
				const encoding = entries.find((e) => e.kind === "CREATE_ENCODING");
				if (encoding && !encoding.resourceId && encoding.startedAt) {
					// A response-lost CREATE may exist remotely. Reconcile its stamp;
					// allowCreate=false forbids accidentally creating during teardown.
					stampStep = encoding.attempt
						? `${encoding.step}#${encoding.attempt}`
						: encoding.step;
					stampAdopt = true;
					cancelRecovery = true;
					// Verification adoption crosses the same durable provider-id barrier
					// as CREATE: the ownership callback requires its active RUNNING step.
					const previousActiveEntry = activeEntry;
					activeEntry = encoding;
					encoding.status = "RUNNING";
					let result: Awaited<ReturnType<typeof executeStep>>;
					try {
						result = await executeStep(encoding, ctx, { wasRunning: true });
					} finally {
						activeEntry = previousActiveEntry;
					}
					encoding.resourceId = result.resourceId;
					encoding.status = "DONE";
					if (result.resourceId) ids.set(encoding.step, result.resourceId);
					await persist(entries, { bitmovinEncodingId: result.resourceId });
				}
				const encodingId = encoding?.resourceId ?? row.bitmovinEncodingId;
				const feeders = await deps.prisma.feederSession.findMany({
					where: {
						liveChannelId,
						OR: [
							feederOccupancyWhere(),
							{ status: { in: [...FEEDER_ACTIVE_STATUSES] } },
						],
					},
					select: { id: true },
				});
				for (const feeder of feeders)
					await deps.enqueueFeederJob({
						feederSessionId: feeder.id,
						action: "stop",
					});
				let confirmed = false;
				if (encodingId) {
					// Re-read after feeder awaits. Trusted stop/CREATED/reset absence
					// proof applies only to this exact current encoding, never a re-air.
					const [current, channel] = await Promise.all([
						deps.prisma.liveChannelRun.findFirst({
							where: { liveChannelId },
							orderBy: { seq: "desc" },
							select: {
								id: true,
								cancelRequested: true,
								bitmovinEncodingId: true,
								encoderStoppedConfirmedFor: true,
							},
						}),
						deps.prisma.liveChannel.findUnique({
							where: { id: liveChannelId },
							select: {
								bitmovinEncodingId: true,
								encoderStoppedConfirmedFor: true,
								provisionClaimedAt: true,
								liveEffectFenceVersion: true,
							},
						}),
					]);
					confirmed =
						current?.id === currentRunId &&
						current.cancelRequested &&
						current.bitmovinEncodingId === encodingId &&
						current.encoderStoppedConfirmedFor === encodingId &&
						channel?.bitmovinEncodingId === encodingId &&
						channel.encoderStoppedConfirmedFor === encodingId &&
						heldAt !== null &&
						channel.provisionClaimedAt?.getTime() === heldAt.getTime() &&
						channel.liveEffectFenceVersion === row.liveEffectFenceVersion;
				}
				if (encodingId && !confirmed) {
					let task = await sdk.getEncodingStatus(encodingId);
					const startAttempted = entries.some(
						(e) => e.kind === "START_LIVE_ENCODING" && e.startedAt,
					);
					if (
						!(task.status === "CREATED" && !startAttempted) &&
						!STOP_TERMINAL_STATUSES.includes(task.status)
					) {
						if (!(await renewLease()) || !(await shouldCancel()))
							throw new ProvisionLeaseLostError(liveChannelId);
						await sdk.stopLiveEncoding(encodingId);
						for (let attempt = 0; attempt < 6; attempt++) {
							task = await sdk.getEncodingStatus(encodingId);
							if (STOP_TERMINAL_STATUSES.includes(task.status)) break;
							await deps.sleep(deps.pollIntervalMs);
							if (!(await renewLease()))
								throw new ProvisionLeaseLostError(liveChannelId);
						}
						if (!STOP_TERMINAL_STATUSES.includes(task.status))
							throw new Error("Provider stop is not yet confirmed");
					}
					await deps.prisma.liveChannelRun.updateMany({
						where: { id: currentRunId, cancelRequested: true },
						data: {
							encoderStoppedConfirmedFor: encodingId,
							providerStatus: task.status,
							providerStatusObservedAt: new Date(deps.now()),
						},
					});
				}
				const occupied = await deps.prisma.feederSession.findFirst({
					where: { liveChannelId, ...feederOccupancyWhere() },
					select: { id: true },
				});
				if (occupied)
					throw new Error("Feeder termination is not yet confirmed");
				if (!(await shouldCancel()))
					throw new ProvisionLeaseLostError(liveChannelId);
				await persist(entries, {
					status: "STOPPED",
					error: null,
					...(encodingId ? { encoderStoppedConfirmedFor: encodingId } : {}),
				});
				await emitChannel("CHANNEL_STOPPED", liveChannelId);
				return { status: "STOPPED", canceledRunId: currentRunId };
			} catch (error) {
				if (error instanceof ProvisionLeaseLostError) return "STOPPING";
				await persist(entries, {
					status: "STOPPING",
					error: redactSecrets(
						`Cancellation pending: ${error instanceof Error ? error.message : "cleanup is not yet confirmed"}`,
					),
				});
				return "STOPPING";
			} finally {
				stampStep = undefined;
				stampAdopt = false;
				cancelRecovery = false;
			}
		};

		try {
			for (const entry of entries) {
				if (await shouldCancel()) return finishCancellation();
				// Kind first, status second. A runtime record is BY DEFINITION not
				// executable, and its status is not a reliable signal: the stale-RTMP
				// guard above re-seeds everything from the RTMP step to the end of the
				// array to PENDING, and records are appended at the end — so a DONE
				// cue, SLATE or ESAM entry can arrive here as PENDING through no
				// author's mistake, and executeStep would then throw and wedge the
				// channel on every subsequent Start (review catch). Slate was named
				// last and was the one that actually wedged channels: it was missing
				// from this sentence for as long as it was missing from the set.
				if (isRuntimeRecordKind(entry.kind)) {
					continue;
				}
				if (entry.status === "DONE") {
					continue;
				}
				// RUNNING = a previous attempt crashed between the SDK call and
				// the DONE write; START_LIVE_ENCODING then verifies the encoding
				// status before re-starting (same wedge prevention as VOD).
				const wasRunning = entry.status === "RUNNING";
				const hadStartAttempt = entry.startedAt !== undefined;
				const wasVerificationCreateAttempt =
					isVerificationRun &&
					entry.kind === "CREATE_ENCODING" &&
					(entry.startedAt !== undefined || entry.finishedAt !== undefined);
				entry.status = "RUNNING";
				entry.startedAt = deps.now();
				entry.error = undefined;
				await persist(entries);

				try {
					activeEntry = entry;
					stampStep = entry.attempt
						? `${entry.step}#${entry.attempt}`
						: entry.step;
					// ERROR-resume reseeds FAILED/RUNNING to PENDING while retaining
					// timing. A verification CREATE with that history may already
					// exist at the provider and must reconcile by exact marker first.
					stampAdopt = wasRunning || wasVerificationCreateAttempt;
					const ticker = startLeaseTicker();
					activeLeaseTicker = ticker;
					let result: Awaited<ReturnType<typeof executeStep>>;
					try {
						result = await executeStep(entry, ctx, { wasRunning });
					} finally {
						try {
							await ticker.stop();
						} finally {
							activeLeaseTicker = undefined;
						}
					}
					// Preserve a late CREATE result before the ownership fence rejects persistence.
					if (entry.kind === "CREATE_ENCODING" && result.resourceId)
						entry.resourceId = result.resourceId;
					if (ticker.lost) {
						throw new ProvisionLeaseLostError(liveChannelId);
					}
					stampStep = undefined;
					stampAdopt = false;
					activeEntry = undefined;
					entry.status = "DONE";
					entry.finishedAt = deps.now();
					entry.resourceId = result.resourceId;
					entry.request = redactSecrets(result.request);
					const providerBarrierEvidence =
						typeof entry.response === "object" &&
						entry.response !== null &&
						"runMirror" in entry.response
							? (entry.response as Record<string, unknown>)
							: undefined;
					entry.response = redactSecrets(result.response);
					if (providerBarrierEvidence) {
						const body =
							typeof entry.response === "object" && entry.response !== null
								? (entry.response as Record<string, unknown>)
								: { result: entry.response };
						entry.response = redactSecrets({
							...body,
							providerBarrier: providerBarrierEvidence,
						});
					}
					if (result.resourceId) {
						ids.set(entry.step, result.resourceId);
					}
					const extra =
						entry.kind === "CREATE_ENCODING" && result.resourceId
							? {
									bitmovinEncodingId: result.resourceId,
									// rev431: see the early persist above — same reason.
									encoderStoppedConfirmedFor: null,
								}
							: {};
					await persist(entries, extra);
				} catch (err) {
					if (await shouldCancel()) {
						if (
							err instanceof CancelRequested &&
							err.beforeSend &&
							!hadStartAttempt
						) {
							entry.startedAt = undefined;
							entry.status = "PENDING";
						}
						return finishCancellation();
					}
					stampStep = undefined;
					stampAdopt = false;
					activeEntry = undefined;
					if (
						err instanceof ProvisionLeaseLostError ||
						err instanceof VerificationProviderOwnershipLostError
					) {
						// Not a step failure. Re-raise BEFORE anything below runs:
						// marking ERROR, stamping a FAILED startup sample, emitting
						// CHANNEL_ERROR and persisting THIS run's now-stale entries
						// would all land on a channel another worker is provisioning
						// correctly .
						throw err instanceof ProvisionLeaseLostError
							? err
							: new ProvisionLeaseLostError(liveChannelId);
					}
					const message = err instanceof Error ? err.message : "step failed";
					if (err instanceof LiveEncodingCanceled) {
						// The await condition was not reached. Preserve the provider's
						// response, but do not mark the channel or startup sample ERROR.
						entry.status = "FAILED";
						entry.finishedAt = deps.now();
						entry.error = redactSecrets(message);
						entry.response = redactSecrets(err.task);
						await persist(entries);
						const run =
							await actions.providerLifecycle.loadCurrentRun(liveChannelId);
						if (run?.id !== currentRunId)
							throw new ProvisionLeaseLostError(liveChannelId);
						const verdict = await withFenceWrite(() =>
							actions.providerLifecycle.reconcile({
								channel: row,
								run,
								encodingId: err.encodingId,
								sdk,
								observation: {
									ok: true,
									status: "CANCELED",
									observedAt: deps.now(),
								},
								channelWrite: {
									where: { provisionClaimedAt: heldAt },
									data: { provisionClaimedAt: null },
								},
							}),
						);
						if (!verdict.channelLanded)
							throw new ProvisionLeaseLostError(liveChannelId);
						heldAt = null;
						return { status: "STOPPED", canceledRunId: currentRunId };
					}
					if (err instanceof VerificationProviderIdPersistenceError) {
						// Preserve the exact provider id and structured compensation
						// outcome in the failure-path DB write. If delete succeeded,
						// restart recovery still requires a direct provider 404 before it
						// may close this resource; an empty marker scan is not enough.
						entry.resourceId = err.providerId;
						entry.response = redactSecrets({
							providerId: err.providerId,
							source: err.source,
							durability: err.durability,
							compensation: err.compensation,
						});
					}
					entry.status = "FAILED";
					entry.finishedAt = deps.now();
					entry.error = redactSecrets(message);
					// One channel = ONE encoding: no stop-siblings here (the VOD
					// multi-encoding ladder concern does not exist for live).
					await persist(entries, {
						status: "ERROR",
						error: redactSecrets(message),
					});
					//  PR1: provisional failure sample (create-if-absent;
					// the reconciler re-covers a write this dying job loses).
					await recordFailedStartupSample(
						deps.prisma,
						liveChannelId,
						entry.step,
						currentRunId,
					);
					await emitChannel(
						"CHANNEL_ERROR",
						liveChannelId,
						redactSecrets(message),
					);
					throw err;
				}
			}
		} catch (err) {
			if (err instanceof ProvisionLeaseLostError) {
				/**
				 * Another worker owns this channel. Return QUIETLY — exactly as
				 * the top-of-function loser does when its claim finds count 0.
				 *
				 * Not rethrown, because BullMQ's `failed` handler flips any row
				 * in CREATED/PROVISIONING/STOPPING to ERROR and retires its
				 * transitional runs, with no attemptsMade guard — so a rethrow
				 * here would have the LOSER mark the WINNER's row broken and
				 * retire the winner's run out from under it.
				 */
				console.warn(err.message);
				return "PROVISIONING";
			}
			throw err;
		}

		if (await shouldCancel()) return finishCancellation();
		// Finalize: the channel reached RUNNING (AWAIT_LIVE_RUNNING is the
		// last compiled op). Read back where to point the encoder and the
		// submitted start request (C7 — Bitmovin purges after ~90 days).
		try {
			const encodingEntry = entries.find((e) => e.kind === "CREATE_ENCODING");
			const encodingId = encodingEntry?.resourceId;
			if (!encodingId) {
				throw new Error("Step log carries no CREATE_ENCODING resource id");
			}
			/**
			 * RUNNING is written only from a FRESH readback of exactly
			 * this encoding — a details GET is not a lifecycle observation (it
			 * answers for a FINISHED encoding too, which is how the audited
			 * revive greened). A terminal answer is reconciled onto run + channel
			 * (lease released in the same write) and the finalize fails with the
			 * terminal message; an unreadable one fails retryably through the
			 * catch below, every id kept.
			 */
			const fresh = await actions.providerLifecycle.observe(sdk, encodingId);
			const freshLifecycle = classifyProviderLifecycle(
				fresh,
				new Date(fresh.observedAt).getTime(),
			);
			if (freshLifecycle === "TERMINAL") {
				const verdict = await actions.providerLifecycle.reconcile({
					channel: row,
					run: await actions.providerLifecycle.loadCurrentRun(liveChannelId),
					encodingId,
					sdk,
					observation: fresh,
					channelWrite: {
						where: { provisionClaimedAt: heldAt },
						data: { provisionClaimedAt: null },
					},
				});
				const reason =
					verdict.reason ?? "the provider reports the encoding ended";
				if (verdict.channelLanded) {
					heldAt = null;
					if (verdict.status === "CANCELED")
						return { status: "STOPPED", canceledRunId: currentRunId };
					throw new ProviderLifecycleRefusal(reason);
				}
				// Not terminalised here (already stamped, or the pointer drifted):
				if (verdict.status === "CANCELED")
					throw new ProvisionLeaseLostError(liveChannelId);
				// the ordinary fenced-ERROR arm below carries the message.
				throw new Error(reason);
			}
			if (freshLifecycle !== "RUNNING") {
				throw new Error(
					`the encoding did not read back RUNNING at finalize (${
						fresh.ok ? fresh.status : fresh.error
					}) — start the channel again to retry`,
				);
			}
			const live = await sdk.getLiveEncodingDetails(encodingId);
			const startRequest = await sdk.getLiveStartRequest(encodingId);
			// Details and the C7 start-request snapshot are independent GETs and can
			// be slow. Re-observe after both: the earlier RUNNING word must not green
			// an encoding that ended or became unreadable while they were in flight.
			const finalObservation = await actions.providerLifecycle.observe(
				sdk,
				encodingId,
			);
			if (await shouldCancel()) return finishCancellation();
			const finalLifecycle = classifyProviderLifecycle(
				finalObservation,
				new Date(finalObservation.observedAt).getTime(),
			);
			const finalRun =
				await actions.providerLifecycle.loadCurrentRun(liveChannelId);
			if (finalLifecycle !== "RUNNING") {
				const verdict = await actions.providerLifecycle.reconcile({
					channel: row,
					run: finalRun,
					encodingId,
					sdk,
					observation: finalObservation,
					channelWrite: {
						where: {
							status: { in: ["PROVISIONING"] },
							provisionClaimedAt: heldAt,
						},
						data: { provisionClaimedAt: null },
					},
				});
				const reason =
					verdict.lifecycle === "TERMINAL"
						? (verdict.reason ??
							"the provider reports the encoding ended during finalize")
						: `the encoding did not read back RUNNING after finalize details (${verdict.reason ?? verdict.status ?? "no status"}) — start the channel again to retry`;
				if (verdict.lifecycle === "TERMINAL" && verdict.channelLanded) {
					heldAt = null;
					if (verdict.status === "CANCELED")
						return { status: "STOPPED", canceledRunId: currentRunId };
					throw new ProviderLifecycleRefusal(reason);
				}
				if (verdict.lifecycle === "TERMINAL" && verdict.status === "CANCELED")
					throw new ProvisionLeaseLostError(liveChannelId);
				throw new Error(reason);
			}
			const awaitEntry = entries.find((e) => e.kind === "AWAIT_LIVE_RUNNING");
			if (awaitEntry) {
				// Snapshots stay redacted (streamKey masked here); the COLUMNS
				// carry the readable values — the ledgered exception.
				awaitEntry.response = redactSecrets({
					...(typeof awaitEntry.response === "object" &&
					awaitEntry.response !== null
						? awaitEntry.response
						: {}),
					live,
					startRequest,
				});
			}
			const finalizeLease = heldAt;
			if (finalizeLease === null) {
				throw new ProvisionLeaseLostError(liveChannelId);
			}
			const committed = await withFenceWrite(() =>
				actions.providerLifecycle.commitRunning({
					channel: row,
					run: finalRun,
					encodingId,
					observation: finalObservation,
					coordinates: live,
					provisionClaimedAt: finalizeLease,
					stepLog: entries as unknown as Prisma.InputJsonValue,
				}),
			);
			if (!committed) {
				// Cancellation can win after the last pre-finalize check while this
				// worker still owns the lease. Reuse its exact-run cleanup now rather
				// than abandoning a live lease for the recovery sweep to expire.
				if (await shouldCancel()) return finishCancellation();
				throw new ProvisionLeaseLostError(liveChannelId);
			}
			heldAt = null;
			//  PR1: the ONLY success sampler — provision finalize.
			// The restart path also writes RUNNING but reuses a live encoding
			// (seconds, not a startup) and must never sample.
			await recordRunningStartupSample(deps.prisma, liveChannelId, entries, {
				runId: currentRunId,
				attemptStartedAt,
			});
			await emitChannel("CHANNEL_RUNNING", liveChannelId);
		} catch (err) {
			if (err instanceof ProvisionLeaseLostError) {
				// The RUNNING finalize itself was refused: another worker owns the
				// row now, and marking it ERROR would be the loser writing over
				// the winner .
				console.warn(err.message);
				return "PROVISIONING";
			}
			if (err instanceof ProviderLifecycleRefusal) {
				// : the reconciler already moved run + channel (lease
				// released) and emitted CHANNEL_ERROR; only the startup sample and
				// the rethrow remain — a second ERROR write would need a lease this
				// worker no longer holds, and a second emit would page twice.
				await recordFailedStartupSample(
					deps.prisma,
					liveChannelId,
					"finalize",
					currentRunId,
				);
				throw err;
			}
			const message = err instanceof Error ? err.message : "finalize failed";
			const marked = await deps.prisma.liveChannel.updateMany({
				where: { id: liveChannelId, provisionClaimedAt: heldAt },
				data: {
					status: "ERROR",
					error: redactSecrets(message),
					provisionClaimedAt: null,
				},
			});
			if (marked.count === 0) {
				console.warn(new ProvisionLeaseLostError(liveChannelId).message);
				return "PROVISIONING";
			}
			heldAt = null;
			// review-242 A1: THE terminal mirror. Unmirrored, the run stayed
			// non-terminal forever — permanently occupying the one-live-run
			// index, so ensureCurrentRun returns it for every later start and
			// PR3's re-airs would merge onto the old row (seq never advances).
			await runs.mirror(liveChannelId, {
				status: "ERROR",
				error: redactSecrets(message),
			});
			//  PR1: finalize deaths are startup failures too.
			await recordFailedStartupSample(
				deps.prisma,
				liveChannelId,
				"finalize",
				currentRunId,
			);
			await emitChannel("CHANNEL_ERROR", liveChannelId, redactSecrets(message));
			throw err;
		}
		return "RUNNING";
	}

	/**
	 * (row 266) — the run-generation fence for a
	 * scheduled action retrying INSIDE the queue.
	 *
	 * A scheduled feeder/slate/stop job carries the run it was PLANNED for
	 * (`plannedLiveChannelRunId`, stamped by the sweep at dispatch). A BullMQ
	 * backoff or a stalled-job re-run can deliver that job AFTER the channel
	 * has stopped and RE-AIRED onto a new run; acting then would push a
	 * previous airing's source, slate or stop onto the CURRENT run's ingest —
	 * the audited case. Row 241's generation check runs at FIRE time and
	 * cannot see a job that turns stale after it was enqueued, so the same
	 * comparison is repeated HERE, at execution time, before the effect.
	 *
	 * Fail-open exactly as core `isStaleGeneration` does: a legacy job or a
	 * manual (non-scheduler) action with no planned run — and a channel with
	 * no run rows at all — is NOT refused.
	 *
	 * On a real mismatch the schedule row is terminated
	 * SKIPPED_STALE_GENERATION with a TERMINAL outcome (never left PENDING —
	 * row 263's lesson), and the caller does NOTHING. Returns whether it
	 * refused.
	 */
	async function refuseStaleQueuedGeneration(
		liveChannelId: string,
		plannedLiveChannelRunId: string | null | undefined,
		target: { scheduleId: string } | { channelStop: string },
	): Promise<boolean> {
		if (plannedLiveChannelRunId == null) {
			return false;
		}
		const currentRun = await deps.prisma.liveChannelRun.findFirst({
			where: { liveChannelId },
			orderBy: { seq: "desc" },
			select: { id: true },
		});
		if (!isStaleGeneration(plannedLiveChannelRunId, currentRun?.id ?? null)) {
			return false;
		}
		const at = new Date(deps.now());
		const note =
			`armed for run ${plannedLiveChannelRunId}, but this channel is now on ` +
			`run ${currentRun?.id ?? "none"} — the queued job outlived its airing ` +
			`and was refused rather than run against a different one`;
		await transitionScheduleToStale(deps.prisma, { ...target, note, at });
		return true;
	}

	return async function process(jobData: unknown): Promise<LiveChannelResult> {
		const job = liveChannelJobSchema.parse(jobData);
		const { liveChannelId } = job;
		// (row 266): the terminal result a run-acting
		// action returns when the fence refuses it — the job is acknowledged
		// (BullMQ must not retry a correct refusal) but nothing was done.
		const staleGenerationResult = (): LiveChannelResult => ({
			acknowledged: true,
			liveChannelId,
			action: job.action,
			status: "SKIPPED_STALE_GENERATION",
		});
		switch (job.action) {
			case "provision": {
				/**
				 * , review-350 HIGH-2: the scheduled START's DELIVERY.
				 *
				 * Plain START is the most common scheduled action and was the one
				 * with no outcome writer at all, so every successful scheduled
				 * start rendered permanently amber ("fired, outcome not
				 * confirmed") — the panel reading the outcome was right; the
				 * missing writer was the defect.
				 *
				 * Written HERE, at the job boundary, rather than at the three
				 * places inside `provision` that land RUNNING or ERROR: this is
				 * the one point that sees the whole verdict, and the three
				 * internal sites would each need the same call with the same
				 * chance of one being forgotten. `PROVISIONING` deliberately
				 * writes NOTHING — it means the lease was lost to another worker,
				 * and that worker's own return is what will answer for this row.
				 */
				let result: Awaited<ReturnType<typeof provision>>;
				try {
					result = await provision(
						liveChannelId,
						liveStartupCancelParamsSchema.parse(job.params ?? {}).cancelRunId,
					);
				} catch (err) {
					await recordScheduleOutcomeBestEffort(
						deps.prisma,
						{ channelStart: liveChannelId },
						"FAILED",
						redactSecrets(
							err instanceof Error ? err.message : "provision failed",
						),
						new Date(deps.now()),
						"EFFECT_FAILED",
					);
					throw err;
				}
				const status = typeof result === "string" ? result : result.status;
				if (status === "RUNNING") {
					await recordScheduleOutcomeBestEffort(
						deps.prisma,
						{ channelStart: liveChannelId },
						"DELIVERED",
						`the channel reached RUNNING`,
						new Date(deps.now()),
						"PROVIDER_RUNNING",
					);
				}
				// A skipped STOPPED redelivery is not a newly canceled startup.
				if (typeof result !== "string") {
					await recordScheduleOutcomeBestEffort(
						deps.prisma,
						{
							canceledChannelStart: {
								liveChannelId,
								liveChannelRunId: result.canceledRunId,
							},
						},
						"FAILED",
						"the channel stopped before startup completed",
						new Date(deps.now()),
						"EFFECT_FAILED",
					);
				}
				return {
					acknowledged: true,
					liveChannelId,
					action: job.action,
					status,
				};
			}
			case "stop": {
				const staleStopTarget = job.effect?.scheduleId
					? ({ scheduleId: job.effect.scheduleId } as const)
					: ({ channelStop: liveChannelId } as const);
				if (
					await refuseStaleQueuedGeneration(
						liveChannelId,
						job.plannedLiveChannelRunId,
						staleStopTarget,
					)
				) {
					return staleGenerationResult();
				}
				const prepared = await prepareLiveEffect(
					job,
					"STOP",
					["RUNNING", "STOPPING", "ERROR", "STOPPED"],
					{ supersedeOpen: true },
				);
				if (prepared.kind === "RETURN") return prepared.result;
				try {
					await actions.stopChannel(liveChannelId, prepared.fence);
					const stopped = await deps.prisma.liveChannel.findUnique({
						where: { id: liveChannelId },
						select: { status: true, error: true },
					});
					if (stopped?.status !== "STOPPED" || stopped.error !== null) {
						await markLiveEffectAmbiguous(
							deps.prisma,
							prepared.fence.claim,
							stopped?.error ?? "the channel did not reach confirmed STOPPED",
						);
						return effectResult(job, "EFFECT_AMBIGUOUS");
					}
					const resolved = await resolveLiveEffectsAfterConfirmedStop(
						deps.prisma,
						{
							liveChannelId,
							liveChannelRunId: prepared.fence.claim.liveChannelRunId,
							providerEncodingId: prepared.fence.claim.providerEncodingId,
							stopClaimId: prepared.fence.claim.id,
							stopIdempotencyKey: prepared.fence.claim.idempotencyKey,
							at: new Date(deps.now()),
						},
					);
					if (resolved.kind === "BLOCKED") {
						await markLiveEffectAmbiguous(
							deps.prisma,
							prepared.fence.claim,
							resolved.reason,
						);
						return effectResult(job, "EFFECT_AMBIGUOUS");
					}
					return effectResult(job, "STOPPED");
				} catch (err) {
					return failLiveEffect(job, prepared.fence, err);
				} finally {
					await acknowledgeResetEffect(prepared.fence);
				}
			}
			case "restart": {
				const prepared = await prepareLiveEffect(job, "RESTART", [
					"PROVISIONING",
				]);
				if (prepared.kind === "RETURN") return prepared.result;
				try {
					await actions.restartChannel(liveChannelId, prepared.fence);
					return finishLiveEffect(job, prepared.fence, "RUNNING");
				} catch (err) {
					return failLiveEffect(job, prepared.fence, err);
				} finally {
					await acknowledgeResetEffect(prepared.fence);
				}
			}
			case "update-rtmp-ingest": {
				const prepared = await prepareLiveEffect(job, "RTMP_INGEST_UPDATE", [
					"RUNNING",
				]);
				if (prepared.kind === "RETURN") return prepared.result;
				try {
					await actions.updateRtmpIngest(
						liveChannelId,
						liveRtmpIngestParamsSchema.parse(job.params),
						job.effect?.requestSha256,
						prepared.fence,
					);
					return finishLiveEffect(job, prepared.fence, "RUNNING");
				} catch (err) {
					return failLiveEffect(job, prepared.fence, err);
				} finally {
					await acknowledgeResetEffect(prepared.fence);
				}
			}
			case "update-auto-shutdown": {
				const prepared = await prepareLiveEffect(job, "AUTO_SHUTDOWN_UPDATE", [
					"RUNNING",
				]);
				if (prepared.kind === "RETURN") return prepared.result;
				try {
					await actions.updateAutoShutdown(
						liveChannelId,
						liveAutoShutdownUpdateParamsSchema.parse(job.params),
						job.effect?.requestSha256,
						prepared.fence,
					);
					return finishLiveEffect(job, prepared.fence, "RUNNING");
				} catch (err) {
					return failLiveEffect(job, prepared.fence, err);
				} finally {
					await acknowledgeResetEffect(prepared.fence);
				}
			}
			case "reset-timeshift": {
				const prepared = await prepareLiveEffect(job, "TIMESHIFT_RESET", [
					"RUNNING",
				]);
				if (prepared.kind === "RETURN") return prepared.result;
				try {
					await actions.resetTimeshift(
						liveChannelId,
						liveResetTimeshiftParamsSchema.parse(job.params ?? {}),
						prepared.fence,
					);
					return finishLiveEffect(job, prepared.fence, "RUNNING");
				} catch (err) {
					return failLiveEffect(job, prepared.fence, err);
				} finally {
					await acknowledgeResetEffect(prepared.fence);
				}
			}
			case "scte35": {
				const prepared = await prepareLiveEffect(job, "SCTE35", ["RUNNING"]);
				if (prepared.kind === "RETURN") return prepared.result;
				try {
					const providerCue = await actions.insertScte35(
						liveChannelId,
						liveScte35ParamsSchema.parse(job.params),
						prepared.fence,
					);
					return finishLiveEffect(job, prepared.fence, "RUNNING", {
						...(providerCue.id ? { providerResultId: providerCue.id } : {}),
					});
				} catch (err) {
					return failLiveEffect(job, prepared.fence, err);
				} finally {
					await acknowledgeResetEffect(prepared.fence);
				}
			}
			case "insert-content": {
				//  (slate insertion): fired by the scheduler sweep — the sweep
				// never touches Bitmovin; this action is the only slate writer.
				const params = liveInsertContentParamsSchema.parse(job.params);
				// (row 266): a scheduled slate additionally
				// names its schedule row for stale-outcome repair. SC-01 binds both
				// scheduled and manual insertion to the exact run/provider fence.
				if (
					params.scheduleId !== undefined &&
					(await refuseStaleQueuedGeneration(
						liveChannelId,
						job.plannedLiveChannelRunId,
						{ scheduleId: params.scheduleId },
					))
				) {
					return staleGenerationResult();
				}
				const prepared = await prepareLiveEffect(job, "SLATE_INSERT", [
					"RUNNING",
				]);
				if (prepared.kind === "RETURN") return prepared.result;
				try {
					await actions.insertContent(liveChannelId, params, prepared.fence);
					return finishLiveEffect(job, prepared.fence, "RUNNING");
				} catch (err) {
					return failLiveEffect(job, prepared.fence, err);
				} finally {
					await acknowledgeResetEffect(prepared.fence);
				}
			}
			case "register-slate-content": {
				//  — see actions.registerSlate.
				const params = liveRegisterSlateParamsSchema.parse(job.params);
				const prepared = await prepareLiveEffect(job, "SLATE_REGISTER", [
					"RUNNING",
				]);
				if (prepared.kind === "RETURN") return prepared.result;
				try {
					const status = await actions.registerSlate(
						liveChannelId,
						params,
						prepared.fence,
					);
					if (prepared.fence.crossedSendBoundary && status !== "REGISTERED") {
						await markLiveEffectAmbiguous(
							deps.prisma,
							prepared.fence.claim,
							`slate registration returned ${status} after crossing a provider mutation boundary`,
						);
						return effectResult(job, "EFFECT_AMBIGUOUS");
					}
					return finishLiveEffect(job, prepared.fence, status);
				} catch (err) {
					return failLiveEffect(job, prepared.fence, err);
				} finally {
					await acknowledgeResetEffect(prepared.fence);
				}
			}
			case "heartbeat":
				await actions.pollHeartbeat(liveChannelId);
				return {
					acknowledged: true,
					liveChannelId,
					action: job.action,
					status: "POLLED",
				};
			case "live-to-vod":
				if (!job.attemptId || !job.liveChannelRunId || !job.encodingId) {
					throw new ChannelStateError(
						"live-to-VOD job is missing its exact attempt/run/encoding identity",
					);
				}
				await actions.liveToVod(
					liveChannelId,
					liveToVodParamsSchema.parse(job.params ?? {}),
					{
						attemptId: job.attemptId,
						liveChannelRunId: job.liveChannelRunId,
						encodingId: job.encodingId,
					},
				);
				return {
					acknowledged: true,
					liveChannelId,
					action: job.action,
					status: "VOD_MANIFESTS_GENERATED",
				};
			case "feeder-start": {
				const params = liveFeederActionParamsSchema.parse(job.params);
				// (row 266): the audited case — a
				// feeder-start re-delivered after a re-air must not push this
				// row's source into the new run's ingest.
				if (
					await refuseStaleQueuedGeneration(
						liveChannelId,
						job.plannedLiveChannelRunId,
						{ scheduleId: params.scheduleId },
					)
				) {
					return staleGenerationResult();
				}
				const prepared = await prepareLiveEffect(job, "FEEDER_START", [
					"RUNNING",
				]);
				if (prepared.kind === "RETURN") return prepared.result;
				let result: string;
				try {
					result = await actions.feederStart(
						liveChannelId,
						params,
						undefined,
						prepared.fence,
					);
				} catch (err) {
					return failLiveEffect(job, prepared.fence, err);
				} finally {
					await acknowledgeResetEffect(prepared.fence);
				}
				if (["ROW_ENDED", "SUPERSEDED", "REFUSED"].includes(result)) {
					await markLiveEffectFailed(
						deps.prisma,
						prepared.fence.claim,
						`feeder start ended before spawn: ${result}`,
					);
				} else if (result === "ALREADY_STARTED") {
					await markLiveEffectAcked(
						deps.prisma,
						prepared.fence.claim,
						new Date(deps.now()),
					);
				}
				return {
					acknowledged: true,
					liveChannelId,
					action: job.action,
					status: result,
				};
			}
			case "feeder-switch": {
				const params = liveFeederActionParamsSchema.parse(job.params);
				// (row 266): the immediate/legacy switch
				// form — same fence as the two-phase commit.
				if (
					await refuseStaleQueuedGeneration(
						liveChannelId,
						job.plannedLiveChannelRunId,
						{ scheduleId: params.scheduleId },
					)
				) {
					return staleGenerationResult();
				}
				const prepared = await prepareLiveEffect(job, "FEEDER_COMMIT", [
					"RUNNING",
				]);
				if (prepared.kind === "RETURN") return prepared.result;
				let result: string;
				try {
					result = await actions.feederSwitch(
						liveChannelId,
						params,
						prepared.fence,
					);
				} catch (err) {
					return failLiveEffect(job, prepared.fence, err);
				} finally {
					await acknowledgeResetEffect(prepared.fence);
				}
				if (["ROW_ENDED", "SUPERSEDED", "REFUSED"].includes(result)) {
					await markLiveEffectFailed(
						deps.prisma,
						prepared.fence.claim,
						`feeder switch ended before spawn: ${result}`,
					);
				} else if (result === "ALREADY_STARTED") {
					await markLiveEffectAcked(
						deps.prisma,
						prepared.fence.claim,
						new Date(deps.now()),
					);
				}
				return {
					acknowledged: true,
					liveChannelId,
					action: job.action,
					status: result,
				};
			}
			case "feeder-stage": {
				const params = liveFeederStageParamsSchema.parse(job.params);
				// (row 266): refuse before the download —
				// staging a whole source for a run that already ended is wasted
				// work whose only use is a switch that can no longer happen.
				if (
					await refuseStaleQueuedGeneration(
						liveChannelId,
						job.plannedLiveChannelRunId,
						{ scheduleId: params.scheduleId },
					)
				) {
					return staleGenerationResult();
				}
				const result = await actions.feederStage(liveChannelId, params);
				return {
					acknowledged: true,
					liveChannelId,
					action: job.action,
					status: result,
				};
			}
			case "feeder-commit": {
				const params = liveFeederCommitParamsSchema.parse(job.params);
				// (row 266): a commit re-delivered after
				// a re-air must not cut a stale staged source into the new run.
				if (
					await refuseStaleQueuedGeneration(
						liveChannelId,
						job.plannedLiveChannelRunId,
						{ scheduleId: params.scheduleId },
					)
				) {
					return staleGenerationResult();
				}
				const prepared = await prepareLiveEffect(job, "FEEDER_COMMIT", [
					"RUNNING",
				]);
				if (prepared.kind === "RETURN") return prepared.result;
				let result: string;
				try {
					result = await actions.feederCommit(
						liveChannelId,
						params,
						prepared.fence,
					);
				} catch (err) {
					return failLiveEffect(job, prepared.fence, err);
				} finally {
					await acknowledgeResetEffect(prepared.fence);
				}
				if (result === "NOT_READY") {
					await markLiveEffectFailed(
						deps.prisma,
						prepared.fence.claim,
						"feeder commit was refused because the staged session was not ready",
					);
				}
				return {
					acknowledged: true,
					liveChannelId,
					action: job.action,
					status: result,
				};
			}
			default: {
				const exhaustive: never = job.action;
				throw new Error(`Unknown live channel action ${String(exhaustive)}`);
			}
		}
	};
}
