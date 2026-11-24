import { restoreLiveProvisionEvidence } from "@bitovp/core";
import type { AppPrismaClient, AppTransactionClient, Prisma } from "@bitovp/db";
import { createRunMirror } from "../orchestrator/run-mirror";

/** Keep the channel and its latest run stable, always locking the channel first. */
export async function lockProvisionAiring(
	tx: AppTransactionClient,
	liveChannelId: string,
) {
	await tx.$queryRaw`SELECT id FROM "LiveChannel" WHERE id = ${liveChannelId}::uuid FOR UPDATE`;
	await tx.$queryRaw`SELECT id FROM "LiveChannelRun" WHERE "liveChannelId" = ${liveChannelId}::uuid ORDER BY seq DESC LIMIT 1 FOR UPDATE`;
	return tx.liveChannelRun.findFirst({
		where: { liveChannelId },
		orderBy: { seq: "desc" },
		select: {
			id: true,
			status: true,
			cancelRequested: true,
			stepLog: true,
			bitmovinEncodingId: true,
		},
	});
}

export type ProvisionEnd = {
	status: "ERROR" | "STOPPING";
	error: string | null;
	stepLog?: Prisma.InputJsonValue;
};

/** Release one provision lease and project its outcome before another airing can start. */
export async function commitProvisionEnd(
	prisma: AppPrismaClient,
	target: {
		liveChannelId: string;
		runId: string | null;
		generation: number;
		lease: Date;
		requireProvisioning?: boolean;
	},
	outcome: ProvisionEnd,
): Promise<boolean> {
	return prisma.$transaction(async (tx) => {
		const { liveChannelId, runId, generation, lease } = target;
		const latest = await lockProvisionAiring(tx, liveChannelId);
		if (
			(latest?.id ?? null) !== runId ||
			(target.requireProvisioning && latest?.status === "RUNNING")
		)
			return false;
		let projection = outcome;
		if (latest && outcome.stepLog !== undefined) {
			const channel = await tx.liveChannel.findUnique({
				where: { id: liveChannelId },
				select: { stepLog: true },
			});
			if (!channel) return false;
			const saved = restoreLiveProvisionEvidence(
				channel.stepLog,
				latest.stepLog,
				latest.bitmovinEncodingId,
			);
			const restored =
				saved &&
				restoreLiveProvisionEvidence(
					outcome.stepLog,
					saved,
					latest.bitmovinEncodingId,
				);
			projection = {
				status: outcome.status,
				error: outcome.error,
				...(restored
					? { stepLog: restored as unknown as Prisma.InputJsonValue }
					: {}),
			};
		}
		const changed = await tx.liveChannel.updateMany({
			where: {
				id: liveChannelId,
				...(target.requireProvisioning ? { status: "PROVISIONING" } : {}),
				provisionClaimedAt: lease,
				liveEffectFenceVersion: generation,
			},
			data: { ...projection, provisionClaimedAt: null },
		});
		if (!changed.count) return false;
		if (
			latest &&
			(!["ERROR", "STOPPED"].includes(latest.status) ||
				(latest.status === "ERROR" &&
					latest.cancelRequested &&
					outcome.status === "STOPPING"))
		) {
			await createRunMirror(tx).mirror(liveChannelId, projection);
		}
		return true;
	});
}
