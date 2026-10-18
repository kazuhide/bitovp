import { describe, expect, it } from "vitest";
import { compilePlan } from "./compiler";
import { stepNameFor } from "./step-names";
import { loadPlan, vodPlanNames } from "./test-support";

const planNames = vodPlanNames();

/**
 * `step-names.ts` claims to reproduce the compiler's step ids. This is what
 * makes that claim true.
 *
 * The compiler writes its ids as inline template literals at 28 call sites and
 * nothing shared them, so `detail-view.ts`'s runtime join re-derived the
 * convention. Rather than refactor 28 literals, the agreement is asserted here
 * against the real compiled output of every VOD golden — so a drift on either
 * side fails with a named fixture instead of silently emptying the "stream id"
 * column on the job detail page, which is a change nobody would notice in
 * review.
 *
 * Deliberately asserted for the prefixes `detail-view` actually joins on. A new
 * consumer adding a prefix should extend this list in the same PR; an unasserted
 * prefix is an unverified claim.
 */
describe("stepNameFor agrees with the compiler", () => {
	it("has a corpus to check against", () => {
		// EXACT, not a floor: 67 fixtures . A floor of 60 let a
		// partial shrink (66 -> 61) pass silently (stack review) — and the corpus
		// changes only when a fixture PR changes it, which is precisely when this
		// number should be re-measured and moved.
		// 70→71→72 on 2026-08-28: `vp9-webm-fixed-dash`, then `mixed-codec-dash-hls` .
		expect(planNames.length).toBe(72);
	});

	it.each(
		planNames,
	)("%s: every joined prefix resolves to a real step", (name) => {
		const plan = loadPlan(name);
		const steps = new Set(compilePlan(plan).map((op) => op.step));

		/**
		 * Renditions: the two ids the detail view attaches to each row.
		 *
		 * A VMAF-only encode emits NOTHING for a non-video rendition — no codec, no
		 * stream (`compiler.ts`, the `plan.qc?.only && !isVideoCodec` continue) — so
		 * those are excluded. This passed unguarded only because `vmaf-only-h264`
		 * happens to have no audio; review built a qc-only plan with an AAC rung and
		 * it went red, which is the second class the muxing guard below did not
		 * cover.
		 */
		const VIDEO = new Set(["H264", "H265", "VP9", "AV1"]);
		for (const rendition of plan.renditions) {
			if (plan.qc?.only === true && !VIDEO.has(rendition.codec)) {
				continue;
			}
			expect(steps.has(stepNameFor("stream", rendition.key))).toBe(true);
			expect(steps.has(stepNameFor("codec", rendition.key))).toBe(true);
		}
		// Endpoints and muxings: the storage panel's join.
		for (const input of plan.inputs) {
			expect(steps.has(stepNameFor("input", input.key))).toBe(true);
		}
		for (const output of plan.outputs) {
			expect(steps.has(stepNameFor("output", output.key))).toBe(true);
		}
		// A VMAF-only encode emits no delivery muxings, so there is no
		// `muxing:<key>` step to join — the plan carries them only so the qc mirror
		// path can be derived. Asserting otherwise is what surfaced the
		// storage-panel defect this exception documents.
		if (plan.qc?.only !== true) {
			for (const muxing of plan.muxings) {
				expect(steps.has(stepNameFor("muxing", muxing.key))).toBe(true);
			}
		}
		// `trim` is newly declared, so assert it rather than leaving it an
		// unverified claim — the standard this file sets for itself.
		for (const trim of plan.trimmingStreams) {
			expect(steps.has(stepNameFor("trim", trim.key))).toBe(true);
		}
	});

	it("is a plain prefix join, so a wrong separator fails loudly", () => {
		// Pins the shape itself: if the compiler ever moved to `stream/<key>` this
		// test is the one that says so.
		expect(stepNameFor("stream", "v1080")).toBe("stream:v1080");
		expect(stepNameFor("codec", "a-aac")).toBe("codec:a-aac");
	});
});
