import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileExpectedArtefacts, encodingPlanSchema } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { verifyArtefacts } from "./engine";

/**
 * The report's SHAPE must not depend on what the world happened to tell us.
 *
 * A vanishing check has now been the defect four separate times in this branch: three
 * faults in the self-test that deleted checks rather than failing them, and a per-rung
 * segment count that was never emitted when the reference duration was absent. Each was
 * fixed individually, and each time I believed the class was exhausted.
 *
 * So this asserts the class away instead of chasing instances. `engine.ts`'s header says
 * there is "deliberately no fifth, quieter state"; the fifth state is a check that is not
 * there. The property: for one plan and one set of artefacts, **the set of check ids is
 * identical whether the probe returns rich facts or almost none**. Verdicts may differ —
 * PASS becomes SKIP — but nothing may disappear.
 *
 * This is the only shape of assertion that can see an absent check. Every other test in
 * this directory inspects checks that exist, which is precisely why the class kept
 * surviving them.
 *
 * THE RULE this enforces, which is the durable output of five instances across four
 * review rounds: **never gate an assertion on a value the artefact under test supplies.**
 * A guard on a PLAN field is fine — no expectation, nothing owed. A guard on a MEASURED
 * value lets the artefact decide whether it gets checked.
 *
 * Two things about the fixture list below, both learned the hard way:
 *
 *   The CROSS-SECTION is the instrument. A fifth instance survived this very test because
 *   `:bitrate` is only emitted on the single-file non-per-title path and no listed fixture
 *   took it — the entry labelled "single-file" was segmented, and the actual MP4 fixture
 *   now routes through the per-title path. A named slot is not a filled one.
 *
 *   The WORLD must be derived, not guessed. See `worldFor`.
 *
 * WHAT THIS INSTRUMENT CANNOT SEE, stated because I measured its boundary rather than
 * assuming it: a differential compares two runs of the SAME code, so it detects a check
 * that is emitted CONDITIONALLY on the world, and is blind to a check the code never
 * emits at all. I proved that on myself — planting a parse-gated `:endlist`
 * (`parsed.segments > 5`) left the suite green, because with the guard in place neither
 * run emits the check and there is nothing to diff.
 *
 * Closing that would need an inventory of which check ids each expectation OUGHT to
 * produce — arguably something `expected.ts` should emit alongside the expectations, and
 * a real piece of design rather than a tweak here. It is recorded in
 *  §9b as an open gap, not implied away.
 */

const F = join(
	import.meta.dirname,
	"../../../../packages/core/src/plan/__fixtures__",
);

const RICH = {
	height: 720,
	width: 1280,
	videoCodec: "h264",
	profile: "high",
	fps: 25,
	durationSec: 12,
	bitrateBps: 2_000_000,
	audioCodec: "aac",
	audioChannels: 2,
	audioSampleRate: 48_000,
};

/** What a real ffprobe returns for a container it can open but barely describe. */
const SPARSE = { durationSec: 12 };

function depsFor(
	objects: { key: string; size: number }[],
	probe: Record<string, unknown>,
	withReference: boolean,
) {
	const base = {
		listAll: async (_o: string, p: string) =>
			objects.filter((x) => x.key.startsWith(p)),
		fetchObject: async (_o: string, k: string) => k,
		fetchConcatenated: async (_o: string, keys: string[]) =>
			keys[keys.length - 1] ?? "",
		probe: async () => probe,
		scanBoxes: async () => ({
			psshSystemIds: [
				"edef8ba979d64acea3c827dcd51d21ed",
				"9a04f07998404286ab92e65be0885f95",
				"94ce86fb07ff4f43adb893d2fa968ca2",
			],
			schemeType: "cbcs",
			ivSizeBytes: 16,
			defaultKid: "43214321432143214321432143214321",
		}),
		readText: async () =>
			"#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-ENDLIST\n<SmoothStreamingMedia><QualityLevel/></SmoothStreamingMedia>",
		parseHls: async () => ({
			variants: [{ uri: "a.m3u8" }, { uri: "b.m3u8" }],
			media: [{ type: "AUDIO" }],
			version: 4,
		}),
		parseDash: async () => ({
			representations: [{ addressing: "TEMPLATE" as const }],
			periods: 1,
		}),
	};
	return (
		withReference ? { ...base, reference: { durationSec: 12, fps: 25 } } : base
	) as never;
}

