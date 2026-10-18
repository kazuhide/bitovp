import { describe, expect, it } from "vitest";
import type { PooledMetrics } from "../vmaf/pooled";
import {
	evaluateQcGate,
	type QcGate,
	qcGateRuleSchema,
	type RenditionPooled,
} from "./qc-gate";

/** Measured keys as the expected set — preserves each PR1 case's intent. */
const keysOf = (rows: RenditionPooled[]): string[] => [
	...new Set(rows.map((row) => row.rendition)),
];

/**
 *  PR1 (design §7): verdict table tests per metric/scope, the
 * unmeasured-target refusals (missing rendition, PSNR asked of a VMAF-only
 * run), and the zero-targets case. Pure — the vmaf-runner feeds real
 * pooled rows in PR2.
 */

function pooled(over: Partial<PooledMetrics> = {}): PooledMetrics {
	return {
		mean: 90,
		harmonicMean: 88,
		min: 70,
		max: 99,
		percentiles: { p1: 75, p5: 80, p10: 82, p25: 85, p50: 91 },
		low1Percent: 74,
		worstFrame: { frameNum: 42, vmaf: 70 },
		...over,
	};
}

const gate = (over: Partial<QcGate> = {}): QcGate => ({
	rules: [{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 85 }],
	onFail: "MARK_ONLY",
	...over,
});

describe("evaluateQcGate", () => {
	it("PER_RENDITION passes only when EVERY targeted rendition clears the bar", () => {
		const verdict = evaluateQcGate(
			gate(),
			[
				{ rendition: "1080p", pooled: pooled({ mean: 95 }) },
				{ rendition: "720p", pooled: pooled({ mean: 84.9 }) },
			],
			keysOf([
				{ rendition: "1080p", pooled: pooled({ mean: 95 }) },
				{ rendition: "720p", pooled: pooled({ mean: 84.9 }) },
			]),
		);
		expect(verdict.pass).toBe(false);
		expect(verdict.ruleResults[0]?.actuals).toEqual([
			{ rendition: "1080p", value: 95, pass: true },
			{ rendition: "720p", value: 84.9, pass: false },
		]);
	});

	it("OVERALL judges the LADDER MEAN — genuinely distinct from PER_RENDITION (review-86b I-1)", () => {
		// The separating shape: one rung dips below the bar while the ladder
		// mean clears it. Under the old "worst rendition" semantics this was
		// provably identical to PER_RENDITION (6,144 brute-forced shapes,
		// zero differences) and the scope control did nothing.
		const rows = [
			{ rendition: "a", pooled: pooled({ mean: 84 }) },
			{ rendition: "b", pooled: pooled({ mean: 92 }) },
		];
		const overall = gate({
			rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 85 }],
		});
		const perRendition = gate({
			rules: [{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 85 }],
		});
		// mean(84, 92) = 88 ≥ 85 → the ladder as a whole passes…
		expect(evaluateQcGate(overall, rows, keysOf(rows)).pass).toBe(true);
		// …while the strict scope fails the dipping rung.
		expect(evaluateQcGate(perRendition, rows, keysOf(rows)).pass).toBe(false);
		// And the mean is a real bar: mean(70, 92) = 81 < 85 → fail.
		const lower = [
			{ rendition: "a", pooled: pooled({ mean: 70 }) },
			{ rendition: "b", pooled: pooled({ mean: 92 }) },
		];
		expect(evaluateQcGate(overall, lower, keysOf(lower)).pass).toBe(false);
	});

	it("each metric reads its own field — VALUES asserted, not just booleans (review-86b I-2)", () => {
		// The old booleans could not tell low1Percent (40) from percentiles.p1
		// (75): check("VMAF_P1_LOW", 40) passed under BOTH readings, and the
		// reviewer's field-swap mutation survived 2,022 tests. The fixture
		// keys every field to a DISTINCT value and asserts the actual.
		const rows = [
			{
				rendition: "r",
				pooled: pooled({
					mean: 90,
					harmonicMean: 60,
					low1Percent: 40,
					min: 20,
					psnr: { mean: 40, min: 30, max: 50 },
				}),
			},
		];
		const metricValue = (metric: QcGate["rules"][number]["metric"]) =>
			evaluateQcGate(
				gate({ rules: [{ metric, scope: "OVERALL", gte: 1 }] }),
				rows,
				keysOf(rows),
			).ruleResults[0]?.actuals[0]?.value;
		expect(metricValue("VMAF_MEAN")).toBe(90); // not max 99
		expect(metricValue("VMAF_HARMONIC_MEAN")).toBe(60);
		expect(metricValue("VMAF_P1_LOW")).toBe(40); // not percentiles.p1 75
		expect(metricValue("VMAF_MIN")).toBe(20);
		expect(metricValue("PSNR_MEAN")).toBe(40); // not psnr.max 50
		// And the reviewer's separating threshold: 50 fails the true reading
		// (40 < 50) where the p1 misread (75) would pass.
		expect(
			evaluateQcGate(
				gate({ rules: [{ metric: "VMAF_P1_LOW", scope: "OVERALL", gte: 50 }] }),
				rows,
				keysOf(rows),
			).pass,
		).toBe(false);
	});

	it("a pooled row MISSING a metric field yields an explicit null actual (review-86b N-1)", () => {
		// PooledMetrics arrives from a Prisma Json column cast, never parsed —
		// a legacy row can lack low1Percent. The verdict fails closed AND the
		// actual carries `value: null` (an absent key would break the PR3
		// evidence export's contract).
		const legacy = pooled();
		delete (legacy as { low1Percent?: number }).low1Percent;
		const verdict = evaluateQcGate(
			gate({ rules: [{ metric: "VMAF_P1_LOW", scope: "OVERALL", gte: 1 }] }),
			[{ rendition: "r", pooled: legacy }],
			["r"],
		);
		expect(verdict.pass).toBe(false);
		expect(verdict.ruleResults[0]?.actuals[0]).toEqual({
			rendition: "r",
			value: null,
			pass: false,
		});
	});

	it("thresholds are INCLUSIVE lower bounds (gte, exactly-at passes)", () => {
		expect(
			evaluateQcGate(
				gate(),
				[{ rendition: "r", pooled: pooled({ mean: 85 }) }],
				keysOf([{ rendition: "r", pooled: pooled({ mean: 85 }) }]),
			).pass,
		).toBe(true);
	});

	it("a rule naming an ABSENT rendition fails as unmeasured, never passes silently", () => {
		const spec = gate({
			rules: [
				{
					metric: "VMAF_MEAN",
					scope: "PER_RENDITION",
					gte: 50,
					renditions: ["missing"],
				},
			],
		});
		const verdict = evaluateQcGate(
			spec,
			[{ rendition: "present", pooled: pooled() }],
			keysOf([{ rendition: "present", pooled: pooled() }]),
		);
		expect(verdict.pass).toBe(false);
		expect(verdict.ruleResults[0]?.actuals).toEqual([
			{ rendition: "missing", value: null, pass: false },
		]);
	});

	it("PSNR asked of a VMAF-only run is unmeasured ⇒ fail", () => {
		const spec = gate({
			rules: [{ metric: "PSNR_MEAN", scope: "OVERALL", gte: 30 }],
		});
		const verdict = evaluateQcGate(
			spec,
			[
				{ rendition: "r", pooled: pooled() }, // no psnr block
			],
			keysOf([
				{ rendition: "r", pooled: pooled() }, // no psnr block
			]),
		);
		expect(verdict.pass).toBe(false);
		expect(verdict.ruleResults[0]?.actuals[0]?.value).toBeNull();
	});

	it("ZERO measured renditions cannot pass either scope", () => {
		expect(evaluateQcGate(gate(), [], keysOf([])).pass).toBe(false);
		expect(
			evaluateQcGate(
				gate({ rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 1 }] }),
				[],
				[],
			).pass,
		).toBe(false);
	});

	it("multiple rules AND together; each carries its own actuals", () => {
		const spec = gate({
			rules: [
				{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 85 },
				{ metric: "VMAF_MIN", scope: "OVERALL", gte: 75 },
			],
		});
		const verdict = evaluateQcGate(
			spec,
			[{ rendition: "r", pooled: pooled({ mean: 90, min: 70 }) }],
			keysOf([{ rendition: "r", pooled: pooled({ mean: 90, min: 70 }) }]),
		);
		expect(verdict.pass).toBe(false);
		expect(verdict.ruleResults.map((r) => r.pass)).toEqual([true, false]);
	});
});

