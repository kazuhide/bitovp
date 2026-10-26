import { type PerTitleGoal, previewPerTitleOutput } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	applyPerTitleAdvice,
	applySelectedPerTitleAdvice,
	hasPerTitleEvaluationCountEvidence,
} from "./per-title-simulator-advice";
import {
	analyzePerTitleSettings,
	perTitleAnalysisContextKey,
} from "./per-title-simulator-analysis";
import { assessPerTitleOrdinaryCap } from "./per-title-simulator-analysis-ordinary-cap";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const codecs = ["H264", "H265", "H265V2", "VP9", "AV1"] as const;

function ordinary(codec: PerTitleGoal["codec"] = "H264"): PerTitleGoal {
	return {
		strategy: "count",
		codec,
		minBitrate: 300_000,
		maxBitrate: 4_000_000,
		minBitrateStepSize: 2.128663656502157,
		maxBitrateStepSize: 2.1286666666666667,
		countPolicy: { kind: "maximum", count: 4 },
		rows: [],
		autoRepresentations: {},
		automaticTemplates: [{ id: "ordinary" }],
	};
}

const capOptions = (goal: PerTitleGoal) => ({
	referenceGoal: goal,
	contextKey: perTitleAnalysisContextKey("cap"),
});

describe("ordinary cap with a maximum count", () => {
	it.each(
		codecs,
	)("repairs cap spacing without making %s maximum count exact", (codec) => {
		const goal = ordinary(codec);
		const before = structuredClone(goal);
		const proposal = tunePerTitleSettings(goal, goal).proposal;
		expect(hasPerTitleEvaluationCountEvidence(goal, proposal)).toBe(true);
		expect(assessPerTitleOrdinaryCap(goal, proposal).status).toBe("blocked");
		const options = capOptions(goal);
		const result = analyzePerTitleSettings(goal, "cap", options);
		expect(result.decision.status).toBe("proposal");
		const advice = result.advice[0];
		expect(advice).toBeDefined();
		if (!advice) return;
		expect(advice.proof).toBe("model-count");
		expect(advice.goal.countPolicy).toEqual(goal.countPolicy);
		expect(advice.goal.minBitrate).toBe(goal.minBitrate);
		expect(advice.goal.maxBitrate).toBe(goal.maxBitrate);
		expect(advice.goal.minBitrateStepSize).toBe(goal.minBitrateStepSize);
		expect(advice.goal.automaticTemplates).toEqual(goal.automaticTemplates);
		expect(advice.goal.autoRepresentations).toEqual(goal.autoRepresentations);
		expect(advice.proposal.countGuarantee).toBe(false);
		expect(
			hasPerTitleEvaluationCountEvidence(advice.goal, advice.proposal),
		).toBe(true);
		expect(
			assessPerTitleOrdinaryCap(advice.goal, advice.proposal),
		).toMatchObject({
			status: "permitted",
			count: 4,
			lastSlot: { maximum: 4_000_000 },
		});
		for (const applied of [
			applyPerTitleAdvice(goal, advice, options),
			applySelectedPerTitleAdvice(
				goal,
				advice,
				advice.changes.map(({ scope, key, rowId }) => ({ scope, key, rowId })),
				options,
			),
		]) {
			expect(applied).not.toBeNull();
			if (!applied) continue;
			expect(applied.countPolicy).toEqual({ kind: "maximum", count: 4 });
			const actual = tunePerTitleSettings(applied, goal).proposal;
			expect(actual.api).toEqual(advice.proposal.api);
			expect(
				previewPerTitleOutput(actual, { countPolicy: applied.countPolicy })
					.countProjection,
			).toMatchObject({
				kind: "maximum",
				status: "unavailable",
				reason: "maximum-only",
			});
		}
		expect(goal).toEqual(before);
	});

	it("repairs the raw maximum-count requirement and cap together", () => {
		const goal = {
			...ordinary(),
			strategy: "automatic" as const,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 6,
		};
		const result = analyzePerTitleSettings(goal, "cap", capOptions(goal));
		expect(result.decision.status).toBe("proposal");
		expect(result.advice.length).toBeGreaterThan(0);
		for (const advice of result.advice) {
			expect(advice.goal.countPolicy).toEqual(goal.countPolicy);
			expect(
				hasPerTitleEvaluationCountEvidence(advice.goal, advice.proposal),
			).toBe(true);
			expect(
				assessPerTitleOrdinaryCap(advice.goal, advice.proposal).status,
			).toBe("permitted");
		}
	});

	it("keeps an already cap-compatible maximum unchanged", () => {
		const goal = { ...ordinary(), maxBitrateStepSize: 2.5 };
		const result = analyzePerTitleSettings(goal, "cap", capOptions(goal));
		expect(result.ordinaryCap.status).toBe("permitted");
		expect(result.decision.status).toBe("keep-current");
		expect(result.advice).toEqual([]);
	});

	it("allows a three-placement chain under a maximum of four", () => {
		const goal = {
			...ordinary(),
			minBitrateStepSize: 3,
			maxBitrateStepSize: 3,
		};
		const result = analyzePerTitleSettings(goal, "cap", capOptions(goal));
		expect(result.decision.status).toBe("proposal");
		const advice = result.advice[0];
		expect(advice).toBeDefined();
		if (!advice) return;
		expect(advice.goal.countPolicy).toEqual({ kind: "maximum", count: 4 });
		expect(advice.goal.minBitrateStepSize).toBe(3);
		expect(
			hasPerTitleEvaluationCountEvidence(advice.goal, advice.proposal),
		).toBe(true);
		expect(
			assessPerTitleOrdinaryCap(advice.goal, advice.proposal),
		).toMatchObject({
			status: "permitted",
			count: 3,
			lastSlot: { maximum: 4_000_000 },
		});
	});

	it.each([
		false,
		true,
	])("relaxes an editable minimum when only one placement fits (held maximum=%s)", (holdMaximum) => {
		const goal = {
			...ordinary(),
			minBitrateStepSize: 20,
			maxBitrateStepSize: 20,
		};
		const result = analyzePerTitleSettings(goal, "cap", {
			...capOptions(goal),
			...(holdMaximum
				? {
						protectedFields: [
							{ scope: "global" as const, key: "maxBitrateStepSize" },
						],
					}
				: {}),
		});
		expect(result.decision.status).toBe("proposal");
		const advice = result.advice[0];
		expect(advice).toBeDefined();
		if (!advice) return;
		expect(advice.goal.countPolicy).toEqual(goal.countPolicy);
		expect(advice.goal.minBitrateStepSize).toBeLessThan(20);
		if (holdMaximum) expect(advice.goal.maxBitrateStepSize).toBe(20);
		expect(
			hasPerTitleEvaluationCountEvidence(advice.goal, advice.proposal),
		).toBe(true);
		expect(assessPerTitleOrdinaryCap(advice.goal, advice.proposal).status).toBe(
			"permitted",
		);
	});

	it("keeps a held minimum when it excludes every cap-ending chain", () => {
		const goal = {
			...ordinary(),
			minBitrateStepSize: 20,
			maxBitrateStepSize: 20,
		};
		const result = analyzePerTitleSettings(goal, "cap", {
			...capOptions(goal),
			protectedFields: [{ scope: "global", key: "minBitrateStepSize" }],
		});
		expect(result.advice).toEqual([]);
		expect(result.ordinaryCap).toMatchObject({ status: "blocked", count: 1 });
		expect(goal.minBitrateStepSize).toBe(20);
	});

	it("explains a held maximum step without overriding it", () => {
		const goal = ordinary();
		const result = analyzePerTitleSettings(goal, "cap", {
			...capOptions(goal),
			protectedFields: [{ scope: "global", key: "maxBitrateStepSize" }],
		});
		expect(result.advice).toEqual([]);
		expect(result.ordinaryCap.status).toBe("blocked");
		expect(result.findings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "ordinary-cap-spacing-blocked",
					fields: [{ scope: "global", key: "maxBitrateStepSize" }],
				}),
			]),
		);
		expect(goal.maxBitrateStepSize).toBe(2.1286666666666667);
	});

	it("does not certify cap use for at most one placement above the starting rate", () => {
		const goal = {
			...ordinary(),
			countPolicy: { kind: "maximum" as const, count: 1 },
		};
		const result = analyzePerTitleSettings(goal, "cap", capOptions(goal));
		expect(result.ordinaryCap).toMatchObject({
			status: "blocked",
			count: 1,
			lastSlot: { maximum: 300_000 },
		});
		expect(result.advice).toEqual([]);
		expect(
			result.findings.some(
				(finding) => finding.code === "ordinary-cap-spacing-blocked",
			),
		).toBe(true);
	});

	it("permits one placement when the global limits are equal", () => {
		const goal = {
			...ordinary(),
			maxBitrate: 300_000,
			countPolicy: { kind: "maximum" as const, count: 4 },
		};
		const proposal = tunePerTitleSettings(goal, goal).proposal;
		expect(assessPerTitleOrdinaryCap(goal, proposal)).toMatchObject({
			status: "permitted",
			count: 1,
			lastSlot: { minimum: 300_000, maximum: 300_000 },
		});
	});

	it("checks an integer cap above the 1.9 decimal boundary", () => {
		const goal: PerTitleGoal = {
			...ordinary(),
			minBitrate: 10_003,
			maxBitrate: 19_006,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "maximum", count: 2 },
		};
		const result = analyzePerTitleSettings(goal, "cap", capOptions(goal));
		expect(result.ordinaryCap).toMatchObject({
			status: "blocked",
			count: 2,
			lastSlot: { maximum: 19_005 },
		});
		expect(result.decision.status).toBe("proposal");
		const advice = result.advice[0];
		expect(advice).toBeDefined();
		if (!advice) return;
		expect(advice.proposal.api.global.maxBitrateStepSize).toBeGreaterThan(1.9);
		expect(advice.goal.countPolicy).toEqual(goal.countPolicy);
		expect(
			hasPerTitleEvaluationCountEvidence(advice.goal, advice.proposal),
		).toBe(true);
		expect(
			assessPerTitleOrdinaryCap(advice.goal, advice.proposal),
		).toMatchObject({
			status: "permitted",
			count: 2,
			lastSlot: { maximum: 19_006 },
		});
	});

	it.each([
		0, 257, 4.5,
	])("does not infer cap placement for unsupported count %s", (count) => {
		const goal = {
			...ordinary(),
			countPolicy: { kind: "maximum" as const, count },
		};
		const proposal = tunePerTitleSettings(goal, goal).proposal;
		expect(assessPerTitleOrdinaryCap(goal, proposal).status).toBe(
			"unavailable",
		);
	});
});

