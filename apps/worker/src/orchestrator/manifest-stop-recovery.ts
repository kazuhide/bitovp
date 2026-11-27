import type { AppPrismaClient, Prisma } from "@bitovp/db";
import type { Queue } from "bullmq";
import { attemptLeaseAvailable } from "./processor";

export const roleManifestStopPendingWhere = {
	OR: [
		{ stepLog: { array_contains: [{ roleDeliveryBlocked: true }] } },
		// An accepted cancel is durable even when its first cleanup write failed.
		{
			cancelRequested: true,
			plan: {
				path: ["outputs"],
				array_contains: [{ kind: "S3_ROLE_BASED" }],
			},
		},
	],
} satisfies Prisma.EncodingJobWhereInput;

export function createManifestStopRecovery({
	prisma,
	queue,
	now,
}: {
	prisma: { encodingJob: Pick<AppPrismaClient["encodingJob"], "findMany"> };
	queue: Pick<Queue, "addBulk">;
	now: () => Date;
}) {
	return async () => {
		const at = now();
		const jobs = await prisma.encodingJob.findMany({
			where: {
				status: { in: ["QUEUED", "RUNNING"] },
				AND: [roleManifestStopPendingWhere, attemptLeaseAvailable(at)],
				// Give a normally delayed delivery (30s) time to resume.
				updatedAt: { lt: new Date(at.getTime() - 60_000) },
			},
			select: { id: true },
			orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
			take: 20,
		});
		if (jobs.length === 0) return;
		await queue.addBulk(
			jobs.map(({ id }) => ({
				name: "orchestrate",
				data: { encodingJobId: id },
				opts: {
					jobId: `${id}-manifest-stop`,
					removeOnComplete: true,
					removeOnFail: true,
				},
			})),
		);
	};
}
