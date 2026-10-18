import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileExpectedArtefacts, encodingPlanSchema } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { verifyArtefacts } from "./engine";

const F = join(
	import.meta.dirname,
	"../../../../packages/core/src/plan/__fixtures__",
);
const load = (n: string) =>
	compileExpectedArtefacts(
		encodingPlanSchema.parse(
			JSON.parse(readFileSync(join(F, `${n}.plan.json`), "utf8")),
		),
	);

/**
 * The four false verdicts a review found, each pinned by the case that exposed it.
 *
 * All four are the same shape and it is the dangerous one: the engine returning a
 * confident answer about an artefact it had not actually examined, or examining it with
 * the wrong instrument. A missing check announces itself as a SKIP; a wrong PASS does
 * not, and a wrong FAIL trains everyone to ignore the report.
 *
 *   pssh              counted, never matched to the configured system — a plan
 *                     configuring Widevine only passed against an init segment carrying
 *                     the PlayReady system id
 *   WebM              `webmMuxingSchema` sets `initSegmentName: "init.hdr"`, so an EBML
 *                     file was handed to the MP4 box walker, which found no `pssh` and
 *                     FAILED a correct encode
 *   audio-only HLS    "0 variants ⇒ media playlist" made a correct audio-only master
 *                     fail one of `:variants` or `:endlist` whichever branch it took
 *   FairPlay/TS       covered by the SKIP message asserted in engine.test.ts — TS
 *                     signals encryption in the playlist, so a box scan is the wrong
 *                     instrument, not merely an unavailable one
 */

const WIDEVINE = "edef8ba979d64acea3c827dcd51d21ed";
const PLAYREADY = "9a04f07998404286ab92e65be0885f95";

function deps(over: Record<string, unknown> = {}) {
	return {
		listAll: async (_o: string, p: string) => [
			{ key: `${p}init.mp4`, size: 900 },
			{ key: `${p}seg_1.m4s`, size: 500_000 },
			{ key: `${p}seg_2.m4s`, size: 500_000 },
			{ key: `${p}init.hdr`, size: 900 },
			{ key: `${p}seg_1.webm`, size: 500_000 },
			{ key: `${p}seg_2.webm`, size: 500_000 },
		],
		fetchObject: async (_o: string, k: string) => k,
		// Permissive on purpose: the fMP4 assembly rule is modelled in engine-fmp4-probe.test.ts,
		// which is the test about it. Here it only has to not be the missing dep.
		fetchConcatenated: async (_o: string, keys: string[]) =>
			keys[keys.length - 1] ?? "",
		probe: async () => ({
			height: 720,
			width: 1280,
			videoCodec: "vp9",
			durationSec: 12,
		}),
		scanBoxes: async () => ({
			psshSystemIds: [PLAYREADY],
			schemeType: "cenc",
			ivSizeBytes: 8,
		}),
		// The master keeps its bare stub; every CHILD the fake parser names (`a1.m3u8`,
		// `a2.m3u8`) reads as a healthy closed fMP4 media playlist, because the engine now
		// walks the children the master references  and an empty child is a
		// real defect, not a neutral stub.
		readText: async (_o: string, k: string) =>
			/\/a\d\.m3u8$/.test(k)
				? '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.000,\nseg_1.m4s\n#EXTINF:4.000,\nseg_2.m4s\n#EXT-X-ENDLIST\n'
				: "#EXTM3U\n#EXT-X-VERSION:4\n",
		parseHls: async () => ({
			// TWO variants, not zero.
			//
			// This stub returned `variants: []`, and a reviewer showed that made the test
			// blind to its own subject: with zero variants the REVERTED code computes
			// `0 === videoEntries(0)` → PASS, so the mutation survived. A real audio-only
			// master carries its renditions as EXT-X-STREAM-INF entries — the engine's own
			// comment says so — and at two variants the reverted code computes `2 === 0` →
			// FAIL, which is the false verdict being fixed. A world in which the bug cannot
			// occur cannot pin the fix.
			variants: [{ uri: "a1.m3u8" }, { uri: "a2.m3u8" }],
			media: [{ type: "AUDIO" }],
			version: 4,
		}),
		parseDash: async () => ({ representations: [], periods: 1 }),
		reference: { durationSec: 12 },
		...over,
	} as never;
}

