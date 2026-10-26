import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { LiveCaptureTarget } from "@bitovp/core";
import type { ObjectStorageBrowser, StorageObject } from "@bitovp/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCredential } from "../orchestrator/executor";
import {
	type CaptureDeps,
	captureRenditionWindow,
	listAllUnderPrefix,
	segmentNamePattern,
	selectWindowSegments,
} from "./live-capture";

const FMP4_TARGET: LiveCaptureTarget = {
	renditionKey: "v1080",
	codec: "H264",
	height: 1080,
	bitrate: 4500000,
	outputKey: "origin",
	segmentPrefix: "output/live/video/1080p",
	kind: "FMP4",
	initSegmentName: "init.mp4",
	segmentNaming: "segment_%number%.m4s",
	segmentLengthSec: 6,
};

const TS_TARGET: LiveCaptureTarget = {
	renditionKey: "v720ts",
	codec: "H264",
	height: 720,
	bitrate: 3000000,
	outputKey: "origin",
	segmentPrefix: "output/live/video/720p-ts",
	kind: "TS",
	segmentNaming: "seg_%number%.ts",
	segmentLengthSec: 6,
};

function obj(key: string, lastModified?: string): StorageObject {
	return { key, size: 1000, ...(lastModified ? { lastModified } : {}) };
}

describe("segmentNamePattern", () => {
	it("matches a %number% template and captures the sequence", () => {
		const re = segmentNamePattern("segment_%number%.m4s");
		expect(re.exec("segment_42.m4s")?.[1]).toBe("42");
		expect(re.exec("init.mp4")).toBeNull();
		expect(re.exec("segment_42.ts")).toBeNull();
	});

	it("escapes literal regex chars in the template", () => {
		const re = segmentNamePattern("v.seg+%number%.ts");
		expect(re.exec("v.seg+7.ts")?.[1]).toBe("7");
		expect(re.exec("vXseg+7Xts")).toBeNull();
	});
	it("matches CMAF random name tokens without stealing the segment-number capture", () => {
		const pattern = segmentNamePattern("seg_{rand_chars:8}_%number%.m4s");
		expect(pattern.exec("seg_Ab12Cd34_17.m4s")?.[1]).toBe("17");
		expect(pattern.test("seg_{rand_chars:8}_17.m4s")).toBe(false);
	});
});