describe("ordinary cap without a count requirement", () => {
	function unrestricted(
		minimumStep = 1.5,
		maximumStep = 1.9,
		codec: PerTitleGoal["codec"] = "H264",
	): PerTitleGoal {
		return {
			...ordinary(codec),
			strategy: "automatic",
			countPolicy: { kind: "unrestricted" },
			minBitrateStepSize: minimumStep,
			maxBitrateStepSize: maximumStep,
		};
	}

	it.each(
		codecs,
	)("keeps %s default spacing when a cap-ending chain is already permitted", (codec) => {
		const goal = unrestricted(1.5, 1.9, codec);
		const proposal = tunePerTitleSettings(goal, goal).proposal;
		const result = analyzePerTitleSettings(goal, "cap", capOptions(goal));
		expect(result.ordinaryCap.status).toBe("permitted");
		expect(result.ordinaryCap.count).toBeGreaterThan(1);
		expect(result.decision.status).toBe("keep-current");
		expect(result.advice).toEqual([]);
		expect(hasPerTitleEvaluationCountEvidence(goal, proposal)).toBe(false);
		expect(
			previewPerTitleOutput(proposal, { countPolicy: goal.countPolicy })
				.countProjection,
		).toBeUndefined();
		expect(proposal.countGuarantee).toBe(false);
	});

	it.each(
		codecs,
	)("widens a narrow %s maximum without adding a count requirement", (codec) => {
		const goal = unrestricted(2, 2, codec);
		const result = analyzePerTitleSettings(goal, "cap", capOptions(goal));
		expect(result.ordinaryCap.status).toBe("blocked");
		expect(result.decision.status).toBe("proposal");
		const advice = result.advice[0];
		expect(advice).toBeDefined();
		if (!advice) return;
		expect(advice.goal.countPolicy).toEqual({ kind: "unrestricted" });
		expect(advice.goal.minBitrateStepSize).toBe(2);
		expect(advice.changes.map((change) => change.key)).toEqual([
			"maxBitrateStepSize",
		]);
		expect(assessPerTitleOrdinaryCap(advice.goal, advice.proposal).status).toBe(
			"permitted",
		);
		expect(
			hasPerTitleEvaluationCountEvidence(advice.goal, advice.proposal),
		).toBe(false);
		expect(advice.proposal.countGuarantee).toBe(false);
		const applied = applyPerTitleAdvice(goal, advice, capOptions(goal));
		expect(applied?.countPolicy).toEqual({ kind: "unrestricted" });
	});

	it("repairs only the editable minimum under a protected unrestricted maximum", () => {
		const goal = unrestricted(2, 2);
		const options = {
			...capOptions(goal),
			protectedFields: [
				{ scope: "global" as const, key: "maxBitrateStepSize" },
			],
		};
		const result = analyzePerTitleSettings(goal, "cap", options);
		expect(result.decision.status).toBe("proposal");
		const advice = result.advice[0];
		expect(advice).toBeDefined();
		if (!advice) return;
		expect(advice.goal.countPolicy).toEqual(goal.countPolicy);
		expect(advice.goal.maxBitrateStepSize).toBe(2);
		expect(advice.goal.minBitrateStepSize).toBeLessThan(2);
		expect(advice.changes.map((change) => change.key)).toEqual([
			"minBitrateStepSize",
		]);
		expect(assessPerTitleOrdinaryCap(advice.goal, advice.proposal).status).toBe(
			"permitted",
		);
		expect(
			hasPerTitleEvaluationCountEvidence(advice.goal, advice.proposal),
		).toBe(false);
		const applied = applyPerTitleAdvice(goal, advice, options);
		expect(applied?.maxBitrateStepSize).toBe(2);
		expect(applied?.countPolicy).toEqual({ kind: "unrestricted" });
	});

	it("retains protected narrow spacing", () => {
		const goal = unrestricted(2, 2);
		const result = analyzePerTitleSettings(goal, "cap", {
			...capOptions(goal),
			protectedFields: [
				{ scope: "global", key: "minBitrateStepSize" },
				{ scope: "global", key: "maxBitrateStepSize" },
			],
		});
		expect(result.ordinaryCap.status).toBe("blocked");
		expect(result.advice).toEqual([]);
		expect(goal).toMatchObject({
			minBitrateStepSize: 2,
			maxBitrateStepSize: 2,
			countPolicy: { kind: "unrestricted" },
		});
	});

	it("does not label an over-budget spacing model blocked", () => {
		const goal = unrestricted(1.0001, 1.0002);
		const proposal = tunePerTitleSettings(goal, goal).proposal;
		expect(assessPerTitleOrdinaryCap(goal, proposal)).toMatchObject({
			status: "unavailable",
			count: null,
			lastSlot: null,
		});
		expect(hasPerTitleEvaluationCountEvidence(goal, proposal)).toBe(false);
	});
});
