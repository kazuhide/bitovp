import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileLiveChannel } from "../live/compiler";
import { LIVE_MANIFEST_ELEMENT_BUDGET } from "../live/dvr";
import { liveChannelPlanSchema } from "../live/schema";
import { AUDIO_CODECS } from "../plan/schema";
import { compileExpectedLiveArtefacts } from "./expected-live";

/**
 * Golden expectations for every live fixture, plus the properties that must hold for all
 * of them.
 *
 * Same shape as the VOD suite, for the same reason: a pinned expectation makes a change
 * to the compiler visible, and a corpus-wide property catches the thing a pin cannot —
 * that the compiler is internally consistent rather than merely stable.
 *
 * `readdirSync`, not `import.meta.glob`: the glob is a Vite transform, and this file runs
 * under plain vitest. Set `UPDATE_EXPECTED=1` to regenerate after a deliberate change.
 */

const FIXTURES = join(import.meta.dirname, "..", "live", "__fixtures__");

const planFiles = readdirSync(FIXTURES)
	.filter((f) => f.endsWith(".plan.json"))
	.sort();

describe("compileExpectedLiveArtefacts — golden per live fixture", () => {
	it("found a corpus to pin, so a broken read cannot pass over nothing", () => {
		// 9→10 : live-pinned-encoder — the arbitrary
		// encoder-version pin, fixture-proven at last.
		// 10→11 (2026-08-23, the Akamai-first customer set):
		// live-akamai-msl-storage — Akamai Object Storage PRIMARY (the readable
		// witness) + MSL4 as the first LIVE deliveryMirror: one encode, both
		// destinations. A separate storage-only fixture was authored and then
		// DROPPED — its check-id set duplicated live-static-ingest's (the
		// no-silence guard caught it), and the combined fixture's primary
		// already covers the storage-output case.
		// 11→12: live-akamai-msl-ts — the HLS/TS half of the MSL pair (owner:
		// CMAF and HLS/TS both).
		// 13→14 : live-akamai-msl5 — the first MSL5 fixture.
		// It differs from `live-akamai-msl` in exactly three ways and each is a
		// measured fact rather than a choice: mslVersion MSL5, the DASH-style
		// segment naming the vendor's own E2E uses, and encoderVersion 2.283.0,
		// the release that shipped MSL5. The MSL4 goldens stayed BYTE-IDENTICAL,
		// which is what "MSL4 behaviour untouched" has to mean to be a claim.
		// 14→15: live-mixed-codec-dash — H264 and
		// H265 on one channel, the topology paid case F could not deliver. The
		// other fourteen goldens stayed BYTE-IDENTICAL, which is what "the
		// single-codec path is untouched" has to mean to be a claim.
		expect(planFiles.length).toBe(15);
	});

	for (const file of planFiles) {
		const name = file.replace(".plan.json", "");
		it(`${name} compiles to its pinned expectations`, () => {
			const plan = liveChannelPlanSchema.parse(
				JSON.parse(readFileSync(join(FIXTURES, file), "utf8")),
			);
			const expected = compileExpectedLiveArtefacts(plan);
			const goldenPath = join(FIXTURES, `${name}.expected-live.json`);
			const serialized = `${JSON.stringify(expected, null, "\t")}\n`;
			if (process.env.UPDATE_EXPECTED === "1") {
				writeFileSync(goldenPath, serialized);
				return;
			}
			expect(JSON.parse(serialized)).toEqual(
				JSON.parse(readFileSync(goldenPath, "utf8")),
			);
		});
	}
});

