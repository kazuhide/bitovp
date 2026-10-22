import { type PerTitleGoal, previewPerTitleOutput } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	applyPerTitleAdvice,
	applySelectedPerTitleAdvice,
	createPerTitleEvaluationAdvice,
} from "./per-title-simulator-advice";
import {
	analyzePerTitleSettings,
	perTitleAnalysisContextKey,
} from "./per-title-simulator-analysis";
import { assessPerTitleReach } from "./per-title-simulator-analysis-reach";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const goal: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 6_000_000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 4,
	countPolicy: { kind: "unrestricted" },
	autoRepresentations: false,
	targetQualityCrf: 18,
	resolutionScaleFactor: 0,
	complexityFactor: 1,
	fixedResolutionAndBitrateConfiguration: {
		forcedRenditionAboveHighestFixedRepresentation: 1,
		forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
		forcedRenditionAboveHighestFixedRepresentationCalculationMode:
			"LAST_CALCULATED_BITRATE",
	},
	rows: [
		{
			id: "lower",
			height: 360,
			minBitrate: 300_000,
			maxBitrate: 500_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 1_500_000,
			highComplexityBoundaryForMaxBitrate: 4_000_000,
		},
		{
			id: "upper",
			height: 720,
			minBitrate: 1_000_000,
			maxBitrate: 4_800_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 1_500_000,
			highComplexityBoundaryForMaxBitrate: 4_000_000,
		},
	],
	automaticTemplates: [{ id: "top", height: 1080 }],
};
const countGoal: PerTitleGoal = {
	strategy: "count",
	codec: "VP9",
	minBitrate: 100_000,
	maxBitrate: 8_000_000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 1.9,
	countPolicy: { kind: "exact", count: 3 },
};

