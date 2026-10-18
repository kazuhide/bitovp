import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileExpectedArtefacts, encodingPlanSchema } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import type { EngineDeps, MediaProbe, ObjectEntry } from "./engine";
import { verifyArtefacts } from "./engine";

/**
 * A segment must be probed as the assembly a PLAYER would make, not as a lone object.
 *
 * This is the defect that made a real corpus run mostly red, and it was mine: the previous
 * round correctly established that an init segment has no frames, so `fps` and `bitrate` could
 * not be read from it — and fixed that by probing the first media segment INSTEAD. A bare fMP4
 * segment is `moof`+`mdat` with no `moov`, so ffprobe answers `Invalid data found when
 * processing input`, and 18 of 38 scenarios FAILed for it. One of them was
 * `fixed-bitrate-hls-on-aws`, whose bucket I had verified BY HAND minutes earlier — 4 muxing
 * directories, init + 2 segments each, `#EXT-X-TARGETDURATION:6`, two variants at 640x360 and
 * 960x540 — and found perfect. The harness was wrong, not the encode.
 *
 * WebM broke the same way on the per-title path: `pertitle-vp9-webm-fmp4-dash-on-aws` reported
 * `init.hdr: End of file`, because a WebM header with no cluster after it is a truncated file.
 *
 * So both paths now pass `[init, firstSegment]`, which is precisely what `EXT-X-MAP` and DASH's
 * `<Initialization>` tell a player to do. The fakes here MODEL that constraint — a bare `.m4s`
 * or a lone `.hdr` throws, exactly as ffprobe does — because a permissive fake is why nothing
 * in the repo could see the defect. Two mutations to the engine each fail a test below.
 */

const F = join(
	import.meta.dirname,
	"../../../../packages/core/src/plan/__fixtures__",
);

function planOf(name: string) {
	return encodingPlanSchema.parse(
		JSON.parse(readFileSync(join(F, `${name}.plan.json`), "utf8")),
	);
}

/**
 * A fake that refuses what real ffprobe refuses.
 *
 * `fetchConcatenated` joins with `+`, so the probe can tell an assembly from a lone object —
 * the distinction the whole defect turns on. Facts are declared per object and merged in order,
 * which is also the truth: geometry and codec come from the init's `moov`, frames from the
 * segment.
 */
function strictDeps(
	objects: string[],
	facts: Record<string, MediaProbe>,
	texts: Record<string, string> = {},
): { deps: EngineDeps; probed: string[] } {
	const probed: string[] = [];
	const deps: EngineDeps = {
		listAll: async (_o: string, prefix: string): Promise<ObjectEntry[]> =>
			objects
				.filter((k) => k.startsWith(prefix))
				.map((k) => ({ key: k, size: 2048 })),
		fetchObject: async (_o: string, key: string) => key,
		fetchConcatenated: async (_o: string, keys: string[]) =>
			keys.length > 1 ? keys.join("+") : (keys[0] ?? ""),
		probe: async (path: string) => {
			probed.push(path);
			const parts = path.split("+");
			if (parts.length === 1) {
				const only = parts[0] ?? "";
				if (/\.m4s$/.test(only)) {
					throw new Error(
						`${only}: Invalid data found when processing input — a bare fMP4 segment has no moov`,
					);
				}
				if (/\.hdr$/.test(only)) {
					throw new Error(
						`${only}: End of file — a WebM header with no cluster after it is truncated`,
					);
				}
			}
			let merged: MediaProbe = {};
			for (const part of parts) {
				merged = { ...merged, ...(facts[part] ?? {}) };
			}
			return merged;
		},
		scanBoxes: async () => ({ psshSystemIds: [] }),
		readText: async (_o: string, key: string) => {
			const t = texts[key];
			if (t === undefined) {
				throw new Error(`no such object: ${key}`);
			}
			return t;
		},
		parseHls: async () => ({
			variants: [],
			media: [],
			version: 4,
			segments: [],
		}),
		parseDash: async () => ({ representations: [], periods: 1 }),
	} as unknown as EngineDeps;
	return { deps, probed };
}

