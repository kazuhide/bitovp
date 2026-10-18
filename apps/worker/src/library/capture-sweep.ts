import { createHash } from "node:crypto";
import { type AppPrismaClient, requestLibrarySource } from "@bitovp/db";

/** Durable completion catch-up: no provider calls and no mutation of job lifecycle. */
export function createLibraryCaptureSweep(deps: {
	prisma: AppPrismaClient;
	capture?: typeof requestLibrarySource;
}) {
	let after: string | undefined;
	return async () => {
		const jobs = await deps.prisma.encodingJob.findMany({
			where: {
				status: "FINISHED",
				libraryCaptureSuppressed: false,
				...(after ? { id: { gt: after } } : {}),
			},
			select: {
				id: true,
				plan: true,
				bitmovinEncodingId: true,
				librarySources: {
					select: {
						sourceKey: true,
						snapshot: true,
						revisions: { take: 1, select: { id: true } },
					},
				},
			},
			orderBy: { id: "asc" },
			take: 25,
		});
		for (const job of jobs) {
			after = job.id;
			const hash = (value: unknown) =>
				createHash("sha256").update(JSON.stringify(value)).digest("hex");
			const key = hash([job.id, job.bitmovinEncodingId, hash(job.plan)]);
			const aisa =
				job.plan &&
				typeof job.plan === "object" &&
				!Array.isArray(job.plan) &&
				job.plan.aiSceneAnalysis;
			if (
				job.librarySources.some(
					(source) =>
						source.sourceKey === key &&
						source.revisions.length &&
						(!aisa ||
							(source.snapshot &&
								typeof source.snapshot === "object" &&
								!Array.isArray(source.snapshot) &&
								source.snapshot.analysisOutput)),
				)
			)
				continue;
			try {
				await (deps.capture ?? requestLibrarySource)(deps.prisma, job.id);
			} catch {
				// A deleted/ineligible legacy job cannot starve subsequent completion work.
				// Raw DB/provider errors must never enter customer metadata.
			}
		}
		if (!jobs.length) after = undefined;
	};
}
