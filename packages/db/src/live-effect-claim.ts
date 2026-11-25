import { createHash, randomUUID } from "node:crypto";
import {
	aisaLiveFinalization,
	classifyProviderStatusWord,
	FEEDER_ACTIVE_STATUSES,
	feederOccupancyWhere,
	hasAisaLiveBinding,
	isAisaManagedLivePlan,
	stepLogSchema,
} from "@bitovp/core";
import type { AppPrismaClient, AppTransactionClient } from "./client";
import {
	recordConfirmedStopDelivery,
	recordStopScheduleFailure,
} from "./live-stop-delivery";

export const STRANDED_RUN_ERROR =
	"The job driving this run died and the channel was marked ERROR; the run row was left mid-transition, which blocked every restart. Retired by the worker's startup sweep — start the channel again.";

export const LIVE_EFFECT_OPEN_STATES = [
	"CLAIMED",
	"DISPATCHING",
	"AMBIGUOUS",
] as const;

export type LiveEffectAction =
	| "STOP"
	| "RESTART"
	| "SLATE_INSERT"
	| "SLATE_REGISTER"
	| "SCTE35"
	| "TIMESHIFT_RESET"
	| "RTMP_INGEST_UPDATE"
	| "AUTO_SHUTDOWN_UPDATE"
	| "FEEDER_START"
	| "FEEDER_COMMIT"
	| "FEEDER_SPAWN";

export type LiveEffectBeginInput = {
	/** Retained pre-effect schedule, checked under the channel/schedule locks. */
	legacyStopDelivery?: "FIRST" | "UNKNOWN" | "EXHAUSTED";
	idempotencyKey: string;
	requestSha256?: string;
	liveChannelId: string;
	liveChannelRunId: string;
	providerEncodingId: string;
	expectedFenceVersion: number;
	action: LiveEffectAction;
	scheduleId?: string;
	targetId?: string;
	ownerId: string;
	now: Date;
	expiresAt: Date;
	/** Stop is the cost-safety override: it invalidates an older open effect. */
	supersedeOpen?: boolean;
	allowedChannelStatuses?: readonly string[];
	/** Reconcile only the same bound managed Analysis after a failed/expired drain. */
	resumeAisaFinalization?: boolean;
};

export type LiveEffectClaimHandle = {
	/** A resumed, previously dispatched intent must observe active state before any still-unsent ordinary STOP. */
	requireActiveStopReadback?: boolean;
	id: string;
	scheduleId?: string | null;
	idempotencyKey: string;
	token: string;
	liveChannelId: string;
	liveChannelRunId: string;
	providerEncodingId: string;
	action: LiveEffectAction;
	generation: number;
	expiresAt: Date;
};

export type LiveEffectBeginResult =
	| { kind: "EXECUTE"; claim: LiveEffectClaimHandle }
	| { kind: "ACKED"; claimId: string; providerResultId: string | null }
	| { kind: "CONFLICT"; reason: string }
	| {
			kind: "BLOCKED";
			claimId: string;
			state: "CLAIMED" | "DISPATCHING" | "FAILED" | "AMBIGUOUS" | "RESOLVED";
			reason: string;
	  }
	| { kind: "STALE"; reason: string };

export type LiveEffectTargetClaimResult =
	| { kind: "DISPATCHING"; claim: LiveEffectClaimHandle }
	| {
			kind: "BLOCKED";
			claimId: string;
			state: "CLAIMED" | "AMBIGUOUS";
			reason: string;
	  }
	| { kind: "NONE" };

type BeginHooks = {
	/** Test-only kill point inside the transaction, after CLAIMED/pre-intent. */
	afterClaimed?: () => void | Promise<void>;
};

export type ResolveLiveEffectsAfterConfirmedStopInput = {
	liveChannelId: string;
	liveChannelRunId: string;
	providerEncodingId: string;
	stopClaimId: string;
	stopIdempotencyKey: string;
	at: Date;
	/** Terminal GETs for every encoder actually observed by the original owner. */
	ownerReadbacks?: {
		generation: number;
		token: string;
		bitmovinAccountId: string;
		encodings: readonly { id: string; status: string }[];
	};
	/** Periodic recovery after the original worker committed a clean STOP projection. */
	interruptedAckGeneration?: number;
	/** Fresh provider GET issued for this generation after its owner recorded ambiguity. */
	terminalReadback?: {
		generation: number;
		bitmovinAccountId: string;
		providerStatus: string;
		encodings?: readonly { id: string; status: string }[];
	};
};

export function liveEffectSendUncertainty(reason: string): string {
	return `${reason}; the provider/process call crossed its send boundary, so exact readback or operator resolution is required before retry`;
}

export function liveChannelAccountId(row: {
	bitmovinAccountId?: string | null;
	plan?: unknown;
}): string | null {
	const account =
		row.bitmovinAccountId ??
		(row.plan as { bitmovin?: { accountId?: unknown } } | null)?.bitmovin
			?.accountId;
	return typeof account === "string" && account.length > 0 ? account : null;
}

const LEGACY_EXPIRED_DISPATCH =
	"effect owner expired after DISPATCHING; exact readback is required before retry";

type StopReceipt = { id: string; status: string };
type StopHistory = {
	providerEncodingId: string;
	action: string;
	failure?: string | null;
	stopProtocolVersion?: number | null;
	stopSendEncodingIds?: string[];
	legacyUnsentStopIds?: string[];
	stopOutcomeEvidence?: unknown;
};

/** Native legacy STOP only retried its own FAILED key before sending. An
 * Analysis retry could follow a composite dispatch, so an older multi-attempt
 * Analysis needs independent evidence before emitting a new notification. */
function legacyStopFailedBeforeSend(
	claim: {
		state: string;
		attempt: number;
		stopSendEncodingIds?: string[];
		stopAnalysisSendId?: string | null;
		stopOutcomeEvidence?: unknown;
	},
	channel: { plan: unknown },
	run: {
		aisaAnalysisId?: string | null;
		aisaStatus?: string | null;
		aisaSnapshot?: unknown;
	},
): boolean {
	return (
		claim.state === "FAILED" &&
		!claim.stopSendEncodingIds?.length &&
		!claim.stopAnalysisSendId &&
		claim.stopOutcomeEvidence == null &&
		(claim.attempt === 1 ||
			(!isAisaManagedLivePlan(channel.plan) &&
				!run.aisaAnalysisId &&
				run.aisaStatus == null &&
				run.aisaSnapshot == null))
	);
}

/** Only legacy STOP diagnostics need to recover target IDs from human-readable fields. */
function legacyFaultTargets(
	error: string | null | undefined,
	known: ReadonlySet<string>,
): string[] | null {
	const prefix = "stop did not confirm — ";
	if (!error?.startsWith(prefix)) return [];
	const ids: string[] = [];
	// Legacy enqueue diagnostics wrapped arbitrary queue error text, including
	// the same semicolon delimiter used between encoder faults.
	const faults = error
		.slice(prefix.length)
		.replace(
			/(^|; )feeder stop could not be enqueued \([\s\S]*?\) — its push may still be running(?=; |$)/g,
			"$1feeder stop could not be enqueued (failure) — its push may still be running",
		);
	// Legacy provider/queue messages can contain arbitrary semicolons. A new
	// entry starts with an encoder ID and colon, or the worker's feeder prefix.
	for (const [index, fault] of faults
		.split(
			/; (?=[A-Za-z0-9_-]+: |feeder (?:[^:;]+: stop was enqueued|stop could not be enqueued))/,
		)
		.entries()) {
		if (
			/^feeder [^:;]+: stop was enqueued but publisher termination was not confirmed$/.test(
				fault,
			) ||
			/^feeder stop could not be enqueued \(.+\) — its push may still be running$/.test(
				fault,
			)
		)
			continue;
		const match = /^([A-Za-z0-9_-]+): /.exec(fault);
		if (!match?.[1]) return null;
		// The first label belongs to our formatter. Inside arbitrary provider text,
		// only an existing identity or the provider's UUID grammar starts another encoder.
		if (
			index === 0 ||
			known.has(match[1]) ||
			/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(match[1])
		)
			ids.push(match[1]);
	}
	return ids;
}

function rtmpRebuildAttempt(log: unknown): number {
	const parsed = stepLogSchema.safeParse(log);
	return parsed.success
		? Math.max(
				0,
				...parsed.data
					.filter((entry) => entry.kind === "CREATE_INPUT_RTMP")
					.map((entry) => entry.attempt ?? 0),
			)
		: 0;
}

export type RtmpRetirementReceipt = {
	accountId: string;
	encodingId: string;
	providerStatus: string;
	observedAt: string;
	disposition: "TERMINAL" | "NEVER_STARTED";
};

function validRetirement(value: unknown): value is RtmpRetirementReceipt {
	if (!value || typeof value !== "object") return false;
	const r = value as Partial<RtmpRetirementReceipt>;
	return (
		typeof r.encodingId === "string" &&
		!!r.encodingId &&
		typeof r.accountId === "string" &&
		!!r.accountId &&
		typeof r.observedAt === "string" &&
		Number.isFinite(Date.parse(r.observedAt)) &&
		((r.disposition === "TERMINAL" &&
			classifyProviderStatusWord(r.providerStatus) === "TERMINAL") ||
			(r.disposition === "NEVER_STARTED" && r.providerStatus === "CREATED"))
	);
}

export function mergeRtmpRetirementEvidence(
	existing: unknown,
	receipts: readonly RtmpRetirementReceipt[],
): RtmpRetirementReceipt[] {
	const result = new Map<string, RtmpRetirementReceipt>();
	for (const r of [...(Array.isArray(existing) ? existing : []), ...receipts])
		if (validRetirement(r))
			result.set(JSON.stringify([r.accountId, r.encodingId]), r);
	return [...result.values()];
}

export function unconfirmedRtmpEncoders(
	run: {
		stepLog: unknown;
		previousProviderEncodingIds?: readonly string[];
		archivedRtmpAttempt?: number;
		rtmpRetirementEvidence?: unknown;
	},
	channel: { stepLog: unknown },
	accountId: string | null,
): string[] | null {
	if (
		Math.max(
			rtmpRebuildAttempt(run.stepLog),
			rtmpRebuildAttempt(channel.stepLog),
		) > (run.archivedRtmpAttempt ?? 0)
	)
		return null;
	const retired = new Set(
		mergeRtmpRetirementEvidence(run.rtmpRetirementEvidence, [])
			.filter((r) => r.accountId === accountId)
			.map((r) => r.encodingId),
	);
	return (run.previousProviderEncodingIds ?? []).filter(
		(id) => !retired.has(id),
	);
}

