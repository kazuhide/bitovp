import { randomUUID } from "node:crypto";
import { classifyProviderStatusWord, feederOccupancyWhere } from "@bitovp/core";
import type { AppPrismaClient } from "./client";

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
};

export type LiveEffectClaimHandle = {
	id: string;
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
};

export type ResolveLiveEffectsAfterConfirmedStopResult =
	| { kind: "RESOLVED"; count: number }
	| { kind: "BLOCKED"; reason: string };

function handleOf(row: {
	id: string;
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
		const retryingFailed = existing?.state === "FAILED" ? existing : null;
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
						failure:
							"effect owner expired after DISPATCHING; exact readback is required before retry",
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
					liveEffectFenceVersion: true,
					bitmovinEncodingId: true,
				},
			}),
			tx.liveChannelRun.findFirst({
				where: { liveChannelId: input.liveChannelId },
				orderBy: { seq: "desc" },
				select: { id: true, bitmovinEncodingId: true },
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
			(currentRun.bitmovinEncodingId ?? channel.bitmovinEncodingId) !==
				input.providerEncodingId
		) {
			return {
				kind: "STALE",
				reason:
					"the planned live run or provider encoding is no longer current",
			};
		}
		// A queue-first manual STOP is the cost-safety override. Its run/provider
		// identity is the
		// immutable admission boundary; an unrelated same-run effect advancing the
		// generation after HTTP admission must be superseded, not turn the stop into
		// a normally-completed no-op. FAILED stop retries adopt the same current
		// generation for the same reason.
		const claimedFromGeneration = durableManualStop
			? channel.liveEffectFenceVersion
			: retryingFailed
				? retryingFailed.generation
				: input.expectedFenceVersion;
		if (channel.liveEffectFenceVersion !== claimedFromGeneration) {
			return {
				kind: "STALE",
				reason: "the live effect generation changed after admission",
			};
		}
		if (open && !input.supersedeOpen) {
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
			},
			data: {
				liveEffectFenceVersion: { increment: 1 },
				// This is the same transaction that supersedes the open RESTART and
				// persists STOP as DISPATCHING. No restart loser can therefore retain
				// PROVISIONING after the STOP owns its new generation.
				...(durableManualStop ? { status: "STOPPING" as const } : {}),
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

		if (open && input.supersedeOpen) {
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
					where: { id: retryingFailed.id },
					data: {
						generation,
						state: "CLAIMED",
						token,
						ownerId: input.ownerId,
						expiresAt: input.expiresAt,
						dispatchedAt: null,
						acknowledgedAt: null,
						failure: null,
						attempt: { increment: 1 },
					},
				})
			: await tx.liveEffectClaim.create({
					data: {
						liveChannelId: input.liveChannelId,
						liveChannelRunId: input.liveChannelRunId,
						...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
						action: input.action,
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
		await hooks.afterClaimed?.();
		const intent = await tx.liveEffectClaim.updateMany({
			where: { id: created.id, token, state: "CLAIMED" },
			data: { state: "DISPATCHING", dispatchedAt: input.now },
		});
		if (intent.count !== 1) {
			throw new Error("LIVE_EFFECT_INTENT_NOT_DURABLE");
		}
		return { kind: "EXECUTE", claim: handleOf({ ...created, generation }) };
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
			const [channel, run, feeder, stopClaim] = await Promise.all([
				tx.liveChannel.findUnique({
					where: { id: input.liveChannelId },
					select: {
						status: true,
						error: true,
						liveEffectFenceVersion: true,
						bitmovinEncodingId: true,
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
					},
				}),
				tx.feederSession.findFirst({
					where: {
						...feederOccupancyWhere(input.liveChannelId),
						liveChannelRunId: input.liveChannelRunId,
					},
					select: { id: true },
				}),
				tx.liveEffectClaim.findUnique({
					where: { id: input.stopClaimId },
					select: {
						idempotencyKey: true,
						liveChannelId: true,
						liveChannelRunId: true,
						providerEncodingId: true,
						action: true,
						generation: true,
						state: true,
					},
				}),
			]);
			if (
				channel?.status !== "STOPPED" ||
				channel.error !== null ||
				channel.bitmovinEncodingId !== input.providerEncodingId
			) {
				return {
					kind: "BLOCKED",
					reason: "the exact channel STOP is not confirmed clean",
				};
			}
			if (
				run?.id !== input.liveChannelRunId ||
				run.status !== "STOPPED" ||
				run.error !== null ||
				run.bitmovinEncodingId !== input.providerEncodingId ||
				!run.providerStatusObservedAt ||
				!run.providerTerminalAt ||
				classifyProviderStatusWord(run.providerStatus) !== "TERMINAL"
			) {
				return {
					kind: "BLOCKED",
					reason:
						"the exact provider encoding has no authoritative terminal readback",
				};
			}
			if (
				!stopClaim ||
				stopClaim.idempotencyKey !== input.stopIdempotencyKey ||
				stopClaim.liveChannelId !== input.liveChannelId ||
				stopClaim.liveChannelRunId !== input.liveChannelRunId ||
				stopClaim.providerEncodingId !== input.providerEncodingId ||
				stopClaim.action !== "STOP" ||
				stopClaim.generation !== channel.liveEffectFenceVersion ||
				(stopClaim.state !== "DISPATCHING" && stopClaim.state !== "AMBIGUOUS")
			) {
				return {
					kind: "BLOCKED",
					reason: "the exact STOP claim is not the current unresolved effect",
				};
			}
			const stopGeneration = stopClaim.generation;
			if (feeder) {
				return {
					kind: "BLOCKED",
					reason: "a feeder still occupies the ended live run",
				};
			}
			// Advance the same CAS that beginLiveEffect uses. A stale admission that
			// read the pre-reconciliation fence must lose even if it resumes only after
			// this transaction commits; a no-op row lock would not invalidate it.
			const locked = await tx.liveChannel.updateMany({
				where: {
					id: input.liveChannelId,
					status: "STOPPED",
					error: null,
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
							state: { in: ["DISPATCHING", "AMBIGUOUS"] },
						},
					},
				},
				data: { liveEffectFenceVersion: { increment: 1 } },
			});
			if (locked.count !== 1) {
				return {
					kind: "BLOCKED",
					reason: "the exact channel STOP changed during reconciliation",
				};
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
					state: { in: ["DISPATCHING", "AMBIGUOUS"] },
					// Keep the ownership predicate on the ACK itself as a second fence. The
					// channel row is already write-locked above against re-air admission.
					liveChannel: {
						is: {
							status: "STOPPED",
							error: null,
							bitmovinEncodingId: input.providerEncodingId,
							liveEffectFenceVersion: stopGeneration + 1,
						},
					},
				},
				data: {
					state: "ACKED",
					acknowledgedAt: input.at,
					failure: null,
				},
			});
			if (acknowledged.count !== 1) {
				// Throw so the transaction rolls back the fence increment. Redelivery
				// re-runs authoritative readback and never sends a second provider STOP.
				throw new Error("LIVE_STOP_RECONCILIATION_ACK_FENCE_LOST");
			}
			const { count } = await tx.liveEffectClaim.updateMany({
				where: {
					id: { not: input.stopClaimId },
					liveChannelId: input.liveChannelId,
					liveChannelRunId: input.liveChannelRunId,
					providerEncodingId: input.providerEncodingId,
					state: { in: [...LIVE_EFFECT_OPEN_STATES] },
				},
				data: {
					state: "RESOLVED",
					acknowledgedAt: input.at,
					failure:
						"resolved by authoritative provider-terminal and feeder-stop readback",
				},
			});
			return { kind: "RESOLVED", count };
		},
		{ isolationLevel: "Serializable" },
	);
}

