import type { PerTitleGoal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	applyPerTitleAdvice,
	createPerTitleEvaluationAdvice,
	hasPerTitleEvaluationCountEvidence,
	type PerTitleAdviceOptions,
} from "./per-title-simulator-advice";
import { perTitleAdviceFields } from "./per-title-simulator-advice-fields";
import {
	analyzePerTitleSettings,
	perTitleAnalysisContextKey,
} from "./per-title-simulator-analysis";
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

describe("Per-Title evaluation purpose boundaries", () => {
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
		const repair = analyzePerTitleSettings(goal, "cap", options).advice[0];
		if (!repair) throw new Error("Expected a count-spacing repair.");
		const applied = applyPerTitleAdvice(goal, repair, {
			...options,
			contextKey: perTitleAnalysisContextKey("cap"),
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
