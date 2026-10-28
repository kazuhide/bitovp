import "server-only";
import { librarySnapshotSchema } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { z } from "zod";
import { MAX_LIBRARY_OFFSET } from "@/lib/library-catalog";
import {
	type LibrarySceneHit,
	type LibrarySceneResults,
	librarySceneRelevance,
} from "@/lib/library-scenes";
import { catalogPreview } from "./library-catalog";
import { enrichLibraryPlayback } from "./library-playback";

export const sceneSearchQuery = z.object({
	q: z
		.string()
		.max(200)
		.transform((value) => value.trim())
		.default(""),
	offset: z.coerce.number().int().min(0).max(MAX_LIBRARY_OFFSET).default(0),
	archived: z.enum(["true", "false"]).default("false"),
	match: z.enum(["all", "any"]).default("all"),
	sort: z.enum(["relevance", "recent"]).default("relevance"),
	locale: z
		.string()
		.max(35)
		.regex(/^(?:[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*)?$/)
		.default(""),
});

export const sceneOptionsQuery = sceneSearchQuery.pick({ archived: true });

export async function librarySceneOptions(
	prisma: AppPrismaClient,
	query: z.infer<typeof sceneOptionsQuery>,
): Promise<{ locales: string[] }> {
	const rows = await prisma.$queryRaw<{ locale: string }[]>`
	 SELECT DISTINCT c.locale FROM "Content" c
	 JOIN "ContentRevision" r ON r."contentId" = c.id AND r.revision = c.revision
	 JOIN "LibrarySource" s ON s.id = r."sourceId"
	 WHERE c.archived = ${query.archived === "true"}
	 AND EXISTS (SELECT 1 FROM "SceneAnalysisRevision" a WHERE a."sourceId" = s.id AND a.locale = c.locale)
	 ORDER BY c.locale`;
	return {
		locales: rows
			.map((row) => row.locale)
			.filter(
				(locale) =>
					sceneSearchQuery.shape.locale.safeParse(locale).success &&
					locale !== "",
			),
	};
}

/** Normalize both width variants and whitespace, without interpreting punctuation as query syntax. */
export function sceneSearchTerms(query: string): string[] {
	return [
		...new Set(
			query.normalize("NFKC").toLowerCase().split(/\s+/u).filter(Boolean),
		),
	];
}

const projection = z
	.object({
		contentId: z.uuid(),
		contentTitle: z.string(),
		contentRevision: z.number().int().positive(),
		archived: z.boolean(),
		locale: z.string().min(1).max(35),
		analysisRevisionId: z.uuid(),
		sceneId: z.uuid(),
		startInSeconds: z.number().finite().nonnegative(),
		endInSeconds: z.number().finite().positive(),
		duration: z.number().finite().positive(),
		title: z.string().max(1024),
		summary: z.string().max(512),
		coverage: z.number().int().positive(),
		weight: z.number().int().positive(),
		sourceId: z.uuid(),
		sourceJobId: z.uuid().nullable(),
		planHash: z.string().nullable(),
		playbackLinks: z.unknown(),
		fileOutputs: z.unknown(),
	})
	.refine(
		(row) =>
			row.endInSeconds > row.startInSeconds && row.endInSeconds <= row.duration,
	);

/** Literal term search of validated scene intervals, under the caller's tenant RLS. */
export async function searchLibraryScenes(
	prisma: AppPrismaClient,
	query: z.infer<typeof sceneSearchQuery>,
	organizationId: string,
): Promise<LibrarySceneResults> {
	const terms = sceneSearchTerms(query.q);
	if (!terms.length) return { items: [], total: 0 };
	const patterns = terms.map((term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`);
	const relevance = query.sort === "relevance";
	// Project analysis-wide JSON before scene expansion, and materialize scene
	// text once so coverage, weight and page selection reuse its normalization.
	const rows = await prisma.$queryRaw<{ total: number; items: unknown[] }[]>`
		WITH terms AS (SELECT value AS pattern FROM jsonb_array_elements_text(${JSON.stringify(patterns)}::jsonb)), candidates AS (
		 SELECT c.id AS "contentId", c.title AS "contentTitle", c.revision AS "contentRevision",
		 c.archived, c.locale, c."updatedAt", a.id AS "analysisRevisionId", entry.scene, entry.ordinal,
		 s.id AS "sourceId", s."jobId" AS "sourceJobId", s.snapshot->>'planHash' AS "planHash",
		 s.snapshot->'playbackLinks' AS "playbackLinks", s.snapshot->'fileOutputs' AS "fileOutputs",
		 a.duration,
		 CASE WHEN jsonb_typeof(entry.scene->'startInSeconds') = 'number' THEN (entry.scene->>'startInSeconds')::numeric END AS start,
		 CASE WHEN jsonb_typeof(entry.scene->'endInSeconds') = 'number' THEN (entry.scene->>'endInSeconds')::numeric END AS finish
		 FROM "Content" c
		 JOIN "ContentRevision" r ON r."contentId" = c.id AND r.revision = c.revision
		 JOIN "LibrarySource" s ON s.id = r."sourceId"
		 JOIN LATERAL (
		  SELECT id,
		  CASE WHEN jsonb_typeof(document->'duration') = 'number' THEN (document->>'duration')::numeric END AS duration,
		  CASE WHEN jsonb_typeof(document->'scenes') = 'array' THEN document->'scenes' ELSE '[]'::jsonb END AS scenes
		  FROM "SceneAnalysisRevision" WHERE "sourceId" = s.id AND locale = c.locale
		  ORDER BY "createdAt" DESC, id DESC LIMIT 1
		 ) a ON true
		 CROSS JOIN LATERAL jsonb_array_elements(a.scenes) WITH ORDINALITY AS entry(scene, ordinal)
		 WHERE c.archived = ${query.archived === "true"}
		 AND (${query.locale === ""} OR c.locale = ${query.locale})
		), valid AS (
		 SELECT * FROM candidates WHERE duration > 0 AND duration <= 1e308::numeric
		 AND start >= 0 AND finish > start AND finish <= duration
		 AND jsonb_typeof(scene->'id') = 'string'
		 AND scene->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		), fields AS MATERIALIZED (
		 SELECT valid.*,
		 normalize(CASE WHEN jsonb_typeof(scene->'title') = 'string' THEN scene->>'title' ELSE '' END, NFKC) AS title_text,
		 normalize(CASE WHEN jsonb_typeof(scene->'summary') = 'string' THEN scene->>'summary' ELSE '' END, NFKC) AS summary_text,
		 normalize(COALESCE((SELECT string_agg(part.value #>> '{}', ' ') FROM (
		   SELECT value FROM jsonb_path_query(scene, '$.keywords[*] ? (@.type() == "string")') AS fields(value)
		   UNION ALL SELECT value FROM jsonb_path_query(scene, '$.shots[*].keywords[*] ? (@.type() == "string")') AS fields(value)
		  ) part), ''), NFKC) AS keyword_text,
		 normalize(COALESCE((SELECT string_agg(value #>> '{}', ' ') FROM
		 jsonb_path_query(scene, '$.shots[*].detailedDescription ? (@.type() == "string")') AS descriptions(value)), ''), NFKC) AS shot_text
		 FROM valid
		), matching AS (
		 SELECT fields.*, scores.coverage, scores.weight FROM fields
		 CROSS JOIN LATERAL (
		  SELECT count(*) FILTER (WHERE score > 0) AS coverage, sum(score) AS weight FROM (
		   SELECT CASE WHEN title_text ILIKE pattern THEN 8 WHEN keyword_text ILIKE pattern THEN 5
		   WHEN summary_text ILIKE pattern THEN 3 WHEN shot_text ILIKE pattern THEN 1 ELSE 0 END AS score FROM terms
		  ) hits
		 ) scores
		 WHERE scores.coverage > 0 AND (${query.match === "any"} OR scores.coverage = ${terms.length})
		), page AS (
		 SELECT "contentId", "contentTitle", "contentRevision", archived, locale, "analysisRevisionId",
		 scene->>'id' AS "sceneId", start::double precision AS "startInSeconds", finish::double precision AS "endInSeconds",
		 duration::double precision AS duration,
		 left(CASE WHEN jsonb_typeof(scene->'title') = 'string' THEN scene->>'title' ELSE '' END, 1024) AS title,
		 left(CASE WHEN jsonb_typeof(scene->'summary') = 'string' THEN scene->>'summary' ELSE '' END, 512) AS summary,
		 "sourceId", "sourceJobId", "planHash", "playbackLinks", "fileOutputs", "updatedAt", ordinal, coverage, weight
		 FROM matching ORDER BY CASE WHEN ${relevance} THEN coverage END DESC,
		 CASE WHEN ${relevance} THEN weight END DESC, "updatedAt" DESC, "contentId", start, ordinal LIMIT 25 OFFSET ${query.offset}
		)
		SELECT (SELECT count(*)::int FROM matching) AS total,
		COALESCE((SELECT jsonb_agg(page ORDER BY CASE WHEN ${relevance} THEN coverage END DESC,
		 CASE WHEN ${relevance} THEN weight END DESC, "updatedAt" DESC, "contentId", "startInSeconds", ordinal) FROM page), '[]'::jsonb) AS items`;
	const result = rows[0] ?? { total: 0, items: [] };
	const selected = result.items.flatMap((item) => {
		const parsed = projection.safeParse(item);
		return parsed.success &&
			parsed.data.coverage <= terms.length &&
			parsed.data.weight >= parsed.data.coverage &&
			parsed.data.weight <= parsed.data.coverage * 8
			? [parsed.data]
			: [];
	});
	const sources = [
		...new Map(
			selected.map((row) => [
				row.sourceId,
				{
					sourceId: row.sourceId,
					jobId: row.sourceJobId,
					planHash: row.planHash ?? "",
					fileOutputs: librarySnapshotSchema.shape.fileOutputs.safeParse(
						row.fileOutputs,
					).data,
					playbackLinks:
						librarySnapshotSchema.shape.playbackLinks.safeParse(
							row.playbackLinks,
						).data ?? [],
				},
			]),
		).values(),
	];
	const playback = sources.length
		? await enrichLibraryPlayback(prisma, sources, organizationId)
		: [];
	const links = new Map(
		sources.map((source, index) => [
			source.sourceId,
			playback[index] ?? source.playbackLinks,
		]),
	);
	const items: LibrarySceneHit[] = selected.map((row) => {
		const preview = catalogPreview(links.get(row.sourceId), {
			duration: row.duration,
			sceneCount: 0,
			start: row.startInSeconds,
			end: row.endInSeconds,
		});
		const candidate =
			row.startInSeconds + (row.endInSeconds - row.startInSeconds) * 0.3;
		return {
			contentId: row.contentId,
			contentTitle: row.contentTitle,
			contentRevision: row.contentRevision,
			archived: row.archived,
			locale: row.locale,
			analysisRevisionId: row.analysisRevisionId,
			sceneId: row.sceneId,
			startInSeconds: row.startInSeconds,
			endInSeconds: row.endInSeconds,
			title: row.title,
			summary: row.summary,
			relevance: librarySceneRelevance(row.coverage, terms.length, row.weight),
			...(preview
				? {
						catalogPreview: {
							kind: preview.kind,
							url: preview.url,
							duration: row.duration,
							time:
								candidate < row.endInSeconds ? candidate : row.startInSeconds,
						},
					}
				: {}),
		};
	});
	return { items, total: result.total };
}