describe("current Per-Title evaluation", () => {
	it("evaluates unchanged settings and repairs cap reach without a fabricated edit", () => {
		const snapshot = structuredClone(goal);
		const result = analyzePerTitleSettings(goal, "cap", {
			protectedFields: [
				{ scope: "stream", rowId: "lower", key: "minBitrate" },
				{ scope: "stream", rowId: "lower", key: "maxBitrate" },
			],
		});
		expect(result.reach.status).toBe("blocked");
		expect(result.advice.length).toBeGreaterThan(0);
		for (const item of result.advice) {
			const reach = assessPerTitleReach(item.goal, item.proposal);
			expect(reach.status).toBe("conditional-reachable");
			expect(reach.high?.maximum).toBe(6_000_000);
			expect(reach.low?.maximum).toBeLessThan(6_000_000);
			expect(item.goal.rows?.[0]).toEqual(goal.rows?.[0]);
			expect(item.goal.automaticTemplates).toEqual(goal.automaticTemplates);
			expect(item.goal.targetQualityCrf).toBe(18);
			expect(item.goal.complexityFactor).toBe(1);
			expect(item.goal.resolutionScaleFactor).toBe(0);
			expect(item.goal.countPolicy).toEqual(goal.countPolicy);
			expect(item.proof).toBe("conditional-settings");
		}
		expect(result.quality.status).toBe("requires-media");
		expect(result.dependencies.length).toBeGreaterThan(20);
		expect(goal).toEqual(snapshot);
	});
	it("derives count settings from the current count requirement alone", () => {
		const result = analyzePerTitleSettings(countGoal, "count");
		expect(result.advice).not.toHaveLength(0);
		const item = result.advice[0];
		expect(item?.proof).toBe("model-count");
		expect(item?.goal.countPolicy).toEqual({ kind: "exact", count: 3 });
		expect(item?.goal.minBitrate).toBe(100_000);
		expect(item?.goal.maxBitrate).toBe(8_000_000);
		expect(
			item?.changes.every((change) => change.key.endsWith("BitrateStepSize")),
		).toBe(true);
		expect(item?.proposal.api.global.targetQualityCrf).toBeUndefined();
	});
	it.each([
		{ upper: 2_400_000, minimumStep: 1.5, maximumStep: 2 },
		{ upper: 4_800_000, minimumStep: 1.5, maximumStep: 4 },
	])("repairs wide and narrow top gaps using a checked dependency change ($upper)", ({
		upper,
		minimumStep,
		maximumStep,
	}) => {
		const current: PerTitleGoal = {
			...goal,
			minBitrateStepSize: minimumStep,
			maxBitrateStepSize: maximumStep,
			fixedResolutionAndBitrateConfiguration: undefined,
			rows: goal.rows?.map((row) =>
				row.id === "upper" ? { ...row, maxBitrate: upper } : row,
			),
		};
		const result = analyzePerTitleSettings(current, "cap");
		expect(result.reach.status).toBe("blocked");
		expect(result.advice.length).toBeGreaterThan(0);
		for (const item of result.advice) {
			expect(
				item.changes.every(
					(change) =>
						change.scope === "global" && change.key.endsWith("BitrateStepSize"),
				),
			).toBe(true);
			const evaluated = assessPerTitleReach(item.goal, item.proposal);
			expect(evaluated.certainty).toBe("all-permitted-rates");
			expect(evaluated.high).toEqual({
				minimum: 6_000_000,
				maximum: 6_000_000,
			});
			expect(item.explanation?.en).toContain("6,000");
		}
	});
	it("prefers a readable integer-checked forced factor over long decimal duplicates", () => {
		const result = analyzePerTitleSettings(goal, "cap");
		const forced = result.advice.filter((item) =>
			item.changes.some((change) =>
				change.key.endsWith("RepresentationFactor"),
			),
		);
		expect(forced).toHaveLength(1);
		expect(
			forced[0]?.goal.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBe(1.25);
		expect(result.advice[0]).toEqual(forced[0]);
		const proposal = forced[0]?.proposal;
		if (!proposal) throw new Error("Expected a forced-rendition proposal.");
		expect(
			Math.max(
				...previewPerTitleOutput(proposal).rows.map((row) => row.bitrate ?? 0),
			),
		).toBe(6_000_000);
		expect(
			Math.max(
				...previewPerTitleOutput(proposal, {
					analysisInput: goal.minBitrate,
				}).rows.map((row) => row.bitrate ?? 0),
			),
		).toBeLessThan(6_000_000);
	});
	it("solves repeated rounded forced steps rather than using an unrounded power", () => {
		const current: PerTitleGoal = {
			...goal,
			minBitrate: 1,
			maxBitrate: 226,
			automaticTemplates: undefined,
			rows: [
				{
					id: "upper",
					height: 720,
					minBitrate: 20,
					maxBitrate: 100,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 50,
					highComplexityBoundaryForMaxBitrate: 200,
				},
			],
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 2,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.5,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		};
		const result = analyzePerTitleSettings(current, "cap");
		expect(result.reach.high?.maximum).toBe(225);
		const candidate = result.advice[0];
		expect(candidate).toBeDefined();
		if (!candidate) throw new Error("Expected integer-checked extra steps.");
		expect(
			candidate.goal.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBe(1.504);
		expect(
			assessPerTitleReach(candidate.goal, candidate.proposal).high?.maximum,
		).toBe(226);
	});
	it("preserves the current count policy and never offers a quality-control shortcut for cap reach", () => {
		const current: PerTitleGoal = {
			...goal,
			countPolicy: { kind: "maximum", count: 6 },
		};
		const result = analyzePerTitleSettings(current, "cap");
		expect(result.advice.length).toBeGreaterThan(0);
		for (const item of result.advice) {
			expect(item.goal.countPolicy).toEqual(current.countPolicy);
			expect(
				item.changes.every(
					(change) =>
						![
							"targetQualityCrf",
							"complexityFactor",
							"resolutionScaleFactor",
							"codecMaxBitrateFactor",
							"codecBufsizeFactor",
						].includes(change.key),
				),
			).toBe(true);
			expect(item.proof).toBe("conditional-settings");
		}
	});
	it("asks for an explicit count requirement rather than inventing one", () => {
		const result = analyzePerTitleSettings(goal, "count");
		expect(
			result.findings.some((finding) => finding.code === "count-required"),
		).toBe(true);
		expect(result.advice).toEqual([]);
	});
	it("does not assert a quality optimum or savings without media evidence", () => {
		const result = analyzePerTitleSettings(goal, "bandwidth");
		expect(result.quality.status).toBe("requires-media");
		expect(result.quality.checks.length).toBeGreaterThanOrEqual(3);
		expect(
			result.findings.some(
				(finding) => finding.code === "quality-measurement-required",
			),
		).toBe(true);
		expect(
			result.advice.every((item) =>
				item.changes.every(
					(change) =>
						![
							"targetQualityCrf",
							"targetQualityQp",
							"complexityFactor",
							"resolutionScaleFactor",
							"minBitrate",
							"maxBitrate",
						].includes(change.key),
				),
			),
		).toBe(true);
	});
	it("keeps hard pins and reports a bounded search outcome rather than impossibility", () => {
		const result = analyzePerTitleSettings(goal, "cap", {
			protectedFields: [
				...[
					"minBitrateStepSize",
					"maxBitrateStepSize",
					"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationFactor",
				].map((key) => ({ scope: "global" as const, key })),
				...[
					"minBitrate",
					"maxBitrate",
					"lowComplexityBoundaryForMaxBitrate",
					"highComplexityBoundaryForMaxBitrate",
				].map((key) => ({ scope: "stream" as const, rowId: "upper", key })),
			],
		});
		expect(result.advice).toEqual([]);
		expect(
			result.findings.some(
				(finding) => finding.code === "no-checked-candidate",
			),
		).toBe(true);
	});
	it("never promotes unknown mixed native count into a count guarantee", () => {
		const current: PerTitleGoal = {
			...goal,
			countPolicy: { kind: "exact", count: 4 },
		};
		const result = analyzePerTitleSettings(current, "count");
		expect(result.reach.count.status).not.toBe("model-checked");
		expect(result.advice.every((item) => item.proof !== "model-count")).toBe(
			true,
		);
	});
	it("keeps automatic inputs assessable but does not silently adopt their settings", () => {
		const current: PerTitleGoal = {
			...goal,
			adjustments: {
				global: {
					minBitrateStepSize: { mode: "auto", method: "constraints" },
				},
			},
		};
		const result = analyzePerTitleSettings(current, "cap");
		expect(result.dependencies.length).toBeGreaterThan(0);
		expect(result.advice).toEqual([]);
		expect(
			result.findings.some((finding) => finding.code === "automatic-settings"),
		).toBe(true);
	});
});

describe("evaluation advice certification", () => {
	it("binds both full and selected adoption to the evaluated objective", () => {
		const options = { contextKey: perTitleAnalysisContextKey("cap") };
		const item = createPerTitleEvaluationAdvice(
			goal,
			{ ...goal, minBitrateStepSize: 1.25 },
			options,
		);
		expect(item).not.toBeNull();
		if (!item) throw new Error("Expected current-input advice.");
		expect(applyPerTitleAdvice(goal, item, options)?.minBitrateStepSize).toBe(
			1.25,
		);
		const stale = { contextKey: perTitleAnalysisContextKey("bandwidth") };
		expect(applyPerTitleAdvice(goal, item, stale)).toBeNull();
		expect(
			applySelectedPerTitleAdvice(goal, item, item.changes, stale),
		).toBeNull();
		expect(
			applyPerTitleAdvice({ ...goal, maxBitrate: 7_000_000 }, item, options),
		).toBeNull();
	});
	it("rejects pinned changes and hidden template mutations", () => {
		const candidate = { ...goal, minBitrateStepSize: 1.25 };
		expect(
			createPerTitleEvaluationAdvice(goal, candidate, {
				protectedFields: [{ scope: "global", key: "minBitrateStepSize" }],
			}),
		).toBeNull();
		expect(
			createPerTitleEvaluationAdvice(goal, {
				...candidate,
				automaticTemplates: [{ id: "top", height: 2160 }],
			}),
		).toBeNull();
	});
	it("does not carry candidate-only count or quality metadata into the current draft", () => {
		const candidate: PerTitleGoal = {
			...goal,
			minBitrateStepSize: 1.25,
			countPolicy: { kind: "maximum", count: 10 },
		};
		const item = createPerTitleEvaluationAdvice(goal, candidate);
		if (item) {
			expect(item.goal.countPolicy).toEqual(goal.countPolicy);
			expect(item.proposal.api).toEqual(
				tunePerTitleSettings(item.goal, item.goal).proposal.api,
			);
		}
	});
});
