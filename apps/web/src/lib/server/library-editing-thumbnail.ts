import "server-only";
import {
	type AnyEditDocument,
	anyEditingDocumentSchema,
	evaluateCompositionFrame,
	hashEditingEvidence,
	toCompositionDocument,
} from "@bitovp/core";
import type {
	EditingThumbnailFrameView,
	EditingThumbnailReference,
} from "@/lib/library-editing";
import {
	EXPECTED_ORGANIZATION_QUERY,
	requestOrganizationId,
} from "@/lib/passive-request";
import { getServerContext, type ServerContext } from "./context";
import { resolveCompositionResources } from "./library-composition";
import { boundMediaUrl, EditingRequestError } from "./library-editing-common";

export function editingThumbnailReference(
	ctx: ServerContext,
	id: string,
	draftRevision: number,
	draft: AnyEditDocument,
): EditingThumbnailReference {
	const cacheKey = hashEditingEvidence({
		version: "editing-thumbnail-v4-japanese-line-breaks",
		id,
		draftRevision,
		draft,
	});
	const query = new URLSearchParams({
		draftRevision: String(draftRevision),
		cacheKey,
	});
	return {
		url: `${boundMediaUrl(ctx, `/api/library/edits/${id}/thumbnail-frame`)}&${query}`,
		cacheKey,
		draftRevision,
		width: draft.canvas.width,
		height: draft.canvas.height,
	};
}

function thumbnailCanvas(canvas: { width: number; height: number }) {
	let divisor = canvas.width;
	let remainder = canvas.height;
	while (remainder) [divisor, remainder] = [remainder, divisor % remainder];
	const unitWidth = canvas.width / divisor;
	const unitHeight = canvas.height / divisor;
	const multiple = Math.floor(192 / Math.max(unitWidth, unitHeight));
	return { width: unitWidth * multiple, height: unitHeight * multiple };
}

/** A single small frame, not a draft, analysis document or storage locator. */
export async function readEditingThumbnailFrame(
	req: Request,
	id: string,
): Promise<EditingThumbnailFrameView> {
	const query = new URL(req.url).searchParams;
	const keys = [EXPECTED_ORGANIZATION_QUERY, "draftRevision", "cacheKey"];
	if (
		[...query.keys()].some((key) => !keys.includes(key)) ||
		keys.some((key) => query.getAll(key).length !== 1) ||
		!/^\d{1,10}$/.test(query.get("draftRevision") ?? "") ||
		!/^[a-f0-9]{64}$/.test(query.get("cacheKey") ?? "")
	)
		throw new EditingRequestError(400, "INVALID_MEDIA_QUERY");
	const ctx = await getServerContext();
	if (query.get(EXPECTED_ORGANIZATION_QUERY) !== requestOrganizationId(ctx))
		throw new EditingRequestError(409, "MEDIA_ORGANIZATION_CHANGED");
	return ctx.prisma.$transaction(
		async (tx) => {
			const row = await tx.editProject.findUnique({
				where: { id },
				include: { mediaVersion: true },
			});
			if (!row) throw new EditingRequestError(404, "EDIT_NOT_FOUND");
			const draft = anyEditingDocumentSchema.parse(row.draft);
			const reference = editingThumbnailReference(
				ctx,
				id,
				row.draftRevision,
				draft,
			);
			if (
				Number(query.get("draftRevision")) !== row.draftRevision ||
				query.get("cacheKey") !== reference.cacheKey
			)
				throw new EditingRequestError(409, "EDIT_THUMBNAIL_CHANGED");
			const empty: EditingThumbnailFrameView = {
				cacheKey: reference.cacheKey,
				draftRevision: row.draftRevision,
				frame: null,
				video: null,
				images: [],
			};
			const document = toCompositionDocument(draft);
			const { plan, images } = await resolveCompositionResources(
				tx,
				document,
				row.mediaVersion,
				id,
				true,
			);
			const first = [...plan.clips].sort(
				(a, b) =>
					a.outputFromFrame - b.outputFromFrame || a.trackOrder - b.trackOrder,
			)[0];
			if (!first) return empty;
			const frameIndex =
				first.outputFromFrame +
				Math.min(
					30,
					Math.floor((first.outputToFrame - first.outputFromFrame - 1) / 2),
				);
			const frame = evaluateCompositionFrame(
				plan,
				frameIndex,
				thumbnailCanvas(document.canvas),
			);
			// One video per capture keeps the global two-decoder ceiling exact.
			if (
				frame.layers.length !== 1 ||
				!frame.layers[0] ||
				frame.layers[0].opacity <= 0
			)
				return empty;
			const layer = frame.layers[0];
			const activeImageIds = new Set(
				frame.overlays.flatMap((overlay) =>
					overlay.kind === "IMAGE" ? [overlay.assetId] : [],
				),
			);
			const result: EditingThumbnailFrameView = {
				cacheKey: reference.cacheKey,
				draftRevision: row.draftRevision,
				frame: {
					frame: frame.frame,
					timeUs: frame.timeUs,
					canvas: frame.canvas,
					layers: frame.layers,
					audio: [],
					captions: frame.captions.map((caption) => ({
						id: caption.id,
						fromFrame: caption.fromFrame,
						toFrame: caption.toFrame,
						text: caption.text,
						rect: caption.rect,
						style: caption.style,
						activeWords: caption.activeWords.map((word) => ({
							text: word.text,
							startChar: word.startChar,
							endChar: word.endChar,
							fromFrame: word.fromFrame,
							toFrame: word.toFrame,
						})),
					})),
					overlays: frame.overlays.map((overlay) => {
						const common = {
							id: overlay.id,
							fromFrame: overlay.fromFrame,
							toFrame: overlay.toFrame,
							rect: overlay.rect,
							opacity: overlay.opacity,
							zIndex: overlay.zIndex,
							pixelRect: overlay.pixelRect,
						};
						return overlay.kind === "IMAGE"
							? { ...common, kind: "IMAGE" as const, assetId: overlay.assetId }
							: {
									...common,
									kind: "TEXT" as const,
									text: overlay.text,
									resolvedStyle: overlay.resolvedStyle,
								};
					}),
				},
				video: {
					clipId: layer.clipId,
					mediaVersionId: layer.mediaVersionId,
					url: boundMediaUrl(
						ctx,
						`/api/library/media-versions/${layer.mediaVersionId}/media`,
					),
				},
				images: images
					.filter((image) => activeImageIds.has(image.id))
					.map((image) => ({
						id: image.id,
						url: boundMediaUrl(
							ctx,
							`/api/library/image-assets/${image.id}/media`,
						),
					})),
			};
			return Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024
				? result
				: empty;
		},
		{ isolationLevel: "RepeatableRead" },
	);
}
