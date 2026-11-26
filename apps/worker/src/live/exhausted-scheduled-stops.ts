import { randomUUID } from "node:crypto";
import {
	classifyProviderStatusWord,
	type LiveChannelJob,
	liveChannelJobSchema,
	scheduledStopJobId,
} from "@bitovp/core";
import {
	beginLiveEffect,
	CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
	competingScheduledStop,
	liveChannelAccountId,
	liveStopFeederWhere,
	liveStopKnownTargets,
	liveStopRunOwnsEncoding,
	type ResolveLiveEffectsAfterConfirmedStopInput,
	readAiringEffectHistory,
	resolveLiveEffectsAfterConfirmedStop,
} from "@bitovp/db";
import { HEARTBEAT_SWEEP_PER_CHANNEL_TIMEOUT_MS } from "../heartbeat-cadence";
import type { LiveChannelDeps } from "../orchestrator/live-processor";

import { recordFinalStopFailure } from "./dead-job-outcome";

type Deps = Pick<
	LiveChannelDeps,
	"prisma" | "makeSdk" | "revealBitmovinAccount" | "now" | "emitEvent"
>;
type ReadJob = (
	id: string,
) => Promise<{ data: unknown; getState(): Promise<string> } | undefined>;

function sameScheduledStop(
	actual: NonNullable<LiveChannelJob["effect"]>,
	expected: NonNullable<LiveChannelJob["effect"]>,
) {
	return (
		actual.action === "STOP" &&
		actual.targetId === undefined &&
		actual.requestSha256 === undefined &&
		actual.idempotencyKey === expected.idempotencyKey &&
		actual.scheduleId === expected.scheduleId &&
		actual.liveChannelRunId === expected.liveChannelRunId
	);
}

