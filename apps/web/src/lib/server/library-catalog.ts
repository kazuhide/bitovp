import "server-only";
import { type ContentView, librarySnapshotSchema } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { z } from "zod";
import {
	type LibraryCatalog,
	type LibraryCatalogItem,
	type LibraryPlaybackFilter,
	MAX_LIBRARY_OFFSET,
} from "@/lib/library-catalog";
import { enrichLibraryPlayback } from "./library-playback";

export const listQuery = z.object({
	q: z.string().max(200).default(""),
	offset: z.coerce.number().int().min(0).max(MAX_LIBRARY_OFFSET).default(0),
	archived: z.enum(["true", "false"]).default("false"),
	playback: z.enum(["all", "playback", "metadata"]).default("all"),
});

const catalogSummary = z.object({
	duration: z.number().finite().positive(),
	sceneCount: z.number().int().min(0).max(5000),
});

const catalogLinksSchema = z
	.array(
		z.object({
			kind: z.enum(["HLS", "DASH", "SMOOTH", "MP4"]),
			url: z.string().nullable(),
			reason: z.unknown().optional(),
		}),
	)
	.max(100);

export function catalogPreview(
	links: unknown,
	summary: unknown,
): ContentView["catalogPreview"] {
	const parsed = catalogLinksSchema.safeParse(links);
	const link = parsed.success
		? [...parsed.data]
				.sort((a, b) => {
					const rank = { HLS: 0, DASH: 1, MP4: 2, SMOOTH: 3 };
					return rank[a.kind] - rank[b.kind];
				})
				.find((item) => {
					if (!item.url || item.reason || item.kind === "SMOOTH") return false;
					if (
						item.kind === "MP4" &&
						/^\/api\/library\/sources\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/media\?key=[A-Za-z0-9_.!~*'()%:-]+$/i.test(
							item.url,
						)
					)
						return true;
					try {
						const url = new URL(item.url);
						return (
							["https:", "http:"].includes(url.protocol) &&
							!url.username &&
							!url.password
						);
					} catch {
						return false;
					}
				})
		: undefined;
	if (!link?.url || link.kind === "SMOOTH") return undefined;
	const stats = z
		.object({
			duration: z.number().finite().positive(),
			sceneCount: z.number().int().min(0).max(5000),
			start: z.number().finite().nonnegative().nullable(),
			end: z.number().finite().nonnegative().nullable(),
		})
		.safeParse(summary);
	const data = stats.success ? stats.data : undefined;
	const candidate =
		data?.start != null && data.end != null && data.end > data.start
			? data.start + (data.end - data.start) * 0.3
			: 5;
	return {
		kind: link.kind,
		url: link.url,
		time: data ? Math.min(candidate, data.duration * 0.95) : candidate,
		...(data ? { duration: data.duration, sceneCount: data.sceneCount } : {}),
	};
}

