import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compilePlan, qcMirrorFilename } from "../plan/compiler";
import { muxingStreamKeys } from "../plan/muxing-streams";
import { AUDIO_CODECS, encodingPlanSchema } from "../plan/schema";
import { compileExpectedArtefacts, pathPattern } from "./expected";

/**
 * Golden coverage for the expectation compiler, glob-driven from the fixture
 * directory — the same shape `plan-import.test.ts` uses, and for the same reason: a
 * new plan fixture must gain its verification automatically, or the corpus quietly
 * grows a scenario nothing checks.
 *
 * Regenerate deliberately with `UPDATE_EXPECTED=1 pnpm --filter @bitovp/core test`
 * and review the diff like an `.ops.json` diff. Nothing here reaches a network, a
 * bucket or ffprobe: this half of verification is pure.
 */

const FIXTURES = join(import.meta.dirname, "..", "plan", "__fixtures__");
const UPDATE = process.env.UPDATE_EXPECTED === "1";

// `readdirSync`, not `import.meta.glob`: the glob is a Vite transform and this file
// also runs under plain tsc. `plan-import.test.ts` reads the same directory the same
// way — one idiom for fixture discovery, so a new fixture is covered by both.
const planFiles = readdirSync(FIXTURES)
	.filter((f) => f.endsWith(".plan.json"))
	.sort();

describe("nullable video rate is not a zero-fps target", () => {
	it.each([null, undefined, 24])("keeps only an explicit rate (%s)", (rate) => {
		const raw = JSON.parse(
			readFileSync(join(FIXTURES, "vp9-webm-fixed-dash.plan.json"), "utf8"),
		);
		for (const rendition of raw.renditions) {
			if (rendition.codec === "VP9") rendition.rate = rate;
		}
		const expected = compileExpectedArtefacts(encodingPlanSchema.parse(raw));
		const video = expected.muxings.flatMap((m) => (m.video ? [m.video] : []));
		expect(video).toHaveLength(4);
		for (const target of video) {
			if (rate === 24) expect(target.fps).toBe(24);
			else expect(target).not.toHaveProperty("fps");
		}
	});
});