export async function resolveLiveEffectsAfterConfirmedStop(
	prisma: AppPrismaClient,
	input: ResolveLiveEffectsAfterConfirmedStopInput,
): Promise<ResolveLiveEffectsAfterConfirmedStopResult> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await resolveLiveEffectsAfterConfirmedStopOnce(prisma, input);
		} catch (error) {
			if (!isPrismaSerializationConflict(error) || attempt >= 2) throw error;
		}
	}
}

/** Re-check the exact token/run/encoding/generation immediately pre-send. */
export async function assertLiveEffectCurrent(
	prisma: AppPrismaClient,
	claim: LiveEffectClaimHandle,
	now: Date,
): Promise<boolean> {
	const [held, channel, currentRun] = await Promise.all([
		prisma.liveEffectClaim.findUnique({
			where: { idempotencyKey: claim.idempotencyKey },
			select: { id: true, token: true, state: true, expiresAt: true },
		}),
		prisma.liveChannel.findUnique({
			where: { id: claim.liveChannelId },
			select: {
				liveEffectFenceVersion: true,
				bitmovinEncodingId: true,
			},
		}),
		prisma.liveChannelRun.findFirst({
			where: { liveChannelId: claim.liveChannelId },
			orderBy: { seq: "desc" },
			select: { id: true, bitmovinEncodingId: true },
		}),
	]);
	return (
		held?.id === claim.id &&
		held.token === claim.token &&
		held.state === "DISPATCHING" &&
		held.expiresAt.getTime() > now.getTime() &&
		channel?.liveEffectFenceVersion === claim.generation &&
		currentRun?.id === claim.liveChannelRunId &&
		(currentRun.bitmovinEncodingId ?? channel?.bitmovinEncodingId) ===
			claim.providerEncodingId
	);
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

export async function markLiveEffectAmbiguous(
	prisma: AppPrismaClient,
	claim: LiveEffectClaimHandle,
	reason: string,
): Promise<boolean> {
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
