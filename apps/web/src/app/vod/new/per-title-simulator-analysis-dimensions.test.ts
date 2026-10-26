import {
	type PerTitleGoal,
	recommendPerTitleSettings,
	resolvePerTitleFixedMode,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { perTitleAdvice } from "./per-title-simulator-advice";
import { analyzePerTitleSettings } from "./per-title-simulator-analysis";
import { assessPerTitleCountStructure } from "./per-title-simulator-analysis-count";
import { perTitleCountDirectedCandidates } from "./per-title-simulator-analysis-count-layouts";
import { assessPerTitleLadder } from "./per-title-simulator-analysis-ladder";
import { assessPerTitleReach } from "./per-title-simulator-analysis-reach";
import { jointPerTitleExpansion } from "./per-title-simulator-joint";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";
import { assessPerTitleUpperLimit } from "./per-title-simulator-upper-limit";

function mixed(): PerTitleGoal {
	return {
		strategy: "fixed-ranges",
		codec: "H264",
		minBitrate: 100_000,
		maxBitrate: 5_600_000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 5,
		countPolicy: { kind: "exact", count: 6 },
		autoRepresentations: false,
		targetQualityCrf: 19,
		fixedResolutionAndBitrateConfiguration: {
			forcedRenditionAboveHighestFixedRepresentation: 1,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"LAST_CALCULATED_BITRATE",
		},
		rows: [
			{ id: "first", height: 400, minBitrate: 300_000, maxBitrate: 420_000 },
			{ id: "second", height: 400, minBitrate: 640_000, maxBitrate: 840_000 },
			{
				id: "middle",
				height: 600,
				minBitrate: 1_300_000,
				maxBitrate: 1_700_000,
			},
			{
				id: "highest",
				height: 800,
				minBitrate: 2_700_000,
				maxBitrate: 3_500_000,
			},
		].map((row) => ({
			...row,
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 3_240_000,
			highComplexityBoundaryForMaxBitrate: 5_600_000,
		})),
		automaticTemplates: [
			{ id: "bottom", height: 200 },
			{ id: "upper-a", height: 1000 },
			{ id: "upper-b", height: 1200 },
		],
	};
}

function widthOnly(goal: PerTitleGoal): PerTitleGoal {
	const convert = <T extends { height?: number }>(row: T) => {
		const { height, ...rest } = row;
		if (height === undefined) throw new Error("Expected a fixture height");
		return { ...rest, width: height * 2 };
	};
	return {
		...goal,
		rows: goal.rows?.map(convert),
		automaticTemplates: goal.automaticTemplates?.map(convert),
	};
}

function dimensions(goal: PerTitleGoal) {
	return [
		...(goal.rows ?? []).map((row) => ({
			...row,
			mode: resolvePerTitleFixedMode(goal, row),
		})),
		...(goal.automaticTemplates ?? []).map((row) => ({
			...row,
			mode: "PER_TITLE_TEMPLATE",
		})),
	].map((row) => ({
		id: row.id,
		mode: row.mode,
		...(Object.hasOwn(row, "height") ? { height: row.height } : {}),
		...(Object.hasOwn(row, "width") ? { width: row.width } : {}),
	}));
}

const proposalFor = (goal: PerTitleGoal) =>
	tunePerTitleSettings(goal, goal).proposal;

describe("shared declared dimensions across Per-Title analysis and advice", () => {
	it("retains count-directed improvements with a shared height and one explicit width", () => {
		const goal = mixed();
		goal.rows = goal.rows?.map((row, index) =>
			index === 0 ? { ...row, width: 800 } : row,
		);
		const before = structuredClone(goal);
		const proposal = proposalFor(goal);
		expect(assessPerTitleCountStructure(goal, proposal).status).toBe(
			"declared-compatible",
		);
		const candidates = perTitleCountDirectedCandidates(goal, proposal);
		expect(candidates.length).toBeGreaterThan(0);
		for (const candidate of candidates) {
			expect(dimensions(candidate)).toEqual(dimensions(goal));
			expect(candidate.automaticTemplates).toEqual(goal.automaticTemplates);
			const checked = proposalFor(candidate);
			expect(checked.countGuarantee).toBe(false);
			expect(assessPerTitleReach(candidate, checked).status).toBe(
				"conditional-reachable",
			);
			expect(assessPerTitleUpperLimit(candidate, checked).status).toBe(
				"satisfied",
			);
			expect(assessPerTitleLadder(candidate, checked).lowerSlots).toEqual({
				minimum: 1,
				maximum: 1,
			});
		}
		expect(goal).toEqual(before);
	});

	it.each([
		"preserve",
		"bandwidth",
	] as const)("shows a %s improvement instead of losing candidates at a partial-width gate", (purpose) => {
		const goal = mixed();
		goal.minBitrateStepSize = 1.7;
		if (purpose === "bandwidth") {
			goal.maxBitrate = 6_000_000;
			goal.rows = goal.rows?.map((row) => ({
				...row,
				lowComplexityBoundaryForMaxBitrate: 5_500_000,
				highComplexityBoundaryForMaxBitrate: 6_000_000,
			}));
		}
		goal.rows = goal.rows?.map((row, index) =>
			index === 0 ? { ...row, width: 800 } : row,
		);
		const result = analyzePerTitleSettings(goal, purpose);
		expect(result.countStructure.status).toBe("declared-compatible");
		expect(result.ladder.lowerSlots).not.toBeNull();
		expect(result.decision.status).toBe("proposal");
		expect(result.advice.length).toBeGreaterThan(0);
		for (const advice of result.advice) {
			expect(dimensions(advice.goal)).toEqual(dimensions(goal));
			expect(advice.proposal.countGuarantee).toBe(false);
		}
	});

	it("preserves width-only fixed and ordinary templates in every count candidate", () => {
		const goal = widthOnly(mixed());
		const before = structuredClone(goal);
		const candidates = perTitleCountDirectedCandidates(goal, proposalFor(goal));
		expect(candidates.length).toBeGreaterThan(0);
		for (const candidate of candidates) {
			expect(dimensions(candidate)).toEqual(dimensions(goal));
			for (const row of proposalFor(candidate).api.streams)
				expect(Object.hasOwn(row, "height")).toBe(false);
		}
		expect(goal).toEqual(before);
	});

	it.each([
		"partial",
		"width-only",
	] as const)("keeps low-boundary advice and joint expansion available for %s dimensions", (shape) => {
		const source: PerTitleGoal = {
			...mixed(),
			maxBitrate: 4_000_000,
			minBitrateStepSize: 1.25,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "unrestricted" },
			rows: [
				{ id: "low", height: 240, minBitrate: 200_000, maxBitrate: 400_000 },
				{
					id: "high",
					height: 720,
					minBitrate: 1_000_000,
					maxBitrate: 1_600_000,
				},
			].map((row) => ({
				...row,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 1_250_000,
				highComplexityBoundaryForMaxBitrate: 4_000_000,
			})),
			automaticTemplates: [
				{ id: "bottom", height: 120 },
				{ id: "upper", height: 1080 },
			],
		};
		const goal =
			shape === "width-only"
				? widthOnly(source)
				: {
						...source,
						rows: source.rows?.map((row, index) =>
							index === 0 ? { ...row, width: 480 } : row,
						),
					};
		const changed = { ...goal, minBitrateStepSize: 1.5 };
		const low = perTitleAdvice(goal, changed, {
			scope: "global",
			key: "minBitrateStepSize",
		}).find((advice) => advice.reason === "lower-boundary");
		expect(low).toBeDefined();
		expect(low?.changes.every((change) => change.after === 1_500_000)).toBe(
			true,
		);
		const expanded = jointPerTitleExpansion(goal, {
			...goal,
			maxBitrate: 8_000_000,
		});
		expect(expanded.length).toBeGreaterThan(0);
		for (const candidate of expanded)
			expect(dimensions(candidate.goal)).toEqual(dimensions(goal));
	});

	it.each([
		"incomparable",
		"invalid",
	] as const)("retains %s dimensions without issuing a certified count or a count candidate", (shape) => {
		const goal = mixed();
		goal.rows = goal.rows?.map((row, index) =>
			index === 0
				? {
						...row,
						height: shape === "invalid" ? Number.NaN : undefined,
						width: 800,
					}
				: row,
		);
		const before = structuredClone(goal);
		const proposal = proposalFor(goal);
		expect(proposal.applicable).toBe(false);
		expect(assessPerTitleCountStructure(goal, proposal).status).toBe("unknown");
		expect(assessPerTitleReach(goal, proposal).status).toBe("unknown");
		expect(assessPerTitleUpperLimit(goal, proposal).status).toBe("unknown");
		expect(perTitleCountDirectedCandidates(goal, proposal)).toEqual([]);
		expect(goal).toEqual(before);
	});

	it("uses a common width when height order is reversed, retaining the ambiguity warning", () => {
		const goal: PerTitleGoal = {
			...mixed(),
			maxBitrate: 4_000_000,
			countPolicy: { kind: "exact", count: 4 },
			rows: [
				{
					id: "low",
					height: 800,
					width: 640,
					minBitrate: 300_000,
					maxBitrate: 420_000,
				},
				{
					id: "fixed",
					height: 400,
					width: 1280,
					minBitrate: 1_000_000,
					maxBitrate: 1_600_000,
				},
			].map((row) => ({
				...row,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 1_200_000,
				highComplexityBoundaryForMaxBitrate: 4_000_000,
			})),
			automaticTemplates: [
				{ id: "lower", height: 200, width: 320 },
				{ id: "upper", height: 1200, width: 2560 },
			],
		};
		const proposal = proposalFor(goal);
		expect(assessPerTitleCountStructure(goal, proposal).status).toBe(
			"declared-compatible",
		);
		expect(assessPerTitleReach(goal, proposal).topFixed?.rowId).toBe("fixed");
		expect(assessPerTitleUpperLimit(goal, proposal).status).not.toBe("unknown");
		expect(
			analyzePerTitleSettings(goal, "preserve").findings.some(
				(finding) => finding.code === "dimension-order-ambiguous",
			),
		).toBe(true);
	});

	it("does not mix width and height units when checking a closed count certificate", () => {
		const goal: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 2_400_000,
			countPolicy: { kind: "exact", count: 3 },
			rows: [
				{
					id: "a",
					height: 240,
					width: 480,
					minBitrate: 160_000,
					maxBitrate: 200_000,
				},
				{ id: "b", height: 480, minBitrate: 400_000, maxBitrate: 480_000 },
				{ id: "c", height: 720, minBitrate: 1_000_000, maxBitrate: 1_200_000 },
			],
		};
		const proposal = recommendPerTitleSettings(goal);
		expect(assessPerTitleReach(goal, proposal).count).toEqual({
			status: "model-checked",
			minimum: 3,
			maximum: 3,
		});
		expect(proposal.countGuarantee).toBe(false);
	});

	it("does not replace a tied highest width with the different height order", () => {
		const goal = widthOnly(mixed());
		goal.rows = goal.rows?.map((row, index) =>
			index >= 2 ? { ...row, width: 1600, height: 600 + index * 100 } : row,
		);
		const proposal = proposalFor(goal);
		expect(assessPerTitleReach(goal, proposal).status).toBe("unknown");
		expect(assessPerTitleUpperLimit(goal, proposal).status).toBe("unknown");
		expect(perTitleCountDirectedCandidates(goal, proposal)).toEqual([]);
	});

	it("keeps a width-only resolution-only Stream outside fixed-range candidate generation", () => {
		const goal = widthOnly(mixed());
		goal.rows = goal.rows?.map((row, index) => {
			if (index !== 3) return row;
			return {
				id: row.id,
				width: row.width,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			};
		});
		const before = structuredClone(goal);
		const proposal = proposalFor(goal);
		const emitted = proposal.api.streams.find((row) => row.rowId === "highest");
		expect(emitted).toMatchObject({
			width: 1600,
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
		});
		expect(emitted?.perTitleSettings).toBeUndefined();
		expect(Object.hasOwn(emitted ?? {}, "height")).toBe(false);
		expect(perTitleCountDirectedCandidates(goal, proposal)).toEqual([]);
		expect(goal).toEqual(before);
	});
});
