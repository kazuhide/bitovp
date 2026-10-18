import { z } from "zod";
import type { PooledMetrics } from "../vmaf/pooled";

/**
 * QC gate : threshold rules over pooled
 * metrics that turn measurement into enforcement — the #40 lesson (a
 * mean-16.77 report shipped FINISHED) as product behavior.
 *
 * PR1 is judgment only: the schema (an optional key inside plan.qc — absent
 * plans emit nothing and the 73 goldens stay byte-identical), the C29
 * validator rails, and the pure verdict function. The orchestration halves
 * (deferred manifest group, AWAITING_QC/QC_FAILED, the vmaf-runner
 * continuation) are PR2 by the design's own split.
 */

export const QC_GATE_METRICS = [
	"VMAF_MEAN",
	"VMAF_HARMONIC_MEAN",
	"VMAF_P1_LOW",
	"VMAF_MIN",
	"PSNR_MEAN",
] as const;
export type QcGateMetric = (typeof QC_GATE_METRICS)[number];

export const qcGateRuleSchema = z.strictObject({
	metric: z.enum(QC_GATE_METRICS),
	/**
	 * PER_RENDITION = every targeted rendition (and per-title rung) must
	 * clear the bar individually. OVERALL = the MEAN of the targeted values
	 * must clear it — the ladder judged as a whole, tolerant of one rung
	 * dipping while the set holds. (review-86b I-1: the first cut defined
	 * OVERALL as "worst rendition", which is provably the same predicate as
	 * PER_RENDITION — 6,144 brute-forced shapes, zero differences — so the
	 * scope control did nothing. Semantics fixed BEFORE any plan persisted
	 * a gate; both scopes still fail closed on any unmeasured target.)
	 */
	scope: z.enum(["PER_RENDITION", "OVERALL"]),
	/**
	 * Thresholds are lower bounds — one operator, honest (design §2). The
	 * 0..100 ceiling is honest for PSNR only because OUR pipeline caps it:
	 * `capPsnr` clamps every persisted dB into [0, PSNR_MAX_DB=100], so a
	 * higher gte is unsatisfiable by construction. If PSNR_MAX_DB ever
	 * moves, this bound must move with it (review-86b priority-2 note).
	 */
	gte: z.number().min(0).max(100),
	/** Rendition KEYS; absent = every measured rendition. */
	renditions: z
		.array(z.string().min(1))
		.min(1)
		.refine((keys) => new Set(keys).size === keys.length, {
			message: "Rendition keys must be unique within a rule",
		})
		.optional(),
});

export const qcGateSchema = z.strictObject({
	rules: z.array(qcGateRuleSchema).min(1),
	onFail: z.enum(["MARK_ONLY", "BLOCK_MANIFESTS"]),
});

export type QcGate = z.infer<typeof qcGateSchema>;
export type QcGateRule = z.infer<typeof qcGateRuleSchema>;

/** One rendition's pooled measurement, as the vmaf-runner persists it. */
export type RenditionPooled = {
	rendition: string;
	/**
	 * Per-title rung id (the resolved `{height}_{bitrate}_{uuid}` segment).
	 * A per-title rendition produces SEVERAL measurements under one rendition
	 * key — each rung is its own entry here, and the gate holds every one of
	 * them to the bar. Absent for standard renditions.
	 */
	variant?: string;
	pooled: PooledMetrics;
};

export type QcRuleResult = {
	rule: QcGateRule;
	pass: boolean;
	/**
	 * Per-rendition actuals: value null = UNMEASURED (rendition named by the
	 * rule but absent from the results, or PSNR asked of a VMAF-only run).
	 * An unmeasured value FAILS its rule — a gate over missing data must
	 * refuse loudly, never pass silently (the instruments-count-the-whole-
	 * population lesson). Per-title rungs appear as one actual EACH (variant
	 * set), all measured against the same threshold.
	 */
	actuals: {
		rendition: string;
		variant?: string;
		value: number | null;
		pass: boolean;
	}[];
};

export type QcVerdict = {
	pass: boolean;
	ruleResults: QcRuleResult[];
};

