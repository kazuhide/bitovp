import type { PerTitleGoal, PerTitleProposal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";
import { assessPerTitleUpperLimit } from "./per-title-simulator-upper-limit";

const mixed = (): PerTitleGoal => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 1,
	maxBitrate: 390,
	minBitrateStepSize: 2,
	maxBitrateStepSize: 4,
	countPolicy: { kind: "exact", count: 3 },
	autoRepresentations: false,
	fixedResolutionAndBitrateConfiguration: {
		forcedRenditionAboveHighestFixedRepresentation: 1,
		forcedRenditionAboveHighestFixedRepresentationFactor: 1.5,
		forcedRenditionAboveHighestFixedRepresentationCalculationMode:
			"LAST_CALCULATED_BITRATE",
	},
	rows: [
		{
			id: "fixed",
			height: 400,
			minBitrate: 100,
			maxBitrate: 100,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 150,
			highComplexityBoundaryForMaxBitrate: 390,
		},
	],
	automaticTemplates: [
		{ id: "lower", height: 200 },
		{ id: "upper-a", height: 600 },
		{ id: "upper-b", height: 800 },
	],
});
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Expected fixture value");
	return value;
}
const proposal = (goal: PerTitleGoal) =>
	tunePerTitleSettings(goal, goal).proposal;
const assess = (goal: PerTitleGoal) =>
	assessPerTitleUpperLimit(goal, proposal(goal));

