import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSensitiveKey } from "../crypto/redact";
import {
	type CompiledOperation,
	compilePlan,
	relativeSegmentPath,
} from "./compiler";
import { VOD_FIXTURES } from "./fixtures";

const FIXTURES = VOD_FIXTURES;

import { encodingPlanSchema } from "./schema";
import { loadPlan } from "./test-support";
import { planHasErrors, validatePlan } from "./validate";

/**
 * Golden tests (REQUIREMENTS §7.1): each encoding examples scenario is a plan
 * fixture whose compiled operation sequence is pinned. Regenerate expected
 * files deliberately with UPDATE_GOLDEN=1 (then review the diff — the ops
 * ARE the acceptance contract).
 */

const dir = join(__dirname, "__fixtures__");

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
	// from. The first version asserted `FIXTURES` against `VOD_FIXTURES` where
	// `const FIXTURES = VOD_FIXTURES` — a comparison of a name with itself, which
	// fires only if someone edits that one declaration. Filtering AT THE LOOP
	// (`for (const name of FIXTURES.filter(...))`) dropped four tests with the
	// suite green and this pin silent (review-300 F3). It guarded the one
	// spelling I happened to use while testing it, which is the blind-spot
	// shape this whole branch has been about.
	expect([...ITERATED].sort()).toEqual([...VOD_FIXTURES].sort());
});

describe("segment naming template on the VOD path (ledger #159)", () => {
	// The schema accepted segmentNamingTemplate on FMP4/TS while this
	// compiler silently dropped it — an operator's {segment_rand_chars:x}
	// (URL-guess prevention) never reached the wire. Exclusive with
	// segmentNaming, the SDK's own rule, exactly as the live compiler
	// has emitted since #137.
	it("emits the template INSTEAD of segmentNaming when set, for FMP4 and TS", () => {
		const plan = loadPlan("fixed-bitrate-hls-on-aws");
		const withTemplate = {
			...plan,
			muxings: plan.muxings.map((m) =>
				m.kind === "FMP4" || m.kind === "TS"
					? {
							...m,
							segmentNamingTemplate: "seg_{segment_rand_chars:8}_%number%",
						}
					: m,
			),
		};
		const ops = compilePlan(encodingPlanSchema.parse(withTemplate));
		const muxingOps = ops.filter(
			(o) => o.kind === "CREATE_MUXING_FMP4" || o.kind === "CREATE_MUXING_TS",
		);
		expect(muxingOps.length).toBeGreaterThan(0);
		for (const op of muxingOps) {
			expect(op.payload.segmentNamingTemplate).toBe(
				"seg_{segment_rand_chars:8}_%number%",
			);
			expect(op.payload).not.toHaveProperty("segmentNaming");
		}
		// And absent template keeps today's wire exactly (the goldens pin
		// this corpus-wide; asserted here so the pair is visible together).
		const plain = compilePlan(encodingPlanSchema.parse(plan)).filter(
			(o) => o.kind === "CREATE_MUXING_FMP4" || o.kind === "CREATE_MUXING_TS",
		);
		for (const op of plain) {
			expect(op.payload.segmentNaming).toBeDefined();
			expect(op.payload).not.toHaveProperty("segmentNamingTemplate");
		}
	});

	it("carries the NexGuard NGPR payload ID to the op — the wire below always accepted it", () => {
		const plan = loadPlan("nexguard-watermarking");
		const withPayload = {
			...plan,
			renditions: plan.renditions.map((r) =>
				"nexguard" in r && r.nexguard
					? { ...r, nexguard: { ...r.nexguard, payload: 12345 } }
					: r,
			),
		};
		const ops = compilePlan(encodingPlanSchema.parse(withPayload));
		const markers = ops.filter((o) => o.kind === "CREATE_NEXGUARD_FILE_MARKER");
		expect(markers.length).toBeGreaterThan(0);
		for (const op of markers) {
			expect(op.payload.payload).toBe(12345);
		}
		// Absent stays absent — the goldens pin the plain corpus.
		const plain = compilePlan(encodingPlanSchema.parse(plan)).filter(
			(o) => o.kind === "CREATE_NEXGUARD_FILE_MARKER",
		);
		for (const op of plain) {
			expect(op.payload).not.toHaveProperty("payload");
		}
	});
});

