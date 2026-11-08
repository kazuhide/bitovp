import { createHash } from "node:crypto";
import {
	AutomaticBindingError,
	COMPOSITION_CAPTION_LAYOUT_POLICY,
	type CompositionDocument,
	type CompositionSourceFacts,
	canonicalEditingJson,
	cfrTimeMapSchema,
	compileComposition,
	editingMediaStorageSchema,
	editingObjectSchema,
} from "@bitovp/core";
import type { AppPrismaClient, LibraryMediaVersion } from "@bitovp/db";
import { inspectEditingProbe } from "./media";
import { MediaOperationError } from "./process";

const invalid = (): never => {
	throw new MediaOperationError("INVALID_RENDER_INPUT");
};
export async function resolveCompositionRenderInput(input: {
	prisma: AppPrismaClient;
	organizationId: string;
	projectId: string;
	primary: LibraryMediaVersion;
	document: CompositionDocument;
}) {
	const { document, primary, organizationId, projectId, prisma } = input;
	if (
		document.mediaVersionId !== primary.id ||
		primary.organizationId !== organizationId
	)
		return invalid();
	const ids = (document.sources ?? []).map((source) => source.mediaVersionId);
	const extra = ids.length
		? await prisma.libraryMediaVersion.findMany({
				where: { organizationId, id: { in: ids }, state: "READY" },
				take: 8,
			})
		: [];
	if (extra.length !== ids.length) return invalid();
	const sources = [
		primary,
		...ids.map((id) => extra.find((row) => row.id === id) ?? invalid()),
	];
	const facts: CompositionSourceFacts[] = sources.map((row) => {
		if (
			row.organizationId !== organizationId ||
			row.state !== "READY" ||
			!row.sha256 ||
			!/^[a-f0-9]{64}$/.test(row.sha256)
		)
			return invalid();
		const storage = editingMediaStorageSchema.parse(row.storage);
		if (!storage.prepared?.expect || !storage.prepared.size) return invalid();
		const probe = inspectEditingProbe(row.probe);
		if (probe.width !== row.width || probe.height !== row.height)
			return invalid();
		const timeMap = cfrTimeMapSchema.parse(row.timeMap);
		if (timeMap.editingEndFrame > probe.frameCount) return invalid();
		return {
			mediaVersionId: row.id,
			width: probe.width,
			height: probe.height,
			hasAudio: probe.hasAudio,
			timeMap,
		};
	});
	for (const declaration of document.sources ?? []) {
		if (!declaration.analysisRevisionId) continue;
		const media = sources.find((row) => row.id === declaration.mediaVersionId);
		if (!media) return invalid();
		const analysis = await prisma.sceneAnalysisRevision.findFirst({
			where: {
				id: declaration.analysisRevisionId,
				organizationId,
				sourceId: media.sourceId,
			},
			select: { id: true },
		});
		if (!analysis) throw new AutomaticBindingError();
	}
	const imageIds = document.imageAssets?.map((image) => image.id) ?? [];
	const images = imageIds.length
		? await prisma.libraryImageAsset.findMany({
				where: {
					organizationId,
					id: { in: imageIds },
					OR: [
						{ projectId },
						{ retainedByProjects: { some: { projectId, organizationId } } },
					],
				},
				take: 16,
			})
		: [];
	if (images.length !== imageIds.length) return invalid();
	for (const image of images) {
		if (
			image.organizationId !== organizationId ||
			!/^[a-f0-9]{64}$/.test(image.sha256) ||
			image.size < 1n ||
			image.size > 8n * 1024n * 1024n ||
			image.width < 1 ||
			image.height < 1 ||
			image.width > 2048 ||
			image.height > 2048
		)
			return invalid();
		const storage = editingObjectSchema.parse(image.storage);
		if (!storage.expect || storage.size !== Number(image.size))
			return invalid();
	}
	const plan = compileComposition(document, facts);
	const pinned = {
		schemaVersion: 2,
		plan,
		...(plan.document.captions?.length
			? { captionLayoutPolicy: COMPOSITION_CAPTION_LAYOUT_POLICY }
			: {}),
		sources: sources
			.map((row) => ({ mediaVersionId: row.id, sha256: row.sha256 }))
			.sort((a, b) => a.mediaVersionId.localeCompare(b.mediaVersionId, "en")),
		images: images
			.map((row) => ({ assetId: row.id, sha256: row.sha256 }))
			.sort((a, b) => a.assetId.localeCompare(b.assetId, "en")),
	};
	const recipeHash = createHash("sha256")
		.update(canonicalEditingJson(pinned))
		.digest("hex");
	return { plan, sources, images, recipeHash };
}
