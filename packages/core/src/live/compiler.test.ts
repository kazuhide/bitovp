import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSensitiveKey } from "../crypto/redact";
import type { CompiledOperation } from "../plan/compiler";
import { planHasErrors } from "../plan/validate";
import { compileLiveChannel, mslManifestPath } from "./compiler";
import { LIVE_FIXTURES } from "./fixtures";

const FIXTURES = LIVE_FIXTURES;

import { liveChannelPlanSchema } from "./schema";
import { validateLiveChannel } from "./validate";

/**
 * Live golden tests — same contract as plan/compiler.test.ts: each fixture
 * pins the compiled operation sequence (the provisioning contract the PR2
 * channel worker replays). Regenerate deliberately with UPDATE_GOLDEN=1.
 * No template.yaml triad member: Encoding Templates do not cover live.
 */

const dir = join(__dirname, "__fixtures__");

function loadPlan(name: string) {
	return liveChannelPlanSchema.parse(
		JSON.parse(readFileSync(join(dir, `${name}.plan.json`), "utf8")),
	);
}

function refTargets(op: CompiledOperation): string[] {
	return Object.values(op.refs).flat();
}

/**
 * The golden loop below must iterate the WHOLE registry.
 *
 * review-299 F8: `fixture-registry.test.ts` asserts a fixture "is
 * compiler-pinned" but verifies MEMBERSHIP IN AN ARRAY — the link from registry
 * entry to actually-deep-equalled is enforced by nothing. A one-line `.filter`
 * here satisfies every one of its four assertions (set-equality both ways, the
 * ops golden exists, the totals) while silently dropping a fixture's four
 * assertions, which is F63-TEST-002 reconstituted. The only witness was the test
 * COUNT, and a dropped count announces nothing.
 *
 * Tautological exactly while nobody filters — which is when it must fire.
 */
const ITERATED: string[] = [];

it("iterates the whole registry — no local filtering", () => {
	// Bound to what the LOOP actually visited, not to the binding it reads
	// from. The first version asserted `FIXTURES` against `LIVE_FIXTURES` where
	// `const FIXTURES = LIVE_FIXTURES` — a comparison of a name with itself, which
	// fires only if someone edits that one declaration. Filtering AT THE LOOP
	// (`for (const name of FIXTURES.filter(...))`) dropped four tests with the
	// suite green and this pin silent (review-300 F3). It guarded the one
	// spelling I happened to use while testing it, which is the blind-spot
	// shape this whole branch has been about.
	expect([...ITERATED].sort()).toEqual([...LIVE_FIXTURES].sort());
});

