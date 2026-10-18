import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExpectedArtefacts } from "@bitovp/core";
import { VOD_FIXTURES } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	makeForeignKeyFilter,
	readPerTitleEvidence,
	readPerTitleRungDirs,
	verifyJob,
} from "./job";

/**
 * WHERE and WHEN an object was written — never what it is called.
 *
 * Two defects live in this file's history and the second is why the rule changed.
 *
 * 1. `--strict-prefix` promised a timestamp comparison and did not make one, so 100
 *    stale `seg_*.ts` files from an earlier run of the SAME plan were accepted as
 *    this job's evidence (their names matched).
 * 2. The other half of that rule — "the basename matches no name the plan declares"
 *    — could never be right, because a run NAMES ITS OWN ARTEFACTS. The per-title
 *    manifest generator resolves `video_{avgBitrate}.m3u8` from the rungs the encoder
 *    chose, and `hlsChildEntries` omits those by design ("resolved at run time"). The
 *    same false FAIL therefore returned with a new family three times: media playlists
 *    and QC mirrors , subtitle playlists (review-325 I1), and the billed
 *    re-audit run `pertitle-h264-fmp4-ts-dash-hls-on-aws` — 481 PASS and one FAIL,
 *    "objects under this plan's prefixes that this run did not write — 6", which were
 *    its own six variant playlists .
 *
 * So membership is decided by directory, and directories ARE knowable in advance: C4
 * forces the run-time part of a per-title path into a placeholder the plan carries.
 *
 * Everything here imports the REAL filter. This file used to re-implement it, which a
 * reviewer showed pins nothing: five mutations to the real one, including deleting the
 * timestamp arm, all survived while these tests stayed green.
 */

const JOB_AT = new Date("2026-08-09T00:00:00.000Z");
const DURING = "2026-08-09T00:05:00.000Z";
const BEFORE = "2026-06-21T10:00:00.000Z";

const FIXTURES = join(
	import.meta.dirname,
	"../../../../packages/core/src/plan/__fixtures__",
);

function golden(name: string): ExpectedArtefacts {
	return JSON.parse(
		readFileSync(join(FIXTURES, `${name}.expected.json`), "utf8"),
	) as ExpectedArtefacts;
}

/** The simplest possible plan shape: one segmented muxing, one manifest. */
const simple = makeForeignKeyFilter(
	{
		muxings: [
			{
				dir: { pattern: "out/video/", prefix: "out/video/", templated: false },
			},
		] as never,
		manifests: [
			{ dir: { pattern: "out/", prefix: "out/", templated: false }, files: [] },
		] as never,
		thumbnails: [],
		sprites: [],
	},
	JOB_AT,
);

describe("strict-prefix foreignness — WHEN", () => {
	it("excludes a stale segment with a MATCHING name — the actual incident", () => {
		// June's run left 100 of these. A name test alone accepted every one as
		// evidence that this job had produced them.
		expect(simple("out/video/seg_7.ts", { lastModified: BEFORE })).toBe(true);
	});

	it("keeps this job's own segment", () => {
		expect(simple("out/video/seg_7.ts", { lastModified: DURING })).toBe(false);
	});

	it("ignores an unparseable timestamp rather than treating it as ancient", () => {
		expect(simple("out/video/seg_1.ts", { lastModified: "not a date" })).toBe(
			false,
		);
	});

	it("still decides when the driver reports no timestamp at all", () => {
		// Not every driver returns lastModified, and the filter must not silently
		// pass everything when it is absent: the place test stands on its own.
		expect(simple("out/video/seg_1.ts", {})).toBe(false);
		expect(simple("out/elsewhere/junk.bin", {})).toBe(true);
	});
});

describe("strict-prefix foreignness — WHERE", () => {
	it("keeps a file the plan never NAMES, in a directory the plan writes to", () => {
		// The load-bearing reversal. Under the old rule this was foreign; it is the
		// shape every per-title artefact has, because the run names it, not the plan.
		expect(simple("out/video/whatever-the-encoder-called-it.ts", {})).toBe(
			false,
		);
	});

	it("excludes a stranger in a directory the plan never writes to", () => {
		expect(simple("out/somebody-else/seg_1.ts", { lastModified: DURING })).toBe(
			true,
		);
	});

	it("excludes a file nested BELOW a declared directory", () => {
		// `out/video/` is declared; `out/video/extra/` is not. A run writes into the
		// directories it declared and into the rung directories C4 makes it declare.
		expect(simple("out/video/extra/seg_1.ts", {})).toBe(true);
	});
});

