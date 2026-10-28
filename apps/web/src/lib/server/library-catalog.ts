import "server-only";
import {
	type ContentView,
	isLibraryFileKind,
	librarySnapshotSchema,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { z } from "zod";
import {
	type LibraryCatalog,
	type LibraryCatalogItem,
	type LibraryPlaybackFilter,
	MAX_LIBRARY_OFFSET,
} from "@/lib/library-catalog";
import { isLibraryMediaUrl } from "@/lib/passive-request";
import {
	enrichLibraryPlayback,
	needsLibraryPlaybackProjection,
} from "./library-playback";

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
			kind: librarySnapshotSchema.shape.playbackLinks.element.shape.kind,
			url: z.string().nullable(),
			reason: z.unknown().optional(),
		}),
	)
	.max(100);

function playableCatalogLink(item: z.infer<typeof catalogLinksSchema>[number]) {
	if (!item.url || item.reason || item.kind === "SMOOTH") return false;
	if (isLibraryFileKind(item.kind) && isLibraryMediaUrl(item.url)) return true;
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
}

function catalogFormats(
	links: unknown,
): LibraryCatalogItem["catalogMetadata"]["formats"] {
	const parsed = catalogLinksSchema.safeParse(links);
	return [
		...new Set(
			(parsed.success ? parsed.data : []).flatMap((link) =>
				playableCatalogLink(link) && link.kind !== "SMOOTH" ? [link.kind] : [],
			),
		),
	];
}