describe("fMP4: a media segment is probed WITH its init segment", () => {
	const plan = planOf("fixed-bitrate-hls-on-aws");
	const expected = compileExpectedArtefacts(plan);

	/**
	 * The world REAL-VOD-2 actually wrote, read back with the AWS CLI.
	 *
	 * `dir.prefix` carries NO trailing slash (`…/video/360p`), so it is joined here rather than
	 * concatenated — my first version produced `…/360pinit.mp4`, listed nothing, and every
	 * assertion below "passed" over an empty world. Which is the failure mode this whole file is
	 * about, so it is worth the sentence.
	 */
	function realWorld() {
		const objects: string[] = [];
		const facts: Record<string, MediaProbe> = {};
		const under = (prefix: string, name: string) =>
			prefix.endsWith("/") ? `${prefix}${name}` : `${prefix}/${name}`;
		for (const m of expected.muxings) {
			if (!m.dir.prefix || !m.initSegment) {
				continue;
			}
			const init = under(m.dir.prefix, m.initSegment);
			objects.push(init);
			/**
			 * Read the audio rate off the EXPECTATION, never a constant.
			 *
			 * My first version hardcoded 48000 and the a64 leg is 44100 — the real bucket says so
			 * (`sample rate 44100 — 44100`). The test would have been asserting that the engine
			 * agrees with the test's guess rather than with the plan.
			 */
			facts[init] = m.video
				? { height: m.video.height ?? 360, videoCodec: "h264" }
				: {
						audioCodec: "aac",
						...(m.audio ? { audioSampleRate: m.audio.sampleRate } : {}),
					};
			for (let n = 0; n < 2; n++) {
				const seg = under(m.dir.prefix, `segment_${n}.m4s`);
				objects.push(seg);
				// Frames: fps and bitrate, the two facts an init cannot carry. Bitrate from the
				// expectation so the assertion is against the plan, not against a constant.
				facts[seg] = m.video
					? {
							fps: 24,
							...(m.video.bitrate !== null
								? { bitrateBps: m.video.bitrate }
								: {}),
						}
					: {};
			}
		}
		return { objects, facts };
	}

	it("probes the assembly, and the probe list proves the init is in front", async () => {
		const { objects, facts } = realWorld();
		const { deps, probed } = strictDeps(objects, facts);
		await verifyArtefacts(expected, deps);
		const assemblies = probed.filter((p) => p.includes("+"));
		expect(
			assemblies.length,
			"at least one init+segment probe",
		).toBeGreaterThan(0);
		for (const a of assemblies) {
			const [first, second] = a.split("+");
			expect(first, a).toMatch(/init\.mp4$/);
			expect(second, a).toMatch(/\.m4s$/);
		}
	});

	it("reports no rendition FAILs on the world a real run actually wrote", async () => {
		/**
		 * The regression, stated as the outcome that matters. Before the fix this produced
		 * `rendition:*` FAILs naming `Invalid data found when processing input` for every
		 * segmented muxing — on artefacts that were independently confirmed correct.
		 */
		const { objects, facts } = realWorld();
		const { deps } = strictDeps(objects, facts);
		const report = await verifyArtefacts(expected, deps);
		const renditionFails = report.checks.filter(
			(c) => c.verdict === "FAIL" && c.id.startsWith("rendition:"),
		);
		expect(
			renditionFails.map((c) => `${c.id}: ${c.detail}`),
			"a correct fMP4 world must produce no rendition failures",
		).toEqual([]);
	});

	it("never probes a bare .m4s — the assertion that catches the whole defect class", async () => {
		const { objects, facts } = realWorld();
		const { deps, probed } = strictDeps(objects, facts);
		await verifyArtefacts(expected, deps);
		const bare = probed.filter((p) => /\.m4s$/.test(p) && !p.includes("+"));
		expect(bare, "a bare fMP4 segment is not a parseable file").toEqual([]);
	});

	it("still reads the bitrate, which the init alone cannot give", async () => {
		// The property the previous round was right to want. It must survive this fix.
		const { objects, facts } = realWorld();
		const { deps } = strictDeps(objects, facts);
		const report = await verifyArtefacts(expected, deps);
		const bitrate = report.checks.filter((c) => /:bitrate$/.test(c.id));
		expect(bitrate.map((c) => c.id)).toEqual([
			"rendition:v360:bitrate",
			"rendition:v540:bitrate",
		]);
		expect(bitrate.every((c) => c.verdict === "PASS")).toBe(true);
	});

	it("falls back to the init when there is no segment to assemble", async () => {
		/**
		 * A broken encode that wrote an init and nothing else must still get its codec and
		 * geometry read, rather than one bare `:segments` FAIL and silence. This is why the
		 * init probe was kept as a fallback rather than deleted.
		 */
		const { facts } = realWorld();
		const initsOnly = Object.keys(facts).filter((k) => k.endsWith("init.mp4"));
		const { deps, probed } = strictDeps(initsOnly, facts);
		const report = await verifyArtefacts(expected, deps);
		expect(probed.some((p) => p.endsWith("init.mp4"))).toBe(true);
		// And the missing segments are still reported — the fallback must not paper over it.
		expect(
			report.checks.some(
				(c) => c.verdict === "FAIL" && /:segments$/.test(c.id),
			),
		).toBe(true);
	});
});

