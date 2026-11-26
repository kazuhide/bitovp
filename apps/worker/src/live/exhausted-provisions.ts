import { hasAisaLiveBinding, type LiveChannelJob } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { type EmitProductEvent, emitScheduleFired } from "../notify/emitter";
import {
	scheduledStartJobId,
	scheduledStartScheduleId,
} from "../scheduler/schedule-outcome";
import {
	identifyProvisionJob,
	prepareScheduledStartDispatch,
	type ReadProvisionJob,
	recordRetainedScheduledStart,
} from "./provision-admission";
import { PROVISION_LEASE_MS } from "./provision-lease";
import { recordExpiredProvisionFailure } from "./reconcile-stranded-runs";

export function createExhaustedProvisionRecovery(
	prisma: AppPrismaClient,
	readOwnedJob: ReadProvisionJob,
	reenqueue: (job: LiveChannelJob, id: string) => Promise<void>,
	emitEvent?: EmitProductEvent,
) {
	let after: string | undefined;
	const error =
		"The original Live startup job exhausted its deliveries. Check the encoder before starting again.";
	return async (at: Date) => {
		// The database identifies all current admissions, including an initial CREATED
		// channel without a run. Queue retention is independent of this keyset cursor.
		const rows = await prisma.liveChannel.findMany({
			where: {
				origin: "MANAGED",
				status: { in: ["CREATED", "PROVISIONING"] },
				provisionClaimedAt: null,
				...(after ? { id: { gt: after } } : {}),
			},
			select: {
				id: true,
				status: true,
				purpose: true,
				plan: true,
				stepLog: true,
				liveEffectFenceVersion: true,
				legacyAdmissionFenceVersion: true,
				manualProvisionAdmissionFenceVersion: true,
				runs: {
					orderBy: { seq: "desc" },
					take: 1,
					select: {
						id: true,
						seq: true,
						status: true,
						cancelRequested: true,
						legacyProvisionAdmissionAt: true,
						aisaAnalysisId: true,
						aisaStatus: true,
						aisaSnapshot: true,
						stepLog: true,
					},
				},
			},
			orderBy: { id: "asc" },
			take: 16,
		});
		after = rows.length === 16 ? rows.at(-1)?.id : undefined;
		for (const row of rows) {
			const run = row.runs[0],
				generation = row.liveEffectFenceVersion;
			if (
				run?.cancelRequested ||
				(run && !["CREATED", "PROVISIONING"].includes(run.status))
			)
				continue;
			let scheduled:
				| {
						id: string;
						outcome: string;
						dispatchJobId: string | null;
						dispatchedAt: Date | null;
						firstStartDispatchAt: Date | null;
				  }
				| undefined;
			let id: string,
				data: LiveChannelJob = { liveChannelId: row.id, action: "provision" };
			if (
				generation === 0 &&
				(!run || run.seq === 1) &&
				row.status === "CREATED"
			) {
				id = row.purpose === "PROBE" ? `probe-${row.id}` : row.id;
			} else {
				if (!run || row.status !== "PROVISIONING") continue;
				const schedules = await prisma.liveSchedule.findMany({
					where: {
						action: "START",
						status: "FIRED",
						liveChannelId: row.id,
						liveChannelRunId: run.id,
						startAdmissionFenceVersion: generation,
						outcome: { in: ["PENDING", "UNKNOWN", "FAILED"] },
					},
					select: {
						id: true,
						outcome: true,
						dispatchJobId: true,
						dispatchedAt: true,
						firstStartDispatchAt: true,
					},
					take: 2,
				});
				if (schedules.length > 1) continue;
				const schedule = schedules[0];
				data = { ...data, plannedLiveChannelRunId: run.id };
				if (schedule) {
					if (hasAisaLiveBinding(row, run)) {
						await recordExpiredProvisionFailure(
							prisma,
							row.id,
							"Scheduled START is unavailable for a protected AISA broadcast. Check the channel before starting again.",
							new Date(0),
							at,
							{ runId: run.id, generation },
							schedule.id,
						);
						continue;
					}
					scheduled = schedule;
					id = scheduledStartJobId(schedule.id, generation);
					data.provisionFenceVersion = generation;
				} else {
					const legacy =
						row.legacyAdmissionFenceVersion === generation &&
						run.legacyProvisionAdmissionAt !== null;
					if (
						row.manualProvisionAdmissionFenceVersion !== generation &&
						!legacy
					)
						continue;
					if (legacy) {
						// An indeterminate old schedule cannot take credit for this airing.
						// Even a confirmed old job may have been evicted. Resume the
						// already-admitted ordinary airing under its exact run and fence.
						if (
							await prisma.liveEffectClaim.findFirst({
								where: {
									liveChannelId: row.id,
									liveChannelRunId: run.id,
									action: "RESTART",
									generation,
								},
								select: { id: true },
							})
						)
							continue;
						if (hasAisaLiveBinding(row, run)) {
							await recordExpiredProvisionFailure(
								prisma,
								row.id,
								"The pre-upgrade START of this protected AISA broadcast could not be attributed. Check the channel before starting again.",
								new Date(0),
								at,
								{ runId: run.id, generation },
							);
							continue;
						}
					}
					const source = legacy ? "resume" : "manual";
					id = `${source}-provision-${row.id}-${run.id}-${generation}`;
				}
			}
			if (scheduled && run) {
				const start = {
					id: scheduled.id,
					liveChannelId: row.id,
					liveChannelRunId: run.id,
					startAdmissionFenceVersion: generation,
				};
				if (scheduled.outcome === "PENDING") {
					const delivery = await prepareScheduledStartDispatch(
						prisma,
						readOwnedJob,
						start,
						scheduled,
					);
					if (!delivery) continue;
					if (delivery.state === null) await reenqueue(data, delivery.id);
					const recorded = await recordRetainedScheduledStart(
						prisma,
						start,
						{ id: delivery.id, state: delivery.state ?? "waiting" },
						at,
					);
					if (recorded === "handoff") void emitScheduleFired(start, emitEvent);
					if (delivery.state !== "failed" || !recorded) continue;
				} else {
					const job = await readOwnedJob(scheduled.dispatchJobId ?? id);
					const state = await job?.getState();
					if (job && state !== "failed" && state !== "completed") continue;
				}
				await recordExpiredProvisionFailure(
					prisma,
					row.id,
					error,
					new Date(at.getTime() - PROVISION_LEASE_MS),
					at,
					{ runId: run.id, generation },
					start.id,
				);
				continue;
			}
			const job = await readOwnedJob(id);
			if (job) {
				if ((await job.getState()) !== "failed") continue;
				const original = await identifyProvisionJob(prisma, row.id, id, job);
				if (!original) continue;
				await recordExpiredProvisionFailure(
					prisma,
					row.id,
					error,
					new Date(at.getTime() - PROVISION_LEASE_MS),
					at,
					original.admission,
					scheduledStartScheduleId(id, original.data.provisionFenceVersion),
				);
			} else await reenqueue(data, id);
		}
	};
}
