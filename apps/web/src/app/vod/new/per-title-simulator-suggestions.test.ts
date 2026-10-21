import type { PerTitleGoal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { perTitleSuggestions } from "./per-title-simulator-suggestions";

const valid: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100000,
	maxBitrate: 200000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 2,
	countPolicy: { kind: "exact", count: 2 },
	rows: [
		{ id: "low", height: 240, minBitrate: 100000, maxBitrate: 100000 },
		{ id: "high", height: 480, minBitrate: 200000, maxBitrate: 200000 },
	],
};
describe("analytic Per-Title suggestions", () => {
	it("expands only global bounds to cover required intervals", () => {
		const before = { ...valid, minBitrate: 150000, maxBitrate: 180000 };
		const suggestion = perTitleSuggestions(before).find(
			(item) => item.reason === "global-range",
		);
		expect(suggestion).toBeDefined();
		expect(suggestion?.goal.minBitrate).toBe(100000);
		expect(suggestion?.goal.maxBitrate).toBe(200000);
		expect(suggestion?.goal.rows).toEqual(before.rows);
		expect(suggestion?.changedFields).toContain("minBitrate");
		expect(suggestion?.changedFields).toContain("maxBitrate");
		expect(suggestion?.proposal.applicable).toBe(true);
	});
	it("suppresses changes when the original model already meets the goal", () => {
		expect(perTitleSuggestions(valid)).toEqual([]);
	});
	it("raises a too-small requested count to the number of mandatory rows", () => {
		const suggestion = perTitleSuggestions({
			...valid,
			countPolicy: { kind: "exact", count: 1 },
		}).find((item) => item.reason === "required-count");
		expect(suggestion?.goal.countPolicy).toEqual({ kind: "exact", count: 2 });
		expect(suggestion?.goal.rows).toEqual(valid.rows);
		expect(suggestion?.changedFields).toContain("countPolicy.count");
		expect(suggestion?.proposal.applicable).toBe(true);
	});
	it("offers removing automatic candidates only as an explicit, verified fixed-only tradeoff", () => {
		const goal = {
			...valid,
			maxBitrate: 400000,
			automaticTemplates: [{ id: "auto", height: 960 }],
		};
		const suggestion = perTitleSuggestions(goal).find(
			(item) => item.reason === "fixed-only",
		);
		expect(suggestion?.goal.automaticTemplates).toEqual([]);
		expect(suggestion?.goal.rows).toEqual(goal.rows);
		expect(suggestion?.changedFields).toContain("automaticTemplates");
		const high = suggestion?.proposal.scenarios.find(
			(scenario) => scenario.id === "high",
		);
		expect(high?.status).toBe("modelled");
		expect(high?.modelCountRange?.maximum).toBeLessThanOrEqual(2);
		expect(high?.modelRungs).toHaveLength(2);
	});
	it("offers removing forced configuration explicitly without changing rows or automatic templates", () => {
		const goal = {
			...valid,
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.3,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE" as const,
			},
		};
		const suggestion = perTitleSuggestions(goal).find(
			(item) => item.reason === "without-forced",
		);
		expect(
			suggestion?.goal.fixedResolutionAndBitrateConfiguration,
		).toBeUndefined();
		expect(suggestion?.changedFields).toContain(
			"fixedResolutionAndBitrateConfiguration",
		);
		expect(suggestion?.goal.rows).toEqual(goal.rows);
		expect(suggestion?.goal.automaticTemplates).toBeUndefined();
		expect(suggestion?.proposal.applicable).toBe(true);
	});
	it("keeps input immutable and exposes exactly the step values actually checked", () => {
		const goal = { ...valid, minBitrate: 150000, maxBitrate: 180000 };
		const copy = structuredClone(goal);
		for (const item of perTitleSuggestions(goal)) {
			expect(item.goal.minBitrateStepSize).toBe(
				item.proposal.api.global.minBitrateStepSize,
			);
			expect(item.goal.maxBitrateStepSize).toBe(
				item.proposal.api.global.maxBitrateStepSize,
			);
		}
		expect(goal).toEqual(copy);
	});
	it("does not activate parked rows when returning to automatic or count strategies", () => {
		const parked = valid.rows;
		for (const goal of [
			{
				...valid,
				strategy: "automatic" as const,
				minBitrate: 200000,
				maxBitrate: 100000,
				countPolicy: { kind: "unrestricted" as const },
			},
			{
				...valid,
				strategy: "count" as const,
				minBitrate: 100000,
				maxBitrate: 100001,
				countPolicy: { kind: "exact" as const, count: 3 },
			},
		]) {
			expect(perTitleSuggestions({ ...goal, rows: parked })).toEqual(
				perTitleSuggestions({ ...goal, rows: [] }),
			);
			expect(perTitleSuggestions({ ...goal, rows: parked })).toEqual([]);
		}
	});

	it("does not produce approximate, invalid or duplicate suggestions", () => {
		for (const goal of [
			{ ...valid, minBitrate: -1 },
			{
				...valid,
				rows: Array.from({ length: 65 }, (_, i) => ({
					...valid.rows?.[0],
					id: `row-${i}`,
				})) as PerTitleGoal["rows"],
			},
			{ ...valid, countPolicy: { kind: "exact" as const, count: 256 } },
		]) {
			const suggestions = perTitleSuggestions(goal);
			expect(suggestions.length).toBeLessThanOrEqual(4);
			expect(
				new Set(suggestions.map((item) => JSON.stringify(item.goal))).size,
			).toBe(suggestions.length);
			expect(suggestions.every((item) => item.proposal.applicable)).toBe(true);
		}
	});
});
