import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodingPlanSchema } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	capabilitiesFor,
	requiredSourceSeconds,
	sourcesOf,
	videoSeconds,
} from "./preflight";

/**
 * The scenarios the run must NOT submit, named from a real run that submitted them.
 *
 * `rewriteForRun` collapses every source path in a plan to the single mezzanine the run stages,
 * and its comment claimed "a scenario that genuinely needs several distinct sources … is gated
 * by preflight, so it never reaches here with the wrong asset". Nothing enforced that. The gate
 * matched only literal placeholder spellings (`<INSERT…>`, `/path/to/your/`), so every fixture
 * naming a REAL upstream path passed it needing nothing but `S3`.
 *
 * REAL-VOD-4 then billed for seven guaranteed failures, and reported each as a product FAIL:
 *
 *   Dolby Atmos Encoding - Progressive Mp4        Error reading Dolby Atmos input file
 *   audio-only-dolbyatmos-adm-hls-dash-fmp4       Audio Input Error
 *   audio-only-dolbyatmos-damf-hls-dash-fmp4      Could not find audio file reference in Dolby
 *                                                 Atmos Master File
 *                                                 big_buck_bunny_1080p_h264_short.mov
 *   dv-embedded-with-atmos-ddp-dd-aac             Encoding has failed
 *   dv-with-atmos-ddp-dd-aac                      Audio Input Error
 *   h264-aac-fmp4-fixed-bitrate-hls-vtt-aws       Internal error during video transcoding
 *   h264-aac-mp4-fixed-bitrate-hls-vtt-aws        Problem with processing input
 *
 * The error message is the proof: Bitmovin names the BBB mezzanine as the file it was asked to
 * read as an Atmos master. So the gate is derived from the plan's STRUCTURE — `fileStreams[]`
 * declares its `fileType`, and `dolbyStreams` being present is itself the evidence — never from
 * a filename, which is the guess that produced this.
 */

const FIXTURES = join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"..",
	"packages",
	"core",
	"src",
	"plan",
	"__fixtures__",
);

function planOf(name: string) {
	return encodingPlanSchema.parse(
		JSON.parse(readFileSync(join(FIXTURES, `${name}.plan.json`), "utf8")),
	);
}

const allNames = readdirSync(FIXTURES)
	.filter((f) => f.endsWith(".plan.json"))
	.map((f) => f.replace(".plan.json", ""))
	.sort();