describe("every expected dir is slash-terminated (ledger #61 a)", () => {
	it("no artefact dir prefix can match a sibling directory", () => {
		// The four compile sites were bare while manifest :566 normalised —
		// "out/thumbs" as a PREFIX also matches "out/thumbsXL/x.jpg": a false
		// PASS on the existence/count assertions and a false FAIL on
		// hygiene:foreign-objects. Corpus-wide, live-compiled (not the
		// goldens, so a stale regen cannot satisfy it): every dir.prefix is
		// empty or ends in "/". Thumbnails were 2/2 and sprites 1/1
		// slash-less, so this is the 100% case for those artefact types.
		const dirs: { where: string; prefix: string; pattern: string }[] = [];
		const collect = (node: unknown, where: string) => {
			if (Array.isArray(node)) {
				node.forEach((item, i) => {
					collect(item, `${where}[${i}]`);
				});
				return;
			}
			if (node && typeof node === "object") {
				const record = node as Record<string, unknown>;
				const dir = record.dir as
					| { prefix?: unknown; pattern?: unknown }
					| undefined;
				if (
					dir &&
					typeof dir === "object" &&
					typeof dir.prefix === "string" &&
					typeof dir.pattern === "string"
				) {
					dirs.push({ where, prefix: dir.prefix, pattern: dir.pattern });
				}
				for (const [key, value] of Object.entries(record)) {
					if (key !== "dir") {
						collect(value, `${where}.${key}`);
					}
				}
			}
		};
		for (const file of planFiles) {
			const name = file.replace(".plan.json", "");
			const plan = encodingPlanSchema.parse(
				JSON.parse(readFileSync(join(FIXTURES, `${name}.plan.json`), "utf8")),
			);
			collect(compileExpectedArtefacts(plan), name);
		}
		// PER-FAMILY minimums, not one floor (review-182 S1: a 502-total floor
		// could not see the one-sprite family collapsing out of the collector —
		// the review-179 vacuity shape). Measured histogram: muxings 341,
		// manifests 103, drm 54, thumbnails 2, sprites 1, qc 1. Manifests are
		// ALREADY all-slashed in the corpus, so for that family this sweep is
		// corroboration — the dedicated slash-less manifest unit test is its
		// real pin (review-182 N1/M2).
		const byFamily = new Map<string, number>();
		for (const dir of dirs) {
			const family = dir.where.replace(/^[^.]*\./, "").split(/[.[]/)[0] ?? "";
			byFamily.set(family, (byFamily.get(family) ?? 0) + 1);
		}
		expect(byFamily.get("muxings") ?? 0).toBeGreaterThan(300);
		expect(byFamily.get("manifests") ?? 0).toBeGreaterThan(90);
		expect(byFamily.get("drm") ?? 0).toBeGreaterThan(40);
		expect(byFamily.get("thumbnails") ?? 0).toBeGreaterThan(1);
		expect(byFamily.get("sprites") ?? 0).toBeGreaterThan(0);
		expect(byFamily.get("qc") ?? 0).toBeGreaterThan(0);
		const bare = dirs.filter((d) => d.prefix !== "" && !d.prefix.endsWith("/"));
		expect(bare.map((d) => d.where)).toEqual([]);
		// Review-182 S2: today an empty prefix occurs ONLY on a DRM'd muxing
		// with no destination of its own — and then the PATTERN is empty too.
		// Pinned so a path STARTING with a placeholder (empty prefix, non-empty
		// pattern — the same defect class as the mid-segment residual recorded
		// on row 61) cannot hide inside the allowance.
		expect(
			dirs
				.filter((d) => d.prefix === "" && d.pattern !== "")
				.map((d) => d.where),
		).toEqual([]);
	});
});

describe("compileExpectedArtefacts — goldens", () => {
	it("finds the whole fixture corpus, so a broken glob cannot pass over nothing", () => {
		// 67 VOD plans, measured . A drop means the glob broke, not that the corpus did.
		// 70→71 on 2026-08-28: `vp9-webm-fixed-dash`.
		// 71→72 same day: `mixed-codec-dash-hls` .
		expect(planFiles.length).toBe(72);
	});

	for (const file of planFiles) {
		const name = file.replace(".plan.json", "");
		it(`${name} compiles to its pinned expectations`, () => {
			const plan = encodingPlanSchema.parse(
				JSON.parse(readFileSync(join(FIXTURES, `${name}.plan.json`), "utf8")),
			);
			const actual = compileExpectedArtefacts(plan);
			const goldenPath = join(FIXTURES, `${name}.expected.json`);
			if (UPDATE) {
				writeFileSync(goldenPath, `${JSON.stringify(actual, null, "\t")}\n`);
			}
			const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
			expect(actual).toEqual(golden);
		});
	}
});

describe("compileExpectedArtefacts — properties that must hold for every fixture", () => {
	const compiled = planFiles.map((file) => {
		const name = file.replace(".plan.json", "");
		const plan = encodingPlanSchema.parse(
			JSON.parse(readFileSync(join(FIXTURES, `${name}.plan.json`), "utf8")),
		);
		return { name, plan, expected: compileExpectedArtefacts(plan) };
	});

	it("expects at least one artefact for every plan", () => {
		/**
		 * A plan that compiles to no expectations would "verify" green while proving nothing —
		 * the exact failure mode this whole harness exists to prevent.
		 *
		 * A `qc.only` plan has no delivery artefacts by design (the compiler emits none), so its
		 * artefacts are the QC MIRRORS. Counting those keeps the property meaningful instead of
		 * exempting the one plan where it would otherwise be trivially false.
		 */
		for (const { name, expected } of compiled) {
			expect(
				expected.muxings.length +
					expected.manifests.length +
					(expected.qc?.mirrors.length ?? 0),
				name,
			).toBeGreaterThan(0);
		}
	});

	it("retains every delivery mirror as a separately browsable output leg", () => {
		const mirrored = compiled.filter(
			({ plan }) => (plan.deliveryMirrors?.length ?? 0) > 0,
		);
		expect(mirrored.map(({ name }) => name)).toEqual(["multi-output-s3-gcs"]);
		for (const { name, plan, expected } of mirrored) {
			const mirrorKeys =
				plan.deliveryMirrors?.map(({ outputKey }) => outputKey) ?? [];
			expect(expected.deliveryMirrorOutputKeys, name).toEqual(mirrorKeys);
			for (const outputKey of mirrorKeys) {
				expect(expected.outputKeys, `${name}/${outputKey}`).toContain(
					outputKey,
				);
			}
		}
	});

	it("emits one expected muxing per plan muxing, never merging or dropping", () => {
		/**
		 * …except for `qc.only`, where the correct count is ZERO.
		 *
		 * `compiler.ts` is explicit — "VMAF-only encode (qc.only): emit NO delivery muxings" —
		 * and it keeps the muxings in the PLAN only so the qc-mirror block can read each
		 * rendition's destination. This expectation used to map `plan.muxings` regardless, so
		 * `vmaf-only-h264` demanded an `init.mp4` and fMP4 segments from a run that had
		 * correctly written one file: `…/video/540p/qc/v540.mp4`. A real run reported it as two
		 * product FAILs and zero PASSes.
		 */
		for (const { name, plan, expected } of compiled) {
			const wantMuxings = plan.qc?.only ? 0 : plan.muxings.length;
			expect(expected.muxings.length, name).toBe(wantMuxings);
			expect(expected.manifests.length, name).toBe(plan.manifests.length);
		}
	});

	it("declares a media block for EVERY stream a container packages", () => {
		/**
		 * The durable pin for #192, corpus-wide and derived from the PLAN.
		 *
		 * The goldens already carry the two muxed fixtures, but a golden is a
		 * restatement: regenerate it and the fact quietly becomes whatever the
		 * code now says. This asks the question directly, of all 70 plans — for
		 * each container, the media families the expectation declares must be
		 * exactly the families of the streams that container carries.
		 *
		 * What it caught: an if/else-if over `muxing.streamKey` gave a muxed
		 * HLS/TS `video` and no `audio`, so `engine.ts`'s `if (muxing.audio)`
		 * never fired and the AAC track inside the segments — the entire point
		 * of muxing it in — was never ffprobed. Nothing failed; the harness was
		 * simply blind to it, which is the shape this file's codec note-arm was
		 * written to prevent one axis over.
		 */
		let muxedContainers = 0;
		for (const { name, plan, expected } of compiled) {
			if (plan.qc?.only) {
				continue; // no delivery muxings by design
			}
			const renditionByKey = new Map(plan.renditions.map((r) => [r.key, r]));
			for (const muxing of plan.muxings) {
				const packagedKeys = muxingStreamKeys(muxing);
				if (packagedKeys.length > 1) {
					muxedContainers++;
				}
				const packaged = packagedKeys
					.map((k) => renditionByKey.get(k))
					.filter((r) => r !== undefined);
				// Unresolved refs are a NOTE, not a media block — skip those.
				if (packaged.length !== packagedKeys.length) {
					continue;
				}
				const want = {
					video: packaged.some(
						(r) => !AUDIO_CODECS.has(r.codec) && r.codec !== "WEBVTT",
					),
					audio: packaged.some((r) => AUDIO_CODECS.has(r.codec)),
					text: packaged.some((r) => r.codec === "WEBVTT"),
				};
				const got = expected.muxings.find((m) => m.muxingKey === muxing.key);
				const where = `${name}/${muxing.key}`;
				expect(got, where).toBeDefined();
				expect(got?.video !== undefined, `${where} video`).toBe(want.video);
				expect(got?.audio !== undefined, `${where} audio`).toBe(want.audio);
				expect(got?.text !== undefined, `${where} text`).toBe(want.text);
			}
		}
		// A corpus with no multiplexed container would pass this vacuously and
		// stop being a pin the day the muxed fixtures were renamed away.
		expect(
			muxedContainers,
			"multiplexed containers in the corpus",
		).toBeGreaterThan(0);
	});

	it("counts a concatenation's sources, so the segment count is derived from the OUTPUT", () => {
		/**
		 * `concatenation-two-sources` FAILed a real run with
		 * `ceil(10.04s / 6s) = 2, so [2, 3] segments — found 4`. Four was right: the verify
		 * rewrite points both sources at the same 10.04s mezzanine, so the output is 20.08s and
		 * ceil(20.08 / 6) = 4 exactly. The expectation had no way to say "the output is longer
		 * than one source", so the engine divided by the wrong duration.
		 */
		const concat = compiled.filter(
			({ plan }) => (plan.concatenationStreams ?? []).length > 0,
		);
		expect(concat.map((c) => c.name)).toEqual(["concatenation-two-sources"]);
		for (const { name, plan, expected } of concat) {
			const most = Math.max(
				...(plan.concatenationStreams ?? []).map((c) => c.sources.length),
			);
			expect(expected.concatenatedSources, name).toBe(most);
			expect(expected.concatenatedSources, name).toBe(2);
			// And it must SAY so, or a reader cannot tell why a count of 4 is right.
			expect(
				expected.notes.some((n) => /concatenation plan/.test(n)),
				name,
			).toBe(true);
		}
	});

	it("records the TRIM duration, so the count is derived from the output", () => {
		/**
		 * `trimming-time-based` cuts 30 seconds out of its source. Run against the full 596.46s
		 * Big Buck Bunny, the engine demanded `[99, 101]` segments of an encode that correctly
		 * wrote 5 — the source's duration is the wrong divisor whenever a trim is in play, in
		 * exactly the way it is wrong for a concatenation in the other direction.
		 */
		const trimmed = compiled.filter(
			({ plan }) => (plan.trimmingStreams ?? []).length > 0,
		);
		expect(trimmed.map((c) => c.name)).toEqual(["trimming-time-based"]);
		for (const { name, expected } of trimmed) {
			expect(expected.trimmedToSeconds, name).toBe(30);
			expect(
				expected.notes.some((n) => /trimming plan/.test(n)),
				name,
			).toBe(true);
		}
	});

	it("takes the SHORTEST trim when a plan carries several", () => {
		/**
		 * Shortest, because every muxing of a trimmed encoding carries the trimmed stream, so the
		 * tightest trim describes the output. The corpus has exactly one trim, so `min` and `max`
		 * are the same value there and a mutation swapping them survived — built by hand rather
		 * than left unpinned.
		 */
		const base = compiled.find((c) => c.name === "trimming-time-based")
			?.plan as (typeof compiled)[number]["plan"];
		const two = {
			...base,
			trimmingStreams: [
				{
					key: "a",
					kind: "TIME_BASED" as const,
					sourceKey: "video",
					offset: 10,
					duration: 30,
				},
				{
					key: "b",
					kind: "TIME_BASED" as const,
					sourceKey: "video",
					offset: 0,
					duration: 12,
				},
			],
		};
		expect(
			compileExpectedArtefacts(two as unknown as typeof base).trimmedToSeconds,
		).toBe(12);
	});

	it("ignores a TIMECODE_TRACK trim, whose length is not derivable here", () => {
		/**
		 * It declares start/end timecodes, which need the source's timecode track to resolve — so
		 * treating it as a duration would be inventing a number.
		 *
		 * Recorded honestly: the `kind !== "TIME_BASED"` guard in the derivation is REDUNDANT
		 * today, because a TIMECODE_TRACK trim carries no `duration` field at all and the
		 * `typeof duration !== "number"` check alone already skips it. A mutation removing the
		 * kind check therefore survives, and that is not a hole in this test — it is the guard
		 * being defensive about a schema that could gain the field later.
		 */
		const base = compiled.find((c) => c.name === "trimming-time-based")
			?.plan as (typeof compiled)[number]["plan"];
		const tc = {
			...base,
			trimmingStreams: [
				{
					key: "a",
					kind: "TIMECODE_TRACK" as const,
					sourceKey: "video",
					startTimeCode: "00:00:10:00",
					endTimeCode: "00:00:40:00",
				},
			],
		};
		expect(
			compileExpectedArtefacts(tc as unknown as typeof base).trimmedToSeconds,
		).toBeUndefined();
	});

	it("leaves trimmedToSeconds absent for every plan that does not trim", () => {
		// Absent rather than the source duration, so "no trim" and "trimmed to the whole thing"
		// are not the same value.
		for (const { name, plan, expected } of compiled) {
			if ((plan.trimmingStreams ?? []).length === 0) {
				expect(expected.trimmedToSeconds, name).toBeUndefined();
			}
		}
	});

	it("leaves concatenatedSources absent for every plan that does not concatenate", () => {
		// An always-present 1 would be indistinguishable from "the field was never wired",
		// which is the shape of the qc fields nothing read for months.
		for (const { name, plan, expected } of compiled) {
			if ((plan.concatenationStreams ?? []).length === 0) {
				expect(expected.concatenatedSources, name).toBeUndefined();
			}
		}
	});

	it("resolves a QC mirror per video rendition wherever qc is on", () => {
		/**
		 * `expected.qc` carried `mirrorRenditionKeys` and `mirrorDirSuffix` and NOTHING read
		 * them — not the engine, not a test. So the QC mirror MP4 the compiler creates was never
		 * verified for any plan. Resolved paths give the engine something to open.
		 */
		const withQc = compiled.filter(({ expected }) => expected.qc);
		expect(withQc.length, "the corpus must still exercise qc").toBeGreaterThan(
			0,
		);
		for (const { name, plan, expected } of withQc) {
			const mirrors = expected.qc?.mirrors ?? [];
			expect(mirrors.length, `${name} mirrors`).toBeGreaterThan(0);
			for (const m of mirrors) {
				// The compiler's rule, restated as an assertion rather than trusted —
				// through the ONE definition (VP9 rides a WebM, ; the
				// hand-built copy this expectation carried said `.mp4` for every
				// codec until review-325 had it derived from enumerateQcTargets).
				const codec = plan.renditions.find(
					(r) => r.key === m.renditionKey,
				)?.codec;
				expect(m.filename, `${name}/${m.renditionKey}`).toBe(
					qcMirrorFilename(m.renditionKey, codec ?? "H264"),
				);
				expect(m.dir.prefix, `${name}/${m.renditionKey}`).toMatch(/qc\/$/);
				expect(m.outputKey, `${name}/${m.renditionKey}`).not.toBe("");
				// And the bucket must be one the engine will open.
				expect(expected.outputKeys, name).toContain(m.outputKey);
			}
			// One per VIDEO rendition; audio has nothing to score.
			expect(mirrors.map((m) => m.renditionKey).sort()).toEqual(
				[...(expected.qc?.mirrorRenditionKeys ?? [])].sort(),
			);
			expect(plan.qc?.vmaf === true || plan.qc?.psnr === true, name).toBe(true);
		}
	});

	it("resolves a destination or a DRM route for every muxing", () => {
		// A muxing with neither is unverifiable: nothing knows where to look. If this
		// ever fires, the plan schema grew a third way to address an output.
		for (const { name, expected } of compiled) {
			for (const m of expected.muxings) {
				const routed = m.outputKey !== "" || (m.viaDrmKeys?.length ?? 0) > 0;
				expect(routed, `${name}/${m.muxingKey}`).toBe(true);
			}
		}
	});

	it("keeps runtime placeholders instead of guessing their expansion", () => {
		// C4 per-title paths carry {uuid}/{bitrate}; segment names carry %number%.
		// Expanding either here would produce confidently wrong expectations.
		for (const { name, expected } of compiled) {
			for (const m of expected.muxings) {
				if (/\{[^}]+\}/.test(m.dir.pattern)) {
					expect(m.dir.templated, `${name}/${m.muxingKey}`).toBe(true);
					expect(m.dir.prefix, `${name}/${m.muxingKey}`).not.toContain("{");
				}
			}
		}
	});

	describe("C9 pairing on the branches the corpus does not reach", () => {
		/**
		 * The property test above recomputes the pairing from the plan and it was still
		 * not enough, which was measured rather than assumed: flipping the CTR default
		 * from 8 to 16 — a direct C9 violation — passed all 77 tests, because **every
		 * CENC fixture in the corpus carries an explicit `ivSize`**, so the default arm
		 * was never executed. A corpus-wide loop cannot see an unexercised branch however
		 * carefully it is written; the population of golden plans is not the population of
		 * plan SHAPES. These construct the missing shapes, and that mutation now fails.
		 *
		 * One thing the review flagged turned out NOT to be a defect, and saying so is
		 * part of the record: deriving `schemeType` from the IV size instead of the mode
		 * is *equivalent* for any plan that passes `validatePlan`, because C9 there
		 * rejects a mismatched explicit `ivSize` and defaults an absent mode to CTR — so
		 * mode and size cannot disagree. That mutation survives these tests and should,
		 * since it changes no output. The compiler reads the mode anyway because the mode
		 * is what the constraint is ABOUT, and a reader should not have to re-derive that
		 * equivalence to trust the line.
		 */
		const base = compiled.find(({ name }) => name === "cenc-cbc-drm-on-aws");

		function withDrm(
			mode: "CTR" | "CBC",
			ivSize?: "IV_8_BYTES" | "IV_16_BYTES",
		) {
			if (!base) {
				throw new Error("cenc-cbc-drm-on-aws fixture missing");
			}
			const plan = structuredClone(base.plan);
			for (const row of plan.drm) {
				if (row.kind !== "CENC") {
					continue;
				}
				row.encryptionMode = mode;
				if (ivSize === undefined) {
					delete (row as { ivSize?: unknown }).ivSize;
				} else {
					row.ivSize = ivSize;
				}
			}
			return compileExpectedArtefacts(encodingPlanSchema.parse(plan));
		}

		it("CTR with no explicit ivSize ⇒ 8 bytes, cenc", () => {
			for (const d of withDrm("CTR").drm) {
				if (d.kind !== "CENC") {
					continue;
				}
				expect(d.ivSizeBytes, d.drmKey).toBe(8);
				expect(d.schemeType, d.drmKey).toBe("cenc");
			}
		});

		it("CBC with no explicit ivSize ⇒ 16 bytes, cbcs", () => {
			for (const d of withDrm("CBC").drm) {
				if (d.kind !== "CENC") {
					continue;
				}
				expect(d.ivSizeBytes, d.drmKey).toBe(16);
				expect(d.schemeType, d.drmKey).toBe("cbcs");
			}
		});

		it("keeps the scheme tied to the MODE even when an explicit ivSize is present", () => {
			// The pairing under an explicit ivSize, for completeness. Note this case does
			// NOT distinguish the two derivations — the describe-block comment above says
			// why, and an earlier version of this comment claimed it did, which was simply
			// false (review catch): both fields agree for every consistent pair, and
			// `validatePlan` rejects inconsistent ones.
			for (const d of withDrm("CTR", "IV_8_BYTES").drm) {
				if (d.kind === "CENC") {
					expect(d.schemeType, d.drmKey).toBe("cenc");
				}
			}
			for (const d of withDrm("CBC", "IV_16_BYTES").drm) {
				if (d.kind === "CENC") {
					expect(d.schemeType, d.drmKey).toBe("cbcs");
				}
			}
		});
	});

	it("derives the C9 IV size from the PLAN's encryption mode for every DRM row", () => {
		/**
		 * This test used to restate the implementation — it asserted
		 * `d.ivSizeBytes === 8 ? "cenc" : "cbcs"`, which is what the compiler computed,
		 * and never read the plan at all. A review measured the consequence: changing
		 * which field `schemeType` derives from failed 0 tests across all 66 goldens, and
		 * flipping the CTR default (a direct C9 violation) also failed 0, because every
		 * CENC fixture happens to carry an explicit `ivSize`.
		 *
		 * So the expectation is recomputed HERE from `plan.drm[]` — the mode, the
		 * optional `ivSize` override, and FairPlay's CBC — and compared. Two derivations
		 * from the same source is not independence, but it is the difference between
		 * checking a rule and echoing a value: a mutation to the compiler's arm now
		 * fails, because this side does not change with it.
		 */
		let checked = 0;
		for (const { name, plan, expected } of compiled) {
			for (const d of expected.drm) {
				const row = plan.drm.find((r) => r.key === d.drmKey);
				expect(row, `${name}/${d.drmKey} must exist in the plan`).toBeDefined();
				if (!row) {
					continue;
				}
				const cbc =
					row.kind !== "CENC" ||
					row.ivSize === "IV_16_BYTES" ||
					(row.ivSize === undefined && row.encryptionMode === "CBC");
				expect(d.ivSizeBytes, `${name}/${d.drmKey} IV size (C9)`).toBe(
					cbc ? 16 : 8,
				);
				expect(d.schemeType, `${name}/${d.drmKey} scheme`).toBe(
					row.kind === "CENC" && row.encryptionMode !== "CBC" ? "cenc" : "cbcs",
				);
				checked++;
			}
		}
		// A corpus-wide loop that iterated nothing would pass. It never has to be a
		// large number; it has to be a real one.
		expect(checked, "DRM rows actually compared").toBeGreaterThan(4);
	});

	it("marks per-title and multi-encoding plans as post-encoding manifests (C1)", () => {
		for (const { name, plan, expected } of compiled) {
			const anyPerTitle = plan.renditions.some(
				(r) => "mode" in r && r.mode === "PER_TITLE_TEMPLATE",
			);
			if (!anyPerTitle && !expected.multiEncoding) {
				continue;
			}
			for (const manifest of expected.manifests) {
				expect(manifest.postEncoding, `${name}/${manifest.manifestKey}`).toBe(
					true,
				);
			}
		}
	});

	it("expects a QC mirror per VIDEO rendition and none for audio", () => {
		for (const { name, plan, expected } of compiled) {
			if (!expected.qc) {
				continue;
			}
			const videoKeys = plan.renditions
				.filter((r) => ["H264", "H265", "VP9", "AV1"].includes(r.codec))
				.map((r) => r.key);
			expect(expected.qc.mirrorRenditionKeys.sort(), name).toEqual(
				videoKeys.sort(),
			);
		}
	});
});

