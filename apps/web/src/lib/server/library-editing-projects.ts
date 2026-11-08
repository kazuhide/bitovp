import "server-only";
import {
	anyEditingDocumentSchema,
	canonicalEditingJson,
	compositionDurationFrames,
	confirmCompositionFraming,
	normalizeManualCaptionSourceEvidenceEdits,
	normalizeManualCaptionTranslationEdits,
	normalizeManualSubjectProtectionEdits,
	proposeHighlightCandidates,
	SubjectProtectionAdoptionError,
	sceneAnalysisDocumentSchema,
} from "@bitovp/core";
import { z } from "zod";
import type {
	AnyEditingProjectView,
	EditingRenderView,
} from "@/lib/library-editing";
import { getServerContext, type ServerContext } from "./context";
import {
	resolveCompositionResources,
	retainCompositionResources,
} from "./library-composition";

export function editingDurationFrames(input: unknown) {
	const document = anyEditingDocumentSchema.parse(input);
	return document.schemaVersion === 2
		? compositionDurationFrames(document)
		: document.clips.reduce((sum, clip) => sum + clip.durationFrames, 0);
}

import {
	assertEditingBinding,
	boundMediaUrl,
	EditingRequestError,
	initialEditingDocument,
	json,
	mediaView,
} from "./library-editing-common";