describe("selectWindowSegments", () => {
	const base = Date.parse("2026-06-18T12:00:00.000Z");
	it.each([
		"mp4",
		"cmfv",
		"cmfa",
	])("selects configured .%s fragments independently of the default .m4s extension", (extension) => {
		const target = {
			...FMP4_TARGET,
			segmentNaming: `part_{rand_chars:8}_%number%.${extension}`,
		};
		const objects = [
			obj(`${target.segmentPrefix}/part_Ab12Cd34_17.${extension}`),
			obj(`${target.segmentPrefix}/part_Ab12Cd34_18.${extension}`),
			obj(`${target.segmentPrefix}/part_Ab12Cd34_19.m4s`),
			obj(`${target.segmentPrefix}/init.mp4`),
		];
		const selected = selectWindowSegments(objects, target, {
			now: base,
			windowSeconds: 60,
			fallbackCount: 2,
		});
		expect(selected.segments.map((segment) => segment.number)).toEqual([
			17, 18,
		]);
	});
	it("keeps only segments within the window by lastModified, ordered by number", () => {
		const objects = [
			obj("output/live/video/1080p/segment_1.m4s", "2026-06-18T11:50:00.000Z"), // old
			obj("output/live/video/1080p/segment_2.m4s", "2026-06-18T11:59:30.000Z"), // in
			obj("output/live/video/1080p/segment_3.m4s", "2026-06-18T11:59:50.000Z"), // in
			obj("output/live/video/1080p/init.mp4", "2026-06-18T11:50:00.000Z"), // not a segment
		];
		const sel = selectWindowSegments(objects, FMP4_TARGET, {
			windowSeconds: 60,
			now: base,
			fallbackCount: 10,
		});
		expect(sel.segments.map((s) => s.number)).toEqual([2, 3]);
		expect(sel.selection).toEqual({
			mode: "window",
			from: "2026-06-18T11:59:00.000Z",
			to: "2026-06-18T12:00:00.000Z",
			contiguous: true,
			segmentCount: 2,
			droppedForGap: 0,
			droppedAfterNow: 0,
		});
	});

	it("orders segments numerically, not lexically (10 sorts after 2)", () => {
		// A lexical string sort would order segment_10 before segment_2 and
		// concat frames out of order — capture must sort by parsed number.
		const objects = [2, 10, 1, 11].map((n) =>
			obj(`output/live/video/1080p/segment_${n}.m4s`),
		);
		const sel = selectWindowSegments(objects, FMP4_TARGET, {
			windowSeconds: 60,
			now: base,
			fallbackCount: 10,
		});
		expect(sel.segments.map((s) => s.number)).toEqual([1, 2, 10, 11]);
		expect(sel.selection.mode).toBe("tail-no-mtimes");
		// 2→10 is a gap: the fallback tail is reported as non-contiguous
		expect(sel.selection.contiguous).toBe(false);
	});

	it("falls back to the last N segments when storage has no mtimes", () => {
		const objects = [1, 2, 3, 4, 5].map((n) =>
			obj(`output/live/video/1080p/segment_${n}.m4s`),
		);
		const sel = selectWindowSegments(objects, FMP4_TARGET, {
			windowSeconds: 60,
			now: base,
			fallbackCount: 2,
		});
		expect(sel.segments.map((s) => s.number)).toEqual([4, 5]);
		expect(sel.selection).toEqual({
			mode: "tail-no-mtimes",
			contiguous: true,
			segmentCount: 2,
			droppedForGap: 0,
			droppedAfterNow: 0,
		});
	});

	it("falls back to the tail when the window catches nothing (clock skew)", () => {
		const objects = [1, 2, 3].map((n) =>
			obj(
				`output/live/video/1080p/segment_${n}.m4s`,
				"2026-06-18T10:00:00.000Z", // all far older than the window
			),
		);
		const sel = selectWindowSegments(objects, FMP4_TARGET, {
			windowSeconds: 60,
			now: base,
			fallbackCount: 2,
		});
		expect(sel.segments.map((s) => s.number)).toEqual([2, 3]);
		expect(sel.selection.mode).toBe("tail-empty-window");
	});

	it("row #256: the window has an upper bound — an object written after the sealed now is not in it", () => {
		const objects = [
			obj("output/live/video/1080p/segment_2.m4s", "2026-06-18T11:59:30.000Z"),
			obj("output/live/video/1080p/segment_3.m4s", "2026-06-18T11:59:50.000Z"),
			obj("output/live/video/1080p/segment_4.m4s", "2026-06-18T12:00:04.000Z"), // after now
		];
		const sel = selectWindowSegments(objects, FMP4_TARGET, {
			windowSeconds: 60,
			now: base,
			fallbackCount: 10,
		});
		expect(sel.segments.map((s) => s.number)).toEqual([2, 3]);
		expect(sel.selection.mode).toBe("window");
	});

	it("row #256: only the newest CONTIGUOUS run is kept — a missing segment before it is a gap, not a splice", () => {
		const objects = [2, 3, 5, 6].map((n) =>
			obj(
				`output/live/video/1080p/segment_${n}.m4s`,
				"2026-06-18T11:59:40.000Z",
			),
		);
		const sel = selectWindowSegments(objects, FMP4_TARGET, {
			windowSeconds: 60,
			now: base,
			fallbackCount: 10,
		});
		expect(sel.segments.map((s) => s.number)).toEqual([5, 6]);
		expect(sel.selection).toMatchObject({
			mode: "window",
			contiguous: true,
			segmentCount: 2,
			droppedForGap: 2,
			droppedAfterNow: 0,
		});
	});

	it("rev428 O4: a segment whose mtime is AFTER the sealed now is left out and COUNTED — a storage clock ahead of the worker is visible", () => {
		const objects = [
			obj("output/live/video/1080p/segment_7.m4s", "2026-06-18T11:59:40.000Z"),
			obj("output/live/video/1080p/segment_8.m4s", "2026-06-18T11:59:50.000Z"),
			// 30 s after `now`: the store's clock runs ahead
			obj("output/live/video/1080p/segment_9.m4s", "2026-06-18T12:00:30.000Z"),
		];
		const sel = selectWindowSegments(objects, FMP4_TARGET, {
			windowSeconds: 60,
			now: base,
			fallbackCount: 10,
		});
		expect(sel.segments.map((s) => s.number)).toEqual([7, 8]);
		expect(sel.selection).toMatchObject({
			mode: "window",
			segmentCount: 2,
			droppedForGap: 0,
			droppedAfterNow: 1,
		});
	});
});