describe("mixed upper-output requirement", () => {
	it("certifies one upper output over the entire conditional driver domain", () => {
		const goal = mixed();
		const saved = structuredClone(goal);
		const current = proposal(goal);
		const original = structuredClone(current);
		const result = assessPerTitleUpperLimit(goal, current);
		expect(result.status).toBe("satisfied");
		expect(result.limit).toBe(1);
		expect(result.highestFixedRowId).toBe("fixed");
		expect(result.domain).toEqual({ minimum: 150, maximum: 390 });
		expect(result.finding).toBeNull();
		expect(goal).toEqual(saved);
		expect(current).toEqual(original);
	});
	it("finds an interior violation that a global-cap endpoint misses", () => {
		const goal = mixed();
		goal.maxBitrate = 200;
		goal.maxBitrateStepSize = 3;
		goal.rows = [
			{
				...required(goal.rows?.[0]),
				minBitrate: 10,
				maxBitrate: 100,
				lowComplexityBoundaryForMaxBitrate: 100,
				highComplexityBoundaryForMaxBitrate: 200,
			},
		];
		const result = assess(goal);
		expect(result.status).toBe("conflict");
		expect(result.finding?.code).toBe("upper-output-limit");
		expect(result.witness?.input).toBeLessThan(200);
		expect(result.witness?.ordinary.length).toBe(2);
	});
	it("includes equality at the second legal upper rung", () => {
		const goal = mixed();
		goal.maxBitrate = 400;
		const result = assess(goal);
		expect(result.status).toBe("conflict");
		expect(result.witness?.ordinary).toEqual([200, 400]);
	});
	it("does not mistake a single reusable upper template for a one-output cap", () => {
		const goal = mixed();
		goal.maxBitrate = 400;
		goal.automaticTemplates = required(goal.automaticTemplates).slice(0, 2);
		expect(assess(goal).status).toBe("conflict");
	});
	it("does not certify the rounded root at the native tolerance boundary", () => {
		const goal = mixed();
		goal.maxBitrate = 159201;
		goal.minBitrateStepSize = 4;
		goal.maxBitrateStepSize = 16;
		goal.rows = [
			{
				...required(goal.rows?.[0]),
				minBitrate: 10000,
				maxBitrate: 10000,
				lowComplexityBoundaryForMaxBitrate: 15000,
				highComplexityBoundaryForMaxBitrate: 159201,
			},
		];
		expect(159201).toBeLessThan(10000 * (4 - 0.01) ** 2);
		const result = assess(goal);
		expect(result.status).toBe("unknown");
		expect(result.finding?.code).toBe("upper-output-limit-unverified");
	});
	it("uses a truncated driver floor and separately rounded forced outputs", () => {
		const goal = mixed();
		goal.maxBitrate = 200;
		goal.rows = [
			{
				...required(goal.rows?.[0]),
				minBitrate: 101,
				maxBitrate: 101,
				lowComplexityBoundaryForMaxBitrate: 151,
				highComplexityBoundaryForMaxBitrate: 200,
			},
		];
		const result = assess(goal);
		expect(result.status).toBe("satisfied");
		expect(result.domain?.minimum).toBe(151);
	});
	it("does not add a forced fallback to an ordinary output", () => {
		const result = assess(mixed());
		expect(result.status).toBe("satisfied");
	});
	it("reports a reachable two-output forced fallback as a requirement conflict", () => {
		const goal = mixed();
		goal.maxBitrate = 180;
		goal.fixedResolutionAndBitrateConfiguration = {
			...required(goal.fixedResolutionAndBitrateConfiguration),
			forcedRenditionAboveHighestFixedRepresentation: 2,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.1,
		};
		expect(assess(goal).status).toBe("conflict");
	});
	it("includes the interior q-activation downward jump", () => {
		const goal = mixed();
		goal.minBitrate = 10;
		goal.maxBitrate = 4000;
		goal.maxBitrateStepSize = 5;
		goal.rows = [
			{
				...required(goal.rows?.[0]),
				minBitrate: 100,
				maxBitrate: 2000,
				lowComplexityBoundaryForMaxBitrate: 1,
				highComplexityBoundaryForMaxBitrate: 1000,
			},
		];
		expect(assess(goal).status).toBe("satisfied");
	});
	it("does not infer the upper requirement from forced count alone", () => {
		const goal = mixed();
		goal.countPolicy = { kind: "unrestricted" };
		expect(assess(goal).status).toBe("not-applicable");
	});
	it("leaves unsupported calculation modes unknown after recognizing the budget", () => {
		const goal = mixed();
		required(
			goal.fixedResolutionAndBitrateConfiguration,
		).forcedRenditionAboveHighestFixedRepresentationCalculationMode = "AVERAGE";
		const result = assess(goal);
		expect(result.limit).toBe(1);
		expect(result.status).toBe("unknown");
	});
	it.each([
		"missing",
		"reversed",
	] as const)("leaves %s complexity boundaries unknown", (kind) => {
		const goal = mixed();
		goal.rows = [
			{
				...required(goal.rows?.[0]),
				lowComplexityBoundaryForMaxBitrate:
					kind === "missing" ? undefined : 400,
			},
		];
		expect(assess(goal).status).toBe("unknown");
	});
	it("does not certify generated automatic resolutions", () => {
		const goal = mixed();
		goal.autoRepresentations = {};
		expect(assess(goal).status).toBe("unknown");
	});
	it("rejects conflicting width/height order", () => {
		const goal = mixed();
		goal.rows = [{ ...required(goal.rows?.[0]), width: 800 }];
		goal.automaticTemplates = [
			{ id: "lower", height: 200, width: 400 },
			{ id: "upper", height: 800, width: 600 },
		];
		expect(assess(goal).status).toBe("unknown");
	});
	it("keeps an unprovable near-boundary envelope unknown within a bounded search", () => {
		const goal = mixed();
		goal.maxBitrate = 399;
		const result = assess(goal);
		expect(result.status).toBe("unknown");
		expect(result.finding?.severity).toBe("conflict");
	});
	it("does not accept a malformed proposal or a different template identity", () => {
		const goal = mixed();
		expect(assessPerTitleUpperLimit(goal, {} as PerTitleProposal).status).toBe(
			"unknown",
		);
		const current = proposal(goal);
		required(current.api.streams[0]).rowId = "unrelated";
		expect(assessPerTitleUpperLimit(goal, current).status).toBe("unknown");
	});
});