export async function readEditingProject(
	id: string,
	ctx?: ServerContext,
	reader?: Pick<
		ServerContext["prisma"],
		"editProject" | "sceneAnalysisRevision" | "renderRun"
	> &
		Partial<
			Pick<ServerContext["prisma"], "libraryMediaVersion" | "libraryImageAsset">
		>,
): Promise<AnyEditingProjectView> {
	const context = ctx ?? (await getServerContext());
	const prisma = reader ?? context.prisma;
	const renderInclude = {
		revision: { select: { document: true } },
		artifact: {
			include: {
				activeDerivations: {
					where: { projectId: id },
					select: { derivedContentId: true },
				},
			},
		},
	} as const;
	const row = await prisma.editProject.findUnique({
		where: { id },
		include: {
			mediaVersion: true,
			currentRevision: true,
			renderRuns: {
				orderBy: { createdAt: "desc" },
				take: 25,
				include: renderInclude,
			},
		},
	});
	if (!row) throw new EditingRequestError(404, "EDIT_NOT_FOUND");
	// PREVIEW traffic must not evict the authoritative EXPORT from this view.
	const latestExport = await prisma.renderRun.findFirst({
		where: { projectId: id, profile: { path: ["kind"], equals: "EXPORT" } },
		orderBy: [{ generation: "desc" }, { createdAt: "desc" }, { id: "desc" }],
		include: renderInclude,
	});
	const runs =
		latestExport && !row.renderRuns.some((run) => run.id === latestExport.id)
			? [...row.renderRuns, latestExport]
			: row.renderRuns;
	const draft = anyEditingDocumentSchema.parse(row.draft);
	let composition: Awaited<
		ReturnType<typeof resolveCompositionResources>
	> | null = null;
	if (draft.schemaVersion === 2) {
		if (!prisma.libraryMediaVersion || !prisma.libraryImageAsset)
			throw new EditingRequestError(500, "COMPOSITION_READER_UNAVAILABLE");
		composition = await resolveCompositionResources(
			{
				libraryMediaVersion: prisma.libraryMediaVersion,
				libraryImageAsset: prisma.libraryImageAsset,
				sceneAnalysisRevision: prisma.sceneAnalysisRevision,
			},
			draft,
			row.mediaVersion,
			id,
			true,
		);
	}
	const analysis = draft.analysisRevisionId
		? await prisma.sceneAnalysisRevision.findFirst({
				where: {
					id: draft.analysisRevisionId,
					sourceId: row.mediaVersion.sourceId,
				},
			})
		: null;
	return {
		id: row.id,
		contentId: row.contentId,
		title: row.title,
		variant: row.variant,
		draftRevision: row.draftRevision,
		draft,
		...(composition
			? {
					additionalMedia: composition.rows
						.slice(1)
						.map((media) => mediaView(context, media)),
					compositionSources: composition.facts,
					imageAssets: composition.images.map((asset) => ({
						id: asset.id,
						url: boundMediaUrl(
							context,
							`/api/library/image-assets/${asset.id}/media`,
						),
						width: asset.width,
						height: asset.height,
					})),
				}
			: {}),
		currentRevisionId: row.currentRevisionId,
		currentRevisionMatchesDraft:
			!!row.currentRevision &&
			JSON.stringify(
				anyEditingDocumentSchema.parse(row.currentRevision.document),
			) === JSON.stringify(draft),
		media: mediaView(context, row.mediaVersion),
		analysis: analysis
			? {
					id: analysis.id,
					locale: analysis.locale,
					document: sceneAnalysisDocumentSchema.parse(analysis.document),
				}
			: null,
		renders: runs.map(
			(run): EditingRenderView => ({
				id: run.id,
				requestKey: run.requestKey,
				revisionId: run.revisionId,
				kind: (run.profile as { kind: "PREVIEW" | "EXPORT" }).kind,
				state: run.state,
				generation: run.generation,
				error: run.error,
				durationFrames: editingDurationFrames(run.revision.document),
				artifact: run.artifact
					? {
							id: run.artifact.id,
							url: boundMediaUrl(
								context,
								`/api/library/artifacts/${run.artifact.id}/media`,
							),
							downloadUrl: boundMediaUrl(
								context,
								`/api/library/artifacts/${run.artifact.id}/download`,
							),
							derivedContentId:
								run.artifact.activeDerivations[0]?.derivedContentId ?? null,
						}
					: null,
			}),
		),
	};
}
const createSchema = z.strictObject({
	contentId: z.uuid(),
	mediaVersionId: z.uuid(),
	title: z.string().trim().min(1).max(500),
	variant: z.enum(["LANDSCAPE", "PORTRAIT"]),
	analysisRevisionId: z.uuid().nullable().optional(),
});
export async function createEditingProject(
	value: unknown,
	actor: string | null,
) {
	const input = createSchema.parse(value);
	const ctx = await getServerContext();
	const media = await ctx.prisma.libraryMediaVersion.findUnique({
		where: { id: input.mediaVersionId },
	});
	if (media?.state !== "READY")
		throw new EditingRequestError(422, "MEDIA_NOT_READY");
	const sourceLink = await ctx.prisma.contentRevision.findFirst({
		where: { contentId: input.contentId, sourceId: media.sourceId },
	});
	if (!sourceLink) throw new EditingRequestError(422, "CONTENT_MEDIA_MISMATCH");
	const draft = initialEditingDocument(media, input.variant);
	if (input.analysisRevisionId) {
		const analysis = await ctx.prisma.sceneAnalysisRevision.findFirst({
			where: { id: input.analysisRevisionId, sourceId: media.sourceId },
		});
		if (!analysis)
			throw new EditingRequestError(422, "ANALYSIS_BINDING_UNVERIFIED");
		draft.analysisRevisionId = analysis.id;
		draft.locale = analysis.locale;
	}
	const row = await ctx.prisma.editProject.create({
		data: {
			contentId: input.contentId,
			mediaVersionId: media.id,
			title: input.title,
			variant: input.variant,
			draft: json(draft),
			createdBy: actor,
		},
	});
	return readEditingProject(row.id, ctx);
}
const draftSchema = z.strictObject({
	expectedRevision: z.number().int().positive(),
	document: anyEditingDocumentSchema,
});
export async function saveEditingDraft(id: string, value: unknown) {
	const input = draftSchema.parse(value);
	const ctx = await getServerContext();
	return ctx.prisma.$transaction(async (tx) => {
		const row = await tx.editProject.findUnique({
			where: { id },
			include: { mediaVersion: true },
		});
		if (!row) throw new EditingRequestError(404, "EDIT_NOT_FOUND");
		const originalDraft = anyEditingDocumentSchema.parse(row.draft);
		if (
			canonicalEditingJson(originalDraft.autoGeneration ?? null) !==
			canonicalEditingJson(input.document.autoGeneration ?? null)
		)
			throw new EditingRequestError(422, "AUTO_GENERATION_IMMUTABLE");
		try {
			input.document = normalizeManualSubjectProtectionEdits(
				originalDraft,
				input.document,
			);
		} catch (error) {
			if (error instanceof SubjectProtectionAdoptionError)
				throw new EditingRequestError(422, error.code);
			throw error;
		}
		for (const clip of input.document.clips)
			for (const part of clip.framing)
				if (part.origin === "AUTO_POLICY") part.origin = "MANUAL";
		const document =
			input.document.schemaVersion === 2
				? normalizeManualCaptionSourceEvidenceEdits(
						originalDraft.schemaVersion === 2
							? originalDraft
							: { ...input.document, captions: [] },
						normalizeManualCaptionTranslationEdits(
							originalDraft,
							input.document,
						),
					)
				: assertEditingBinding(input.document, row.mediaVersion, true);
		if (document.schemaVersion === 2)
			await resolveCompositionResources(
				tx,
				document,
				row.mediaVersion,
				id,
				true,
			);
		if (
			document.schemaVersion === 1 &&
			(row.variant === "PORTRAIT") !==
				document.canvas.height > document.canvas.width
		)
			throw new EditingRequestError(422, "EDIT_VARIANT_MISMATCH");
		if (document.analysisRevisionId) {
			const evidence = await tx.sceneAnalysisRevision.findFirst({
				where: {
					id: document.analysisRevisionId,
					sourceId: row.mediaVersion.sourceId,
					locale: document.locale,
				},
			});
			if (!evidence)
				throw new EditingRequestError(422, "ANALYSIS_BINDING_UNVERIFIED");
		}
		await retainCompositionResources(tx, id, document);
		const changed = await tx.editProject.updateMany({
			where: { id, draftRevision: input.expectedRevision },
			data: { draft: json(document), draftRevision: { increment: 1 } },
		});
		if (!changed.count) throw new EditingRequestError(409, "EDIT_CONFLICT");
		return readEditingProject(id, ctx, tx);
	});
}
const confirmSchema = z.strictObject({
	expectedRevision: z.number().int().positive(),
	confirmSuggestions: z.boolean(),
});
export async function confirmEditingRevision(
	id: string,
	value: unknown,
	actor: string | null,
) {
	const input = confirmSchema.parse(value);
	const ctx = await getServerContext();
	return ctx.prisma.$transaction(async (tx) => {
		const row = await tx.editProject.findUnique({
			where: { id },
			include: { mediaVersion: true },
		});
		if (!row) throw new EditingRequestError(404, "EDIT_NOT_FOUND");
		let document = anyEditingDocumentSchema.parse(row.draft);
		if (input.confirmSuggestions)
			document = confirmCompositionFraming(document);
		if (document.schemaVersion === 2) {
			await resolveCompositionResources(tx, document, row.mediaVersion, id);
			await retainCompositionResources(tx, id, document);
		} else assertEditingBinding(document, row.mediaVersion);
		const changed = await tx.editProject.updateMany({
			where: { id, draftRevision: input.expectedRevision },
			data: { draft: json(document), draftRevision: { increment: 1 } },
		});
		if (!changed.count) throw new EditingRequestError(409, "EDIT_CONFLICT");
		const revision = await tx.editRevision.create({
			data: {
				projectId: id,
				revision: input.expectedRevision + 1,
				document: json(document),
				parentRevisionId: row.currentRevisionId,
				createdBy: actor,
			},
		});
		await tx.editProject.update({
			where: { id },
			data: { currentRevisionId: revision.id },
		});
		return readEditingProject(id, ctx, tx);
	});
}
export async function editingSuggestions(id: string, value: unknown) {
	const input = z
		.strictObject({
			query: z.string().max(200),
			sceneIds: z.array(z.uuid()).max(20).optional(),
			targetDurationFrames: z.number().int().positive().max(5400).optional(),
		})
		.parse(value);
	const project = await readEditingProject(id);
	return {
		candidates: project.analysis
			? proposeHighlightCandidates(project.analysis.document, {
					query: input.query,
					selectedSceneIds: input.sceneIds,
					targetDurationFrames: input.targetDurationFrames,
					analysisBinding: "UNVERIFIED",
				})
			: [],
	};
}