describe("Kantar fan-out across a multi-encoding ladder (P5 PR-4)", () => {
	/**
	 * Renditions are partitioned by encodingKey, so a blind per-encoding
	 * fan-out configures Kantar on video-only siblings — exactly the state
	 * PLAN_KANTAR_NEEDS_AUDIO forbids (licence consumed, nothing
	 * watermarked). Every Dolby golden has audio in the DV ladder only, so
	 * this is the repo's dominant multi-encoding shape, not a corner case.
	 * Regression test for the review probe that found it.
	 */
	function dolbyPlanWithKantar() {
		const plan = loadPlan("dolby-dv-hdr10-sdr-3ladder-profile5-single-input");
		plan.kantar = {
			credentialId: "00000000-0000-4000-8000-0000000000b1",
			licenseId: 4711,
			channelName: "Demo",
			contentReference: "ep01",
			serverUrl: "https://kantar.example.com/watermark",
			reportDestination: {
				outputKey: plan.outputs[0]?.key ?? "origin",
				path: "reports",
			},
		};
		return plan;
	}

	it("emits a Kantar op ONLY for encodings that carry audio", () => {
		const plan = dolbyPlanWithKantar();
		const audioByEncoding = new Map<string, number>();
		for (const rendition of plan.renditions) {
			const key = rendition.encodingKey ?? "";
			const isAudio = ["AAC", "DOLBY_ATMOS", "DDPLUS", "DD"].includes(
				rendition.codec,
			);
			audioByEncoding.set(
				key,
				(audioByEncoding.get(key) ?? 0) + (isAudio ? 1 : 0),
			);
		}
		const withAudio = [...audioByEncoding.entries()]
			.filter(([, count]) => count > 0)
			.map(([key]) => key);
		const withoutAudio = [...audioByEncoding.entries()]
			.filter(([, count]) => count === 0)
			.map(([key]) => key);
		// The fixture must actually exercise the split, or this proves nothing.
		expect(withAudio.length).toBeGreaterThan(0);
		expect(withoutAudio.length).toBeGreaterThan(0);

		const ops = compilePlan(plan);
		const kantarEncodingIds = ops
			.filter((op) => op.kind === "CREATE_KANTAR_WATERMARK")
			.map((op) => op.refs.encodingId);
		expect(kantarEncodingIds).toEqual(
			withAudio.map((key) => `encoding:${key}`),
		);
		for (const key of withoutAudio) {
			expect(kantarEncodingIds).not.toContain(`encoding:${key}`);
		}
	});

	it("emits one op for the implicit single encoding when it has audio", () => {
		const ops = compilePlan(loadPlan("kantar-audio-watermark"));
		const kantar = ops.filter((op) => op.kind === "CREATE_KANTAR_WATERMARK");
		expect(kantar).toHaveLength(1);
		expect(kantar[0]?.refs.encodingId).toBe("encoding");
	});
});

