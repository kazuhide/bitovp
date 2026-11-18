import "server-only";
import {
	type AnyEditDocument,
	anyEditingDocumentSchema,
	canonicalEditingJson,
	isContentHighlightPolicy,
} from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import type {
	EditingClipPurpose,
	EditingProjectExportSummary,
	EditingProjectPage,
	EditingProjectSummary,
	StoredEditingExport,
} from "@/lib/library-editing";
import { requestOrganizationId } from "@/lib/passive-request";
import type { ServerContext } from "./context";
import { boundMediaUrl, EditingRequestError } from "./library-editing-common";
import { editingDurationFrames } from "./library-editing-projects";
import { editingThumbnailReference } from "./library-editing-thumbnail";

/** Stable publication lineage survives content metadata and source revisions. */
export async function contentParent(
	prisma: AppPrismaClient,
	contentId: string,
) {
	const derivation = await prisma.contentDerivation.findFirst({
		where: { derivedContentId: contentId },
		select: {
			project: {
				select: {
					id: true,
					contentId: true,
					content: { select: { id: true, title: true } },
				},
			},
		},
	});
	const project = derivation?.project;
	return project && project.contentId !== contentId
		? {
				contentId: project.contentId,
				title: project.content.title,
				projectId: project.id,
			}
		: null;
}

type ExportRow = {
	id: string;
	projectId: string;
	revisionId: string;
	generation: number;
	state: string;
	finishedAt: Date | null;
	document: unknown;
	artifactId: string | null;
	derivedContentId: string | null;
};

const exportProfile = { path: ["kind"], equals: "EXPORT" };
const exportRuns = {
	profile: exportProfile,
	generation: { gt: 0 },
} satisfies Prisma.RenderRunWhereInput;
const successfulExport = {
	...exportRuns,
	state: "SUCCEEDED",
	artifact: { isNot: null },
} satisfies Prisma.RenderRunWhereInput;

function exportPurpose(
	document: AnyEditDocument | undefined,
): EditingClipPurpose {
	const generation = document?.autoGeneration;
	if (generation && "trailer" in generation && generation.trailer)
		return "TRAILER";
	return generation && isContentHighlightPolicy(generation.policyVersion)
		? "HIGHLIGHT"
		: "CLIP";
}

function exportArtifact(
	ctx: ServerContext,
	id: string,
	derivedContentId: string | null,
) {
	return {
		id,
		url: boundMediaUrl(ctx, `/api/library/artifacts/${id}/media`),
		downloadUrl: boundMediaUrl(ctx, `/api/library/artifacts/${id}/download`),
		derivedContentId,
	};
}

/** Reads the exact successful run even after a replacement export or draft edit. */
export async function readStoredEditingExport(
	ctx: ServerContext,
	projectId: string,
	exportId: string,
): Promise<StoredEditingExport> {
	const organizationId = requestOrganizationId(ctx);
	return ctx.prisma.$transaction(
		async (tx) => {
			const run = await tx.renderRun.findFirst({
				where: {
					id: exportId,
					projectId,
					organizationId,
					...successfulExport,
					project: { organizationId },
					revision: { projectId, organizationId },
					artifact: { is: { organizationId } },
				},
				select: {
					id: true,
					revisionId: true,
					generation: true,
					revision: { select: { document: true } },
					project: {
						select: {
							contentId: true,
							title: true,
							draft: true,
							currentRevisionId: true,
						},
					},
					artifact: {
						select: {
							id: true,
							activeDerivations: {
								where: { organizationId, projectId },
								select: { derivedContentId: true },
								take: 1,
							},
						},
					},
				},
			});
			if (!run?.artifact) throw new EditingRequestError(404, "EDIT_NOT_FOUND");
			const latest = await tx.renderRun.findFirst({
				where: {
					projectId,
					organizationId,
					...exportRuns,
					revision: { projectId, organizationId },
				},
				orderBy: [
					{ generation: "desc" },
					{ createdAt: "desc" },
					{ id: "desc" },
				],
				select: { id: true },
			});
			const document = anyEditingDocumentSchema.safeParse(
				run.revision.document,
			);
			const draft = anyEditingDocumentSchema.safeParse(run.project.draft);
			return {
				projectId,
				contentId: run.project.contentId,
				title: run.project.title,
				earlierVersion:
					latest?.id !== run.id ||
					run.revisionId !== run.project.currentRevisionId ||
					!document.success ||
					!draft.success ||
					canonicalEditingJson(document.data) !==
						canonicalEditingJson(draft.data),
				purpose: exportPurpose(document.data),
				render: {
					id: run.id,
					revisionId: run.revisionId,
					generation: run.generation,
					kind: "EXPORT",
					state: "SUCCEEDED",
					error: null,
					...(document.success
						? { durationFrames: editingDurationFrames(document.data) }
						: {}),
					artifact: exportArtifact(
						ctx,
						run.artifact.id,
						run.artifact.activeDerivations[0]?.derivedContentId ?? null,
					),
				},
			};
		},
		{ isolationLevel: "RepeatableRead" },
	);
}