export function archivedStopRecoveryTarget(
	channel: {
		origin?: string;
		purpose?: string | null;
		status: string;
		error?: string | null;
		provisionClaimedAt?: Date | null;
		bitmovinEncodingId?: string | null;
		bitmovinAccountId?: string | null;
		encoderStoppedConfirmedFor?: string | null;
		plan?: unknown;
		stepLog: unknown;
	},
	run:
		| ({
				bitmovinEncodingId?: string | null;
				aisaAnalysisId?: string | null;
				encoderStoppedConfirmedFor?: string | null;
		  } & Parameters<typeof unconfirmedRtmpEncoders>[0])
		| null,
	history: readonly StopHistory[] = [],
) {
	if (
		!run ||
		channel.origin !== "MANAGED" ||
		channel.provisionClaimedAt ||
		(!["STOPPING", "ERROR", "STOPPED"].includes(channel.status) &&
			!(
				channel.purpose === "PROBE" &&
				channel.status === "RUNNING" &&
				!channel.bitmovinEncodingId &&
				!run.bitmovinEncodingId
			)) ||
		isAisaManagedLivePlan(channel.plan) ||
		run.aisaAnalysisId
	)
		return null;
	const account = liveChannelAccountId(channel);
	const archive = account
		? pendingAiringRetirement(run, channel, history, account)
		: null;
	if (!archive?.length) return null;
	if (!channel.bitmovinEncodingId && !run.bitmovinEncodingId) {
		const paired =
			channel.encoderStoppedConfirmedFor === run.encoderStoppedConfirmedFor
				? run.encoderStoppedConfirmedFor
				: undefined;
		const candidates = archive.filter(
			(id) =>
				run.previousProviderEncodingIds?.includes(id) ||
				liveStopLogEncodings(run.stepLog)?.includes(id) ||
				history.some(
					(c) =>
						c.providerEncodingId === id || c.stopSendEncodingIds?.includes(id),
				),
		);
		return candidates.find((id) => id !== paired) ?? candidates[0] ?? null;
	}
	return channel.bitmovinEncodingId &&
		run.bitmovinEncodingId === channel.bitmovinEncodingId
		? channel.bitmovinEncodingId
		: null;
}

/** Identify the archive displayed to the operator without exposing historical provider IDs. */
export function archivedStopRevision(
	channel: Parameters<typeof archivedStopRecoveryTarget>[0] & {
		id: string;
		liveEffectFenceVersion: number;
	},
	run:
		| (NonNullable<Parameters<typeof archivedStopRecoveryTarget>[1]> & {
				id: string;
		  })
		| null,
	history: readonly StopHistory[] = [],
): string | null {
	const target = archivedStopRecoveryTarget(channel, run, history);
	if (!run || !target) return null;
	const accountId = liveChannelAccountId(channel);
	return createHash("sha256")
		.update(
			JSON.stringify([
				channel.id,
				run.id,
				channel.liveEffectFenceVersion,
				accountId,
				target,
				pendingAiringRetirement(run, channel, history, accountId),
			]),
		)
		.digest("hex");
}

/** Restore a lost primary only from this current run's durable RTMP archive.
 * Called by an explicit stop. Normal provisioning and heartbeat never rebind a target. */
export async function bindArchivedStopTarget(
	prisma: AppPrismaClient,
	liveChannelId: string,
	expectedRunId?: string,
	expectedRevision?: string,
): Promise<string | null> {
	return prisma.$transaction((tx) =>
		bindArchivedStopTargetInTransaction(
			tx,
			liveChannelId,
			expectedRunId,
			expectedRevision,
		),
	);
}

export async function bindArchivedStopTargetInTransaction(
	tx: AppTransactionClient,
	liveChannelId: string,
	expectedRunId?: string,
	expectedRevision?: string,
): Promise<string | null> {
	const locked = await tx.$queryRaw<
		{ id: string }[]
	>`SELECT id FROM "LiveChannel" WHERE id=${liveChannelId}::uuid FOR UPDATE`;
	if (!locked.length) return null;
	const channel = await tx.liveChannel.findUnique({
		where: { id: liveChannelId },
	});
	if (!channel) return null;
	const run = await tx.liveChannelRun.findFirst({
		where: { liveChannelId },
		orderBy: { seq: "desc" },
	});
	if (!run || (expectedRunId && run.id !== expectedRunId)) return null;
	const history = await readAiringEffectHistory(tx, liveChannelId, run.id);
	if (
		expectedRevision !== undefined &&
		archivedStopRevision(channel, run, history) !== expectedRevision
	)
		return null;
	const target = archivedStopRecoveryTarget(channel, run, history);
	if (!target || channel.bitmovinEncodingId === target) return target;
	// Rebinding cannot retroactively validate an old CREATED observation. Only an ID
	// previously indexed by the retirement writer qualified for that disposition.
	const receipts = mergeRtmpRetirementEvidence(run.rtmpRetirementEvidence, []);
	// Older clean STOPs can predate per-target receipts. Before moving the
	// primary, materialize the old paired confirmation on its own account/ID.
	const priorId = run.encoderStoppedConfirmedFor;
	const accountId = liveChannelAccountId(channel);
	const priorTerminal =
		priorId &&
		accountId &&
		channel.encoderStoppedConfirmedFor === priorId &&
		(!run.bitmovinEncodingId || run.bitmovinEncodingId === priorId) &&
		run.status === "STOPPED" &&
		!run.error &&
		channel.status === "STOPPED" &&
		!channel.error &&
		run.providerTerminalAt &&
		run.providerStatus &&
		classifyProviderStatusWord(run.providerStatus) === "TERMINAL" &&
		history.some(
			(claim) =>
				claim.action === "STOP" &&
				claim.state === "ACKED" &&
				!claim.failure &&
				claim.providerEncodingId === priorId,
		)
			? [
					{
						accountId,
						encodingId: priorId,
						providerStatus: run.providerStatus,
						observedAt: (
							run.providerStatusObservedAt ?? run.providerTerminalAt
						).toISOString(),
						disposition: "TERMINAL" as const,
					},
				]
			: [];
	const retained = receipts.filter(
		(r) =>
			r.encodingId !== target ||
			r.disposition !== "NEVER_STARTED" ||
			run.previousProviderEncodingIds.includes(target),
	);
	await tx.liveChannelRun.update({
		where: { id: run.id },
		data: {
			bitmovinEncodingId: target,
			...(retained.length !== receipts.length || priorTerminal.length
				? {
						rtmpRetirementEvidence: mergeRtmpRetirementEvidence(
							retained,
							priorTerminal,
						),
					}
				: {}),
			// The rebound primary remains an outstanding archive until its own receipt lands.
			previousProviderEncodingIds: [
				...new Set([...run.previousProviderEncodingIds, target]),
			],
			providerStatus: null,
			providerStatusObservedAt: null,
			providerTerminalAt: null,
			providerFeederStopsEnqueuedAt: null,
			providerUnknownSince: null,
			providerUnknownAlertedAt: null,
			encoderStoppedConfirmedFor: null,
			heartbeatPollEpoch: { increment: 1 },
		},
	});
	await tx.liveChannel.update({
		where: { id: liveChannelId },
		data: { bitmovinEncodingId: target, encoderStoppedConfirmedFor: null },
	});
	return target;
}

export function collectLiveStopTargets(
	run: {
		bitmovinEncodingId: string | null;
		stepLog: unknown;
		aisaAnalysisId?: string | null;
		previousProviderEncodingIds?: readonly string[];
		rtmpRetirementEvidence?: unknown;
		archivedRtmpAttempt?: number;
	},
	channel: {
		bitmovinEncodingId: string | null;
		stepLog: unknown;
		error?: string | null;
	},
	history: readonly StopHistory[],
	accountId?: string | null,
): { encodingIds: string[]; complete: boolean } {
	const channelIds = liveStopLogEncodings(channel.stepLog);
	const runIds = liveStopLogEncodings(run.stepLog);
	const archive = unconfirmedRtmpEncoders(run, channel, accountId ?? null);
	let complete = !!channelIds && !!runIds && archive !== null;
	const ids = new Set([
		...(run.bitmovinEncodingId ? [run.bitmovinEncodingId] : []),
		...(channel.bitmovinEncodingId ? [channel.bitmovinEncodingId] : []),
		...(channelIds ?? []),
		...(runIds ?? []),
		...(archive ?? run.previousProviderEncodingIds ?? []),
	]);
	for (const claim of history) {
		for (const id of [
			claim.providerEncodingId,
			...(claim.stopSendEncodingIds ?? []),
			...(claim.legacyUnsentStopIds ?? []),
		]) {
			if (typeof id === "string" && id) ids.add(id);
			else complete = false;
		}
		const required = (
			claim.stopOutcomeEvidence as { requiredEncodingIds?: unknown } | null
		)?.requiredEncodingIds;
		if (Array.isArray(required))
			for (const id of required) {
				if (typeof id !== "string" || !id) complete = false;
				else ids.add(id);
			}
		if (claim.action !== "STOP" || claim.stopProtocolVersion === 1) continue;
		const legacy = legacyFaultTargets(claim.failure, ids);
		if (!legacy) complete = false;
		for (const id of legacy ?? []) ids.add(id);
	}
	// An unclaimed or pre-upgrade projection can be the last remaining trace of
	// a secondary encoder. Typed receipts retain the exact set separately.
	const ownerRecordedError = history.some(
		(c) =>
			c.stopProtocolVersion === 1 &&
			(c.stopOutcomeEvidence as { error?: unknown } | null)?.error ===
				channel.error,
	);
	if (!ownerRecordedError) {
		const extra = legacyFaultTargets(channel.error, ids);
		if (!extra) complete = false;
		for (const id of extra ?? []) ids.add(id);
	}
	return { encodingIds: [...ids], complete };
}

/** Settlement needs a complete inventory; recovery can still inspect recorded targets. */
export function liveStopKnownTargets(
	...args: Parameters<typeof collectLiveStopTargets>
): string[] | null {
	const targets = collectLiveStopTargets(...args);
	return targets.complete ? targets.encodingIds : null;
}

/** A never-started archive receipt no longer applies after a RESTART targets the same encoder. */
export function validLiveRetirementReceipts(
	run: {
		rtmpRetirementEvidence?: unknown;
		previousProviderEncodingIds?: readonly string[];
	},
	history: readonly StopHistory[],
	accountId: string | null,
) {
	return mergeRtmpRetirementEvidence(run.rtmpRetirementEvidence, []).filter(
		(receipt) =>
			receipt.accountId === accountId &&
			(receipt.disposition === "TERMINAL" ||
				(run.previousProviderEncodingIds?.includes(receipt.encodingId) &&
					!history.some(
						(claim) =>
							claim.action === "RESTART" &&
							claim.providerEncodingId === receipt.encodingId,
					))),
	);
}

