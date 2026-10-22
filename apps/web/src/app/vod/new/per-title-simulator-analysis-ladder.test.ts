import type { PerTitleGoal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
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

describe("whole-ladder current-setting analysis", () => {
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
	it("does not claim to preserve an unknown native count in a mixed ladder", () => {
		const goal = {
			...mixed(7_200_000),
			countPolicy: { kind: "exact", count: 6 } as const,
		};
		const result = analyzePerTitleSettings(goal, "preserve");
		expect(result.advice).toEqual([]);
		expect(result.decision.status).toBe("inspect-only");
		expect(
			result.findings.some(
				(finding) => finding.code === "preserve-count-unverified",
			),
		).toBe(true);
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
