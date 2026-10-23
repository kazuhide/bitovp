import type { PerTitleGoal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { applyPerTitleAdvice } from "./per-title-simulator-advice";
import { analyzePerTitleSettings } from "./per-title-simulator-analysis";
import {
	assessPerTitleLadder,
	perTitlePlacementCapacity,
} from "./per-title-simulator-analysis-ladder";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const mixed = (maximum = 4_800_000): PerTitleGoal => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 120_000,
	maxBitrate: maximum,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 5,
	countPolicy: { kind: "unrestricted" },
	targetQualityCrf: 19,
	complexityFactor: 1,
	resolutionScaleFactor: 0,
	autoRepresentations: false,
	fixedResolutionAndBitrateConfiguration: {
		forcedRenditionAboveHighestFixedRepresentation: 1,
		forcedRenditionAboveHighestFixedRepresentationFactor: 1.25,
		forcedRenditionAboveHighestFixedRepresentationCalculationMode:
			"LAST_CALCULATED_BITRATE",
	},
	rows: [
		{ id: "first", height: 400, minBitrate: 240_000, maxBitrate: 440_000 },
		{ id: "second", height: 400, minBitrate: 520_000, maxBitrate: 800_000 },
		{ id: "middle", height: 600, minBitrate: 900_000, maxBitrate: 1_250_000 },
		{
			id: "highest",
			height: 800,
			minBitrate: 1_600_000,
			maxBitrate: 2_200_000,
		},
	].map((row) => ({
		...row,
		bitrateSelectionMode: "COMPLEXITY_RANGE",
		lowComplexityBoundaryForMaxBitrate: 2_000_000,
		highComplexityBoundaryForMaxBitrate: 4_800_000,
	})),
	automaticTemplates: [
		{ id: "bottom-auto", height: 200 },
		{ id: "top-auto-a", height: 1000 },
		{ id: "top-auto-b", height: 1200 },
	],
});
const assess = (goal: PerTitleGoal) =>
	assessPerTitleLadder(goal, tunePerTitleSettings(goal, goal).proposal);

const fixedCurve = (): PerTitleGoal => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 1_000_000,
	minBitrateStepSize: 1.2,
	maxBitrateStepSize: 4,
	countPolicy: { kind: "unrestricted" },
	rows: [
		{
			id: "fixed",
			height: 360,
			width: 640,
			minBitrate: 200_000,
			maxBitrate: 400_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 100_000,
			highComplexityBoundaryForMaxBitrate: 2_000_000,
		},
	],
	automaticTemplates: [
		{ id: "lower", height: 180, width: 320 },
		{ id: "upper", height: 720, width: 1280 },
	],
});