describe("properties that must hold for every live fixture", () => {
	const compiled = planFiles.map((file) => {
		const name = file.replace(".plan.json", "");
		const plan = liveChannelPlanSchema.parse(
			JSON.parse(readFileSync(join(FIXTURES, file), "utf8")),
		);
		return { name, plan, expected: compileExpectedLiveArtefacts(plan) };
	});

	it("expects at least one muxing and one manifest for every channel", () => {
		// A plan compiling to nothing would "verify" green while proving nothing.
		for (const { name, expected } of compiled) {
			expect(expected.muxings.length, name).toBeGreaterThan(0);
			expect(expected.manifests.length, name).toBeGreaterThan(0);
		}
	});

	it("derives the C8 element estimate from the PLAN, not from the compiler's own output", () => {
		/**
		 * Recomputed here from `plan.liveManifests[].timeshift` and the muxing cadence,
		 * rather than restating whatever the compiler produced. The VOD suite learned this
		 * the hard way: its C9 property test asserted the implementation's own expression
		 * and a direct constraint violation passed all 66 goldens .
		 */
		let checked = 0;
		for (const { name, plan, expected } of compiled) {
			const renditionByKey = new Map(plan.renditions.map((r) => [r.key, r]));
			for (const m of expected.manifests) {
				const declaredManifest = plan.liveManifests.find(
					(x) => x.key === m.manifestKey,
				);
				const declared = declaredManifest?.timeshift;
				expect(m.timeshiftSec, `${name}/${m.manifestKey}`).toBe(declared);
				if (declared === undefined) {
					expect(m.elementBudget, `${name}/${m.manifestKey}`).toBeUndefined();
					continue;
				}
				/**
				 * The legs THIS manifest enumerates, re-derived here from the plan's
				 * own kind pins rather than by calling `selectLiveManifestMuxings` —
				 * the #43 rule, kept: a property test that asks the implementation
				 * how to compute the thing it is checking checks nothing.
				 *
				 * The multiplier used to be `plan.renditions.length`. That is the
				 * same wrong premise the compiler held (#192), so this test
				 * recomputed the bug faithfully and corroborated it: a rendition
				 * muxed into another container adds a STREAM, not a playlist, and a
				 * rendition with no muxing of its own costs no manifest elements.
				 * Independence is only worth something when the population is right.
				 */
				const legs = plan.muxings.filter((leg) => {
					const r = renditionByKey.get(leg.streamKey);
					if (!r) {
						return false;
					}
					// DASH live enumerates the fMP4 legs and nothing else; only HLS
					// carries the per-family kind pins. (tsc caught this: reading the
					// pins off the union compiled nowhere, and the version that did
					// would have counted TS legs into a DASH budget.)
					if (declaredManifest?.kind !== "HLS") {
						return leg.kind === "FMP4";
					}
					const pinned = AUDIO_CODECS.has(r.codec)
						? declaredManifest.audioMuxingKind
						: declaredManifest.videoMuxingKind;
					return pinned === undefined || leg.kind === pinned;
				});
				const shortest = Math.min(
					...legs.map((leg) => {
						if (leg.kind === "MP4")
							throw new Error("manifest fixture must be segmented");
						return leg.segmentLength;
					}),
				);
				const segments = Math.ceil(declared / shortest);
				expect(
					m.elementBudget?.segmentsPerRendition,
					`${name}/${m.manifestKey} segments per rendition`,
				).toBe(segments);
				expect(
					m.elementBudget?.totalElements,
					`${name}/${m.manifestKey} total elements (C8)`,
				).toBe(segments * legs.length);
				expect(m.elementBudget?.budget).toBe(LIVE_MANIFEST_ELEMENT_BUDGET);
				checked++;
			}
		}
		// A loop that iterated nothing would pass. It has to be a real number.
		expect(checked, "manifests with a declared DVR window").toBeGreaterThan(3);
	});

	it("says which ingests our feeder can drive, and notes the ones it cannot", () => {
		const feedable = compiled.filter(
			({ expected }) => expected.ingest.feedable,
		);
		const not = compiled.filter(({ expected }) => !expected.ingest.feedable);
		// Both sets must be non-empty or this fixture corpus has stopped covering the
		// distinction the live tier is built around.
		expect(feedable.length, "feedable channels").toBeGreaterThan(0);
		expect(not.length, "channels our feeder cannot drive").toBeGreaterThan(0);
		for (const { name, expected } of not) {
			// Never silent: an unfeedable ingest must SAY so, or a verifier waits out the
			// whole start timeout and reports a timeout as an encoding defect.
			expect(
				expected.notes.some((n) => /cannot be driven by our feeder/.test(n)),
				name,
			).toBe(true);
		}
	});

	it("requires a stream key only where the protocol has one", () => {
		for (const { name, expected } of compiled) {
			const wantsKey =
				expected.ingest.requiresCoordinates.includes("streamKey");
			expect(wantsKey, name).toBe(
				expected.ingest.kind === "RTMP" ||
					expected.ingest.kind === "REDUNDANT_RTMP",
			);
			// Every ingest hands back an encoder address; that is how a feed is pointed.
			expect(expected.ingest.requiresCoordinates, name).toContain("encoderIp");
		}
	});

	it("keeps every muxing prefix under its manifest's output", () => {
		// A channel whose segments and manifest land in different buckets is not a channel
		// a player can consume, and it is the kind of thing a path typo produces.
		for (const { name, expected } of compiled) {
			const outputs = new Set(expected.manifests.map((m) => m.outputKey));
			for (const m of expected.muxings) {
				expect(outputs.has(m.outputKey), `${name}/${m.muxingKey}`).toBe(true);
			}
		}
	});

	it("flags the ESAM channel as needing a POIS, and only that one", () => {
		const needs = compiled.filter(({ expected }) => expected.needsPois);
		expect(needs.map((x) => x.name)).toEqual(["live-esam-full"]);
	});

	it("never emits an empty note", () => {
		for (const { name, expected } of compiled) {
			for (const note of expected.notes) {
				expect(note.trim(), name).not.toBe("");
			}
		}
	});
});

