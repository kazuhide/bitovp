import {
	complexityTargetsDoNotDecrease,
	type PerTitleGoal,
} from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPerTitleEvaluationAdvice } from "./per-title-simulator-advice";
import { analyzePerTitleSettings } from "./per-title-simulator-analysis";
import * as genericCandidates from "./per-title-simulator-analysis-candidates";
import { assessPerTitleCountStructure } from "./per-title-simulator-analysis-count";
import * as countCandidates from "./per-title-simulator-analysis-count-layouts";
import {
	assessPerTitleLadder,
	perTitleAnalysisCurve,
} from "./per-title-simulator-analysis-ladder";
import * as wholeCandidates from "./per-title-simulator-analysis-layouts";
import * as retainedFactorCandidates from "./per-title-simulator-analysis-retained-factor";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const mixed = (): PerTitleGoal => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 6_000_000,
	minBitrateStepSize: 1.7,
	maxBitrateStepSize: 5,
	countPolicy: { kind: "exact", count: 6 },
	autoRepresentations: false,
	targetQualityCrf: 19,
	complexityFactor: 1,
	resolutionScaleFactor: 0,
	codecMinBitrateFactor: 0.8,
	codecMaxBitrateFactor: 1.4,
	codecBufsizeFactor: 2,
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
		lowComplexityBoundaryForMaxBitrate: 5_500_000,
		highComplexityBoundaryForMaxBitrate: 6_000_000,
	})),
	automaticTemplates: [
		{ id: "bottom", height: 200 },
		{ id: "upper-a", height: 1000 },
		{ id: "upper-b", height: 1200 },
	],
});

const saturated = (): PerTitleGoal => ({
	...mixed(),
	minBitrateStepSize: 1.6,
	rows: [
		{ id: "first", height: 400, minBitrate: 300_000, maxBitrate: 400_000 },
		{ id: "second", height: 400, minBitrate: 650_000, maxBitrate: 750_000 },
		{ id: "middle", height: 600, minBitrate: 1_200_000, maxBitrate: 1_300_000 },
		{
			id: "highest",
			height: 800,
			minBitrate: 2_050_000,
			maxBitrate: 2_200_000,
		},
	].map((row) => ({
		...row,
		bitrateSelectionMode: "COMPLEXITY_RANGE",
		lowComplexityBoundaryForMaxBitrate: 3_000_000,
		highComplexityBoundaryForMaxBitrate: 3_800_000,
	})),
});

function structuralCandidate(goal: PerTitleGoal): PerTitleGoal {
	const proposal = tunePerTitleSettings(goal, goal).proposal;
	const candidate = countCandidates.perTitleCountDirectedCandidates(
		goal,
		proposal,
	)[0];
	if (!candidate)
		throw new Error("Expected an independently checked structural candidate.");
	if (!createPerTitleEvaluationAdvice(goal, candidate))
		throw new Error(
			"Expected the candidate to pass the real advice certificate.",
		);
	return candidate;
}

function offerOnly(candidate: PerTitleGoal) {
	vi.spyOn(genericCandidates, "perTitleAnalysisCandidates").mockReturnValue([
		candidate,
	]);
	vi.spyOn(countCandidates, "perTitleCountDirectedCandidates").mockReturnValue(
		[],
	);
	vi.spyOn(wholeCandidates, "perTitleWholeLadderCandidates").mockReturnValue(
		[],
	);
	vi.spyOn(
		retainedFactorCandidates,
		"perTitleRetainedFactorCandidates",
	).mockReturnValue([]);
}

afterEach(() => vi.restoreAllMocks());

