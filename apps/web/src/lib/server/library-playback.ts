import "server-only";
import { createHash } from "node:crypto";
import {
	encodingPlanSchema,
	type LibrarySourceView,
	libraryFileOutputs,
	libraryPlaybackLinks,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";

type PlaybackLinks = LibrarySourceView["snapshot"]["playbackLinks"];
type FileSource = {
	jobId: string | null;
	planHash: string;
	fileOutputs?: ReturnType<typeof libraryFileOutputs>;
};
type PlaybackSource = FileSource & {
	sourceId: string;
	playbackLinks: PlaybackLinks;
};

export const needsLibraryPlaybackProjection = (source: PlaybackSource) =>
	source.fileOutputs === undefined &&
	!source.playbackLinks.some((link) => link.kind === "MP4" && link.url);

async function matchingPlans(
	prisma: Pick<AppPrismaClient, "encodingJob" | "credential">,
	sources: readonly FileSource[],
) {
	const ids = [
		...new Set(
			sources.flatMap((source) => (source.jobId ? [source.jobId] : [])),
		),
	];
	const jobs = ids.length
		? await prisma.encodingJob.findMany({
				where: { id: { in: ids } },
				select: { id: true, plan: true },
			})
		: [];
	return new Map(
		jobs.flatMap((job) => {
			const hash = createHash("sha256")
				.update(JSON.stringify(job.plan))
				.digest("hex");
			if (
				!sources.some(
					(source) => source.jobId === job.id && source.planHash === hash,
				)
			)
				return [];
			const parsed = encodingPlanSchema.safeParse(job.plan);
			return parsed.success
				? [[job.id, { plan: parsed.data, hash }] as const]
				: [];
		}),
	);
}

/** Exact stored coordinates survive deletion; legacy rows require the identical retained plan. */
export async function libraryFileOutputsForSource(
	prisma: Pick<AppPrismaClient, "encodingJob" | "credential">,
	source: FileSource,
): Promise<ReturnType<typeof libraryFileOutputs>> {
	if (source.fileOutputs !== undefined) return source.fileOutputs;
	const plans = await matchingPlans(prisma, [source]);
	const match = source.jobId ? plans.get(source.jobId) : undefined;
	return match ? libraryFileOutputs(match.plan) : [];
}

/** Read-only compatibility for manifest-only snapshots; never reconstruct a deleted job. */
export async function enrichLibraryPlayback(
	prisma: Pick<AppPrismaClient, "encodingJob" | "credential">,
	sources: readonly PlaybackSource[],
	/** A batched catalog supplies eligibility from its complete matched snapshot. */
	projectionEligible = needsLibraryPlaybackProjection,
): Promise<PlaybackLinks[]> {
	const plans = await matchingPlans(prisma, sources.filter(projectionEligible));
	const credentialIds = [
		...new Set(
			[...plans.values()].flatMap(({ plan }) =>
				plan.muxings.flatMap((muxing) => {
					if (muxing.kind !== "MP4" || !muxing.destination) return [];
					const output = plan.outputs.find(
						(item) => item.key === muxing.destination?.outputKey,
					);
					return output ? [output.credentialId] : [];
				}),
			),
		),
	];
	const credentials = credentialIds.length
		? await prisma.credential.findMany({
				where: { id: { in: credentialIds } },
				select: { id: true, provider: true, config: true },
			})
		: [];
	return sources.map((source) => {
		const match = source.jobId ? plans.get(source.jobId) : undefined;
		const samePlan =
			match && source.planHash === match.hash ? match.plan : undefined;
		const keys = new Set(source.playbackLinks.map((link) => link.key));
		const links = [
			...source.playbackLinks,
			...(samePlan
				? libraryPlaybackLinks(
						samePlan,
						credentials.map((credential) => ({
							...credential,
							config: (credential.config ?? {}) as Record<string, unknown>,
						})),
					).filter((link) => link.kind === "MP4" && !keys.has(link.key))
				: []),
		];
		const files =
			source.fileOutputs ?? (samePlan ? libraryFileOutputs(samePlan) : []);
		return links.map((link) => {
			if (link.kind !== "MP4" || !files.some((file) => file.key === link.key))
				return link;
			const { reason: _unneeded, ...available } = link;
			return {
				...available,
				url: `/api/library/sources/${source.sourceId}/media?key=${encodeURIComponent(link.key)}`,
				via: "library",
			};
		});
	});
}