/**
 * , on the real artefacts of the run that found it.
 *
 * The plan is `pertitle-h264-fmp4-ts-dash-hls-on-aws` — 7 H264 per-title templates,
 * fMP4+TS legs, DASH+HLS. Its golden `hlsChildFiles` holds ONE entry
 * (`audio_128000.m3u8`); the six `video_<avgBitrate>.m3u8` the encoder's ladder
 * produced are in no static list and never can be.
 */
describe("run B: a per-title run's own artefacts are not somebody else's", () => {
	const expected = golden("pertitle-h264-fmp4-ts-dash-hls-on-aws");
	const filter = makeForeignKeyFilter(expected, JOB_AT);
	const root = expected.manifests[0]?.dir.prefix as string;
	/** The six the paid run wrote, and the six this check called foreign. */
	const VARIANTS = [
		"video_249000.m3u8",
		"video_495000.m3u8",
		"video_1005000.m3u8",
		"video_1998000.m3u8",
		"video_3006000.m3u8",
		"video_4498000.m3u8",
	];

	it("the golden really does omit them, or this test proves nothing", () => {
		const declared = expected.manifests.flatMap((m) => m.hlsChildFiles ?? []);
		expect(declared).toEqual(["audio_128000.m3u8"]);
	});

	it.each(VARIANTS)("keeps the run-named variant playlist %s", (name) => {
		expect(filter(`${root}${name}`, { lastModified: DURING })).toBe(false);
	});

	it("counts none of the six as foreign — the paid run's FAIL, inverted", () => {
		const foreign = VARIANTS.filter((n) =>
			filter(`${root}${n}`, { lastModified: DURING }),
		);
		expect(foreign, "the report said 6; the rule must say 0").toEqual([]);
	});

	it("keeps a rung's own segments under the expanded {…} directory", () => {
		const rung = `${root}video/hls/v540/540p_1005000_9f2c1b47/`;
		expect(filter(`${rung}seg_1.ts`, { lastModified: DURING })).toBe(false);
		// The rung's playlist, if the provider ever writes one beside the segments:
		// still inside a directory this plan declares, whatever it is called.
		expect(filter(`${rung}anything.m3u8`, { lastModified: DURING })).toBe(
			false,
		);
	});

	it("still excludes one of those same six when it PREDATES the job", () => {
		// The place test alone would keep it. This is the arm that keeps
		// `--strict-prefix` worth passing.
		expect(filter(`${root}${VARIANTS[0]}`, { lastModified: BEFORE })).toBe(
			true,
		);
	});

	it("still excludes a stranger in an undeclared subdirectory of the same prefix", () => {
		expect(filter(`${root}scratch/notes.txt`, { lastModified: DURING })).toBe(
			true,
		);
	});
});

/**
 *  / review-325, re-pinned on the rule that replaced them.
 *
 * Each of these was foreign once, and each is a file the plan asks the provider to
 * write. They pass now for a structural reason rather than because someone
 * remembered to add their name to a list.
 */
describe("everything the plan writes stays, by place", () => {
	const dir = (p: string) => ({ pattern: p, prefix: p, templated: false });
	const f = makeForeignKeyFilter(
		{
			muxings: [{ dir: dir("out/video/720p/") }] as never,
			manifests: [
				{ dir: dir("out/"), files: ["stream.m3u8"], hlsChildFiles: [] },
			] as never,
			qc: { mirrors: [{ dir: dir("out/video/720p/qc/") }] },
			thumbnails: [{ dir: dir("out/thumbs/") }] as never,
			sprites: [{ dir: dir("out/sprites/") }] as never,
		},
		JOB_AT,
	);
	it.each([
		["an HLS media playlist", "out/video_720000.m3u8"],
		["a QC mirror MP4", "out/video/720p/qc/v720.mp4"],
		["a thumbnail", "out/thumbs/thumb_3.jpg"],
		["a sprite image", "out/sprites/sprite_0.jpg"],
		["the sprite VTT", "out/sprites/sprite.vtt"],
	])("keeps %s", (_what, key) => {
		expect(f(key, { lastModified: DURING })).toBe(false);
	});
	it("still rejects a stranger in a directory nothing declares", () => {
		expect(f("out/video/720p/qc/deeper/notes.txt", {})).toBe(true);
	});
});