describe("compileLiveChannel golden fixtures", () => {
	for (const name of FIXTURES) {
		ITERATED.push(name);
		describe(name, () => {
			const plan = loadPlan(name);
			const ops = compileLiveChannel(plan);
			const expectedPath = join(dir, `${name}.ops.json`);

			it("validates without errors", () => {
				expect(planHasErrors(validateLiveChannel(plan))).toBe(false);
			});
			it("explicitly starts only each Live DASH first Period at zero seconds", () => {
				const periods = ops.filter((op) => op.kind === "CREATE_DASH_PERIOD");
				expect(periods).toHaveLength(
					ops.filter((op) => op.kind === "CREATE_MANIFEST_DASH").length,
				);
				for (const period of periods)
					expect(period.payload).toEqual({ start: 0 });
			});

			it("matches the golden operation sequence", () => {
				if (process.env.UPDATE_GOLDEN) {
					if (process.env.CI) {
						throw new Error(
							"Refusing to regenerate goldens in CI — the comparison would be vacuous",
						);
					}
					writeFileSync(expectedPath, `${JSON.stringify(ops, null, "\t")}\n`);
				}
				expect(existsSync(expectedPath)).toBe(true);
				expect(ops).toEqual(JSON.parse(readFileSync(expectedPath, "utf8")));
			});

			it("has unique step ids and only-backward references", () => {
				const seen = new Set<string>();
				for (const op of ops) {
					expect(seen.has(op.step)).toBe(false);
					for (const target of refTargets(op)) {
						expect(
							seen.has(target),
							`${op.step} references ${target} before it exists`,
						).toBe(true);
					}
					seen.add(op.step);
				}
			});

			it("never carries secret material in payloads", () => {
				const text = JSON.stringify(ops).toLowerCase();
				for (const banned of [
					"accesskey",
					"secretkey",
					"accountkey",
					"accountname",
					"sastoken",
					"password",
					"passphrase",
					"privatekey",
					"apikey",
					"decryptionkey",
				]) {
					expect(text).not.toContain(banned);
				}
				// Structural check mirrors the VOD goldens with two documented
				// SDK-name exceptions: the live stream key is connection-routing
				// material the plan owns (StartLiveEncodingRequest.streamKey,
				// RTMP ingest points), and streamKeyId is a REFERENCE to an
				// account StreamKey resource. Persisted snapshots still mask
				// both (redactSecrets) — vault material (SRT passphrase, Zixi
				// password/decryptionKey) only ever rides as credentialId.
				const SDK_KEY_NAME_EXCEPTIONS = new Set(["streamKey", "streamKeyId"]);
				const assertNoSensitiveKeys = (value: unknown): void => {
					if (Array.isArray(value)) {
						for (const item of value) {
							assertNoSensitiveKeys(item);
						}
						return;
					}
					if (value && typeof value === "object") {
						for (const [k, item] of Object.entries(value)) {
							if (!SDK_KEY_NAME_EXCEPTIONS.has(k)) {
								expect(
									isSensitiveKey(k),
									`payload key "${k}" looks secret`,
								).toBe(false);
							}
							assertNoSensitiveKeys(item);
						}
					}
				};
				for (const op of ops) {
					assertNoSensitiveKeys(op.payload);
				}
			});
		});
	}

	it("pins manifestGenerator V2 on the start request (C3)", () => {
		const ops = compileLiveChannel(loadPlan("live-rtmp-simple"));
		const start = ops.find((op) => op.kind === "START_LIVE_ENCODING");
		expect(start?.payload.manifestGenerator).toBe("V2");
	});

	it("references pre-created manifests and keys start options by plan key", () => {
		const ops = compileLiveChannel(loadPlan("live-rtmp-simple"));
		const start = ops.find((op) => op.kind === "START_LIVE_ENCODING");
		expect(start?.refs.liveHlsManifestIds).toEqual(["manifest:hls"]);
		expect(start?.refs.liveDashManifestIds).toEqual(["manifest:dash"]);
		expect(start?.payload.hlsManifests).toEqual({
			hls: { timeshift: 7200, liveEdgeOffset: 18, insertProgramDateTime: true },
		});
		expect(start?.payload.dashManifests).toEqual({
			dash: {
				timeshift: 7200,
				suggestedPresentationDelay: 12000,
				minimumUpdatePeriod: 6000,
				availabilityStartTimeMode: "ON_FIRST_SEGMENT",
			},
		});
		// Pre-created trees exist before the start; they are never STARTED —
		// the live encoder generates them (no START_MANIFEST_* in live).
		const startIndex = ops.findIndex((op) => op.kind === "START_LIVE_ENCODING");
		expect(
			ops.findIndex((op) => op.kind === "CREATE_MANIFEST_HLS"),
		).toBeLessThan(startIndex);
		expect(
			ops.findIndex((op) => op.kind === "CREATE_MANIFEST_DASH"),
		).toBeLessThan(startIndex);
		expect(ops.some((op) => op.kind.startsWith("START_MANIFEST_"))).toBe(false);
	});

	it("carries explicit null reupload intervals into the START payload", () => {
		// SDK: null = "never re-upload" — distinct from absent, so the
		// compiled payload must preserve it for the PR2 worker verbatim.
		const plan = loadPlan("live-rtmp-simple");
		plan.start.reupload = {
			dashManifestInterval: null,
			muxingInitFileInterval: null,
		};
		const ops = compileLiveChannel(plan);
		const start = ops.find((op) => op.kind === "START_LIVE_ENCODING");
		expect(start?.payload.reuploadSettings).toEqual({
			dashManifestInterval: null,
			muxingInitFileInterval: null,
		});
	});

	it("ends with AWAIT_LIVE_RUNNING (steady state, no compiled stop)", () => {
		/**
		 * Counts what it visited — review-300 measured this loop as the WORST of
		 * the three, because it is inside a single `it`. Filtering it dropped
		 * fixtures with the suite green AND THE TEST COUNT UNMOVED: two assertions
		 * per fixture, one `it`, so the dropped-count tell that catches the other
		 * two loops has nothing to say here. Silent-drop with zero tell.
		 */
		let visited = 0;
		for (const name of FIXTURES) {
			const ops = compileLiveChannel(loadPlan(name));
			const last = ops.at(-1);
			expect(last?.kind).toBe("AWAIT_LIVE_RUNNING");
			expect(last?.refs.encodingId).toBe("encoding");
			visited += 1;
		}
		expect(visited).toBe(LIVE_FIXTURES.length);
	});

	it("compiles the RTMP input as a resolve-only op (list-only API)", () => {
		const ops = compileLiveChannel(loadPlan("live-rtmp-simple"));
		const input = ops.find((op) => op.kind === "CREATE_INPUT_RTMP");
		expect(input?.step).toBe("live-input:main");
		expect(input?.payload).toEqual({});
	});

	it("carries SRT credentials as vault refs, never inline", () => {
		const ops = compileLiveChannel(loadPlan("live-srt-listener"));
		const input = ops.find((op) => op.kind === "CREATE_INPUT_SRT");
		expect(input?.payload.credentialId).toBe(
			"00000000-0000-4000-8000-000000000003",
		);
		expect(input?.payload.keyLength).toBe(128);
		// Backup connections compile as nested SrtInput shapes.
		expect(input?.payload.backupSrtInputs).toEqual({
			delayThreshold: 15,
			srtInputs: [{ mode: "LISTENER", port: 2089 }],
		});
	});

	it("references the live input directly on each codec stream (no IngestInputStream)", () => {
		// live/start cannot resolve a standalone IngestInputStream built on the
		// account RTMP input — it fails 2025 on the ingest-stream id. The working
		// Akamai sample and bitmovin-live templates instead reference the input
		// directly on each Stream's StreamInput: video position 0, audio
		// position 1 (C13). So live emits NO CREATE_INGEST_INPUT_STREAM.
		const plan = loadPlan("live-rtmp-simple");
		const ops = compileLiveChannel(plan);
		expect(ops.some((op) => op.kind === "CREATE_INGEST_INPUT_STREAM")).toBe(
			false,
		);
		const videoCodecs = new Set(["H264", "H265"]);
		const codecByKey = new Map(plan.renditions.map((r) => [r.key, r.codec]));
		const streams = ops.filter((op) => op.kind === "CREATE_STREAM");
		expect(streams.length).toBeGreaterThan(0);
		for (const op of streams) {
			// Direct input reference, not a pre-built ingest stream.
			expect(op.refs.inputId).toBe("live-input:main");
			expect(op.refs.inputStreamId).toBeUndefined();
			expect(op.payload.inputPath).toBe("live");
			const key = op.step.replace(/^stream:/, "");
			const expectedPosition = videoCodecs.has(codecByKey.get(key) ?? "")
				? 0
				: 1;
			expect(op.payload.position).toBe(expectedPosition);
		}
	});

	describe("SCTE-35 ad markers (C14)", () => {
		// live-rtmp-simple has 3 fMP4 video legs + 1 fMP4 audio leg and both an
		// HLS and a DASH manifest, so it exercises every carrier at once.
		const fmp4Ops = (ops: ReturnType<typeof compileLiveChannel>) =>
			ops.filter((op) => op.kind === "CREATE_MUXING_FMP4");
		const startOf = (ops: ReturnType<typeof compileLiveChannel>) =>
			ops.find((op) => op.kind === "START_LIVE_ENCODING");

		it("emits NO SCTE keys when adMarkers is absent (default plans unchanged)", () => {
			const ops = compileLiveChannel(loadPlan("live-rtmp-simple"));
			for (const op of fmp4Ops(ops)) {
				expect(op.payload).not.toHaveProperty("signalScte35AsEmsg");
			}
			const start = startOf(ops);
			const hls = (start?.payload.hlsManifests as Record<string, unknown>).hls;
			const dash = (start?.payload.dashManifests as Record<string, unknown>)
				.dash;
			expect(hls).not.toHaveProperty("adMarkerSettings");
			expect(dash).not.toHaveProperty("adMarkerSettings");
		});

		it("sets signalScte35AsEmsg on every fMP4 muxing when scte35 is on", () => {
			const plan = loadPlan("live-rtmp-simple");
			plan.adMarkers = { scte35: true };
			const muxings = fmp4Ops(compileLiveChannel(plan));
			expect(muxings.length).toBeGreaterThan(0);
			for (const op of muxings) {
				expect(op.payload.signalScte35AsEmsg).toBe(true);
			}
		});

		it("adds DASH + HLS adMarkerSettings to the START options when scte35 is on", () => {
			const plan = loadPlan("live-rtmp-simple");
			plan.adMarkers = { scte35: true };
			const start = startOf(compileLiveChannel(plan));
			const hls = (start?.payload.hlsManifests as Record<string, unknown>).hls;
			const dash = (start?.payload.dashManifests as Record<string, unknown>)
				.dash;
			// toEqual, not toMatchObject: this is a byte-identity claim about
			// the C14 defaults — an extra key the knobs might introduce must
			// fail here (review catch N8).
			expect((hls as { adMarkerSettings?: unknown }).adMarkerSettings).toEqual({
				enabledMarkerTypes: ["EXT_X_DATERANGE"],
			});
			expect((dash as { adMarkerSettings?: unknown }).adMarkerSettings).toEqual(
				{
					periodOption: "SINGLE_PERIOD",
					eventStreamSignalling: "XML_BIN",
				},
			);
		});

		it("does not signal emsg on TS muxings (TS has no emsg box)", () => {
			// live-zixi is the TS scenario; the flag must not invent a TS field.
			const plan = loadPlan("live-zixi");
			plan.adMarkers = { scte35: true };
			const ops = compileLiveChannel(plan);
			for (const op of ops.filter((o) => o.kind === "CREATE_MUXING_TS")) {
				expect(op.payload).not.toHaveProperty("signalScte35AsEmsg");
			}
		});
	});
});

