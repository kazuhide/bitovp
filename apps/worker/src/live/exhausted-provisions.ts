import { liveChannelJobSchema } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { legacyScheduleId } from "../scheduler/schedule-outcome";
import { resolveProvisionAdmission } from "./provision-admission";
import { PROVISION_LEASE_MS } from "./provision-lease";
import { recordExpiredProvisionFailure } from "./reconcile-stranded-runs";

/** Old manual jobs have timestamped IDs that cannot be reconstructed from SQL.
 * Scan a bounded page of failed IDs only while an airing awaits its first lease.
 * The scoped queue reader verifies tenant ownership before exposing its payload. */
export function createExhaustedProvisionRecovery(
	prisma: AppPrismaClient,
	failedIds: (offset: number, limit: number) => Promise<string[]>,
	readOwnedJob: (
		id: string,
	) => Promise<
		| { data: unknown; timestamp?: number; getState(): Promise<string> }
		| undefined
	>,
) {
	let offset = 0;
	return async (at: Date) => {
		const pending = await prisma.liveChannel.findFirst({
			where: { status: "PROVISIONING", provisionClaimedAt: null },
			select: { id: true },
		});
		if (!pending) {
			offset = 0;
			return;
		}
		const limit = 16;
		const ids = await failedIds(offset, limit);
		offset = ids.length === limit ? offset + limit : 0;
		for (const id of ids) {
			const job = await readOwnedJob(id);
			if (!job) continue;
			const parsed = liveChannelJobSchema.safeParse(job.data);
			if (
				!parsed.success ||
				parsed.data.action !== "provision" ||
				(await job.getState()) !== "failed"
			)
				continue;
			const data = parsed.data;
			const admission = await resolveProvisionAdmission(
				prisma,
				data.liveChannelId,
				data,
				id,
				job.timestamp,
			);
			if (!admission) continue;
			const error =
				"The original Live startup job exhausted its deliveries. Check the encoder before starting again.";
			await recordExpiredProvisionFailure(
				prisma,
				data.liveChannelId,
				error,
				new Date(at.getTime() - PROVISION_LEASE_MS),
				at,
				admission,
				legacyScheduleId(id),
			);
		}
	};
}