describe("the declared directory set covers every family the expectation carries", () => {
	it("a DRM-routed muxing reaches storage through its DRM rows, and those count", () => {
		// All four muxings of `pertitle-h264-mp4-smooth-drm-on-aws` carry an empty
		// `dir` — the DRM rows ARE that plan's whole population, so dropping them
		// would mark every artefact of a DRM'd plan foreign.
		const expected = golden("pertitle-h264-mp4-smooth-drm-on-aws");
		expect(
			expected.muxings.every((m) => m.dir.prefix === ""),
			"the fixture must still be the DRM-routed shape this arm is about",
		).toBe(true);
		const drmDir = expected.drm.find((d) => d.dir)?.dir?.prefix as string;
		expect(drmDir).toBeTruthy();
		const f = makeForeignKeyFilter(expected, JOB_AT);
		expect(f(`${drmDir}720p_1200000_abc/video.ismv`, {})).toBe(false);
	});

	it("a NESTED child URI contributes its DIRECTORY — the run names the file, we know the place", () => {
		// `rendition.hlsMedia.uri` is operator-settable (API parity), so a nested
		// value is a reachable shape.
		const f = makeForeignKeyFilter(
			{
				muxings: [] as never,
				manifests: [
					{
						dir: { pattern: "out/", prefix: "out/", templated: false },
						files: ["stream.m3u8"],
						hlsChildFiles: ["sub/dir/video_720000.m3u8"],
					},
				] as never,
				thumbnails: [],
				sprites: [],
			},
			JOB_AT,
		);
		expect(f("out/sub/dir/video_720000.m3u8", {})).toBe(false);
		expect(f("out/sub/dir/whatever-the-run-called-it.m3u8", {})).toBe(false);
		expect(f("out/sub/other/video_720000.m3u8", {})).toBe(true);
	});

	it("a real VTT fixture's subtitle playlist is NOT foreign", () => {
		// review-325 I1: the subtitle family was dropped from the name list and
		// `--strict-prefix` FAILed a correct encode on its own `subtitles_en.m3u8`.
		const expected = golden("fixed-bitrate-hls-vtt-on-aws");
		const hls = expected.manifests.find((m) => m.kind === "HLS");
		expect(hls?.hlsChildFiles).toContain("subtitles_en.m3u8");
		const f = makeForeignKeyFilter(expected, JOB_AT);
		expect(f(`${hls?.dir.prefix}subtitles_en.m3u8`, {})).toBe(false);
		expect(f(`${hls?.dir.prefix}audio_128000.m3u8`, {})).toBe(false);
	});
});

/**
 * The population, derived from the world rather than from a list of families I
 * happened to think of.
 *
 * Every family this filter has ever got wrong was a family nobody enumerated. So
 * this walks the WHOLE fixture corpus, builds the objects each expectation implies
 * (including the rung expansion of every templated directory, and a file whose name
 * the run invents), and asserts that none of them is foreign. A new artefact family
 * added to `compileExpectedArtefacts` joins this sweep for free; a directory family
 * dropped from `declaredDirPatterns` fails it on whichever fixture carries one.
 */