describe("HLS audio media NAME uniqueness — live (audit 893eb66 HIGH-8, ledger #201)", () => {
	function withSecondAudio() {
		const plan = loadPlan("live-rtmp-simple");
		const a = plan.renditions.find((r) => r.key === "a128");
		const m = plan.muxings.find((x) => x.streamKey === "a128");
		if (!a || !m || a.codec !== "AAC") {
			throw new Error("fixture is missing its audio rendition");
		}
		plan.renditions.push({ ...a, key: "a64", bitrate: 64000 });
		plan.muxings.push({
			...m,
			key: "a64",
			streamKey: "a64",
			destination: {
				...m.destination,
				path: "output/live-rtmp-simple/audio/64000",
			},
		} as (typeof plan.muxings)[number]);
		return plan;
	}
	const mediaNames = (plan: ReturnType<typeof loadPlan>) =>
		compileLiveChannel(plan)
			.filter((op) => op.kind === "CREATE_HLS_AUDIO_MEDIA")
			.map((op) => op.payload.name);

	it("two audio renditions get two NAMEs in the group", () => {
		// AWS Live A/B/E and the MSL4 M2 run all published both entries as
		// "HLS Audio Media". The verifier's parser keys entries by NAME, so the
		// second silently replaced the first and the duplicate was invisible.
		expect(mediaNames(withSecondAudio())).toEqual([
			"HLS Audio Media (a128)",
			"HLS Audio Media (a64)",
		]);
	});

	it("one audio rendition keeps the vendor literal — every live golden is byte-identical", () => {
		expect(mediaNames(loadPlan("live-rtmp-simple"))).toEqual([
			"HLS Audio Media",
		]);
	});
});

