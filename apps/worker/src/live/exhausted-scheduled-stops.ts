import {
	classifyProviderStatusWord,
	type LiveChannelJob,
	liveChannelJobSchema,
} from "@bitovp/core";
import {
	beginLiveEffect,
	CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
	competingScheduledStop,
	liveChannelAccountId,
	liveStopFeederWhere,
	liveStopKnownTargets,
	liveStopRunOwnsEncoding,
	readAiringEffectHistory,
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
			const jobId = `sched-${row.id}`;
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
				// A retained old payload identifies the Redis job, not the latest database
				// admission. A base-release retry could re-fire the same schedule and a
				// rebuilt outbox can likewise find its deterministic key already occupied.
				const staleReceipt = Boolean(
					legacy &&
						originalFence === channel.liveEffectFenceVersion &&
						found?.effect &&
						found.effect.admissionFenceVersion < originalFence,
				);
				if (
					found?.effect &&
					!staleReceipt &&
					(found.effect.admissionFenceVersion !== originalFence ||
						found.effect.providerEncodingId !== encodingId)
				)
					continue;
				const advancedFence = originalFence !== channel.liveEffectFenceVersion;
				// A refired row also reuses the claim key. A pre-send failure from a
				// different admission cannot run or be replayed for this one.
				const priorFailedClaim =
					legacy &&
					!advancedFence &&
					(await deps.prisma.liveEffectClaim.findFirst({
						where: {
							idempotencyKey: effect.idempotencyKey,
							scheduleId: row.id,
							liveChannelId: row.liveChannelId,
							liveChannelRunId: run.id,
							action: "STOP",
							state: "FAILED",
							generation: { lt: originalFence },
						},
						select: { id: true },
					}));
				const resetQueueObservation = async () => {
					if (row.legacyStopExhaustedFence === originalFence) {
						await deps.prisma.liveSchedule.updateMany({
							where: {
								id: row.id,
								liveChannelId: row.liveChannelId,
								liveChannelRunId: run.id,
								legacyStopExhaustedFence: originalFence,
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
					!priorFailedClaim &&
					savedHandoff &&
					!job &&
					row.outcome === "PENDING";
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
												generation: { lt: originalFence },
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
				if (priorFailedClaim) {
					await recordFinalStopFailure(
						deps.prisma,
						{
							id: jobId,
							data: original,
							finishedOn: new Date(deps.now()).getTime(),
						},
						"The scheduled STOP claim belongs to a failed earlier admission.",
						deps.emitEvent,
						true,
					);
					continue;
				}
				let failedFencedDelivery = false;
				if (legacy && !advancedFence && (!job || found?.effect)) {
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
					let terminal = false;
					if (targets?.length && accountId) {
						try {
							const sdk = deps.makeSdk({
								...(await deps.revealBitmovinAccount(accountId)),
								bitmovinAccountId: accountId,
								monitoringSignal: AbortSignal.timeout(
									HEARTBEAT_SWEEP_PER_CHANNEL_TIMEOUT_MS,
								),
							});
							const states = await Promise.all(
								targets.map(async (id) =>
									classifyProviderStatusWord(
										(await sdk.getEncodingStatus(id)).status,
									),
								),
							);
							terminal =
								states.every((state) => state === "TERMINAL") &&
								!(await deps.prisma.feederSession.findFirst({
									where: liveStopFeederWhere(row.liveChannelId),
									select: { id: true },
								}));
						} catch {
							// A lost status read is not proof that the original handoff was sent.
						}
					}
					// A stamped lost job can be replayed while the encoder or its feeder is
					// active. When both have finished, only terminal observation remains.
					if (mayReplay && terminal && (await deferToAnotherHandoff()))
						continue;
					if (!terminal) {
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
				if (!legacy || advancedFence || failedFencedDelivery) {
					if (
						!legacy &&
						((row.dispatchJobId !== jobId && row.outcome !== "UNKNOWN") ||
							row.stopProviderEncodingId !== encodingId)
					)
						continue;
					if (
						!job &&
						row.outcome === "PENDING" &&
						originalFence === channel.liveEffectFenceVersion
					) {
						const claim = await deps.prisma.liveEffectClaim.findUnique({
							where: { idempotencyKey: effect.idempotencyKey },
							select: { id: true },
						});
						if (!claim) {
							await resetQueueObservation();
							await reenqueue?.(original, jobId);
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
