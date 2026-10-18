import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileExpectedArtefacts, encodingPlanSchema } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { verifyArtefacts } from "./engine";

const F = join(
	import.meta.dirname,
	"../../../../packages/core/src/plan/__fixtures__",
);
const plan = encodingPlanSchema.parse(
	JSON.parse(readFileSync(join(F, "pertitle-h264-openapi.plan.json"), "utf8")),
);
const expected = compileExpectedArtefacts(plan);

/**
 * Per-title ladders, driven against a REAL fixture's compiled expectations.
 *
 * A review asked whether the engine could report PASS on a broken world, and found the
 * worse converse: per-title scenarios — 14 of the 66 — could not go green as written.
 * `pathPattern` cuts a templated path at its first placeholder, so all seven FMP4
 * muxings of `pertitle-h264-openapi` resolve to the same listing prefix. Driving the
 * shipped engine against a CORRECT 3-rung result therefore produced 33 failures: the
 * init-segment lookup returned the same file for every muxing, and the segment count
 * summed all rungs and compared the total against one rendition's expectation.
 *
 * The model was wrong, not just the arithmetic. Per-title rungs are chosen by the
 * ENCODER: the plan cannot name their heights or how many there will be. So the engine
 * now partitions by rung directory and asserts what is knowable — placeholders expanded
 * (C4), an init segment and the right segment count PER rung, codec, distinct geometry —
 * and never a template value the plan deliberately left out.
 *
 * A SECOND review then asked the obvious next question — what if the ladder collapses? —
 * and the answer was 0 FAILs and 104 PASSes, because a per-rung loop cannot see a rung
 * that is not there. So the rung COUNT is asserted separately, from a bound the plan does
 * know: every per-title muxing sharing a prefix contributes at least one rung.
 *
 * The four cases below are the proof, and the failing ones are what make the green one
 * mean anything: a control alone would pass on an engine that asserts nothing.
 */

/** A per-title world: one object set per rung directory, as Bitmovin writes it. */
function world(rungs: { dir: string; height: number; segs: number }[]) {
	// ONE set per rung directory, which is what Bitmovin writes: the per-title muxings
	// SHARE a prefix and the encoder produces one directory per rung.
	const seen = new Set<string>();
	const objects: { key: string; size: number }[] = [];
	for (const m of expected.muxings) {
		if (!m.dir.prefix) continue;
		// Non-per-title muxings (the audio legs) write DIRECTLY under their prefix; only
		// per-title video fans out into rung directories.
		const dirsFor = m.perTitle ? rungs.map((r) => r.dir) : [""];
		for (const rd of dirsFor) {
			const r = rungs.find((x) => x.dir === rd) ?? rungs[0];
			if (!r) {
				throw new Error("per-title capture produced no rungs");
			}
			const base = rd === "" ? m.dir.prefix : `${m.dir.prefix}${rd}/`;
			if (seen.has(base)) continue;
			seen.add(base);
			if (m.initSegment)
				objects.push({ key: `${base}${m.initSegment}`, size: 900 });
			for (let i = 1; i <= r.segs; i++) {
				objects.push({
					key: `${base}${(m.segmentNaming ?? "seg_%number%.m4s").replace("%number%", String(i))}`,
					size: 500_000,
				});
			}
		}
	}
	return objects;
}

/** The height a rung directory's name declares — the stub's stand-in for ffprobe. */
function heightOfKey(key: string): number {
	const m = /\/(\d+)p_/.exec(key);
	return m ? Number(m[1]) : 1080;
}

/**
 * SEVEN rungs, because the fixture declares seven per-title muxings per prefix and each
 * yields at least one rung directory.
 *
 * My first version of this file used three and called it "the correct ladder". A second
 * review asked what happens when a ladder collapses, and the answer was 0 FAILs and 104
 * PASSes — so a rung-COUNT check went in, and it promptly rejected this very world. A
 * world its author believed was correct is exactly what a count check is for; per-rung
 * checks cannot see a rung that is not there, by construction.
 */
const RUNGS = [
	{ dir: "180p_400000", height: 180, segs: 2 },
	{ dir: "360p_300000", height: 360, segs: 2 },
	{ dir: "360p_600000", height: 360, segs: 2 },
	{ dir: "540p_1500000", height: 540, segs: 2 },
	{ dir: "720p_3000000", height: 720, segs: 2 },
	{ dir: "900p_4000000", height: 900, segs: 2 },
	{ dir: "1080p_6000000", height: 1080, segs: 2 },
];

