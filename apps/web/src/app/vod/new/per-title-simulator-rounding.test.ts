import type { PerTitleGoal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	applyPerTitleAdvice,
	type PerTitleAdviceOptions,
	perTitleAdvice,
} from "./per-title-simulator-advice";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

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
});

const expansion = { scope: "global", key: "maxBitrate" } as const;
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Expected a checked adjustment.");
	return value;
}
function joint(
	previous: PerTitleGoal,
	maximum = previous.maxBitrate * 2,
	options: PerTitleAdviceOptions = {},
) {
	const current = { ...previous, maxBitrate: maximum };
	const items = perTitleAdvice(previous, current, expansion, options);
	expect(items).toHaveLength(1);
	const advice = required(items[0]);
	expect(advice.reason).toBe("joint-range");
	return { current, advice };
}

describe("readable checked Per-Title adjustments", () => {
	it("prefers readable bitrate endpoints and ratios in the actual adopted API", () => {
		const previous = source();
		const before = structuredClone(previous);
		const { current, advice } = joint(previous);
		const currentBefore = structuredClone(current);
		for (const row of advice.goal.rows ?? []) {
			for (const value of [row.minBitrate, row.maxBitrate]) {
				const bitrate = required(value);
				expect(Number.isSafeInteger(bitrate)).toBe(true);
				expect(bitrate).toBe(Number(bitrate.toPrecision(4)));
			}
		}
		for (const value of [
			advice.goal.minBitrateStepSize,
			advice.goal.maxBitrateStepSize,
			advice.goal.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		]) {
			const ratio = required(value);
			expect(ratio).toBe(Number(ratio.toFixed(4)));
		}
		const adopted = applyPerTitleAdvice(current, advice);
		expect(adopted).not.toBeNull();
		if (!adopted) throw new Error("Expected an adoptable checked adjustment.");
		expect(tunePerTitleSettings(adopted, adopted).proposal.api).toEqual(
			advice.proposal.api,
		);
		expect(previous).toEqual(before);
		expect(current).toEqual(currentBefore);
	});

	it("prefers one safe upper boundary when all complexity rows can share it", () => {
		const previous = source();
		const { advice } = joint(previous);
		const rows = required(advice.goal.rows);
		expect(rows).toHaveLength(2);
		const upper = required(rows[0]?.highComplexityBoundaryForMaxBitrate);
		expect(rows[1]?.highComplexityBoundaryForMaxBitrate).toBe(upper);
		expect(upper).toBeGreaterThanOrEqual(previous.maxBitrate);
		expect(upper).toBeLessThanOrEqual(advice.goal.maxBitrate);
		for (const stream of advice.proposal.api.streams.filter(
			(stream) =>
				stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		))
			expect(stream.perTitleSettings?.highComplexityBoundaryForMaxBitrate).toBe(
				upper,
			);
	});

	it("retains odd protected values and the exact latest driver while rounding free settings", () => {
		const previous = source();
		previous.rows = previous.rows?.map((row) =>
			row.id === "a" ? { ...row, minBitrate: 200_003 } : row,
		);
		previous.fixedResolutionAndBitrateConfiguration = {
			...previous.fixedResolutionAndBitrateConfiguration,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.23456789,
		};
		const options: PerTitleAdviceOptions = {
			protectedFields: [
				{ scope: "stream", rowId: "a", key: "minBitrate" },
				{
					scope: "global",
					key: "fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationFactor",
				},
			],
		};
		const snapshot = structuredClone({ previous, options });
		const { current, advice } = joint(previous, 8_000_123, options);
		expect(advice.goal.rows?.[0]?.minBitrate).toBe(200_003);
		expect(
			advice.goal.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBe(1.23456789);
		expect(advice.goal.maxBitrate).toBe(8_000_123);
		expect(advice.proposal.api.global.maxBitrate).toBe(8_000_123);
		for (const value of [
			advice.goal.rows?.[0]?.maxBitrate,
			advice.goal.rows?.[1]?.minBitrate,
			advice.goal.rows?.[1]?.maxBitrate,
		]) {
			const bitrate = required(value);
			expect(bitrate).toBe(Number(bitrate.toPrecision(4)));
		}
		const accepted = applyPerTitleAdvice(current, advice, options);
		expect(accepted).toEqual(advice.goal);
		expect({ previous, options }).toEqual(snapshot);
	});

	it("preserves custom and protected upper boundaries instead of forcing a common value", () => {
		const previous = source();
		previous.rows = previous.rows?.map((row) =>
			row.id === "b"
				? { ...row, highComplexityBoundaryForMaxBitrate: 3_500_003 }
				: row,
		);
		const { advice } = joint(previous, 8_000_000, {
			protectedFields: [
				{
					scope: "stream",
					rowId: "a",
					key: "highComplexityBoundaryForMaxBitrate",
				},
			],
		});
		expect(advice.goal.rows?.[0]?.highComplexityBoundaryForMaxBitrate).toBe(
			4_000_000,
		);
		expect(advice.goal.rows?.[1]?.highComplexityBoundaryForMaxBitrate).toBe(
			3_500_003,
		);
	});

	it("does not round spacing down to admit an extra integer placement", () => {
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
		const unsafe = 2.12;
		expect(
			Math.round(Math.round(Math.round(1 * unsafe) * unsafe) * unsafe),
		).toBeLessThanOrEqual(8);
		const current = { ...previous, maxBitrate: 8 };
		const snapshot = structuredClone({ previous, current });
		const items = perTitleAdvice(previous, current, expansion);
		for (const advice of items) {
			const spacing = required(advice.goal.minBitrateStepSize);
			expect(
				Math.round(Math.round(Math.round(1 * spacing) * spacing) * spacing),
			).toBeGreaterThan(8);
			expect(advice.goal.maxBitrate).toBe(8);
			expect(
				advice.proposal.diagnostics.some((d) => d.severity === "conflict"),
			).toBe(false);
			expect(applyPerTitleAdvice(current, advice)).toEqual(advice.goal);
		}
		expect({ previous, current }).toEqual(snapshot);
	});
});