describe("capabilitiesFor — a source's ROLE, not its filename", () => {
	it("found the corpus, so a broken read cannot pass over nothing", () => {
		// 70→71 on 2026-08-28: `vp9-webm-fixed-dash` (audit 893eb66 CRITICAL-2).
		// 71→72 same day: `mixed-codec-dash-hls` .
		expect(allNames.length).toBe(72);
	});

	it("gates every WEBVTT scenario, naming the four that exist", () => {
		const vtt = allNames.filter((n) =>
			(planOf(n).fileStreams ?? []).some(
				(s) => "fileType" in s && s.fileType === "WEBVTT",
			),
		);
		expect(vtt).toEqual([
			"fixed-bitrate-hls-vtt-on-aws",
			"fixed-bitrate-hls-vtt-on-azure",
			"mp4-fixed-bitrate-hls-vtt-on-aws",
			"mp4-fixed-bitrate-hls-vtt-on-azure",
		]);
		for (const n of vtt) {
			expect(capabilitiesFor(planOf(n), n), n).toContain("TYPED_SOURCE_ASSETS");
		}
	});

	it("gates every Dolby scenario on DOLBY_ASSETS, including the ones with real Netflix paths", () => {
		/**
		 * The five that actually burned encoder minutes are in here. Before the fix they needed
		 * only `["S3"]`, because `netflix-opencontent/SolLevante/…` and `sollevante_lp_v01…wav`
		 * look nothing like a placeholder — which is the whole problem with matching on names.
		 */
		const dolby = allNames.filter(
			(n) => (planOf(n).dolbyStreams ?? []).length > 0,
		);
		expect(dolby.length).toBe(18);
		for (const n of dolby) {
			expect(capabilitiesFor(planOf(n), n), n).toContain("DOLBY_ASSETS");
		}
		for (const n of [
			"dolby-atmos-progressive-mp4",
			"dolby-audio-only-atmos-adm",
			"dolby-audio-only-atmos-damf",
			"dolby-dv-embedded-ddp",
			"dolby-dv-ddp-multi-audio",
		]) {
			expect(dolby, `${n} is one of the five that were billed for`).toContain(
				n,
			);
		}
	});

	it("does NOT gate the scenarios the single mezzanine genuinely satisfies", () => {
		/**
		 * The complement, and the reason the gate is role-based rather than a source count.
		 * `concatenation-two-sources` reads two distinct paths and collapsing both to the same
		 * mezzanine is FINE — it concatenates BBB with itself, which is exactly the property
		 * under test. `audio-only-aac-fmp4-hls-dash` reads an `.mp3`, and an H.264 `.mov` has
		 * an audio track, so that substitution is sound too; it FINISHED on the real run.
		 * A blanket "more than one source ⇒ blocked" rule would have failed both.
		 */
		for (const n of [
			"concatenation-two-sources",
			"audio-only-aac-fmp4-hls-dash",
			"fixed-bitrate-hls-on-aws",
			"pertitle-h264-separate-av-inputs",
			"trimming-time-based",
		]) {
			const needs = capabilitiesFor(planOf(n), n);
			expect(needs, n).not.toContain("TYPED_SOURCE_ASSETS");
			expect(needs, n).not.toContain("DOLBY_ASSETS");
		}
	});

	it("keeps the gate structural — the same plan under a harmless name is still gated", () => {
		// The bug was a name-shaped inference. If renaming a plan changes its gate, the
		// inference has crept back in.
		const plan = planOf("fixed-bitrate-hls-vtt-on-aws");
		expect(capabilitiesFor(plan, "totally-innocuous-name")).toContain(
			"TYPED_SOURCE_ASSETS",
		);
		const dv = planOf("dolby-dv-ddp-multi-audio");
		expect(capabilitiesFor(dv, "nothing-to-see-here")).toContain(
			"DOLBY_ASSETS",
		);
	});

	it("still reports the sources it gates on, so a SKIP can say what to stage", () => {
		// A gate that cannot name the missing file makes the SKIP unactionable.
		expect(sourcesOf(planOf("fixed-bitrate-hls-vtt-on-aws"))).toContain(
			"sintel/subtitles_en.vtt",
		);
		expect(
			sourcesOf(planOf("dolby-audio-only-atmos-damf")).join(" "),
		).toContain(".atmos");
	});
});

