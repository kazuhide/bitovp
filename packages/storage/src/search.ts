import type {
	ListObjectsResult,
	ObjectStorageBrowser,
	StorageObject,
} from "./types";

/**
 * Object-name search across a whole prefix. Object stores have no server-side
 * name query, so this is a recursive listing walk with the match applied here —
 * which makes it UNBOUNDED work on a customer bucket. Both caps below are
 * therefore hard, and the result always says whether the answer is complete.
 */

/** Underlying pages (≤100 objects each, C6) walked per request. */
export const SEARCH_MAX_PAGES = 25;
/**
 * Matches collected per request, checked at PAGE boundaries — never mid-page,
 * so `nextCursor` resumes at a page start and no object goes unexamined. A
 * request can therefore return up to this many + one page of matches.
 */
export const SEARCH_MAX_MATCHES = 100;

export type SearchObjectsInput = {
	bucket: string;
	/** Search scope: only keys below this prefix are examined. */
	prefix?: string;
	/** Case-insensitive substring of the object's file name. */
	search?: string;
	/** File-name extension, with or without the leading dot. */
	extension?: string;
	/** Resume token from a previous truncated scan. */
	cursor?: string;
	/** Underlying page size (clamped to 100 by the driver). */
	limit?: number;
	maxPages?: number;
	maxMatches?: number;
};

export type SearchScan = {
	/** Objects examined by THIS request (not since the first page). */
	scannedObjects: number;
	scannedPages: number;
	/** Stopped because the match cap filled. */
	matchLimitReached: boolean;
	/** Stopped because the page cap ran out. */
	scanLimitReached: boolean;
	/** The listing under `prefix` was walked to its end — nothing was missed. */
	complete: boolean;
};

export type SearchObjectsResult = ListObjectsResult & { scan: SearchScan };

/**
 * Matches the PREFIX-RELATIVE PATH — the exact string the table puts on screen
 * for a match (`object-table.tsx` renders `key` with the browsed prefix
 * stripped). Searched text and displayed text must be the same text: an
 * operator who sees `job/720p_1500000_uuid/qc/v1.mp4` and types `720p` has to
 * get that row, and matching only the basename (`v1.mp4`) returns nothing.
 *
 * Not the FULL key either. The browsed prefix is identical on every row, so
 * folding it in would let a search for an ancestor folder's own name match the
 * entire listing — under prefix `in/mp4/`, "mp4" would match everything.
 * Stripping the prefix keeps that guard while restoring the equivalence.
 *
 * The guard is therefore PREFIX-DEPENDENT, not absolute (review precision
 * note): at the bucket root the prefix is empty, so there is nothing to strip
 * and a search for `mp4` DOES match everything under any `mp4/` folder. That is
 * correct rather than a hole, because at root the table shows the full key too —
 * the invariant being preserved is "searched text == displayed text", not
 * "never match a folder name".
 *
 * The extension stays a property of the FILE NAME, so it is tested against the
 * basename: an `ext` box containing a slash must not match a folder suffix.
 *
 * PRECONDITION: `search` and `extension` must already be lower-cased — this
 * compares against a lower-cased key and does not fold them itself.
 * `searchObjects` does it before calling; a direct package consumer passing
 * `"TRAILER"` gets a silent zero-match (review catch).
 */
export function matchesObjectName(
	key: string,
	search: string,
	extension: string,
	prefix = "",
): boolean {
	const relative = (
		key.startsWith(prefix) ? key.slice(prefix.length) : key
	).toLowerCase();
	if (extension) {
		const name = relative.slice(relative.lastIndexOf("/") + 1);
		if (!name.endsWith(`.${extension}`)) {
			return false;
		}
	}
	return !search || relative.includes(search);
}

export async function searchObjects(
	browser: ObjectStorageBrowser,
	input: SearchObjectsInput,
): Promise<SearchObjectsResult> {
	const maxPages = Math.max(1, input.maxPages ?? SEARCH_MAX_PAGES);
	const maxMatches = Math.max(1, input.maxMatches ?? SEARCH_MAX_MATCHES);
	const search = (input.search ?? "").trim().toLowerCase();
	const extension = (input.extension ?? "")
		.trim()
		.replace(/^\./, "")
		.toLowerCase();

	const objects: StorageObject[] = [];
	let cursor = input.cursor;
	let scannedObjects = 0;
	let scannedPages = 0;
	let matchLimitReached = false;

	while (scannedPages < maxPages) {
		const page = await browser.listObjects({
			bucket: input.bucket,
			prefix: input.prefix,
			cursor,
			limit: input.limit,
			// Search spans the whole subtree, so no delimiter — folders come back
			// as the deep keys they contain, not as prefixes.
			recursive: true,
		});
		scannedPages += 1;
		scannedObjects += page.objects.length;
		for (const obj of page.objects) {
			if (matchesObjectName(obj.key, search, extension, input.prefix ?? "")) {
				objects.push(obj);
			}
		}
		cursor = page.nextCursor;
		// A page can be EMPTY and still carry a cursor (Azure returns fewer items
		// than maxPageSize whenever it feels like it, C23), so the cursor is the
		// only end-of-listing signal.
		if (!cursor) {
			// Normalized, not just tested: this predicate accepts "" while the
			// `scan` verdicts below and the UI's `nextCursor ?? null` do not, and a
			// "" reaching TanStack makes hasNextPage true while "Load more" re-sends
			// no cursor — page 1 refetched forever, duplicate React keys. One
			// assignment keeps all three predicates agreeing.
			cursor = undefined;
			break;
		}
		if (objects.length >= maxMatches) {
			matchLimitReached = true;
			break;
		}
	}

	return {
		prefixes: [],
		objects,
		nextCursor: cursor,
		scan: {
			scannedObjects,
			scannedPages,
			matchLimitReached,
			scanLimitReached: cursor !== undefined && !matchLimitReached,
			complete: cursor === undefined,
		},
	};
}