describe("fps, on the one fixture family that pins a rate", () => {
	/**
	 * `fixed-bitrate-hls-on-aws` does not declare `rate`, so it emits no fps check at all —
	 * correctly, since the plan pins nothing to compare against. Asserting fps there was my
	 * mistake: a premise the fixture cannot support, which is the same error as gating on a
	 * measured value, one level up.
	 *
	 * Exactly two fixtures pin a video rate, and `keyframes-segment-aligned` is one of them —
	 * it is also the scenario whose real run reported `fps 25 — 25000`, the track TIMESCALE read
	 * off an init segment. So this is the right place to prove fps is now readable.
	 */
	const plan = planOf("keyframes-segment-aligned");
	const expected = compileExpectedArtefacts(plan);

	it("reads 25fps from the assembled segment, not a timescale from the init", async () => {
		const objects: string[] = [];
		const facts: Record<string, MediaProbe> = {};
		const under = (p: string, n: string) =>
			p.endsWith("/") ? `${p}${n}` : `${p}/${n}`;
		for (const m of expected.muxings) {
			if (!m.dir.prefix) {
				continue;
			}
			if (m.initSegment) {
				const init = under(m.dir.prefix, m.initSegment);
				objects.push(init);
				// An init carries geometry and NO fps — modelled, because that is the fact that
				// made `fps 25 — 25000` possible in the first place.
				facts[init] = m.video
					? { height: m.video.height ?? 360, videoCodec: "h264" }
					: {
							audioCodec: "aac",
							...(m.audio ? { audioSampleRate: m.audio.sampleRate } : {}),
						};
			}
			const naming = m.segmentNaming;
			if (!naming) {
				continue;
			}
			for (let n = 0; n < 3; n++) {
				const seg = under(m.dir.prefix, naming.replace("%number%", String(n)));
				objects.push(seg);
				facts[seg] = m.video
					? {
							fps: m.video.fps ?? 25,
							...(m.video.bitrate !== null
								? { bitrateBps: m.video.bitrate }
								: {}),
						}
					: {};
			}
		}
		const { deps } = strictDeps(objects, facts);
		const report = await verifyArtefacts(expected, deps);
		const fps = report.checks.filter((c) => /:fps$/.test(c.id));
		expect(
			fps.length,
			"the plan pins a rate, so fps must be checked",
		).toBeGreaterThan(0);
		expect(
			fps.filter((c) => c.verdict === "FAIL").map((c) => c.detail),
			"25fps read off a real segment must not FAIL",
		).toEqual([]);
	});
});

