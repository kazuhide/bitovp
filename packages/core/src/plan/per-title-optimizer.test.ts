import { describe, expect, it } from "vitest";
import {
	type PerTitleGoal,
	recommendPerTitleSettings,
} from "./per-title-simulator.js";

const firstRange = {
	id: "a",
	height: 240,
	minBitrate: 160_000,
	maxBitrate: 200_000,
};
const fixed: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 2_400_000,
	countPolicy: { kind: "exact", count: 3 },
	rows: [
		firstRange,
		{ id: "b", height: 480, minBitrate: 400_000, maxBitrate: 480_000 },
		{ id: "c", height: 720, minBitrate: 1_000_000, maxBitrate: 1_200_000 },
	],
};

describe("joint Per-Title constraint optimization", () => {
	it("derives the row calibration and spacing together for a fully specified count", () => {
		const source = structuredClone(fixed);
		const result = recommendPerTitleSettings(fixed);
		expect(result.derivation?.method).toBe("joint-constraints");
		expect(result.derivation?.constraints?.status).toBe("checked");
		expect(result.derivation?.constraints?.scope).toBe("closed-ladder");
		expect(result.derivation?.targetSatisfied).toBe(true);
		for (const stream of result.api.streams) {
			expect(stream.perTitleSettings).toMatchObject({
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 1_000_000,
				highComplexityBoundaryForMaxBitrate: 2_400_000,
			});
		}
		expect(result.api.global.minBitrateStepSize).toBeGreaterThan(1.26);
		expect(result.countGuarantee).toBe(false);
		expect(fixed).toEqual(source);
	});

	it("budgets additional renditions instead of asking the user to delete the rule", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			countPolicy: { kind: "exact", count: 5 },
		});
		expect(
			result.api.global.fixedResolutionAndBitrateConfiguration,
		).toMatchObject({
			forcedRenditionAboveHighestFixedRepresentation: 2,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"LAST_CALCULATED_BITRATE",
		});
		expect(result.derivation?.constraints?.status).toBe("checked");
		expect(result.derivation?.constraints?.forced.count).toBe(2);
		expect(
			result.scenarios.every((s) => s.modelCountRange?.maximum === 5),
		).toBe(true);
		for (const scenario of result.scenarios) {
			expect(scenario.modelRungs).toHaveLength(5);
			expect(scenario.modelRungs.at(-1)?.bitrate).toBeLessThanOrEqual(
				fixed.maxBitrate,
			);
		}
	});

	it("accounts for an unnecessary saved rule in the explicit derivation", () => {
		const goal: PerTitleGoal = {
			...fixed,
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 2,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.4,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"MAXIMUM",
			},
		};
		const before = structuredClone(goal);
		const result = recommendPerTitleSettings(goal);
		expect(
			result.api.global.fixedResolutionAndBitrateConfiguration,
		).toBeUndefined();
		expect(result.derivation?.constraints?.changes).toContainEqual(
			expect.objectContaining({ field: "forcedCount", before: 2, after: 0 }),
		);
		expect(result.derivation?.targetSatisfied).toBe(true);
		expect(goal).toEqual(before);
	});

	it("preserves explicit boundaries and exposes their coupled effect", () => {
		const goal: PerTitleGoal = {
			...fixed,
			rows: fixed.rows?.map((row) => ({
				...row,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 800_000,
				highComplexityBoundaryForMaxBitrate: 3_000_000,
			})),
		};
		const first = recommendPerTitleSettings(goal);
		const second = recommendPerTitleSettings({
			...goal,
			rows: goal.rows?.map((row) => ({
				...row,
				highComplexityBoundaryForMaxBitrate: 4_000_000,
			})),
		});
		expect(
			first.api.streams[0]?.perTitleSettings
				?.highComplexityBoundaryForMaxBitrate,
		).toBe(3_000_000);
		expect(
			second.api.streams[0]?.perTitleSettings
				?.highComplexityBoundaryForMaxBitrate,
		).toBe(4_000_000);
		expect(first.derivation?.constraints?.checkpoints).toBeDefined();
		expect(second.derivation?.constraints?.checkpoints).not.toEqual(
			first.derivation?.constraints?.checkpoints,
		);
	});

	it("keeps mixed automatic candidates and conditional rule behavior visible", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			countPolicy: { kind: "exact", count: 5 },
			automaticTemplates: [{ id: "automatic", height: 1080 }],
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.3,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		});
		expect(
			result.api.streams.some((stream) => stream.mode === "PER_TITLE_TEMPLATE"),
		).toBe(true);
		expect(
			result.api.global.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentation,
		).toBe(1);
		expect(result.derivation?.constraints?.scope).toBe("conditional");
		expect(result.derivation?.constraints?.forced.conditional).toBe(true);
		expect(result.derivation?.targetSatisfied).toBe(false);
	});

	it.each([
		"exact",
		"maximum",
	] as const)("does not certify a mixed %s count from an independent interval example", (kind) => {
		const result = recommendPerTitleSettings({
			...fixed,
			minBitrateStepSize: 1.9,
			maxBitrateStepSize: 3,
			countPolicy: { kind, count: 5 },
			automaticTemplates: [{ id: "automatic", height: 1080 }],
		});
		expect(result.derivation?.constraints?.scope).toBe("conditional");
		expect(result.derivation?.constraints?.status).toBe("unknown");
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.applicable).toBe(false);
		expect(result.status).not.toBe("candidate");
		expect(result.derivation?.selectedMinStep).toBe(
			result.api.global.minBitrateStepSize,
		);
		expect(result.derivation?.selectedMaxStep).toBe(
			result.api.global.maxBitrateStepSize,
		);
		expect(result.api.streams.map((stream) => stream.rowId)).toContain(
			"automatic",
		);
	});

	it("replaces unsafe near-unit spacing rather than certifying rounded duplicate points", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			minBitrate: 3,
			maxBitrate: 12,
			minBitrateStepSize: 1.01,
			maxBitrateStepSize: 2.5,
			countPolicy: { kind: "exact", count: 2 },
			rows: [
				{ id: "a", height: 240, minBitrate: 3, maxBitrate: 3 },
				{ id: "b", height: 480, minBitrate: 6, maxBitrate: 6 },
			],
		});
		expect(result.derivation?.constraints?.status).toBe("checked");
		for (const value of [3, 6]) {
			expect(
				Math.round(value * result.api.global.minBitrateStepSize),
			).toBeGreaterThan(value);
		}
		expect(result.api.global.minBitrateStepSize).toBeGreaterThan(1.01);
	});

	it.each([
		{ rows: [{ ...firstRange, id: "" }] },
		{ rows: [{ ...firstRange, minBitrate: 0 }] },
		{
			rows: [
				{
					...firstRange,
					lowComplexityBoundaryForMaxBitrate: 1000,
					bitrateSelectionMode: "COMPLEXITY_RANGE" as const,
				},
			],
		},
		{ countPolicy: { kind: "exact" as const, count: 0 } },
	])("never upgrades invalid requirements to a joint certificate: %j", (patch) => {
		const result = recommendPerTitleSettings({ ...fixed, ...patch });
		expect(result.applicable).toBe(false);
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.derivation?.constraints?.status).not.toBe("checked");
	});

	it("does not claim that arbitrary requested counts fit the reserved bitrate budget", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			maxBitrate: 1_200_000,
			countPolicy: { kind: "exact", count: 256 },
		});
		expect(result.derivation?.constraints?.status).not.toBe("checked");
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.applicable).toBe(false);
	});

	it("does not certify a count when the complexity calibration has no input span", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			maxBitrate: 1_200_000,
			rows: fixed.rows?.map((row) =>
				row.id === "c" ? { ...row, minBitrate: 1_200_000 } : row,
			),
		});
		expect(result.derivation?.constraints?.status).toBe("unknown");
		expect(result.derivation?.constraints?.inputRange).toBeNull();
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.applicable).toBe(false);
	});

	it("preserves a safe additional-rendition factor independently of ordinary spacing", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			countPolicy: { kind: "exact", count: 4 },
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.1,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		});
		expect(result.derivation?.targetSatisfied).toBe(true);
		expect(
			result.api.global.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBe(1.1);
		expect(result.api.global.minBitrateStepSize).toBeGreaterThan(1.1);
		expect(
			result.scenarios.every((scenario) => scenario.modelRungs.length === 4),
		).toBe(true);
	});

	it.each(
		[[Number.NaN], [-0.1], [1.1], Array(10).fill(1)].map(
			(scenarioFractions) => ({ scenarioFractions }),
		),
	)("preserves rejection of invalid or unbounded calculation inputs: %j", ({
		scenarioFractions,
	}) => {
		const result = recommendPerTitleSettings({ ...fixed, scenarioFractions });
		expect(result.applicable).toBe(false);
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.derivation?.constraints?.status).not.toBe("checked");
	});

	it("does not replace a failed coupled check with a successful independent interval example", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			minBitrate: 100_000,
			maxBitrate: 400_000,
			countPolicy: { kind: "exact", count: 2 },
			rows: [
				{
					id: "a",
					height: 240,
					minBitrate: 100_000,
					maxBitrate: 200_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 1,
					highComplexityBoundaryForMaxBitrate: 2,
				},
				{
					id: "b",
					height: 480,
					minBitrate: 150_000,
					maxBitrate: 300_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 1_000_000,
					highComplexityBoundaryForMaxBitrate: 2_000_000,
				},
			],
		});
		expect(result.derivation?.constraints?.status).toBe("unknown");
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.applicable).toBe(false);
		expect(result.derivation?.selectedMinStep).toBe(
			result.api.global.minBitrateStepSize,
		);
		expect(result.derivation?.selectedMaxStep).toBe(
			result.api.global.maxBitrateStepSize,
		);
		expect(
			result.scenarios.every(
				(scenario) =>
					scenario.status === "unknown" &&
					scenario.modelCountRange === null &&
					scenario.modelRungs.length === 0,
			),
		).toBe(true);
	});

	it("requires resolved dimension ordering when explicit widths are mixed with omitted widths", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			rows: fixed.rows?.map((row, index) =>
				index === 0 ? { ...row, width: 4000 } : row,
			),
		});
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.applicable).toBe(false);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "row-order-unknown" }),
		);
	});

	it.each([
		{ kind: "exact", count: 2 },
		{ kind: "maximum", count: 10 },
	] as const)("leaves equal-dimension execution order unresolved for $kind counts", (countPolicy) => {
		const result = recommendPerTitleSettings({
			...fixed,
			maxBitrate: 600_000,
			countPolicy,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 2.1,
			rows: [
				{
					id: "a",
					width: 640,
					height: 360,
					minBitrate: 100_000,
					maxBitrate: 400_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 600_000,
					highComplexityBoundaryForMaxBitrate: 700_000,
				},
				{
					id: "b",
					width: 640,
					height: 360,
					minBitrate: 100_000,
					maxBitrate: 200_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 50_000,
					highComplexityBoundaryForMaxBitrate: 60_000,
				},
			],
		});
		expect(result.derivation?.constraints?.status).toBe("unknown");
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.applicable).toBe(false);
	});
});
