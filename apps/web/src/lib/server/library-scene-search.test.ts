import type { AppPrismaClient } from "@bitovp/db";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./library-playback", () => ({ enrichLibraryPlayback: vi.fn() }));

import { enrichLibraryPlayback } from "./library-playback";
import {
	sceneSearchQuery,
	sceneSearchTerms,
	searchLibraryScenes,
} from "./library-scene-search";

const contentId = "00000000-0000-4000-8000-000000000010";
const analysisRevisionId = "00000000-0000-4000-8000-000000000020";
const sourceId = "00000000-0000-4000-8000-000000000030";
const sceneId = "00000000-0000-4000-8000-000000000040";
const row = {
	contentId,
	contentTitle: "Nature",
	contentRevision: 2,
	archived: false,
	locale: "en",
	analysisRevisionId,
	sceneId,
	startInSeconds: 98.25,
	endInSeconds: 99.75,
	duration: 100,
	title: "Wildlife",
	summary: "A fox.",
	coverage: 1,
	weight: 3,
	sourceId,
	sourceJobId: null,
	planHash: "retained",
	fileOutputs: [],
	playbackLinks: [
		{
			key: "hls",
			kind: "HLS",
			label: "HLS",
			url: "https://media.test/a.m3u8",
			path: "a.m3u8",
			via: "derived",
		},
	],
};
function database(items: unknown[], total = items.length) {
	const db = { $queryRaw: vi.fn(async () => [{ items, total }]) };
	return { db, prisma: db as unknown as AppPrismaClient };
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(enrichLibraryPlayback).mockImplementation(
		async (_prisma, sources) => sources.map((source) => source.playbackLinks),
	);
});
it("bounds query inputs and avoids querying for an empty term", async () => {
	expect(sceneSearchQuery.parse({ q: "  fox  " })).toEqual({
		q: "fox",
		offset: 0,
		archived: "false",
		match: "all",
		sort: "relevance",
		locale: "",
	});
	for (const query of [
		{ q: "x".repeat(201) },
		{ offset: -1 },
		{ offset: 100001 },
		{ archived: "yes" },
		{ match: "fuzzy" },
		{ sort: "random" },
		{ locale: "../en" },
		{ locale: "x".repeat(36) },
	])
		expect(sceneSearchQuery.safeParse(query).success).toBe(false);
	const { db, prisma } = database([row]);
	expect(
		await searchLibraryScenes(prisma, sceneSearchQuery.parse({ q: " \t " })),
	).toEqual({ items: [], total: 0 });
	expect(db.$queryRaw).not.toHaveBeenCalled();
	expect(enrichLibraryPlayback).not.toHaveBeenCalled();
});
it("normalizes width/whitespace/case and does not interpret punctuation as operators", () => {
	expect(sceneSearchTerms("  ＦＯＸ　fox\tｶﾓﾒ カモメ \n50%_\\trail ")).toEqual([
		"fox",
		"カモメ",
		"50%_\\trail",
	]);
	expect(sceneSearchTerms("' OR 1=1 --")).toEqual(["'", "or", "1=1", "--"]);
});
it("returns only pinned scene context and keeps thumbnails inside a late matching scene", async () => {
	const { prisma } = database(
		[{ ...row, raw: "PRIVATE", credentialId: "PRIVATE" }],
		26,
	);
	const result = await searchLibraryScenes(
		prisma,
		sceneSearchQuery.parse({ q: "fox", offset: 25 }),
	);
	expect(result.total).toBe(26);
	expect(result.items[0]).toEqual({
		contentId,
		contentTitle: "Nature",
		contentRevision: 2,
		archived: false,
		locale: "en",
		analysisRevisionId,
		sceneId,
		startInSeconds: 98.25,
		endInSeconds: 99.75,
		title: "Wildlife",
		summary: "A fox.",
		relevance: { score: 70.6, matchedTerms: 1, totalTerms: 1 },
		catalogPreview: {
			kind: "HLS",
			url: "https://media.test/a.m3u8",
			time: 98.7,
			duration: 100,
		},
	});
	expect(JSON.stringify(result)).not.toMatch(
		/PRIVATE|sourceId|planHash|fileOutputs/,
	);
	expect(enrichLibraryPlayback).toHaveBeenCalledOnce();
});
it("deduplicates selected-page source enrichment and drops malformed scene coordinates", async () => {
	const { prisma } = database([
		row,
		{ ...row, sceneId: "00000000-0000-4000-8000-000000000041" },
		{ ...row, startInSeconds: -1 },
		{ ...row, endInSeconds: 101 },
		{ ...row, sceneId: "not-uuid" },
		{ ...row, coverage: 2 },
		{ ...row, weight: 9 },
	]);
	const result = await searchLibraryScenes(
		prisma,
		sceneSearchQuery.parse({ q: "fox" }),
	);
	expect(result.items).toHaveLength(2);
	expect(vi.mocked(enrichLibraryPlayback).mock.calls[0]?.[1]).toHaveLength(1);
});
it("calculates scores from unique query terms even in recent order", async () => {
	const { prisma } = database([{ ...row, coverage: 1, weight: 8 }]);
	const result = await searchLibraryScenes(
		prisma,
		sceneSearchQuery.parse({ q: "fox FOX kelp", match: "any", sort: "recent" }),
	);
	expect(result.items[0]?.relevance).toEqual({
		score: 50,
		matchedTerms: 1,
		totalTerms: 2,
	});
});
it("keeps metadata-only scene discoveries without claiming playback", async () => {
	const { prisma } = database([{ ...row, playbackLinks: [] }]);
	const result = await searchLibraryScenes(
		prisma,
		sceneSearchQuery.parse({ q: "fox" }),
	);
	expect(result.items[0]?.sceneId).toBe(sceneId);
	expect(result.items[0]?.catalogPreview).toBeUndefined();
});
