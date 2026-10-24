import { type PerTitleGoal, previewPerTitleOutput } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	applyPerTitleAdvice,
	createPerTitleEvaluationAdvice,
	hasPerTitleEvaluationCountEvidence,
	type PerTitleAdviceOptions,
} from "./per-title-simulator-advice";
import { perTitleAdviceFields } from "./per-title-simulator-advice-fields";
import { perTitleAdvicePreview } from "./per-title-simulator-advice-preview-model";
import {
	analyzePerTitleSettings,
	perTitleAnalysisContextKey,
} from "./per-title-simulator-analysis";
import { assessPerTitleOrdinaryCap } from "./per-title-simulator-analysis-ordinary-cap";
import { assessPerTitleValidity } from "./per-title-simulator-analysis-validity";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const codecs = ["H264", "H265", "VP9", "AV1"] as const;
const intents = ["count", "preserve"] as const;

function pointGoal(
	codec: PerTitleGoal["codec"],
	count: 1 | 2 | 6,
	maximum: number,
): PerTitleGoal {
	const rates =
		count === 1
			? [200_000]
			: count === 2
				? [200_000, 300_000]
				: Array.from({ length: 6 }, (_, index) =>
						Math.round(200_000 * 16 ** (index / 5)),
					);
	return {
		strategy: "fixed-ranges",
		codec,
		minBitrate: 100_000,
		maxBitrate: maximum,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 1.9,
		countPolicy: { kind: "exact", count },
		autoRepresentations: false,
		targetQualityCrf: 18,
		rows: rates.map((bitrate, index) => ({
			id: `fixed-${index}`,
			height: [180, 270, 360, 540, 720, 1080][index] ?? 1080,
			minBitrate: bitrate,
			maxBitrate: bitrate,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 400_000,
			highComplexityBoundaryForMaxBitrate: 4_000_000,
		})),
	};
}

function optimizedGoal(
	codec: PerTitleGoal["codec"],
	maximum: number,
): PerTitleGoal {
	return {
		...pointGoal(codec, 1, maximum),
		rows: [
			{
				id: "fixed",
				height: 720,
				minBitrate: 200_000,
				maxBitrate: 400_000,
				bitrateSelectionMode: "OPTIMIZED",
			},
		],
	};
}

function requirements(goal: PerTitleGoal) {
	return {
		strategy: goal.strategy,
		codec: goal.codec,
		minimum: goal.minBitrate,
		maximum: goal.maxBitrate,
		count: goal.countPolicy,
		automatic: goal.autoRepresentations,
		quality: goal.targetQualityCrf,
		rows: goal.rows?.map(({ id, height, width }) => ({ id, height, width })),
		ordinary: goal.automaticTemplates,
	};
}

function ordinaryCountGoal(codec: PerTitleGoal["codec"]): PerTitleGoal {
	return {
		strategy: "count",
		codec,
		minBitrate: 300_000,
		maxBitrate: 4_000_000,
		minBitrateStepSize: 2.128663656502157,
		maxBitrateStepSize: 2.1286666666666667,
		countPolicy: { kind: "exact", count: 4 },
		targetQualityCrf: 18,
		rows: [],
		autoRepresentations: {},
		automaticTemplates: [{ id: "ordinary" }],
	};
}

function ordinarySlots(goal: PerTitleGoal) {
	const proposal = tunePerTitleSettings(goal, goal).proposal;
	return previewPerTitleOutput(proposal, {
		countPolicy: goal.countPolicy,
	}).rows.filter((row) => row.kind === "count-slot");
}

