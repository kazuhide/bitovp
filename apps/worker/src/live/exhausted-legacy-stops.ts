import { classifyProviderStatusWord, liveChannelJobSchema } from "@bitovp/core";
import {
	beginLiveEffect,
	liveChannelAccountId,
	liveStopRunOwnsEncoding,
} from "@bitovp/db";
import { HEARTBEAT_SWEEP_PER_CHANNEL_TIMEOUT_MS } from "../heartbeat-cadence";
import type { LiveChannelDeps } from "../orchestrator/live-processor";

type Deps = Pick<
	LiveChannelDeps,
	"prisma" | "makeSdk" | "revealBitmovinAccount" | "now"
>;
type ReadJob = (
	id: string,
) => Promise<{ data: unknown; getState(): Promise<string> } | undefined>;

/** Enrol a pre-journal STOP in the existing terminal observer without ever posting STOP. */
export function createExhaustedLegacyStopRecovery(
	deps: Deps,
	readJob: ReadJob,
) {
	let after: string | undefined;
	return async () => {
		const rows = await deps.prisma.liveSchedule.findMany({
			where: {
				action: "STOP",
				status: "FIRED",
				liveChannelRunId: { not: null },
				firedAt: { not: null },
				stopAdmissionFenceVersion: null,
				liveChannel: {
					status: "STOPPING",
					origin: "MANAGED",
					legacyAdmissionFenceVersion: { not: null },
				},
				OR: [
					{ outcome: "UNKNOWN" },
					{ outcome: "PENDING", dispatchedAt: { not: null } },
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
				channel.legacyAdmissionFenceVersion !==
					channel.liveEffectFenceVersion ||
				(row.dispatchJobId && row.dispatchJobId !== jobId) ||
				!liveStopRunOwnsEncoding(run, encodingId)
			)
				continue;
			try {
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
				console.warn(
					`[live] Legacy scheduled STOP observation deferred for ${row.id}`,
				);
			}
		}
	};
}