describe("false verdicts the review found", () => {
	it("FAILS a pssh for the WRONG system (a Widevine plan, a PlayReady box)", async () => {
		const e = load("cenc-cbc-drm-on-aws");
		const report = await verifyArtefacts(e, deps());
		const pssh = report.checks.filter((c) => /:pssh$/.test(c.id));
		expect(pssh.length, "pssh checks must exist").toBeGreaterThan(0);
		const failed = pssh.filter((c) => c.verdict === "FAIL");
		expect(
			failed.length,
			`pssh verdicts: ${pssh.map((c) => c.verdict).join(",")}`,
		).toBeGreaterThan(0);
		expect(failed[0]?.detail).toMatch(/missing/);
	});

	it("PASSES when every configured system is present", async () => {
		const e = load("cenc-cbc-drm-on-aws");
		const report = await verifyArtefacts(
			e,
			deps({
				scanBoxes: async () => ({
					psshSystemIds: [
						WIDEVINE,
						PLAYREADY,
						"94ce86fb07ff4f43adb893d2fa968ca2",
					],
					schemeType: "cbcs",
					ivSizeBytes: 16,
					defaultKid: "43214321432143214321432143214321",
				}),
			}),
		);
		const pssh = report.checks.filter((c) => /:pssh$/.test(c.id));
		expect(
			pssh.every((c) => c.verdict === "PASS"),
			pssh.map((c) => c.detail).join(" | "),
		).toBe(true);
	});

	it("SKIPS WebM DRM with a named reason instead of FAILING a correct encode", async () => {
		const e = load("pertitle-vp9-webm-cenc-drm-on-aws");
		// The audio leg of this fixture is FMP4, so it correctly goes through the box scan;
		// only the WebM video rows must be skipped rather than failed.
		const report = await verifyArtefacts(e, deps());
		const webm = report.checks.filter((c) => /^drm:v\d/.test(c.id));
		expect(webm.length, "WebM DRM rows must produce a verdict").toBeGreaterThan(
			0,
		);
		expect(
			webm.filter((c) => c.verdict === "FAIL").map((c) => c.id),
			"a correct WebM encode must not FAIL on MP4 boxes",
		).toEqual([]);
		expect(
			webm.some((c) => c.verdict === "SKIP" && /EBML/.test(c.detail ?? "")),
		).toBe(true);
	});

	it("does not fail an audio-only HLS master on :variants or :endlist", async () => {
		const e = load("audio-only-aac-fmp4-hls-dash");
		const report = await verifyArtefacts(e, deps());
		const bad = report.checks.filter(
			(c) => c.verdict === "FAIL" && /(:variants|:endlist)$/.test(c.id),
		);
		expect(bad.map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
	});
});

/**
 * Verdicts that the design fixes in place, and that nothing was holding there.
 *
 * A reviewer's mutation battery found four assertions inside the new per-title branch and
 * one hygiene verdict that could be deleted or downgraded with the whole suite still
 * green — so #43's claim that "disabling the branch fails all three" was true but the
 * weakest available statement. These pin the individual decisions.
 */
describe("verdicts pinned where the design puts them", () => {
	it("foreign objects are FAIL, not WARN — the flag exists to make them fatal", async () => {
		const e = load("fixed-bitrate-hls-on-aws");
		const report = await verifyArtefacts(e, {
			...(deps() as object),
			// One object the plan never declares, under a prefix it owns.
			foreignKeyFilter: (key: string) => key.includes("stranger"),
			listAll: async (_o: string, p: string) => [
				{ key: `${p}init.mp4`, size: 900 },
				{ key: `${p}segment_1.m4s`, size: 500_000 },
				{ key: `${p}segment_2.m4s`, size: 500_000 },
				{ key: `${p}stranger.ts`, size: 42 },
			],
		} as never);
		const hygiene = report.checks.find(
			(c) => c.id === "hygiene:foreign-objects",
		);
		expect(hygiene, "the hygiene check must be emitted").toBeDefined();
		expect(
			hygiene?.verdict,
			"design §8 makes contamination a FAIL, and `--strict-prefix` exists to make it fatal",
		).toBe("FAIL");
	});

	/**
	 * The detail NAMES what it found .
	 *
	 * The billed re-audit's whole report was 481 PASS and this line reading
	 * "…this run did not write — 6". A bare count is the one finding that can be
	 * neither diagnosed nor argued with: turning that 6 into "the six per-title
	 * variant playlists" took a separate investigation of the bucket.
	 */
	it("names the foreign objects instead of only counting them", async () => {
		const e = load("fixed-bitrate-hls-on-aws");
		const report = await verifyArtefacts(e, {
			...(deps() as object),
			foreignKeyFilter: (key: string) => key.includes("stranger"),
			listAll: async (_o: string, p: string) => [
				{ key: `${p}init.mp4`, size: 900 },
				{ key: `${p}stranger.ts`, size: 42 },
			],
		} as never);
		const hygiene = report.checks.find(
			(c) => c.id === "hygiene:foreign-objects",
		);
		expect(hygiene?.detail).toMatch(/stranger\.ts/);
	});

	/**
	 * One object listed under two overlapping prefixes is ONE contamination.
	 *
	 * A plan's manifest prefix is usually the parent of every muxing prefix, so
	 * the sweep lists the same key more than once and used to add one to the count
	 * each time. An operator reading "6" cannot tell six strangers from two seen
	 * three times, and the number is what the report gates on.
	 */
	it("counts one object once, however many prefixes reach it", async () => {
		const e = load("fixed-bitrate-hls-on-aws");
		const report = await verifyArtefacts(e, {
			...(deps() as object),
			foreignKeyFilter: (key: string) => key.includes("stranger"),
			// Every prefix returns the SAME one stranger, at a fixed key.
			listAll: async () => [
				{ key: "out/stranger.ts", size: 42 },
				{ key: "out/init.mp4", size: 900 },
			],
		} as never);
		const hygiene = report.checks.find(
			(c) => c.id === "hygiene:foreign-objects",
		);
		expect(hygiene?.verdict).toBe("FAIL");
		expect(hygiene?.detail).toMatch(/— 1: out\/stranger\.ts/);
	});

	it("a Smooth manifest with ZERO QualityLevels still gets a verdict", async () => {
		// The check used to be wrapped in `if (levels > 0)`, so it disappeared exactly when
		// the artefact was emptiest — the same "a parser accepted it ≠ it is a playlist"
		// defect already fixed for HLS, left unfixed for Smooth.
		const e = load("pertitle-h264-mp4-smooth-drm-on-aws");
		const report = await verifyArtefacts(e, {
			...(deps() as object),
			readText: async () => "<SmoothStreamingMedia></SmoothStreamingMedia>",
		} as never);
		const levels = report.checks.filter((c) => /:quality-levels$/.test(c.id));
		expect(levels.length, "a verdict, not silence").toBeGreaterThan(0);
		expect(levels.every((c) => c.verdict === "FAIL")).toBe(true);
	});
});

/**
 * A muxing whose DRM rows point at TWO different outputs.
 *
 * `directoriesFor`'s own comment says "a row may point at a different output entirely",
 * and every fetch used `dirs[0].outputKey` while `keys` came from all of them — so a key
 * listed from the second output was downloaded from the FIRST bucket. Either a 404
 * reported as a probe failure, or, worse, a same-named object in the wrong bucket probed
 * as though it were this one, which is a green check about a file that is not the artefact.
 *
 * No fixture routes a muxing to two outputs (I checked all 66), so this is the only place
 * the behaviour can be observed — which is exactly why it needs a test rather than a
 * note: a latent wrong-bucket read in a verifier is not something to leave standing.
 */
describe("a muxing routed to two outputs", () => {
	it("FAILS when one of two destinations received NOTHING", async () => {
		/**
		 * The worse half of the wrong-bucket finding, and the one I had not fixed.
		 *
		 * `keys` is the union across every destination, so a muxing writing to two outputs
		 * passed every check on ONE output's artefacts while the other produced nothing.
		 * A reviewer built exactly this: outA's DRM leg wrote nothing, outB wrote
		 * correctly, and `muxing:v720:init` came out PASS.
		 */
		const e = load("cenc-cbc-drm-on-aws");
		const firstDrm = e.drm[0];
		if (!firstDrm?.dir) {
			throw new Error("fixture has no DRM destination");
		}
		const mirror = {
			...firstDrm,
			drmKey: `${firstDrm.drmKey}-mirror`,
		} as typeof firstDrm;
		(mirror as { outputKey: string }).outputKey = "empty-output";
		e.drm.push(mirror);
		const target = e.muxings.find((m) =>
			m.viaDrmKeys?.includes(firstDrm.drmKey),
		);
		target?.viaDrmKeys?.push(mirror.drmKey);

		const report = await verifyArtefacts(e, {
			...(deps() as object),
			// The mirror destination is empty; the original has everything.
			listAll: async (outputKey: string, p: string) =>
				outputKey === "empty-output"
					? []
					: [
							{ key: `${p}init.mp4`, size: 900 },
							{ key: `${p}segment_1.m4s`, size: 500_000 },
							{ key: `${p}segment_2.m4s`, size: 500_000 },
						],
		} as never);

		const fails = report.checks.filter((c) => c.verdict === "FAIL");
		expect(
			fails.some((c) => /:dest:empty-output$/.test(c.id)),
			`failures were [${fails.map((f) => f.id).join(", ")}]`,
		).toBe(true);
		expect(
			fails.find((c) => /:dest:empty-output$/.test(c.id))?.detail,
			"the report must say another destination cannot stand in",
		).toMatch(/cannot stand in/);
	});

	it("fetches an init segment from the output it was LISTED from", async () => {
		// The muxing path only. My first version of this test asserted "some fetch named
		// the mirror output", which `verifyDrm` satisfies on its own — it fetches with
		// `drm.outputKey` directly — so the test was green with the fix reverted. Third
		// time in this branch that a test of mine was green for the wrong reason, and the
		// only reason I caught it was running the mutation.
		//
		// So this asserts the specific pairing: the init segment exists ONLY under the
		// mirror output, and must therefore be fetched from it.
		const e = load("cenc-cbc-drm-on-aws");
		const firstDrm = e.drm[0];
		if (!firstDrm?.dir) {
			throw new Error("fixture has no DRM destination");
		}
		const mirror = {
			...firstDrm,
			drmKey: `${firstDrm.drmKey}-mirror`,
		} as typeof firstDrm;
		(mirror as { outputKey: string }).outputKey = "mirror-output";
		e.drm.push(mirror);
		const target = e.muxings.find((m) =>
			m.viaDrmKeys?.includes(firstDrm.drmKey),
		);
		if (!target?.initSegment) {
			throw new Error("no DRM-routed muxing with an init segment");
		}
		target.viaDrmKeys?.push(mirror.drmKey);

		const fetched: { outputKey: string; key: string }[] = [];
		await verifyArtefacts(e, {
			...(deps() as object),
			// The init segment is present under the MIRROR output only. `dirs[0]` is the
			// original, so a `dirs[0]`-based fetch names the wrong bucket for it.
			listAll: async (outputKey: string, p: string) =>
				outputKey === "mirror-output"
					? [{ key: `${p}${target.initSegment}`, size: 900 }]
					: [{ key: `${p}other.m4s`, size: 500 }],
			fetchConcatenated: async (_o: string, keys: string[]) =>
				keys[keys.length - 1] ?? "",
			fetchObject: async (outputKey: string, key: string) => {
				fetched.push({ outputKey, key });
				return key;
			},
		} as never);

		const initFetches = fetched.filter((f) =>
			f.key.endsWith(target.initSegment as string),
		);
		expect(
			initFetches.length,
			"the init segment must have been fetched",
		).toBeGreaterThan(0);
		// Every fetch of THAT key must name the bucket it actually lives in.
		expect(
			initFetches.filter((f) => f.outputKey !== "mirror-output"),
			"an init segment listed from mirror-output was fetched from another bucket",
		).toEqual([]);
	});
});

/**
 * `postEncoding` is not "per-title", and conflating them loosened 15 plans that know
 * their exact rendition count.
 *
 * I relaxed the manifest entry-count assertions from equality to a range to fix a real
 * false FAIL on per-title — and branched the relaxation on `manifest.postEncoding`, which
 * is true for per-title AND for multi-encoding AND for any plan that simply declares
 * `generation.timing: POST_ENCODING`. That is precisely the distinction an earlier fix in
 * this same branch had established, and I then erased it.
 *
 * 15 fixtures are postEncoding with NO per-title muxing, including every Dolby ladder —
 * "the most complex orchestration in scope" per the shared contract. A reviewer measured a 3-ladder
 * that lost 11 of its 12 renditions reporting green.
 */
describe("a non-per-title postEncoding manifest keeps its exact count", () => {
	const NAME = "dolby-dv-hdr10-sdr-3ladder-profile5-single-input";

	function report(videoVariants: number, representations: number) {
		const e = load(NAME);
		return verifyArtefacts(e, {
			...(deps() as object),
			parseHls: async () => ({
				variants: Array.from({ length: videoVariants }, (_, i) => ({
					uri: `v${i}.m3u8`,
				})),
				media: [{ type: "AUDIO" }],
				version: 4,
			}),
			parseDash: async () => ({
				representations: Array.from({ length: representations }, () => ({
					addressing: "TEMPLATE" as const,
				})),
				periods: 1,
			}),
		} as never);
	}

	it("is postEncoding but NOT per-title, so the premise holds", () => {
		const e = load(NAME);
		expect(
			e.muxings.some((m) => m.perTitle),
			"no per-title muxing",
		).toBe(false);
		expect(
			e.manifests.some((m) => m.postEncoding),
			"but the manifests are postEncoding",
		).toBe(true);
		expect(e.manifests.every((m) => m.perTitle === false)).toBe(true);
	});

	it("FAILS a manifest describing 1 video rendition where 12 were declared", async () => {
		const r = await report(1, 3);
		const fails = r.checks.filter((c) => c.verdict === "FAIL");
		expect(
			fails.some((c) => /manifest:.*:variants$/.test(c.id)),
			`failures were [${fails.map((f) => f.id).join(", ")}]`,
		).toBe(true);
		expect(
			fails.some((c) => /manifest:.*:representations$/.test(c.id)),
			`failures were [${fails.map((f) => f.id).join(", ")}]`,
		).toBe(true);
	});

	it("PASSES the exact declared counts", async () => {
		const e = load(NAME);
		const dash = e.manifests.find((m) => m.kind === "DASH");
		const hls = e.manifests.find((m) => m.kind === "HLS");
		if (!dash || !hls) {
			throw new Error("fixture lacks a DASH or HLS manifest");
		}
		const r = await report(
			hls.videoEntries,
			dash.videoEntries + dash.audioEntries,
		);
		const countFails = r.checks.filter(
			(c) => c.verdict === "FAIL" && /(:variants|:representations)$/.test(c.id),
		);
		expect(countFails.map((c) => c.detail)).toEqual([]);
	});
});

/**
 * The Smooth arm's per-title discriminator, pinned synthetically.
 *
 * All three manifest arms relax an exact entry count to a range when the encoder chose the
 * ladder. HLS and DASH are pinned by the Dolby fixture — reverting either to
 * `postEncoding` fails it. SMOOTH could not be pinned that way, because no fixture is
 * postEncoding-and-Smooth-and-not-per-title, so reverting that arm alone survived the
 * whole suite (review catch). It is unobservable today and would return silently the day
 * such a fixture is added.
 *
 * A missing fixture is not a reason to leave an arm unguarded, so the expectation is
 * constructed: the real Smooth fixture with `perTitle` flipped off, which is exactly the
 * plan shape that has no representative on disk.
 */
describe("the Smooth quality-levels arm", () => {
	function smoothExpectation(perTitle: boolean) {
		const e = load("pertitle-h264-mp4-smooth-drm-on-aws");
		for (const m of e.manifests) {
			if (m.kind === "SMOOTH") {
				(m as { perTitle: boolean }).perTitle = perTitle;
			}
		}
		return e;
	}

	/** A Smooth manifest declaring `levels` QualityLevel elements. */
	function withLevels(levels: number) {
		return {
			...(deps() as object),
			readText: async () =>
				`<SmoothStreamingMedia>${"<QualityLevel/>".repeat(levels)}</SmoothStreamingMedia>`,
		} as never;
	}

	it("requires the EXACT count when the plan chose the ladder", async () => {
		const e = smoothExpectation(false);
		const smooth = e.manifests.find((m) => m.kind === "SMOOTH");
		if (!smooth) {
			throw new Error("fixture has no Smooth manifest");
		}
		const want = smooth.videoEntries + smooth.audioEntries;
		const short = await verifyArtefacts(e, withLevels(1));
		expect(
			short.checks
				.filter((c) => /:quality-levels$/.test(c.id))
				.map((c) => c.verdict),
			`a non-per-title Smooth manifest must require exactly ${want}`,
		).toContain("FAIL");

		const exact = await verifyArtefacts(e, withLevels(want));
		expect(
			exact.checks
				.filter((c) => /:quality-levels$/.test(c.id) && c.verdict === "FAIL")
				.map((c) => c.detail),
		).toEqual([]);
	});

	it("accepts fewer than declared when the ENCODER chose the ladder", async () => {
		// The other direction, so the arm is pinned rather than merely present: a per-title
		// Smooth manifest legitimately carries fewer levels than the templates declare.
		const perTitle = await verifyArtefacts(
			smoothExpectation(true),
			withLevels(1),
		);
		expect(
			perTitle.checks
				.filter((c) => /:quality-levels$/.test(c.id) && c.verdict === "FAIL")
				.map((c) => c.detail),
			"per-title must not be held to the template count",
		).toEqual([]);
	});
});

/**
 * The VOD zero-byte blind spot, closed — §9b had recorded it since phase A.
 *
 * `:segments` and `:segment-count` count FILES, so an origin write failure that truncates
 * every segment to zero bytes reads as a healthy encode. The live tier got this check from
 * the I8 fix and VOD never did. A reviewer pointed out that with a real corpus in flight it
 * is live ammunition — and it is a false GREEN, which is worse than a false red.
 */
describe("VOD segments must carry bytes", () => {
	/**
	 * §9b had recorded this since phase A — "nothing reads `ObjectEntry.size`, so a 0-byte
	 * segment still passes" — and the live tier got the check while VOD never did. A reviewer
	 * pointed out that with a real corpus in flight it is live ammunition, and it is a false
	 * GREEN, which is worse than a false red.
	 *
	 * The world is DERIVED from the expectation. My first version wrote guessed keys and the
	 * check was never reached, so the test reported the check missing rather than the bytes
	 * wrong — the guessed-world mistake, in the test written for a finding about guessing.
	 */
	function worldFor(
		e: ReturnType<typeof load>,
		size: number | undefined,
	): { key: string; size?: number }[] {
		const objects: { key: string; size?: number }[] = [];
		for (const m of e.muxings) {
			const base = m.dir.prefix.endsWith("/")
				? m.dir.prefix
				: `${m.dir.prefix}/`;
			if (m.initSegment) {
				objects.push({ key: `${base}${m.initSegment}`, size: 900 });
			}
			if (m.segmentNaming) {
				for (let i = 1; i <= 2; i++) {
					objects.push({
						key: `${base}${m.segmentNaming.replace(/%number%/g, String(i))}`,
						...(size !== undefined ? { size } : {}),
					});
				}
			}
		}
		for (const m of e.manifests) {
			for (const f of m.files) {
				objects.push({ key: `${m.dir.prefix}${f}`, size: 700 });
			}
		}
		return objects;
	}

	function runWith(size: number | undefined) {
		const e = load("fixed-bitrate-hls-on-aws");
		const objects = worldFor(e, size);
		return verifyArtefacts(e, {
			...(deps() as object),
			listAll: async (_o: string, p: string) =>
				objects.filter((x) => x.key.startsWith(p)),
		} as never);
	}

	it("FAILS an encode whose segments are all zero-length", async () => {
		const report = await runWith(0);
		const bytes = report.checks.filter((c) => /:segment-bytes$/.test(c.id));
		expect(bytes.length, "the check must be emitted").toBeGreaterThan(0);
		expect(bytes.some((c) => c.verdict === "FAIL")).toBe(true);
		expect(bytes.find((c) => c.verdict === "FAIL")?.detail).toMatch(
			/zero-length/,
		);
		// The count checks are blind to it, which is the entire point.
		expect(
			report.checks
				.filter((c) => /:segments$/.test(c.id))
				.every((c) => c.verdict === "PASS"),
		).toBe(true);
	});

	it("PASSES when the segments carry bytes", async () => {
		const report = await runWith(500_000);
		const bytes = report.checks.filter((c) => /:segment-bytes$/.test(c.id));
		expect(bytes.length).toBeGreaterThan(0);
		expect(bytes.every((c) => c.verdict === "PASS")).toBe(true);
	});

	it("SKIPs when the driver reports no sizes, rather than gating on a world value", async () => {
		const report = await runWith(undefined);
		const bytes = report.checks.filter((c) => /:segment-bytes$/.test(c.id));
		expect(bytes.length).toBeGreaterThan(0);
		expect(bytes.every((c) => c.verdict === "SKIP")).toBe(true);
	});
});
