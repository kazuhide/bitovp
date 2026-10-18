import { describe, expect, it } from "vitest";
import { loadScenarios, planViaWizard } from "./preflight";

/**
 * The corpus verifies what the WIZARD produces, not what the fixture file says.
 *
 * Until now the runner posted fixture JSON straight to `/api/encoding-jobs`. A corpus run
 * therefore proved the plan compiler, the orchestrator, the Bitmovin client and the storage
 * drivers — and proved nothing at all about the plan the product actually generates. The
 * deep-equal between "the fixture" and "what the wizard would build from it" was asserted by a
 * unit test and never exercised against a real encoder, so every `verified` verdict rested on
 * artefacts built from a plan the product might never have produced.
 *
 * `wizard.tsx` submits `imported ? buildSubmissionPlan(imported, accountId) : buildPlan(state)`.
 * Both branches are real, so the runner uses whichever an operator would have to: the FORM path
 * where the form can author the scenario, the IMPORT path where it cannot.
 *
 * All VOD fixtures currently round-trip through the form. Synthetic cases below
 * retain coverage for schema-supported fields that still require the import path.
 */

const scenarios = loadScenarios();
const vod = scenarios.filter((s) => s.kind === "VOD");

describe("every scenario is submitted through one of the wizard's own paths", () => {
	it("found the corpus, so a broken read cannot pass over nothing", () => {
		// 70→71 on 2026-08-28: `vp9-webm-fixed-dash` (audit 893eb66 CRITICAL-2).
		expect(vod.length).toBe(72);
	});

	it("labels every scenario with the path that produced its plan", () => {
		// A missing label would let a future scenario be submitted with no record of how,
		// which is the ambiguity this whole change exists to remove.
		for (const s of scenarios) {
			expect(["wizard-form", "wizard-import"], s.name).toContain(
				s.submittedVia,
			);
		}
	});

	it("reproduces all 72 VOD fixtures through the FORM path", () => {
		const form = vod.filter((s) => s.submittedVia === "wizard-form");
		expect(form.length).toBe(72);
	});

	it("has no residual VOD fixture requiring the import path", () => {
		const diverged = vod.filter((s) => s.wizardDivergence);
		expect(diverged.map((s) => s.name)).toEqual([]);
		expect(vod.filter((s) => s.submittedVia === "wizard-import")).toEqual([]);
	});

	it("every form-path scenario carries a plan that parsed", () => {
		// The form path is only usable if its output is a valid plan; a scenario labelled
		// `wizard-form` with a null plan would mean the label was decorative.
		for (const s of vod.filter((x) => x.submittedVia === "wizard-form")) {
			expect(s.plan, s.name).not.toBeNull();
			expect(s.invalid, s.name).toBeUndefined();
		}
	});

	it("does not claim the LIVE fixtures go through the VOD wizard", () => {
		/**
		 * The live wizard is a different form (`app/live/new/build-live-plan.ts`) and the live
		 * runner submits the parsed live plan. Routing them through this label as `wizard-form`
		 * would be exactly the kind of unearned claim the rest of this file removes.
		 */
		const live = scenarios.filter((s) => s.kind === "LIVE");
		// 9→10 / 77→78 : live-pinned-encoder joins —
		// gated behind PINNED_ENCODER_VERSION until Track 1 supplies the tag.
		// 13→14 : live-akamai-msl5.
		// 14→15 (2026-08-29, paid re-audit eb7c983 HIGH-2): live-mixed-codec-dash.
		expect(live.length).toBe(15);
		for (const s of live) {
			expect(s.submittedVia, s.name).toBe("wizard-import");
		}
	});
});

