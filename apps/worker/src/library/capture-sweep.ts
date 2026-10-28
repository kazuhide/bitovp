import { createHash } from "node:crypto";
import {
	encodingPlanSchema,
	libraryFileOutputs,
	librarySnapshotSchema,
} from "@bitovp/core";
import { type AppPrismaClient, requestLibrarySource } from "@bitovp/db";

function needsFileMetadataUpgrade(
	value: unknown,
	planHash: string,
	expected: ReturnType<typeof libraryFileOutputs>,
) {
	if (!expected.length) return false;
	const parsed = librarySnapshotSchema.safeParse(value);
	if (!parsed.success || parsed.data.planHash !== planHash) return false;
	const snapshot = parsed.data;
	const stored = snapshot.fileOutputs ?? [];
	if (
		stored.length < 100 &&
		expected.some((file) => !stored.some((item) => item.key === file.key))
	)
		return true;
	return expected.some((file) => {
		const existing = stored.find((item) => item.key === file.key);
		// Registration preserves conflicting stored coordinates and cannot repair them.
		return (
			existing &&
			existing.kind === file.kind &&
			existing.credentialId === file.credentialId &&
			existing.bucket === file.bucket &&
			existing.path === file.path &&
			!snapshot.playbackLinks.some((link) => link.key === file.key)
		);
	});
}

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
						state: true,
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
			const planHash = hash(job.plan);
			const key = hash([job.id, job.bitmovinEncodingId, planHash]);
			const parsedPlan = encodingPlanSchema.safeParse(job.plan);
			const expectedFiles = parsedPlan.success
				? libraryFileOutputs(parsedPlan.data)
				: [];
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
						(source.state === "RUNNING" ||
							!needsFileMetadataUpgrade(
								source.snapshot,
								planHash,
								expectedFiles,
							)) &&
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