export function catalogPreview(
	links: unknown,
	summary: unknown,
): ContentView["catalogPreview"] {
	const parsed = catalogLinksSchema.safeParse(links);
	const link = parsed.success
		? [...parsed.data]
				.sort((a, b) => {
					const rank = { HLS: 0, DASH: 1, MP4: 2, WEBM: 3, SMOOTH: 4 };
					return rank[a.kind] - rank[b.kind];
				})
				.find(playableCatalogLink)
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

type CatalogCandidate = {
	id: string;
	sourceId: string | null;
	sourceJobId: string | null;
	planHash: string | null;
	playbackLinks: unknown;
	fileOutputs: unknown;
};

type CatalogWindow = {
	cursorId: string;
	cursorUpdatedAt: Date;
	scanned: number;
	candidates: CatalogCandidate[];
};

function playbackSources(batch: readonly CatalogCandidate[]) {
	return batch.map((item) => ({
		sourceId: item.sourceId ?? "",
		jobId: item.sourceJobId,
		planHash: item.planHash ?? "",
		fileOutputs: librarySnapshotSchema.shape.fileOutputs.safeParse(
			item.fileOutputs,
		).data,
		playbackLinks:
			librarySnapshotSchema.shape.playbackLinks.safeParse(item.playbackLinks)
				.data ?? [],
	}));
}

/** Slim classification retains only page metadata and distinct eligible plan keys. */
export async function listContents(
	prisma: AppPrismaClient,
	query: Omit<z.infer<typeof listQuery>, "playback"> & {
		playback?: LibraryPlaybackFilter;
	},
	organizationId: string,
): Promise<LibraryCatalog> {
	const pattern = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
	return prisma.$transaction(
		async (tx) => {
			const counts = { all: 0, playback: 0, metadata: 0 };
			const selected = new Map<
				string,
				{
					links: unknown;
					formats: LibraryCatalogItem["catalogMetadata"]["formats"];
				}
			>();
			let total = 0;
			const batchSize = 250;
			async function* candidateBatches() {
				let cursor: { id: string; updatedAt: Date } | undefined;
				for (;;) {
					// Bound expensive search to scanned IDs, including windows with no matches.
					const [window] = await tx.$queryRaw<CatalogWindow[]>`
        WITH scanned AS MATERIALIZED (
          SELECT c.id, c."updatedAt", c.revision, c.title, c.description, c.tags, c.locale
          FROM "Content" c WHERE c.archived = ${query.archived === "true"}
          AND (${cursor === undefined} OR (c."updatedAt", c.id) < (${cursor?.updatedAt ?? new Date(0)}, ${cursor?.id ?? "00000000-0000-0000-0000-000000000000"}::uuid))
          ORDER BY c."updatedAt" DESC, c.id DESC LIMIT ${batchSize}
        ), matching AS (
          SELECT c.id, c."updatedAt", c.revision FROM scanned c
          WHERE (${query.q === ""} OR concat_ws(' ', c.title, c.description, array_to_string(c.tags, ' ')) ILIKE ${pattern}
            OR EXISTS (
              SELECT 1 FROM "ContentRevision" r JOIN LATERAL (
                SELECT a.document FROM "SceneAnalysisRevision" a WHERE a."sourceId" = r."sourceId" AND a.locale = c.locale
                ORDER BY a."createdAt" DESC, a.id DESC LIMIT 1
              ) a ON true WHERE r."contentId" = c.id AND r.revision = c.revision
              AND jsonb_path_query_array(a.document, '$.** ? (@.type() == "string")')::text ILIKE ${pattern}
            )
          )
        ), projected AS (
          SELECT matching.id, matching."updatedAt", s.id AS "sourceId", s."jobId" AS "sourceJobId",
            s.snapshot->>'planHash' AS "planHash", s.snapshot->'playbackLinks' AS "playbackLinks",
            s.snapshot->'fileOutputs' AS "fileOutputs"
          FROM matching LEFT JOIN "ContentRevision" r ON r."contentId" = matching.id AND r.revision = matching.revision
          LEFT JOIN "LibrarySource" s ON s.id = r."sourceId"
        )
        SELECT boundary.id AS "cursorId", boundary."updatedAt" AS "cursorUpdatedAt",
          (SELECT count(*)::int FROM scanned) AS scanned,
          COALESCE((SELECT jsonb_agg(projected ORDER BY "updatedAt" DESC, id DESC) FROM projected), '[]'::jsonb) AS candidates
        FROM scanned boundary ORDER BY boundary."updatedAt", boundary.id LIMIT 1`;
					if (!window) break;
					yield window.candidates;
					cursor = { id: window.cursorId, updatedAt: window.cursorUpdatedAt };
					if (window.scanned < batchSize) break;
				}
			}
			const eligiblePlans = new Map<string, Set<string>>();
			async function classify(
				batch: CatalogCandidate[],
				sources: ReturnType<typeof playbackSources>,
				projectionEligible: NonNullable<
					Parameters<typeof enrichLibraryPlayback>[3]
				>,
			) {
				const playback = await enrichLibraryPlayback(
					tx,
					sources,
					organizationId,
					projectionEligible,
				);
				for (const [index, item] of batch.entries()) {
					const links = playback[index]?.length
						? playback[index]
						: item.playbackLinks;
					const formats = catalogFormats(links);
					const available = formats.length > 0;
					counts.all++;
					counts[available ? "playback" : "metadata"]++;
					if (
						query.playback === "playback"
							? !available
							: query.playback === "metadata"
								? available
								: false
					)
						continue;
					if (total >= query.offset && selected.size < 25)
						selected.set(item.id, { links, formats });
					total++;
				}
			}
			let requiresProjection = false;
			for await (const batch of candidateBatches()) {
				const sources = playbackSources(batch);
				for (const source of sources) {
					if (!source.jobId || !needsLibraryPlaybackProjection(source))
						continue;
					let hashes = eligiblePlans.get(source.jobId);
					if (!hashes) {
						hashes = new Set();
						eligiblePlans.set(source.jobId, hashes);
					}
					hashes.add(source.planHash);
				}
				if (!eligiblePlans.size) {
					// Captured coordinates need no retained-plan queries.
					await classify(batch, sources, () => false);
				} else if (!requiresProjection) {
					// A later trigger can change earlier peers with the same job/hash.
					Object.assign(counts, { all: 0, playback: 0, metadata: 0 });
					total = 0;
					selected.clear();
					requiresProjection = true;
				}
			}
			if (requiresProjection) {
				for await (const batch of candidateBatches()) {
					await classify(batch, playbackSources(batch), (source) =>
						Boolean(
							source.jobId &&
								eligiblePlans.get(source.jobId)?.has(source.planHash),
						),
					);
				}
			}
			if (!selected.size) return { counts, total, items: [] };
			const ids = [...selected.keys()];
			const rows = await tx.$queryRaw<
				{ items: (ContentView & { analysisSummary: unknown })[] }[]
			>`
      WITH page AS (
        SELECT c.id, c.title, c.description, c.tags, c.locale, c.revision, c.archived, c."updatedAt", a.summary AS "analysisSummary"
        FROM "Content" c LEFT JOIN "ContentRevision" r ON r."contentId" = c.id AND r.revision = c.revision
        LEFT JOIN LATERAL (
          SELECT jsonb_build_object('duration', document->'duration', 'sceneCount', jsonb_array_length(document->'scenes'), 'start', document->'scenes'->0->'startInSeconds', 'end', document->'scenes'->0->'endInSeconds') AS summary
          FROM "SceneAnalysisRevision" WHERE "sourceId" = r."sourceId" AND locale = c.locale
          ORDER BY "createdAt" DESC, id DESC LIMIT 1
        ) a ON true
        WHERE c.id = ANY(${ids}::uuid[])
      )
      SELECT COALESCE(jsonb_agg(page ORDER BY "updatedAt" DESC, id DESC), '[]'::jsonb) AS items FROM page`;
			const items: LibraryCatalogItem[] = (rows[0]?.items ?? []).map(
				({ analysisSummary, ...item }) => {
					const playback = selected.get(item.id);
					const summary = catalogSummary.safeParse(analysisSummary);
					return {
						...item,
						catalogPreview: catalogPreview(playback?.links, analysisSummary),
						catalogMetadata: {
							formats: playback?.formats ?? [],
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
			return { counts, total, items };
		},
		{
			isolationLevel: "RepeatableRead",
			timeout: 30000,
			statementTimeoutMs: 5000,
		},
	);
}