describe("whole-ladder current-setting analysis", () => {
	it("lifts row endpoints by the analysis floor while keeping raw placement limits", () => {
		const result = assess(fixedCurve());
		// V=100000 is lifted to C=200000. The target is
		// 200000+floor((200000-100000)*200000/1900000)=210526.
		expect(result.rows.find((row) => row.rowId === "fixed")).toMatchObject({
			low: { minimum: 210_526, maximum: 210_526 },
			high: { minimum: 294_736, maximum: 294_736 },
		});
		expect(result.input).toEqual({ minimum: 100_000, maximum: 1_000_000 });
		expect(result.globalCapacity).toBe(13);
	});
	it("uses the lifted analysis floor domain for interior lower-side bounds", () => {
		const goal = fixedCurve();
		goal.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 1,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.25,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"LAST_CALCULATED_BITRATE",
		};
		const result = assess(goal);
		// F=250000 and C cannot fall below it. At F, q=208333 and t=215789;
		// the unreachable raw-input interval used to include the 200000 minimum.
		expect(result.rows.find((row) => row.rowId === "fixed")?.low).toEqual({
			minimum: 208_333,
			maximum: 215_789,
		});
		expect(result.lowerSlots).toEqual({ minimum: 4, maximum: 5 });
	});
	it("keeps a floor above the global cap in the analysis interval certificate", () => {
		const goal = fixedCurve();
		goal.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 1,
			forcedRenditionAboveHighestFixedRepresentationFactor: 10,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"LAST_CALCULATED_BITRATE",
		};
		const result = assess(goal);
		// F=2000000 exceeds U=1000000, so every permitted V maps to the
		// high clamp C=2000000. The raw global interval remains unchanged.
		expect(result.rows.find((row) => row.rowId === "fixed")).toMatchObject({
			low: { minimum: 400_000, maximum: 400_000 },
			high: { minimum: 400_000, maximum: 400_000 },
		});
		expect(result.intervals?.maximumWithinRowRatio).toBe(1);
		expect(result.input).toEqual({ minimum: 100_000, maximum: 1_000_000 });
		expect(result.topResponse.status).toBe("unknown");
	});
	it.each([
		[10, 2_000_000, "LAST_CALCULATED_BITRATE"],
		[5, 1_000_000, "MINIMUM"],
	] as const)("reports saturation when F equals H, including F above U (%s)", (factor, high, mode) => {
		const goal = fixedCurve();
		if (goal.rows?.[0]) goal.rows[0].highComplexityBoundaryForMaxBitrate = high;
		goal.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 1,
			forcedRenditionAboveHighestFixedRepresentationFactor: factor,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode: mode,
		};
		const result = assess(goal);
		expect(result.rows.find((row) => row.rowId === "fixed")).toMatchObject({
			low: { minimum: 400_000, maximum: 400_000 },
			high: { minimum: 400_000, maximum: 400_000 },
		});
		expect(result.earlySaturationRows).toContain("fixed");
	});
	it("withholds curve bounds when the analysis floor ordering is unresolved", () => {
		const goal = fixedCurve();
		const first = goal.rows?.[0];
		if (!first) throw new Error("Expected the fixed row.");
		goal.rows = [
			...(goal.rows ?? []),
			{ ...first, id: "same-width", minBitrate: 250_000 },
		];
		const result = assess(goal);
		expect(
			result.rows
				.filter(
					(row) =>
						row.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				)
				.every((row) => row.low === null && row.high === null),
		).toBe(true);
		expect(result.intervals).toBeNull();
		expect(result.lowerSlots).toBeNull();
		expect(result.globalCapacity).toBe(13);
	});
	it("uses the truncated analysis floor for a raw-input connection domain", () => {
		const goal = fixedCurve();
		goal.minBitrate = 10_000;
		goal.maxBitrate = 50_000;
		goal.minBitrateStepSize = 1.5;
		goal.rows = goal.rows?.map((row) => ({
			...row,
			minBitrate: 10_001,
			maxBitrate: 20_000,
			lowComplexityBoundaryForMaxBitrate: 20_000,
			highComplexityBoundaryForMaxBitrate: 40_000,
		}));
		goal.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 1,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.5,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"LAST_CALCULATED_BITRATE",
		};
		const result = assess(goal);
		// F=trunc(10001*1.5)=15001, not the separately rounded addition 15002.
		expect(result.topResponse.floor).toBe(15_001);
		expect(result.topResponse.domain).toEqual({
			minimum: 15_001,
			maximum: 50_000,
		});
		expect(result.topResponse.status).not.toBe("tracked");
	});
	it("includes interior q-activation in the lower-side placement range", () => {
		const goal: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100,
			maxBitrate: 4000,
			minBitrateStepSize: 2,
			maxBitrateStepSize: 100,
			countPolicy: { kind: "unrestricted" },
			rows: [
				{
					id: "fixed",
					height: 400,
					minBitrate: 100,
					maxBitrate: 2000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 1,
					highComplexityBoundaryForMaxBitrate: 1000,
				},
			],
			automaticTemplates: [
				{ id: "bottom", height: 200 },
				{ id: "top", height: 800 },
			],
		};
		expect(assess(goal).lowerSlots).toEqual({ minimum: 0, maximum: 4 });
	});
	it.each([
		"missing",
		"reversed",
	] as const)("does not present conditional targets for %s complexity boundaries", (type) => {
		const goal = mixed();
		goal.rows = goal.rows?.map((row) => ({
			...row,
			lowComplexityBoundaryForMaxBitrate:
				type === "missing" ? undefined : 5_000_000,
		}));
		for (const row of assess(goal).rows.filter(
			(row) => row.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		)) {
			expect(row.configured).not.toBeNull();
			expect(row.low).toBeNull();
			expect(row.high).toBeNull();
		}
	});
	it.each([
		4_800_000, 7_200_000,
	])("proposes a checked interior improvement even when the top already reaches %i", (maximum) => {
		const goal = mixed(maximum);
		const original = structuredClone(goal);
		const result = analyzePerTitleSettings(goal, "cap");
		expect(result.reach.status).toBe("conditional-reachable");
		expect(result.decision.status).toBe("proposal");
		expect(result.advice.length).toBeGreaterThan(0);
		const candidate = result.advice[0];
		if (!candidate)
			throw new Error("Expected an interior dependency adjustment");
		const checked = assess(candidate.goal);
		expect(checked.topResponse.status).toBe("tracked");
		expect(checked.topResponse.domain?.maximum).toBe(maximum);
		expect(
			candidate.changes.some(
				(change) => change.key === "maxBitrate" && change.scope === "stream",
			),
		).toBe(true);
		expect(candidate.goal.minBitrate).toBe(goal.minBitrate);
		expect(candidate.goal.maxBitrate).toBe(goal.maxBitrate);
		expect(candidate.goal.countPolicy).toEqual(goal.countPolicy);
		expect(candidate.goal.automaticTemplates).toEqual(goal.automaticTemplates);
		expect(candidate.goal.targetQualityCrf).toBe(goal.targetQualityCrf);
		expect(candidate.goal.complexityFactor).toBe(goal.complexityFactor);
		expect(candidate.goal.resolutionScaleFactor).toBe(
			goal.resolutionScaleFactor,
		);
		expect(candidate.proof).toBe("conditional-settings");
		expect(candidate.explanation?.en).toContain("whole");
		expect(goal).toEqual(original);
	});
	it("retains individually pinned bands while recalculating other coupled values", () => {
		const goal = mixed(7_200_000);
		const result = analyzePerTitleSettings(goal, "cap", {
			protectedFields: [
				{ scope: "stream", rowId: "first", key: "minBitrate" },
				{ scope: "stream", rowId: "first", key: "maxBitrate" },
			],
		});
		expect(result.advice.length).toBeGreaterThan(0);
		for (const candidate of result.advice) {
			expect(candidate.goal.rows?.[0]?.minBitrate).toBe(240_000);
			expect(candidate.goal.rows?.[0]?.maxBitrate).toBe(440_000);
		}
	});
	it("audits every template, including automatic and repeated-resolution rows", () => {
		const goal = mixed(7_200_000);
		const result = assess(goal);
		expect(result.rows.map((row) => row.rowId).sort()).toEqual(
			[...(goal.rows ?? []), ...(goal.automaticTemplates ?? [])]
				.map((row) => row.id)
				.sort(),
		);
		expect(result.topResponse.status).toBe("gap");
		expect(result.upperSlots?.maximum).toBeGreaterThan(1);
		expect(result.earlySaturationRows).toHaveLength(4);
	});
	it.each([
		4_800_000, 7_200_000,
	])("evaluates a declared six-output mixed ladder at %i without claiming native count proof", (maximum) => {
		const goal = {
			...mixed(maximum),
			countPolicy: { kind: "exact", count: 6 } as const,
		};
		const result = analyzePerTitleSettings(goal, "preserve");
		expect(result.search.generated).toBeGreaterThan(0);
		expect(result.decision.status).toBe("proposal");
		expect(result.advice.length).toBeGreaterThan(0);
		expect(result.reach.count.status).toBe("unknown");
		for (const item of result.advice) {
			expect(item.proof).toBe("conditional-settings");
			expect(item.goal.countPolicy).toEqual({ kind: "exact", count: 6 });
			expect(item.goal.minBitrate).toBe(goal.minBitrate);
			expect(item.goal.maxBitrate).toBe(goal.maxBitrate);
			expect(item.goal.automaticTemplates).toEqual(goal.automaticTemplates);
			expect(item.facts.preservedCount).toBe(0);
			expect(item.facts.requiredCount).toBe(6);
			expect(item.explanation?.en).toContain("required 6");
			expect(item.explanation?.en).not.toContain("checked count of 6");
			expect(
				applyPerTitleAdvice(goal, item, { contextKey: "analysis:preserve" })
					?.countPolicy,
			).toEqual(goal.countPolicy);
			expect(
				applyPerTitleAdvice(
					{ ...goal, countPolicy: { kind: "exact", count: 7 } },
					item,
					{ contextKey: "analysis:preserve" },
				),
			).toBeNull();
		}
		expect(
			result.findings.some(
				(finding) => finding.code === "declared-count-structure",
			),
		).toBe(true);
	});
	it("does not relabel a six-role mixed structure as a verified seven-output proposal", () => {
		const goal = {
			...mixed(7_200_000),
			countPolicy: { kind: "exact", count: 7 } as const,
		};
		const result = analyzePerTitleSettings(goal, "preserve");
		expect(result.search.generated).toBeGreaterThan(0);
		expect(result.countStructure.status).not.toBe("declared-compatible");
		expect(result.reach.count.status).toBe("unknown");
		expect(result.advice).toEqual([]);
		expect(result.decision.status).toBe("no-certified-candidate");
	});
	it("retains a whole-domain top connection when an upper boundary is held", () => {
		const goal: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 16_000,
			maxBitrate: 2_304_000,
			minBitrateStepSize: 2,
			maxBitrateStepSize: 10,
			countPolicy: { kind: "exact", count: 6 },
			autoRepresentations: false,
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 2,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
			rows: [32_000, 72_000, 164_000, 384_000].map((minimum, index) => ({
				id: `fixed-${index}`,
				height: 200 * (index + 1),
				minBitrate: minimum,
				maxBitrate: minimum * 2,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 768_000,
				highComplexityBoundaryForMaxBitrate: 1_536_000,
			})),
			automaticTemplates: [
				{ id: "lower", height: 100 },
				{ id: "upper-a", height: 1000 },
				{ id: "upper-b", height: 1200 },
			],
		};
		const result = analyzePerTitleSettings(goal, "preserve", {
			protectedFields: [
				{
					scope: "stream",
					rowId: "fixed-3",
					key: "highComplexityBoundaryForMaxBitrate",
				},
			],
		});
		expect(result.ladder.topResponse.status).toBe("tracked");
		for (const item of result.advice)
			expect(assess(item.goal).topResponse.status).toBe("tracked");
		expect(result.search.rejected["top-tracking-regression"]).toBeGreaterThan(
			0,
		);
	});
	it("keeps the global limits and a checked count while optimizing a closed ladder", () => {
		const goal: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 6_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 10,
			countPolicy: { kind: "exact", count: 2 },
			rows: [
				{ id: "low", height: 400, minBitrate: 300_000, maxBitrate: 500_000 },
				{
					id: "high",
					height: 800,
					minBitrate: 1_000_000,
					maxBitrate: 2_400_000,
				},
			].map((row) => ({
				...row,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 1_500_000,
				highComplexityBoundaryForMaxBitrate: 2_500_000,
			})),
		};
		const result = analyzePerTitleSettings(goal, "preserve");
		expect(result.advice.length).toBeGreaterThan(0);
		for (const candidate of result.advice) {
			expect(candidate.goal.minBitrate).toBe(goal.minBitrate);
			expect(candidate.goal.maxBitrate).toBe(goal.maxBitrate);
			expect(candidate.goal.countPolicy).toEqual(goal.countPolicy);
			expect(candidate.proof).toBe("model-count");
		}
	});
	it("does not mistake an already valid count for a reason to change parameters", () => {
		const goal: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 6_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 10,
			countPolicy: { kind: "exact", count: 2 },
			rows: [
				{ id: "low", height: 400, minBitrate: 300_000, maxBitrate: 500_000 },
				{
					id: "high",
					height: 800,
					minBitrate: 1_000_000,
					maxBitrate: 2_400_000,
				},
			].map((row) => ({
				...row,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 1_500_000,
				highComplexityBoundaryForMaxBitrate: 6_000_000,
			})),
		};
		const result = analyzePerTitleSettings(goal, "preserve");
		expect(result.advice).toEqual([]);
		expect(result.decision.status).toBe("keep-current");
		expect(result.decision.message.en).toContain("does not establish");
	});
	it("requires a checked existing count rather than treating a count requirement as evidence", () => {
		const goal: PerTitleGoal = {
			strategy: "count",
			codec: "VP9",
			minBitrate: 160_000,
			maxBitrate: 5_120_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "exact", count: 3 },
		};
		const result = analyzePerTitleSettings(goal, "preserve");
		expect(result.advice).toEqual([]);
		expect(result.decision.status).toBe("inspect-only");
		expect(
			analyzePerTitleSettings(goal, "count").advice.length,
		).toBeGreaterThan(0);
	});
	it("reports an explicit search outcome when all coupled settings are held", () => {
		const goal = mixed(7_200_000);
		const result = analyzePerTitleSettings(goal, "cap", {
			protectedFields: [
				...[
					"minBitrateStepSize",
					"maxBitrateStepSize",
					"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationFactor",
					"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationCalculationMode",
				].map((key) => ({ scope: "global" as const, key })),
				...(goal.rows ?? []).flatMap((row) =>
					[
						"minBitrate",
						"maxBitrate",
						"lowComplexityBoundaryForMaxBitrate",
						"highComplexityBoundaryForMaxBitrate",
					].map((key) => ({ scope: "stream" as const, key, rowId: row.id })),
				),
			],
		});
		expect(result.advice).toEqual([]);
		expect(result.decision.status).toBe("no-certified-candidate");
		expect(result.search.generated).toBeGreaterThan(0);
		expect(
			Object.values(result.search.rejected).reduce((a, b) => a + b, 0),
		).toBeGreaterThan(0);
	});
	it("offers another coupled layout when minimum spacing and the forced factor are held", () => {
		const goal = mixed(7_200_000);
		const result = analyzePerTitleSettings(goal, "cap", {
			protectedFields: [
				{ scope: "global", key: "minBitrateStepSize" },
				{
					scope: "global",
					key: "fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationFactor",
				},
				{ scope: "stream", rowId: "first", key: "minBitrate" },
				{ scope: "stream", rowId: "first", key: "maxBitrate" },
			],
		});
		expect(result.advice.length).toBeGreaterThan(0);
		for (const item of result.advice) {
			expect(item.goal.minBitrateStepSize).toBe(1.5);
			expect(
				item.goal.fixedResolutionAndBitrateConfiguration
					?.forcedRenditionAboveHighestFixedRepresentationFactor,
			).toBe(1.25);
			expect(item.goal.rows?.[0]?.maxBitrate).toBe(440_000);
		}
	});
	it("keeps lower-side placement room separate from the native output count", () => {
		const current = assess(mixed(7_200_000));
		expect(current.lowerSlots?.maximum).toBeGreaterThan(1);
		expect(current.lowerConnection?.fitsMaximum).toBe(true);
		expect(perTitlePlacementCapacity(120_000, 440_000, 1.5)).toBe(4);
		expect(perTitlePlacementCapacity(120_000, 440_000, 1)).toBeNull();
	});
	it("ranks placement capacity beyond the model bound as unknown risk, never zero increase", () => {
		const goal = mixed(7_200_000);
		goal.maxBitrateStepSize = 10;
		goal.rows = goal.rows?.map((row) =>
			row.id === "highest" ? { ...row, minBitrate: 1_572_864 } : row,
		);
		goal.fixedResolutionAndBitrateConfiguration = {
			...goal.fixedResolutionAndBitrateConfiguration,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1025 / 1024,
		};
		const result = analyzePerTitleSettings(goal, "cap");
		const unbounded = result.advice.find(
			(item) => assess(item.goal).globalCapacity === null,
		);
		expect(unbounded).toBeDefined();
		expect(unbounded?.facts.capacityIncrease).toBeGreaterThan(0);
		expect(unbounded?.facts.capacityUnresolved).toBe(1);
		expect(unbounded?.explanation?.en).toContain("model bound");
		expect(
			assess(result.advice[0]?.goal ?? goal).globalCapacity,
		).not.toBeNull();
	});
	it("explains unresolved placement growth on a direct cap repair without a whole-ladder certificate", () => {
		const goal: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 120_000,
			maxBitrate: 7_200_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 10,
			countPolicy: { kind: "unrestricted" },
			autoRepresentations: false,
			rows: [
				{
					id: "fixed",
					height: 400,
					minBitrate: 7_190_000,
					maxBitrate: 7_190_000,
					bitrateSelectionMode: "OPTIMIZED",
				},
			],
			automaticTemplates: [{ id: "upper-auto", height: 800 }],
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1025 / 1024,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		};
		const unresolved = analyzePerTitleSettings(goal, "cap").advice.find(
			(item) => item.facts.capacityUnresolved === 1,
		);
		expect(unresolved).toBeDefined();
		expect(unresolved?.facts.wholeLadderImprovement).toBe(0);
		expect(unresolved?.explanation?.en).toContain("model bound");
		expect(unresolved?.explanation?.ja).toContain("検証上限");
	});
	it("describes a lower forced floor without calling it an increase", () => {
		const goal = mixed(7_200_000);
		goal.minBitrateStepSize = 1.2;
		goal.fixedResolutionAndBitrateConfiguration = {
			...goal.fixedResolutionAndBitrateConfiguration,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.5,
		};
		const floor = assess(goal).topResponse.floor ?? 0;
		const lowered = analyzePerTitleSettings(goal, "cap").advice.find(
			(item) => (assess(item.goal).topResponse.floor ?? Infinity) < floor,
		);
		expect(lowered).toBeDefined();
		expect(lowered?.explanation?.ja).not.toContain("上がります");
		expect(lowered?.explanation?.ja).toContain("変わります");
	});
});
