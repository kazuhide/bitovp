import {
	certifyComplexityIntervals,
	evaluateComplexityRange,
	type PerTitleGoal,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	applyPerTitleAdvice,
	perTitleAdvice,
} from "./per-title-simulator-advice";

const source = (): PerTitleGoal => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 4_000_000,
	minBitrateStepSize: 1.25,
	maxBitrateStepSize: 4,
	countPolicy: { kind: "unrestricted" },
	autoRepresentations: false,
	rows: [
		{
			id: "a",
			height: 240,
			minBitrate: 200_000,
			maxBitrate: 400_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 1_250_000,
			highComplexityBoundaryForMaxBitrate: 4_000_000,
		},
		{
			id: "b",
			height: 720,
			minBitrate: 1_000_000,
			maxBitrate: 1_600_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 1_250_000,
			highComplexityBoundaryForMaxBitrate: 4_000_000,
		},
	],
	automaticTemplates: [
		{ id: "bottom", height: 120 },
		{ id: "top", height: 1080 },
	],
	fixedResolutionAndBitrateConfiguration: {
		forcedRenditionAboveHighestFixedRepresentation: 1,
		forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
		forcedRenditionAboveHighestFixedRepresentationCalculationMode:
			"LAST_CALCULATED_BITRATE",
	},
	targetQualityCrf: 18,
});

function joint(previous: PerTitleGoal, maximum = previous.maxBitrate * 2) {
	const current = { ...previous, maxBitrate: maximum };
	const items = perTitleAdvice(previous, current, {
		scope: "global",
		key: "maxBitrate",
	});
	const advice = items[0];
	expect(advice?.reason).toBe("joint-range");
	if (!advice) throw new Error("Expected a joint range adjustment.");
	return { current, advice };
}