describe("bandwidth structural repairs", () => {
	it("offers a conditional mixed-ladder repair without a quality or savings guarantee", () => {
		const goal = mixed();
		const before = structuredClone(goal);
		const result = analyzePerTitleSettings(goal, "bandwidth", {
			protectedFields: ["minBitrate", "maxBitrate"].map((key) => ({
				scope: "stream",
				rowId: "first",
				key,
			})),
		});
		expect(result.decision.status).toBe("proposal");
		expect(result.advice.length).toBeGreaterThan(0);
		expect(result.quality.status).toBe("requires-media");
		const baseline = tunePerTitleSettings(goal, goal).proposal;
		for (const item of result.advice) {
			expect(item.proof).toBe("conditional-settings");
			expect(item.proposal.countGuarantee).toBe(false);
			expect(item.goal.minBitrate).toBe(goal.minBitrate);
			expect(item.goal.maxBitrate).toBe(goal.maxBitrate);
			expect(item.goal.countPolicy).toEqual(goal.countPolicy);
			expect(item.goal.automaticTemplates).toEqual(goal.automaticTemplates);
			expect(
				item.goal.rows?.map(({ id, height, width }) => ({ id, height, width })),
			).toEqual(
				goal.rows?.map(({ id, height, width }) => ({ id, height, width })),
			);
			for (const key of [
				"targetQualityCrf",
				"targetQualityQp",
				"complexityFactor",
				"resolutionScaleFactor",
				"codecMinBitrateFactor",
				"codecMaxBitrateFactor",
				"codecBufsizeFactor",
			] as const)
				expect(item.goal[key]).toBe(goal[key]);
			expect(item.goal.rows?.[0]?.minBitrate).toBe(goal.rows?.[0]?.minBitrate);
			expect(item.goal.rows?.[0]?.maxBitrate).toBe(goal.rows?.[0]?.maxBitrate);
			const after = assessPerTitleLadder(item.goal, item.proposal);
			expect(after.lowerSlots?.minimum).toBeGreaterThanOrEqual(1);
			expect(after.lowerSlots?.maximum).toBeLessThanOrEqual(
				result.ladder.lowerSlots?.maximum ?? 0,
			);
			expect(after.upperSlots?.maximum).toBeLessThanOrEqual(
				result.ladder.upperSlots?.maximum ?? 0,
			);
			expect(after.globalCapacity).toBeLessThanOrEqual(
				result.ladder.globalCapacity ?? 0,
			);
			expect(
				(after.lowerSlots?.maximum ?? Infinity) <
					(result.ladder.lowerSlots?.maximum ?? 0) ||
					(after.upperSlots?.maximum ?? Infinity) <
						(result.ladder.upperSlots?.maximum ?? 0) ||
					(after.globalCapacity ?? Infinity) <
						(result.ladder.globalCapacity ?? 0),
			).toBe(true);
			for (const row of baseline.api.streams) {
				const curve = perTitleAnalysisCurve(row);
				if (!curve) continue;
				const next = item.proposal.api.streams.find(
					(value) => value.rowId === row.rowId,
				);
				const nextCurve = next && perTitleAnalysisCurve(next);
				expect(
					nextCurve &&
						complexityTargetsDoNotDecrease(
							curve,
							nextCurve,
							result.ladder.input,
						),
				).toBe(true);
			}
			expect(item.explanation?.en).toMatch(/structur|placement/i);
			expect(item.explanation?.en).toMatch(/savings.*quality.*media/i);
			expect(item.explanation?.en).not.toMatch(
				/quality is preserved|guaranteed savings/i,
			);
		}
		expect(
			result.advice.some(
				(item) =>
					(assessPerTitleLadder(item.goal, item.proposal).lowerSlots?.maximum ??
						Infinity) < (result.ladder.lowerSlots?.maximum ?? 0),
			),
		).toBe(true);
		expect(
			result.advice.some(
				(item) =>
					assessPerTitleLadder(item.goal, item.proposal).upperSlots?.maximum ===
					0,
			),
		).toBe(true);
		expect(goal).toEqual(before);
	});

	it("includes a nondecreasing whole-ladder extension that reduces upper placement room", () => {
		const goal = saturated();
		const baseline = tunePerTitleSettings(goal, goal).proposal;
		const extended = wholeCandidates.perTitleWholeLadderCandidates(
			goal,
			baseline,
			{},
		)[0];
		if (!extended) throw new Error("Expected a whole-ladder extension seed.");
		const certificate = createPerTitleEvaluationAdvice(goal, extended);
		if (!certificate)
			throw new Error("Expected an independently accepted extension.");
		const result = analyzePerTitleSettings(goal, "bandwidth");
		expect(
			result.advice.map((item) => item.proposal.api),
			JSON.stringify(result.search.rejected),
		).toContainEqual(certificate.proposal.api);
		const after = assessPerTitleLadder(certificate.goal, certificate.proposal);
		expect(certificate.proof).toBe("conditional-settings");
		expect(certificate.proposal.countGuarantee).toBe(false);
		expect(after.upperSlots?.maximum).toBeLessThan(
			result.ladder.upperSlots?.maximum ?? 0,
		);
		expect(after.lowerSlots).toEqual(result.ladder.lowerSlots);
		expect(after.globalCapacity).toBe(result.ladder.globalCapacity);
		expect(after.earlySaturationRows.length).toBeLessThan(
			result.ladder.earlySaturationRows.length,
		);
		for (const row of baseline.api.streams) {
			const curve = perTitleAnalysisCurve(row);
			if (!curve) continue;
			const next = certificate.proposal.api.streams.find(
				(value) => value.rowId === row.rowId,
			);
			const nextCurve = next && perTitleAnalysisCurve(next);
			expect(
				nextCurve &&
					complexityTargetsDoNotDecrease(curve, nextCurve, result.ladder.input),
			).toBe(true);
		}
	});

	it("rejects a fixed upper-target reduction even when the structural candidate is otherwise valid", () => {
		const goal = mixed();
		const candidate = structuralCandidate(goal);
		const lowered = {
			...candidate,
			rows: candidate.rows?.map((row, index) =>
				index === 0
					? {
							...row,
							lowComplexityBoundaryForMaxBitrate: 5_700_000,
							highComplexityBoundaryForMaxBitrate: 6_000_000,
						}
					: row,
			),
		};
		expect(createPerTitleEvaluationAdvice(goal, lowered)).not.toBeNull();
		offerOnly(lowered);
		const result = analyzePerTitleSettings(goal, "bandwidth");
		expect(result.advice).toEqual([]);
		expect(result.search.rejected["bandwidth-target-reduction"]).toBe(1);
	});

	it("rejects a quality-control shortcut attached to a valid structural repair", () => {
		const goal = mixed();
		const candidate = { ...structuralCandidate(goal), targetQualityCrf: 24 };
		expect(createPerTitleEvaluationAdvice(goal, candidate)).not.toBeNull();
		offerOnly(candidate);
		const result = analyzePerTitleSettings(goal, "bandwidth");
		expect(result.advice).toEqual([]);
		expect(result.search.rejected["bandwidth-quality-or-role-change"]).toBe(1);
	});

	it("does not offer a valid change without an independently checked structural improvement", () => {
		const goal = mixed();
		const candidate = { ...goal, maxBitrateStepSize: 6 };
		expect(createPerTitleEvaluationAdvice(goal, candidate)).not.toBeNull();
		offerOnly(candidate);
		const result = analyzePerTitleSettings(goal, "bandwidth");
		expect(result.advice).toEqual([]);
		expect(result.search.rejected).toEqual({
			"bandwidth-no-structural-improvement": 1,
		});
	});

	it("rejects a structural candidate that increases global placement capacity", () => {
		const goal = mixed();
		const candidate = { ...structuralCandidate(goal), minBitrateStepSize: 1.6 };
		expect(createPerTitleEvaluationAdvice(goal, candidate)).not.toBeNull();
		offerOnly(candidate);
		const result = analyzePerTitleSettings(goal, "bandwidth");
		expect(result.advice).toEqual([]);
		expect(result.search.rejected["bandwidth-placement-regression"]).toBe(1);
	});

	it.each([
		"bandwidth",
		"cap",
		"preserve",
	] as const)("retains placement room for the declared lower role under the %s objective", (intent) => {
		const goal: PerTitleGoal = {
			...mixed(),
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 6,
			countPolicy: { kind: "exact", count: 4 },
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 3.5,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
			rows: [
				{ id: "first", height: 400, minBitrate: 300_000, maxBitrate: 300_000 },
				{
					id: "highest",
					height: 800,
					minBitrate: 1_200_000,
					maxBitrate: 1_300_000,
				},
			].map((row) => ({
				...row,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 4_200_000,
				highComplexityBoundaryForMaxBitrate: 6_000_000,
			})),
			automaticTemplates: [
				{ id: "bottom", height: 200 },
				{ id: "upper", height: 1000 },
			],
		};
		const baseline = tunePerTitleSettings(goal, goal).proposal;
		const aligned = wholeCandidates
			.perTitleWholeLadderCandidates(goal, baseline, {})
			.find((candidate) => candidate.minBitrateStepSize === 3.5);
		if (!aligned) throw new Error("Expected a real aligned whole-ladder seed.");
		const certificate = createPerTitleEvaluationAdvice(goal, aligned);
		if (!certificate)
			throw new Error("Expected the aligned seed to pass the advice factory.");
		const structure = assessPerTitleCountStructure(
			certificate.goal,
			certificate.proposal,
		);
		expect(structure.status).toBe("declared-compatible");
		expect(structure.lower?.required).toBe(1);
		expect(assessPerTitleLadder(goal, baseline).lowerSlots).toEqual({
			minimum: 2,
			maximum: 2,
		});
		expect(
			assessPerTitleLadder(certificate.goal, certificate.proposal).lowerSlots,
		).toEqual({ minimum: 0, maximum: 0 });
		const result = analyzePerTitleSettings(goal, intent);
		for (const item of result.advice) {
			const checkedStructure = assessPerTitleCountStructure(
				item.goal,
				item.proposal,
			);
			const checked = assessPerTitleLadder(item.goal, item.proposal);
			expect(checked.lowerSlots?.minimum).toBeGreaterThanOrEqual(
				checkedStructure.lower?.required ?? 0,
			);
		}
		expect(
			result.search.rejected["required-lower-role-unavailable"],
		).toBeGreaterThan(0);
	});

	it("does not treat early saturation alone as evidence of a bandwidth repair", () => {
		const base = saturated();
		const goal = {
			...base,
			rows: base.rows?.map((row) => ({
				...row,
				...(row.id === "highest"
					? { minBitrate: 2_200_000, maxBitrate: 2_500_000 }
					: {}),
				highComplexityBoundaryForMaxBitrate: 4_800_000,
			})),
		};
		const baseline = tunePerTitleSettings(goal, goal).proposal;
		const extended = wholeCandidates.perTitleWholeLadderCandidates(
			goal,
			baseline,
			{},
		)[0];
		if (!extended) throw new Error("Expected a whole-ladder extension seed.");
		const certificate = createPerTitleEvaluationAdvice(goal, extended);
		if (!certificate)
			throw new Error("Expected an independently accepted extension.");
		const before = assessPerTitleLadder(goal, baseline);
		const after = assessPerTitleLadder(certificate.goal, certificate.proposal);
		expect(after.earlySaturationRows.length).toBeLessThan(
			before.earlySaturationRows.length,
		);
		expect(after.lowerSlots).toEqual(before.lowerSlots);
		expect(after.upperSlots).toEqual(before.upperSlots);
		expect(after.globalCapacity).toBe(before.globalCapacity);
		offerOnly(extended);
		const result = analyzePerTitleSettings(goal, "bandwidth");
		expect(result.advice).toEqual([]);
		expect(result.search.rejected).toEqual({
			"bandwidth-no-structural-improvement": 1,
		});
	});

	it("keeps protected structural fields and refuses unsupported count-role repairs", () => {
		const goal = mixed();
		const fields = [
			{ scope: "global", key: "minBitrateStepSize" },
			{ scope: "global", key: "maxBitrateStepSize" },
			{
				scope: "global",
				key: "fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationFactor",
			},
			...(goal.rows ?? []).flatMap((row) =>
				[
					"minBitrate",
					"maxBitrate",
					"lowComplexityBoundaryForMaxBitrate",
					"highComplexityBoundaryForMaxBitrate",
				].map((key) => ({ scope: "stream" as const, rowId: row.id, key })),
			),
		] as const;
		expect(
			analyzePerTitleSettings(goal, "bandwidth", { protectedFields: fields })
				.advice,
		).toEqual([]);
		const mismatch = {
			...goal,
			countPolicy: { kind: "exact", count: 5 },
		} as const;
		expect(analyzePerTitleSettings(mismatch, "bandwidth").advice).toEqual([]);
	});
});
