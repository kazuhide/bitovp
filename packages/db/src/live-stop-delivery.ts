import { redactSecrets, scheduledStopJobId } from "@bitovp/core";
import type { Prisma } from "../generated/client";
import type { AppTransactionClient } from "./client";

export const CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION = 1;

/** Whether a legacy sweep fence belongs to the STOP now closing this airing. */
export function isLiveStopAdmissionFence(
	legacyFence: number | null,
	generation: number,
	claim?: { attempt: number },
): legacyFence is number {
	if (legacyFence === null) return false;
	if (legacyFence === generation) return true;
	if (!claim) return false;
	if (legacyFence === generation - 1) return true;
	// A claim starts one generation after admission. On retry both
	// counters advance together from that claim's exact previous generation.
	return legacyFence === generation - claim.attempt;
}

/** A terminal observation alone leaves this schedule's delivery unknown. */
export async function recordObservedScheduledStop(
	tx: AppTransactionClient,
	input: {
		scheduleId: string;
		liveChannelId: string;
		liveChannelRunId: string;
		providerEncodingId: string;
		generation: number;
		at: Date;
	},
): Promise<void> {
	await tx.liveSchedule.updateMany({
		where: {
			id: input.scheduleId,
			liveChannelId: input.liveChannelId,
			liveChannelRunId: input.liveChannelRunId,
			action: "STOP",
			status: "FIRED",
			outcome: "PENDING",
			OR: [
				{ stopProviderEncodingId: null, stopAdmissionFenceVersion: null },
				{
					stopProviderEncodingId: input.providerEncodingId,
					stopAdmissionFenceVersion: { lt: input.generation },
				},
			],
		},
		data: {
			outcome: "UNKNOWN",
			outcomeNote:
				"The broadcast ended. Delivery of this scheduled STOP could not be confirmed.",
			outcomeAt: input.at,
			outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
			outcomeEvidenceVersion: CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
			outcomeEvidenceAt: input.at,
		},
	});
}

/**
 * Called while committing the channel's exact terminal transition. Each matching
 * schedule was handed off and independently observed exhausted before this STOP
 * won the channel. A missing claim or an exact pre-send failure leaves the
 * schedule's provider outcome unknown.
 */
export async function settleExhaustedStopSchedules(
	tx: AppTransactionClient,
	input: {
		liveChannelId: string;
		liveChannelRunId: string;
		providerEncodingId: string;
		admissionFence: number;
		at: Date;
	},
): Promise<void> {
	await tx.$executeRaw`
		UPDATE "LiveSchedule" s SET
			"outcome" = 'UNKNOWN',
			"outcomeNote" = 'The scheduled STOP delivery was exhausted before its provider outcome could be confirmed.',
			"outcomeAt" = ${input.at},
			"outcomeEvidenceAt" = ${input.at},
			"outcomeEvidenceKind" = 'JOB_TERMINAL_UNKNOWN',
			"outcomeEvidenceVersion" = ${CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION},
			"updatedAt" = statement_timestamp()
		WHERE s."liveChannelId" = ${input.liveChannelId}::uuid
			AND s."liveChannelRunId" = ${input.liveChannelRunId}::uuid
			AND s."action" = 'STOP' AND s."status" = 'FIRED' AND s."outcome" = 'PENDING'
			AND s."dispatchedAt" IS NOT NULL
			AND (s."dispatchJobId" IS NULL OR s."dispatchJobId" = 'sched-' || s.id::text || COALESCE('-stop-' || s."stopDeliveryToken"::text, ''))
			AND s."legacyStopExhaustedFence" = ${input.admissionFence}
			AND ((s."stopProviderEncodingId" IS NULL AND s."stopAdmissionFenceVersion" IS NULL)
				OR (s."stopProviderEncodingId" = ${input.providerEncodingId}
					AND s."stopAdmissionFenceVersion" = ${input.admissionFence}))
			AND NOT EXISTS (
				SELECT 1 FROM "LiveEffectClaim" c
				WHERE (c."scheduleId" = s.id OR c."idempotencyKey" = 'schedule:' || s.id::text || ':stop')
					AND NOT (
						c."scheduleId" IS NOT DISTINCT FROM s.id
						AND c."idempotencyKey" = 'schedule:' || s.id::text || ':stop'
						AND c."liveChannelId" = s."liveChannelId"
						AND c."liveChannelRunId" = s."liveChannelRunId"
						AND c."providerEncodingId" = ${input.providerEncodingId}
						AND c."action" = 'STOP' AND c."state" = 'FAILED'
						AND c."generation" = ${input.admissionFence}
						AND cardinality(c."stopSendEncodingIds") = 0
						AND c."stopAnalysisSendId" IS NULL AND c."stopOutcomeEvidence" IS NULL
					)
			)
	`;
}

/** An exact, accepted STOP and its terminal read supersede an earlier queue
 * observation for this same handed-off admission. Other UNKNOWN history is sticky. */