/**
 * The manifest mocks are DERIVED from the rung list, not hard-coded.
 *
 * They used to return 7 variants and 8 representations while `world` wrote 3 rung
 * directories — a pair no encoder can produce. A reviewer caught that the impossible
 * mock was the only reason "passes a CORRECT ladder" was green: with a manifest honestly
 * describing the world, the plan-count assertions failed. Deriving them means the test
 * cannot describe a world it did not build.
 */
function deps(
	objects: { key: string; size: number }[],
	heightOf: (k: string) => number,
	rungCount = RUNGS.length,
) {
	return {
		listAll: async (_o: string, prefix: string) =>
			objects.filter((x) => x.key.startsWith(prefix)),
		fetchObject: async (_o: string, key: string) => key,
		fetchConcatenated: async (_o: string, keys: string[]) =>
			keys[keys.length - 1] ?? "",
		probe: async (p: string) =>
			/audio/.test(p)
				? {
						audioCodec: "aac",
						audioBitrateBps: 128_000,
						sampleRate: 48_000,
						channels: 2,
						channelLayout: "stereo",
						durationSec: 12,
					}
				: {
						height: heightOf(p),
						width: (heightOf(p) * 16) / 9,
						videoCodec: "h264",
						durationSec: 12,
						fps: 25,
					},
		scanBoxes: async () => ({ psshSystemIds: [] }),
		// The master keeps its bare stub; every CHILD the fake parser names reads
		// as a healthy closed fMP4 media playlist — per-title masters walk their
		// children too since review-325 , and an empty child is a
		// defect the engine is supposed to see.
		// The audio media child is named as the COMPILER names it (this fixture
		// pins `audioMediaUri: "audio.m3u8"`), because the one-to-one binding
		// (row 284) asserts the entry's URI against the plan.
		readText: async (_o: string, k: string) =>
			k.endsWith("/index.m3u8") || k.endsWith("/audio.m3u8")
				? '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.000,\nseg_1.m4s\n#EXTINF:4.000,\nseg_2.m4s\n#EXT-X-ENDLIST\n'
				: "#EXTM3U\n#EXT-X-VERSION:4\n",
		parseHls: async () => ({
			variants: Array.from({ length: rungCount }, (_, i) => ({
				uri: `v${i}/index.m3u8`,
			})),
			media: [
				{
					type: "AUDIO",
					groupId: "audio",
					name: "HLS Audio Media",
					uri: "audio.m3u8",
				},
			],
			version: 4,
		}),
		parseDash: async () => ({
			// rungs + the one audio representation, which is NOT per-title.
			// Classified like the real adapter would (review-325: per-title MPDs
			// are counted per KIND too — the rungs are video, the last is audio).
			representations: Array.from({ length: rungCount + 1 }, (_, i) => ({
				addressing: "TEMPLATE" as const,
				kind: i < rungCount ? ("video" as const) : ("audio" as const),
			})),
			periods: 1,
			durationSec: 12,
		}),
		reference: { durationSec: 12 },
	} as never;
}