/** Claims may outlive their run. Only exact terminal evidence on the surviving channel retires them. */
export function unresolvedOrphanLiveClaimTargets(
	history: readonly StopHistory[],
	evidence: unknown,
	accountId: string | null,
) {
	const empty = { stepLog: [], bitmovinEncodingId: null };
	const inventory = outstandingLiveStopTargets(
		{ ...empty, rtmpRetirementEvidence: evidence },
		empty,
		history,
		accountId,
		null,
	);
	return inventory.complete ? inventory.encodingIds : null;
}

/** All identities whose retirement still needs a readback on this account. */
export function outstandingLiveStopTargets(
	run: Parameters<typeof collectLiveStopTargets>[0],
	channel: Parameters<typeof collectLiveStopTargets>[1],
	history: readonly StopHistory[],
	accountId: string | null,
	primary: string | null,
) {
	const inventory = collectLiveStopTargets(run, channel, history, accountId);
	const retired = new Set(
		validLiveRetirementReceipts(run, history, accountId).map(
			(r) => r.encodingId,
		),
	);
	return {
		complete: inventory.complete,
		encodingIds: inventory.encodingIds.filter(
			(id) => id === primary || !retired.has(id),
		),
	};
}
export function pendingSecondaryStopTargets(
	run: Parameters<typeof outstandingLiveStopTargets>[0],
	channel: Parameters<typeof outstandingLiveStopTargets>[1],
	history: readonly StopHistory[],
	accountId: string | null,
	primary: string | null,
): string[] | null {
	const inventory = outstandingLiveStopTargets(
		run,
		channel,
		history,
		accountId,
		primary,
	);
	return inventory.complete
		? inventory.encodingIds.filter((id) => id !== primary)
		: null;
}
/** A lifecycle observation on one primary cannot retire a different primary on the other mirror. */
export function divergentLivePrimaries(
	run: { bitmovinEncodingId?: string | null },
	channel: { bitmovinEncodingId?: string | null },
): string[] {
	const a = run.bitmovinEncodingId,
		b = channel.bitmovinEncodingId;
	return a && b && a !== b ? [a, b] : [];
}
/** The primary has its own lifecycle guard. If its column was lost, every surviving ID needs retirement. */
export function pendingAiringRetirement(
	run: Parameters<typeof unconfirmedRtmpEncoders>[0] & {
		bitmovinEncodingId?: string | null;
	},
	channel: {
		stepLog: unknown;
		bitmovinEncodingId?: string | null;
		error?: string | null;
	},
	history: readonly StopHistory[],
	accountId: string | null,
): string[] | null {
	const primary = run.bitmovinEncodingId ?? null;
	const pending = pendingSecondaryStopTargets(
		{ ...run, bitmovinEncodingId: primary },
		{ ...channel, bitmovinEncodingId: channel.bitmovinEncodingId ?? null },
		history,
		accountId,
		primary,
	);
	if (!pending) return null;
	// An explicitly indexed encoder can itself have been rebound as the primary of
	// an archive-only STOP. Its positive receipt is still required before re-air.
	const receipts = validLiveRetirementReceipts(run, history, accountId);
	const valid = new Set(receipts.map((receipt) => receipt.encodingId));
	const terminal = new Set(
		receipts
			.filter((receipt) => receipt.disposition === "TERMINAL")
			.map((receipt) => receipt.encodingId),
	);
	const divergent = divergentLivePrimaries(run, channel).filter(
		(id) => !terminal.has(id),
	);
	const indexed = (run.previousProviderEncodingIds ?? []).filter(
		(id) => !valid.has(id),
	);
	return [...new Set([...pending, ...indexed, ...divergent])].sort();
}
export function readAiringEffectHistory(
	tx: Pick<AppTransactionClient, "liveEffectClaim">,
	liveChannelId: string,
	liveChannelRunId: string,
) {
	return tx.liveEffectClaim.findMany({
		where: { liveChannelId, liveChannelRunId },
		select: {
			action: true,
			providerEncodingId: true,
			state: true,
			failure: true,
			attempt: true,
			stopProtocolVersion: true,
			stopSendEncodingIds: true,
			legacyUnsentStopIds: true,
			stopAnalysisSendId: true,
			stopOutcomeEvidence: true,
			legacyStopErrorNotificationPossible: true,
		},
	});
}

export function stopNotificationHistoryEligible(
	history: Awaited<ReturnType<typeof readAiringEffectHistory>>,
	channel: { plan: unknown },
	run: {
		aisaAnalysisId?: string | null;
		aisaStatus?: string | null;
		aisaSnapshot?: unknown;
	},
	status: "STOPPED" | "ERROR",
) {
	return history.every(
		(claim) =>
			claim.action !== "STOP" ||
			(claim.stopProtocolVersion === 1
				? status === "STOPPED" || !claim.legacyStopErrorNotificationPossible
				: status === "STOPPED" &&
					legacyStopFailedBeforeSend(claim, channel, run)),
	);
}
/** An acknowledged provider operation carries the target checked against this airing
 * at admission. A failed operation, feeder-only claim, or ID mentioned in a
 * diagnostic can require observation without authorizing a new encoder mutation. */
export function acknowledgedProviderTargets(
	history: readonly (StopHistory & { state: string })[],
): string[] {
	return history
		.filter(
			(c) =>
				c.state === "ACKED" &&
				[
					"RESTART",
					"SLATE_INSERT",
					"SLATE_REGISTER",
					"SCTE35",
					"TIMESHIFT_RESET",
					"RTMP_INGEST_UPDATE",
					"AUTO_SHUTDOWN_UPDATE",
				].includes(c.action),
		)
		.map((c) => c.providerEncodingId);
}
/** Identities proved to belong to the airing, distinct from IDs mentioned only by a diagnostic. */
export function ownedLiveStopEncoders(
	run: Parameters<typeof liveStopKnownTargets>[0],
	channel: Parameters<typeof liveStopKnownTargets>[1],
	history: readonly (StopHistory & { state: string })[],
): Set<string> {
	return new Set(
		[
			...acknowledgedProviderTargets(history),
			run.bitmovinEncodingId,
			...(liveStopLogEncodings(run.stepLog) ?? []),
			...(liveStopLogEncodings(channel.stepLog) ?? []),
			...(run.previousProviderEncodingIds ?? []),
		].filter((id): id is string => Boolean(id)),
	);
}

/** Targets with affirmative run ownership and no historical STOP reservation.
 * Legacy dispatches cannot distinguish an attempted encoding from an untouched one. */
export function unreservedStopTargets(
	run: Parameters<typeof liveStopKnownTargets>[0],
	channel: Parameters<typeof liveStopKnownTargets>[1] & {
		plan?: unknown;
		bitmovinAccountId?: string | null;
	},
	history: readonly (StopHistory & { state: string })[],
): string[] {
	const account = liveChannelAccountId(channel);
	if (!account || run.aisaAnalysisId || isAisaManagedLivePlan(channel.plan))
		return [];
	const stops = history.filter((c) => c.action === "STOP");
	const reservations = new Set(
		stops.flatMap((c) => c.stopSendEncodingIds ?? []),
	);
	const outstanding = outstandingLiveStopTargets(
		run,
		channel,
		history,
		account,
		run.bitmovinEncodingId ?? null,
	);
	const owned = ownedLiveStopEncoders(run, channel, history);
	return outstanding.encodingIds.filter(
		(id) =>
			owned.has(id) &&
			!reservations.has(id) &&
			stops.every(
				(c) =>
					c.stopProtocolVersion === 1 ||
					!["DISPATCHING", "AMBIGUOUS", "ACKED"].includes(c.state) ||
					c.legacyUnsentStopIds?.includes(id) === true,
			),
	);
}

export function savedStopReadbacks(
	claim: { stopOutcomeEvidence?: unknown },
	accountId: string,
): StopReceipt[] {
	const saved = claim.stopOutcomeEvidence as {
		accountId?: unknown;
		encodings?: unknown;
	} | null;
	if (
		!saved ||
		saved.accountId !== accountId ||
		!Array.isArray(saved.encodings)
	)
		return [];
	return saved.encodings.filter(
		(r): r is StopReceipt =>
			r &&
			typeof r.id === "string" &&
			typeof r.status === "string" &&
			classifyProviderStatusWord(r.status) === "TERMINAL",
	);
}

export function canObserveLiveStop(
	claim: {
		state: string;
		failure?: string | null;
		expiresAt: Date;
		stopProtocolVersion?: number | null;
		stopOutcomeEvidence?: unknown;
	},
	channel: { status: string; error: string | null },
	at: Date,
): boolean {
	if (
		claim.state !== "AMBIGUOUS" &&
		!(claim.state === "DISPATCHING" && claim.expiresAt <= at)
	)
		return false;
	if (channel.status === "STOPPING") return true;
	if (channel.status !== "ERROR" && channel.status !== "STOPPED") return false;
	if (channel.status === "STOPPED" && channel.error === null) return true;
	const saved = claim.stopOutcomeEvidence as {
		status?: unknown;
		error?: unknown;
	} | null;
	if (claim.stopProtocolVersion === 1)
		return (
			!!saved &&
			saved.status === channel.status &&
			saved.error === channel.error
		);
	const expired =
		claim.expiresAt <= at &&
		(claim.state === "DISPATCHING" ||
			claim.failure === LEGACY_EXPIRED_DISPATCH);
	return (
		!!channel.error &&
		(expired ||
			(channel.status === "ERROR"
				? claim.failure === liveEffectSendUncertainty(channel.error)
				: claim.failure === channel.error &&
					channel.error.startsWith("stop did not confirm — ")))
	);
}

/** Both projected logs are part of a broadcast's encoder ownership record. */
export function liveStopLogEncodings(log: unknown): string[] | null {
	const parsed = stepLogSchema.safeParse(log);
	if (!parsed.success) return null;
	return parsed.data.flatMap((entry) =>
		(entry.kind === "CREATE_ENCODING" ||
			entry.kind === "RESOLVE_AISA_LIVE_ENCODING") &&
		entry.resourceId
			? [entry.resourceId]
			: [],
	);
}

/** Older runs had no encoder column. Only their own completed creation receipt can replace it. */
export function liveStopRunOwnsEncoding(
	run: { bitmovinEncodingId: string | null; stepLog: unknown },
	id: string,
): boolean {
	if (run.bitmovinEncodingId !== null) return run.bitmovinEncodingId === id;
	const parsed = stepLogSchema.safeParse(run.stepLog);
	return (
		parsed.success &&
		parsed.data.some(
			(entry) =>
				entry.kind === "CREATE_ENCODING" &&
				entry.status === "DONE" &&
				entry.resourceId === id,
		)
	);
}