/** A fake browser whose list pages are scripted and getObject yields canned bytes. */
function fakeBrowser(opts: {
	pages: { objects: StorageObject[]; nextCursor?: string }[];
	bytesFor?: (key: string) => string;
}): { browser: ObjectStorageBrowser; gets: string[] } {
	const gets: string[] = [];
	let pageIdx = 0;
	const browser: ObjectStorageBrowser = {
		listBuckets: vi.fn(async () => ["b"]),
		listObjects: vi.fn(async () => {
			const page = opts.pages[pageIdx] ?? { objects: [] };
			pageIdx += 1;
			return {
				prefixes: [],
				objects: page.objects,
				...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
			};
		}),
		getObject: vi.fn(async ({ key }: { key: string }) => {
			gets.push(key);
			const body = opts.bytesFor ? opts.bytesFor(key) : `bytes:${key}`;
			return Readable.from([Buffer.from(body)]);
		}),
		dispose: vi.fn(),
	};
	return { browser, gets };
}

let workDir: string;
beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "cap-test-"));
});
afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

/**
 * A browser that honours `prefix` + delimiter the way S3 and Azure actually do
 * — .
 *
 * The fake below it ignores its input entirely and replays canned pages, so it
 * could not see that `listAllUnderPrefix` never asked for recursion: both real
 * drivers apply a "/" delimiter unless `recursive` is set, and the real
 * `segmentPrefix` has no trailing slash, so every `<prefix>/seg-N.ts` collapsed
 * into a CommonPrefix and the capture found ZERO segments. The fake's own
 * prefix ("a/") carried a trailing slash the real caller never has, which hid
 * it a second way.
 *
 * This double answers the question the other one cannot: what comes back from
 * something that reads the arguments.
 */
function delimiterFaithfulBrowser(keys: string[]) {
	const calls: { prefix?: string; recursive?: boolean }[] = [];
	return {
		calls,
		browser: {
			// `Promise<string[]>` per the real contract. The first cut returned
			// `{buckets: []}` — never called, so nothing caught it, but a lie
			// inside the fixture whose entire reason to exist is fidelity to
			// that contract is the wrong place to keep one (review catch).
			async listBuckets(): Promise<string[]> {
				return [];
			},
			async listObjects(input: { prefix?: string; recursive?: boolean }) {
				calls.push(input);
				const p = input.prefix ?? "";
				const under = keys.filter((k) => k.startsWith(p));
				if (input.recursive) {
					return {
						prefixes: [],
						objects: under.map((k) => ({ key: k, size: 1 })),
					};
				}
				return {
					prefixes: [
						...new Set(
							under
								.filter((k) => k.slice(p.length).includes("/"))
								.map((k) => `${p}${k.slice(p.length).split("/")[0]}/`),
						),
					],
					objects: under
						.filter((k) => !k.slice(p.length).includes("/"))
						.map((k) => ({ key: k, size: 1 })),
				};
			},
		} as unknown as ObjectStorageBrowser,
	};
}

