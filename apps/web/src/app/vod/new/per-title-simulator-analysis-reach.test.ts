import {
	type PerTitleGoal,
	type PerTitleProposal,
	proposePerTitleSettings,
	recommendPerTitleSettings,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { assessPerTitleReach } from "./per-title-simulator-analysis-reach";

function mixed(overrides: Partial<PerTitleGoal> = {}): PerTitleGoal {
	return {
		strategy: "fixed-ranges",
		codec: "H264",
		minBitrate: 100_000,
		maxBitrate: 6_000_000,
		minBitrateStepSize: 1.2,
		maxBitrateStepSize: 4,
		countPolicy: { kind: "unrestricted" },
		autoRepresentations: false,
		rows: [
			{
				id: "fixed",
				height: 720,
				minBitrate: 1_800_000,
				maxBitrate: 2_400_000,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 2_100_000,
				highComplexityBoundaryForMaxBitrate: 6_000_000,
			},
		],
		automaticTemplates: [{ id: "top", height: 1080 }],
		...overrides,
	};
}

function proposal(goal: PerTitleGoal): PerTitleProposal {
	const value = proposePerTitleSettings(goal)[0];
	if (!value) throw new Error("Expected the current-setting proposal.");
	return value;
}

function forced(
	mode:
		| "LAST_CALCULATED_BITRATE"
		| "MINIMUM"
		| "MAXIMUM"
		| "AVERAGE" = "LAST_CALCULATED_BITRATE",
): PerTitleGoal {
	return mixed({
		minBitrate: 1,
		maxBitrate: 228,
		automaticTemplates: [],
		rows: [
			{
				id: "fixed",
				height: 720,
				minBitrate: 80,
				maxBitrate: 101,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 10,
				highComplexityBoundaryForMaxBitrate: 228,
			},
		],
		fixedResolutionAndBitrateConfiguration: {
			forcedRenditionAboveHighestFixedRepresentation: 2,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.5,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode: mode,
		},
	});
}

describe("current-setting Per-Title reach assessment", () => {
	it("uses the cap and minimum as explicit hypotheses, independently of graph examples", () => {
		const goal = mixed();
		const current = proposal(goal);
		current.scenarios = [];
		const before = structuredClone({ goal, current });
		expect(assessPerTitleReach(goal, current)).toMatchObject({
			status: "conditional-reachable",
			branch: "direct",
			certainty: "all-permitted-rates",
			cap: 6_000_000,
			highInput: 6_000_000,
			lowInput: 100_000,
			high: { minimum: 6_000_000, maximum: 6_000_000 },
			low: { minimum: 1_800_000, maximum: 1_800_000 },
			topFixed: { rowId: "fixed", minimum: 2_400_000, maximum: 2_400_000 },
			requiredRatio: 2.5,
			adaptation: "conditional",
			count: { status: "unknown", minimum: null, maximum: null },
			scope: "configuration-only",
		});
		expect({ goal, current }).toEqual(before);
	});

	it.each([
		[{ maxBitrateStepSize: 2 }, "gap-too-wide"],
		[{ minBitrateStepSize: 3 }, "gap-too-narrow"],
	] as const)("identifies an inadmissible direct cap connection: %s", (change, code) => {
		const goal = mixed(change);
		const result = assessPerTitleReach(goal, proposal(goal));
		expect(result.status).toBe("blocked");
		expect(result.blockers).toContain(code);
		expect(result.high?.maximum).toBe(2_400_000);
	});

	it("does not let a low forced factor hide an admissible automatic cap connection", () => {
		const goal = mixed({
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.1,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		});
		expect(assessPerTitleReach(goal, proposal(goal))).toMatchObject({
			status: "conditional-reachable",
			branch: "direct",
			high: { minimum: 6_000_000, maximum: 6_000_000 },
		});
	});

	it("evaluates H above the cap instead of substituting the row maximum", () => {
		const goal = mixed({ automaticTemplates: [] });
		goal.rows = goal.rows?.map((row) => ({
			...row,
			maxBitrate: 6_000_000,
			lowComplexityBoundaryForMaxBitrate: 2_000_000,
			highComplexityBoundaryForMaxBitrate: 10_000_000,
		}));
		expect(assessPerTitleReach(goal, proposal(goal))).toMatchObject({
			status: "blocked",
			branch: "fixed",
			high: { minimum: 3_900_000, maximum: 3_900_000 },
			blockers: ["fixed-top-below-cap"],
		});
	});

	it("distinguishes possible and all-permitted direct selections", () => {
		const goal = mixed({ minBitrateStepSize: 2, maxBitrateStepSize: 3 });
		goal.rows = goal.rows?.map((row) => ({
			...row,
			minBitrate: 2_000_000,
			maxBitrate: 4_000_000,
			bitrateSelectionMode: "OPTIMIZED",
		}));
		const result = assessPerTitleReach(goal, proposal(goal));
		expect(result).toMatchObject({
			status: "conditional-reachable",
			branch: "direct",
			certainty: "some-permitted-rates",
			high: { minimum: 2_000_000, maximum: 6_000_000 },
			adaptation: "unknown",
		});
		expect(result.blockers).toContain("high-input-selection-dependent");
	});

	it("retains the shared complexity evaluator's interior q relaxation", () => {
		const goal = mixed({
			minBitrate: 100,
			maxBitrate: 1000,
			minBitrateStepSize: 4,
			maxBitrateStepSize: 4,
			automaticTemplates: [],
			rows: [
				{
					id: "fixed",
					height: 720,
					minBitrate: 200,
					maxBitrate: 800,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 100,
					highComplexityBoundaryForMaxBitrate: 2000,
				},
			],
		});
		expect(assessPerTitleReach(goal, proposal(goal)).topFixed).toEqual({
			rowId: "fixed",
			minimum: 250,
			maximum: 484,
		});
	});

	it("keeps a closed fixed ladder below the cap despite a fabricated output example", () => {
		const goal = mixed({ automaticTemplates: [] });
		const current = proposal(goal);
		current.status = "candidate";
		current.applicable = true;
		current.scenarios = [
			{
				id: "fabricated",
				fraction: 1,
				assumedMaxBitrate: 6_000_000,
				status: "modelled",
				modelCountRange: { minimum: 1, maximum: 1 },
				rowModels: [],
				modelRungs: [{ bitrate: 6_000_000, kind: "illustrative" }],
				diagnostics: [],
			},
		];
		expect(assessPerTitleReach(goal, current)).toMatchObject({
			status: "blocked",
			branch: "fixed",
			certainty: "unknown",
			high: { minimum: 2_400_000, maximum: 2_400_000 },
			count: { status: "unknown" },
		});
	});

	it("checks every repeated rounded forced point, independently of ordinary steps", () => {
		const goal = forced();
		goal.minBitrateStepSize = 10;
		goal.maxBitrateStepSize = 10;
		expect(assessPerTitleReach(goal, proposal(goal))).toMatchObject({
			status: "conditional-reachable",
			branch: "forced",
			high: { minimum: 228, maximum: 228 },
			low: { minimum: 180, maximum: 180 },
			adaptation: "conditional",
		});
	});

	it("rejects forced overshoot across the configured row band", () => {
		const goal = forced();
		goal.rows = goal.rows?.map((row) => ({ ...row, maxBitrate: 102 }));
		const result = assessPerTitleReach(goal, proposal(goal));
		expect(result.status).toBe("blocked");
		expect(result.blockers).toContain("forced-cap-exceeded");
	});

	it("rejects non-increasing forced rounds", () => {
		const goal = forced();
		goal.fixedResolutionAndBitrateConfiguration = {
			...goal.fixedResolutionAndBitrateConfiguration,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.00000001,
		};
		const result = assessPerTitleReach(goal, proposal(goal));
		expect(result.status).toBe("blocked");
		expect(result.blockers).toContain("forced-not-increasing");
	});

	it.each([
		"MINIMUM",
		"MAXIMUM",
		"AVERAGE",
	] as const)("identifies a constant forced %s base as flat across the hypotheses", (mode) => {
		const goal = forced(mode);
		const result = assessPerTitleReach(goal, proposal(goal));
		expect(result.adaptation).toBe("flat");
		expect(result.low).toEqual(result.high);
	});

	it("rounds an odd-sum average only after applying its first forced factor", () => {
		const goal = forced("AVERAGE");
		goal.maxBitrate = 204;
		expect(assessPerTitleReach(goal, proposal(goal))).toMatchObject({
			status: "conditional-reachable",
			branch: "forced",
			high: { minimum: 204, maximum: 204 },
			low: { minimum: 204, maximum: 204 },
			adaptation: "flat",
		});
	});

	it.each([
		{ forcedRenditionAboveHighestFixedRepresentation: 1 },
		{ forcedRenditionAboveHighestFixedRepresentationFactor: 1.2 },
	])("does not invent missing forced defaults: %s", (rule) => {
		const goal = mixed({ fixedResolutionAndBitrateConfiguration: rule });
		expect(assessPerTitleReach(goal, proposal(goal))).toMatchObject({
			status: "unknown",
			blockers: ["forced-settings-incomplete"],
		});
	});

	it("leaves automatic resolution generation unresolved", () => {
		const goal = mixed({ autoRepresentations: {} });
		expect(assessPerTitleReach(goal, proposal(goal))).toMatchObject({
			status: "unknown",
			blockers: ["automatic-generation-unresolved"],
		});
	});

	it("does not infer automatic-only or missing upper template output", () => {
		for (const goal of [
			mixed({ strategy: "automatic", rows: [] }),
			mixed({ automaticTemplates: [{ id: "lower", height: 180 }] }),
		]) {
			expect(assessPerTitleReach(goal, proposal(goal)).status).toBe("unknown");
		}
	});

	it("does not resolve a tied highest template or a mixed dimension basis", () => {
		for (const templates of [
			[
				{ id: "first", height: 1080 },
				{ id: "second", height: 1080 },
			],
			[{ id: "top", height: 1080, width: 1920 }],
		]) {
			const goal = mixed({ automaticTemplates: templates });
			expect(assessPerTitleReach(goal, proposal(goal))).toMatchObject({
				status: "unknown",
				blockers: ["unresolved-order"],
			});
		}
	});

	it("can establish top reach while repeated lower resolutions retain an order warning", () => {
		const goal = mixed({ countPolicy: { kind: "exact", count: 4 } });
		const top = goal.rows?.[0];
		if (!top) throw new Error("Expected the highest fixed row.");
		goal.rows = [
			{
				...top,
				id: "lower-a",
				height: 360,
				minBitrate: 300_000,
				maxBitrate: 500_000,
			},
			{
				...top,
				id: "lower-b",
				height: 360,
				minBitrate: 600_000,
				maxBitrate: 900_000,
			},
			top,
		];
		const current = proposal(goal);
		current.diagnostics.push({
			code: "row-order-unknown",
			severity: "warning",
			message: "The repeated lower-resolution probes have unresolved ordering.",
			rowIds: ["lower-a", "lower-b"],
		});
		expect(assessPerTitleReach(goal, current)).toMatchObject({
			status: "conditional-reachable",
			branch: "direct",
			certainty: "all-permitted-rates",
			topFixed: { rowId: "fixed", minimum: 2_400_000, maximum: 2_400_000 },
			high: { minimum: 6_000_000, maximum: 6_000_000 },
			count: { status: "unknown", minimum: null, maximum: null },
		});
	});

	it.each([
		["H265V2", { targetQualityCrf: 18 }],
		["AV1", { codecMaxBitrateFactor: 1.2 }],
		["H264", { targetQualityQp: 18 }],
	] as const)("leaves unsupported %s settings unknown", (codec, change) => {
		const goal = mixed({ codec, ...change });
		expect(assessPerTitleReach(goal, proposal(goal))).toMatchObject({
			status: "unknown",
			blockers: ["unsupported-settings"],
		});
	});

	it("keeps supported codec factors separate from nominal target reach", () => {
		const goal = mixed({ codecMaxBitrateFactor: 2, codecBufsizeFactor: 2 });
		expect(assessPerTitleReach(goal, proposal(goal)).status).toBe(
			"conditional-reachable",
		);
	});

	it("accepts a current closed-ladder count certificate without treating it as reach proof", () => {
		const goal: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 2_400_000,
			countPolicy: { kind: "exact", count: 3 },
			rows: [
				{ id: "a", height: 240, minBitrate: 160_000, maxBitrate: 200_000 },
				{ id: "b", height: 480, minBitrate: 400_000, maxBitrate: 480_000 },
				{ id: "c", height: 720, minBitrate: 1_000_000, maxBitrate: 1_200_000 },
			],
		};
		const current = recommendPerTitleSettings(goal);
		expect(assessPerTitleReach(goal, current)).toMatchObject({
			status: "blocked",
			count: { status: "model-checked", minimum: 3, maximum: 3 },
		});
	});

	it("does not accept a count flag or a sampled ladder as a count certificate", () => {
		const goal = mixed({ countPolicy: { kind: "exact", count: 2 } });
		const current = proposal(goal);
		current.derivation = {
			method: "joint-constraints",
			requiredRowCount: 1,
			selectedMinStep: 1.2,
			selectedMaxStep: 4,
			targetSatisfied: true,
			rationale: "A flag without a count certificate.",
		};
		expect(assessPerTitleReach(goal, current).count.status).toBe("unknown");
	});

	it("rechecks a claimed count certificate over the full explicit input interval", () => {
		const goal = mixed({
			minBitrate: 100,
			maxBitrate: 1000,
			countPolicy: { kind: "exact", count: 1 },
			automaticTemplates: [],
			rows: [
				{
					id: "fixed",
					height: 720,
					minBitrate: 200,
					maxBitrate: 800,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 100,
					highComplexityBoundaryForMaxBitrate: 2000,
				},
			],
		});
		const current = proposal(goal);
		current.status = "candidate";
		current.applicable = true;
		current.derivation = {
			method: "joint-constraints",
			requiredRowCount: 1,
			selectedMinStep: 1.2,
			selectedMaxStep: 4,
			targetSatisfied: true,
			rationale: "A fabricated narrow input domain.",
			constraints: {
				status: "checked",
				scope: "closed-ladder",
				inputRange: { minimum: 1000, maximum: 1000 },
				floorRange: { minimum: 1000, maximum: 1000 },
				forced: { count: 0, factor: null, conditional: false, ranges: [] },
				changes: [],
				checkpoints: [],
				conditions: [],
			},
		};
		current.scenarios = [
			{
				id: "narrow-sample",
				fraction: 1,
				assumedMaxBitrate: 1000,
				status: "modelled",
				modelCountRange: { minimum: 1, maximum: 1 },
				rowModels: [],
				modelRungs: [{ rowId: "fixed", bitrate: 484, kind: "required" }],
				diagnostics: [],
			},
		];
		expect(assessPerTitleReach(goal, current).count.status).toBe("unknown");
	});

	it("does not let a malformed count flag invalidate independently checked reach", () => {
		const goal = mixed({
			automaticTemplates: [],
			countPolicy: { kind: "exact", count: 1 },
		});
		const current = proposal(goal);
		current.status = "candidate";
		current.applicable = true;
		current.derivation = {
			method: "joint-constraints",
			requiredRowCount: 1,
			selectedMinStep: 1.2,
			selectedMaxStep: 4,
			targetSatisfied: true,
			rationale: "A malformed count certificate.",
			constraints: {
				status: "checked",
				scope: "closed-ladder",
				inputRange: { minimum: 100_000, maximum: 6_000_000 },
				floorRange: { minimum: 100_000, maximum: 100_000 },
			},
		} as NonNullable<PerTitleProposal["derivation"]>;
		expect(assessPerTitleReach(goal, current)).toMatchObject({
			status: "blocked",
			count: { status: "unknown" },
		});
	});

	it("rejects a malformed parked forced factor even when the forced count is zero", () => {
		const goal = mixed({
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 0,
				forcedRenditionAboveHighestFixedRepresentationFactor: Number.NaN,
			},
		});
		expect(assessPerTitleReach(goal, proposal(goal)).status).toBe("unknown");
	});

	it("returns unknown for malformed API values rather than throwing", () => {
		const goal = mixed();
		const current = proposal(goal);
		current.api.global.maxBitrate = Number.NaN;
		expect(assessPerTitleReach(goal, current).status).toBe("unknown");
		const malformed = { ...current, api: null } as unknown as PerTitleProposal;
		expect(assessPerTitleReach(goal, malformed).status).toBe("unknown");
	});
});
