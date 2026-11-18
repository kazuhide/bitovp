import "server-only";
import { MEDIA_TASK_STATES } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { z } from "zod";
import {
	GENERATION_HISTORY_PAGE_SIZE,
	type GenerationHistory,
	type GenerationHistoryFilters,
} from "@/lib/library-generation-history";
import { retainedExportForProject } from "./library-retained-export";

type TaskRow = {
	taskId: string;
	state: GenerationHistory["items"][number]["state"];
	contentId: string | null;
	contentTitle: string | null;
	mediaVersionId: string;
	updatedAt: Date;
	projectIds: (string | null)[] | null;
};
type ClipRow = GenerationHistory["items"][number]["clips"][number] & {
	contentId: string;
	mediaVersionId: string;
};

const periodDays = { day: 1, week: 7, month: 30 };
const uuidPattern = "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$";
const uuid = z.uuid();

function clipIds(row: TaskRow): string[] {
	if (row.state !== "SUCCEEDED" || !row.contentId) return [];
	return [
		...new Set(
			(row.projectIds ?? []).flatMap((id) => {
				const parsed = uuid.safeParse(id);
				return parsed.success ? [parsed.data] : [];
			}),
		),
	];
}

export async function listGenerationHistory(
	db: AppPrismaClient,
	organizationId: string,
	filters: GenerationHistoryFilters,
): Promise<GenerationHistory> {
	const search = filters.q ? `%${filters.q.replace(/[\\%_]/g, "\\$&")}%` : null;
	const states = filters.state ? [filters.state] : [...MEDIA_TASK_STATES];
	const updatedSince = filters.period
		? new Date(Date.now() - periodDays[filters.period] * 86_400_000)
		: null;
	return db.$transaction(
		async (tx) => {
			const tasks = await tx.$queryRaw<TaskRow[]>`
      SELECT t.id AS "taskId", t.state, t."updatedAt", t."mediaVersionId",
        c.id AS "contentId", c.title AS "contentTitle",
        CASE WHEN t.state = 'SUCCEEDED' THEN ARRAY[
          COALESCE(t.result->'projectIds'->>0, t.result->>'projectId'),
          t.result->'projectIds'->>1, t.result->'projectIds'->>2
        ] END AS "projectIds"
      FROM "LibraryMediaTask" t
      JOIN "LibraryMediaVersion" m ON m.id = t."mediaVersionId" AND m."organizationId" = t."organizationId"
      LEFT JOIN "Content" c ON c."organizationId" = t."organizationId"
        AND c.id = CASE
          WHEN (t.parameters#>>'{input,parameters,contentId}') ~* ${uuidPattern}
          THEN (t.parameters#>>'{input,parameters,contentId}')::uuid
        END
        AND EXISTS (
          SELECT 1 FROM "ContentRevision" v
          WHERE v."contentId" = c.id AND v."sourceId" = m."sourceId" AND v."organizationId" = c."organizationId"
        )
      WHERE t."organizationId" = ${organizationId}::uuid AND t.kind = 'GENERATE'
        AND t.state = ANY(${states}::text[])
        AND t."updatedAt" >= COALESCE(${updatedSince}::timestamp, '-infinity'::timestamp)
        AND (${search}::text IS NULL OR c.title ILIKE ${search}::text)
      ORDER BY t."updatedAt" DESC, t.id DESC
      LIMIT ${GENERATION_HISTORY_PAGE_SIZE + 1} OFFSET ${filters.offset}`;
			const page = tasks
				.slice(0, GENERATION_HISTORY_PAGE_SIZE)
				.map((task) => ({ task, ids: clipIds(task) }));
			const projectIds = [...new Set(page.flatMap(({ ids }) => ids))];
			const clips = projectIds.length
				? await tx.$queryRaw<ClipRow[]>`
        SELECT p.id AS "projectId", p.title, p."contentId", p."mediaVersionId", kept.id AS "exportId"
        FROM "EditProject" p
        LEFT JOIN LATERAL (${retainedExportForProject()}) kept ON true
        WHERE p.id = ANY(${projectIds}::uuid[]) AND p."organizationId" = ${organizationId}::uuid`
				: [];
			const byId = new Map(clips.map((clip) => [clip.projectId, clip]));
			return {
				items: page.map(({ task, ids }) => ({
					taskId: task.taskId,
					state: task.state,
					contentTitle: task.contentTitle,
					updatedAt: task.updatedAt.toISOString(),
					clips: ids.flatMap((id) => {
						const clip = byId.get(id);
						if (
							!clip ||
							clip.contentId !== task.contentId ||
							clip.mediaVersionId !== task.mediaVersionId
						)
							return [];
						return [
							{
								projectId: clip.projectId,
								title: clip.title,
								exportId: clip.exportId,
							},
						];
					}),
				})),
				hasMore: tasks.length > GENERATION_HISTORY_PAGE_SIZE,
			};
		},
		{ isolationLevel: "RepeatableRead", statementTimeoutMs: 5_000 },
	);
}