describe("MSL4 manifest paths on the wire (re-audit 2026-08-29 BLOCKER-5, ledger #220)", () => {
	it("mslManifestPath: empty stays empty, anything else gets a leading AND trailing slash", () => {
		expect(mslManifestPath("")).toBe("");
		expect(mslManifestPath("output/x")).toBe("/output/x/");
		expect(mslManifestPath("/output/x/")).toBe("/output/x/");
		expect(mslManifestPath("//output/x//")).toBe("/output/x/");
	});
	it("an MSL primary publishes at the plan's (event-root) path with no mirror paths", () => {
		const plan = liveChannelPlanSchema.parse(
			JSON.parse(
				readFileSync(
					join(__dirname, "__fixtures__/live-akamai-msl.plan.json"),
					"utf8",
				),
			),
		);
		const manifests = compileLiveChannel(plan).filter((op) =>
			op.kind.startsWith("CREATE_MANIFEST_"),
		);
		expect(manifests.length).toBeGreaterThan(0);
		for (const op of manifests) {
			expect(op.payload.outputPath).toBe("");
			expect(op.payload).not.toHaveProperty("mirrorOutputPaths");
		}
	});
	it("an MSL MIRROR of a storage primary gets the `/folder/` form while the primary keeps its folder", () => {
		const plan = liveChannelPlanSchema.parse(
			JSON.parse(
				readFileSync(
					join(__dirname, "__fixtures__/live-akamai-msl-storage.plan.json"),
					"utf8",
				),
			),
		);
		const manifests = compileLiveChannel(plan).filter((op) =>
			op.kind.startsWith("CREATE_MANIFEST_"),
		);
		expect(manifests.length).toBeGreaterThan(0);
		for (const op of manifests) {
			expect(op.payload.outputPath).toBe("output/live-akamai-msl-storage");
			expect(op.payload.mirrorOutputPaths).toEqual([
				"/output/live-akamai-msl-storage/",
			]);
			expect(op.refs.mirrorOutputIds).toEqual(["output:mirror-1"]);
		}
	});
});