/** Keyword search covers current metadata and the current source's latest selected-language analysis. */
export async function listContents(
	prisma: AppPrismaClient,
	query: Omit<z.infer<typeof listQuery>, "playback"> & {
		playback?: LibraryPlaybackFilter;
	},
): Promise<LibraryCatalog> {
	const pattern = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
	const rows = await prisma.$queryRaw<
		{
			total: number;
			items: (ContentView & {
				playbackLinks: unknown;
				analysisSummary: unknown;
				sourceJobId: string | null;
				sourceId: string | null;
				planHash: string | null;
				fileOutputs: unknown;
			})[];
		}[]
	>`
		WITH matching AS (
		 SELECT c.id, c.title, c.description, c.tags, c.locale, c.revision, c.archived, c."updatedAt"
		 FROM "Content" c WHERE c.archived = ${query.archived === "true"} AND (
		 ${query.q === ""} OR concat_ws(' ', c.title, c.description, array_to_string(c.tags, ' ')) ILIKE ${pattern}
		 OR EXISTS (
		  SELECT 1 FROM "ContentRevision" r JOIN LATERAL (
		   SELECT a.document FROM "SceneAnalysisRevision" a WHERE a."sourceId" = r."sourceId" AND a.locale = c.locale
		   ORDER BY a."createdAt" DESC, a.id DESC LIMIT 1
		  ) a ON true WHERE r."contentId" = c.id AND r.revision = c.revision
		  AND jsonb_path_query_array(a.document, '$.** ? (@.type() == "string")')::text ILIKE ${pattern}
		  )
		 )
		),
		projected AS (
		 SELECT matching.*, s.snapshot->'playbackLinks' AS "playbackLinks", a.summary AS "analysisSummary",
		 s.id AS "sourceId", s."jobId" AS "sourceJobId", s.snapshot->>'planHash' AS "planHash",
		 s.snapshot->'fileOutputs' AS "fileOutputs"
		 FROM matching LEFT JOIN "ContentRevision" r ON r."contentId" = matching.id AND r.revision = matching.revision
		 LEFT JOIN "LibrarySource" s ON s.id = r."sourceId"
		 LEFT JOIN LATERAL (
		  SELECT jsonb_build_object('duration', document->'duration', 'sceneCount', jsonb_array_length(document->'scenes'), 'start', document->'scenes'->0->'startInSeconds', 'end', document->'scenes'->0->'endInSeconds') AS summary
		  FROM "SceneAnalysisRevision" WHERE "sourceId" = s.id AND locale = matching.locale
		  ORDER BY "createdAt" DESC, id DESC LIMIT 1
		 ) a ON true
		)
		SELECT (SELECT count(*)::int FROM matching) AS total,
		COALESCE((SELECT jsonb_agg(projected ORDER BY "updatedAt" DESC, id DESC) FROM projected), '[]'::jsonb) AS items`;
	const result = rows[0] ?? { total: 0, items: [] };
	const playback = await enrichLibraryPlayback(
		prisma,
		result.items.map((item) => {
			const links = librarySnapshotSchema.shape.playbackLinks.safeParse(
				item.playbackLinks,
			);
			return {
				sourceId: item.sourceId ?? "",
				jobId: item.sourceJobId ?? null,
				planHash: item.planHash ?? "",
				fileOutputs: librarySnapshotSchema.shape.fileOutputs.safeParse(
					item.fileOutputs,
				).data,
				playbackLinks: links.success ? links.data : [],
			};
		}),
	);
	const items: LibraryCatalogItem[] = result.items.map(
		(
			{
				playbackLinks,
				analysisSummary,
				sourceJobId: _jobId,
				sourceId: _sourceId,
				planHash: _hash,
				fileOutputs: _files,
				...item
			},
			index,
		) => {
			const links = playback[index]?.length ? playback[index] : playbackLinks;
			const preview = catalogPreview(links, analysisSummary);
			const parsedLinks = catalogLinksSchema.safeParse(links);
			const formats = [
				...new Set(
					(parsedLinks.success ? parsedLinks.data : []).flatMap((link) => {
						const candidate = catalogPreview([link], null);
						return candidate ? [candidate.kind] : [];
					}),
				),
			];
			const summary = catalogSummary.safeParse(analysisSummary);
			return {
				...item,
				catalogPreview: preview,
				catalogMetadata: {
					formats,
					...(summary.success
						? {
								duration: summary.data.duration,
								sceneCount: summary.data.sceneCount,
							}
						: {}),
				},
			};
		},
	);
	const count = items.filter(
		(item) => item.catalogMetadata.formats.length > 0,
	).length;
	const counts = {
		all: items.length,
		playback: count,
		metadata: items.length - count,
	};
	const filtered = items.filter((item) =>
		query.playback === "playback"
			? item.catalogMetadata.formats.length > 0
			: query.playback === "metadata"
				? item.catalogMetadata.formats.length === 0
				: true,
	);
	return {
		counts,
		total: filtered.length,
		items: filtered.slice(query.offset, query.offset + 25),
	};
}
