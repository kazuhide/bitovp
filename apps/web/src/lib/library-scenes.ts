import type { ContentView } from "@bitovp/core";
import { z } from "zod";

export type LibrarySceneSelection = {
	contentRevision: number;
	analysisRevisionId: string;
	sceneId: string;
	locale: string;
	archived: boolean;
};

export type LibrarySceneHit = LibrarySceneSelection & {
	contentId: string;
	contentTitle: string;
	startInSeconds: number;
	endInSeconds: number;
	title: string;
	summary: string;
	relevance?: { score: number; matchedTerms: number; totalTerms: number };
	catalogPreview?: ContentView["catalogPreview"];
};

/** Query-relative display score; preserves coverage before per-field weight. */
export function librarySceneRelevance(
	matchedTerms: number,
	totalTerms: number,
	weight: number,
) {
	const coverageUnit = 8 * totalTerms + 1;
	const numerator = matchedTerms * coverageUnit + weight;
	const denominator = totalTerms * coverageUnit + 8 * totalTerms;
	return {
		score: Math.round((1000 * numerator) / denominator) / 10,
		matchedTerms,
		totalTerms,
	};
}

export type LibrarySceneResults = {
	items: LibrarySceneHit[];
	total: number;
};

const selectionSchema = z.object({
	contentRevision: z.coerce.number().int().positive().max(2147483647),
	analysisRevisionId: z.string().uuid(),
	sceneId: z.string().uuid(),
	locale: z.string().min(1).max(35),
	archived: z.enum(["true", "false"]),
});

export function readLibrarySceneSelection(
	params: Record<string, string | string[] | undefined>,
): LibrarySceneSelection | undefined {
	const parsed = selectionSchema.safeParse(params);
	return parsed.success
		? { ...parsed.data, archived: parsed.data.archived === "true" }
		: undefined;
}

export function librarySceneHref(hit: LibrarySceneHit): string {
	const params = new URLSearchParams({
		contentRevision: String(hit.contentRevision),
		analysisRevisionId: hit.analysisRevisionId,
		sceneId: hit.sceneId,
		locale: hit.locale,
		archived: String(hit.archived),
	});
	return `/library/${encodeURIComponent(hit.contentId)}?${params}`;
}