/**
 * Every file the EXPECTATION names — derived, never guessed.
 *
 * The first version wrote hard-coded names (`init.mp4`, `video.ismv`, `segment_N.m4s`),
 * so for any fixture whose muxings name something else the `:file` check failed,
 * `verifyMediaProperties` was never reached, and no rendition check existed in EITHER
 * run — which made the id-set comparison vacuous for that fixture. A reviewer's
 * independent sweep found a fifth vanishing guard my test could not see for exactly that
 * reason: `mp4-fixed-bitrate-hls-on-aws` never reached the single-file path at all.
 *
 * An instrument that builds a guessed world measures the guess.
 */
function worldFor(expected: ReturnType<typeof compileExpectedArtefacts>) {
	const objects: { key: string; size: number }[] = [];
	const push = (prefix: string, name: string, size: number) => {
		objects.push({ key: `${prefix}${name}`, size });
	};
	const rungs = ["", "360p_300000/", "540p_600000/", "720p_900000/"];
	for (const m of expected.muxings) {
		const bases = new Set<string>();
		if (m.dir.prefix) {
			bases.add(m.dir.prefix);
		}
		for (const d of expected.drm) {
			if (m.viaDrmKeys?.includes(d.drmKey) && d.dir?.prefix) {
				bases.add(d.dir.prefix);
			}
		}
		for (const base of bases) {
			for (const rung of m.perTitle ? rungs.slice(1) : [""]) {
				const at = `${base}${rung}`;
				if (m.filename) {
					push(at, m.filename, 4_000_000);
				}
				if (m.initSegment) {
					push(at, m.initSegment, 900);
				}
				if (m.segmentNaming) {
					for (let i = 1; i <= 3; i++) {
						push(at, m.segmentNaming.replace(/%number%/g, String(i)), 500_000);
					}
				}
			}
		}
	}
	for (const m of expected.manifests) {
		for (const f of m.files) {
			push(m.dir.prefix, f, 700);
		}
	}
	return objects;
}

/** A cross-section: single-file, segmented, per-title, DRM, audio-only, Smooth. */
const FIXTURES = [
	"fixed-bitrate-hls-on-aws",
	"mp4-fixed-bitrate-hls-on-aws",
	"pertitle-h264-openapi",
	"pertitle-h264-mp4-smooth-drm-on-aws",
	"cenc-cbc-drm-on-aws",
	"audio-only-aac-fmp4-hls-dash",
	"dolby-dv-hdr10-sdr-3ladder-profile5-single-input",
];

describe("no check may disappear when the world says less", () => {
	for (const name of FIXTURES) {
		it(`${name}: same check ids, rich probe vs sparse`, async () => {
			const expected = compileExpectedArtefacts(
				encodingPlanSchema.parse(
					JSON.parse(readFileSync(join(F, `${name}.plan.json`), "utf8")),
				),
			);
			const objects = worldFor(expected);
			const rich = await verifyArtefacts(
				expected,
				depsFor(objects, RICH, true),
			);
			const sparse = await verifyArtefacts(
				expected,
				depsFor(objects, SPARSE, false),
			);

			// A real population, or the comparison is vacuous.
			expect(rich.checks.length, "checks emitted").toBeGreaterThan(5);

			const ids = (r: typeof rich) => r.checks.map((c) => c.id).sort();
			const missing = ids(rich).filter((id) => !ids(sparse).includes(id));
			expect(
				missing,
				"these checks VANISHED when the probe returned less — they must SKIP instead",
			).toEqual([]);
		});
	}

	it("and the sparse run says SKIP rather than passing quietly", async () => {
		const expected = compileExpectedArtefacts(
			encodingPlanSchema.parse(
				JSON.parse(
					readFileSync(join(F, "fixed-bitrate-hls-on-aws.plan.json"), "utf8"),
				),
			),
		);
		const sparse = await verifyArtefacts(
			expected,
			depsFor(worldFor(expected), SPARSE, false),
		);
		expect(
			sparse.counts.SKIP,
			"a probe that described nothing must produce SKIPs",
		).toBeGreaterThan(0);
	});
});

