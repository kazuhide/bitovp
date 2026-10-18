import {
	FEEDER_MAX_ACTIVE_SESSIONS,
	feederJobSchema,
	liveChannelJobSchema,
	notifyJobSchema,
	orchestratorJobSchema,
	probeBatchJobSchema,
	type QueueKey,
	slateNormalizeJobSchema,
	storageInspectJobSchema,
	tenantQueueEnvelopeSchema,
	tenantSystemSweepSchema,
	usageBackfillJobSchema,
	vmafJobSchema,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { DelayedError, type Job } from "bullmq";
import {
	admitInactiveOrganization,
	INACTIVE_ORGANIZATION_ERROR,
} from "./admission";
import { runInOrganization } from "./scope";

const sweeps = {
	liveChannel: {
		name: "heartbeat-sweep",
		id: "live-heartbeat-sweep",
		marker: "heartbeat",
	},
	slateNormalize: {
		name: "slate-normalize-promote",
		id: "slate-normalize-promote",
		marker: "slate",
	},
} as const;

type TenantConsumerDeps = {
	prisma: AppPrismaClient;
	forEachOrganization(run: () => Promise<unknown> | unknown): Promise<void>;
	/** One explicit migration window; never resolve arbitrary org-less payloads. */
	legacyOrganizationId?: string;
	isOrganizationActive?(organizationId: string): Promise<boolean>;
};

export function tenantJobPayload(job: Job, legacyOrganizationId?: string) {
	const parsed = tenantQueueEnvelopeSchema.safeParse(job.data);
	if (parsed.success) return parsed.data;
	if (
		legacyOrganizationId &&
		typeof job.data === "object" &&
		job.data !== null &&
		!("organizationId" in job.data) &&
		!("payload" in job.data) &&
		!("systemSweep" in job.data)
	)
		return { organizationId: legacyOrganizationId, payload: job.data };
	throw new Error("Organization queue envelope is required");
}

function unwrappedJob(job: Job, payload: unknown): Job {
	return Object.assign(Object.create(job), { data: payload });
}

async function assertOwned(
	prisma: AppPrismaClient,
	model: string,
	id: string,
	relation?: object,
) {
	const delegate = Reflect.get(prisma, model) as {
		findFirst(args: object): Promise<{ id: string } | null>;
	};
	if (
		!(await delegate.findFirst({
			where: { id, ...relation },
			select: { id: true },
		}))
	)
		throw new Error("Tenant resource unavailable");
}

/** Primary and related ownership are checked before any processor resolves secrets. */
export async function assertTenantJobOwned(
	prisma: AppPrismaClient,
	key: QueueKey,
	payload: unknown,
) {
	switch (key) {
		case "orchestrator": {
			const data = orchestratorJobSchema.parse(payload);
			await assertOwned(prisma, "encodingJob", data.encodingJobId);
			return;
		}
		case "liveChannel": {
			const data = liveChannelJobSchema.parse(payload);
			await assertOwned(prisma, "liveChannel", data.liveChannelId);
			if (data.effect?.scheduleId)
				await assertOwned(prisma, "liveSchedule", data.effect.scheduleId, {
					liveChannelId: data.liveChannelId,
				});
			const runIds = new Set([
				data.liveChannelRunId,
				data.plannedLiveChannelRunId,
				data.effect?.liveChannelRunId,
			]);
			for (const id of runIds)
				if (id)
					await assertOwned(prisma, "liveChannelRun", id, {
						liveChannelId: data.liveChannelId,
					});
			if (typeof data.params === "object" && data.params !== null) {
				const params = data.params as Record<string, unknown>;
				if (typeof params.cancelRunId === "string")
					await assertOwned(prisma, "liveChannelRun", params.cancelRunId, {
						liveChannelId: data.liveChannelId,
					});
				if (typeof params.scheduleId === "string")
					await assertOwned(prisma, "liveSchedule", params.scheduleId, {
						liveChannelId: data.liveChannelId,
					});
				if (typeof params.feederSessionId === "string")
					await assertOwned(prisma, "feederSession", params.feederSessionId, {
						liveChannelId: data.liveChannelId,
					});
			}
			return;
		}
		case "vmafRunner":
			await assertOwned(
				prisma,
				"vmafJob",
				vmafJobSchema.parse(payload).vmafJobId,
			);
			return;
		case "feederManager":
			await assertOwned(
				prisma,
				"feederSession",
				feederJobSchema.parse(payload).feederSessionId,
			);
			return;
		case "storageInspect":
			await assertOwned(
				prisma,
				"storageInspection",
				storageInspectJobSchema.parse(payload).storageInspectionId,
			);
			return;
		case "slateNormalize":
			await assertOwned(
				prisma,
				"slateNormalization",
				slateNormalizeJobSchema.parse(payload).slateNormalizationId,
			);
			return;
		case "usageStatistics":
			await assertOwned(
				prisma,
				"bitmovinAccount",
				usageBackfillJobSchema.parse(payload).accountId,
			);
			return;
		case "startupProbe": {
			probeBatchJobSchema.parse(payload);
			const setting = await prisma.appSetting.findUnique({
				where: { key: "live:startup-probe" },
				select: { value: true },
			});
			if (!setting) throw new Error("Tenant resource unavailable");
			return;
		}
		case "notify": {
			const data = notifyJobSchema.parse(payload);
			if ("jobId" in data) await assertOwned(prisma, "encodingJob", data.jobId);
			if ("liveChannelId" in data)
				await assertOwned(prisma, "liveChannel", data.liveChannelId);
			if ("vmafJobId" in data)
				await assertOwned(prisma, "vmafJob", data.vmafJobId);
			if ("feederSessionId" in data)
				await assertOwned(prisma, "feederSession", data.feederSessionId);
			if ("alertId" in data)
				await assertOwned(prisma, "alertEvent", data.alertId);
			if ("watchFolderId" in data)
				await assertOwned(prisma, "watchRule", data.watchFolderId);
			if ("scheduleId" in data)
				await assertOwned(prisma, "liveSchedule", data.scheduleId);
			return;
		}
	}
}

export function createTenantConsumer(deps: TenantConsumerDeps) {
	// One process-wide spare slot remains available for STOP across all tenants.
	let feederStarts = 0;
	return <T>(
		key: QueueKey,
		handler: (job: Job) => Promise<T>,
		options?: { reserveFeederStopSlot?: boolean; enforceActive?: boolean },
	) =>
		async (job: Job): Promise<T | undefined> => {
			const sweep =
				key === "liveChannel" || key === "slateNormalize"
					? sweeps[key]
					: undefined;
			const marker = tenantSystemSweepSchema.safeParse(job.data);
			if (
				sweep &&
				job.name === sweep.name &&
				job.repeatJobKey === sweep.id &&
				marker.success &&
				marker.data.systemSweep === sweep.marker
			) {
				await deps.forEachOrganization(() => handler(unwrappedJob(job, {})));
				return;
			}
			const envelope = tenantJobPayload(job, deps.legacyOrganizationId);
			return runInOrganization(envelope.organizationId, async () => {
				await assertTenantJobOwned(deps.prisma, key, envelope.payload);
				if (
					options?.enforceActive !== false &&
					deps.isOrganizationActive &&
					!(await deps.isOrganizationActive(envelope.organizationId)) &&
					!(await admitInactiveOrganization(deps.prisma, key, envelope.payload))
				)
					throw new Error(INACTIVE_ORGANIZATION_ERROR);
				const feederStart =
					options?.reserveFeederStopSlot !== false &&
					key === "feederManager" &&
					feederJobSchema.parse(envelope.payload).action === "start";
				if (feederStart && feederStarts >= FEEDER_MAX_ACTIVE_SESSIONS) {
					await job.moveToDelayed(Date.now() + 1000, job.token);
					throw new DelayedError();
				}
				if (feederStart) feederStarts++;
				try {
					return await handler(unwrappedJob(job, envelope.payload));
				} finally {
					if (feederStart) feederStarts--;
				}
			});
		};
}
