import { describe, expect, it, vi } from "vitest";
import {
	matchesObjectName,
	SEARCH_MAX_MATCHES,
	SEARCH_MAX_PAGES,
	searchObjects,
} from "./search";
import type {
	ListObjectsInput,
	ListObjectsResult,
	ObjectStorageBrowser,
	StorageObject,
} from "./types";

function obj(key: string): StorageObject {
	return { key, size: 1 };
}

/** A browser whose listObjects replays canned pages and records its inputs. */
function fakeBrowser(pages: ListObjectsResult[]) {
	const calls: ListObjectsInput[] = [];
	let index = 0;
	const listObjects = vi.fn(async (input: ListObjectsInput) => {
		calls.push(input);
		return pages[index++] ?? { prefixes: [], objects: [] };
	});
	const browser: ObjectStorageBrowser = {
		listBuckets: async () => [],
		listObjects,
	};
	return { browser, calls, listObjects };
}

/** N pages of `perPage` objects each, all cursored except the last. */
function pagesOf(
	count: number,
	perPage: number,
	name = "clip",
): ListObjectsResult[] {
	return Array.from({ length: count }, (_, page) => ({
		prefixes: [],
		objects: Array.from({ length: perPage }, (_, i) =>
			obj(`in/p${page}/${name}${i}.mp4`),
		),
		nextCursor: page === count - 1 ? undefined : `cursor-${page + 1}`,
	}));
}

describe("matchesObjectName", () => {
	it("matches case-insensitively", () => {
		expect(matchesObjectName("in/MP4/Trailer.MOV", "trailer", "", "in/")).toBe(
			true,
		);
	});

	it("matches the PREFIX-RELATIVE PATH — the string the table displays", () => {
		// The row renders as `720p_1500000_uuid/qc/v1.mp4`, so typing what is on
		// screen has to hit. Basename matching (`v1.mp4`) returned nothing.
		const key = "out/job/720p_1500000_uuid/qc/v1.mp4";
		expect(matchesObjectName(key, "720p", "", "out/job/")).toBe(true);
		expect(matchesObjectName(key, "qc/", "", "out/job/")).toBe(true);
		expect(matchesObjectName(key, "v1", "", "out/job/")).toBe(true);
	});

	it("excludes the browsed prefix, so its own name cannot match every row", () => {
		// Matching the FULL key would make "mp4" match everything under `in/mp4/`
		// — a filter that selects the whole listing is no filter.
		expect(matchesObjectName("in/mp4/trailer.mov", "mp4", "", "in/mp4/")).toBe(
			false,
		);
		expect(matchesObjectName("in/mp4/trailer.mov", "in/", "", "in/mp4/")).toBe(
			false,
		);
		// A folder BELOW the browsed prefix is displayed, so it does match.
		expect(matchesObjectName("in/mp4/trailer.mov", "mp4", "", "in/")).toBe(
			true,
		);
	});

	it("falls back to the full key when it does not sit under the prefix", () => {
		expect(matchesObjectName("other/trailer.mov", "trailer", "", "in/")).toBe(
			true,
		);
	});

	it("filters by extension on the file name, not the path", () => {
		expect(matchesObjectName("in/a.MP4", "", "mp4", "in/")).toBe(true);
		expect(matchesObjectName("in/a.mp4.bak", "", "mp4", "in/")).toBe(false);
		expect(matchesObjectName("in/mp4/", "", "mp4", "in/")).toBe(false);
		// The extension is a FILE-NAME property: a slash-bearing ext box must not
		// match a folder suffix.
		expect(matchesObjectName("in/x.a/b.mov", "", "a/b", "in/")).toBe(false);
	});

	it("ANDs name and extension", () => {
		expect(matchesObjectName("in/trailer.mp4", "trail", "mp4", "in/")).toBe(
			true,
		);
		expect(matchesObjectName("in/trailer.mov", "trail", "mp4", "in/")).toBe(
			false,
		);
	});
});