describe("MSL delivery topology", () => {
	const compile = (name: string) =>
		compileExpectedLiveArtefacts(
			liveChannelPlanSchema.parse(
				JSON.parse(readFileSync(join(FIXTURES, `${name}.plan.json`), "utf8")),
			),
		);

	it.each([
		"live-akamai-msl-ts",
		"live-akamai-msl",
	])("classifies direct MSL4 %s as a PRIMARY edge output, never a storage origin", (name) => {
		expect(compile(name).mslEdgeOutputs).toEqual([
			{ outputKey: "origin", role: "PRIMARY" },
		]);
	});

	it("classifies Object Storage primary + MSL mirror as one readable origin plus one MIRROR edge output", () => {
		const expected = compile("live-akamai-msl-storage");
		expect(expected.manifests.map((manifest) => manifest.outputKey)).toEqual([
			"origin",
			"origin",
		]);
		expect(expected.mslEdgeOutputs).toEqual([
			{ outputKey: "mirror-1", role: "MIRROR" },
		]);
	});
});

describe("shared-bitrate playlist names reach the verifier (row #325, review-538 R1)", () => {
	it("expects exactly the uris the compiler emits, suffix included", () => {
		const plan = liveChannelPlanSchema.parse(
			JSON.parse(
				readFileSync(join(FIXTURES, "live-rtmp-simple.plan.json"), "utf8"),
			),
		);
		const a128 = plan.renditions.find((r) => r.key === "a128");
		const m128 = plan.muxings.find((m) => m.key === "a128");
		if (a128?.codec !== "AAC" || !m128?.destination) {
			throw new Error("fixture shape changed");
		}
		plan.renditions.push({ ...a128, key: "a128b", name: "AAC 128 (alt)" });
		plan.muxings.push({
			...m128,
			key: "a128b",
			streamKey: "a128b",
			destination: { ...m128.destination, path: `${m128.destination.path}b` },
		});
		const emitted = compileLiveChannel(plan)
			.filter(
				(op) =>
					op.kind === "CREATE_HLS_AUDIO_MEDIA" ||
					op.kind === "CREATE_HLS_STREAM_INFO",
			)
			.map((op) => (op.payload as { uri?: unknown }).uri);
		expect(emitted).toContain("audio_128000_1.m3u8");
		const expectedHls = compileExpectedLiveArtefacts(plan).manifests.filter(
			(manifest) => manifest.kind === "HLS",
		);
		expect(expectedHls).toHaveLength(1);
		expect([...(expectedHls[0]?.mediaPlaylists ?? [])].sort()).toEqual(
			[...emitted].sort(),
		);
	});
});