export function liveStopFeederWhere(liveChannelId: string) {
	return {
		liveChannelId,
		OR: [
			feederOccupancyWhere(),
			{ status: { in: [...FEEDER_ACTIVE_STATUSES] } },
		],
	};
}

export type ResolveLiveEffectsAfterConfirmedStopResult =
	| {
			kind: "RESOLVED";
			count: number;
			recoveredFromError?: true;
			terminalFailure?: true;
	  }
	| { kind: "BLOCKED"; reason: string }
	| { kind: "ALREADY_ACKED" };

function handleOf(row: {
	id: string;
	scheduleId?: string | null;
	idempotencyKey: string;
	token: string;
	liveChannelId: string;
	liveChannelRunId: string;
	providerEncodingId: string;
	action: string;
	generation: number;
	expiresAt: Date;
}): LiveEffectClaimHandle {
	return {
		id: row.id,
		...(row.scheduleId ? { scheduleId: row.scheduleId } : {}),
		idempotencyKey: row.idempotencyKey,
		token: row.token,
		liveChannelId: row.liveChannelId,
		liveChannelRunId: row.liveChannelRunId,
		providerEncodingId: row.providerEncodingId,
		action: row.action as LiveEffectAction,
		generation: row.generation,
		expiresAt: row.expiresAt,
	};
}

function isPrismaSerializationConflict(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "P2034"
	);
}

/** Locked admission for an explicit recovery after an earlier clean STOP.
 * The journal-free worker sent only to its primary and channel-log IDs. An
 * unrecorded response can suppress a repeat, but cannot suppress a positively
 * identified displaced encoder's first send outside that set. */
async function recoverAcknowledgedStop(
	tx: AppTransactionClient,
	input: LiveEffectBeginInput,
	existingId: string | undefined,
): Promise<{ requireReadback: boolean; existingUnsent?: string[] } | null> {
	const initial = await tx.liveChannel.findUnique({
		where: { id: input.liveChannelId },
	});
	if (initial?.status !== "STOPPED" || initial.error !== null) return null;
	// Every writer of the airing, including outgoing send reservations, locks
	// the channel first. Never lock a historical acknowledgement ahead of it.
	const locked = await tx.$queryRaw<
		{ id: string }[]
	>`SELECT id FROM "LiveChannel" WHERE id=${input.liveChannelId}::uuid AND status='STOPPED' AND error IS NULL FOR UPDATE`;
	if (!locked.length) return null;
	const channel = await tx.liveChannel.findUnique({
		where: { id: input.liveChannelId },
	});
	if (!channel) return null;
	const run = await tx.liveChannelRun.findFirst({
		where: { liveChannelId: input.liveChannelId },
		orderBy: { seq: "desc" },
	});
	if (run?.id !== input.liveChannelRunId) return null;
	const history = await tx.liveEffectClaim.findMany({
		where: { liveChannelId: input.liveChannelId, liveChannelRunId: run.id },
	});
	const target = archivedStopRecoveryTarget(channel, run, history);
	if (!target || target !== input.providerEncodingId) return null;

	const result: { requireReadback: boolean; existingUnsent?: string[] } = {
		requireReadback: history.some(
			(c) =>
				c.action === "STOP" &&
				c.state === "ACKED" &&
				c.providerEncodingId !== target,
		),
	};
	const channelLog = liveStopLogEncodings(channel.stepLog);
	if (!channelLog || run.status !== "STOPPED" || run.error) return result;
	const terminalIds = new Set(
		validLiveRetirementReceipts(run, history, liveChannelAccountId(channel))
			.filter((r) => r.disposition === "TERMINAL")
			.map((r) => r.encodingId),
	);
	if (
		run.bitmovinEncodingId &&
		run.providerTerminalAt &&
		classifyProviderStatusWord(run.providerStatus) === "TERMINAL"
	)
		terminalIds.add(run.bitmovinEncodingId);
	const pending =
		pendingAiringRetirement(
			run,
			channel,
			history,
			liveChannelAccountId(channel),
		) ?? [];
	for (const claim of history) {
		if (
			claim.action !== "STOP" ||
			claim.state !== "ACKED" ||
			claim.stopProtocolVersion !== null ||
			!terminalIds.has(claim.providerEncodingId) ||
			claim.failure
		)
			continue;
		const covered = new Set([
			claim.providerEncodingId,
			...channelLog,
			...claim.stopSendEncodingIds,
		]);
		const unsent = pending.filter((id) => !covered.has(id));
		if (!unsent.length) continue;
		result.requireReadback = true;
		if (claim.id === existingId) result.existingUnsent = unsent;
		else
			await tx.liveEffectClaim.updateMany({
				where: {
					id: claim.id,
					state: "ACKED",
					generation: claim.generation,
					token: claim.token,
				},
				data: { legacyUnsentStopIds: unsent },
			});
	}
	return result;
}

/**
 * Acquire and durably write DISPATCHING before the caller crosses its send or
 * spawn boundary. The channel fence CAS is the linearization point shared with
 * stop/start transitions: a concurrent generation change makes one side lose.
 */