describe("per-title rungs, against the real fixture", () => {
	it("passes a CORRECT full ladder", async () => {
		const report = await verifyArtefacts(
			expected,
			deps(world(RUNGS), heightOfKey),
		);
		const fails = report.checks.filter((c) => c.verdict === "FAIL");
		expect(fails.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
		// And it must have actually checked the rungs, not skipped them into silence.
		const rungChecks = report.checks.filter((c) => /540p_1500000/.test(c.id));
		expect(rungChecks.length, "per-rung checks emitted").toBeGreaterThan(10);
	});

	it("FAILS a ladder that collapsed to one rung — 0 FAILs before this check", async () => {
		// A per-title encode producing one rung where seven were declared is a real
		// Bitmovin failure mode, and it read as 104 PASSes and no failures at all: the
		// per-rung loop only ever iterates the rungs that EXIST, so a missing rung is
		// invisible to it by construction. Found by a second review's question.
		const report = await verifyArtefacts(
			expected,
			deps(world([RUNGS[0] as (typeof RUNGS)[number]]), heightOfKey, 1),
		);
		const fails = report.checks.filter((c) => c.verdict === "FAIL");
		expect(
			fails.some((c) => /:rungs$/.test(c.id)),
			`failures were [${fails.map((f) => f.id).join(", ")}]`,
		).toBe(true);
		expect(
			fails.find((c) => /:rungs$/.test(c.id))?.detail,
			"the failure must say how many were required and why",
		).toMatch(/at least 4 rung directories .* — found 1/);
	});

	it("WARNS rather than FAILS when there are MORE rungs than templates", async () => {
		/**
		 * The ceiling used to FAIL, and a real run refuted it.
		 * `pertitle-av1-fmp4-dash-on-aws` declares two per-title video muxings and the encoder
		 * wrote four rung directories — 360p_128000, 360p_415163, 720p_1346567, 720p_1615880 —
		 * both extras predicted by the plan's own perTitle config:
		 * `forcedRenditionAboveHighestFixedRepresentation: 1` at factor 1.2 gives
		 * 1346567 × 1.2 = 1615880.4, and `minBitrate: 128000` gives the bottom rung exactly.
		 *
		 * So an over-count is worth SAYING and not worth failing. This fixture has 7 per-title
		 * muxings, so nine rungs is over its ceiling by two.
		 */
		const extra = [
			...RUNGS,
			{ dir: "1440p_9000000", height: 1440, segs: 3 },
			{ dir: "2160p_12000000", height: 2160, segs: 3 },
		];
		const report = await verifyArtefacts(
			expected,
			deps(world(extra), heightOfKey, extra.length),
		);
		const overs = report.checks.filter((c) =>
			/:rungs-above-templates$/.test(c.id),
		);
		expect(overs.length, "the over-count must be reported").toBeGreaterThan(0);
		expect(overs.every((c) => c.verdict === "WARN")).toBe(true);
		// And it must name the legitimate causes, or a reader cannot tell noise from a defect.
		expect(overs[0]?.detail).toMatch(
			/forcedRenditionAboveHighestFixedRepresentation/,
		);
		// Critically: not a FAIL anywhere in the rung checks.
		expect(
			report.checks
				.filter((c) => c.verdict === "FAIL" && /:rungs/.test(c.id))
				.map((c) => c.id),
		).toEqual([]);
	});

	it("FAILS a ladder with one rung truncated", async () => {
		const objects = world([
			...RUNGS.slice(0, 6),
			{ dir: "1080p_6000000", height: 1080, segs: 1 },
		]);
		const report = await verifyArtefacts(expected, deps(objects, heightOfKey));
		const fails = report.checks.filter((c) => c.verdict === "FAIL");
		expect(
			fails.some((c) => /1080p_6000000:segment-count/.test(c.id)),
			`failures were [${fails.map((f) => f.id).join(", ")}]`,
		).toBe(true);
	});

	it("FAILS when the {height} placeholder never expanded", async () => {
		const objects = world([
			{ dir: "{height}p_{bitrate}", height: 1080, segs: 2 },
		]);
		const report = await verifyArtefacts(
			expected,
			deps(objects, () => 1080),
		);
		const fails = report.checks.filter((c) => c.verdict === "FAIL");
		expect(fails.some((c) => /rung-placeholders/.test(c.id))).toBe(true);
	});
});

/**
 * The MP4 shape, which the first version of the per-title branch did not cover.
 *
 * `pertitle-h264-mp4-smooth-drm-on-aws` has four per-title muxings that all write
 * through their DRM rows to ONE prefix and all name the same file, `video.ismv`. With
 * the branch gated on `segmentNaming`, they stayed on the single-file path, where
 * `keys.find(k => k.endsWith("video.ismv"))` returned the same object four times and
 * reported it as four renditions — the exact aliasing bug the branch exists to remove,
 * still live for single-file containers. A second review asked for this shape by name.
 */
describe("per-title, single-file container (MP4/Smooth)", () => {
	const mp4Expected = compileExpectedArtefacts(
		encodingPlanSchema.parse(
			JSON.parse(
				readFileSync(
					join(F, "pertitle-h264-mp4-smooth-drm-on-aws.plan.json"),
					"utf8",
				),
			),
		),
	);

	/** One `video.ismv` per rung directory, plus the init segment DRM scans. */
	function mp4World(rungDirs: string[]) {
		const seen = new Set<string>();
		const objects: { key: string; size: number }[] = [];
		const prefixes = [
			...mp4Expected.drm.map((d) => d.dir?.prefix),
			...mp4Expected.muxings.map((m) => m.dir.prefix),
		].filter((p): p is string => p !== undefined && p !== "");
		for (const prefix of prefixes) {
			for (const rd of rungDirs) {
				const base = `${prefix}${rd}/`;
				if (seen.has(base)) continue;
				seen.add(base);
				objects.push({ key: `${base}video.ismv`, size: 4_000_000 });
			}
		}
		return objects;
	}

	function mp4Deps(objects: { key: string; size: number }[]) {
		return {
			listAll: async (_o: string, prefix: string) =>
				objects.filter((x) => x.key.startsWith(prefix)),
			fetchObject: async (_o: string, key: string) => key,
			fetchConcatenated: async (_o: string, keys: string[]) =>
				keys[keys.length - 1] ?? "",
			probe: async (p: string) => ({
				height: heightOfKey(p),
				width: (heightOfKey(p) * 16) / 9,
				videoCodec: "h264",
				durationSec: 12,
			}),
			scanBoxes: async () => ({
				psshSystemIds: ["9a04f07998404286ab92e65be0885f95"],
				schemeType: "cenc",
				ivSizeBytes: 8,
			}),
			readText: async () => "<xml/>",
			parseHls: async () => ({ variants: [], media: [], version: 4 }),
			parseDash: async () => ({ representations: [], periods: 1 }),
			reference: { durationSec: 12 },
		} as never;
	}

	/**
	 * SEVEN rungs, matching the seven per-title muxings this fixture declares. My first
	 * version used four and the rung-count check failed it — which is the count check
	 * doing its job on its author for the second time in one file.
	 */
	const RUNG_DIRS = [
		"180p_400000",
		"360p_300000",
		"360p_600000",
		"540p_1500000",
		"720p_3000000",
		"900p_4000000",
		"1080p_6000000",
	];

	it("probes each rung's own file instead of the same one four times", async () => {
		const report = await verifyArtefacts(
			mp4Expected,
			mp4Deps(mp4World(RUNG_DIRS)),
		);
		// One `:file` check per (muxing, rung) — the aliasing bug produced none of these.
		const perRung = report.checks.filter((c) =>
			/:180p_400000:file$/.test(c.id),
		);
		expect(perRung.length, "per-rung file checks emitted").toBeGreaterThan(0);
		// And each rung's own height must have been read, not one height four times.
		const heights = report.checks.filter((c) => /:height$/.test(c.id));
		expect(heights.length).toBeGreaterThan(3);
	});

	it("FAILS when a rung directory holds the WRONG file", async () => {
		/**
		 * NOT "a rung's file is missing" — that test was unsupportable and only passed
		 * because the rung bound was over-tight (review catch).
		 *
		 * For a single-file container, deleting the only object in a rung directory makes
		 * the DIRECTORY cease to exist, and "the file is missing" and "per-title pruned
		 * that rung" are then the same bytes on disk. The listing cannot tell them apart,
		 * so no honest check can. What IS checkable is a rung directory that exists and
		 * holds something other than what the muxing names.
		 */
		const objects = mp4World(RUNG_DIRS).map((o) =>
			o.key.includes("540p_1500000")
				? { ...o, key: o.key.replace("video.ismv", "video.mp4") }
				: o,
		);
		const report = await verifyArtefacts(mp4Expected, mp4Deps(objects));
		const fails = report.checks.filter((c) => c.verdict === "FAIL");
		expect(
			fails.some((c) => /540p_1500000:file$/.test(c.id)),
			`failures were [${fails.map((f) => f.id).join(", ")}]`,
		).toBe(true);
	});
});

/**
 * C3 from the second review: per-title MANIFESTS were asserted against the plan's
 * TEMPLATE count.
 *
 * The muxing side already reasoned that the encoder chooses the ladder — `expected.ts`
 * emits a note saying exactly that — and the manifest side had not, so a CORRECT
 * per-title encode failed `manifest:dash:representations` and `manifest:hls:variants`.
 * The reviewer measured `8 representation(s) — 4` and `7 video variant(s) — 3` against a
 * manifest honestly describing the rungs that were produced. That hit 12 of the 14
 * per-title fixtures, so "per-title cannot go green" was fixed for muxings and still true
 * for manifests.
 */
describe("per-title manifests describe the ENCODER's ladder", () => {
	it("accepts a legitimate ladder whose manifests honestly describe it", async () => {
		/**
		 * FOUR rungs, not three, and every FAIL inspected — not just the manifest ones.
		 *
		 * This test filtered to `c.id.startsWith("manifest:")` while, in the same report,
		 * `:rungs` was failing 14 times because 3 rungs is below the fixed floor of 4. It
		 * asserted a ladder was accepted while the report in its own hand rejected it, and
		 * the filter hid the contradiction — the third time in this file that an assertion
		 * was narrowed until it could only see the half that agreed (review catch).
		 *
		 * So: a genuinely legitimate size, and the assertion covers the whole report.
		 */
		const four = RUNGS.slice(0, 4);
		const report = await verifyArtefacts(
			expected,
			deps(world(four), heightOfKey, four.length),
		);
		expect(
			report.checks
				.filter((c) => c.verdict === "FAIL")
				.map((f) => `${f.id}: ${f.detail}`),
			"a correct 4-rung result with honest manifests must be wholly green",
		).toEqual([]);
	});

	it("WARNS on a per-title MPD with more representations than templates", async () => {
		/**
		 * This test used to require a FAIL, and a real run refuted the bound it enforced.
		 *
		 * `pertitle-av1-fmp4-dash-on-aws` declares 2 per-title video muxings and its MPD
		 * honestly enumerates 5 representations (1 audio + 4 video rungs). Two of those rungs
		 * are produced by the plan's OWN perTitle config —
		 * `forcedRenditionAboveHighestFixedRepresentation: 1` at factor 1.2 predicts
		 * 1346567 × 1.2 = 1615880.4, matching the observed `720p_1615880`, and
		 * `minBitrate: 128000` matches `360p_128000` exactly. The encoder was right and the
		 * assertion was wrong, in the same way and for the same reason as the muxing-side
		 * ceiling this file already corrected.
		 *
		 * So an over-count is still REPORTED — it is worth a human's attention — but as a WARN.
		 * The floor remains a FAIL, and the two tests after this one pin it.
		 */
		const report = await verifyArtefacts(
			expected,
			deps(world(RUNGS), heightOfKey, RUNGS.length + 20),
		);
		const over = report.checks.filter((c) =>
			/manifest:dash:representations-above-templates$/.test(c.id),
		);
		expect(over.length, "the over-count must be reported").toBe(1);
		expect(over[0]?.verdict).toBe("WARN");
		expect(
			report.checks
				.filter(
					(c) =>
						c.verdict === "FAIL" && /manifest:dash:representations/.test(c.id),
				)
				.map((c) => c.id),
			"an honest over-count is not a product failure",
		).toEqual([]);
	});

	it("FAILS a per-title MPD declaring fewer representations than it has audio", async () => {
		// The floor: audio is NOT per-title, so its count is exact and the MPD can never
		// have fewer representations than the audio renditions plus one video rung.
		const report = await verifyArtefacts(
			expected,
			deps(world(RUNGS), heightOfKey, 0),
		);
		const fails = report.checks.filter((c) => c.verdict === "FAIL");
		expect(
			fails.some((c) => /manifest:dash:representations$/.test(c.id)),
			`failures were [${fails.map((f) => f.id).join(", ")}]`,
		).toBe(true);
	});

	it("WARNS, and does not FAIL, on a master with more variants than templates", async () => {
		/**
		 * The HLS twin of the correction above. The old comment read "per-title selects from the
		 * ladder the templates describe, so a master with more variants than templates is
		 * wrong" — a reasonable belief that the artefacts do not support.
		 *
		 * Reported, not failed: a reader should still see the discrepancy.
		 */
		const report = await verifyArtefacts(
			expected,
			deps(world(RUNGS), heightOfKey, RUNGS.length + 3),
		);
		const over = report.checks.filter((c) =>
			/manifest:hls:variants-above-templates$/.test(c.id),
		);
		expect(over.length, "the over-count must be reported").toBe(1);
		expect(over[0]?.verdict).toBe("WARN");
		expect(
			report.checks
				.filter(
					(c) => c.verdict === "FAIL" && /manifest:hls:variants/.test(c.id),
				)
				.map((c) => c.id),
		).toEqual([]);
	});

	it("still FAILS a manifest that declares no variants at all", async () => {
		const report = await verifyArtefacts(
			expected,
			deps(world(RUNGS), heightOfKey, 0),
		);
		const fails = report.checks.filter((c) => c.verdict === "FAIL");
		expect(
			fails.some((c) => /manifest:hls/.test(c.id)),
			`failures were [${fails.map((f) => f.id).join(", ")}]`,
		).toBe(true);
	});
});

/**
 * The individual assertions inside the per-title branch, each pinned on its own.
 *
 * A reviewer's mutation battery deleted the per-rung codec check and the per-rung
 * init-segment check and the whole suite stayed green — so "disabling the branch fails all
 * three" was true and also the weakest claim available. Deleting one assertion is the
 * realistic regression; deleting the branch is not.
 */
describe("each per-rung assertion, pinned", () => {
	it("FAILS when one rung was encoded with the wrong codec", async () => {
		const report = await verifyArtefacts(
			expected,
			deps(world(RUNGS), (k) => heightOfKey(k), RUNGS.length),
		);
		// Control: the correct world has no codec failure.
		expect(
			report.checks.filter((c) => c.verdict === "FAIL" && /:codec$/.test(c.id)),
		).toEqual([]);

		const objects = world(RUNGS);
		const wrongCodec = await verifyArtefacts(expected, {
			...(deps(objects, heightOfKey, RUNGS.length) as object),
			probe: async (p: string) =>
				/audio/.test(p)
					? {
							audioCodec: "aac",
							sampleRate: 48_000,
							channels: 2,
							channelLayout: "stereo",
							durationSec: 12,
						}
					: {
							height: heightOfKey(p),
							// One rung came out VP9 in an H264 ladder.
							videoCodec: p.includes("540p") ? "vp9" : "h264",
							durationSec: 12,
							fps: 25,
						},
		} as never);
		const fails = wrongCodec.checks.filter((c) => c.verdict === "FAIL");
		expect(
			fails.some((c) => /540p_1500000:codec$/.test(c.id)),
			`failures were [${fails.map((f) => f.id).join(", ")}]`,
		).toBe(true);
	});

	it("FAILS when one rung is missing its init segment", async () => {
		const objects = world(RUNGS).filter(
			(o) => !(o.key.includes("720p_3000000") && o.key.endsWith("init.mp4")),
		);
		const report = await verifyArtefacts(
			expected,
			deps(objects, heightOfKey, RUNGS.length),
		);
		const fails = report.checks.filter((c) => c.verdict === "FAIL");
		expect(
			fails.some((c) => /720p_3000000:init$/.test(c.id)),
			`failures were [${fails.map((f) => f.id).join(", ")}]`,
		).toBe(true);
	});
});

/**
 * Which check actually carries the collapsed-ladder signal — measured, because I bounded
 * the manifest assertions loosely on purpose and needed to know what that costs.
 *
 * A reviewer suggested cross-checking the rung count against the manifest's own
 * representation count. That cannot work: the manifest states the ENCODER's ladder, which
 * is precisely why asserting it against the plan's template count was a false FAIL (C3).
 * So the manifest arms are deliberately permissive, and the question is what is left
 * holding the line.
 *
 * Answer, measured: for a ladder that produced 3 CORRECT rungs where 7 were declared,
 * `:rungs` fails 14 times and the manifest checks fail **zero** times. So `:rungs` is the
 * only thing that detects a collapsed ladder. That is worth knowing rather than
 * assuming — if anyone ever loosens it, nothing downstream will notice.
 */
describe("who catches a partially collapsed ladder", () => {
	it("is `:rungs`, and NOT the manifest bounds", async () => {
		const three = RUNGS.slice(0, 3);
		const report = await verifyArtefacts(
			expected,
			deps(world(three), heightOfKey, three.length),
		);
		const fails = report.checks.filter((c) => c.verdict === "FAIL");
		expect(
			fails.filter((c) => /:rungs$/.test(c.id)).length,
			"the rung-count check must fire",
		).toBeGreaterThan(0);
		expect(
			fails.filter((c) => c.id.startsWith("manifest:")).map((c) => c.id),
			"the manifest bounds are permissive by design and cannot see this",
		).toEqual([]);
		// So every FAIL here is a rung-count FAIL. If that stops being true, the comment
		// above is stale and someone should re-derive which check is load-bearing.
		expect(fails.every((c) => /:rungs$/.test(c.id))).toBe(true);
	});
});

/**
 * The rung band, over every ladder size — the table a review measured against the old
 * bound, kept as the pin.
 *
 * The semantics come from the Bitmovin encoding API, not from the fixtures: a
 * `PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE` stream is never pruned and always
 * yields exactly one rung, while a plain `PER_TITLE_TEMPLATE` is a convex-hull CANDIDATE
 * that the algorithm routinely drops — for no perceptual gain on low-motion content, a
 * target height above the source's, `maxBitrate`/step-size pruning, or redundancy against
 * a fixed rung. Zero rungs from a flexible template is correct behaviour.
 *
 * `pertitle-h264-openapi` declares 4 fixed + 3 flexible, so 4..7 rungs are ALL correct
 * results and only below 4 is a real defect. My previous bound of `fixed + templates`
 * demanded 7 and failed the legitimate 4 — a false red introduced while fixing a false
 * green, in the round whose purpose was removing false reds.
 */
describe("the rung band accepts every legitimate ladder size", () => {
	for (const size of [7, 6, 5, 4]) {
		it(`accepts ${size} rungs (4 fixed are guaranteed, ${7 - size} flexible pruned)`, async () => {
			const report = await verifyArtefacts(
				expected,
				deps(world(RUNGS.slice(0, size)), heightOfKey, size),
			);
			expect(
				report.checks
					.filter((c) => c.verdict === "FAIL" && /:rungs$/.test(c.id))
					.map((c) => c.detail),
			).toEqual([]);
		});
	}

	for (const size of [3, 1]) {
		it(`FAILS ${size} rungs — below the ${4} fixed muxings' guarantee`, async () => {
			const report = await verifyArtefacts(
				expected,
				deps(world(RUNGS.slice(0, size)), heightOfKey, size),
			);
			expect(
				report.checks.filter(
					(c) => c.verdict === "FAIL" && /:rungs$/.test(c.id),
				).length,
				"a ladder below the fixed floor is a real defect",
			).toBeGreaterThan(0);
		});
	}
});

/**
 * The band's blind spot, tested rather than reasoned about.
 *
 * `[fixed, total]` deliberately accepts 4..7 rungs, so the obvious worry is a ladder that
 * sits INSIDE the band and is still broken — every fixed rung present, but each one short
 * of content. If the band were the only per-title check, that would pass.
 *
 * Measured: it does not. At the legitimate 4 rungs, 2 segments each is green; 1 segment
 * each fails `:segment-count` 58 times; 0 fails `:segments` 37 times. So the band bounds
 * the ladder's SHAPE and the per-rung checks bound its CONTENT, and neither substitutes
 * for the other.
 */
describe("a ladder inside the band but short of content", () => {
	/** Four rungs — the legitimate minimum — with `segs` segments in each. */
	function shortWorld(segs: number) {
		const four = RUNGS.slice(0, 4).map((r) => ({ ...r, segs }));
		return world(four);
	}

	it("is green at the correct segment count", async () => {
		const report = await verifyArtefacts(
			expected,
			deps(shortWorld(2), heightOfKey, 4),
		);
		expect(
			report.checks.filter((c) => c.verdict === "FAIL").map((c) => c.id),
		).toEqual([]);
	});

	it("FAILS per rung when every rung is one segment short", async () => {
		const report = await verifyArtefacts(
			expected,
			deps(shortWorld(1), heightOfKey, 4),
		);
		const fails = report.checks.filter((c) => c.verdict === "FAIL");
		expect(
			fails.every((c) => /:segment-count$/.test(c.id)),
			`unexpected failures: ${fails.map((f) => f.id).join(", ")}`,
		).toBe(true);
		// Per rung, not once for the ladder — the whole point of the rung partitioning.
		expect(fails.length).toBeGreaterThan(4);
	});

	it("FAILS when a rung has no segments at all", async () => {
		const report = await verifyArtefacts(
			expected,
			deps(shortWorld(0), heightOfKey, 4),
		);
		expect(
			report.checks.some(
				(c) => c.verdict === "FAIL" && /:segments$/.test(c.id),
			),
		).toBe(true);
	});
});

/**
 * With no reference duration, the per-rung count check must SKIP — never vanish.
 *
 * The non-per-title path had this `else`; the per-rung path did not. So on a run where
 * the source could not be probed, **56 per-rung checks simply disappeared** and a broken
 * ladder reported zero FAILs — while `verifyJob` had already logged "reference
 * unavailable … duration-derived checks will SKIP", a promise this path did not keep.
 *
 * This is the hardest class to test for, and the reason it needs its own case: every
 * other assertion in this file inspects checks that EXIST, so an absent check is
 * invisible to all of them. The only way to see it is to count.
 */
describe("no reference duration", () => {
	function noReference(objects: { key: string; size: number }[]) {
		const base = deps(objects, heightOfKey, 4) as Record<string, unknown>;
		const { reference: _dropped, ...rest } = base;
		return rest as never;
	}

	it("emits a SKIP per rung rather than nothing at all", async () => {
		const four = RUNGS.slice(0, 4);
		const report = await verifyArtefacts(expected, noReference(world(four)));
		const counts = report.checks.filter((c) => /:segment-count$/.test(c.id));
		expect(
			counts.length,
			"per-rung count checks must still be emitted, as SKIPs",
		).toBeGreaterThan(4);
		expect(counts.every((c) => c.verdict === "SKIP")).toBe(true);
		expect(counts[0]?.detail).toMatch(/no reference duration/);
	});

	it("emits the SAME number of count checks with and without a reference", async () => {
		// The exact property that was violated: the shape of the report must not depend on
		// whether the source could be probed — only the verdicts may.
		const four = RUNGS.slice(0, 4);
		const withRef = await verifyArtefacts(
			expected,
			deps(world(four), heightOfKey, 4),
		);
		const without = await verifyArtefacts(expected, noReference(world(four)));
		const ids = (r: typeof withRef) =>
			r.checks
				.filter((c) => /:segment-count$/.test(c.id))
				.map((c) => c.id)
				.sort();
		expect(ids(without)).toEqual(ids(withRef));
	});

	it("does not report a BROKEN ladder as green when the reference is missing", async () => {
		// One segment where two are wanted. With a reference this is 56 FAILs; without one
		// it must be 56 SKIPs — and in neither case a silent pass.
		const short = RUNGS.slice(0, 4).map((r) => ({ ...r, segs: 1 }));
		const report = await verifyArtefacts(expected, noReference(world(short)));
		const counts = report.checks.filter((c) => /:segment-count$/.test(c.id));
		expect(counts.length).toBeGreaterThan(4);
		expect(
			counts.every((c) => c.verdict === "SKIP"),
			"unchecked, and SAYING so",
		).toBe(true);
	});
});

describe("per-title masters are walked and counted too (review-325 I2, ledger #207)", () => {
	it("a per-title child playlist that never closes FAILS by name — the walk is discovery-based, not template-sized", async () => {
		// `deps` is typed `never` for the engine's benefit; the arms below spread
		// it, so name the two members they override.
		const base = deps(world(RUNGS), heightOfKey) as unknown as {
			readText(o: string, k: string): Promise<string>;
		} & Record<string, unknown>;
		const report = await verifyArtefacts(expected, {
			...base,
			readText: async (o: string, k: string) =>
				k.endsWith("/v0/index.m3u8")
					? (await base.readText(o, k)).replace("#EXT-X-ENDLIST\n", "")
					: base.readText(o, k),
		} as never);
		const fails = report.checks
			.filter((c) => c.verdict === "FAIL")
			.map((c) => c.id);
		expect(fails).toContain("manifest:hls:child:v0-index-m3u8:endlist");
	});

	it("a per-title MPD whose every representation is audio FAILS the video floor (paid case 8 on a per-title ladder)", async () => {
		// `deps` is typed `never` for the engine's benefit; the arms below spread
		// it, so name the two members they override.
		const base = deps(world(RUNGS), heightOfKey) as unknown as {
			readText(o: string, k: string): Promise<string>;
		} & Record<string, unknown>;
		const report = await verifyArtefacts(expected, {
			...base,
			parseDash: async () => ({
				representations: Array.from({ length: RUNGS.length + 1 }, () => ({
					addressing: "TEMPLATE" as const,
					kind: "audio" as const,
				})),
				periods: 1,
			}),
		} as never);
		const fails = report.checks
			.filter((c) => c.verdict === "FAIL")
			.map((c) => c.id);
		expect(fails).toContain("manifest:dash:video-representations");
	});
});
