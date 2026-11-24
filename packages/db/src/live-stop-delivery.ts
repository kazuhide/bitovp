import { redactSecrets } from "@bitovp/core";
import type { AppTransactionClient } from "./client";

export const CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION = 1;

/** Called inside the transaction that ACKs the proven STOP(s) for this exact airing. */
export async function recordConfirmedStopDelivery(
	tx: AppTransactionClient,
	input: {
		liveChannelId: string;
		liveChannelRunId: string;
		scheduleIds: readonly string[];
		status: "STOPPED" | "ERROR";
		at: Date;
	},
): Promise<void> {
	const { liveChannelId, liveChannelRunId, scheduleIds, at } = input;
	if (scheduleIds.length) {
		await tx.liveSchedule.updateMany({
			where: {
				id: { in: [...scheduleIds] },
				liveChannelId,
				liveChannelRunId,
				action: "STOP",
				status: "FIRED",
				outcome: "PENDING",
			},
			data: {
				outcome: "DELIVERED",
				outcomeAt: at,
				outcomeNote: null,
				outcomeEvidenceKind: "PROVIDER_TERMINAL",
				outcomeEvidenceVersion: CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
				outcomeEvidenceAt: at,
			},
		});
	}
	await tx.liveChannelRun.updateMany({
		where: { id: liveChannelRunId, liveChannelId, stopNotificationAt: null },
		data: {
			stopNotificationAt: at,
			stopNotificationKind:
				input.status === "ERROR" ? "CHANNEL_ERROR" : "CHANNEL_STOPPED",
		},
	});
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
			outcome: "PENDING",
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