export async function recordOwnedScheduledStopDelivery(
	tx: AppTransactionClient,
	input: {
		scheduleId: string;
		liveChannelId: string;
		liveChannelRunId: string;
		providerEncodingId: string;
		admissionFence: number;
		at: Date;
	},
) {
	const receipt = await tx.liveSchedule.findFirst({
		where: {
			id: input.scheduleId,
			liveChannelId: input.liveChannelId,
			liveChannelRunId: input.liveChannelRunId,
			outcome: { in: ["PENDING", "FAILED", "UNKNOWN"] },
		},
		select: {
			stopDeliveryToken: true,
			stopAdmissionFenceVersion: true,
			stopProviderEncodingId: true,
		},
	});
	if (!receipt) return;
	const legacy =
		receipt.stopDeliveryToken === null &&
		receipt.stopAdmissionFenceVersion === null &&
		receipt.stopProviderEncodingId === null;
	const expectedJobId = scheduledStopJobId(
		input.scheduleId,
		receipt.stopDeliveryToken,
	);
	const outcomes: Prisma.LiveScheduleWhereInput[] = [
		{ outcome: "PENDING" },
		{ outcome: "FAILED", outcomeEvidenceKind: "EFFECT_FAILED" },
	];
	if (!legacy)
		outcomes.push({
			outcome: "UNKNOWN",
			outcomeEvidenceKind: {
				in: ["JOB_TERMINAL_UNKNOWN", "PROVIDER_STATUS_UNKNOWN"],
			},
			outcomeEvidenceVersion: CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
		});
	await tx.liveSchedule.updateMany({
		where: {
			id: input.scheduleId,
			liveChannelId: input.liveChannelId,
			liveChannelRunId: input.liveChannelRunId,
			action: "STOP",
			status: "FIRED",
			stopDeliveryToken: receipt.stopDeliveryToken,
			stopProviderEncodingId: legacy ? null : input.providerEncodingId,
			stopAdmissionFenceVersion: legacy ? null : input.admissionFence,
			...(legacy
				? { OR: [{ dispatchJobId: null }, { dispatchJobId: expectedJobId }] }
				: { dispatchedAt: { not: null }, dispatchJobId: expectedJobId }),
			AND: [{ OR: outcomes }],
		},
		data: {
			outcome: "DELIVERED",
			outcomeAt: input.at,
			outcomeNote: null,
			outcomeEvidenceKind: "PROVIDER_TERMINAL",
			outcomeEvidenceVersion: CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
			outcomeEvidenceAt: input.at,
		},
	});
}

/** Called inside the transaction that confirms termination of this exact airing. */
export async function recordConfirmedLiveStopNotification(
	tx: AppTransactionClient,
	input: {
		liveChannelId: string;
		liveChannelRunId: string;
		channelName: string;
		notificationEligible: boolean;
		status: "STOPPED" | "ERROR";
		at: Date;
	},
): Promise<void> {
	const { liveChannelId, liveChannelRunId, at } = input;
	const kind = input.status === "ERROR" ? "CHANNEL_ERROR" : "CHANNEL_STOPPED";
	const first = await tx.liveChannelRun.updateMany({
		where: { id: liveChannelRunId, liveChannelId, stopNotificationAt: null },
		data: {
			stopNotificationAt: at,
			stopNotificationKind: kind,
			stopNotificationState: input.notificationEligible
				? "PENDING"
				: "LEGACY_UNKNOWN",
		},
	});
	if (first.count === 1 && input.notificationEligible) {
		await tx.liveStopNotification.create({
			data: {
				id: liveChannelRunId,
				channelId: liveChannelId,
				channelName: input.channelName,
				kind,
				occurredAt: at,
				nextAttemptAt: at,
			},
		});
	}
}

/** Record what the scheduled STOP knew at its own failure boundary, before another observer can win. */
export async function recordStopScheduleFailure(
	tx: AppTransactionClient,
	claimId: string,
	input: {
		liveChannelId: string;
		liveChannelRunId: string;
		state: "AMBIGUOUS" | "FAILED";
		status: "STOPPED" | "ERROR";
		error: string;
		at: Date;
	},
) {
	const claim = await tx.liveEffectClaim.findUnique({
		where: { id: claimId },
		select: { scheduleId: true },
	});
	if (!claim?.scheduleId) return;
	await tx.liveSchedule.updateMany({
		where: {
			id: claim.scheduleId,
			liveChannelId: input.liveChannelId,
			liveChannelRunId: input.liveChannelRunId,
			action: "STOP",
			status: "FIRED",
			...(input.state === "AMBIGUOUS"
				? {
						OR: [
							{ outcome: "PENDING" },
							{ outcome: "FAILED", outcomeEvidenceKind: "EFFECT_FAILED" },
						],
					}
				: { outcome: "PENDING" }),
		},
		data: {
			outcome: input.state === "FAILED" ? "FAILED" : "UNKNOWN",
			outcomeAt: input.at,
			outcomeNote: redactSecrets(input.error),
			outcomeEvidenceVersion: CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
			outcomeEvidenceKind:
				input.state === "FAILED"
					? "EFFECT_FAILED"
					: input.status === "STOPPED"
						? "PROVIDER_STATUS_UNKNOWN"
						: "JOB_TERMINAL_UNKNOWN",
			outcomeEvidenceAt: input.at,
		},
	});
}
