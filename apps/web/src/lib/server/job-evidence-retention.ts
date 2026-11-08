import "server-only";
import type { AppPrismaClient } from "@bitovp/db";

export const JOB_LIBRARY_EVIDENCE_REFERENCES =
	"JOB_LIBRARY_EVIDENCE_REFERENCES";

export class JobLibraryEvidenceRequired extends Error {
	readonly code = JOB_LIBRARY_EVIDENCE_REFERENCES;
	constructor(readonly protectedCount: number) {
		super(
			"This job is retained by Library source evidence and cannot be deleted.",
		);
	}
}

/** The supplied client is tenant-scoped; never use an administrative client for a request. */
export function countJobEvidenceReferences(
	prisma: Pick<AppPrismaClient, "libraryEvidenceReceipt">,
	jobIds?: readonly string[],
): Promise<number> {
	return prisma.libraryEvidenceReceipt.count({
		where: {
			jobId:
				jobIds === undefined
					? { not: null }
					: jobIds.length === 1
						? jobIds[0]
						: { in: [...jobIds] },
		},
	});
}

/** Call again after the target job row locks, before deleting any dependents. */
export async function assertNoJobEvidenceReferences(
	prisma: Pick<AppPrismaClient, "libraryEvidenceReceipt">,
	jobIds?: readonly string[],
) {
	const protectedCount = await countJobEvidenceReferences(prisma, jobIds);
	if (protectedCount > 0) throw new JobLibraryEvidenceRequired(protectedCount);
}

export function isForeignKeyViolation(error: unknown): boolean {
	const value = error as { code?: string; meta?: { code?: string } } | null;
	return (
		value?.code === "P2003" ||
		(value?.code === "P2010" && value.meta?.code === "23503")
	);
}