describe("WebM per-title: init.hdr is probed WITH a cluster", () => {
	const plan = planOf("pertitle-vp9-webm-fmp4-dash-on-aws");
	const expected = compileExpectedArtefacts(plan);

	/**
	 * FOUR rung directories, because three would make this test prove nothing.
	 *
	 * `muxing:*:rungs` requires 4..7 here — four of the seven per-title muxings declare a fixed
	 * resolution and are guaranteed a rung each — and a FAILing rung count makes the engine
	 * return BEFORE any rung is probed. My first version supplied two, so `probed` held exactly
	 * one entry (the audio leg), the lone-`.hdr` assertion passed over an empty set, and the
	 * mutation it was written to catch survived. Checked by asserting the probe count, not by
	 * trusting the verdict.
	 */
	const RUNGS = [
		"1080p_3200000_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		"720p_2400000_bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
		"540p_1600000_cccccccc-dddd-4eee-8fff-111111111111",
		"360p_800000_ffffffff-1111-4222-8333-444444444444",
	];

	function webmWorld() {
		const objects: string[] = [];
		const facts: Record<string, MediaProbe> = {};
		const under = (p: string, n: string) =>
			p.endsWith("/") ? `${p}${n}` : `${p}/${n}`;
		for (const m of expected.muxings) {
			if (!m.dir.prefix || !m.segmentNaming) {
				continue;
			}
			const dirs = m.perTitle ? RUNGS : [""];
			for (const d of dirs) {
				const base = d === "" ? m.dir.prefix : under(m.dir.prefix, `${d}/`);
				if (m.initSegment) {
					const init = `${base}${m.initSegment}`;
					if (!objects.includes(init)) {
						objects.push(init);
						facts[init] = m.video
							? {
									height: Number.parseInt(d, 10) || 360,
									videoCodec: m.container.startsWith("WEBM") ? "vp9" : "h264",
								}
							: {
									audioCodec: "aac",
									...(m.audio ? { audioSampleRate: m.audio.sampleRate } : {}),
								};
					}
				}
				for (let n = 0; n < 3; n++) {
					const seg = `${base}${m.segmentNaming.replace("%number%", String(n))}`;
					if (!objects.includes(seg)) {
						objects.push(seg);
						facts[seg] = m.video ? { fps: 24, bitrateBps: 800_000 } : {};
					}
				}
			}
		}
		return { objects, facts };
	}

	/** Enough MPD for the manifest checks to read something rather than error. */
	const MPD = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT12S"><Period>
${RUNGS.map(
	(r, i) =>
		`  <AdaptationSet><Representation id="v${i}" height="${Number.parseInt(r, 10)}"><SegmentTemplate media="$Number$.chk"/></Representation></AdaptationSet>`,
).join("\n")}
  <AdaptationSet><Representation id="a128"><SegmentTemplate media="$Number$.m4s"/></Representation></AdaptationSet>
</Period></MPD>
`;

	it("probes each WebM rung as header + cluster, never a lone .hdr", async () => {
		const { objects, facts } = webmWorld();
		// The manifest's real object key: its directory plus the file it names.
		const m0 = expected.manifests[0];
		const mpdKey = m0?.files[0]
			? m0.dir.prefix.endsWith("/")
				? `${m0.dir.prefix}${m0.files[0]}`
				: `${m0.dir.prefix}/${m0.files[0]}`
			: undefined;
		const { deps, probed } = strictDeps(
			objects,
			facts,
			mpdKey ? { [mpdKey]: MPD } : {},
		);
		await verifyArtefacts(expected, deps);

		// FIRST: the world was actually reached. Without this the rest is vacuous, which is
		// exactly how the earlier version of this test passed while the defect was live.
		const hdrProbes = probed.filter((p) => p.includes(".hdr"));
		expect(
			hdrProbes.length,
			"every WebM rung must be probed — a zero here means the test proved nothing",
		).toBeGreaterThanOrEqual(RUNGS.length);

		for (const p of hdrProbes) {
			const [first, second] = p.split("+");
			expect(first, p).toMatch(/init\.hdr$/);
			expect(second, `${p} — a WebM header needs a cluster after it`).toMatch(
				/\.chk$/,
			);
		}
		expect(
			probed.filter((p) => /\.hdr$/.test(p) && !p.includes("+")),
			"`init.hdr: End of file` is what a lone header produces on a real run",
		).toEqual([]);
	});

	it("reports no rendition FAILs on a correct WebM per-title ladder", async () => {
		const { objects, facts } = webmWorld();
		// The manifest's real object key: its directory plus the file it names.
		const m0 = expected.manifests[0];
		const mpdKey = m0?.files[0]
			? m0.dir.prefix.endsWith("/")
				? `${m0.dir.prefix}${m0.files[0]}`
				: `${m0.dir.prefix}/${m0.files[0]}`
			: undefined;
		const { deps } = strictDeps(
			objects,
			facts,
			mpdKey ? { [mpdKey]: MPD } : {},
		);
		const report = await verifyArtefacts(expected, deps);
		expect(
			report.checks
				.filter((c) => c.verdict === "FAIL" && /^rendition:/.test(c.id))
				.map((c) => `${c.id}: ${c.detail}`),
		).toEqual([]);
	});
});

describe("a concatenation's segment count comes from the OUTPUT's duration", () => {
	/**
	 * `concatenation-two-sources` FAILed a real run with
	 * `ceil(10.04s / 6s) = 2, so [2, 3] segments — found 4`, and four was RIGHT: the verify
	 * rewrite points both sources at the same 10.04s mezzanine, so the output is 20.08s and
	 * ceil(20.08 / 6) = 4 exactly.
	 *
	 * The engine had no test driving a concatenation plan at all — removing the multiplier left
	 * all 287 verify tests green — so the fix is pinned here, with the real numbers.
	 */
	const plan = planOf("concatenation-two-sources");
	const expected = compileExpectedArtefacts(plan);

	function worldWith(segmentsPerMuxing: number) {
		const objects: string[] = [];
		const facts: Record<string, MediaProbe> = {};
		const under = (p: string, n: string) =>
			p.endsWith("/") ? `${p}${n}` : `${p}/${n}`;
		for (const m of expected.muxings) {
			if (!m.dir.prefix || !m.segmentNaming) {
				continue;
			}
			if (m.initSegment) {
				const init = under(m.dir.prefix, m.initSegment);
				objects.push(init);
				facts[init] = m.video
					? { height: m.video.height ?? 720, videoCodec: "h264" }
					: {
							audioCodec: "aac",
							...(m.audio ? { audioSampleRate: m.audio.sampleRate } : {}),
						};
			}
			for (let n = 0; n < segmentsPerMuxing; n++) {
				const seg = under(
					m.dir.prefix,
					m.segmentNaming.replace("%number%", String(n)),
				);
				objects.push(seg);
				facts[seg] = m.video ? { fps: 24, bitrateBps: 3_000_000 } : {};
			}
		}
		return { objects, facts };
	}

	/** The real mezzanine: 10.04s, and the plan joins two of them. */
	const REFERENCE = { durationSec: 10.04, fps: 24, nbFrames: 217 };

	function depsWithReference(
		objects: string[],
		facts: Record<string, MediaProbe>,
	) {
		const { deps, probed } = strictDeps(objects, facts);
		return {
			deps: { ...deps, reference: REFERENCE } as typeof deps,
			probed,
		};
	}

	it("accepts 4 segments for a 2-source join at 6s — the count a real run produced", async () => {
		const { objects, facts } = worldWith(4);
		const { deps } = depsWithReference(objects, facts);
		const report = await verifyArtefacts(expected, deps);
		const counts = report.checks.filter((c) => /:segment-count$/.test(c.id));
		expect(counts.length, "the count must actually be checked").toBeGreaterThan(
			0,
		);
		expect(
			counts.filter((c) => c.verdict === "FAIL").map((c) => c.detail),
			"4 segments is right for 2 x 10.04s at 6s",
		).toEqual([]);
		/**
		 * The message shows the OUTPUT duration — and for a VIDEO muxing that is the video's, not
		 * the container's: 2 × (217 frames ÷ 24fps) = 18.08s, where the container would say
		 * 2 × 10.04 = 20.08s. Both divide to 4 segments here, so the count is unchanged; the
		 * number printed is the honest one now.
		 *
		 * The distinction is not cosmetic. `generic-s3-akamai-io` on a 30.03s source wrote 6
		 * audio segments and 5 video ones, and dividing the video by the container duration
		 * failed a correct encode with `ceil(30.03s / 6s) = 6 … found 5`.
		 */
		expect(counts.find((c) => c.id.includes("v720"))?.detail).toContain(
			"18.08s",
		);
	});

	it("still FAILS a count that is wrong for the joined duration", async () => {
		// The complement: multiplying must not have made the check unenforceable. Two segments
		// is what the OLD (wrong) expectation wanted, so it is the sharpest counter-example.
		const { objects, facts } = worldWith(2);
		const { deps } = depsWithReference(objects, facts);
		const report = await verifyArtefacts(expected, deps);
		expect(
			report.checks.some(
				(c) => c.verdict === "FAIL" && /:segment-count$/.test(c.id),
			),
			"2 segments is short for a 20.08s output",
		).toBe(true);
	});
});

describe("the segment-count band, from two real sources", () => {
	/**
	 * `[floor, ceil + 1]`, and both ends were measured rather than chosen.
	 *
	 * `input/AWOLNATION_muxed_30s.mkv` is 30.03s at a 6s segment length. `ceil` says 6; Bitmovin
	 * wrote **5** and folded the trailing 0.03s into the last segment rather than emitting a
	 * 0.03-second fragment. The old band `[ceil, ceil+1]` failed a correct Akamai encode over 30
	 * milliseconds of content — the last FAIL standing between that scenario and green.
	 *
	 * The other end is `big_buck_bunny_1080p_h264_short.mov`: 10.04s/6s → floor 1, ceil 2,
	 * observed **2**. Both real results sit inside the band, and a mutation to either end fails
	 * one of the four cases below.
	 */
	const plan = planOf("fixed-bitrate-hls-on-aws");
	const expected = compileExpectedArtefacts(plan);

	function worldOf(segmentsPerMuxing: number) {
		const objects: string[] = [];
		const facts: Record<string, MediaProbe> = {};
		const under = (p: string, n: string) =>
			p.endsWith("/") ? `${p}${n}` : `${p}/${n}`;
		for (const m of expected.muxings) {
			if (!m.dir.prefix || !m.initSegment) {
				continue;
			}
			const init = under(m.dir.prefix, m.initSegment);
			objects.push(init);
			facts[init] = m.video
				? { height: m.video.height ?? 360, videoCodec: "h264" }
				: {
						audioCodec: "aac",
						...(m.audio ? { audioSampleRate: m.audio.sampleRate } : {}),
					};
			for (let n = 0; n < segmentsPerMuxing; n++) {
				const seg = under(m.dir.prefix, `segment_${n}.m4s`);
				objects.push(seg);
				facts[seg] = m.video
					? {
							fps: 24,
							...(m.video.bitrate !== null
								? { bitrateBps: m.video.bitrate }
								: {}),
						}
					: {};
			}
		}
		return { objects, facts };
	}

	/** 30.03s of video, the Akamai source. 6s segments ⇒ floor 5, ceil 6, band [5, 7]. */
	const REF = { durationSec: 30.03, videoDurationSec: 30.03, fps: 24 };

	function countsFor(segmentsPerMuxing: number) {
		const { objects, facts } = worldOf(segmentsPerMuxing);
		const { deps } = strictDeps(objects, facts);
		return verifyArtefacts(expected, {
			...deps,
			reference: REF,
		} as typeof deps).then((r) =>
			r.checks.filter((c) => /:segment-count$/.test(c.id)),
		);
	}

	it("accepts 5 — the floor, and the count a real Akamai encode produced", async () => {
		const counts = await countsFor(5);
		expect(counts.length, "the count must actually be checked").toBeGreaterThan(
			0,
		);
		expect(
			counts.filter((c) => c.verdict === "FAIL").map((c) => c.detail),
		).toEqual([]);
		expect(counts[0]?.detail).toContain("allows [5, 7]");
	});

	it("accepts 6 — the ceiling", async () => {
		const counts = await countsFor(6);
		expect(counts.filter((c) => c.verdict === "FAIL")).toEqual([]);
	});

	it("FAILS 4 — below the floor, which is real truncation", async () => {
		const counts = await countsFor(4);
		expect(counts.some((c) => c.verdict === "FAIL")).toBe(true);
	});

	it("FAILS 8 — above the tolerated trailing fragment", async () => {
		// The upper bound has its own reason (an encoder may flush ONE short final fragment) and
		// removing it entirely left every test green, so it is pinned here on its own.
		const counts = await countsFor(8);
		expect(counts.some((c) => c.verdict === "FAIL")).toBe(true);
	});
});

describe("a TRIM overrides the source duration entirely", () => {
	/**
	 * `trimming-time-based` cuts 30 seconds out of its source. Run against the full 596.46s Big
	 * Buck Bunny — which is what unlocked the scenario in the first place, since the trim needs a
	 * 40-second window — the engine demanded `[99, 101]` segments of an encode that correctly wrote
	 * 5. The source's duration is the wrong divisor whenever a trim is in play.
	 *
	 * No engine test drove a trimmed plan before this, so a mutation deleting the trim branch
	 * survived every one of the 324 verify tests.
	 */
	const plan = planOf("trimming-time-based");
	const expected = compileExpectedArtefacts(plan);

	function worldOf(segmentsPerMuxing: number) {
		const objects: string[] = [];
		const facts: Record<string, MediaProbe> = {};
		const under = (p: string, n: string) =>
			p.endsWith("/") ? `${p}${n}` : `${p}/${n}`;
		for (const m of expected.muxings) {
			if (!m.dir.prefix || !m.segmentNaming) {
				continue;
			}
			if (m.initSegment) {
				const init = under(m.dir.prefix, m.initSegment);
				objects.push(init);
				facts[init] = m.video
					? { height: m.video.height ?? 720, videoCodec: "h264" }
					: {
							audioCodec: "aac",
							...(m.audio ? { audioSampleRate: m.audio.sampleRate } : {}),
						};
			}
			for (let n = 0; n < segmentsPerMuxing; n++) {
				const seg = under(
					m.dir.prefix,
					m.segmentNaming.replace("%number%", String(n)),
				);
				objects.push(seg);
				facts[seg] = m.video ? { fps: 24, bitrateBps: 3_000_000 } : {};
			}
		}
		return { objects, facts };
	}

	/** The FULL Big Buck Bunny: what the run actually stages to make this scenario possible. */
	const REF = { durationSec: 596.46, videoDurationSec: 596.46, fps: 24 };

	async function counts(segmentsPerMuxing: number) {
		const { objects, facts } = worldOf(segmentsPerMuxing);
		const { deps } = strictDeps(objects, facts);
		const report = await verifyArtefacts(expected, {
			...deps,
			reference: REF,
		} as typeof deps);
		return report.checks.filter((c) => /:segment-count$/.test(c.id));
	}

	it("expects the TRIM's 30s, not the source's 596s", async () => {
		const c = await counts(5);
		expect(c.length, "the count must actually be checked").toBeGreaterThan(0);
		expect(c[0]?.detail).toContain("30.00s");
		expect(c[0]?.detail).not.toContain("596");
		expect(c.filter((x) => x.verdict === "FAIL").map((x) => x.detail)).toEqual(
			[],
		);
	});

	it("still FAILS a trimmed output with the wrong segment count", async () => {
		// The complement: honouring the trim must not have made the check unenforceable. 99 is
		// what the source duration would have demanded, so it is the sharpest counter-example.
		const c = await counts(99);
		expect(c.some((x) => x.verdict === "FAIL")).toBe(true);
	});
});
