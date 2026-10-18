import { describe, expect, it } from "vitest";
import type { PooledMetrics } from "../vmaf/pooled";
import { evaluateQcGate, type QcGate } from "./qc-gate";

/**
 *  (paid audit 893eb66 HIGH-10): a per-title rung the provider
 * built but the runner could not score — its mirror was never written — must
 * reach the verdict as an UNMEASURED actual, exactly as a rendition absent
 * from the results does. The listing-based population made such a rung
 * invisible: the measured rungs passed, the gate passed, delivery went out
 * with an unverified rung (the #40 failure the gate exists to prevent).
 */
const pooled = (mean: number): PooledMetrics => ({
	mean,
	harmonicMean: mean,
	min: mean - 5,
	max: 99,
	percentiles: { p1: 80, p5: 85, p10: 86, p25: 88, p50: 90 },
	low1Percent: 80,
	worstFrame: { frameNum: 1, vmaf: mean - 5 },
});

const gate = (scope: "PER_RENDITION" | "OVERALL"): QcGate => ({
	rules: [{ metric: "VMAF_MEAN", scope, gte: 80 }],
	onFail: "MARK_ONLY",
});

const measured = [
	{ rendition: "vpt", variant: "1080p_4200000_a", pooled: pooled(95) },
	{ rendition: "vpt", variant: "720p_2400000_b", pooled: pooled(92) },
];

describe("evaluateQcGate — unmeasured per-title rungs", () => {
	it("PER_RENDITION: an unmeasured rung is one failing actual, value null, beside the measured ones", () => {
		const verdict = evaluateQcGate(
			gate("PER_RENDITION"),
			measured,
			["vpt"],
			[{ rendition: "vpt", variant: "360p_500000_c" }],
		);
		expect(verdict.pass).toBe(false);
		expect(verdict.ruleResults[0]?.actuals).toEqual([
			{ rendition: "vpt", variant: "1080p_4200000_a", value: 95, pass: true },
			{ rendition: "vpt", variant: "720p_2400000_b", value: 92, pass: true },
			{ rendition: "vpt", variant: "360p_500000_c", value: null, pass: false },
		]);
	});

	it("a rendition with NO measured rung and two holes fails exactly twice — one actual per hole, no extra 'absent' actual", () => {
		// Review-329 S2: the branch the commit message headlines was untested.
		const verdict = evaluateQcGate(
			gate("PER_RENDITION"),
			[],
			["vpt"],
			[
				{ rendition: "vpt", variant: "360p_500000_c" },
				{ rendition: "vpt", variant: "720p_2400000_d" },
			],
		);
		expect(verdict.pass).toBe(false);
		expect(verdict.ruleResults[0]?.actuals).toEqual([
			{ rendition: "vpt", variant: "360p_500000_c", value: null, pass: false },
			{ rendition: "vpt", variant: "720p_2400000_d", value: null, pass: false },
		]);
	});

	it("OVERALL: the ladder mean cannot be taken over a hole — the rule fails", () => {
		const verdict = evaluateQcGate(
			gate("OVERALL"),
			measured,
			["vpt"],
			[{ rendition: "vpt", variant: "360p_500000_c" }],
		);
		expect(verdict.pass).toBe(false);
	});

	it("without the unmeasured list the same measurements pass — the control", () => {
		expect(evaluateQcGate(gate("PER_RENDITION"), measured, ["vpt"]).pass).toBe(
			true,
		);
		expect(
			evaluateQcGate(gate("PER_RENDITION"), measured, ["vpt"], []).pass,
		).toBe(true);
	});

	it("an unmeasured rung of a rendition no rule targets does not fail the rule", () => {
		const scoped: QcGate = {
			rules: [
				{
					metric: "VMAF_MEAN",
					scope: "PER_RENDITION",
					gte: 80,
					renditions: ["vpt"],
				},
			],
			onFail: "MARK_ONLY",
		};
		const verdict = evaluateQcGate(
			scoped,
			measured,
			["vpt", "vother"],
			[{ rendition: "vother", variant: "540p_1_x" }],
		);
		expect(verdict.pass).toBe(true);
	});
});