describe("compilePlan golden fixtures", () => {
	for (const name of FIXTURES) {
		ITERATED.push(name);
		describe(name, () => {
			const plan = loadPlan(name);
			const ops = compilePlan(plan);
			const expectedPath = join(dir, `${name}.ops.json`);

			it("validates with codec modes separate from the start request", () => {
				expect(planHasErrors(validatePlan(plan))).toBe(false);
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
				]) {
					expect(text).not.toContain(banned);
				}
				// Structural check: no payload KEY may look secret per the
				// runtime redaction matcher (kid passes; "key"/"license"/
				// suffixed variants fail). FairPlay skd:// uris legitimately
				// contain "token" as a value substring, hence keys-only.
				const assertNoSensitiveKeys = (value: unknown): void => {
					if (Array.isArray(value)) {
						for (const item of value) {
							assertNoSensitiveKeys(item);
						}
						return;
					}
					if (value && typeof value === "object") {
						for (const [k, item] of Object.entries(value)) {
							expect(isSensitiveKey(k), `payload key "${k}" looks secret`).toBe(
								false,
							);
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

	it("JIT start pins manifestGenerator V2 with manifest refs (C3)", () => {
		const ops = compilePlan(loadPlan("dash-hls-sftp-output-just-in-time"));
		const start = ops.find((op) => op.kind === "START_ENCODING");
		expect(start?.payload).toEqual({ manifestGenerator: "V2" });
		expect(start?.refs.vodHlsManifestIds).toEqual(["manifest:hls"]);
		expect(start?.refs.vodDashManifestIds).toEqual(["manifest:dash"]);
		// JIT: manifest trees exist before the start op.
		const startIndex = ops.findIndex((op) => op.kind === "START_ENCODING");
		expect(
			ops.findIndex((op) => op.kind === "CREATE_MANIFEST_HLS"),
		).toBeLessThan(startIndex);
	});

	it("post-encoding starts empty and generates manifests after the await", () => {
		const ops = compilePlan(loadPlan("dash-hls-sftp-output-post-encoding"));
		const start = ops.find((op) => op.kind === "START_ENCODING");
		expect(start?.payload).toEqual({});
		expect(start?.refs.vodHlsManifestIds).toBeUndefined();
		const awaitIndex = ops.findIndex((op) => op.kind === "AWAIT_ENCODING");
		const manifestIndex = ops.findIndex(
			(op) => op.kind === "CREATE_MANIFEST_HLS",
		);
		expect(manifestIndex).toBeGreaterThan(awaitIndex);
		const kinds = ops.map((op) => op.kind);
		expect(kinds).toContain("START_MANIFEST_HLS");
		expect(kinds).toContain("AWAIT_MANIFEST_DASH");
	});

	it("derives HLS uris and segment paths like the samples", () => {
		const ops = compilePlan(loadPlan("fixed-bitrate-hls-on-aws"));
		const media = ops.filter((op) => op.kind === "CREATE_HLS_AUDIO_MEDIA");
		const variants = ops.filter((op) => op.kind === "CREATE_HLS_STREAM_INFO");
		expect(variants.map((op) => op.payload.uri)).toEqual([
			"video_300000.m3u8",
			"video_600000.m3u8",
		]);
		expect(media.map((op) => op.payload.uri)).toEqual([
			"audio_128000.m3u8",
			"audio_64000.m3u8",
		]);
		expect(variants[0]?.payload.segmentPath).toBe("video/360p");
		expect(media[0]?.payload.segmentPath).toBe("audio/128000");
	});

	it("carries stream conditions through to CREATE_STREAM", () => {
		const ops = compilePlan(
			loadPlan("fixed-bitrate-dash-hls-streamcondition-on-aws"),
		);
		const audioStream = ops.find((op) => op.step === "stream:a128");
		expect(audioStream?.payload.conditions).toEqual({
			attribute: "AUDIOSTREAMCOUNT",
			operator: "GREATER_THAN",
			value: "0",
		});
		const videoStream = ops.find((op) => op.step === "stream:v360");
		expect(videoStream?.payload).not.toHaveProperty("conditions");
	});
});

describe("nested VOD manifest directories", () => {
	it.each([
		"fixed-bitrate-hls-on-aws",
		"cenc-cbc-drm-on-aws",
	])("references the selected clear or DRM destination in %s", (name) => {
		const plan = loadPlan(name);
		for (const manifest of plan.manifests)
			manifest.destination.path = `${manifest.destination.path.replace(/\/$/, "")}/${manifest.key}-2`;
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const entries = compilePlan(plan).filter(
			(operation) => typeof operation.payload.segmentPath === "string",
		);
		expect(entries.length).toBeGreaterThan(0);
		for (const operation of entries) {
			const manifest = plan.manifests.find(
				(entry) => `manifest:${entry.key}` === operation.refs.manifestId,
			);
			const muxing = plan.muxings.find(
				(entry) => `muxing:${entry.key}` === operation.refs.muxingId,
			);
			const drm = manifest?.drmKind
				? plan.drm.find(
						(entry) =>
							entry.muxingKey === muxing?.key &&
							entry.kind === manifest.drmKind,
					)
				: undefined;
			const destination = drm?.destination ?? muxing?.destination;
			if (!manifest || !destination) throw new Error("Missing VOD destination");
			expect(String(operation.payload.segmentPath)).toMatch(/^\.\.\//);
			expect(
				new URL(
					`${operation.payload.segmentPath}/seg.m4s`,
					`https://delivery.example/published/${manifest.destination.path}/stream.m3u8`,
				).href,
			).toBe(`https://delivery.example/published/${destination.path}/seg.m4s`);
		}
	});
});

describe("relativeSegmentPath", () => {
	it("resolves descendant and unrelated directories from the manifest base", () => {
		expect(relativeSegmentPath("output/x/video/360p", "output/x/")).toBe(
			"video/360p",
		);
		expect(relativeSegmentPath("elsewhere/video/360p", "output/x/")).toBe(
			"../../elsewhere/video/360p",
		);
	});

	it("normalizes a missing trailing slash instead of mangling", () => {
		expect(relativeSegmentPath("output/x/video/360p", "output/x")).toBe(
			"video/360p",
		);
	});

	it("does not strip sibling prefixes", () => {
		expect(relativeSegmentPath("output/x2/video/360p", "output/x")).toBe(
			"../x2/video/360p",
		);
	});
	it.each([
		["output/x/video/720p", "output/x/hls-2", "../video/720p"],
		["output/x/audio/128000", "output/x/hls-2", "../audio/128000"],
		["output/video/", "output/manifests/hls", "../../video/"],
		["output", "output/hls", ".."],
		["output/x", "output/x", ""],
		["", "output/x", "../.."],
		["video/720p", "", "video/720p"],
		["/assets/video/", "output/x", "/assets/video/"],
		[
			"https://media.example/video/",
			"output/x",
			"https://media.example/video/",
		],
		["//media.example/video/", "output/x", "//media.example/video/"],
	])("resolves segment directory %s from %s", (target, base, expected) => {
		const actual = relativeSegmentPath(target, base);
		expect(actual).toBe(expected);
		const delivery = "https://delivery.example/published/";
		const child = `${actual}${actual && !actual.endsWith("/") ? "/" : ""}seg.m4s`;
		const source = `${target}${target && !target.endsWith("/") ? "/" : ""}seg.m4s`;
		const master = `${base}${base && !base.endsWith("/") ? "/" : ""}stream.m3u8`;
		expect(new URL(child, new URL(master, delivery)).href).toBe(
			new URL(source, delivery).href,
		);
	});
});
