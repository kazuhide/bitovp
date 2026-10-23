import { type PerTitleGoal, previewPerTitleOutput } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	applyPerTitleAdvice,
	applySelectedPerTitleAdvice,
	createPerTitleEvaluationAdvice,
	hasPerTitleEvaluationCountEvidence,
	type PerTitleAdviceOptions,
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
	it.each([
		"cap",
		"bandwidth",
		"count",
		"preserve",
	] as const)("repairs an explicit six-output requirement in automatic mode for %s", (intent) => {
		const current: PerTitleGoal = {
			strategy: "automatic",
			codec: "VP9",
			minBitrate: 128_000,
			maxBitrate: 4_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "exact", count: 6 },
			autoRepresentations: {},
			rows: [],
			automaticTemplates: [{ id: "automatic-template" }],
		};
		const result = analyzePerTitleSettings(current, intent);
		expect(result.decision.status).toBe("proposal");
		expect(result.advice.length).toBeGreaterThan(0);
		for (const item of result.advice) {
			expect(item.proof).toBe("model-count");
			expect(hasPerTitleEvaluationCountEvidence(item.goal, item.proposal)).toBe(
				true,
			);
			expect(item.goal.strategy).toBe("automatic");
			expect(item.goal.countPolicy).toEqual(current.countPolicy);
			expect(item.goal.minBitrate).toBe(128_000);
			expect(item.goal.maxBitrate).toBe(4_000_000);
			expect(item.goal.rows).toEqual([]);
			expect(item.goal.autoRepresentations).toEqual({});
			expect(item.goal.automaticTemplates).toEqual(current.automaticTemplates);
			expect(assessPerTitleReach(item.goal, item.proposal).status).toBe(
				"unknown",
			);
			expect(item.explanation?.en).toContain("count");
			expect(
				applyPerTitleAdvice(current, item, {
					contextKey: perTitleAnalysisContextKey(intent),
				}),
			).not.toBeNull();
		}
	});
	it("offers an explicit complexity-selection repair for an optimized fixed cap", () => {
		const current: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 1_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "unrestricted" },
			autoRepresentations: false,
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
		const candidate: PerTitleGoal = {
			...current,
			rows: current.rows?.map((row) => ({
				...row,
				maxBitrate: current.maxBitrate,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 400_000,
				highComplexityBoundaryForMaxBitrate: current.maxBitrate,
			})),
		};
		const options = { contextKey: perTitleAnalysisContextKey("cap") };
		const explicit = createPerTitleEvaluationAdvice(
			current,
			candidate,
			options,
		);
		expect(explicit).not.toBeNull();
		if (!explicit) throw new Error("Expected a valid explicit repair.");
		expect(assessPerTitleReach(explicit.goal, explicit.proposal)).toMatchObject(
			{
				status: "conditional-reachable",
				adaptation: "conditional",
				low: { minimum: 200_000, maximum: 200_000 },
				high: { minimum: 1_000_000, maximum: 1_000_000 },
			},
		);
		const result = analyzePerTitleSettings(current, "cap");
		expect(
			result.advice.some((item) =>
				item.changes.some(
					(change) =>
						change.rowId === "fixed" &&
						change.key === "bitrateSelectionMode" &&
						change.after === "COMPLEXITY_RANGE",
				),
			),
		).toBe(true);
	});
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
			expect(item.goal.rows?.[0]?.minBitrate).toBe(goal.rows?.[0]?.minBitrate);
			expect(item.goal.rows?.[0]?.maxBitrate).toBe(goal.rows?.[0]?.maxBitrate);
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
	it("requires the entire explicit analysis interval before declaring a closed count checked", () => {
		const current: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 10000,
			maxBitrate: 10000000,
			minBitrateStepSize: 1.2,
			maxBitrateStepSize: 10,
			countPolicy: { kind: "exact", count: 2 },
			rows: [
				{
					id: "lower",
					height: 360,
					minBitrate: 100000,
					maxBitrate: 800000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 10000,
					highComplexityBoundaryForMaxBitrate: 1000000,
				},
				{
					id: "upper",
					height: 720,
					minBitrate: 1000000,
					maxBitrate: 2000000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 1000000,
					highComplexityBoundaryForMaxBitrate: 10000000,
				},
			],
		};
		expect(
			tunePerTitleSettings(current, current).proposal.derivation
				?.targetSatisfied,
		).toBe(true);
		const result = analyzePerTitleSettings(current, "count");
		expect(result.reach.count.status).toBe("unknown");
		expect(
			result.findings.some((finding) => finding.code === "count-model-checked"),
		).toBe(false);
		expect(result.advice.length).toBeGreaterThan(0);
		for (const item of result.advice) {
			expect(assessPerTitleReach(item.goal, item.proposal).count.status).toBe(
				"model-checked",
			);
			expect(item.proof).toBe("model-count");
		}
		const held = analyzePerTitleSettings(current, "count", {
			protectedFields: [
				{
					scope: "stream",
					rowId: "lower",
					key: "highComplexityBoundaryForMaxBitrate",
				},
			],
		});
		expect(held.advice).toEqual([]);
		expect(
			held.findings.some((finding) => finding.code === "count-model-checked"),
		).toBe(false);
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
		expect(
			result.advice.some((item) =>
				item.changes.every(
					(change) =>
						change.scope === "global" && change.key.endsWith("BitrateStepSize"),
				),
			),
		).toBe(true);
		for (const item of result.advice) {
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
			minBitrate: 10_000,
			maxBitrate: 22_601,
			automaticTemplates: undefined,
			rows: [
				{
					id: "upper",
					height: 720,
					minBitrate: 10_000,
					maxBitrate: 10_001,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 10_000,
					// Keep the curve above the forced floor so low and high inputs can differ.
					highComplexityBoundaryForMaxBitrate: 22_601,
				},
			],
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 2,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.5,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		};
		const saturated = structuredClone(current);
		if (saturated.rows?.[0])
			saturated.rows[0].highComplexityBoundaryForMaxBitrate = 20_000;
		const flat = analyzePerTitleSettings(saturated, "cap");
		expect(flat.reach.adaptation).toBe("flat");
		expect(flat.advice).toHaveLength(0);
		const result = analyzePerTitleSettings(current, "cap");
		expect(result.reach.high?.maximum).toBe(22_503);
		const powerEstimate = Math.sqrt(22_601 / 10_001);
		expect(Math.round(Math.round(10_001 * powerEstimate) * powerEstimate)).toBe(
			22_600,
		);
		const candidate = result.advice[0];
		expect(candidate).toBeDefined();
		if (!candidate) throw new Error("Expected integer-checked extra steps.");
		expect(
			candidate.goal.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBe(1.503299);
		expect(
			assessPerTitleReach(candidate.goal, candidate.proposal).high?.maximum,
		).toBe(22_601);
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
		expect(
			result.findings.find((finding) => finding.code === "count-required")
				?.fields,
		).toEqual([{ scope: "global", key: "countPolicy" }]);
		expect(result.advice).toEqual([]);
	});
	it("identifies the requested-count model limit and its input field", () => {
		const result = analyzePerTitleSettings(
			{ ...countGoal, countPolicy: { kind: "exact", count: 257 } },
			"cap",
		);
		expect(result.advice).toEqual([]);
		expect(result.decision.status).toBe("inspect-only");
		expect(
			result.findings.find((finding) => finding.code === "count-model-limit"),
		).toMatchObject({
			fields: [{ scope: "global", key: "countPolicy" }],
			message: { en: expect.stringContaining("not a provider limit") },
		});
	});
	it("identifies held fields only when releasing them permits a checked alternative", () => {
		const fields = [
			{ scope: "global" as const, key: "minBitrateStepSize" },
			{ scope: "global" as const, key: "maxBitrateStepSize" },
		];
		const result = analyzePerTitleSettings(countGoal, "cap", {
			protectedFields: fields,
		});
		expect(result.advice).toEqual([]);
		expect(result.relaxation?.certifiedAlternatives).toBeGreaterThan(0);
		expect(result.relaxation?.fields.length).toBeGreaterThan(0);
		expect(
			result.relaxation?.fields.every((field) =>
				fields.some(
					(held) => held.scope === field.scope && held.key === field.key,
				),
			),
		).toBe(true);
		const released = new Set(
			result.relaxation?.fields.map((field) => field.key),
		);
		expect(
			analyzePerTitleSettings(countGoal, "cap", {
				protectedFields: fields.filter((field) => !released.has(field.key)),
			}).advice.length,
		).toBeGreaterThan(0);
		const unrelated = analyzePerTitleSettings(
			{ ...countGoal, countPolicy: { kind: "unrestricted" } },
			"cap",
			{ protectedFields: [{ scope: "global", key: "targetQualityCrf" }] },
		);
		expect(unrelated.advice).toEqual([]);
		expect(unrelated.relaxation).toBeUndefined();
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
	it("evaluates automatic inputs while retaining unchanged automatic policies", () => {
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
		expect(result.advice.length).toBeGreaterThan(0);
		for (const item of result.advice) {
			if (!item.changes.some((change) => change.key === "minBitrateStepSize"))
				expect(item.goal.adjustments?.global?.minBitrateStepSize).toEqual(
					current.adjustments?.global?.minBitrateStepSize,
				);
		}
		expect(
			result.findings.some((finding) => finding.code === "automatic-settings"),
		).toBe(true);
	});
});