describe("no fixture's own artefacts are foreign", () => {
	const names = readdirSync(FIXTURES)
		.filter((f) => f.endsWith(".expected.json"))
		.map((f) => f.replace(/\.expected\.json$/, ""))
		.sort();

	/**
	 * EQUALITY against the registry, not a floor against a listing.
	 *
	 * `toBeGreaterThan(60)` was derived from the set under question — it closes
	 * drift downward only, and it would have gone on passing at 61 while the
	 * docblock above says "all 72". `VOD_FIXTURES` is the registry, and
	 * `fixture-registry.test.ts` set-equals THAT against the `.plan.json` files
	 * on disk in both directions, so equality here makes this sweep transitively
	 * the whole corpus: a new fixture joins it the moment it is registered, and a
	 * registered plan with no `.expected.json` fails here by name.
	 */
	it("is the registry, not a floor — every registered VOD fixture is swept", () => {
		expect(names).toEqual([...VOD_FIXTURES].sort());
	});

	/** Every key the run could put in a directory the expectation declares. */
	function worldFor(expected: ExpectedArtefacts): string[] {
		const keys: string[] = [];
		const expand = (pattern: string): string =>
			pattern.replace(/\{[a-zA-Z]+\}/g, "9f2c").replace(/%[a-zA-Z]+%/g, "3");
		const at = (pattern: string, name: string) => {
			const d = expand(pattern);
			if (d !== "") {
				keys.push(`${d}${name}`);
			}
		};
		for (const m of expected.muxings) {
			at(m.dir.pattern, m.initSegment ?? "init.mp4");
			at(m.dir.pattern, m.filename ?? "video.mp4");
			at(m.dir.pattern, expand(m.segmentNaming ?? "seg_%number%.ts"));
			// The file the RUN names, which no expectation contains.
			at(m.dir.pattern, "resolved-at-run-time.bin");
		}
		for (const d of expected.drm) {
			if (d.dir) {
				at(d.dir.pattern, "init.mp4");
				at(d.dir.pattern, "resolved-at-run-time.bin");
			}
		}
		for (const m of expected.manifests) {
			for (const file of m.files) {
				at(m.dir.pattern, file);
			}
			for (const child of m.hlsChildFiles ?? []) {
				at(m.dir.pattern, child);
			}
			// The per-title variant playlists  and any other child the
			// generator names from the chosen ladder.
			at(m.dir.pattern, "video_1005000.m3u8");
		}
		for (const t of expected.thumbnails) {
			at(t.dir.pattern, expand(t.pattern));
		}
		for (const sp of expected.sprites) {
			at(sp.dir.pattern, expand(sp.spriteName ?? "sprite_%number%.jpg"));
			at(sp.dir.pattern, sp.vttName ?? "sprite.vtt");
		}
		for (const mirror of expected.qc?.mirrors ?? []) {
			at(mirror.dir.pattern, mirror.filename);
		}
		return keys;
	}

	for (const name of names) {
		it(`${name}: nothing it writes is foreign`, () => {
			const expected = golden(name);
			const f = makeForeignKeyFilter(expected, JOB_AT);
			const world = worldFor(expected);
			expect(
				world.length,
				"a fixture with no world proves nothing",
			).toBeGreaterThan(0);
			expect(world.filter((k) => f(k, { lastModified: DURING }))).toEqual([]);
		});
	}
});

/**
 * The run-derived half : directories the capture snapshot
 * records only ever ADD.
 */
describe("observed rung directories", () => {
	const base = {
		muxings: [
			{
				dir: { pattern: "out/video/", prefix: "out/video/", templated: false },
			},
		] as never,
		manifests: [] as never,
		thumbnails: [],
		sprites: [],
	};

	it("keeps an object in a directory only the snapshot names", () => {
		const without = makeForeignKeyFilter(base, JOB_AT);
		const withObserved = makeForeignKeyFilter(base, JOB_AT, [
			"elsewhere/360p_500000_9f2c/",
		]);
		expect(
			without("elsewhere/360p_500000_9f2c/seg_1.m4s", {}),
			"without the observed set this is out of place",
		).toBe(true);
		expect(withObserved("elsewhere/360p_500000_9f2c/seg_1.m4s", {})).toBe(
			false,
		);
	});

	it("adds a trailing slash, so a path the API returned without one still matches", () => {
		const f = makeForeignKeyFilter(base, JOB_AT, [
			"elsewhere/360p_500000_9f2c",
		]);
		expect(f("elsewhere/360p_500000_9f2c/seg_1.m4s", {})).toBe(false);
	});

	it("never widens the TIME rule — an observed directory's stale object is still foreign", () => {
		const f = makeForeignKeyFilter(base, JOB_AT, [
			"elsewhere/360p_500000_9f2c/",
		]);
		expect(
			f("elsewhere/360p_500000_9f2c/seg_1.m4s", { lastModified: BEFORE }),
		).toBe(true);
	});
});