/**
 * The same invariant under a degraded PARSE, not just a degraded probe.
 *
 * A reviewer flagged `if (!isMaster)` → `:endlist` as a candidate of the same class: the
 * artefact's own parse decides whether the check exists. Neither of our differentials
 * degraded parse results, so it was a candidate and not a finding — and I would rather
 * measure it than leave it as a guess in a review thread.
 *
 * Measured: **nothing vanishes.** A parse that finds a media playlist where a master was
 * expected still emits `:variants` and `:endlist`; an MPD with no representations still
 * emits `:representations` and `:addressing`. Where a degraded parse DOES remove
 * downstream checks it does so after a reported `:parse` FAIL, which is an absence a
 * reader can see and account for — not silence.
 *
 * Kept because the answer could change: the guards are one edit away from the bad shape,
 * and this is the assertion that would notice.
 */
describe("no check may disappear when the PARSE says less", () => {
	const RICH_HLS = {
		variants: [{ uri: "a.m3u8" }, { uri: "b.m3u8" }],
		media: [{ type: "AUDIO" }],
		version: 4,
		segments: 3,
	};
	const RICH_DASH = {
		representations: [{ addressing: "TEMPLATE" as const }],
		periods: 1,
	};

	for (const name of [
		"fixed-bitrate-hls-on-aws",
		"audio-only-aac-fmp4-hls-dash",
		"dash-template-and-timeline-on-aws",
		"pertitle-h264-openapi",
	]) {
		it(`${name}: same check ids under a degraded parse`, async () => {
			const expected = compileExpectedArtefacts(
				encodingPlanSchema.parse(
					JSON.parse(readFileSync(join(F, `${name}.plan.json`), "utf8")),
				),
			);
			const objects = worldFor(expected);
			const base = depsFor(objects, RICH, true) as Record<string, unknown>;
			const run = (hls: unknown, dash: unknown) =>
				verifyArtefacts(expected, {
					...base,
					parseHls: async () => hls,
					parseDash: async () => dash,
				} as never);

			const rich = await run(RICH_HLS, RICH_DASH);
			expect(rich.checks.length).toBeGreaterThan(5);
			const ids = (r: typeof rich) => new Set(r.checks.map((c) => c.id));

			// Degrade WITHIN each parse shape, not across shapes.
			//
			// The first version compared a master baseline against a media-playlist run,
			// and could not see a parse-gated `:endlist` at all: `:endlist` is only emitted
			// for a MEDIA playlist, so the master baseline never had it to lose. Planting
			// the bad shape on purpose proved that — the suite stayed green. The same
			// cross-section mistake as the `:bitrate` slot, one commit later, which is why
			// the planted-fault check below is now part of the test rather than something I
			// did once by hand.
			const MEDIA = { variants: [], media: [], version: 4, segments: 3 };
			for (const [label, richPair, poorPair] of [
				[
					"a media playlist that reports no segment count",
					[MEDIA, RICH_DASH],
					[{ ...MEDIA, segments: undefined }, RICH_DASH],
				],
				[
					"a master that reports no version",
					[RICH_HLS, RICH_DASH],
					[{ ...RICH_HLS, version: undefined }, RICH_DASH],
				],
				[
					"an MPD that reports no representations",
					[RICH_HLS, RICH_DASH],
					[RICH_HLS, { representations: [], periods: 1 }],
				],
			] as const) {
				const good = await run(richPair[0], richPair[1]);
				const poor = await run(poorPair[0], poorPair[1]);
				// A check may be absent when something in its own namespace FAILED in the
				// degraded run — an unparseable manifest legitimately has no variant count,
				// and the FAIL is what a reader sees instead. That is a reported absence, not
				// silence, and it is the same `mayVanish` discipline the self-test uses.
				const failedNamespaces = new Set(
					poor.checks
						.filter((c) => c.verdict === "FAIL")
						.map((c) => c.id.split(":").slice(0, 2).join(":")),
				);
				const vanished = [...ids(good)]
					.filter((x) => !ids(poor).has(x))
					.filter(
						(x) => !failedNamespaces.has(x.split(":").slice(0, 2).join(":")),
					);
				expect(
					vanished,
					`${label}: these checks VANISHED with nothing failing in their namespace — a degraded parse must still produce a verdict`,
				).toEqual([]);
			}
		});
	}
});