/**
 * The manifest topology, pinned against the PLAN and the COMPILER rather than
 * restated from a golden.
 *
 * A golden is a restatement: regenerate it and the fact becomes whatever the
 * code now says. These derive each fact a second way — the family set from the
 * plan's renditions, the HLS expected nodes from the compiler's own
 * `CREATE_HLS_STREAM_INFO` / `CREATE_HLS_AUDIO_MEDIA` ops — so a topology that
 * drifts from either goes red here even after a regen.
 */
describe("manifest topology — declared families and compiler-granularity nodes (row 284)", () => {
	const compiled = planFiles.map((file) => {
		const name = file.replace(".plan.json", "");
		const plan = encodingPlanSchema.parse(
			JSON.parse(readFileSync(join(FIXTURES, `${name}.plan.json`), "utf8")),
		);
		return {
			name,
			plan,
			expected: compileExpectedArtefacts(plan),
			ops: compilePlan(plan),
		};
	});
	const VIDEO = new Set(["H264", "H265", "VP9", "AV1"]);
	const isPerTitle = (r: object) =>
		"mode" in r && typeof r.mode === "string" && r.mode.startsWith("PER_TITLE");

	it("declaredVideoCodecFamilies is the family set of EVERY video rendition the manifest lists — per-title included", () => {
		let perTitleManifests = 0;
		for (const { name, plan, expected } of compiled) {
			for (const manifest of expected.manifests) {
				if (manifest.kind === "SMOOTH") {
					expect(manifest.manifestRenditions, name).toBeUndefined();
					continue;
				}
				const planManifest = plan.manifests.find(
					(m) => m.key === manifest.manifestKey,
				);
				const pin =
					planManifest && "videoMuxingKind" in planManifest
						? planManifest.videoMuxingKind
						: undefined;
				// From the PLAN: the codec of every video rendition that owns a
				// muxing this manifest lists (its leg pin, if any).
				const families = new Set<string>();
				for (const muxing of plan.qc?.only ? [] : plan.muxings) {
					const r = plan.renditions.find((x) => x.key === muxing.streamKey);
					if (!r || !VIDEO.has(r.codec)) {
						continue;
					}
					if (pin !== undefined && muxing.kind !== pin) {
						continue;
					}
					families.add(r.codec);
				}
				const where = `${name}/${manifest.manifestKey}`;
				expect(
					manifest.manifestRenditions?.declaredVideoCodecFamilies,
					where,
				).toEqual([...families].sort());
				if (manifest.perTitle) {
					perTitleManifests += 1;
					// The HIGH-3 premise: a per-title manifest used to compile to an
					// EMPTY family set (its video list is empty by design), and the
					// DASH AdaptationSet check then failed a real H.264 MPD as
					// "no plan family".
					expect(
						manifest.manifestRenditions?.declaredVideoCodecFamilies.length,
						`${where} must declare its per-title family`,
					).toBeGreaterThan(0);
					expect(manifest.manifestRenditions?.video, where).toEqual([]);
				}
			}
		}
		// Not vacuous: the corpus carries per-title manifests.
		expect(perTitleManifests).toBeGreaterThan(10);
	});

	it("HLS expected variant nodes are the compiler's CREATE_HLS_STREAM_INFO ops, node for node", () => {
		let nodes = 0;
		let fanOutManifests = 0;
		let audioVariantManifests = 0;
		for (const { name, plan, expected, ops } of compiled) {
			for (const manifest of expected.manifests) {
				if (manifest.kind !== "HLS") {
					continue;
				}
				const planManifest = plan.manifests.find(
					(m) => m.key === manifest.manifestKey,
				);
				if (
					planManifest?.kind === "HLS" &&
					planManifest.variantsPerAudioGroup
				) {
					fanOutManifests += 1;
				}
				if (planManifest?.kind === "HLS" && planManifest.audioVariantStreams) {
					audioVariantManifests += 1;
				}
				// The compiler's rows for THIS manifest: `hls-variant:<manifest>:…`.
				const fromCompiler = ops
					.filter(
						(op) =>
							op.kind === "CREATE_HLS_STREAM_INFO" &&
							op.step.startsWith(`hls-variant:${manifest.manifestKey}:`),
					)
					.map((op) => {
						const payload = op.payload as { uri?: string; audio?: string };
						return `${payload.uri ?? ""}\u0000${payload.audio ?? ""}`;
					})
					.sort();
				const fromExpectation = (manifest.manifestRenditions?.hlsVariants ?? [])
					.map((v) => `${v.uri}\u0000${v.audioGroup ?? ""}`)
					.sort();
				expect(fromExpectation, `${name}/${manifest.manifestKey}`).toEqual(
					fromCompiler,
				);
				nodes += fromExpectation.length;
				// Keys are unique — each is a check id.
				const keys = (manifest.manifestRenditions?.hlsVariants ?? []).map(
					(v) => v.key,
				);
				expect(new Set(keys).size, `${name}/${manifest.manifestKey} keys`).toBe(
					keys.length,
				);
				// Per-title rows are never expected nodes (run-time URIs, C1).
				for (const v of manifest.manifestRenditions?.hlsVariants ?? []) {
					const r = plan.renditions.find((x) => x.key === v.renditionKey);
					expect(r && isPerTitle(r), `${name}/${v.key} per-title`).toBe(false);
				}
			}
		}
		// The three shapes the compiler emits must all be in the population.
		expect(nodes).toBeGreaterThan(100);
		expect(fanOutManifests).toBeGreaterThan(0);
		expect(audioVariantManifests).toBeGreaterThan(0);
	});

	it("HLS audio entries carry the compiler's EXT-X-MEDIA group, name and uri", () => {
		let entries = 0;
		for (const { name, expected, ops } of compiled) {
			for (const manifest of expected.manifests) {
				if (manifest.kind !== "HLS") {
					continue;
				}
				const fromCompiler = ops
					.filter(
						(op) =>
							op.kind === "CREATE_HLS_AUDIO_MEDIA" &&
							op.step.startsWith(`hls-media:${manifest.manifestKey}:`),
					)
					.map((op) => {
						const p = op.payload as {
							groupId?: string;
							name?: string;
							uri?: string;
						};
						return `${p.groupId ?? ""}\u0000${p.name ?? ""}\u0000${p.uri ?? ""}`;
					})
					.sort();
				const fromExpectation = (manifest.manifestRenditions?.audio ?? [])
					.map(
						(a) =>
							`${a.groupId ?? ""}\u0000${a.name ?? ""}\u0000${a.uri ?? ""}`,
					)
					.sort();
				expect(fromExpectation, `${name}/${manifest.manifestKey}`).toEqual(
					fromCompiler,
				);
				entries += fromExpectation.length;
			}
		}
		expect(entries).toBeGreaterThan(50);
	});
});