/**
 * Where the observed set comes from: the job's own per-title capture.
 *
 * A rule nobody calls is not a fix, and this reader is the one seam that can be
 * exercised without a bucket — `verifyJob` itself needs a database, credentials
 * and storage, so its call is pinned by shape at the bottom, the same way the QC
 * join is.
 */
describe("readPerTitleRungDirs", () => {
	const SNAPSHOT = {
		capturedAt: "2026-08-29T00:00:00.000Z",
		streams: [
			{
				streamId: "s-1",
				mode: "PER_TITLE_RESULT",
				params: {},
				muxings: [
					{
						muxingId: "m-1",
						muxingType: "TS",
						outputs: [{ outputPath: "out/video/hls/540p_1005000_9f2c/" }],
						drm: [],
					},
				],
			},
		],
		scan: {
			streamsListed: 1,
			templatesListed: 7,
			templatesDeclared: 7,
			resultsCaptured: 1,
			muxingsListed: 1,
			complete: true,
			codecConfigErrors: 0,
			unattributed: 1,
		},
	};
	const prismaWith = (row: unknown) =>
		({
			encodingJob: { findUnique: async () => row },
		}) as never;

	it("reads the capture step's own response", async () => {
		expect(
			await readPerTitleRungDirs(
				prismaWith({
					stepLog: [
						{
							step: "per-title-results",
							response: { captured: true, snapshot: SNAPSHOT },
						},
					],
					snapshots: null,
				}),
				"job-1",
			),
		).toEqual(["out/video/hls/540p_1005000_9f2c/"]);
	});

	it("falls back to the backfilled snapshots column", async () => {
		expect(
			await readPerTitleRungDirs(
				prismaWith({
					stepLog: [],
					snapshots: { perTitleResults: SNAPSHOT },
				}),
				"job-1",
			),
		).toEqual(["out/video/hls/540p_1005000_9f2c/"]);
	});

	it("returns provider output identities from the same read as the RESULT view", async () => {
		const evidence = await readPerTitleEvidence(
			prismaWith({
				stepLog: [
					{
						step: "output:origin",
						kind: "CREATE_OUTPUT_S3",
						payload: {},
						refs: {},
						status: "DONE",
						resourceId: "provider-origin",
					},
					{
						step: "output:mirror",
						kind: "CREATE_OUTPUT_GCS",
						payload: {},
						refs: {},
						status: "FAILED",
						resourceId: "provider-mirror-abandoned",
					},
					{
						step: "per-title-results",
						kind: "CAPTURE_PER_TITLE_RESULTS",
						payload: {},
						refs: {},
						status: "DONE",
						response: { captured: true, snapshot: SNAPSHOT },
					},
				],
				snapshots: null,
			}),
			"job-1",
		);
		expect(evidence.view.origin).toBe("step");
		expect(evidence.providerOutputIds).toEqual({ origin: "provider-origin" });
	});

	it.each([
		["no row at all", null],
		["no capture", { stepLog: [], snapshots: null }],
		[
			"a FAILED capture",
			{
				stepLog: [
					{
						step: "per-title-results",
						response: { captured: false, error: "listStreams timed out" },
					},
				],
				snapshots: null,
			},
		],
		[
			"an unparseable snapshot",
			{ stepLog: [], snapshots: { perTitleResults: 7 } },
		],
	])("is empty for %s — the observed set only ever adds", async (_what, row) => {
		expect(await readPerTitleRungDirs(prismaWith(row), "job-1")).toEqual([]);
	});
});