export async function beginLiveEffect(
	prisma: AppPrismaClient,
	input: LiveEffectBeginInput,
	hooks: BeginHooks = {},
): Promise<LiveEffectBeginResult> {
	return prisma.$transaction(async (tx) => {
		if (input.legacyStopDelivery) {
			if (
				input.action !== "STOP" ||
				!input.scheduleId ||
				input.idempotencyKey !== `schedule:${input.scheduleId}:stop`
			)
				return {
					kind: "STALE" as const,
					reason: "Legacy schedule STOP has no exact receipt",
				};
			await tx.$queryRaw`SELECT id FROM "LiveChannel" WHERE id = ${input.liveChannelId}::uuid FOR UPDATE`;
			await tx.$queryRaw`SELECT id FROM "LiveSchedule" WHERE id = ${input.scheduleId}::uuid FOR UPDATE`;
			const original = await tx.liveSchedule.findFirst({
				where: {
					id: input.scheduleId,
					liveChannelId: input.liveChannelId,
					liveChannelRunId: input.liveChannelRunId,
					action: "STOP",
					status: "FIRED",
					outcome:
						input.legacyStopDelivery === "EXHAUSTED"
							? { in: ["PENDING", "UNKNOWN"] }
							: "PENDING",
					liveChannel: {
						status: "STOPPING",
						...(input.legacyStopDelivery === "EXHAUSTED"
							? {
									legacyAdmissionFenceVersion: input.expectedFenceVersion,
									liveEffectFenceVersion: input.expectedFenceVersion,
									bitmovinEncodingId: input.providerEncodingId,
									runs: {
										some: {
											id: input.liveChannelRunId,
											status: { in: ["RUNNING", "STOPPING", "ERROR"] },
										},
									},
								}
							: {}),
					},
					OR: [
						{ dispatchJobId: null },
						{ dispatchJobId: `sched-${input.scheduleId}` },
					],
				},
				select: { id: true },
			});
			if (!original)
				return {
					kind: "STALE" as const,
					reason:
						"The preclaimed legacy schedule or its broadcast is no longer pending",
				};
		}
		const durableManualStop =
			input.action === "STOP" &&
			input.supersedeOpen === true &&
			input.scheduleId === undefined &&
			input.idempotencyKey.startsWith("manual:stop:");
		const existing = await tx.liveEffectClaim.findUnique({
			where: { idempotencyKey: input.idempotencyKey },
		});
		if (
			existing &&
			(existing.requestSha256 ?? null) !== (input.requestSha256 ?? null)
		) {
			return {
				kind: "CONFLICT" as const,
				reason: "the request id is already bound to a different payload",
			};
		}
		let unsentGeneration: number | undefined;

		let retryingFailed = existing?.state === "FAILED" ? existing : null;
		if (
			(existing?.stopProtocolVersion === 1 ||
				(!!existing && existing.legacyUnsentStopIds?.length > 0)) &&
			input.action === "STOP" &&
			(existing.state === "DISPATCHING" || existing.state === "AMBIGUOUS") &&
			existing.expiresAt <= input.now
		) {
			const [channel, run, history] = await Promise.all([
				tx.liveChannel.findUnique({ where: { id: input.liveChannelId } }),
				tx.liveChannelRun.findFirst({
					where: { liveChannelId: input.liveChannelId },
					orderBy: { seq: "desc" },
				}),
				readAiringEffectHistory(
					tx,
					input.liveChannelId,
					input.liveChannelRunId,
				),
			]);
			if (
				channel &&
				run?.id === input.liveChannelRunId &&
				channel.liveEffectFenceVersion === existing.generation &&
				channel.bitmovinEncodingId === input.providerEncodingId &&
				liveStopRunOwnsEncoding(run, input.providerEncodingId) &&
				canObserveLiveStop(existing, channel, input.now) &&
				unreservedStopTargets(run, channel, history).length
			) {
				retryingFailed = existing;
				unsentGeneration = existing.generation;
			}
		}
		// A clean pre-journal STOP covered the primary and the then-current channel
		// creation log. Its old dedupe key can be scheduled or manual.
		const recovery =
			durableManualStop &&
			(!existing ||
				(existing.state === "ACKED" &&
					existing.liveChannelId === input.liveChannelId &&
					existing.liveChannelRunId === input.liveChannelRunId &&
					existing.providerEncodingId === input.providerEncodingId))
				? await recoverAcknowledgedStop(tx, input, existing?.id)
				: null;
		if (recovery && existing) retryingFailed = existing;
		const recoveringLegacyAck = recovery?.requireReadback ?? false;
		const retryingPromotedTarget =
			durableManualStop &&
			retryingFailed?.state === "FAILED" &&
			(await tx.liveEffectClaim.findFirst({
				where: {
					liveChannelId: input.liveChannelId,
					liveChannelRunId: input.liveChannelRunId,
					action: "STOP",
					state: "ACKED",
					providerEncodingId: { not: input.providerEncodingId },
				},
				select: { id: true },
			}));
		const legacyUnsentStopIds = recovery?.existingUnsent;

		if (
			existing &&
			input.resumeAisaFinalization &&
			input.action === "STOP" &&
			(existing.state === "AMBIGUOUS" ||
				existing.state === "ACKED" ||
				(existing.state === "DISPATCHING" &&
					existing.expiresAt.getTime() <= input.now.getTime()))
		) {
			const run = await tx.liveChannelRun.findFirst({
				where: { liveChannelId: input.liveChannelId },
				orderBy: { seq: "desc" },
				select: {
					id: true,
					status: true,
					error: true,
					bitmovinEncodingId: true,
					aisaAnalysisId: true,
					aisaStatus: true,
					aisaSnapshot: true,
					aisaFinalization: true,
					providerStatus: true,
				},
			});
			if (
				run?.id === input.liveChannelRunId &&
				run.bitmovinEncodingId === input.providerEncodingId &&
				run.aisaAnalysisId &&
				(existing.state !== "ACKED" ||
					aisaLiveFinalization(run) === "PENDING" ||
					(aisaLiveFinalization(run) === "FAILED" &&
						(run.status !== "ERROR" ||
							run.error !== "AISA_LIVE_TERMINAL_FAILURE")))
			)
				retryingFailed = existing;
		}
		if (
			existing &&
			!retryingFailed &&
			(existing.liveChannelId !== input.liveChannelId ||
				existing.liveChannelRunId !== input.liveChannelRunId ||
				existing.providerEncodingId !== input.providerEncodingId ||
				existing.action !== input.action ||
				(existing.scheduleId ?? undefined) !== input.scheduleId ||
				(existing.targetId ?? undefined) !== input.targetId)
		) {
			return {
				kind: "CONFLICT" as const,
				reason:
					"the request id is already bound to a different live effect identity",
			};
		}
		if (existing && !retryingFailed) {
			if (existing.state === "ACKED") {
				return {
					kind: "ACKED" as const,
					claimId: existing.id,
					providerResultId: existing.providerResultId,
				};
			}
			let state = existing.state;
			if (
				state === "DISPATCHING" &&
				existing.expiresAt.getTime() <= input.now.getTime()
			) {
				const expired = await tx.liveEffectClaim.updateMany({
					where: {
						id: existing.id,
						token: existing.token,
						state: "DISPATCHING",
					},
					data: {
						state: "AMBIGUOUS",
						failure: LEGACY_EXPIRED_DISPATCH,
					},
				});
				if (expired.count === 1) state = "AMBIGUOUS";
			}
			return {
				kind: "BLOCKED" as const,
				claimId: existing.id,
				state,
				reason:
					state === "AMBIGUOUS"
						? "the previous attempt may have applied; exact readback or operator resolution is required"
						: `the idempotency key is already ${state}`,
			};
		}
		if (
			retryingFailed &&
			(retryingFailed.liveChannelId !== input.liveChannelId ||
				retryingFailed.liveChannelRunId !== input.liveChannelRunId ||
				retryingFailed.providerEncodingId !== input.providerEncodingId ||
				retryingFailed.action !== input.action ||
				(retryingFailed.scheduleId ?? undefined) !== input.scheduleId ||
				(retryingFailed.targetId ?? undefined) !== input.targetId)
		) {
			return {
				kind: "STALE",
				reason: "a failed idempotency key cannot be rebound to another effect",
			};
		}

		const [channel, currentRun, open] = await Promise.all([
			tx.liveChannel.findUnique({
				where: { id: input.liveChannelId },
				select: {
					status: true,
					error: true,
					plan: true,
					stepLog: true,
					bitmovinAccountId: true,
					liveEffectFenceVersion: true,
					bitmovinEncodingId: true,
				},
			}),
			tx.liveChannelRun.findFirst({
				where: { liveChannelId: input.liveChannelId },
				orderBy: { seq: "desc" },
				select: {
					id: true,
					bitmovinEncodingId: true,
					stepLog: true,
					status: true,
					error: true,
					providerStatus: true,
					providerTerminalAt: true,
					stopNotificationAt: true,
					stopNotificationKind: true,
					aisaAnalysisId: true,
					aisaStatus: true,
					aisaSnapshot: true,
					archivedRtmpAttempt: true,
					previousProviderEncodingIds: true,
					rtmpRetirementEvidence: true,
				},
			}),
			tx.liveEffectClaim.findFirst({
				where: {
					liveChannelId: input.liveChannelId,
					state: { in: [...LIVE_EFFECT_OPEN_STATES] },
				},
				select: { id: true, state: true, token: true },
			}),
		]);
		if (!channel) return { kind: "STALE", reason: "channel no longer exists" };
		if (
			input.allowedChannelStatuses &&
			!input.allowedChannelStatuses.includes(channel.status) &&
			// The HTTP restart admission moves this exact run/provider to
			// PROVISIONING before its worker claims RESTART. A durable manual STOP
			// is the cost-safety winner and may preempt that one additional state;
			// immutable run/provider identity is still checked immediately below.
			!(durableManualStop && channel.status === "PROVISIONING")
		) {
			return {
				kind: "STALE",
				reason: `channel is ${channel.status}, not an admitted effect state`,
			};
		}
		if (
			currentRun?.id !== input.liveChannelRunId ||
			(input.action === "STOP" &&
				(!liveStopRunOwnsEncoding(currentRun, input.providerEncodingId) ||
					channel.bitmovinEncodingId !== input.providerEncodingId)) ||
			(currentRun.bitmovinEncodingId ?? channel.bitmovinEncodingId) !==
				input.providerEncodingId
		) {
			return {
				kind: "STALE",
				reason:
					"the planned live run or provider encoding is no longer current",
			};
		}
		// A heartbeat may have completed this exact airing after the UI queued STOP.
		// Its durable completion also owns the notification for the manual request.
		if (
			durableManualStop &&
			!open &&
			channel.status === "STOPPED" &&
			channel.error === null &&
			currentRun.status === "STOPPED" &&
			currentRun.error === null &&
			currentRun.providerTerminalAt &&
			classifyProviderStatusWord(currentRun.providerStatus) === "TERMINAL" &&
			currentRun.stopNotificationAt &&
			currentRun.stopNotificationKind === "CHANNEL_STOPPED" &&
			pendingSecondaryStopTargets(
				currentRun,
				channel,
				await readAiringEffectHistory(tx, input.liveChannelId, currentRun.id),
				liveChannelAccountId(channel),
				input.providerEncodingId,
			)?.length === 0 &&
			!(await tx.feederSession.findFirst({
				where: liveStopFeederWhere(input.liveChannelId),
				select: { id: true },
			}))
		) {
			return {
				kind: "STALE",
				reason: "the airing was already confirmed stopped",
			};
		}
		// A queue-first manual STOP is the cost-safety override. Its run/provider
		// identity is the
		// immutable admission boundary; an unrelated same-run effect advancing the
		// generation after HTTP admission must be superseded, not turn the stop into
		// a normally-completed no-op. FAILED stop retries adopt the same current
		// generation for the same reason.
		const claimedFromGeneration =
			unsentGeneration ??
			(durableManualStop
				? channel.liveEffectFenceVersion
				: retryingFailed
					? retryingFailed.generation
					: input.expectedFenceVersion);
		if (channel.liveEffectFenceVersion !== claimedFromGeneration) {
			return {
				kind: "STALE",
				reason: "the live effect generation changed after admission",
			};
		}
		if (
			open &&
			(!input.supersedeOpen ||
				(input.legacyStopDelivery && open.id !== existing?.id))
		) {
			return {
				kind: "BLOCKED",
				claimId: open.id,
				state: open.state as "CLAIMED" | "DISPATCHING" | "AMBIGUOUS",
				reason: "another external effect is unresolved on this channel",
			};
		}

		const generation = claimedFromGeneration + 1;
		const advanced = await tx.liveChannel.updateMany({
			where: {
				id: input.liveChannelId,
				liveEffectFenceVersion: claimedFromGeneration,
				...(input.action === "RESTART" ? { provisionClaimedAt: null } : {}),
			},
			data: {
				liveEffectFenceVersion: { increment: 1 },
				// This is the same transaction that supersedes the open RESTART and
				// persists STOP as DISPATCHING. No restart loser can therefore retain
				// PROVISIONING after the STOP owns its new generation.
				...(durableManualStop
					? { status: "STOPPING" as const, provisionClaimedAt: null }
					: {}),
			},
		});
		if (advanced.count !== 1) {
			if (durableManualStop) {
				// Another transaction won after our read. Throw so BullMQ's bounded
				// delivery retry re-runs the exact run/provider checks; returning STALE
				// would complete the stop job while the encoder kept billing.
				throw new Error("LIVE_STOP_ADMISSION_RACE");
			}
			return {
				kind: "STALE",
				reason:
					"the live effect generation changed while the claim was acquired",
			};
		}

		if (open && input.supersedeOpen && open.id !== retryingFailed?.id) {
			await tx.liveEffectClaim.updateMany({
				where: {
					id: open.id,
					token: open.token,
					state: { in: ["CLAIMED", "DISPATCHING"] },
				},
				data: {
					state: "AMBIGUOUS",
					failure:
						"superseded by a cost-safety STOP; exact readback is required before re-air",
				},
			});
		}

		const token = randomUUID();
		const created = retryingFailed
			? await tx.liveEffectClaim.update({
					// The claim may have been reclaimed after our first read but before
					// this manual STOP adopted the current channel generation. Only the
					// exact observed owner/state may be replaced. A lost CAS throws and
					// rolls back the channel advance and any supersession above.
					where: {
						id: retryingFailed.id,
						token: retryingFailed.token,
						state: retryingFailed.state,
						generation: retryingFailed.generation,
					},
					data: {
						generation,
						state: "CLAIMED",
						token,
						ownerId: input.ownerId,
						expiresAt: input.expiresAt,
						dispatchedAt: null,
						acknowledgedAt: null,
						failure: null,
						...(legacyUnsentStopIds ? { legacyUnsentStopIds } : {}),
						...(retryingFailed.stopProtocolVersion == null &&
						input.action === "STOP" &&
						retryingFailed.state !== "FAILED" &&
						!retryingFailed.stopSendEncodingIds?.includes(
							input.providerEncodingId,
						)
							? { stopSendEncodingIds: { push: input.providerEncodingId } }
							: {}),
						...(input.action === "STOP" &&
						retryingFailed.stopProtocolVersion == null &&
						legacyStopFailedBeforeSend(retryingFailed, channel, currentRun)
							? {
									stopProtocolVersion: 1,
									legacyStopErrorNotificationPossible: true,
								}
							: {}),
						attempt: { increment: 1 },
					},
				})
			: await tx.liveEffectClaim.create({
					data: {
						liveChannelId: input.liveChannelId,
						liveChannelRunId: input.liveChannelRunId,
						...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
						action: input.action,
						...(input.legacyStopDelivery && input.legacyStopDelivery !== "FIRST"
							? // A worker from before the send ledger may have posted for any
								// encoder in this compound STOP. Reuse its readback-only semantics.
								{
									stopProtocolVersion: null,
									stopSendEncodingIds: [input.providerEncodingId],
								}
							: input.action === "STOP"
								? { stopProtocolVersion: 1 }
								: {}),
						idempotencyKey: input.idempotencyKey,
						...(input.requestSha256
							? { requestSha256: input.requestSha256 }
							: {}),
						providerEncodingId: input.providerEncodingId,
						...(input.targetId ? { targetId: input.targetId } : {}),
						generation,
						state: "CLAIMED",
						token,
						ownerId: input.ownerId,
						expiresAt: input.expiresAt,
					},
				});
		if (
			retryingFailed?.state === "FAILED" &&
			input.action === "STOP" &&
			input.scheduleId
		) {
			// A new attempt is underway. A crash or its final callback must never inherit
			// a definitive pre-send failure from the previous attempt.
			await tx.liveSchedule.updateMany({
				where: {
					id: input.scheduleId,
					liveChannelId: input.liveChannelId,
					liveChannelRunId: input.liveChannelRunId,
					action: "STOP",
					status: "FIRED",
					outcome: "FAILED",
					outcomeEvidenceKind: "EFFECT_FAILED",
				},
				data: {
					outcome: "PENDING",
					outcomeAt: null,
					outcomeNote: null,
					outcomeEvidenceAt: null,
					outcomeEvidenceKind: null,
					outcomeEvidenceVersion: null,
				},
			});
		}
		await hooks.afterClaimed?.();
		const intent = await tx.liveEffectClaim.updateMany({
			where: { id: created.id, token, state: "CLAIMED" },
			data: { state: "DISPATCHING", dispatchedAt: input.now },
		});
		if (intent.count !== 1) {
			throw new Error("LIVE_EFFECT_INTENT_NOT_DURABLE");
		}
		return {
			kind: "EXECUTE",
			claim: {
				...handleOf({ ...created, generation }),
				...(input.action === "STOP" &&
				(recoveringLegacyAck ||
					retryingPromotedTarget ||
					(retryingFailed &&
						(retryingFailed.state !== "FAILED" || retryingFailed.attempt > 1)))
					? { requireActiveStopReadback: true }
					: {}),
			},
		};
	});
}

