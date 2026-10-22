import type { PerTitleGoal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { assessPerTitleCountStructure } from "./per-title-simulator-analysis-count";
import { perTitleCountDirectedCandidates } from "./per-title-simulator-analysis-count-layouts";
import { assessPerTitleLadder } from "./per-title-simulator-analysis-ladder";
import { assessPerTitleReach } from "./per-title-simulator-analysis-reach";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const mixed = (): PerTitleGoal => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 5_600_000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 5,
	countPolicy: { kind: "exact", count: 6 },
	autoRepresentations: false,
	targetQualityCrf: 19,
	complexityFactor: 1,
	fixedResolutionAndBitrateConfiguration: {
		forcedRenditionAboveHighestFixedRepresentation: 1,
		forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
		forcedRenditionAboveHighestFixedRepresentationCalculationMode:
			"LAST_CALCULATED_BITRATE",
	},
	rows: [
		{ id: "first", height: 400, minBitrate: 300_000, maxBitrate: 420_000 },
		{ id: "second", height: 400, minBitrate: 640_000, maxBitrate: 840_000 },
		{ id: "middle", height: 600, minBitrate: 1_300_000, maxBitrate: 1_700_000 },
		{
			id: "highest",
			height: 800,
			minBitrate: 2_700_000,
			maxBitrate: 3_500_000,
		},
	].map((row) => ({
		...row,
		bitrateSelectionMode: "COMPLEXITY_RANGE",
		lowComplexityBoundaryForMaxBitrate: 3_240_000,
		highComplexityBoundaryForMaxBitrate: 5_600_000,
	})),
	automaticTemplates: [
		{ id: "bottom", height: 200 },
		{ id: "upper-a", height: 1000 },
		{ id: "upper-b", height: 1200 },
	],
});
const candidates = (goal: PerTitleGoal) =>
	perTitleCountDirectedCandidates(
		goal,
		tunePerTitleSettings(goal, goal).proposal,
	);

describe("derived mixed-count candidate family", () => {
	it("reduces ordinary placement room with the unchanged full-domain certificate", () => {
		const goal = mixed();
		const result = candidates(goal);
		expect(result.length).toBeGreaterThan(0);
		expect(result.length).toBeLessThanOrEqual(4);
		for (const candidate of result) {
			const proposal = tunePerTitleSettings(candidate, candidate).proposal;
			const ladder = assessPerTitleLadder(candidate, proposal);
			const reach = assessPerTitleReach(candidate, proposal);
			expect(ladder.lowerSlots).toEqual({ minimum: 1, maximum: 1 });
			expect(ladder.upperSlots).toEqual({ minimum: 0, maximum: 0 });
			expect(ladder.intervals?.maximumWithinRowRatio).toBeLessThan(
				candidate.minBitrateStepSize as number,
			);
			expect(ladder.intervals?.minimumAdjacentRatio).toBeGreaterThanOrEqual(
				candidate.minBitrateStepSize as number,
			);
			expect(ladder.intervals?.maximumAdjacentRatio).toBeLessThanOrEqual(5);
			expect(reach.status).toBe("conditional-reachable");
			expect(reach.certainty).toBe("all-permitted-rates");
			expect(reach.high).toEqual({
				minimum: goal.maxBitrate,
				maximum: goal.maxBitrate,
			});
			expect(reach.adaptation).toBe("conditional");
			expect(reach.count.status).toBe("unknown");
			expect(
				assessPerTitleCountStructure(candidate, proposal).nativeCount,
			).toBe("requires-media");
		}
	});
	it("preserves global limits, count, quality controls, templates and the first fixed band", () => {
		const goal = mixed();
		for (const candidate of candidates(goal)) {
			expect(candidate.minBitrate).toBe(goal.minBitrate);
			expect(candidate.maxBitrate).toBe(goal.maxBitrate);
			expect(candidate.countPolicy).toEqual(goal.countPolicy);
			expect(candidate.targetQualityCrf).toBe(goal.targetQualityCrf);
			expect(candidate.complexityFactor).toBe(goal.complexityFactor);
			expect(candidate.automaticTemplates).toEqual(goal.automaticTemplates);
			expect(
				candidate.rows?.map(({ id, height, width }) => ({ id, height, width })),
			).toEqual(
				goal.rows?.map(({ id, height, width }) => ({ id, height, width })),
			);
			expect(candidate.rows?.[0]?.minBitrate).toBe(goal.rows?.[0]?.minBitrate);
			expect(candidate.rows?.[0]?.maxBitrate).toBe(goal.rows?.[0]?.maxBitrate);
			expect(
				candidate.fixedResolutionAndBitrateConfiguration
					?.forcedRenditionAboveHighestFixedRepresentation,
			).toBe(1);
			expect(
				candidate.fixedResolutionAndBitrateConfiguration
					?.forcedRenditionAboveHighestFixedRepresentationCalculationMode,
			).toBe("LAST_CALCULATED_BITRATE");
		}
	});
	it("allows held first-band endpoints but refuses to move a held downstream minimum", () => {
		const goal = mixed();
		const proposal = tunePerTitleSettings(goal, goal).proposal;
		expect(
			perTitleCountDirectedCandidates(goal, proposal, {
				protectedFields: ["minBitrate", "maxBitrate"].map((key) => ({
					scope: "stream",
					rowId: "first",
					key,
				})),
			}).length,
		).toBeGreaterThan(0);
		expect(
			perTitleCountDirectedCandidates(goal, proposal, {
				protectedFields: [
					{ scope: "stream", rowId: "middle", key: "minBitrate" },
				],
			}),
		).toEqual([]);
	});
	it("does not change held spacing, forced factor, or complexity boundaries", () => {
		const goal = mixed();
		const proposal = tunePerTitleSettings(goal, goal).proposal;
		for (const protectedFields of [
			[{ scope: "global" as const, key: "minBitrateStepSize" }],
			[
				{
					scope: "global" as const,
					key: "fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationFactor",
				},
			],
			[
				{
					scope: "stream" as const,
					rowId: "first",
					key: "lowComplexityBoundaryForMaxBitrate",
				},
			],
		])
			expect(
				perTitleCountDirectedCandidates(goal, proposal, { protectedFields }),
			).toEqual([]);
	});
	it("returns no candidate when the lower-slot and q-activation step window is empty", () => {
		const goal = mixed();
		goal.rows = goal.rows?.map((row, index) =>
			index === 0 ? { ...row, minBitrate: 150_000 } : row,
		);
		expect(candidates(goal)).toEqual([]);
	});
	it("requires the explicit compatible mixed declaration and preserves its upper rule", () => {
		const goal = mixed();
		goal.countPolicy = { kind: "unrestricted" };
		expect(candidates(goal)).toEqual([]);
		goal.countPolicy = { kind: "exact", count: 6 };
		goal.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 2,
		};
		expect(candidates(goal)).toEqual([]);
	});
});
