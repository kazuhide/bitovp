import {
	hasAisaLiveBinding,
	type LiveChannelJob,
	liveChannelJobSchema,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import {
	scheduledStartJobId,
	scheduledStartScheduleId,
} from "../scheduler/schedule-outcome";
import { resolveProvisionAdmission } from "./provision-admission";
import { PROVISION_LEASE_MS } from "./provision-lease";
import { recordExpiredProvisionFailure } from "./reconcile-stranded-runs";

type ReadJob = (
	id: string,
) => Promise<
	{ data: unknown; timestamp?: number; getState(): Promise<string> } | undefined
>;

export function createExhaustedProvisionRecovery(
	prisma: AppPrismaClient,
	readOwnedJob: ReadJob,
	reenqueue: (job: LiveChannelJob, id: string) => Promise<void>,
) {
	let after: string | undefined;
	const error =
		"The original Live startup job exhausted its deliveries. Check the encoder before starting again.";
	async function identify(
		id: string,
		job: NonNullable<Awaited<ReturnType<ReadJob>>>,
		channelId: string,
	) {
		const parsed = liveChannelJobSchema.safeParse(job.data);
		if (
			!parsed.success ||
			parsed.data.action !== "provision" ||
			parsed.data.params ||
			parsed.data.effect ||
			channelId !== parsed.data.liveChannelId
		)
			return null;
		const admission = await resolveProvisionAdmission(
			prisma,
			channelId,
			parsed.data,
			id,
			job.timestamp,
		);
		return admission ? { admission, data: parsed.data } : null;
	}
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
			let terminalScheduleId: string | undefined;
			let scheduledStartId: string | undefined;
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
					select: { id: true, outcome: true },
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
					scheduledStartId = schedule.id;
					id = scheduledStartJobId(schedule.id, generation);
					if (schedule.outcome !== "PENDING") terminalScheduleId = schedule.id;
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
			let job = await readOwnedJob(id);
			if (!job && scheduledStartId && run) {
				const legacyId = scheduledStartJobId(scheduledStartId);
				const legacy = await readOwnedJob(legacyId);
				const original = legacy && (await identify(legacyId, legacy, row.id));
				if (
					legacy &&
					original &&
					"runId" in original.admission &&
					original.admission.runId === run.id &&
					original.admission.generation === generation
				) {
					id = legacyId;
					job = legacy;
					await prisma.liveSchedule.updateMany({
						where: {
							id: scheduledStartId,
							liveChannelId: row.id,
							liveChannelRunId: run.id,
							action: "START",
							status: "FIRED",
							outcome: "PENDING",
							startAdmissionFenceVersion: generation,
							dispatchedAt: null,
						},
						data: { dispatchedAt: at, dispatchJobId: legacyId },
					});
				}
			}
			if (
				terminalScheduleId &&
				run &&
				(!job || ["failed", "completed"].includes(await job.getState()))
			)
				await recordExpiredProvisionFailure(
					prisma,
					row.id,
					error,
					new Date(at.getTime() - PROVISION_LEASE_MS),
					at,
					{ runId: run.id, generation },
					terminalScheduleId,
				);
			else if (job) {
				if ((await job.getState()) !== "failed") continue;
				const original = await identify(id, job, row.id);
				if (original)
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