describe("upper requirement metadata", () => {
	it("compares forced settings independently of property insertion order", () => {
		const goal = mixed(),
			current = proposal(goal);
		current.api.global.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"LAST_CALCULATED_BITRATE",
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.5,
			forcedRenditionAboveHighestFixedRepresentation: 1,
		};
		expect(assessPerTitleUpperLimit(goal, current).status).toBe("satisfied");
	});
	it("accepts known width ordering and rejects duplicate highest fixed dimensions", () => {
		const goal = mixed();
		goal.rows = required(goal.rows).map((row) => ({
			...row,
			width: required(row.height) * 2,
		}));
		goal.automaticTemplates = required(goal.automaticTemplates).map((row) => ({
			...row,
			width: required(row.height) * 2,
		}));
		expect(assess(goal).status).toBe("satisfied");
		goal.rows = [...goal.rows, { ...required(goal.rows[0]), id: "duplicate" }];
		goal.countPolicy = { kind: "exact", count: 4 };
		expect(assess(goal).status).toBe("unknown");
	});
	it("checks OPTIMIZED intervals without pretending the minimum is measured", () => {
		const goal = mixed();
		goal.rows = [
			{ ...required(goal.rows?.[0]), bitrateSelectionMode: "OPTIMIZED" },
		];
		expect(assess(goal).status).toBe("satisfied");
	});
	it("keeps a floor above the cap as a nonempty singleton driver domain", () => {
		const goal = mixed();
		goal.maxBitrate = 120;
		const result = assess(goal);
		expect(result.domain).toEqual({ minimum: 150, maximum: 150 });
		expect(result.status).toBe("satisfied");
	});
	it("can check an upper budget without a forced fallback", () => {
		const goal = mixed();
		goal.fixedResolutionAndBitrateConfiguration = undefined;
		expect(assess(goal).status).toBe("satisfied");
	});
});

describe("upper role structure", () => {
	it("retains duplicate lower fixed resolutions with a unique highest fixed row", () => {
		const goal = mixed(),
			top = required(goal.rows?.[0]);
		goal.rows = [
			{ ...top, id: "low-a", height: 300, minBitrate: 10, maxBitrate: 10 },
			{ ...top, id: "low-b", height: 300, minBitrate: 20, maxBitrate: 20 },
			top,
		];
		goal.countPolicy = { kind: "exact", count: 5 };
		expect(assess(goal).status).toBe("satisfied");
	});
	it("checks the low-complexity equality branch itself", () => {
		const goal = mixed();
		goal.maxBitrate = 100;
		goal.maxBitrateStepSize = 3;
		goal.rows = [
			{
				...required(goal.rows?.[0]),
				minBitrate: 10,
				maxBitrate: 100,
				lowComplexityBoundaryForMaxBitrate: 100,
				highComplexityBoundaryForMaxBitrate: 200,
			},
		];
		const result = assess(goal);
		expect(result.status).toBe("conflict");
		expect(result.witness?.input).toBe(100);
	});
	it("does not derive a hard upper limit from a maximum-count request", () => {
		const goal = mixed();
		goal.countPolicy = { kind: "maximum", count: 3 };
		expect(assess(goal)).toMatchObject({
			status: "not-applicable",
			limit: null,
			finding: null,
		});
	});
});

describe("same-input highest fixed dominance", () => {
	const overlapping = (): PerTitleGoal => {
		const goal = mixed(),
			top = required(goal.rows?.[0]);
		goal.rows = [
			{ ...top, id: "middle", height: 300, minBitrate: 50, maxBitrate: 110 },
			{ ...top, maxBitrate: 200 },
		];
		goal.countPolicy = { kind: "exact", count: 4 };
		return goal;
	};
	it("certifies overlapping configured ranges whose effective rates remain strictly ordered", () => {
		const goal = overlapping();
		expect(required(goal.rows?.[0]).maxBitrate).toBeGreaterThan(
			required(required(goal.rows?.[1]).minBitrate),
		);
		expect(assess(goal).status).toBe("satisfied");
	});
	it("does not certify equality between the highest fixed rows", () => {
		const goal = overlapping();
		goal.rows = required(goal.rows).map((row) =>
			row.id === "middle" ? { ...row, maxBitrate: 200 } : row,
		);
		expect(assess(goal).status).toBe("unknown");
	});
	it("does not infer dominance from endpoints when the fixed curves cross inside", () => {
		const goal = overlapping();
		goal.rows = required(goal.rows).map((row) =>
			row.id === "middle"
				? { ...row, maxBitrate: 190, highComplexityBoundaryForMaxBitrate: 300 }
				: row,
		);
		expect(assess(goal).status).toBe("unknown");
	});
});