describe("listAllUnderPrefix against a browser that reads its arguments", () => {
	// The real shape: destination path verbatim, no trailing slash, segments one
	// level under it.
	const KEYS = [
		"output/live/video/1080p/seg-0.ts",
		"output/live/video/1080p/seg-1.ts",
	];
	/**
	 * A SIBLING rung whose prefix starts with the one we ask for. Without the
	 * directory scoping these come back too, and `selectWindowSegments` cannot
	 * tell them apart — a ladder shares one `segmentNaming` template — so two
	 * renditions interleave into one clip and are scored as one number.
	 */
	const SIBLING = [
		"output/live/video/1080p_hi/seg-0.ts",
		"output/live/video/1080p_hi/seg-1.ts",
	];

	it("asks for recursion, and therefore finds the segments", async () => {
		const { browser, calls } = delimiterFaithfulBrowser([...KEYS, ...SIBLING]);
		const found = await listAllUnderPrefix(
			browser,
			"b",
			"output/live/video/1080p",
		);
		// The OUTCOME an operator cares about: this rendition's segments were
		// found, and the sibling rung's were NOT swept in with them.
		expect(found.map((o) => o.key)).toEqual(KEYS);
		// Asked at a directory boundary, so a string-prefix sibling cannot bleed
		// in. Dropping the trailing slash returns four objects here, and the
		// clip would be scored across two renditions with no error raised.
		expect(calls[0]?.prefix).toBe("output/live/video/1080p/");
		// And the mechanism, because dropping the flag is silent otherwise:
		// without it this same double returns zero objects and two prefixes.
		expect(calls[0]?.recursive).toBe(true);
	});

	/**
	 * An EMPTY prefix stays empty. `destinationSchema.path` has no `min(1)`, so
	 * "" is reachable; "" means the whole container, and turning it into "/"
	 * would scope to a root directory that does not exist — a listing that
	 * returns nothing while looking like it asked a sensible question.
	 */
	it("leaves an empty prefix alone rather than making it a root directory", async () => {
		const { browser, calls } = delimiterFaithfulBrowser(KEYS);
		const found = await listAllUnderPrefix(browser, "b", "");
		expect(calls[0]?.prefix).toBe("");
		expect(found).toHaveLength(KEYS.length);
	});
});

describe("listAllUnderPrefix", () => {
	it("paginates with the cursor and concatenates every page", async () => {
		const { browser } = fakeBrowser({
			pages: [
				{ objects: [obj("a/1")], nextCursor: "c1" },
				{ objects: [obj("a/2")], nextCursor: "c2" },
				{ objects: [obj("a/3")] },
			],
		});
		const all = await listAllUnderPrefix(browser, "b", "a/");
		expect(all.map((o) => o.key)).toEqual(["a/1", "a/2", "a/3"]);
		expect(browser.listObjects).toHaveBeenCalledTimes(3);
	});
});

const credential: ResolvedCredential = {
	provider: "AWS_S3",
	config: { region: "us-east-1" },
	secret: { accessKeyId: "ak", secretAccessKey: "sk" },
};

function captureDeps(browser: ObjectStorageBrowser): CaptureDeps {
	return {
		resolveCredential: vi.fn(async () => credential),
		makeBrowser: () => browser,
	};
}

