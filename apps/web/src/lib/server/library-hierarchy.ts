import "server-only";
import { anyEditingDocumentSchema, canonicalEditingJson } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import type {
	EditingProjectExportSummary,
	EditingProjectPage,
	EditingProjectSummary,
} from "@/lib/library-editing";
import type { ServerContext } from "./context";
import { boundMediaUrl } from "./library-editing-common";
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

function duration(document: unknown) {
	const parsed = anyEditingDocumentSchema.safeParse(document);
	return parsed.success ? editingDurationFrames(parsed.data) : null;
}

/** Only small summaries leave this function; draft/evidence/storage stays private. */
export async function listEditingProjectSummaries(
	ctx: ServerContext,
	contentId: string,
	offset: number,
): Promise<EditingProjectPage> {
	return ctx.prisma.$transaction(
		async (tx) => {
			const rows = await tx.editProject.findMany({
				where: { contentId },
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
			const total = await tx.editProject.count({ where: { contentId } });
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
WHERE r."projectId" = ANY(${ids}::uuid[]) AND r.profile->>'kind' = 'EXPORT' AND r.generation > 0
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
					return run
						? {
								id: run.id,
								revisionId: run.revisionId,
								generation: run.generation,
								state: run.state,
								durationFrames: duration(run.document),
								finishedAt: run.finishedAt?.toISOString() ?? null,
								matchesCurrentDraft:
									currentRevisionMatchesDraft &&
									run.revisionId === row.currentRevisionId,
								artifact:
									run.state === "SUCCEEDED" && run.artifactId
										? {
												id: run.artifactId,
												url: boundMediaUrl(
													ctx,
													`/api/library/artifacts/${run.artifactId}/media`,
												),
												downloadUrl: boundMediaUrl(
													ctx,
													`/api/library/artifacts/${run.artifactId}/download`,
												),
												derivedContentId: run.derivedContentId,
											}
										: null,
							}
						: null;
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
					thumbnail: draft.success
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