/**
 * Per-title rungs : one rendition key, several measurements.
 * The first cut keyed results in a Map, so duplicates silently collapsed to
 * whichever rung was persisted LAST — a per-title rendition was judged by one
 * arbitrary rung. Every rung must clear the bar (kill: restore the Map).
 */
describe("per-title rungs", () => {
	it("PER_RENDITION holds EVERY rung of a key to the bar", () => {
		const spec = gate({
			rules: [{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 80 }],
		});
		const verdict = evaluateQcGate(
			spec,
			[
				{ rendition: "pt", variant: "1080p_a", pooled: pooled({ mean: 95 }) },
				{ rendition: "pt", variant: "360p_b", pooled: pooled({ mean: 62 }) },
			],
			keysOf([
				{ rendition: "pt", variant: "1080p_a", pooled: pooled({ mean: 95 }) },
				{ rendition: "pt", variant: "360p_b", pooled: pooled({ mean: 62 }) },
			]),
		);
		expect(verdict.pass).toBe(false);
		const actuals = verdict.ruleResults[0]?.actuals;
		expect(actuals).toHaveLength(2);
		expect(actuals?.map((a) => [a.variant, a.pass])).toEqual([
			["1080p_a", true],
			["360p_b", false],
		]);
	});

	it("OVERALL averages ACROSS rungs, not the last-persisted one", () => {
		const spec = gate({
			rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 80 }],
		});
		// The failing rung persisted FIRST — a last-wins collapse would see
		// only 95 and pass; the honest mean (62+95)/2 = 78.5 < 80 fails.
		expect(
			evaluateQcGate(
				spec,
				[
					{ rendition: "pt", variant: "low", pooled: pooled({ mean: 62 }) },
					{ rendition: "pt", variant: "high", pooled: pooled({ mean: 95 }) },
				],
				keysOf([
					{ rendition: "pt", variant: "low", pooled: pooled({ mean: 62 }) },
					{ rendition: "pt", variant: "high", pooled: pooled({ mean: 95 }) },
				]),
			).pass,
		).toBe(false);
	});

	it("a rule naming an UNMEASURED key still gets one failing actual", () => {
		const spec = gate({
			rules: [
				{
					metric: "VMAF_MEAN",
					scope: "PER_RENDITION",
					gte: 80,
					renditions: ["pt", "ghost"],
				},
			],
		});
		const verdict = evaluateQcGate(
			spec,
			[{ rendition: "pt", variant: "only", pooled: pooled({ mean: 95 }) }],
			keysOf([
				{ rendition: "pt", variant: "only", pooled: pooled({ mean: 95 }) },
			]),
		);
		expect(verdict.pass).toBe(false);
		expect(verdict.ruleResults[0]?.actuals).toEqual([
			{ rendition: "pt", variant: "only", value: 95, pass: true },
			{ rendition: "ghost", value: null, pass: false },
		]);
	});
});

