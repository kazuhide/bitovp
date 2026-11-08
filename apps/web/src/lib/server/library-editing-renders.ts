import "server-only";
import {
	anyEditingDocumentSchema,
	editingMediaStorageSchema,
	editingRenderProfileSchema,
	verifyAutomaticAnalysisBinding,
} from "@bitovp/core";
import { z } from "zod";
import type { EditingRenderView } from "@/lib/library-editing";
import { requestOrganizationId } from "@/lib/passive-request";
import { getServerContext, type ServerContext } from "./context";
import { resolveCompositionResources } from "./library-composition";
import {
	assertEditingBinding,
	boundMediaUrl,
	EditingRequestError,
	hash,
	json,
} from "./library-editing-common";
import { editingDurationFrames } from "./library-editing-projects";

export async function readEditingRender(
	id: string,
	context?: ServerContext,
): Promise<EditingRenderView> {
	const ctx = context ?? (await getServerContext());
	const row = await ctx.prisma.renderRun.findUnique({
		where: { id },
		include: {
			revision: { select: { document: true } },
			artifact: {
				include: {
					activeDerivations: {
						select: { projectId: true, derivedContentId: true },
					},
				},
			},
		},
	});
	if (!row) throw new EditingRequestError(404, "RENDER_NOT_FOUND");
	return {
		id: row.id,
		requestKey: row.requestKey,
		revisionId: row.revisionId,
		kind: editingRenderProfileSchema.parse(row.profile).kind,
		state: row.state,
		generation: row.generation,
		error: row.error,
		durationFrames: editingDurationFrames(row.revision.document),
		artifact: row.artifact
			? {
					id: row.artifact.id,
					url: boundMediaUrl(
						ctx,
						`/api/library/artifacts/${row.artifact.id}/media`,
					),
					downloadUrl: boundMediaUrl(
						ctx,
						`/api/library/artifacts/${row.artifact.id}/download`,
					),
					derivedContentId:
						row.artifact.activeDerivations.find(
							(target) => target.projectId === row.projectId,
						)?.derivedContentId ?? null,
				}
			: null,
	};
}
const requestSchema = z.strictObject({
	revisionId: z.uuid(),
	kind: z.enum(["PREVIEW", "EXPORT"]),
	requestKey: z.uuid(),
});
export async function requestEditingRender(projectId: string, value: unknown) {
	const input = requestSchema.parse(value);
	const ctx = await getServerContext();
	const organizationId = requestOrganizationId(ctx);
	const requestHash = hash({ revisionId: input.revisionId, kind: input.kind });
	const whereKey = {
		organizationId_projectId_requestKey: {
			organizationId,
			projectId,
			requestKey: input.requestKey,
		},
	};
	const replay = async () => {
		const existing = await ctx.prisma.renderRun.findUnique({ where: whereKey });
		if (!existing) return null;
		if (existing.requestHash !== requestHash)
			throw new EditingRequestError(409, "REQUEST_KEY_REUSED");
		return existing.id;
	};
	const existing = await replay();
	if (existing) return readEditingRender(existing, ctx);
	let id: string;
	try {
		id = await ctx.prisma.$transaction(async (tx) => {
			const project = await tx.editProject.findUnique({
				where: { id: projectId },
				include: { mediaVersion: true },
			});
			if (!project || project.archived)
				throw new EditingRequestError(404, "EDIT_NOT_FOUND");
			if (project.mediaVersion.state !== "READY")
				throw new EditingRequestError(422, "MEDIA_NOT_READY");
			const revision = await tx.editRevision.findFirst({
				where: { id: input.revisionId, projectId },
			});
			if (!revision) throw new EditingRequestError(422, "REVISION_NOT_FOUND");
			const parsedDocument = anyEditingDocumentSchema.parse(revision.document);
			const document =
				parsedDocument.schemaVersion === 2
					? parsedDocument
					: assertEditingBinding(parsedDocument, project.mediaVersion);
			if (document.schemaVersion === 2)
				await resolveCompositionResources(
					tx,
					document,
					project.mediaVersion,
					projectId,
				);
			if (document.autoGeneration) {
				const analysis = await tx.sceneAnalysisRevision.findFirst({
					where: {
						id: document.analysisRevisionId ?? "",
						sourceId: project.mediaVersion.sourceId,
					},
				});
				try {
					if (!analysis) throw new Error("Missing analysis evidence");
					const records = await tx.libraryAnalysisBinding.findMany({
						where: {
							mediaVersionId: project.mediaVersion.id,
							analysisRevisionId: analysis.id,
						},
						take: 26,
					});
					verifyAutomaticAnalysisBinding({
						organizationId,
						media: project.mediaVersion,
						analysis,
						bindings: records.map((record) => record.proof),
						binding: document.autoGeneration.binding,
					});
				} catch {
					throw new EditingRequestError(422, "ANALYSIS_BINDING_UNVERIFIED");
				}
			}
			const mediaStorage = editingMediaStorageSchema.parse(
				project.mediaVersion.storage,
			);
			let generation = 0;
			if (input.kind === "EXPORT") {
				const target = await tx.contentDerivation.upsert({
					where: {
						organizationId_projectId_variant: {
							organizationId,
							projectId,
							variant: project.variant,
						},
					},
					create: { projectId, variant: project.variant },
					update: {},
				});
				generation = (
					await tx.contentDerivation.update({
						where: { id: target.id },
						data: { desiredGeneration: { increment: 1 } },
					})
				).desiredGeneration;
			}
			const run = await tx.renderRun.create({
				data: {
					projectId,
					revisionId: revision.id,
					requestKey: input.requestKey,
					requestHash,
					generation,
					profile: json({ kind: input.kind }),
					outputCredentialId: mediaStorage.output.credentialId,
					outputBucket: mediaStorage.output.bucket,
					outputPrefix: mediaStorage.output.prefix,
				},
			});
			return run.id;
		});
	} catch (error) {
		if ((error as { code?: string }).code !== "P2002") throw error;
		const prior = await replay();
		if (!prior) throw new EditingRequestError(409, "RENDER_REQUEST_CONFLICT");
		id = prior;
	}
	return readEditingRender(id, ctx);
}
export async function cancelEditingRender(id: string) {
	const ctx = await getServerContext();
	const current = new Date();
	await ctx.prisma.$transaction(async (tx) => {
		await tx.renderRun.updateMany({
			where: { id, state: "QUEUED" },
			data: {
				state: "CANCELED",
				cancelRequestedAt: current,
				finishedAt: current,
			},
		});
		await tx.renderRun.updateMany({
			where: { id, state: { in: ["PREPARING", "RENDERING", "VALIDATING"] } },
			data: { state: "CANCEL_REQUESTED", cancelRequestedAt: current },
		});
	});
	return readEditingRender(id, ctx);
}