/** Recover both pre-journal observation and the original handoff of a fenced scheduled STOP. */
export function createExhaustedScheduledStopRecovery(
	deps: Deps,
	readJob: ReadJob,
	reenqueue?: (job: LiveChannelJob, id: string) => Promise<void>,
) {
	let after: string | undefined;
	return async () => {
		const rows = await deps.prisma.liveSchedule.findMany({
			where: {
				action: "STOP",
				status: "FIRED",
				liveChannelRunId: { not: null },
				firedAt: { not: null },
				liveChannel: {
					status: "STOPPING",
					origin: "MANAGED",
				},
				OR: [
					{
						stopAdmissionFenceVersion: null,
						liveChannel: { legacyAdmissionFenceVersion: { not: null } },
						OR: [
							{ outcome: "UNKNOWN" },
							{ outcome: "PENDING", dispatchedAt: { not: null } },
						],
					},
					{
						stopAdmissionFenceVersion: { not: null },
						OR: [
							{ outcome: "UNKNOWN" },
							{ outcome: "PENDING", dispatchedAt: { not: null } },
						],
					},
				],
				...(after ? { id: { gt: after } } : {}),
			},
			orderBy: { id: "asc" },
			take: 4,
			select: {
				id: true,
				firedAt: true,
				liveChannelRunId: true,
				liveChannelId: true,
				outcome: true,
				dispatchJobId: true,
				stopAdmissionFenceVersion: true,
				stopDeliveryToken: true,
				legacyStopExhaustedFence: true,
				stopProviderEncodingId: true,
				liveChannel: {
					select: {
						bitmovinAccountId: true,
						stepLog: true,
						error: true,
						plan: true,
						bitmovinEncodingId: true,
						liveEffectFenceVersion: true,
						legacyAdmissionFenceVersion: true,
						runs: {
							orderBy: { seq: "desc" },
							take: 1,
							select: {
								id: true,
								previousProviderEncodingIds: true,
								archivedRtmpAttempt: true,
								rtmpRetirementEvidence: true,
								aisaAnalysisId: true,
								status: true,
								bitmovinEncodingId: true,
								stepLog: true,
							},
						},
					},
				},
			},
		});
		after = rows.length === 4 ? rows.at(-1)?.id : undefined;
		for (const row of rows) {
			const channel = row.liveChannel,
				run = channel.runs[0],
				encodingId = channel.bitmovinEncodingId;
			const jobId = scheduledStopJobId(row.id, row.stopDeliveryToken);
			if (
				!run ||
				(run.status !== "STOPPING" &&
					!(
						["RUNNING", "ERROR"].includes(run.status) &&
						channel.legacyAdmissionFenceVersion !== null
					)) ||
				run.id !== row.liveChannelRunId ||
				!encodingId ||
				(row.dispatchJobId && row.dispatchJobId !== jobId) ||
				!liveStopRunOwnsEncoding(run, encodingId)
			)
				continue;
			try {
				const originalFence =
					row.stopAdmissionFenceVersion ?? channel.legacyAdmissionFenceVersion;
				if (
					originalFence === null ||
					(row.stopProviderEncodingId &&
						row.stopProviderEncodingId !== encodingId)
				)
					continue;
				const effect = {
					action: "STOP" as const,
					idempotencyKey: `schedule:${row.id}:stop`,
					scheduleId: row.id,
					liveChannelRunId: run.id,
					providerEncodingId: encodingId,
					admissionFenceVersion: originalFence,
					...(row.stopDeliveryToken && {
						stopDeliveryToken: row.stopDeliveryToken,
					}),
				};
				const original: LiveChannelJob = {
					liveChannelId: row.liveChannelId,
					action: "stop",
					plannedLiveChannelRunId: run.id,
					effect,
				};
				const job = await readJob(jobId);
				const retained = job ? liveChannelJobSchema.safeParse(job.data) : null;
				const found = retained?.success ? retained.data : undefined;
				const legacy = originalFence === channel.legacyAdmissionFenceVersion;
				if (
					job &&
					(found?.effect?.stopDeliveryToken ?? null) !== row.stopDeliveryToken
				)
					continue;
				// The deterministic job must belong to this exact schedule and airing.
				// BullMQ deduplicates on this key even when the same schedule is admitted again.
				if (
					job &&
					(found?.action !== "stop" ||
						found.params !== undefined ||
						found.attemptId !== undefined ||
						found.liveChannelRunId !== undefined ||
						found.encodingId !== undefined ||
						found.provisionFenceVersion !== undefined ||
						found.liveChannelId !== row.liveChannelId ||
						(found.plannedLiveChannelRunId &&
							found.plannedLiveChannelRunId !== run.id) ||
						(found.effect ? !sameScheduledStop(found.effect, effect) : !legacy))
				)
					continue;
				const legacyRow =
					row.stopProviderEncodingId === null &&
					row.stopAdmissionFenceVersion === null;
				const advancedFence = originalFence !== channel.liveEffectFenceVersion;
				const failedClaim =
					legacy && !advancedFence
						? await deps.prisma.liveEffectClaim.findFirst({
								where: {
									idempotencyKey: effect.idempotencyKey,
									scheduleId: row.id,
									liveChannelId: row.liveChannelId,
									liveChannelRunId: run.id,
									action: "STOP",
									state: "FAILED",
									generation: { lte: originalFence },
								},
								select: {
									id: true,
									token: true,
									providerEncodingId: true,
									generation: true,
									attempt: true,
								},
							})
						: null;
				const priorFailedClaim =
					failedClaim && failedClaim.generation < originalFence;
				const currentFailedClaim =
					failedClaim?.generation === originalFence &&
					failedClaim.providerEncodingId === encodingId;
				// Claiming a delivery advances its channel fence. The matching current
				// failed claim can still authorize a retry of its original queued payload.
				// A refire can also retain a genuinely older payload under the same key.
				const olderEnvelope =
					legacy &&
					!advancedFence &&
					found?.effect &&
					found.effect.admissionFenceVersion < originalFence;
				const staleReceipt =
					!!olderEnvelope &&
					!(
						currentFailedClaim &&
						found?.effect?.providerEncodingId === encodingId &&
						found.effect.admissionFenceVersion ===
							failedClaim.generation - failedClaim.attempt
					);
				if (
					found?.effect &&
					!olderEnvelope &&
					(found.effect.admissionFenceVersion !== originalFence ||
						found.effect.providerEncodingId !== encodingId)
				)
					continue;
				const resetQueueObservation = async () => {
					if (row.legacyStopExhaustedFence === originalFence) {
						await deps.prisma.liveSchedule.updateMany({
							where: {
								id: row.id,
								liveChannelId: row.liveChannelId,
								liveChannelRunId: run.id,
								legacyStopExhaustedFence: originalFence,
								stopDeliveryToken: row.stopDeliveryToken,
							},
							data: { legacyStopExhaustedFence: null },
						});
					}
				};
				const jobState = job && (await job.getState());
				if (
					job &&
					!staleReceipt &&
					!priorFailedClaim &&
					jobState !== "failed" &&
					!(row.outcome === "UNKNOWN" && jobState === "completed")
				) {
					await resetQueueObservation();
					continue;
				}
				const savedHandoff =
					row.stopProviderEncodingId === encodingId &&
					row.stopAdmissionFenceVersion === originalFence;
				const mayReplay =
					!failedClaim && savedHandoff && !job && row.outcome === "PENDING";
				const deferToAnotherHandoff = async () => {
					// A lost or terminal job has no runnable handoff. Keep its schedule available
					// for fallback if every other handoff also proves exhausted.
					const wrongAdmission =
						(staleReceipt || priorFailedClaim) && row.outcome === "PENDING";
					if (
						row.legacyStopExhaustedFence !== originalFence ||
						wrongAdmission
					) {
						const at = new Date(deps.now());
						await deps.prisma.liveSchedule.updateMany({
							where: {
								id: row.id,
								liveChannelId: row.liveChannelId,
								liveChannelRunId: run.id,
								action: "STOP",
								status: "FIRED",
								stopProviderEncodingId: row.stopProviderEncodingId,
								stopAdmissionFenceVersion: row.stopAdmissionFenceVersion,
								stopDeliveryToken: row.stopDeliveryToken,
								outcome: row.outcome,
								...(row.outcome === "PENDING" && {
									dispatchedAt: { not: null },
								}),
								liveChannel: {
									status: "STOPPING",
									bitmovinEncodingId: encodingId,
									legacyAdmissionFenceVersion: originalFence,
									liveEffectFenceVersion: originalFence,
									effectClaims: {
										none: {
											idempotencyKey: effect.idempotencyKey,
											NOT: {
												action: "STOP",
												state: "FAILED",
												generation: { lte: originalFence },
											},
										},
									},
								},
							},
							data: {
								legacyStopExhaustedFence: originalFence,
								...(wrongAdmission && {
									outcome: "UNKNOWN",
									outcomeAt: at,
									outcomeNote:
										"The retained STOP belongs to an earlier admission. Delivery of this schedule was not confirmed.",
									outcomeEvidenceVersion:
										CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
									outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
									outcomeEvidenceAt: at,
								}),
							},
						});
					}
					return deps.prisma.liveSchedule.findFirst({
						where: {
							liveChannelId: row.liveChannelId,
							...competingScheduledStop(row.id, run.id, originalFence),
						},
						select: { id: true },
					});
				};
				if (
					legacy &&
					!advancedFence &&
					(legacyRow || savedHandoff) &&
					!mayReplay &&
					(await deferToAnotherHandoff())
				)
					continue;
				// Give other freshly sampled schedules their turn first. A stale job
				// cannot be replayed for the current admission, even if Redis says waiting.
				if (staleReceipt && row.legacyStopExhaustedFence !== originalFence)
					continue;
				let terminalReadback: ResolveLiveEffectsAfterConfirmedStopInput["terminalReadback"];
				let failedFencedDelivery = false;
				if (
					legacy &&
					!advancedFence &&
					!priorFailedClaim &&
					(!job || found?.effect || currentFailedClaim)
				) {
					const accountId = liveChannelAccountId(channel);
					const history = await readAiringEffectHistory(
						deps.prisma,
						row.liveChannelId,
						run.id,
					);
					const targets = liveStopKnownTargets(
						run,
						channel,
						history,
						accountId,
					);
					if (targets?.length && accountId) {
						try {
							const sdk = deps.makeSdk({
								...(await deps.revealBitmovinAccount(accountId)),
								bitmovinAccountId: accountId,
								monitoringSignal: AbortSignal.timeout(
									HEARTBEAT_SWEEP_PER_CHANNEL_TIMEOUT_MS,
								),
							});
							const encodings = await Promise.all(
								targets.map(async (id) => ({
									id,
									status: (await sdk.getEncodingStatus(id)).status,
								})),
							);
							const primary = encodings.find(({ id }) => id === encodingId);
							if (
								primary &&
								encodings.every(
									({ status }) =>
										classifyProviderStatusWord(status) === "TERMINAL",
								) &&
								!(await deps.prisma.feederSession.findFirst({
									where: liveStopFeederWhere(row.liveChannelId),
									select: { id: true },
								}))
							)
								terminalReadback = {
									generation: originalFence,
									bitmovinAccountId: accountId,
									providerStatus: primary.status,
									encodings,
								};
						} catch {
							// A lost status read is not proof that the original handoff was sent.
						}
					}
					// A stamped lost job can be replayed while the encoder or its feeder is
					// active. When both have finished, only terminal observation remains.
					if (mayReplay && terminalReadback && (await deferToAnotherHandoff()))
						continue;
					if (!terminalReadback && !currentFailedClaim) {
						if (!staleReceipt && (found?.effect || savedHandoff))
							failedFencedDelivery = true;
						else if (
							(!job || staleReceipt) &&
							!(await deps.prisma.liveEffectClaim.findFirst({
								where: {
									liveChannelId: row.liveChannelId,
									liveChannelRunId: run.id,
									action: "STOP",
									generation: originalFence,
									state: { in: ["CLAIMED", "DISPATCHING", "AMBIGUOUS"] },
								},
								select: { id: true },
							}))
						) {
							// A pre-upgrade evicted job has no durable send ledger. Give the
							// operator an actionable exact airing without replaying its POST.
							await recordFinalStopFailure(
								deps.prisma,
								{
									id: jobId,
									data: original,
									finishedOn: new Date(deps.now()).getTime(),
								},
								"The pre-upgrade STOP no longer has a verifiable queue receipt.",
								deps.emitEvent,
								true,
							);
							continue;
						} else continue;
					}
				}
				if (currentFailedClaim && failedClaim && terminalReadback) {
					const resolved = await resolveLiveEffectsAfterConfirmedStop(
						deps.prisma,
						{
							liveChannelId: row.liveChannelId,
							liveChannelRunId: run.id,
							providerEncodingId: encodingId,
							stopClaimId: failedClaim.id,
							stopIdempotencyKey: effect.idempotencyKey,
							at: new Date(deps.now()),
							terminalReadback: {
								...terminalReadback,
								exhaustedFailedSchedule: {
									id: row.id,
									claimToken: failedClaim.token,
									...(row.stopDeliveryToken && {
										stopDeliveryToken: row.stopDeliveryToken,
									}),
								},
							},
						},
					);
					if (resolved.kind !== "BLOCKED") continue;
				}
				if (priorFailedClaim || currentFailedClaim) {
					await recordFinalStopFailure(
						deps.prisma,
						{
							id: jobId,
							data: original,
							finishedOn: new Date(deps.now()).getTime(),
						},
						priorFailedClaim
							? "The scheduled STOP claim belongs to a failed earlier admission."
							: "The current STOP claim failed before its provider send.",
						deps.emitEvent,
						true,
					);
					continue;
				}
				if (!legacy || advancedFence || failedFencedDelivery) {
					if (
						!legacy &&
						((row.dispatchJobId !== jobId && row.outcome !== "UNKNOWN") ||
							row.stopProviderEncodingId !== encodingId)
					)
						continue;
					if (
						reenqueue &&
						!job &&
						row.outcome === "PENDING" &&
						originalFence === channel.liveEffectFenceVersion
					) {
						// A delayed failure callback may still contain the evicted
						// job's payload. Replace its authority before publishing a
						// new Redis job, under the same lock as effect acquisition.
						const stopDeliveryToken = randomUUID();
						const replacementJobId = scheduledStopJobId(
							row.id,
							stopDeliveryToken,
						);
						const replaced = await deps.prisma.$transaction(async (tx) => {
							const [held] = await tx.$queryRaw<{ id: string }[]>`
								SELECT id FROM "LiveChannel"
								WHERE id = ${row.liveChannelId}::uuid AND status = 'STOPPING'
									AND "liveEffectFenceVersion" = ${originalFence}
									AND "bitmovinEncodingId" = ${encodingId}
								FOR UPDATE`;
							if (!held) return false;
							const [latest, claim] = await Promise.all([
								tx.liveChannelRun.findFirst({
									where: { liveChannelId: row.liveChannelId },
									orderBy: { seq: "desc" },
									select: { id: true, bitmovinEncodingId: true, stepLog: true },
								}),
								tx.liveEffectClaim.findUnique({
									where: { idempotencyKey: effect.idempotencyKey },
									select: { id: true },
								}),
							]);
							if (
								claim ||
								!latest ||
								latest.id !== run.id ||
								!liveStopRunOwnsEncoding(latest, encodingId)
							)
								return false;
							const marked = await tx.liveSchedule.updateMany({
								where: {
									id: row.id,
									liveChannelId: row.liveChannelId,
									liveChannelRunId: run.id,
									action: "STOP",
									status: "FIRED",
									outcome: "PENDING",
									dispatchedAt: { not: null },
									dispatchJobId: row.dispatchJobId,
									stopAdmissionFenceVersion: originalFence,
									stopProviderEncodingId: encodingId,
									stopDeliveryToken: row.stopDeliveryToken,
								},
								data: {
									stopDeliveryToken,
									dispatchJobId: replacementJobId,
									legacyStopExhaustedFence: null,
								},
							});
							return marked.count === 1;
						});
						if (replaced) {
							await reenqueue(
								{ ...original, effect: { ...effect, stopDeliveryToken } },
								replacementJobId,
							);
							continue;
						}
					}
					// A pre-send FAILED claim holds a newer generation than its enqueue.
					// The transaction rechecks that claim, its exact target and the channel fence.
					// UNKNOWN may already be durable even if the final channel projection failed.
					if (
						!job &&
						originalFence === channel.liveEffectFenceVersion &&
						!failedFencedDelivery &&
						row.outcome !== "UNKNOWN"
					)
						continue;
					if (job && jobState !== "failed") continue;
					await recordFinalStopFailure(
						deps.prisma,
						{
							id: jobId,
							data: original,
							finishedOn: new Date(deps.now()).getTime(),
						},
						job
							? "The original scheduled job is in the failed queue."
							: "The scheduled STOP job was evicted before its provider send was confirmed.",
						deps.emitEvent,
						legacy && !advancedFence,
					);
					continue;
				}
				if (
					channel.legacyAdmissionFenceVersion !== channel.liveEffectFenceVersion
				)
					continue;
				const at = new Date(deps.now());
				await beginLiveEffect(deps.prisma, {
					idempotencyKey: `schedule:${row.id}:stop`,
					scheduleId: row.id,
					liveChannelId: row.liveChannelId,
					liveChannelRunId: run.id,
					providerEncodingId: encodingId,
					expectedFenceVersion: channel.liveEffectFenceVersion,
					...(row.stopDeliveryToken && {
						stopDeliveryToken: row.stopDeliveryToken,
					}),
					action: "STOP",
					allowedChannelStatuses: ["STOPPING"],
					legacyStopDelivery: "EXHAUSTED",
					ownerId: "legacy-stop-observer",
					now: at,
					expiresAt: at,
				});
			} catch {
				console.warn(`[live] Scheduled STOP recovery deferred for ${row.id}`);
			}
		}
	};
}