/**
 * review-201 C2: the default target set must be the PLAN's promise, never the
 * measurement's coverage. Their proof: 3 renditions promised, 480p never
 * measured (enumerateQcTargets skips silently three ways), two measured rungs
 * clear the bar → the old code passed a BLOCK gate over an unverified
 * delivery. Kill: change `rule.renditions ?? expectedRenditions` back to
 * measured keys and every case here goes red.
 */
describe("expected-population default (review-201 C2)", () => {
	const measuredTwo = [
		{ rendition: "v1080", pooled: pooled({ mean: 96 }) },
		{ rendition: "v720", pooled: pooled({ mean: 95 }) },
	];

	it("OVERALL with renditions absent FAILS when a promised rendition is unmeasured", () => {
		const verdict = evaluateQcGate(
			gate({ rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 93 }] }),
			measuredTwo,
			["v1080", "v720", "v480"],
		);
		expect(verdict.pass).toBe(false);
		// The hole is RECORDED, not silent: a null actual names the rendition.
		expect(verdict.ruleResults[0]?.actuals).toContainEqual({
			rendition: "v480",
			value: null,
			pass: false,
		});
	});

	it("PER_RENDITION with renditions absent fails the same way", () => {
		const verdict = evaluateQcGate(
			gate({
				rules: [{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 93 }],
			}),
			measuredTwo,
			["v1080", "v720", "v480"],
		);
		expect(verdict.pass).toBe(false);
		expect(verdict.ruleResults[0]?.actuals).toHaveLength(3);
	});

	it("passes when the expected population IS fully measured", () => {
		expect(
			evaluateQcGate(
				gate({ rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 93 }] }),
				measuredTwo,
				["v1080", "v720"],
			).pass,
		).toBe(true);
	});

	it("an explicit rule.renditions list still overrides the expected set", () => {
		// Naming renditions out of the rule is the ONE sanctioned way to skip
		// an unmeasurable rendition (a Dolby-vision reference, say).
		expect(
			evaluateQcGate(
				gate({
					rules: [
						{
							metric: "VMAF_MEAN",
							scope: "OVERALL",
							gte: 93,
							renditions: ["v1080", "v720"],
						},
					],
				}),
				measuredTwo,
				["v1080", "v720", "v480"],
			).pass,
		).toBe(true);
	});

	it("a measurement for a rendition OUTSIDE the expected set still judges it when named", () => {
		// expected drives DEFAULTS only; an explicit rule reaches anything
		// measured (or fails it as unmeasured if not).
		const verdict = evaluateQcGate(
			gate({
				rules: [
					{
						metric: "VMAF_MEAN",
						scope: "PER_RENDITION",
						gte: 99,
						renditions: ["v1080"],
					},
				],
			}),
			measuredTwo,
			[],
		);
		expect(verdict.pass).toBe(false);
		expect(verdict.ruleResults[0]?.actuals[0]?.value).toBe(96);
	});
});

describe("qcGateRuleSchema refinements (review-86b N-2)", () => {
	it("rejects duplicate rendition keys within one rule", () => {
		const dup = qcGateRuleSchema.safeParse({
			metric: "VMAF_MEAN",
			scope: "PER_RENDITION",
			gte: 80,
			renditions: ["v", "v"],
		});
		expect(dup.success).toBe(false);
		const ok = qcGateRuleSchema.safeParse({
			metric: "VMAF_MEAN",
			scope: "PER_RENDITION",
			gte: 80,
			renditions: ["v", "w"],
		});
		expect(ok.success).toBe(true);
	});
});
