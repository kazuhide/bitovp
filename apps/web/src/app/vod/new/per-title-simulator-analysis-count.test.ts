import type { PerTitleGoal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { assessPerTitleCountStructure } from "./per-title-simulator-analysis-count";
import { assessPerTitleReach } from "./per-title-simulator-analysis-reach";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const mixed = (): PerTitleGoal => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 120_000,
	maxBitrate: 4_800_000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 5,
	countPolicy: { kind: "exact", count: 6 },
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
		{ id: "bottom", height: 200 },
		{ id: "upper-a", height: 1000 },
		{ id: "upper-b", height: 1200 },
	],
});
const assess = (goal: PerTitleGoal) =>
	assessPerTitleCountStructure(goal, tunePerTitleSettings(goal, goal).proposal);

describe("declared mixed-ladder count structure", () => {
	it("maps four mandatory rows, one lower role and one alternative upper role to declared six", () => {
		const result = assess(mixed());
		expect(result.status).toBe("declared-compatible");
		expect(result.scope).toBe("declared-structure");
		expect(result.required).toBe(6);
		expect(result.declaredCount).toBe(6);
		expect(result.fixedRowIds).toEqual([
			"first",
			"second",
			"middle",
			"highest",
		]);
		expect(result.lower).toEqual({ rowIds: ["bottom"], required: 1 });
		expect(result.upper).toEqual({
			rowIds: ["upper-a", "upper-b"],
			required: 1,
			selection: "one-of",
		});
		expect(result.nativeCount).toBe("requires-media");
		expect(result.blockers).toEqual([]);
	});
	it("keeps the native/model count unresolved even when the declared structure fits", () => {
		const goal = mixed();
		const proposal = tunePerTitleSettings(goal, goal).proposal;
		expect(assessPerTitleCountStructure(goal, proposal).status).toBe(
			"declared-compatible",
		);
		expect(assessPerTitleReach(goal, proposal).count.status).toBe("unknown");
		expect(assess(goal).risks).toEqual(
			expect.arrayContaining([
				"native-count-requires-media",
				"lower-ordinary-reuse",
				"upper-choice-requires-analysis",
				"forced-addition-is-fallback",
			]),
		);
	});
	it("surfaces extra placement room without treating it as generated output count", () => {
		expect(assess(mixed()).risks).toContain("lower-extra-slot-capacity");
		expect(assess(mixed()).lowerReuseThreshold).toBe(270_000);
	});
	it("does not infer a different role multiplicity solely from the requested count", () => {
		const goal = mixed();
		goal.countPolicy = { kind: "exact", count: 7 };
		const result = assess(goal);
		expect(result.status).toBe("unknown");
		expect(result.declaredCount).toBe(6);
		expect(result.blockers).toContain("declared-role-count-mismatch");
	});
	it("reports a genuine conflict when the count is below mandatory fixed templates", () => {
		const goal = mixed();
		goal.countPolicy = { kind: "exact", count: 3 };
		expect(assess(goal).status).toBe("conflict");
		expect(assess(goal).blockers).toContain("required-fixed-count-exceeded");
	});
	it("does not use an unrestricted or maximum count as an exact mixed-role declaration", () => {
		const goal = mixed();
		goal.countPolicy = { kind: "unrestricted" };
		expect(assess(goal).status).toBe("not-applicable");
		goal.countPolicy = { kind: "maximum", count: 6 };
		expect(assess(goal).status).toBe("unknown");
		expect(assess(goal).blockers).toContain("mixed-exact-count-required");
	});
	it("leaves provider-created automatic templates unresolved", () => {
		const goal = mixed();
		goal.autoRepresentations = {};
		expect(assess(goal).status).toBe("unknown");
		expect(assess(goal).blockers).toContain("automatic-generation-unresolved");
	});
	it("identifies ordinary templates inside the fixed ladder rather than silently ignoring them", () => {
		const goal = mixed();
		goal.automaticTemplates = [
			...(goal.automaticTemplates ?? []),
			{ id: "interior", height: 500 },
		];
		const result = assess(goal);
		expect(result.status).toBe("unknown");
		expect(result.intermediateRowIds).toEqual(["interior"]);
		expect(result.blockers).toContain("intermediate-ordinary-roles-unresolved");
	});
	it("does not collapse multiple lower choices into a mandatory single output", () => {
		const goal = mixed();
		goal.automaticTemplates = [
			...(goal.automaticTemplates ?? []),
			{ id: "another-bottom", height: 300 },
		];
		expect(assess(goal).status).toBe("unknown");
		expect(assess(goal).blockers).toContain("lower-role-unresolved");
	});
	it("requires an explicit single upper fallback and upper candidates", () => {
		const goal = mixed();
		goal.fixedResolutionAndBitrateConfiguration = undefined;
		expect(assess(goal).blockers).toContain("upper-rule-unresolved");
		goal.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 2,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.25,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"LAST_CALCULATED_BITRATE",
		};
		expect(assess(goal).status).toBe("unknown");
		goal.fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentation = 1;
		goal.automaticTemplates = [{ id: "bottom", height: 200 }];
		expect(assess(goal).blockers).toContain("upper-role-unresolved");
	});
	it("does not fill omitted forced factor or mode defaults", () => {
		const goal = mixed();
		goal.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 1,
		};
		expect(assess(goal).status).toBe("unknown");
		expect(assess(goal).blockers).toContain("upper-rule-unresolved");
	});
	it("keeps closed-ladder proof on the existing path", () => {
		const goal = mixed();
		goal.automaticTemplates = [];
		expect(assess(goal).status).toBe("not-applicable");
	});
	it("rejects unresolved dimension bases and duplicate row identities", () => {
		const goal = mixed();
		goal.automaticTemplates = [
			{ id: "bottom", width: 300 },
			{ id: "upper", height: 1200 },
		];
		expect(assess(goal).blockers).toContain(
			"mixed-resolution-order-unresolved",
		);
		const duplicate = mixed();
		duplicate.automaticTemplates = [
			{ id: "first", height: 200 },
			{ id: "upper", height: 1200 },
		];
		expect(assess(duplicate).blockers).toContain("invalid-template-identities");
	});
	it("requires bounded fixed rows and unchanged global envelope for a role assessment", () => {
		const goal = mixed();
		goal.rows = goal.rows?.map((row) =>
			row.id === "first" ? { ...row, maxBitrate: undefined } : row,
		);
		expect(assess(goal).blockers).toContain("fixed-ranges-unresolved");
		const valid = mixed();
		const proposal = tunePerTitleSettings(valid, valid).proposal;
		proposal.api.global.maxBitrate++;
		expect(assessPerTitleCountStructure(valid, proposal).blockers).toContain(
			"settings-mismatch",
		);
	});
	it("supports a consistent width basis alongside explicit heights", () => {
		const goal = mixed();
		goal.rows = goal.rows?.map((row) => {
			if (row.height === undefined)
				throw new Error("Fixture height is required");
			return { ...row, width: row.height * 2 };
		});
		goal.automaticTemplates = goal.automaticTemplates?.map((row) => ({
			...row,
			width: (row.height ?? 0) * 2,
		}));
		expect(assess(goal).status).toBe("declared-compatible");
	});
	it("matches role identities and dimensions to the declared input", () => {
		const goal = mixed();
		const proposal = tunePerTitleSettings(goal, goal).proposal;
		const first = proposal.api.streams.find(
			(stream) => stream.rowId === "first",
		);
		if (!first) throw new Error("Expected the explicit fixed template.");
		first.rowId = "detached";
		expect(assessPerTitleCountStructure(goal, proposal).blockers).toContain(
			"template-roles-mismatch",
		);
		first.rowId = "first";
		first.height = 420;
		expect(assessPerTitleCountStructure(goal, proposal).blockers).toContain(
			"template-roles-mismatch",
		);
	});
});