/** Only small summaries leave this function; draft/evidence/storage stays private. */
export async function listEditingProjectSummaries(
	ctx: ServerContext,
	contentId: string,
	offset: number,
	exportedOnly = false,
): Promise<EditingProjectPage> {
	const organizationId = requestOrganizationId(ctx);
	const where: Prisma.EditProjectWhereInput = {
		contentId,
		organizationId,
		...(exportedOnly
			? {
					renderRuns: {
						some: {
							...successfulExport,
							organizationId,
							artifact: { is: { organizationId } },
							revision: { organizationId },
						},
					},
				}
			: {}),
	};
	return ctx.prisma.$transaction(
		async (tx) => {
			const rows = await tx.editProject.findMany({
				where,
				orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
				skip: offset,
				take: 25,
				select: {
					id: true,
					contentId: true,
					title: true,
					variant: true,
					updatedAt: true,
					archived: true,
					draftRevision: true,
					draft: true,
					currentRevisionId: true,
					currentRevision: { select: { document: true } },
				},
			});
			const total = await tx.editProject.count({ where });
			if (!rows.length) return { items: [], offset, total };
			const ids = rows.map((row) => row.id);
			async function exports(successOnly: boolean) {
				return tx.$queryRaw<ExportRow[]>`
SELECT DISTINCT ON (r."projectId") r.id, r."projectId", r."revisionId",
 r.generation, r.state, r."finishedAt", v.document,
 a.id AS "artifactId", d."derivedContentId"
FROM "RenderRun" r
JOIN "EditProject" p ON p.id = r."projectId" AND p."organizationId" = r."organizationId"
JOIN "EditRevision" v ON v.id = r."revisionId" AND v."projectId" = r."projectId" AND v."organizationId" = r."organizationId"
LEFT JOIN "RenderArtifact" a ON a."runId" = r.id AND a."organizationId" = r."organizationId"
LEFT JOIN "ContentDerivation" d ON d."projectId" = r."projectId" AND d.variant = p.variant
 AND d."activeArtifactId" = a.id AND d."organizationId" = r."organizationId"
WHERE r."organizationId" = ${organizationId}::uuid
 AND r."projectId" = ANY(${ids}::uuid[]) AND r.profile->>'kind' = 'EXPORT' AND r.generation > 0
 AND (${successOnly} = false OR (r.state = 'SUCCEEDED' AND a.id IS NOT NULL))
ORDER BY r."projectId", r.generation DESC, r."createdAt" DESC, r.id DESC`;
			}
			const latest = new Map(
				(await exports(false)).map((run) => [run.projectId, run]),
			);
			const successful = new Map(
				(await exports(true)).map((run) => [run.projectId, run]),
			);
			const items: EditingProjectSummary[] = rows.map((row) => {
				const draft = anyEditingDocumentSchema.safeParse(row.draft);
				const current = anyEditingDocumentSchema.safeParse(
					row.currentRevision?.document,
				);
				const currentRevisionMatchesDraft =
					draft.success &&
					current.success &&
					canonicalEditingJson(draft.data) ===
						canonicalEditingJson(current.data);
				function summary(
					run: ExportRow | undefined,
				): EditingProjectExportSummary | null {
					if (!run) return null;
					const document = anyEditingDocumentSchema.safeParse(run.document);
					return {
						id: run.id,
						revisionId: run.revisionId,
						generation: run.generation,
						state: run.state,
						durationFrames: document.success
							? editingDurationFrames(document.data)
							: null,
						purpose: exportPurpose(document.data),
						finishedAt: run.finishedAt?.toISOString() ?? null,
						matchesCurrentDraft:
							currentRevisionMatchesDraft &&
							run.revisionId === row.currentRevisionId,
						artifact:
							run.state === "SUCCEEDED" && run.artifactId
								? exportArtifact(ctx, run.artifactId, run.derivedContentId)
								: null,
					};
				}
				const success = summary(successful.get(row.id));
				return {
					id: row.id,
					contentId: row.contentId,
					title: row.title,
					variant: row.variant,
					updatedAt: row.updatedAt.toISOString(),
					archived: row.archived,
					draftRevision: row.draftRevision,
					currentRevisionId: row.currentRevisionId,
					currentRevisionMatchesDraft,
					durationFrames: draft.success
						? editingDurationFrames(draft.data)
						: null,
					fps: draft.success ? draft.data.fps : null,
					thumbnail:
						draft.success && !exportedOnly
							? editingThumbnailReference(
									ctx,
									row.id,
									row.draftRevision,
									draft.data,
								)
							: null,
					latestExport: summary(latest.get(row.id)),
					latestSuccessfulExport:
						success?.state === "SUCCEEDED" && success.artifact
							? { ...success, state: "SUCCEEDED", artifact: success.artifact }
							: null,
				};
			});
			return { items, offset, total };
		},
		{ isolationLevel: "RepeatableRead" },
	);
}