describe("captureRenditionWindow (fMP4)", () => {
	it.each([
		false,
		true,
	])("resolves CMAF init templates and fails on ambiguous candidates (%s)", async (ambiguous) => {
		const dir = FMP4_TARGET.segmentPrefix;
		const { browser, gets } = fakeBrowser({
			pages: [
				{
					objects: [
						obj(`${dir}/init-Ab12Cd34.mp4`),
						obj(`${dir}/segment_1.m4s`),
						...(ambiguous ? [obj(`${dir}/init-Ef56Gh78.mp4`)] : []),
					],
				},
			],
			bytesFor: (key) => (key.includes("init-") ? "INIT" : "MEDIA"),
		});
		const pending = captureRenditionWindow({
			deps: captureDeps(browser),
			credential,
			bucket: "b",
			target: {
				...FMP4_TARGET,
				initSegmentName: undefined,
				initSegmentNameTemplate: "init-{rand_chars:8}.mp4",
			},
			jobDir: workDir,
			windowSeconds: 120,
			now: Date.now(),
			fallbackCount: 10,
		});
		if (ambiguous) {
			await expect(pending).rejects.toThrow(/exactly one match; found 2/);
			expect(gets).toEqual([]);
		} else {
			const clip = await pending;
			expect(clip.container).toBe("FMP4");
			expect(readFileSync(clip.clipPath, "utf8")).toBe("INITMEDIA");
			expect(gets[0]).toBe(`${dir}/init-Ab12Cd34.mp4`);
		}
	});
	it("downloads init + ordered media segments and byte-concatenates them into one clip", async () => {
		const { browser, gets } = fakeBrowser({
			pages: [
				{
					objects: [
						obj("output/live/video/1080p/init.mp4", "2026-06-18T11:59:00.000Z"),
						obj(
							"output/live/video/1080p/segment_1.m4s",
							"2026-06-18T11:59:40.000Z",
						),
						obj(
							"output/live/video/1080p/segment_2.m4s",
							"2026-06-18T11:59:50.000Z",
						),
					],
				},
			],
			bytesFor: (key) =>
				key.endsWith("init.mp4")
					? "INIT"
					: key.endsWith("segment_1.m4s")
						? "SEG1"
						: "SEG2",
		});
		const clip = await captureRenditionWindow({
			deps: captureDeps(browser),
			credential,
			bucket: "b",
			target: FMP4_TARGET,
			jobDir: workDir,
			windowSeconds: 120,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
			fallbackCount: 10,
		});
		expect(clip.segmentCount).toBe(2);
		expect(clip.container).toBe("FMP4");
		expect(clip.clipPath.endsWith(".mp4")).toBe(true);
		// Init downloaded first, then segments in order.
		expect(gets).toEqual([
			"output/live/video/1080p/init.mp4",
			"output/live/video/1080p/segment_1.m4s",
			"output/live/video/1080p/segment_2.m4s",
		]);
		// ONE clip: init bytes, then each fragment's bytes, in order — the fMP4
		// contract. The concat-demuxer LIST this used to write decoded every
		// real capture to zero frames ; the ffmpeg-backed proof is
		// live-capture-ffmpeg.test.ts.
		expect(readFileSync(clip.clipPath, "utf8")).toBe("INITSEG1SEG2");
	});

	it("throws when no segments are found under the prefix", async () => {
		const { browser } = fakeBrowser({ pages: [{ objects: [] }] });
		await expect(
			captureRenditionWindow({
				deps: captureDeps(browser),
				credential,
				bucket: "b",
				target: FMP4_TARGET,
				jobDir: workDir,
				windowSeconds: 120,
				now: Date.now(),
				fallbackCount: 10,
			}),
		).rejects.toThrow(/found no segments/);
	});
});

describe("captureRenditionWindow (TS)", () => {
	it("byte-concatenates TS segments in order into one clip (no init)", async () => {
		const { browser, gets } = fakeBrowser({
			pages: [
				{
					objects: [
						obj(
							"output/live/video/720p-ts/seg_1.ts",
							"2026-06-18T11:59:40.000Z",
						),
						obj(
							"output/live/video/720p-ts/seg_2.ts",
							"2026-06-18T11:59:50.000Z",
						),
					],
				},
			],
			bytesFor: (key) => (key.endsWith("seg_1.ts") ? "AAA" : "BBB"),
		});
		const clip = await captureRenditionWindow({
			deps: captureDeps(browser),
			credential,
			bucket: "b",
			target: TS_TARGET,
			jobDir: workDir,
			windowSeconds: 120,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
			fallbackCount: 10,
		});
		expect(clip.container).toBe("TS");
		expect(clip.clipPath.endsWith(".ts")).toBe(true);
		expect(gets).toEqual([
			"output/live/video/720p-ts/seg_1.ts",
			"output/live/video/720p-ts/seg_2.ts",
		]);
		// Combined clip is the segments concatenated in order.
		expect(readFileSync(clip.clipPath as string, "utf8")).toBe("AAABBB");
	});
});

describe("listAllUnderPrefix — a listing it cannot finish is refused (ledger #213)", () => {
	it("throws, by name, instead of returning a quietly short tail", async () => {
		// A browser whose every page carries a next cursor: 2000 pages of 100
		// would be the 200,000-object cap. The old code returned the partial
		// list and the capture scored a guessed window (paid audit MODERATE-15).
		const browser = {
			listBuckets: async () => ["b"],
			listObjects: async () => ({
				prefixes: [],
				objects: [obj("output/live/video/1080p/segment_1.m4s")],
				nextCursor: "more",
			}),
		} as unknown as ObjectStorageBrowser;
		await expect(
			listAllUnderPrefix(browser, "b", "output/live/video/1080p"),
		).rejects.toThrow(/truncated at 200000 objects/);
	});
});