describe("searchObjects", () => {
	it("walks recursively across pages and returns only the matches", async () => {
		const { browser, calls } = fakeBrowser([
			{
				prefixes: ["ignored/"],
				objects: [obj("in/a/trailer.mp4"), obj("in/a/other.mov")],
				nextCursor: "c1",
			},
			{
				prefixes: [],
				objects: [obj("in/b/deep/trailer-2.mp4"), obj("in/b/notes.txt")],
			},
		]);
		const result = await searchObjects(browser, {
			bucket: "media",
			prefix: "in/",
			search: "TRAILER",
			limit: 100,
		});

		expect(calls[0]).toEqual({
			bucket: "media",
			prefix: "in/",
			cursor: undefined,
			limit: 100,
			recursive: true,
		});
		expect(calls[1]?.cursor).toBe("c1");
		expect(result.objects.map((o) => o.key)).toEqual([
			"in/a/trailer.mp4",
			"in/b/deep/trailer-2.mp4",
		]);
		// Recursive listings have no folders, and a search answer is a flat list.
		expect(result.prefixes).toEqual([]);
		expect(result.nextCursor).toBeUndefined();
		expect(result.scan).toEqual({
			scannedObjects: 4,
			scannedPages: 2,
			matchLimitReached: false,
			scanLimitReached: false,
			complete: true,
		});
	});

	it("finds a match by the FOLDER segment the table shows, not just its name", async () => {
		// The regression this pins: an operator sees the prefix-relative path and
		// searches a piece of it. Under `out/job/`, "720p" is a folder segment —
		// basename matching answered "nothing here".
		const { browser } = fakeBrowser([
			{
				prefixes: [],
				objects: [
					obj("out/job/720p_1500000_uuid/qc/v1.mp4"),
					obj("out/job/360p_500000_uuid/qc/v1.mp4"),
				],
			},
		]);
		const result = await searchObjects(browser, {
			bucket: "b",
			prefix: "out/job/",
			search: "720p",
		});
		expect(result.objects.map((o) => o.key)).toEqual([
			"out/job/720p_1500000_uuid/qc/v1.mp4",
		]);
	});

	it("does not let the browsed prefix itself match every object", async () => {
		const { browser } = fakeBrowser([
			{
				prefixes: [],
				objects: [obj("in/mp4/a.mov"), obj("in/mp4/b.mov")],
			},
		]);
		const result = await searchObjects(browser, {
			bucket: "b",
			prefix: "in/mp4/",
			search: "mp4",
		});
		expect(result.objects).toEqual([]);
	});

	it("supports an extension-only search", async () => {
		const { browser } = fakeBrowser([
			{
				prefixes: [],
				objects: [obj("in/a.mp4"), obj("in/b.mov"), obj("in/c.MP4")],
			},
		]);
		const result = await searchObjects(browser, {
			bucket: "b",
			extension: ".MP4",
		});
		expect(result.objects.map((o) => o.key)).toEqual(["in/a.mp4", "in/c.MP4"]);
		expect(result.scan.complete).toBe(true);
	});

	it("keeps paging through an EMPTY page that still carries a cursor (C23)", async () => {
		const { browser, listObjects } = fakeBrowser([
			{ prefixes: [], objects: [], nextCursor: "c1" },
			{ prefixes: [], objects: [obj("in/late.mp4")] },
		]);
		const result = await searchObjects(browser, {
			bucket: "b",
			search: "late",
		});
		expect(listObjects).toHaveBeenCalledTimes(2);
		expect(result.objects.map((o) => o.key)).toEqual(["in/late.mp4"]);
		expect(result.scan.complete).toBe(true);
	});

	it("NORMALIZES an empty terminating cursor away instead of forwarding it", async () => {
		// A driver that leaked Azure's empty-string end-of-listing token (or any
		// future one that does) must not turn into `nextCursor: ""` on the wire:
		// the scan verdicts here use `=== undefined` and the UI uses `?? null`, so
		// a "" would report an incomplete scan AND make "Load more" refetch page 1
		// forever.
		const { browser, listObjects } = fakeBrowser([
			{ prefixes: [], objects: [obj("in/a.mp4")], nextCursor: "" },
		]);
		const result = await searchObjects(browser, { bucket: "b", search: "a" });
		expect(listObjects).toHaveBeenCalledTimes(1);
		expect(result.nextCursor).toBeUndefined();
		expect(result.scan).toMatchObject({
			scanLimitReached: false,
			complete: true,
		});
	});

	it("stops at the page cap and reports the scan as incomplete", async () => {
		// Every page is cursored and holds no match: the walk must not run away.
		const pages = Array.from({ length: SEARCH_MAX_PAGES + 5 }, (_, i) => ({
			prefixes: [],
			objects: [obj(`in/${i}/nope.mov`)],
			nextCursor: `cursor-${i + 1}`,
		}));
		const { browser, listObjects } = fakeBrowser(pages);
		const result = await searchObjects(browser, { bucket: "b", search: "mp4" });

		expect(listObjects).toHaveBeenCalledTimes(SEARCH_MAX_PAGES);
		expect(result.objects).toEqual([]);
		expect(result.scan).toMatchObject({
			scannedPages: SEARCH_MAX_PAGES,
			scannedObjects: SEARCH_MAX_PAGES,
			scanLimitReached: true,
			matchLimitReached: false,
			complete: false,
		});
		// The caller can resume exactly where the scan stopped.
		expect(result.nextCursor).toBe(`cursor-${SEARCH_MAX_PAGES}`);
	});

	it("stops at the match cap on a page boundary so no object is skipped", async () => {
		const { browser, listObjects } = fakeBrowser(pagesOf(4, 60));
		const result = await searchObjects(browser, {
			bucket: "b",
			search: "clip",
		});

		// 60 matches on page 1 is under the cap; page 2 pushes it to 120 ⇒ stop.
		expect(listObjects).toHaveBeenCalledTimes(2);
		expect(result.objects).toHaveLength(120);
		expect(result.objects.length).toBeGreaterThan(SEARCH_MAX_MATCHES);
		expect(result.scan).toMatchObject({
			scannedPages: 2,
			scannedObjects: 120,
			matchLimitReached: true,
			scanLimitReached: false,
			complete: false,
		});
		// Resuming from a page START is what makes the mid-page overflow safe.
		expect(result.nextCursor).toBe("cursor-2");
	});

	it("resumes from a cursor and honors caller-supplied caps", async () => {
		const { browser, calls } = fakeBrowser(pagesOf(3, 2));
		const result = await searchObjects(browser, {
			bucket: "b",
			search: "clip",
			cursor: "cursor-9",
			maxPages: 1,
		});
		expect(calls[0]?.cursor).toBe("cursor-9");
		expect(calls).toHaveLength(1);
		expect(result.scan).toMatchObject({
			scannedPages: 1,
			scanLimitReached: true,
			complete: false,
		});
	});

	it("reports complete when the listing ends inside the caps", async () => {
		const { browser } = fakeBrowser(pagesOf(1, 3));
		const result = await searchObjects(browser, {
			bucket: "b",
			search: "clip",
		});
		expect(result.scan.complete).toBe(true);
		expect(result.nextCursor).toBeUndefined();
	});
});