describe("joint Per-Title range advice", () => {
	it("adjusts ranges, steps and the existing additional factor as one explicit option", () => {
		const previous = source();
		const snapshot = structuredClone(previous);
		const { current, advice } = joint(previous);
		expect(advice.goal.minBitrate).toBe(previous.minBitrate);
		expect(advice.goal.maxBitrate).toBe(8_000_000);
		expect(advice.goal.automaticTemplates).toEqual(previous.automaticTemplates);
		expect(advice.goal.countPolicy).toEqual(previous.countPolicy);
		expect(advice.goal.targetQualityCrf).toBe(18);
		const exponent = Math.log(80) / Math.log(40);
		expect(advice.goal.rows?.[0]?.minBitrate).toBe(230_000);
		expect(advice.goal.rows?.[0]?.minBitrate).not.toBe(400_000);
		expect(advice.facts.exponent).toBe(exponent);
		expect(advice.goal.minBitrateStepSize).toBe(1.31);
		expect(advice.goal.maxBitrateStepSize).toBeGreaterThanOrEqual(
			4 ** exponent,
		);
		expect(advice.goal.maxBitrateStepSize).toBeGreaterThanOrEqual(
			(advice.goal.rows?.[1]?.minBitrate ?? Infinity) /
				(advice.goal.rows?.[0]?.minBitrate ?? 1),
		);
		expect(advice.facts.connectionRisk).toBe(0);
		expect(
			advice.goal.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBe(1.24);
		expect(
			advice.goal.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentation,
		).toBe(1);
		expect(advice.proof).toBe("conditional-settings");
		expect(previous).toEqual(snapshot);
		expect(current.rows).toEqual(snapshot.rows);
		expect(applyPerTitleAdvice(current, advice)).toEqual(advice.goal);
		expect(
			applyPerTitleAdvice({ ...current, minBitrate: 110_000 }, advice),
		).toBeNull();
	});

	it("does not lower a fixed-C target even when mapping both boundaries would lower it", () => {
		const previous: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100,
			maxBitrate: 400,
			minBitrateStepSize: 2,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "unrestricted" },
			rows: [
				{
					id: "fixed",
					height: 240,
					minBitrate: 100,
					maxBitrate: 200,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 200,
					highComplexityBoundaryForMaxBitrate: 400,
				},
			],
		};
		const { advice } = joint(previous, 1600);
		const row = advice.goal.rows?.[0];
		expect(row?.minBitrate).toBe(100);
		expect(row?.maxBitrate).toBe(400);
		expect(row?.lowComplexityBoundaryForMaxBitrate).toBe(200);
		expect(row?.highComplexityBoundaryForMaxBitrate).toBe(800);
		for (let input = 1; input <= 400; input++) {
			const after = evaluateComplexityRange({
				minimum: row?.minBitrate ?? 0,
				maximum: row?.maxBitrate ?? 0,
				low: row?.lowComplexityBoundaryForMaxBitrate ?? 0,
				high: row?.highComplexityBoundaryForMaxBitrate ?? 0,
				input,
				minStep: advice.goal.minBitrateStepSize ?? 0,
			});
			const before = evaluateComplexityRange({
				minimum: 100,
				maximum: 200,
				low: 200,
				high: 400,
				input,
				minStep: 2,
			});
			expect(after?.maximum).toBeGreaterThanOrEqual(
				before?.maximum ?? Infinity,
			);
		}
	});

	it("preserves custom upper boundaries and repeated resolutions", () => {
		const previous = source();
		previous.rows = previous.rows?.map((row) => ({
			...row,
			height: 360,
			highComplexityBoundaryForMaxBitrate: 3_500_000,
		}));
		const { advice } = joint(previous);
		expect(
			advice.goal.rows?.map((row) => [
				row.id,
				row.height,
				row.highComplexityBoundaryForMaxBitrate,
			]),
		).toEqual([
			["a", 360, 3_500_000],
			["b", 360, 3_500_000],
		]);
	});

	it("limits an existing additional factor when repeated rounding would exceed the new cap", () => {
		const previous: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 1,
			maxBitrate: 8,
			minBitrateStepSize: 2,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "unrestricted" },
			rows: [{ id: "fixed", height: 240, minBitrate: 1, maxBitrate: 2 }],
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 2,
				forcedRenditionAboveHighestFixedRepresentationFactor: 2,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		};
		const { advice } = joint(previous, 16);
		const factor =
			advice.goal.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor ?? 0;
		expect(factor).toBeGreaterThan(1);
		expect(factor).toBeLessThan(2 ** (4 / 3));
		const first = Math.round(3 * factor),
			second = Math.round(first * factor);
		expect(first).toBeGreaterThan(3);
		expect(second).toBeGreaterThan(first);
		expect(second).toBeLessThanOrEqual(16);
	});

	it("raises the mapped minimum step when integer rounding otherwise adds a placement", () => {
		const previous: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 1,
			maxBitrate: 4,
			minBitrateStepSize: 1.6,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "unrestricted" },
			rows: [{ id: "fixed", height: 240, minBitrate: 1, maxBitrate: 2 }],
		};
		const { advice } = joint(previous, 8);
		const spacing = advice.goal.minBitrateStepSize ?? 0;
		expect(spacing).toBeGreaterThan(1.6 ** 1.5);
		expect(spacing).toBe(2.13);
		expect(
			Math.round(Math.round(Math.round(1 * spacing) * spacing) * spacing),
		).toBeGreaterThan(8);
		expect(advice.facts.previousCapacity).toBe(3);
		expect(advice.facts.capacity).toBe(3);
	});

	it("retains certified connections after rounding ranges and steps without increasing placement room", () => {
		const previous: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100,
			maxBitrate: 10_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "unrestricted" },
			autoRepresentations: false,
			rows: [
				{
					id: "a",
					height: 240,
					minBitrate: 250,
					maxBitrate: 420,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 5400,
					highComplexityBoundaryForMaxBitrate: 10_000,
				},
				{
					id: "b",
					height: 720,
					minBitrate: 500,
					maxBitrate: 750,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 5400,
					highComplexityBoundaryForMaxBitrate: 10_000,
				},
			],
			automaticTemplates: [{ id: "top", height: 1080 }],
		};
		const { advice } = joint(previous, 30_000);
		const step = advice.goal.minBitrateStepSize ?? 0;
		expect(step).toBe(Number(step.toFixed(2)));
		const certificate = certifyComplexityIntervals(
			(advice.goal.rows ?? []).map((row) => ({
				minimum: row.minBitrate ?? 0,
				maximum: row.maxBitrate ?? 0,
				low: row.lowComplexityBoundaryForMaxBitrate ?? 0,
				high: row.highComplexityBoundaryForMaxBitrate ?? 0,
			})),
			{ minimum: 1, maximum: advice.goal.maxBitrate },
			step,
		);
		expect(certificate).not.toBeNull();
		expect(certificate?.minimumAdjacentRatio).toBeGreaterThanOrEqual(step);
		expect(certificate?.maximumAdjacentRatio).toBeLessThanOrEqual(
			advice.goal.maxBitrateStepSize ?? 0,
		);
		expect(
			advice.goal.rows?.[0]?.highComplexityBoundaryForMaxBitrate,
		).toBeGreaterThan(10_000);
		expect(advice.facts.capacity).toBeLessThanOrEqual(
			advice.facts.previousCapacity ?? 0,
		);
		expect(advice.facts.connectionRisk).toBe(0);
	});

	it("does not invent a joint expansion for degenerate or invalid source ranges", () => {
		for (const previous of [
			{ ...source(), minBitrate: 4_000_000 },
			{ ...source(), minBitrateStepSize: 1 },
		]) {
			const result = perTitleAdvice(
				previous,
				{ ...previous, maxBitrate: 8_000_000 },
				{ scope: "global", key: "maxBitrate" },
			);
			expect(result.some((item) => item.reason === "joint-range")).toBe(false);
		}
	});
});
