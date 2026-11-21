import type { AppPrismaClient } from "@bitovp/db";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export function pruneOperationAttempts(
	prisma: Pick<AppPrismaClient, "operationAttempt">,
	now = new Date(),
) {
	return prisma.operationAttempt.deleteMany({
		where: { startedAt: { lt: new Date(now.getTime() - RETENTION_MS) } },
	});
}