/**
 * ACK the exact STOP and close older uncertainty in one transaction, only
 * when the ended run has three independent terminal facts: our stop landed
 * cleanly, the provider was read back terminal, and no feeder still owns or
 * may own a publisher process.
 */
async function resolveLiveEffectsAfterConfirmedStopOnce(
	prisma: AppPrismaClient,
	input: ResolveLiveEffectsAfterConfirmedStopInput,
): Promise<ResolveLiveEffectsAfterConfirmedStopResult> {
	return prisma.$transaction(
		async (tx) => {
			const proof = input.terminalReadback;
			const owner = input.ownerReadbacks;
			const periodic =
				proof !== undefined || input.interruptedAckGeneration !== undefined;
			const [channel, run, feeder, stopClaim, history] = await Promise.all([
				tx.liveChannel.findUnique({
					where: { id: input.liveChannelId },
					select: {
						name: true,
						status: true,
						error: true,
						liveEffectFenceVersion: true,
						bitmovinEncodingId: true,
						bitmovinAccountId: true,
						origin: true,
						plan: true,
						stepLog: true,
					},
				}),
				tx.liveChannelRun.findFirst({
					where: { liveChannelId: input.liveChannelId },
					orderBy: { seq: "desc" },
					select: {
						id: true,
						status: true,
						error: true,
						bitmovinEncodingId: true,
						providerStatus: true,
						providerStatusObservedAt: true,
						providerTerminalAt: true,
						aisaAnalysisId: true,
						aisaStatus: true,
						aisaSnapshot: true,
						aisaFinalization: true,
						stepLog: true,
						previousProviderEncodingIds: true,
						archivedRtmpAttempt: true,
						rtmpRetirementEvidence: true,
						endedAt: true,
					},
				}),
				tx.feederSession.findFirst({
					where: liveStopFeederWhere(input.liveChannelId),
					select: { id: true },
				}),
				tx.liveEffectClaim.findUnique({ where: { id: input.stopClaimId } }),
				tx.liveEffectClaim.findMany({
					where: {
						liveChannelId: input.liveChannelId,
						liveChannelRunId: input.liveChannelRunId,
					},
					select: {
						id: true,
						idempotencyKey: true,
						scheduleId: true,
						providerEncodingId: true,
						action: true,
						generation: true,
						state: true,
						token: true,
						failure: true,
						stopProtocolVersion: true,
						legacyStopErrorNotificationPossible: true,
						attempt: true,
						stopSendEncodingIds: true,
						legacyUnsentStopIds: true,
						stopAnalysisSendId: true,
						stopOutcomeEvidence: true,
					},
				}),
			]);
			const blocked = (reason: string) => ({
				kind: "BLOCKED" as const,
				reason,
			});
			if (
				!stopClaim ||
				stopClaim.idempotencyKey !== input.stopIdempotencyKey ||
				stopClaim.liveChannelId !== input.liveChannelId ||
				stopClaim.liveChannelRunId !== input.liveChannelRunId ||
				stopClaim.providerEncodingId !== input.providerEncodingId ||
				stopClaim.action !== "STOP"
			)
				return blocked("the exact STOP identity changed");
			if (stopClaim.state === "ACKED") return { kind: "ALREADY_ACKED" };
			if (
				!channel ||
				!run ||
				run.id !== input.liveChannelRunId ||
				channel.bitmovinEncodingId !== input.providerEncodingId ||
				!liveStopRunOwnsEncoding(run, input.providerEncodingId) ||
				stopClaim.generation !== channel.liveEffectFenceVersion ||
				!["DISPATCHING", "AMBIGUOUS"].includes(stopClaim.state)
			)
				return blocked(
					"the exact STOP claim is not the current unresolved effect",
				);
			const stopGeneration = stopClaim.generation;
			const terminal = new Map(
				(owner?.encodings ?? proof?.encodings ?? []).map(({ id, status }) => [
					id,
					status,
				]),
			);
			if (!owner) {
				const recorded =
					run.providerStatusObservedAt && run.providerTerminalAt
						? run.providerStatus
						: null;
				const status = proof?.providerStatus ?? recorded;
				if (status) terminal.set(input.providerEncodingId, status);
			}
			const providerStatus = terminal.get(input.providerEncodingId);
			if (
				!providerStatus ||
				[...terminal.values()].some(
					(status) => classifyProviderStatusWord(status) !== "TERMINAL",
				)
			)
				return blocked(
					"the exact provider encoding has no authoritative terminal readback",
				);
			if (
				Math.max(
					rtmpRebuildAttempt(run.stepLog),
					rtmpRebuildAttempt(channel.stepLog),
				) > (run.archivedRtmpAttempt ?? 0)
			)
				return blocked(
					"encoder identities from an earlier RTMP rebuild were not archived; verify the provider account before resolving this broadcast",
				);
			const inventory = outstandingLiveStopTargets(
				run,
				channel,
				history,
				liveChannelAccountId(channel),
				input.providerEncodingId,
			);
			const targets = inventory.encodingIds;
			if (!inventory.complete || targets.some((id) => !terminal.has(id)))
				return blocked(
					"a broadcast log or historical effect identifies an encoder without terminal readback",
				);
			const stops = history.filter(
				(c) =>
					c.action === "STOP" &&
					LIVE_EFFECT_OPEN_STATES.some((state) => state === c.state),
			);
			if (
				stops.some(
					(c) =>
						c.providerEncodingId !== input.providerEncodingId ||
						c.generation > stopGeneration,
				)
			)
				return blocked(
					"another unresolved STOP needs independent target verification",
				);
			if (feeder) return blocked("a feeder still occupies this channel");
			const aisa = aisaLiveFinalization({ ...run, providerStatus });
			if (
				aisa === "PENDING" ||
				(isAisaManagedLivePlan(channel.plan) && aisa === "UNBOUND")
			)
				return blocked("the exact Analysis finalization is not yet confirmed");
			const confirmedStatus = aisa === "FAILED" ? "ERROR" : "STOPPED";
			const confirmedError =
				aisa === "FAILED" ? "AISA_LIVE_TERMINAL_FAILURE" : null;
			if (
				periodic &&
				(channel.origin !== "MANAGED" ||
					(aisa !== "COMPLETE" &&
						(isAisaManagedLivePlan(channel.plan) ||
							run.aisaAnalysisId ||
							[run.stepLog, channel.stepLog].some((log) =>
								stepLogSchema
									.parse(log)
									.some((e) => e.kind === "RESOLVE_AISA_LIVE_ENCODING"),
							))))
			)
				return blocked(
					"periodic STOP reconciliation requires an ordinary managed broadcast or complete Analysis finalization",
				);
			if (owner) {
				if (
					owner.generation !== stopGeneration ||
					owner.token !== stopClaim.token ||
					stopClaim.state !== "DISPATCHING" ||
					liveChannelAccountId(channel) !== owner.bitmovinAccountId ||
					channel.status !== "STOPPING"
				)
					return blocked("the original STOP no longer owns these readbacks");
			} else if (proof) {
				const matchingRun =
					channel.status === run.status && channel.error === run.error;
				const terminalHeartbeat =
					run.status === "STOPPED" &&
					run.error === null &&
					run.providerTerminalAt &&
					run.providerStatusObservedAt &&
					classifyProviderStatusWord(run.providerStatus) === "TERMINAL";
				if (
					proof.generation !== stopGeneration ||
					liveChannelAccountId(channel) !== proof.bitmovinAccountId ||
					!canObserveLiveStop(stopClaim, channel, input.at) ||
					!(
						matchingRun ||
						terminalHeartbeat ||
						(stopClaim.stopProtocolVersion == null &&
							(channel.status === "STOPPED" || channel.status === "ERROR") &&
							(run.status === "STOPPING" ||
								(run.status === "ERROR" &&
									run.error === STRANDED_RUN_ERROR &&
									!!channel.error &&
									(stopClaim.failure === channel.error ||
										stopClaim.failure ===
											liveEffectSendUncertainty(channel.error))))) ||
						(channel.status === "STOPPING" &&
							[
								"STOPPING",
								"RUNNING",
								"ERROR",
								"PROVISIONING",
								"STOPPED",
							].includes(run.status))
					)
				)
					return blocked(
						"the terminal GET cannot be bound to this interrupted or uncertain STOP",
					);
			} else {
				if (
					channel.status !== confirmedStatus ||
					channel.error !== confirmedError ||
					run.status !== confirmedStatus ||
					run.error !== confirmedError
				)
					return blocked("the exact channel STOP is not confirmed clean");
				if (
					input.interruptedAckGeneration !== undefined &&
					(input.interruptedAckGeneration !== stopGeneration ||
						(stopClaim.state === "DISPATCHING" &&
							stopClaim.expiresAt > input.at))
				)
					return blocked("the interrupted STOP owner has not expired");
			}
			const legacyFailure =
				proof && stopClaim.stopProtocolVersion == null && channel.error
					? {
							accountId: proof.bitmovinAccountId,
							status: channel.status,
							error: channel.error,
							requiredEncodingIds: targets,
							encodings: [...terminal].map(([id, status]) => ({ id, status })),
						}
					: null;
			// Advance the same CAS that beginLiveEffect uses. A stale admission that
			// read the pre-reconciliation fence must lose even if it resumes only after
			// this transaction commits; a no-op row lock would not invalidate it.
			const archived =
				pendingAiringRetirement(
					run,
					channel,
					history,
					liveChannelAccountId(channel),
				) ?? [];
			if (archived.length && !owner && !proof)
				return blocked(
					"archived encoder ownership requires an account-bound provider read",
				);
			const observedAccount =
				owner?.bitmovinAccountId ?? proof?.bitmovinAccountId;
			const retirements: RtmpRetirementReceipt[] = [];
			if (observedAccount)
				for (const encodingId of archived) {
					const status = terminal.get(encodingId);
					if (status)
						retirements.push({
							accountId: observedAccount,
							encodingId,
							providerStatus: status,
							observedAt: input.at.toISOString(),
							disposition: "TERMINAL",
						});
				}
			const locked = await tx.liveChannel.updateMany({
				where: {
					id: input.liveChannelId,
					status: channel.status,
					error: channel.error,
					bitmovinEncodingId: input.providerEncodingId,
					liveEffectFenceVersion: stopGeneration,
					effectClaims: {
						some: {
							id: input.stopClaimId,
							idempotencyKey: input.stopIdempotencyKey,
							liveChannelRunId: input.liveChannelRunId,
							providerEncodingId: input.providerEncodingId,
							action: "STOP",
							generation: stopGeneration,
							state: {
								in: [stopClaim.state],
							},
						},
					},
				},
				data: {
					liveEffectFenceVersion: { increment: 1 },
					status: confirmedStatus,
					error: confirmedError,
				},
			});
			if (locked.count !== 1) {
				return {
					kind: "BLOCKED",
					reason: "the exact channel STOP changed during reconciliation",
				};
			}
			{
				const projected = await tx.liveChannelRun.updateMany({
					where: {
						id: run.id,
						liveChannelId: input.liveChannelId,
						bitmovinEncodingId: run.bitmovinEncodingId,
						status: run.status,
						error: run.error,
					},
					data: {
						status: confirmedStatus,
						error: confirmedError,
						...(retirements.length
							? {
									rtmpRetirementEvidence: mergeRtmpRetirementEvidence(
										run.rtmpRetirementEvidence,
										retirements,
									),
								}
							: {}),
						endedAt: run.endedAt ?? input.at,
						bitmovinEncodingId: input.providerEncodingId,
						heartbeatPollEpoch: { increment: 1 },
						providerStatus,
						providerStatusObservedAt:
							proof || owner ? input.at : run.providerStatusObservedAt,
						...(run.aisaAnalysisId && { cancelRequested: false }),
						providerUnknownSince: null,
						providerUnknownAlertedAt: null,
						providerTerminalAt: run.providerTerminalAt ?? input.at,
					},
				});
				if (projected.count !== 1)
					throw new Error("LIVE_STOP_RECONCILIATION_RUN_FENCE_LOST");
			}
			const acknowledged = await tx.liveEffectClaim.updateMany({
				where: {
					id: input.stopClaimId,
					idempotencyKey: input.stopIdempotencyKey,
					liveChannelId: input.liveChannelId,
					liveChannelRunId: input.liveChannelRunId,
					providerEncodingId: input.providerEncodingId,
					action: "STOP",
					generation: stopGeneration,
					state: { in: [stopClaim.state] },
					// Keep the ownership predicate on the ACK itself as a second fence. The
					// channel row is already write-locked above against re-air admission.
					liveChannel: {
						is: {
							status: confirmedStatus,
							error: confirmedError,
							bitmovinEncodingId: input.providerEncodingId,
							liveEffectFenceVersion: stopGeneration + 1,
						},
					},
				},
				data: {
					state: "ACKED",
					...(legacyFailure ? { stopOutcomeEvidence: legacyFailure } : {}),
					acknowledgedAt: input.at,
					...(proof && !stopClaim.failure && channel.error
						? { failure: channel.error }
						: {}),
					...(confirmedError && !stopClaim.failure
						? { failure: confirmedError }
						: {}),
				},
			});
			if (acknowledged.count !== 1) {
				// Throw so the transaction rolls back the fence increment. Redelivery
				// re-runs authoritative readback and never sends a second provider STOP.
				throw new Error("LIVE_STOP_RECONCILIATION_ACK_FENCE_LOST");
			}
			for (const sibling of stops.filter((c) => c.id !== input.stopClaimId)) {
				const finished = await tx.liveEffectClaim.updateMany({
					where: {
						id: sibling.id,
						token: sibling.token,
						generation: sibling.generation,
						providerEncodingId: input.providerEncodingId,
						state: sibling.state,
					},
					data: { state: "ACKED", acknowledgedAt: input.at },
				});
				if (finished.count !== 1)
					throw new Error("LIVE_STOP_RECONCILIATION_SIBLING_FENCE_LOST");
			}
			await recordConfirmedStopDelivery(tx, {
				channelName: channel.name,
				// Older workers could emit an unkeyed notification before persisting the ACK.
				notificationEligible:
					stopClaim.stopProtocolVersion === 1 &&
					stopNotificationHistoryEligible(
						history,
						channel,
						run,
						confirmedStatus,
					),
				liveChannelId: input.liveChannelId,
				liveChannelRunId: run.id,
				status: confirmedStatus,
				at: input.at,
				scheduleIds: stops.flatMap((c) => (c.scheduleId ? [c.scheduleId] : [])),
			});
			const { count } = await tx.liveEffectClaim.updateMany({
				where: {
					id: { not: input.stopClaimId },
					action: { not: "STOP" },
					liveChannelId: input.liveChannelId,
					liveChannelRunId: input.liveChannelRunId,
					providerEncodingId: input.providerEncodingId,
					state: { in: [...LIVE_EFFECT_OPEN_STATES] },
				},
				data: {
					state: "RESOLVED",
					acknowledgedAt: input.at,
				},
			});
			return {
				kind: "RESOLVED",
				count,
				...(confirmedStatus === "ERROR"
					? { terminalFailure: true as const }
					: {}),
				...(proof && channel.status === "ERROR"
					? { recoveredFromError: true as const }
					: {}),
			};
		},
		{ isolationLevel: "Serializable" },
	);
}