describe("the wiring, pinned by shape", () => {
	// `verifyJob` needs a database, credentials and a bucket, so no test can call
	// it. What this catches is the one revert that matters: the rule existing and
	// nobody passing the run's own directories into it.
	const source = readFileSync(new URL("./job.ts", import.meta.url), "utf8");
	const body = source.slice(
		source.indexOf("export async function verifyJob("),
		source.indexOf("export function formatReport("),
	);

	it("verifyJob reads the capture only for a per-title plan, once, for both consumers", () => {
		expect(body).toContain("planHasPerTitle(plan)");
		expect(body).toContain("readPerTitleEvidence(options.prisma, job.id)");
		// The rung directories (strict-prefix filter) and the RESULT families
		// (per-title manifest check, row 284) both come off that ONE read.
		expect(body).toContain("perTitleRungDirsOf(perTitleView)");
		expect(body).toContain("perTitleActualVideoFamilies(perTitleView)");
		expect(body).toContain("perTitleActualPopulations(perTitleView)");
		expect(body).toContain("deps.perTitleActual = perTitleActual");
		expect(body).toContain("deps.perTitlePopulations = perTitlePopulations");
		expect(body).toContain(
			"deps.providerOutputIds = perTitleEvidence.providerOutputIds",
		);
	});

	it("verifyJob hands the observed directories to the filter", () => {
		const call = body.slice(
			body.indexOf("foreignKeyFilter: makeForeignKeyFilter("),
		);
		expect(call.slice(0, 200)).toContain("observedRungDirs");
	});
});

/**
 * A query whose result nothing reads is not a cheap query — and this one is
 * BEHAVIOURAL, not a source-text pin.
 *
 * `verifyJob` cannot be run to completion here (it needs credentials and a
 * bucket), but the gate is evaluated BEFORE any of that, so letting the call
 * fail downstream and reading the prisma call log still answers the only
 * question: was the capture fetched? `stepLog` and `snapshots` are the two fat
 * JSON columns.
 *
 * Who consumes them changed with row 284: the per-title manifest check compares
 * the plan's declared families with the capture's RESULT families on EVERY
 * per-title verify, so a per-title plan reads the capture with or without
 * `--strict-prefix` (this test used to pin the opposite, when the strict-prefix
 * filter was the capture's only reader). A fixed-ladder plan has no capture and
 * no consumer, and must still fetch neither column.
 *
 * The per-title arms are the CONTROL for the fixed one. Without them a
 * `verifyJob` that threw before ever reaching the gate would leave the fixed
 * arm green for the wrong reason.
 */
describe("the capture is read only when something will consume it", () => {
	const planNamed = (name: string) =>
		JSON.parse(
			readFileSync(join(FIXTURES, `${name}.plan.json`), "utf8"),
		) as unknown;
	const perTitlePlan = planNamed("pertitle-h264-fmp4-ts-dash-hls-on-aws");
	const fixedPlan = planNamed("fixed-bitrate-hls-on-aws");

	async function callsFor(
		plan: unknown,
		excludeOlderThanJob: boolean,
	): Promise<string[]> {
		const calls: string[] = [];
		const prisma = {
			encodingJob: {
				findMany: async () => {
					calls.push("findMany");
					return [
						{
							id: "job-1",
							name: "per-title",
							status: "FINISHED",
							plan,
							createdAt: JOB_AT,
							qcOverriddenAt: null,
						},
					];
				},
				findUnique: async () => {
					calls.push("findUnique");
					return { stepLog: [], snapshots: null };
				},
			},
		} as never;
		// It WILL throw further down (no credential store, no bucket). That is
		// after the gate, so the log is already decisive.
		await verifyJob({
			prisma,
			ffprobePath: "ffprobe",
			jobIdPrefix: "job-1",
			excludeOlderThanJob,
		}).catch(() => undefined);
		return calls;
	}

	it("does NOT fetch stepLog/snapshots for a fixed-ladder plan, with or without strict-prefix", async () => {
		expect(await callsFor(fixedPlan, false)).toEqual(["findMany"]);
		expect(await callsFor(fixedPlan, true)).toEqual(["findMany"]);
	});

	it("DOES fetch them, ONCE, for a per-title plan without strict-prefix — the family check consumes them (row 284)", async () => {
		expect(await callsFor(perTitlePlan, false)).toEqual([
			"findMany",
			"findUnique",
		]);
	});

	it("DOES fetch them, still once, for a per-title plan with strict-prefix — both consumers share the read", async () => {
		expect(await callsFor(perTitlePlan, true)).toEqual([
			"findMany",
			"findUnique",
		]);
	});
});