describe("mixed-codec live DASH — one video set per codec (eb7c983 HIGH-2)", () => {
	/**
	 * DASH video adaptation sets must be separated by codec. An H264+H265 Live
	 * channel cannot place the first H265 representation in the H264 set.
	 */
	const videoSets = (plan: ReturnType<typeof loadPlan>) =>
		compileLiveChannel(plan)
			.filter((op) => op.kind === "CREATE_DASH_ADAPTATION_SET_VIDEO")
			.map((op) => op.step);

	it("creates one set per video codec, with deterministic step ids", () => {
		// Order is the plan's muxing order (H265 rungs first in this fixture),
		// not an alphabetical sort — the ids and their emission order are a
		// function of the plan and nothing else.
		expect(videoSets(loadPlan("live-mixed-codec-dash"))).toEqual([
			"manifest:dash:aset-video-h265",
			"manifest:dash:aset-video-h264",
		]);
	});

	it("puts each representation in ITS OWN codec's set", () => {
		// The relation, not two right answers: both sets exist and both are
		// cited, so a swap of the two codecs' representations would satisfy any
		// assertion that only checked which ids appear.
		const plan = loadPlan("live-mixed-codec-dash");
		const byRendition = new Map(plan.renditions.map((r) => [r.key, r.codec]));
		const reps = compileLiveChannel(plan).filter(
			(op) => op.kind === "CREATE_DASH_REPRESENTATION_FMP4",
		);
		expect(reps.length).toBe(5);
		for (const rep of reps) {
			// `refs` values are `string | string[]` (mirrorOutputIds is a list),
			// so narrow rather than cast — a ref that arrived as an array would
			// otherwise silently key the map with "undefined".
			const muxingId = rep.refs.muxingId;
			expect(typeof muxingId, `${rep.step} muxingId`).toBe("string");
			const muxingKey =
				typeof muxingId === "string" ? muxingId.replace("muxing:", "") : "";
			const codec = byRendition.get(muxingKey);
			expect(rep.refs.adaptationSetId, `${rep.step} (${codec})`).toBe(
				codec === "AAC"
					? "manifest:dash:aset-audio"
					: `manifest:dash:aset-video-${(codec ?? "").toLowerCase()}`,
			);
		}
	});

	it("does NOT create the base `aset-video` for a mixed channel", () => {
		// The negative arm. Before the fix every representation referenced this
		// step; after it, the step does not exist — which is what makes the old
		// shape a dangling reference rather than a different-but-equal one.
		const ops = compileLiveChannel(loadPlan("live-mixed-codec-dash"));
		expect(ops.some((op) => op.step === "manifest:dash:aset-video")).toBe(
			false,
		);
		// And nothing cites a set that no op creates. The golden suite's
		// only-backward-references check covers the corpus; this names the
		// property the mixed fixture exists to hold.
		const created = new Set(
			ops
				.filter(
					(op) =>
						op.kind === "CREATE_DASH_ADAPTATION_SET_VIDEO" ||
						op.kind === "CREATE_DASH_ADAPTATION_SET_AUDIO",
				)
				.map((op) => op.step),
		);
		for (const op of ops) {
			const target = op.refs.adaptationSetId;
			if (target === undefined) {
				continue;
			}
			// Flatten rather than cast: `refs` values may be lists, and every
			// element has to resolve, not just the first one.
			for (const one of Array.isArray(target) ? target : [target]) {
				expect(created.has(one), `${op.step} → ${one}`).toBe(true);
			}
		}
	});

	it("a single-codec channel keeps the historical `aset-video` step id", () => {
		// Why the other fourteen live goldens are byte-identical. Asserted
		// rather than read off the diff: this is the control a fix that
		// suffixed unconditionally would break.
		expect(videoSets(loadPlan("live-rtmp-simple"))).toEqual([
			"manifest:dash:aset-video",
		]);
	});

	it("a mixed channel's HLS variants are unaffected — one per video muxing", () => {
		// Scope, stated: HLS variants are independent playlists with no shared
		// set to be refused, so the fix touches DASH only. Asserted rather than
		// assumed, because "unaffected" is a claim about another part of the
		// same compile.
		const ops = compileLiveChannel(loadPlan("live-mixed-codec-dash"));
		expect(
			ops.filter((op) => op.kind === "CREATE_HLS_STREAM_INFO").length,
		).toBe(4);
	});
});
