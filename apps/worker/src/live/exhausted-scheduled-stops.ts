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
				// A stranded pre-upgrade STOP can acquire a fenced payload on
				// redispatch. Its migration generation still identifies the
				// original unjournaled airing, so recovery remains read-only.
				if (
					row.stopAdmissionFenceVersion !== null &&
					row.stopAdmissionFenceVersion !== channel.legacyAdmissionFenceVersion
				) {
					if (
						row.dispatchJobId !== jobId ||
						row.stopProviderEncodingId !== encodingId ||
						row.stopAdmissionFenceVersion !== channel.liveEffectFenceVersion
					)
						continue;
					const effect = {
						action: "STOP" as const,
						idempotencyKey: `schedule:${row.id}:stop`,
						scheduleId: row.id,
						liveChannelRunId: run.id,
						providerEncodingId: encodingId,
						admissionFenceVersion: row.stopAdmissionFenceVersion,
					};
					const job = await readJob(jobId);
					if (!job) {
						// A purged queue record says nothing about external delivery.
						// Current workers journal before every send. Only an untouched
						// admission may be queued again, under its original fence/key.
						const claim = await deps.prisma.liveEffectClaim.findUnique({
							where: { idempotencyKey: effect.idempotencyKey },
							select: { id: true },
						});
						if (!claim && row.outcome === "PENDING")
							await reenqueue?.(
								{
									liveChannelId: row.liveChannelId,
									action: "stop",
									plannedLiveChannelRunId: run.id,
									effect,
								},
								jobId,
							);
						continue;
					}
					const parsed = liveChannelJobSchema.safeParse(job.data);
					const found = parsed.success ? parsed.data : null;
					if (
						found?.action !== "stop" ||
						found.liveChannelId !== row.liveChannelId ||
						(found.plannedLiveChannelRunId &&
							found.plannedLiveChannelRunId !== run.id) ||
						found.effect?.action !== "STOP" ||
						found.effect.idempotencyKey !== effect.idempotencyKey ||
						found.effect.scheduleId !== row.id ||
						found.effect.liveChannelRunId !== run.id ||
						found.effect.providerEncodingId !== encodingId ||
						found.effect.admissionFenceVersion !==
							effect.admissionFenceVersion ||
						(await job.getState()) !== "failed"
					)
						continue;
					await recordFinalStopFailure(
						deps.prisma,
						{
							id: jobId,
							data: found,
							finishedOn: new Date(deps.now()).getTime(),
						},
						"The original scheduled job is in the failed queue.",
						deps.emitEvent,
					);
					continue;
				}
				if (
					channel.legacyAdmissionFenceVersion !== channel.liveEffectFenceVersion
				)
					continue;
				if (row.outcome === "PENDING") {
					const job = await readJob(jobId);
					if (job) {
						const parsed = liveChannelJobSchema.safeParse(job.data);
						if (
							!parsed.success ||
							parsed.data.action !== "stop" ||
							parsed.data.liveChannelId !== row.liveChannelId ||
							(parsed.data.plannedLiveChannelRunId &&
								parsed.data.plannedLiveChannelRunId !== run.id) ||
							parsed.data.effect ||
							(await job.getState()) !== "failed"
						)
							continue;
					} else {
						// A purged job is not proof of exhaustion. Only its own observed
						// terminal encoder permits read-only reconciliation of that pending receipt.
						const bitmovinAccountId = liveChannelAccountId(channel);
						if (row.dispatchJobId !== jobId || !bitmovinAccountId) continue;
						const sdk = deps.makeSdk({
							...(await deps.revealBitmovinAccount(bitmovinAccountId)),
							bitmovinAccountId,
							monitoringSignal: AbortSignal.timeout(
								HEARTBEAT_SWEEP_PER_CHANNEL_TIMEOUT_MS,
							),
						});
						if (
							classifyProviderStatusWord(
								(await sdk.getEncodingStatus(encodingId)).status,
							) !== "TERMINAL"
						)
							continue;
					}
				}
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