describe("pathPattern", () => {
	it("splits at the first placeholder and keeps the whole pattern", () => {
		expect(pathPattern("out/video/{height}p/{uuid}/")).toEqual({
			pattern: "out/video/{height}p/{uuid}/",
			prefix: "out/video/",
			templated: true,
		});
	});

	it("treats a %number% segment name as templated too", () => {
		expect(pathPattern("seg_%number%.m4s").templated).toBe(true);
	});

	it("leaves a literal path alone, prefix equal to the pattern", () => {
		expect(pathPattern("out/audio/128000/")).toEqual({
			pattern: "out/audio/128000/",
			prefix: "out/audio/128000/",
			templated: false,
		});
	});
});

describe("a destination path is a directory, not a prefix", () => {
	/**
	 * Bitmovin joins `manifestName` onto `destination.path`, and the schema does
	 * not force a trailing slash — `plan/compiler.ts` has carried `joinFilePath`
	 * for exactly this since the first single-file reference, and
	 * `expected-live.ts` normalised for it because the live wizard writes
	 * slash-less paths.
	 *
	 * All 66 VOD fixtures happen to end in `/`, so this compiler concatenated
	 * raw for its whole life with nothing to show it: a mutation reverting the
	 * normalisation passes all 1,198 tests. This is that mutation's test.
	 */
	it("normalises a slash-less manifest path", () => {
		const plan = encodingPlanSchema.parse(
			JSON.parse(
				readFileSync(
					join(FIXTURES, "fixed-bitrate-hls-on-aws.plan.json"),
					"utf8",
				),
			),
		);
		const manifest = plan.manifests[0];
		if (!manifest) {
			throw new Error("fixture has no manifest");
		}
		manifest.destination.path = "output/no-slash";
		const expected = compileExpectedArtefacts(plan);
		expect(expected.manifests[0]?.dir.prefix).toBe("output/no-slash/");
		// The runner builds the object key as `${dir.prefix}${file}` — without the
		// normalisation it would look for `output/no-slashstream.m3u8` and FAIL a
		// perfectly good encoding.
		expect(
			`${expected.manifests[0]?.dir.prefix}${expected.manifests[0]?.files[0]}`,
		).toBe("output/no-slash/stream.m3u8");
	});

	it("leaves an already-slashed path alone", () => {
		const plan = encodingPlanSchema.parse(
			JSON.parse(
				readFileSync(
					join(FIXTURES, "fixed-bitrate-hls-on-aws.plan.json"),
					"utf8",
				),
			),
		);
		expect(plan.manifests[0]?.destination.path.endsWith("/")).toBe(true);
		expect(compileExpectedArtefacts(plan).manifests[0]?.dir.prefix).toBe(
			plan.manifests[0]?.destination.path,
		);
	});
});
