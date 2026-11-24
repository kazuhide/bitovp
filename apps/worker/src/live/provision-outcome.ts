import type { AppPrismaClient, Prisma } from "@bitovp/db";
import { createRunMirror } from "../orchestrator/run-mirror";

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
		await tx.$queryRaw`SELECT id FROM "LiveChannel" WHERE id = ${liveChannelId}::uuid FOR UPDATE`;
		await tx.$queryRaw`SELECT id FROM "LiveChannelRun" WHERE "liveChannelId" = ${liveChannelId}::uuid ORDER BY seq DESC LIMIT 1 FOR UPDATE`;
		const latest = await tx.liveChannelRun.findFirst({
			where: { liveChannelId },
			orderBy: { seq: "desc" },
			select: { id: true, status: true, cancelRequested: true },
		});
		if (
			(latest?.id ?? null) !== runId ||
			(target.requireProvisioning && latest?.status === "RUNNING")
		)
			return false;
		const changed = await tx.liveChannel.updateMany({
			where: {
				id: liveChannelId,
				...(target.requireProvisioning ? { status: "PROVISIONING" } : {}),
				provisionClaimedAt: lease,
				liveEffectFenceVersion: generation,
			},
			data: { ...outcome, provisionClaimedAt: null },
		});
		if (!changed.count) return false;
		if (
			latest &&
			(!["ERROR", "STOPPED"].includes(latest.status) ||
				(latest.status === "ERROR" &&
					latest.cancelRequested &&
					outcome.status === "STOPPING"))
		) {
			await createRunMirror(tx).mirror(liveChannelId, outcome);
		}
		return true;
	});
}
