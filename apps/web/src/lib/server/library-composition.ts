import "server-only";
import {
	anyEditingDocumentSchema,
	type CompositionDocument,
	type CompositionSourceFacts,
	cfrTimeMapSchema,
	compileComposition,
} from "@bitovp/core";
import type {
	AppPrismaClient,
	AppTransactionClient,
	LibraryMediaVersion,
} from "@bitovp/db";
import { EditingRequestError } from "./library-editing-common";

type ResourceReader = Pick<
	AppPrismaClient,
	"libraryMediaVersion" | "libraryImageAsset" | "sceneAnalysisRevision"
>;

export function compositionSourceIds(document: CompositionDocument) {
	return [
		document.mediaVersionId,
		...(document.sources ?? []).map((s) => s.mediaVersionId),
	];
}

export function compositionSourceFacts(
	media: LibraryMediaVersion,
): CompositionSourceFacts {
	if (media.state !== "READY" || !media.sha256 || !media.width || !media.height)
		throw new EditingRequestError(422, "MEDIA_NOT_READY");
	const probe = media.probe as { streams?: { codec_type?: string }[] } | null;
	return {
		mediaVersionId: media.id,
		timeMap: cfrTimeMapSchema.parse(media.timeMap),
		width: media.width,
		height: media.height,
		hasAudio:
			Array.isArray(probe?.streams) &&
			probe.streams.some((s) => s.codec_type === "audio"),
	};
}

/** Resolve all references through tenant-scoped READY rows; document IDs are not locators. */
export async function resolveCompositionResources(
	db: ResourceReader,
	document: CompositionDocument,
	primary: LibraryMediaVersion,
	projectId: string,
	allowUnconfirmed = false,
) {
	if (document.mediaVersionId !== primary.id)
		throw new EditingRequestError(422, "MEDIA_VERSION_MISMATCH");
	const additionalIds = (document.sources ?? []).map(
		(source) => source.mediaVersionId,
	);
	const extra = additionalIds.length
		? await db.libraryMediaVersion.findMany({
				where: { id: { in: additionalIds }, state: "READY" },
				take: 8,
			})
		: [];
	if (extra.length !== additionalIds.length)
		throw new EditingRequestError(422, "COMPOSITION_SOURCE_UNAVAILABLE");
	const rows = [
		primary,
		...additionalIds
			.map((id) => extra.find((row) => row.id === id))
			.filter((row) => row !== undefined),
	];
	for (const source of document.sources ?? []) {
		if (!source.analysisRevisionId) continue;
		const media = rows.find((row) => row.id === source.mediaVersionId);
		const analysis =
			media &&
			(await db.sceneAnalysisRevision.findFirst({
				where: { id: source.analysisRevisionId, sourceId: media.sourceId },
				select: { id: true },
			}));
		if (!analysis)
			throw new EditingRequestError(422, "ANALYSIS_BINDING_UNVERIFIED");
	}
	const ids = document.imageAssets?.map((asset) => asset.id) ?? [];
	const images = ids.length
		? await db.libraryImageAsset.findMany({
				where: {
					id: { in: ids },
					OR: [{ projectId }, { retainedByProjects: { some: { projectId } } }],
				},
				take: 16,
			})
		: [];
	if (images.length !== ids.length)
		throw new EditingRequestError(422, "COMPOSITION_IMAGE_UNAVAILABLE");
	const facts = rows.map(compositionSourceFacts);
	const plan = compileComposition(document, facts, { allowUnconfirmed });
	return { rows, images, facts, plan };
}

/** Retain historical references even when later drafts remove a layer or image. */
export async function retainCompositionResources(
	tx: AppTransactionClient,
	projectId: string,
	input: unknown,
) {
	const document = anyEditingDocumentSchema.parse(input);
	if (document.schemaVersion !== 2) return;
	const data = [
		...compositionSourceIds(document).map((mediaVersionId) => ({
			projectId,
			mediaVersionId,
		})),
		...(document.imageAssets ?? []).map((asset) => ({
			projectId,
			imageAssetId: asset.id,
		})),
	];
	if (data.length)
		await tx.editProjectResource.createMany({ data, skipDuplicates: true });
}