export async function wasLiveStopAcknowledged(
	db: Pick<AppTransactionClient, "liveEffectClaim">,
	claim: Pick<
		LiveEffectClaimHandle,
		| "id"
		| "idempotencyKey"
		| "liveChannelId"
		| "liveChannelRunId"
		| "providerEncodingId"
	>,
): Promise<boolean> {
	const row = await db.liveEffectClaim.findUnique({
		where: { id: claim.id },
		select: {
			state: true,
			action: true,
			idempotencyKey: true,
			liveChannelId: true,
			liveChannelRunId: true,
			providerEncodingId: true,
		},
	});
	return (
		row?.state === "ACKED" &&
		row.action === "STOP" &&
		row.idempotencyKey === claim.idempotencyKey &&
		row.liveChannelId === claim.liveChannelId &&
		row.liveChannelRunId === claim.liveChannelRunId &&
		row.providerEncodingId === claim.providerEncodingId
	);
}

export async function resolveLiveEffectsAfterConfirmedStop(
	prisma: AppPrismaClient,
	input: ResolveLiveEffectsAfterConfirmedStopInput,
): Promise<ResolveLiveEffectsAfterConfirmedStopResult> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			const outcome = await resolveLiveEffectsAfterConfirmedStopOnce(
				prisma,
				input,
			);
			if (
				outcome.kind === "BLOCKED" &&
				(await wasLiveStopAcknowledged(prisma, {
					...input,
					id: input.stopClaimId,
					idempotencyKey: input.stopIdempotencyKey,
				}))
			)
				return { kind: "ALREADY_ACKED" };
			return outcome;
		} catch (error) {
			if (!isPrismaSerializationConflict(error) || attempt >= 2) throw error;
		}
	}
}

/** Re-check the exact token/run/encoding/generation immediately pre-send. */
export async function assertLiveEffectCurrent(
	prisma: Pick<
		AppPrismaClient,
		"liveChannel" | "liveChannelRun" | "liveEffectClaim"
	>,
	claim: LiveEffectClaimHandle,
	now: Date,
): Promise<boolean> {
	const ordinaryTimer = claim.action === "AUTO_SHUTDOWN_UPDATE";
	const [held, channel, currentRun] = await Promise.all([
		prisma.liveEffectClaim.findUnique({
			where: { idempotencyKey: claim.idempotencyKey },
			select: { id: true, token: true, state: true, expiresAt: true },
		}),
		prisma.liveChannel.findUnique({
			where: { id: claim.liveChannelId },
			select: {
				...(ordinaryTimer ? { origin: true, plan: true, stepLog: true } : {}),
				liveEffectFenceVersion: true,
				provisionClaimedAt: true,
				bitmovinEncodingId: true,
			},
		}),
		prisma.liveChannelRun.findFirst({
			where: { liveChannelId: claim.liveChannelId },
			orderBy: { seq: "desc" },
			select: {
				id: true,
				bitmovinEncodingId: true,
				...(ordinaryTimer
					? {
							stepLog: true,
							aisaAnalysisId: true,
							aisaStatus: true,
							aisaSnapshot: true,
						}
					: {}),
			},
		}),
	]);
	return (
		(!ordinaryTimer || !hasAisaLiveBinding(channel, currentRun)) &&
		held?.id === claim.id &&
		held.token === claim.token &&
		held.state === "DISPATCHING" &&
		held.expiresAt.getTime() > now.getTime() &&
		channel?.liveEffectFenceVersion === claim.generation &&
		(claim.action !== "RESTART" || channel.provisionClaimedAt == null) &&
		currentRun?.id === claim.liveChannelRunId &&
		(currentRun.bitmovinEncodingId ?? channel?.bitmovinEncodingId) ===
			claim.providerEncodingId
	);
}

