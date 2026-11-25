import {
	classifyProviderStatusWord,
	type LiveChannelJob,
	liveChannelJobSchema,
} from "@bitovp/core";
import {
	beginLiveEffect,
	liveChannelAccountId,
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
		actual.liveChannelRunId === expected.liveChannelRunId &&
		actual.providerEncodingId === expected.providerEncodingId &&
		actual.admissionFenceVersion === expected.admissionFenceVersion
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
						outcome: { in: ["PENDING", "UNKNOWN"] },
						dispatchedAt: { not: null },
					},
				],
				...(after ? { id: { gt: after } } : {}),
			},
			orderBy: { id: "asc" },
			take: 4,
			select: {
				id: true,
				liveChannelRunId: true,
				liveChannelId: true,
				outcome: true,
				dispatchJobId: true,
				stopAdmissionFenceVersion: true,
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
				// Both the base release and the upgraded redispatch emit fenced STOPs.
				// Still older bare jobs may only observe their own migrated airing.
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
						(found.effect
							? !sameScheduledStop(found.effect, effect)
							: !legacy) ||
						(row.outcome === "PENDING" && (await job.getState()) !== "failed"))
				)
					continue;
				const advancedFence = originalFence !== channel.liveEffectFenceVersion;
				let failedFencedDelivery = false;
				if (legacy && !advancedFence && (!job || found?.effect)) {
					if (row.dispatchJobId !== jobId && !found?.effect) continue;
					const savedHandoff =
						row.stopProviderEncodingId === encodingId &&
						row.stopAdmissionFenceVersion === originalFence;
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
							terminal = states.every((state) => state === "TERMINAL");
						} catch {
							// A lost status read is not proof that the original handoff was sent.
						}
					}
					if (!terminal) {
						if (found?.effect || savedHandoff) failedFencedDelivery = true;
						else if (
							!job &&
							!history.some((claim) => claim.action === "STOP")
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
							);
							continue;
						} else continue;
					}
				}
				if (!legacy || advancedFence || failedFencedDelivery) {
					if (
						!legacy &&
						(row.dispatchJobId !== jobId ||
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
							await reenqueue?.(original, jobId);
							continue;
						}
					}
					// A pre-send FAILED claim holds a newer generation than its enqueue.
					// The transaction rechecks that claim, its exact target and the channel fence.
					// With an evicted job only durable FAILED can authorize that projection.
					if (
						!job &&
						originalFence === channel.liveEffectFenceVersion &&
						!failedFencedDelivery
					)
						continue;
					if (job && (await job.getState()) !== "failed") continue;
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
