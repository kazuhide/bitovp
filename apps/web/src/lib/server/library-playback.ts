import "server-only";
import { createHash } from "node:crypto";
import {
	type EncodingPlan,
	encodingPlanSchema,
	isLibraryFileKind,
	type LibrarySourceView,
	libraryFileOutputs,
	libraryPlaybackLinks,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { bindPassiveRequestUrl } from "@/lib/passive-request";

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
	!source.playbackLinks.some(
		(link) => isLibraryFileKind(link.kind) && link.url,
	);

/** Older captures omitted this newly supported file kind, sometimes retaining an empty list. */
function uncapturedWebmPlan(plan: EncodingPlan, source: FileSource) {
	if (source.fileOutputs?.length !== 0 || plan.qc?.only) return undefined;
	const muxings = plan.muxings.filter(
		(muxing) => muxing.kind === "PROGRESSIVE_WEBM",
	);
	return muxings.length ? { ...plan, muxings, manifests: [] } : undefined;
}

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
	if (source.fileOutputs?.length) return source.fileOutputs;
	const plans = await matchingPlans(prisma, [source]);
	const match = source.jobId ? plans.get(source.jobId) : undefined;
	if (!match) return [];
	if (source.fileOutputs === undefined) return libraryFileOutputs(match.plan);
	const recovered = uncapturedWebmPlan(match.plan, source);
	if (!recovered) return [];
	const files = libraryFileOutputs(recovered);
	const credentials = await prisma.credential.findMany({
		where: { id: { in: [...new Set(files.map((file) => file.credentialId))] } },
		select: { id: true },
	});
	return files.filter((file) =>
		credentials.some((credential) => credential.id === file.credentialId),
	);
}

/** Read-only compatibility for manifest-only snapshots; never reconstruct a deleted job. */
export async function enrichLibraryPlayback(
	prisma: Pick<AppPrismaClient, "encodingJob" | "credential">,
	sources: readonly PlaybackSource[],
	organizationId: string,
	/** A batched catalog supplies eligibility from its complete matched snapshot. */
	projectionEligible = needsLibraryPlaybackProjection,
): Promise<PlaybackLinks[]> {
	const plans = await matchingPlans(
		prisma,
		sources.filter(
			(source) =>
				projectionEligible(source) || source.fileOutputs?.length === 0,
		),
	);
	const credentialIds = [
		...new Set(
			[...plans.values()].flatMap(({ plan }) => [
				...plan.muxings.flatMap((muxing) => {
					if (
						(muxing.kind !== "MP4" &&
							!(muxing.kind === "WEBM" && muxing.progressive === true)) ||
						!muxing.destination
					)
						return [];
					const output = plan.outputs.find(
						(item) => item.key === muxing.destination?.outputKey,
					);
					return output ? [output.credentialId] : [];
				}),
				...libraryFileOutputs(plan).map((file) => file.credentialId),
			]),
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
		const recovered = samePlan
			? uncapturedWebmPlan(samePlan, source)
			: undefined;
		const projected = projectionEligible(source) ? samePlan : recovered;
		const keys = new Set(source.playbackLinks.map((link) => link.key));
		const links = [
			...source.playbackLinks,
			...(projected
				? libraryPlaybackLinks(
						projected,
						credentials.map((credential) => ({
							...credential,
							config: (credential.config ?? {}) as Record<string, unknown>,
						})),
					).filter(
						(link) => isLibraryFileKind(link.kind) && !keys.has(link.key),
					)
				: []),
		];
		const files = recovered
			? libraryFileOutputs(recovered).filter((file) =>
					credentials.some((credential) => credential.id === file.credentialId),
				)
			: (source.fileOutputs ?? (samePlan ? libraryFileOutputs(samePlan) : []));
		return links.map((link) => {
			if (
				!isLibraryFileKind(link.kind) ||
				!files.some((file) => file.key === link.key)
			)
				return link;
			const { reason: _unneeded, ...available } = link;
			return {
				...available,
				url: bindPassiveRequestUrl(
					`/api/library/sources/${source.sourceId}/media?key=${encodeURIComponent(link.key)}`,
					organizationId,
				),
				via: "library",
			};
		});
	});
}
