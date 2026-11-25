import {
	classifyProviderStatusWord,
	type LiveChannelJob,
	liveChannelJobSchema,
} from "@bitovp/core";
import {
	beginLiveEffect,
	liveChannelAccountId,
	liveStopRunOwnsEncoding,
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
						plan: true,
						bitmovinEncodingId: true,
						liveEffectFenceVersion: true,
						legacyAdmissionFenceVersion: true,
						runs: {
							orderBy: { seq: "desc" },
							take: 1,
							select: {
								id: true,
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
				run?.status !== "STOPPING" ||
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
				if (
					legacy &&
					!advancedFence &&
					row.outcome === "PENDING" &&
					(!job || found?.effect)
				) {
					const bitmovinAccountId = liveChannelAccountId(channel);
					if (row.dispatchJobId !== jobId || !bitmovinAccountId) continue;
					const sdk = deps.makeSdk({
						...(await deps.revealBitmovinAccount(bitmovinAccountId)),
						bitmovinAccountId,
						monitoringSignal: AbortSignal.timeout(
							HEARTBEAT_SWEEP_PER_CHANNEL_TIMEOUT_MS,
						),
					});
					const state = classifyProviderStatusWord(
						(await sdk.getEncodingStatus(encodingId)).status,
					);
					if (state !== "TERMINAL") {
						// Fenced deliveries reserve their send in the database. A still-running
						// target with a failed job can expose manual retry after that claim is checked.
						// An evicted job or a transitional provider read proves neither fact.
						if (!found?.effect || state !== "RUNNING") continue;
						failedFencedDelivery = true;
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
					if (!job && originalFence === channel.liveEffectFenceVersion)
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
							: "The original delivery is missing after its pre-send claim failed.",
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