describe("Per-Title evaluation purpose boundaries", () => {
	it.each(
		codecs,
	)("repairs %s ordinary cap spacing without changing a held minimum step or claiming native reach", (codec) => {
		const goal = ordinaryCountGoal(codec);
		const before = structuredClone(goal);
		const context = {
			referenceGoal: goal,
			contextKey: perTitleAnalysisContextKey("cap"),
			protectedFields: [
				{ scope: "global" as const, key: "minBitrateStepSize" },
				{ scope: "global" as const, key: "targetQualityCrf" },
			],
		};
		const current = tunePerTitleSettings(goal, goal).proposal;
		expect(hasPerTitleEvaluationCountEvidence(goal, current)).toBe(true);
		expect(ordinarySlots(goal).at(-1)?.maximumBitrate).toBe(2_893_637);
		const result = analyzePerTitleSettings(goal, "cap", context);
		expect(result.reach.status).toBe("unknown");
		expect(result.quality.status).toBe("requires-media");
		expect(result.decision.status).toBe("proposal");
		expect(result.advice.length).toBeGreaterThan(0);
		for (const advice of result.advice) {
			expect(advice.proof).toBe("model-count");
			expect(advice.changes.map(({ scope, key }) => ({ scope, key }))).toEqual([
				{ scope: "global", key: "maxBitrateStepSize" },
			]);
			const applied = applyPerTitleAdvice(goal, advice, context);
			if (!applied)
				throw new Error("Expected an adoptable cap-spacing repair.");
			expect(requirements(applied)).toEqual(requirements(goal));
			expect(applied.minBitrateStepSize).toBe(goal.minBitrateStepSize);
			expect(ordinarySlots(applied)).toHaveLength(4);
			expect(ordinarySlots(applied).at(-1)?.maximumBitrate).toBe(
				goal.maxBitrate,
			);
			const checked = tunePerTitleSettings(applied, goal).proposal;
			expect(checked.api).toEqual(advice.proposal.api);
			expect(hasPerTitleEvaluationCountEvidence(applied, checked)).toBe(true);
			expect(checked.countGuarantee).toBe(false);
			const selected = advice.changes.map(({ scope, key, rowId }) => ({
				scope,
				key,
				...(rowId === undefined ? {} : { rowId }),
			}));
			const full = perTitleAdvicePreview(
				goal,
				advice,
				{ selected: [], kept: [] },
				context,
			);
			const partial = perTitleAdvicePreview(
				goal,
				advice,
				{ selected, kept: [] },
				context,
			);
			const kept = perTitleAdvicePreview(
				goal,
				advice,
				{ selected: [], kept: selected },
				context,
			);
			expect(full.status).toBe("ready");
			expect(full.after?.api).toEqual(checked.api);
			expect(partial.after?.api).toEqual(checked.api);
			expect(kept.after?.api).toEqual(current.api);
			expect(
				analyzePerTitleSettings(applied, "count", context).decision.status,
			).toBe("keep-current");
			const rechecked = analyzePerTitleSettings(applied, "cap", context);
			expect(rechecked.decision.status).toBe("keep-current");
			expect(rechecked.advice).toEqual([]);
			expect(rechecked.ordinaryCap.status).toBe("permitted");
			expect(rechecked.reach.status).toBe("unknown");
		}
		expect(goal).toEqual(before);
	});

	it.each(
		codecs,
	)("requires %s cap proposals to permit the cap as well as repair the requested count", (codec) => {
		const goal: PerTitleGoal = {
			...ordinaryCountGoal(codec),
			strategy: "automatic",
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 6,
		};
		const result = analyzePerTitleSettings(goal, "cap", {
			referenceGoal: goal,
		});
		expect(result.decision.status).toBe("proposal");
		expect(result.advice.length).toBeGreaterThan(0);
		for (const advice of result.advice) {
			expect(advice.proof).toBe("model-count");
			expect(requirements(advice.goal)).toEqual(requirements(goal));
			expect(ordinarySlots(advice.goal)).toHaveLength(4);
			expect(ordinarySlots(advice.goal).at(-1)?.maximumBitrate).toBe(
				goal.maxBitrate,
			);
		}
	});

	it.each(
		codecs,
	)("keeps %s count and preserve objectives distinct from ordinary cap utilization", (codec) => {
		const goal = ordinaryCountGoal(codec);
		for (const intent of ["count", "preserve"] as const) {
			const result = analyzePerTitleSettings(goal, intent, {
				referenceGoal: goal,
			});
			expect(result.decision.status).toBe("keep-current");
			expect(result.advice).toEqual([]);
			expect(result.reach.status).toBe("unknown");
		}
		const bandwidth = analyzePerTitleSettings(goal, "bandwidth", {
			referenceGoal: goal,
		});
		expect(bandwidth.decision.status).toBe("inspect-only");
		expect(bandwidth.advice).toEqual([]);
		expect(ordinarySlots(goal).at(-1)?.maximumBitrate).toBe(2_893_637);
	});

	it("identifies a held maximum step that prevents four ordinary outputs from permitting the cap", () => {
		const goal = { ...ordinaryCountGoal("H264"), maxBitrateStepSize: 2.37 };
		const before = structuredClone(goal);
		const minimumStep = { scope: "global" as const, key: "minBitrateStepSize" };
		const maximumStep = { scope: "global" as const, key: "maxBitrateStepSize" };
		const result = analyzePerTitleSettings(goal, "cap", {
			referenceGoal: goal,
			protectedFields: [minimumStep, maximumStep],
		});
		// Even the largest integer path allowed by this maximum ratio ends at
		// 3,993,615 bps: 300,000 -> 711,000 -> 1,685,070 -> 3,993,615.
		expect(ordinarySlots(goal).at(-1)?.maximumBitrate).toBe(3_993_615);
		expect(result.advice).toEqual([]);
		expect(result.decision.status).toBe("no-certified-candidate");
		expect(result.relaxation?.fields).toEqual([maximumStep]);
		expect(result.relaxation?.certifiedAlternatives).toBeGreaterThan(0);
		expect(
			result.findings.some(
				(finding) =>
					finding.severity === "warning" &&
					finding.fields?.some(
						({ scope, key }) =>
							scope === "global" && key === "maxBitrateStepSize",
					),
			),
		).toBe(true);
		expect(goal).toEqual(before);
	});

	it("does not substitute a count-only repair for an impossible one-slot cap objective", () => {
		const goal: PerTitleGoal = {
			...ordinaryCountGoal("H264"),
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 6,
			countPolicy: { kind: "exact", count: 1 },
		};
		const result = analyzePerTitleSettings(goal, "cap", {
			referenceGoal: goal,
		});
		expect(result.advice).toEqual([]);
		expect(result.decision.status).toBe("no-certified-candidate");
		expect(result.reach.status).toBe("unknown");
		expect(ordinarySlots(goal)).toHaveLength(1);
		expect(ordinarySlots(goal)[0]?.maximumBitrate).toBe(goal.minBitrate);
	});

	it.each([
		[2.3712633333333333, "blocked"],
		[2.3712633333333337, "permitted"],
	] as const)("uses emitted decimal spacing at the ordinary cap boundary %s", (maximumStep, status) => {
		const goal = {
			...ordinaryCountGoal("H264"),
			maxBitrateStepSize: maximumStep,
		};
		const proposal = tunePerTitleSettings(goal, goal).proposal;
		expect(hasPerTitleEvaluationCountEvidence(goal, proposal)).toBe(true);
		const cap = assessPerTitleOrdinaryCap(goal, proposal);
		expect(cap.status).toBe(status);
		expect(cap.scope).toBe("spacing-only");
		if (status === "permitted")
			expect(cap.lastSlot?.maximum).toBe(goal.maxBitrate);
		else expect(cap.lastSlot?.maximum).toBeLessThan(goal.maxBitrate);
	});

	it.each([
		"maximum",
		"unrestricted",
	] as const)("does not interpret %s count requirements as exact ordinary cap evidence", (kind) => {
		const goal: PerTitleGoal = {
			...ordinaryCountGoal("H264"),
			countPolicy: kind === "maximum" ? { kind, count: 4 } : { kind },
		};
		const result = analyzePerTitleSettings(goal, "cap", {
			referenceGoal: goal,
		});
		expect(result.ordinaryCap.status).toBe("unavailable");
		expect(result.ordinaryCap.count).toBeNull();
		expect(result.reach.status).toBe("unknown");
		expect(result.advice).toEqual([]);
		expect(result.decision.status).not.toBe("keep-current");
	});

	it("preserves inactive forced-rule metadata in an ordinary cap-spacing repair", () => {
		const rule = {
			forcedRenditionAboveHighestFixedRepresentation: 0,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"MAXIMUM" as const,
		};
		const goal = {
			...ordinaryCountGoal("H264"),
			fixedResolutionAndBitrateConfiguration: rule,
		};
		const context = {
			referenceGoal: goal,
			contextKey: perTitleAnalysisContextKey("cap"),
		};
		const result = analyzePerTitleSettings(goal, "cap", context);
		expect(result.ordinaryCap.status).toBe("blocked");
		expect(result.advice.length).toBeGreaterThan(0);
		for (const advice of result.advice) {
			expect(
				advice.proposal.api.global.fixedResolutionAndBitrateConfiguration,
			).toEqual(rule);
			expect(
				advice.changes.every(({ key }) => key === "maxBitrateStepSize"),
			).toBe(true);
			const applied = applyPerTitleAdvice(goal, advice, context);
			if (!applied)
				throw new Error("Expected an adoptable inactive-rule cap repair.");
			expect(applied.fixedResolutionAndBitrateConfiguration).toEqual(rule);
			expect(ordinarySlots(applied).at(-1)?.maximumBitrate).toBe(
				goal.maxBitrate,
			);
		}
	});

	it("does not use the ordinary spacing proof for active or incomplete forced rules", () => {
		for (const rule of [
			{
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"MAXIMUM" as const,
			},
			{ forcedRenditionAboveHighestFixedRepresentationFactor: 1.2 },
		]) {
			const goal = {
				...ordinaryCountGoal("H264"),
				fixedResolutionAndBitrateConfiguration: rule,
			};
			const proposal = tunePerTitleSettings(goal, goal).proposal;
			expect(assessPerTitleOrdinaryCap(goal, proposal).status).toBe(
				"unavailable",
			);
		}
	});

	it("does not certify ordinary cap spacing for API-invalid stream settings", () => {
		const goal: PerTitleGoal = {
			...ordinaryCountGoal("H264"),
			automaticTemplates: [{ id: "ordinary", codecMaxBitrateFactor: 0 }],
		};
		const proposal = tunePerTitleSettings(goal, goal).proposal;
		expect(proposal.applicable).toBe(false);
		expect(proposal.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "invalid-setting",
				severity: "conflict",
			}),
		);
		expect(assessPerTitleOrdinaryCap(goal, proposal).status).toBe(
			"unavailable",
		);
	});

	it("recognizes a one-slot cap only when the first and last bitrate are the same", () => {
		const goal: PerTitleGoal = {
			...ordinaryCountGoal("H264"),
			maxBitrate: 300_000,
			countPolicy: { kind: "exact", count: 1 },
		};
		const result = analyzePerTitleSettings(goal, "cap", {
			referenceGoal: goal,
		});
		expect(result.ordinaryCap.status).toBe("permitted");
		expect(result.ordinaryCap.lastSlot).toEqual({
			minimum: 300_000,
			maximum: 300_000,
		});
		expect(result.reach.status).toBe("unknown");
		expect(result.advice).toEqual([]);
		expect(result.decision.status).toBe("keep-current");
	});

	it("checks cap proposals against the resolved automatic upper bound without replacing its policy", () => {
		const goal: PerTitleGoal = {
			...ordinaryCountGoal("H264"),
			adjustments: {
				global: { maxBitrate: { mode: "auto", method: "default" } },
			},
		};
		const reference = { ...ordinaryCountGoal("H264"), maxBitrate: 6_000_000 };
		const context = {
			referenceGoal: reference,
			contextKey: perTitleAnalysisContextKey("cap"),
		};
		const result = analyzePerTitleSettings(goal, "cap", context);
		expect(result.ordinaryCap.cap).toBe(reference.maxBitrate);
		expect(result.advice.length).toBeGreaterThan(0);
		for (const advice of result.advice) {
			const applied = applyPerTitleAdvice(goal, advice, context);
			if (!applied)
				throw new Error("Expected an adoptable resolved-cap repair.");
			expect(applied.adjustments?.global?.maxBitrate).toEqual(
				goal.adjustments?.global?.maxBitrate,
			);
			expect(applied.maxBitrate).toBe(goal.maxBitrate);
			expect(advice.changes.some(({ key }) => key === "maxBitrate")).toBe(
				false,
			);
			const checked = tunePerTitleSettings(applied, reference).proposal;
			expect(checked.api.global.maxBitrate).toBe(reference.maxBitrate);
			const rows = previewPerTitleOutput(checked, {
				countPolicy: applied.countPolicy,
			}).rows;
			expect(
				rows.filter(({ kind }) => kind === "count-slot").at(-1)?.maximumBitrate,
			).toBe(reference.maxBitrate);
		}
	});

	it.each(
		codecs.flatMap((codec) =>
			([1, 2, 6] as const).flatMap((count) =>
				[4_000_000, 6_000_000].flatMap((maximum) =>
					intents.map((intent) => [codec, count, maximum, intent] as const),
				),
			),
		),
	)("keeps checked %s point count %s at %s for %s while retaining cap warnings", (codec, count, maximum, intent) => {
		const input = pointGoal(codec, count, maximum);
		const normalized = tunePerTitleSettings(input, input);
		expect(
			hasPerTitleEvaluationCountEvidence(normalized.goal, normalized.proposal),
		).toBe(true);
		// Hold all optional settings so preserve cannot replace an already valid
		// count with an unrelated cap-tracking adjustment.
		const options: PerTitleAdviceOptions = {
			referenceGoal: input,
			protectedFields: perTitleAdviceFields(normalized.goal),
		};
		const before = structuredClone(normalized.goal);
		const result = analyzePerTitleSettings(normalized.goal, intent, options);
		expect(result.advice).toEqual([]);
		expect(result.decision.status).toBe("keep-current");
		expect(result.decision.message.en).toContain("count and spacing");
		expect(result.relaxation).toBeUndefined();
		expect(result.findings).toContainEqual(
			expect.objectContaining({ code: "flat-top", severity: "warning" }),
		);
		expect(result.findings.map(({ code }) => code)).toContain(
			"count-model-checked",
		);
		expect(normalized.proposal.countGuarantee).toBe(false);
		expect(normalized.goal).toEqual(before);
	});

	it.each(
		codecs.flatMap((codec) =>
			([1, 2, 6] as const).flatMap((count) =>
				(["exact", "maximum"] as const).map(
					(kind) => [codec, count, kind] as const,
				),
			),
		),
	)("keeps repaired %s ordinary count %s/%s without removing native-analysis caveats", (codec, count, kind) => {
		const goal: PerTitleGoal = {
			strategy: "automatic",
			codec,
			minBitrate: 100_000,
			maxBitrate: 4_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind, count },
			autoRepresentations: {},
			automaticTemplates: [{ id: "ordinary" }],
		};
		const options = { referenceGoal: goal };
		const repair = analyzePerTitleSettings(goal, "count", options).advice[0];
		if (!repair) throw new Error("Expected a count-spacing repair.");
		const applied = applyPerTitleAdvice(goal, repair, {
			...options,
			contextKey: perTitleAnalysisContextKey("count"),
		});
		if (!applied) throw new Error("Expected an adoptable count repair.");
		const result = analyzePerTitleSettings(applied, "count", options);
		expect(result.advice).toEqual([]);
		expect(result.decision.status).toBe("keep-current");
		expect(result.findings).toContainEqual(
			expect.objectContaining({
				code: "automatic-count-unresolved",
				severity: "warning",
			}),
		);
		expect(result.reach.status).toBe("unknown");
		expect(result.quality.status).toBe("requires-media");
		expect(applied.countPolicy).toEqual(goal.countPolicy);
	});

	it.each(
		codecs.flatMap((codec) =>
			[1_000_000, 4_000_000, 6_000_000].flatMap((maximum) =>
				intents.map((intent) => [codec, maximum, intent] as const),
			),
		),
	)("finds an independently checked %s selection-policy count repair at %s for %s", (codec, maximum, intent) => {
		const goal = optimizedGoal(codec, maximum);
		const before = structuredClone(goal);
		const options: PerTitleAdviceOptions = {
			referenceGoal: goal,
			protectedFields: [
				{ scope: "global", key: "targetQualityCrf" },
				{ scope: "stream", rowId: "fixed", key: "minBitrate" },
			],
		};
		const candidate: PerTitleGoal = {
			...goal,
			rows: goal.rows?.map((row) => ({
				...row,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 400_000,
				highComplexityBoundaryForMaxBitrate: maximum,
			})),
		};
		const context = {
			...options,
			contextKey: perTitleAnalysisContextKey(intent),
		};
		const independent = createPerTitleEvaluationAdvice(
			goal,
			candidate,
			context,
		);
		if (!independent)
			throw new Error("Expected an independently checked repair.");
		expect(independent.proof).toBe("model-count");
		expect(applyPerTitleAdvice(goal, independent, context)).not.toBeNull();
		const result = analyzePerTitleSettings(goal, intent, options);
		expect(result.decision.status).toBe("proposal");
		expect(result.advice.length).toBeGreaterThan(0);
		expect(
			result.advice.some((advice) =>
				advice.changes.some(
					(change) =>
						change.key === "bitrateSelectionMode" &&
						change.after === "COMPLEXITY_RANGE",
				),
			),
		).toBe(true);
		for (const advice of result.advice) {
			expect(advice.proof).toBe("model-count");
			expect(requirements(advice.goal)).toEqual(requirements(goal));
			const applied = applyPerTitleAdvice(goal, advice, context);
			if (!applied) throw new Error("Expected an adoptable generated repair.");
			const recalculated = tunePerTitleSettings(applied, goal).proposal;
			expect(recalculated.api).toEqual(advice.proposal.api);
			expect(hasPerTitleEvaluationCountEvidence(applied, recalculated)).toBe(
				true,
			);
			expect(
				assessPerTitleValidity(applied, recalculated).some(
					(finding) => finding.severity === "conflict",
				),
			).toBe(false);
			expect(recalculated.countGuarantee).toBe(false);
			const reevaluated = analyzePerTitleSettings(applied, intent, options);
			expect(["keep-current", "proposal"]).toContain(
				reevaluated.decision.status,
			);
			for (const remaining of reevaluated.advice) {
				const next = applyPerTitleAdvice(applied, remaining, context);
				if (!next) throw new Error("Expected an adoptable follow-up.");
				expect(requirements(next)).toEqual(requirements(goal));
				expect(
					hasPerTitleEvaluationCountEvidence(
						next,
						tunePerTitleSettings(next, goal).proposal,
					),
				).toBe(true);
			}
		}
		expect(goal).toEqual(before);
	});

	it.each(
		intents,
	)("retains a held selection policy instead of silently repairing %s", (intent) => {
		const goal = optimizedGoal("H264", 1_000_000);
		const before = structuredClone(goal);
		const held = {
			scope: "stream" as const,
			rowId: "fixed",
			key: "bitrateSelectionMode",
		};
		const result = analyzePerTitleSettings(goal, intent, {
			referenceGoal: goal,
			protectedFields: [held],
		});
		expect(result.advice).toEqual([]);
		expect(result.decision.status).not.toBe("keep-current");
		expect(result.relaxation?.fields).toEqual([held]);
		expect(result.relaxation?.certifiedAlternatives).toBeGreaterThan(0);
		expect(goal).toEqual(before);
	});

	it.each(
		codecs.flatMap((codec) =>
			([2, 6] as const).flatMap((count) =>
				intents.map((intent) => [codec, count, intent] as const),
			),
		),
	)("repairs every unresolved selection policy in a %s closed %s-count ladder for %s", (codec, count, intent) => {
		const candidate = pointGoal(codec, count, 4_000_000);
		const goal: PerTitleGoal = {
			...candidate,
			rows: candidate.rows?.map((row) => ({
				id: row.id,
				height: row.height,
				minBitrate: row.minBitrate,
				maxBitrate: row.maxBitrate,
				bitrateSelectionMode: "OPTIMIZED",
			})),
		};
		const context = {
			referenceGoal: goal,
			contextKey: perTitleAnalysisContextKey(intent),
		};
		expect(
			createPerTitleEvaluationAdvice(goal, candidate, context)?.proof,
		).toBe("model-count");
		const result = analyzePerTitleSettings(goal, intent, context);
		expect(result.decision.status).toBe("proposal");
		expect(result.advice.length).toBeGreaterThan(0);
		for (const advice of result.advice) {
			const applied = applyPerTitleAdvice(goal, advice, context);
			if (!applied) throw new Error("Expected an adoptable policy repair.");
			expect(requirements(applied)).toEqual(requirements(goal));
			expect(
				applied.rows?.map(({ id, minBitrate, maxBitrate }) => ({
					id,
					minBitrate,
					maxBitrate,
				})),
			).toEqual(
				goal.rows?.map(({ id, minBitrate, maxBitrate }) => ({
					id,
					minBitrate,
					maxBitrate,
				})),
			);
			expect(
				hasPerTitleEvaluationCountEvidence(
					applied,
					tunePerTitleSettings(applied, goal).proposal,
				),
			).toBe(true);
		}
	});

	it.each(
		intents,
	)("identifies a held lower selection policy blocking a multirow %s repair", (intent) => {
		const source = pointGoal("H264", 2, 4_000_000);
		const goal: PerTitleGoal = {
			...source,
			rows: source.rows?.map((row) => ({
				...row,
				bitrateSelectionMode: "OPTIMIZED",
				lowComplexityBoundaryForMaxBitrate: undefined,
				highComplexityBoundaryForMaxBitrate: undefined,
			})),
		};
		const held = {
			scope: "stream" as const,
			rowId: "fixed-0",
			key: "bitrateSelectionMode",
		};
		const before = structuredClone(goal);
		const result = analyzePerTitleSettings(goal, intent, {
			referenceGoal: goal,
			protectedFields: [held],
		});
		expect(result.advice).toEqual([]);
		expect(result.decision.status).not.toBe("keep-current");
		expect(result.relaxation?.fields).toEqual([held]);
		expect(result.relaxation?.certifiedAlternatives).toBeGreaterThan(0);
		expect(goal).toEqual(before);
	});

	it("does not treat a count certificate as permission to ignore a rate-control warning", () => {
		const goal = {
			...pointGoal("H264", 1, 4_000_000),
			codecMaxBitrateFactor: 0.5,
		};
		const normalized = tunePerTitleSettings(goal, goal);
		expect(
			hasPerTitleEvaluationCountEvidence(normalized.goal, normalized.proposal),
		).toBe(true);
		const result = analyzePerTitleSettings(normalized.goal, "count", {
			referenceGoal: goal,
			protectedFields: perTitleAdviceFields(normalized.goal),
		});
		expect(result.advice).toEqual([]);
		expect(result.decision.status).not.toBe("keep-current");
		expect(result.findings).toContainEqual(
			expect.objectContaining({
				code: "codec-maximum-below-target",
				severity: "warning",
			}),
		);
	});

	it("does not declare an invalid global requirement repaired by a count certificate", () => {
		const goal = { ...pointGoal("H264", 1, 4_000_000), minBitrate: 9_999 };
		const result = analyzePerTitleSettings(goal, "count", {
			protectedFields: perTitleAdviceFields(goal),
		});
		expect(result.advice).toEqual([]);
		expect(result.decision.status).not.toBe("keep-current");
		expect(result.findings.map(({ code }) => code)).toContain(
			"global-bitrate-below-api-minimum",
		);
	});
});