describe("evaluation advice certification", () => {
	it("shows changed automatic policies and certifies adoption against the loaded reference", () => {
		const reference: PerTitleGoal = {
			...goal,
			maxBitrateStepSize: 1.9,
			rows: goal.rows?.map((row) =>
				row.id === "upper" ? { ...row, maxBitrate: 2_400_000 } : row,
			),
		};
		const current = tunePerTitleSettings(
			{
				...reference,
				adjustments: {
					global: {
						maxBitrateStepSize: { mode: "auto", method: "default" },
					},
					streams: {
						lower: {
							minBitrate: { mode: "auto", method: "proportional" },
							maxBitrate: { mode: "auto", method: "logarithmic" },
						},
					},
				},
			},
			reference,
		).goal;
		const options: PerTitleAdviceOptions = {
			referenceGoal: reference,
			contextKey: perTitleAnalysisContextKey("cap"),
		};
		const result = analyzePerTitleSettings(current, "cap", options);
		const item = result.advice.find((advice) =>
			advice.changes.some((change) => change.key === "maxBitrateStepSize"),
		);
		expect(item).toBeDefined();
		if (!item) throw new Error("Expected an explicit automatic-policy change.");
		expect(
			item.changes.find((change) => change.key === "maxBitrateStepSize"),
		).toMatchObject({
			beforeAdjustment: { mode: "auto", method: "default" },
			afterAdjustment: { mode: "fixed" },
		});
		const applied = applyPerTitleAdvice(current, item, options);
		expect(applied).not.toBeNull();
		if (!applied) throw new Error("Expected reference-bound adoption.");
		expect(tunePerTitleSettings(applied, reference).proposal.api).toEqual(
			item.proposal.api,
		);
		expect(applied.adjustments?.streams).toEqual(current.adjustments?.streams);
		const selected = applySelectedPerTitleAdvice(
			current,
			item,
			[{ scope: "global", key: "maxBitrateStepSize" }],
			options,
		);
		expect(selected).not.toBeNull();
		expect(selected?.adjustments?.streams).toEqual(
			current.adjustments?.streams,
		);
		expect(selected?.adjustments?.global?.maxBitrateStepSize).toEqual({
			mode: "fixed",
		});
		const hiddenPolicy = structuredClone(item);
		for (const change of hiddenPolicy.changes) {
			delete change.beforeAdjustment;
			delete change.afterAdjustment;
		}
		expect(applyPerTitleAdvice(current, hiddenPolicy, options)).toBeNull();
		const stale = {
			...options,
			referenceGoal: { ...reference, maxBitrate: 7_000_000 },
		};
		expect(applyPerTitleAdvice(current, item, stale)).toBeNull();
		expect(
			applySelectedPerTitleAdvice(current, item, item.changes, stale),
		).toBeNull();
	});
	it("rejects a candidate when a held automatic value moves through a dependency", () => {
		const reference: PerTitleGoal = {
			...countGoal,
			strategy: "automatic",
			countPolicy: { kind: "unrestricted" },
		};
		const current: PerTitleGoal = {
			...reference,
			adjustments: {
				global: { minBitrate: { mode: "auto", method: "proportional" } },
			},
		};
		expect(
			createPerTitleEvaluationAdvice(
				current,
				{ ...current, maxBitrate: 4_000_000 },
				{ referenceGoal: reference },
			),
		).not.toBeNull();
		expect(
			createPerTitleEvaluationAdvice(
				current,
				{ ...current, maxBitrate: 4_000_000 },
				{
					referenceGoal: reference,
					protectedFields: [{ scope: "global", key: "minBitrate" }],
				},
			),
		).toBeNull();
	});
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