/** Reserve each outgoing STOP under the same channel lock used for supersession. */
export async function claimLiveStopSend(
	prisma: AppPrismaClient,
	claim: LiveEffectClaimHandle,
	encodingId: string,
	at: Date,
): Promise<boolean> {
	return prisma.$transaction(async (tx) => {
		const held = {
			id: claim.id,
			action: "STOP" as const,
			token: claim.token,
			state: "DISPATCHING" as const,
			expiresAt: { gt: at },
		};
		const lock = await tx.liveChannel.updateMany({
			where: {
				id: claim.liveChannelId,
				bitmovinEncodingId: claim.providerEncodingId,
				liveEffectFenceVersion: claim.generation,
				effectClaims: { some: held },
			},
			data: { liveEffectFenceVersion: claim.generation },
		});
		if (!lock.count) return false;
		const recorded = await tx.liveEffectClaim.updateMany({
			where: { ...held, NOT: { stopSendEncodingIds: { has: encodingId } } },
			data: { stopSendEncodingIds: { push: encodingId } },
		});
		return recorded.count === 1;
	});
}

/** The Analysis and Encoding stop POSTs are independent. An older reservation
 * suppresses only that provider operation; an owner lost during the binding
 * GET must leave the winning owner eligible to make the first POST. */
export async function reserveAisaStop(
	prisma: AppPrismaClient,
	claim: LiveEffectClaimHandle,
	service: "analysis" | "encoding",
	targetId: string,
	at: Date,
): Promise<"RESERVED" | "PRIOR" | "LOST"> {
	return prisma.$transaction(async (tx) => {
		const held = {
			id: claim.id,
			token: claim.token,
			state: "DISPATCHING" as const,
			expiresAt: { gt: at },
		};
		const lock = await tx.liveChannel.updateMany({
			where: {
				id: claim.liveChannelId,
				bitmovinEncodingId: claim.providerEncodingId,
				liveEffectFenceVersion: claim.generation,
				effectClaims: { some: held },
			},
			data: { liveEffectFenceVersion: claim.generation },
		});
		if (!lock.count) return "LOST";
		const run = await tx.liveChannelRun.findFirst({
			where: { liveChannelId: claim.liveChannelId },
			orderBy: { seq: "desc" },
			select: { id: true, bitmovinEncodingId: true, aisaAnalysisId: true },
		});
		if (
			!run ||
			run.id !== claim.liveChannelRunId ||
			!run.aisaAnalysisId ||
			run.bitmovinEncodingId !== claim.providerEncodingId ||
			(service === "analysis" ? run.aisaAnalysisId : run.bitmovinEncodingId) !==
				targetId
		)
			return "LOST";
		const previous = await tx.liveEffectClaim.findFirst({
			where: {
				liveChannelRunId: run.id,
				liveChannelId: claim.liveChannelId,
				action: "STOP",
				OR: [
					service === "analysis"
						? { stopAnalysisSendId: targetId }
						: { stopSendEncodingIds: { has: targetId } },
					{
						id: { not: claim.id },
						stopProtocolVersion: null,
						state: { in: ["DISPATCHING", "AMBIGUOUS", "ACKED"] },
					},
				],
			},
			select: { id: true },
		});
		if (previous) return "PRIOR";
		await tx.liveEffectClaim.update({
			where: { id: claim.id, token: claim.token },
			data:
				service === "analysis"
					? { stopAnalysisSendId: targetId }
					: { stopSendEncodingIds: { push: targetId } },
		});
		return "RESERVED";
	});
}

export async function markLiveEffectAcked(
	prisma: AppPrismaClient,
	claim: LiveEffectClaimHandle,
	at: Date,
	evidence: { providerResultId?: string } = {},
): Promise<boolean> {
	const { count } = await prisma.liveEffectClaim.updateMany({
		where: {
			id: claim.id,
			token: claim.token,
			state: { in: ["DISPATCHING", "AMBIGUOUS"] },
		},
		data: {
			state: "ACKED",
			acknowledgedAt: at,
			failure: null,
			...(evidence.providerResultId
				? { providerResultId: evidence.providerResultId }
				: {}),
		},
	});
	return count === 1;
}

/** A late owner cannot overwrite the winner's channel, history, or error evidence. */
export async function recordLiveStopFailure(
	prisma: AppPrismaClient,
	claim: LiveEffectClaimHandle,
	input: {
		status: "STOPPED" | "ERROR";
		error: string;
		failure: string;
		state: "FAILED" | "AMBIGUOUS";
		accountId?: string | null;
		encodings?: StopReceipt[];
		requiredEncodingIds?: string[];
		at: Date;
	},
): Promise<"RECORDED" | "ALREADY_ACKED" | "LOST"> {
	return prisma.$transaction(async (tx) => {
		const current = await tx.liveChannel.updateMany({
			where: {
				id: claim.liveChannelId,
				liveEffectFenceVersion: claim.generation,
				bitmovinEncodingId: claim.providerEncodingId,
				effectClaims: {
					some: {
						id: claim.id,
						token: claim.token,
						action: "STOP",
						state: "DISPATCHING",
					},
				},
			},
			data: { status: input.status, error: input.error },
		});
		if (!current.count) {
			return (await wasLiveStopAcknowledged(tx, claim))
				? "ALREADY_ACKED"
				: "LOST";
		}
		const run = {
			id: claim.liveChannelRunId,
			liveChannelId: claim.liveChannelId,
		};
		const account =
			input.accountId &&
			(await tx.liveChannel.findUnique({
				where: { id: claim.liveChannelId },
				select: { plan: true, bitmovinAccountId: true },
			}));
		const accountMatches =
			!!account && liveChannelAccountId(account) === input.accountId;
		const receipts = (accountMatches ? (input.encodings ?? []) : []).filter(
			(r) => classifyProviderStatusWord(r.status) === "TERMINAL",
		);
		const primary =
			input.accountId &&
			receipts.find((r) => r.id === claim.providerEncodingId);
		const projected = await tx.liveChannelRun.updateMany({
			where: run,
			data: {
				status: input.status,
				error: input.error,
				...(primary
					? {
							providerStatus: primary.status,
							providerStatusObservedAt: input.at,
							heartbeatPollEpoch: { increment: 1 },
							providerUnknownSince: null,
							providerUnknownAlertedAt: null,
						}
					: {}),
			},
		});
		if (primary)
			await tx.liveChannelRun.updateMany({
				where: { ...run, providerTerminalAt: null },
				data: { providerTerminalAt: input.at },
			});
		const marked = await tx.liveEffectClaim.updateMany({
			where: { id: claim.id, token: claim.token, state: "DISPATCHING" },
			data: {
				state: input.state,
				failure: input.failure,
				stopOutcomeEvidence: {
					status: input.status,
					error: input.error,
					accountId: input.accountId ?? null,
					encodings: receipts,
					requiredEncodingIds: input.requiredEncodingIds ?? [],
				},
			},
		});
		if (projected.count !== 1 || marked.count !== 1)
			throw new Error("LIVE_STOP_FAILURE_FENCE_LOST");
		await recordStopScheduleFailure(tx, claim.id, {
			liveChannelId: claim.liveChannelId,
			liveChannelRunId: claim.liveChannelRunId,
			state: input.state,
			status: input.status,
			error: input.error,
			at: input.at,
		});
		await tx.liveChannelRun.updateMany({
			where: { ...run, endedAt: null },
			data: { endedAt: input.at },
		});
		return "RECORDED";
	});
}

export async function markLiveEffectAmbiguous(
	prisma: AppPrismaClient,
	claim: LiveEffectClaimHandle,
	reason: string,
): Promise<boolean> {
	if (claim.action === "STOP" && claim.scheduleId) {
		return prisma.$transaction(async (tx) => {
			const changed = await tx.liveEffectClaim.updateMany({
				where: { id: claim.id, token: claim.token, state: "DISPATCHING" },
				data: { state: "AMBIGUOUS", failure: reason },
			});
			if (!changed.count) return false;
			await recordStopScheduleFailure(tx, claim.id, {
				liveChannelId: claim.liveChannelId,
				liveChannelRunId: claim.liveChannelRunId,
				state: "AMBIGUOUS",
				status: "ERROR",
				error: reason,
				at: new Date(),
			});
			return true;
		});
	}
	const { count } = await prisma.liveEffectClaim.updateMany({
		where: { id: claim.id, token: claim.token, state: "DISPATCHING" },
		data: { state: "AMBIGUOUS", failure: reason },
	});
	return count === 1;
}

export async function markLiveEffectFailed(
	prisma: AppPrismaClient,
	claim: LiveEffectClaimHandle,
	reason: string,
): Promise<boolean> {
	const { count } = await prisma.liveEffectClaim.updateMany({
		where: { id: claim.id, token: claim.token, state: "DISPATCHING" },
		data: { state: "FAILED", failure: reason },
	});
	return count === 1;
}

/**
 * Resolve the durable claim handed from the live-action worker to a feeder
 * session. An expired DISPATCHING claim is evidence of an uncertain spawn,
 * never permission to spawn again, so the same read turns it AMBIGUOUS.
 */
export async function loadLiveEffectTargetClaim(
	prisma: AppPrismaClient,
	input: { liveChannelId: string; targetId: string; now: Date },
): Promise<LiveEffectTargetClaimResult> {
	const row = await prisma.liveEffectClaim.findFirst({
		where: {
			liveChannelId: input.liveChannelId,
			targetId: input.targetId,
			state: { in: [...LIVE_EFFECT_OPEN_STATES] },
		},
		orderBy: { createdAt: "desc" },
	});
	if (!row) return { kind: "NONE" };
	if (row.state === "DISPATCHING") {
		if (row.expiresAt.getTime() <= input.now.getTime()) {
			await prisma.liveEffectClaim.updateMany({
				where: { id: row.id, token: row.token, state: "DISPATCHING" },
				data: {
					state: "AMBIGUOUS",
					failure:
						"effect owner expired before the feeder spawn was acknowledged; operator resolution is required",
				},
			});
			return {
				kind: "BLOCKED",
				claimId: row.id,
				state: "AMBIGUOUS",
				reason:
					"the previous feeder spawn may have applied; operator resolution is required",
			};
		}
		return { kind: "DISPATCHING", claim: handleOf(row) };
	}
	return {
		kind: "BLOCKED",
		claimId: row.id,
		state: row.state as "CLAIMED" | "AMBIGUOUS",
		reason:
			row.state === "AMBIGUOUS"
				? "the previous feeder spawn may have applied; operator resolution is required"
				: "the feeder effect claim has not reached its durable dispatch intent",
	};
}

/** Bind a newly-created feeder session to the still-held effect claim. */
export async function bindLiveEffectTarget(
	prisma: AppPrismaClient,
	claim: LiveEffectClaimHandle,
	targetId: string,
): Promise<boolean> {
	const { count } = await prisma.liveEffectClaim.updateMany({
		where: {
			id: claim.id,
			token: claim.token,
			state: "DISPATCHING",
			OR: [{ targetId: null }, { targetId }],
		},
		data: { targetId },
	});
	return count === 1;
}