describe("planViaWizard — the mechanism, not today's bytes", () => {
	/**
	 * An honest note on what routing through the wizard does and does not change.
	 *
	 * Today it changes NOTHING about the submitted bytes. The form path reproduces all
	 * current VOD fixtures exactly, and the import path preserves unsupported plan shapes
	 * verbatim — so replacing the whole thing with `JSON.parse(raw)` is observationally
	 * identical, and a mutation doing exactly that survives every value-based assertion above.
	 * That is worth saying plainly rather than implying a bigger change than was made.
	 *
	 * What it changes is the FUTURE: a regression in `buildPlan` now surfaces in a real corpus
	 * run instead of only in a unit test that excludes ten fixtures. So the mechanism is what
	 * gets pinned here — given a plan the wizard cannot reproduce, the divergence must be
	 * detected, named down to the field, and must flip the scenario to the import path.
	 */
	it("detects a field the wizard drops, and names the path to it", () => {
		// Per-plan schedulingPriority is supported by the schema/compiler, but only
		// account defaults have a form control; the job form must not silently drop it.
		const plan = {
			planVersion: 1,
			name: "synthetic-priority-override",
			bitmovin: { cloudRegion: "AWS_AP_NORTHEAST_1", schedulingPriority: 73 },
			generation: { timing: "JUST_IN_TIME" },
			inputs: [
				{
					key: "main",
					kind: "GCS_SERVICE_ACCOUNT",
					name: "in",
					bucket: "b",
					region: "EUROPE_WEST_1",
					credentialId: "11111111-1111-4111-8111-111111111111",
				},
			],
			outputs: [
				{
					key: "origin",
					kind: "S3",
					name: "out",
					bucket: "o",
					credentialId: "11111111-1111-4111-8111-111111111111",
				},
			],
			ingest: [
				{
					key: "video",
					inputKey: "main",
					inputPath: "a.mp4",
					position: 0,
					selectionMode: "VIDEO_RELATIVE",
				},
			],
			renditions: [
				{
					key: "v",
					codec: "H264",
					ingestKey: "video",
					height: 360,
					bitrate: 300000,
				},
			],
			muxings: [
				{
					key: "v",
					kind: "FMP4",
					streamKey: "v",
					segmentLength: 4,
					destination: { outputKey: "origin", path: "out/v/" },
				},
			],
			manifests: [],
		};
		const out = planViaWizard(JSON.stringify(plan));
		expect(out.divergence, "the dropped field must be detected").toBeDefined();
		expect(out.divergence).toMatch(/bitmovin\.schedulingPriority/);
		expect(out.divergence).toMatch(/73/);
		// Manifest destinations can have independent paths in JSON, while the
		// form derives one shared output base. Keep that loss detector separate.
		const manifestPlan = {
			...plan,
			bitmovin: { cloudRegion: "AWS_AP_NORTHEAST_1" },
			manifests: [
				{
					key: "hls",
					kind: "HLS",
					destination: { outputKey: "origin", path: "out/" },
				},
				{
					key: "dash",
					kind: "DASH",
					destination: { outputKey: "origin", path: "different-dash-root/" },
				},
			],
		};
		const manifestOut = planViaWizard(JSON.stringify(manifestPlan));
		expect(manifestOut.divergence).toMatch(/manifests\.1\.destination\.path/);
		expect(manifestOut.divergence).toMatch(/different-dash-root/);
	});

	it("reports NO divergence for a plan the form can author", () => {
		// The control. Without it, a `planViaWizard` that always cried divergence would pass
		// the test above and route every scenario down the import path — undoing the change
		// while looking like it worked.
		const clean = {
			planVersion: 1,
			name: "synthetic-clean",
			bitmovin: { cloudRegion: "AWS_AP_NORTHEAST_1" },
			generation: { timing: "JUST_IN_TIME" },
			inputs: [
				{
					key: "main",
					kind: "S3",
					name: "in",
					bucket: "b",
					credentialId: "11111111-1111-4111-8111-111111111111",
				},
			],
			outputs: [
				{
					key: "origin",
					kind: "S3",
					name: "out",
					bucket: "o",
					credentialId: "11111111-1111-4111-8111-111111111111",
				},
			],
			ingest: [
				{
					key: "video",
					inputKey: "main",
					inputPath: "a.mp4",
					position: 0,
					selectionMode: "VIDEO_RELATIVE",
				},
			],
			renditions: [
				{
					key: "v",
					codec: "H264",
					ingestKey: "video",
					height: 360,
					bitrate: 300000,
				},
			],
			muxings: [
				{
					key: "v",
					kind: "FMP4",
					streamKey: "v",
					segmentLength: 4,
					destination: { outputKey: "origin", path: "out/v/" },
				},
			],
			manifests: [],
		};
		const out = planViaWizard(JSON.stringify(clean));
		expect(
			out.divergence,
			"a form-authorable plan must not diverge",
		).toBeUndefined();
		expect(out.plan).toBeDefined();
	});

	it("reports a named finding when the wizard's rebuild fails the plan schema", () => {
		/**
		 * A malformed plan must become a finding, not an exception that takes the whole 73-row
		 * population down with it.
		 *
		 * Worth recording what this does NOT cover. I first named it "when the wizard cannot read
		 * the plan", meaning the `catch` around `planToWizardState`/`buildPlan` — and a mutation
		 * deleting that catch's message survived. The importer turns out to be very tolerant:
		 * every malformed shape I tried (`renditions` as a string, `inputs: null`, `muxings` of
		 * numbers, and seven more) produced a state that rebuilt into a plan the SCHEMA then
		 * rejected, so the catch was never entered. It stays as a defensive guard, unexercised by
		 * any input the corpus can produce, and this test claims only the branch it reaches.
		 */
		const out = planViaWizard(
			'{"planVersion":1,"name":"x","renditions":"not-an-array"}',
		);
		expect(out.divergence).toMatch(/does not satisfy the plan schema/);
	});
});