describe("requiredSourceSeconds — the source has to be long enough", () => {
	/**
	 * `trimming-time-based` declares `offset: 10, duration: 30` — a 40-second window — and the
	 * run stages a 10.04-second mezzanine. Bitmovin answered `Internal encoding error occurred.
	 * Please contact support`, and the corpus recorded it as a product failure. It was the
	 * harness handing the encoder an impossible job, the same class of mistake as pointing an
	 * Atmos master at an H.264 `.mov`.
	 *
	 * Derived from the plan's own numbers, so a new fixture is covered the day it lands.
	 */
	it("names every fixture that needs more VIDEO than the staged 9.04s", () => {
		/**
		 * 9.04s, not 10.04s: `217 frames @ 24fps` is the VIDEO length, and the container is
		 * longer only because the audio track is. That distinction is the whole reason the
		 * thumbnail fixture reached the encoder.
		 */
		const stagedVideoSeconds = 217 / 24;
		const over = allNames
			.map((n) => ({ n, need: requiredSourceSeconds(planOf(n)) }))
			.filter((x) => (x.need ?? 0) > stagedVideoSeconds)
			.sort((a, b) => a.n.localeCompare(b.n));
		expect(over.map((x) => `${x.n}=${x.need}`)).toEqual([
			"fixed-bitrate-dash-hls-streamcondition-thumbnail-on-aws=10",
			"fixed-bitrate-dash-hls-streamcondition-thumbnail-on-azure=10",
			"trimming-time-based=40",
		]);
	});

	it("ignores PERCENT positions, which scale to whatever the source is", () => {
		/**
		 * No fixture uses PERCENT today, so this branch had no coverage and a mutation removing
		 * the unit check survived — which would have turned every percentage into a false
		 * blocker the moment such a fixture landed. Built by hand rather than left untested.
		 */
		const base = planOf(
			"fixed-bitrate-dash-hls-streamcondition-thumbnail-on-aws",
		);
		const percent = {
			...base,
			thumbnails: (base.thumbnails ?? []).map((t) => ({
				...t,
				unit: "PERCENT" as const,
				positions: [10, 50, 90],
			})),
		};
		expect(
			requiredSourceSeconds(percent as unknown as typeof base),
			"a percentage places no lower bound on the source",
		).toBeUndefined();
		// And the SECONDS form of the very same plan still does.
		expect(requiredSourceSeconds(base)).toBe(10);
	});

	it("derives the VIDEO duration from frames ÷ fps, not the container", () => {
		// The arithmetic that replaced a guessed margin.
		expect(
			videoSeconds({ durationSec: 10.04, fps: 24, nbFrames: 217 }),
		).toBeCloseTo(9.042, 2);
		// And falls back to the container when the frame count is unavailable, because a
		// missing measurement must not become a fabricated one.
		expect(videoSeconds({ durationSec: 12 })).toBe(12);
		expect(videoSeconds({})).toBeUndefined();
	});

	it("returns undefined for a plan that places no lower bound on the source", () => {
		// Absent rather than 0, so "no requirement" and "requires nothing measurable" are not
		// the same value — the caller only gates when BOTH numbers are known.
		expect(
			requiredSourceSeconds(planOf("fixed-bitrate-hls-on-aws")),
		).toBeUndefined();
		expect(
			requiredSourceSeconds(planOf("concatenation-two-sources")),
		).toBeUndefined();
	});

	it("counts a thumbnail POSITION but not a sprite INTERVAL", () => {
		/**
		 * I first excluded thumbnail positions, reasoning that `sprites-trickplay` samples every
		 * 10s on the same source and passes, so a position at the boundary must be fine. The next
		 * real run refuted it in one line: `Setting up encoding configuration failed! No valid
		 * thumbnail positions set!` A sprite interval running past the end yields fewer tiles; a
		 * thumbnail position past the end has no frame. Reasoning by analogy between two
		 * different shapes is what produced the wrong call.
		 */
		expect(
			requiredSourceSeconds(
				planOf("fixed-bitrate-dash-hls-streamcondition-thumbnail-on-aws"),
			),
		).toBe(10);
		expect(requiredSourceSeconds(planOf("sprites-trickplay"))).toBeUndefined();
	});
});

describe("a VOD plan pinned to a Cloud Connect infrastructure is gated (C18)", () => {
	/**
	 * `labels-infrastructure-preview` declares
	 * `bitmovin.infrastructure: { infrastructureId, cloudRegion }` with `cloudRegion: "EXTERNAL"`,
	 * and Bitmovin refused it on CREATE: `Could not retrieve AWS account. Please check your
	 * configuration! (code 2042)`. It was the last FAIL in a full 73-scenario corpus run.
	 *
	 * `LIVE_INFRA` already encoded this prerequisite for live channels; only the live path asked
	 * for it. Structural, from the plan's own field, so a new infrastructure-bearing fixture is
	 * gated the day it lands.
	 */
	it("names the infrastructure fixture, and only it", () => {
		const gated = allNames.filter((n) =>
			capabilitiesFor(planOf(n), n).includes("LIVE_INFRA"),
		);
		expect(gated).toEqual(["labels-infrastructure-preview"]);
	});

	it("gates on the FIELD, not the name", () => {
		// The same plan under an innocuous name must still be gated; a name-shaped inference is
		// the mistake this file already corrected once for typed sources.
		const plan = planOf("labels-infrastructure-preview");
		expect(capabilitiesFor(plan, "something-else")).toContain("LIVE_INFRA");
	});

	it("does not gate a plan whose labels merely mention cloud-connect", () => {
		/**
		 * The fixture carries `labels: ["p5", "cloud-connect"]` AND an infrastructure block. Only
		 * the block may matter — labels are free text an operator sets for their own filtering, and
		 * gating on them would make a label change silently stop a scenario running.
		 */
		const plan = planOf("labels-infrastructure-preview");
		const labelsOnly = {
			...plan,
			bitmovin: { ...plan.bitmovin, infrastructure: undefined },
		};
		expect(
			capabilitiesFor(labelsOnly as typeof plan, "labels-only"),
		).not.toContain("LIVE_INFRA");
	});
});