function metricOf(pooled: PooledMetrics, metric: QcGateMetric): number | null {
	// `?? null` throughout (review-86b N-1): PooledMetrics arrives from a
	// Prisma Json column that is cast, never parsed — a row missing a field
	// yields undefined, which fails closed but serializes as an ABSENT key
	// where the actuals type promises `value: number | null`, and the PR3
	// evidence export reads these.
	switch (metric) {
		case "VMAF_MEAN":
			return pooled.mean ?? null;
		case "VMAF_HARMONIC_MEAN":
			return pooled.harmonicMean ?? null;
		case "VMAF_P1_LOW":
			// The LOW-1% POOL mean (not percentiles.p1): "P1_LOW" is the QoE
			// tail metric, and the pool mean is the one #40's report headlines.
			return pooled.low1Percent ?? null;
		case "VMAF_MIN":
			return pooled.min ?? null;
		case "PSNR_MEAN":
			return pooled.psnr ? (pooled.psnr.mean ?? null) : null;
	}
}

/**
 * Pure verdict (design §3.3). PER_RENDITION: every targeted rendition must
 * clear the bar, each with its own actual. OVERALL: the MEAN of the
 * targeted values must clear it — the ladder as one number (review-86b
 * I-1; "worst rendition" was PER_RENDITION restated). Both fail on
 * unmeasured targets.
 *
 * Rungs : rules target rendition KEYS, and a per-title key
 * expands to one actual PER RUNG — the first cut collapsed duplicates into a
 * Map, so a per-title rendition was judged by whichever rung happened to be
 * persisted last. A floor over a ladder must hold every rung to it.
 *
 * `expectedRenditions` (review-201 C2): the default target set for a rule
 * with `renditions` absent. The first cut derived it from the RESULTS — so a
 * rendition that was never measured was not "unmeasured", it was invisible,
 * and a BLOCK gate passed a delivery with an unverified rendition (reachable:
 * enumerateQcTargets silently skips three ways). REQUIRED, not optional: the
 * caller that knows the plan must say what was promised; deriving it from
 * what happened is the exact hole. Pass gateExpectedRenditionKeys(plan).
 */
export function evaluateQcGate(
	gate: QcGate,
	results: RenditionPooled[],
	expectedRenditions: string[],
	/**
	 * Rungs the provider BUILT that the runner could not score (* paid audit HIGH-10): a per-title rung whose QC mirror was never written.
	 * Each becomes one failing actual (`value: null`) for every rule that
	 * targets its rendition — the listing-based population made such a rung
	 * invisible, and a gate cannot hold to the bar a rung it never heard of.
	 */
	unmeasured: { rendition: string; variant?: string }[] = [],
): QcVerdict {
	const byRendition = new Map<string, RenditionPooled[]>();
	for (const entry of results) {
		const bucket = byRendition.get(entry.rendition);
		if (bucket) {
			bucket.push(entry);
		} else {
			byRendition.set(entry.rendition, [entry]);
		}
	}
	const ruleResults: QcRuleResult[] = gate.rules.map((rule) => {
		const targets = rule.renditions ?? expectedRenditions;
		const actuals = targets.flatMap((rendition) => {
			const measured = byRendition.get(rendition);
			const holes = unmeasured
				.filter((u) => u.rendition === rendition)
				.map((u) => ({
					rendition,
					...(u.variant !== undefined ? { variant: u.variant } : {}),
					value: null,
					pass: false,
				}));
			if (!measured || measured.length === 0) {
				// Named by the rule, absent from the results — ONE failing
				// actual documents the hole (or one per unmeasured rung).
				return holes.length > 0
					? holes
					: [{ rendition, value: null, pass: false }];
			}
			return [
				...measured.map((entry) => {
					const value = metricOf(entry.pooled, rule.metric);
					return {
						rendition,
						...(entry.variant !== undefined ? { variant: entry.variant } : {}),
						value,
						pass: value !== null && value >= rule.gte,
					};
				}),
				...holes,
			];
		});
		if (rule.scope === "OVERALL") {
			// The ladder mean carries the verdict (per-rung actuals stay
			// reported with their individual pass flags as evidence). An
			// unmeasured target still fails the rule outright — averaging
			// over a hole would let missing data soften the bar — and zero
			// targets cannot pass.
			const values = actuals.map((entry) => entry.value);
			const pass =
				values.length > 0 &&
				values.every((value) => value !== null) &&
				(values as number[]).reduce((sum, value) => sum + value, 0) /
					values.length >=
					rule.gte;
			return { rule, pass, actuals };
		}
		const pass = actuals.length > 0 && actuals.every((entry) => entry.pass);
		return { rule, pass, actuals };
	});
	return {
		pass: ruleResults.every((entry) => entry.pass),
		ruleResults,
	};
}
