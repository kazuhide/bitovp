import type { PerTitleGoal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	applyPerTitleAdvice,
	hasAutomaticPerTitleSettings,
	perTitleAdvice,
} from "./per-title-simulator-advice";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const mixed: PerTitleGoal = {
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
		{ id: "small", height: 120 },
		{ id: "upper", height: 1080 },
	],
	targetQualityCrf: 18,
	resolutionScaleFactor: 0,
};
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Expected fixture value.");
	return value;
}
const changeRow = (
	goal: PerTitleGoal,
	id: string,
	key: string,
	value: number,
): PerTitleGoal => ({
	...goal,
	rows: goal.rows?.map((row) =>
		row.id === id ? { ...row, [key]: value } : row,
	),
});

describe("dependent Per-Title advice", () => {
	it("proposes only previously coupled high boundaries and holds the edited maximum", () => {
		const previous = structuredClone(mixed);
		const current = { ...previous, maxBitrate: 8_000_000 };
		const snapshot = structuredClone(current);
		const advice = perTitleAdvice(previous, current, {
			scope: "global",
			key: "maxBitrate",
		});
		const item = advice.find((a) => a.reason === "upper-boundary");
		expect(item).toBeDefined();
		expect(
			item?.changes.map((c) => [c.rowId, c.key, c.before, c.after]),
		).toEqual([
			["a", "highComplexityBoundaryForMaxBitrate", 4_000_000, 8_000_000],
			["b", "highComplexityBoundaryForMaxBitrate", 4_000_000, 8_000_000],
		]);
		expect(item?.goal.maxBitrate).toBe(8_000_000);
		expect(item?.proof).toBe("conditional-settings");
		expect(item?.proposal.api.global.targetQualityCrf).toBe(18);
		expect(item?.proposal.api.global.resolutionScaleFactor).toBe(0);
		expect(current).toEqual(snapshot);
		expect(previous).toEqual(mixed);
		expect(applyPerTitleAdvice(current, required(item))).toEqual(item?.goal);
		expect(
			applyPerTitleAdvice(
				{ ...current, maxBitrate: 9_000_000 },
				required(item),
			),
		).toBeNull();
	});
	it("does not overwrite a custom high boundary", () => {
		const previous = changeRow(
			mixed,
			"a",
			"highComplexityBoundaryForMaxBitrate",
			3_000_000,
		);
		const item = perTitleAdvice(
			previous,
			{ ...previous, maxBitrate: 8_000_000 },
			{ scope: "global", key: "maxBitrate" },
		).find((a) => a.reason === "upper-boundary");
		expect(item?.changes.map((c) => c.rowId)).toEqual(["b"]);
		expect(item?.goal.rows?.[0]?.highComplexityBoundaryForMaxBitrate).toBe(
			3_000_000,
		);
	});
	it("recalculates coupled lows after a highest fixed minimum or minimum step edit", () => {
		for (const [current, edit, expected] of [
			[
				changeRow(mixed, "b", "minBitrate", 1_200_000),
				{ scope: "stream", key: "minBitrate", rowId: "b" },
				1_500_000,
			],
			[
				{ ...mixed, minBitrateStepSize: 1.5 },
				{ scope: "global", key: "minBitrateStepSize" },
				1_500_000,
			],
		] as const) {
			const item = perTitleAdvice(mixed, current, edit).find(
				(a) => a.reason === "lower-boundary",
			);
			expect(item).toBeDefined();
			expect(item?.changes.every((c) => c.after === expected)).toBe(true);
			expect(item?.facts.highestFixedMinimum).toBe(
				current.rows?.[1]?.minBitrate,
			);
			expect(item?.proposal.api.global.minBitrateStepSize).toBe(
				current.minBitrateStepSize,
			);
		}
	});
	it("does not claim the shared mixed recipe with generated or ambiguous candidates", () => {
		for (const previous of [
			{ ...mixed, autoRepresentations: {} },
			{ ...mixed, automaticTemplates: [{ id: "unknown" }] },
		]) {
			const result = perTitleAdvice(
				previous,
				{ ...previous, minBitrateStepSize: 1.5 },
				{ scope: "global", key: "minBitrateStepSize" },
			);
			expect(result.some((a) => a.reason === "lower-boundary")).toBe(false);
		}
	});
	it("repairs an outside row by enlarging the global bound, without undoing the row edit", () => {
		const current = changeRow(mixed, "b", "maxBitrate", 5_000_000);
		const item = perTitleAdvice(mixed, current, {
			scope: "stream",
			key: "maxBitrate",
			rowId: "b",
		}).find((a) => a.reason === "global-range");
		expect(item?.goal.rows?.[1]?.maxBitrate).toBe(5_000_000);
		expect(item?.goal.maxBitrate).toBe(5_000_000);
	});
	it("holds a lowered global maximum and changes only a feasible offending row endpoint", () => {
		const current = { ...mixed, maxBitrate: 1_400_000 };
		const item = perTitleAdvice(mixed, current, {
			scope: "global",
			key: "maxBitrate",
		}).find((a) => a.reason === "row-range");
		expect(item?.goal.maxBitrate).toBe(1_400_000);
		expect(item?.goal.rows?.[1]?.maxBitrate).toBe(1_400_000);
		expect(item?.changes.some((c) => c.scope === "global")).toBe(false);
		const impossible = { ...mixed, maxBitrate: 500_000 };
		expect(
			perTitleAdvice(mixed, impossible, { scope: "global", key: "maxBitrate" }),
		).toEqual([]);
	});
	it("uses the actual solver for a count edit, then adopts exact settings as fixed", () => {
		const previous: PerTitleGoal = {
			strategy: "count",
			codec: "VP9",
			minBitrate: 100_000,
			maxBitrate: 8_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "exact", count: 5 },
		};
		const current: PerTitleGoal = {
			...previous,
			countPolicy: { kind: "exact", count: 3 },
		};
		const item = perTitleAdvice(previous, current, {
			scope: "count",
			key: "count",
		}).find((a) => a.reason === "spacing");
		expect(item).toBeDefined();
		expect(item?.proof).toBe("model-count");
		expect(item?.proposal.derivation?.targetSatisfied).toBe(true);
		expect(item?.goal.countPolicy).toEqual(current.countPolicy);
		for (const c of item?.changes ?? [])
			expect(item?.goal.adjustments?.global?.[c.key]?.mode).toBe("fixed");
	});
	it("keeps the latest step and all templates or forced fields unchanged", () => {
		const previous: PerTitleGoal = {
			strategy: "count",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 8_000_000,
			minBitrateStepSize: 2,
			maxBitrateStepSize: 2,
			countPolicy: { kind: "exact", count: 3 },
		};
		const current = { ...previous, minBitrateStepSize: 3 };
		for (const item of perTitleAdvice(previous, current, {
			scope: "global",
			key: "minBitrateStepSize",
		})) {
			expect(item.goal.minBitrateStepSize).toBe(3);
			expect(item.changes.every((c) => c.key !== "minBitrateStepSize")).toBe(
				true,
			);
		}
		const fixedRule = {
			...mixed,
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.1,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE" as const,
			},
		};
		for (const item of perTitleAdvice(
			fixedRule,
			{ ...fixedRule, maxBitrate: 8_000_000 },
			{ scope: "global", key: "maxBitrate" },
		)) {
			expect(item.goal.automaticTemplates).toEqual(
				fixedRule.automaticTemplates,
			);
			expect(item.goal.fixedResolutionAndBitrateConfiguration).toEqual(
				fixedRule.fixedResolutionAndBitrateConfiguration,
			);
		}
	});
	it("suppresses unchanged inputs, false edit descriptions and oversized inputs", () => {
		expect(
			perTitleAdvice(mixed, mixed, { scope: "global", key: "maxBitrate" }),
		).toEqual([]);
		expect(
			perTitleAdvice(
				mixed,
				{ ...mixed, maxBitrate: 8_000_000, minBitrate: 200_000 },
				{ scope: "global", key: "maxBitrate" },
			),
		).toEqual([]);
		const huge = {
			...mixed,
			rows: Array.from({ length: 65 }, (_, i) => ({
				...required(mixed.rows?.[0]),
				id: String(i),
			})),
		};
		expect(
			perTitleAdvice(
				huge,
				{ ...huge, maxBitrate: 8_000_000 },
				{ scope: "global", key: "maxBitrate" },
			),
		).toEqual([]);
	});
	it("rechecks the final adopted API, is deterministic, and rejects metadata-stale advice", () => {
		const current = { ...mixed, maxBitrate: 8_000_000 };
		expect(hasAutomaticPerTitleSettings(current)).toBe(false);
		const advice = perTitleAdvice(mixed, current, {
			scope: "global",
			key: "maxBitrate",
		});
		expect(advice.length).toBeGreaterThan(0);
		expect(advice.length).toBeLessThanOrEqual(3);
		expect(
			perTitleAdvice(mixed, current, { scope: "global", key: "maxBitrate" }),
		).toEqual(advice);
		for (const item of advice) {
			expect(tunePerTitleSettings(item.goal, item.goal).proposal.api).toEqual(
				item.proposal.api,
			);
			expect(
				applyPerTitleAdvice(
					{
						...current,
						adjustments: { global: { targetQualityCrf: { mode: "fixed" } } },
					},
					item,
				),
			).toBeNull();
			expect(
				applyPerTitleAdvice(current, {
					...item,
					goal: { ...item.goal, maxBitrate: 9_000_000 },
				}),
			).toBeNull();
		}
	});
	it("does not hide invalid pinned inputs or manufacture quality advice", () => {
		const invalid = { ...mixed, targetQualityCrf: Number.NaN };
		expect(
			perTitleAdvice(
				invalid,
				{ ...invalid, maxBitrate: 8_000_000 },
				{ scope: "global", key: "maxBitrate" },
			),
		).toEqual([]);
		expect(
			perTitleAdvice(
				mixed,
				{ ...mixed, targetQualityCrf: 20 },
				{ scope: "global", key: "targetQualityCrf" },
			),
		).toEqual([]);
		expect(
			perTitleAdvice(
				mixed,
				{ ...mixed, maxBitrate: Number.NaN },
				{ scope: "global", key: "maxBitrate" },
			),
		).toEqual([]);
	});
	it("repairs a lowered row minimum by widening only the global minimum", () => {
		const current = changeRow(mixed, "a", "minBitrate", 50_000);
		const item = perTitleAdvice(mixed, current, {
			scope: "stream",
			key: "minBitrate",
			rowId: "a",
		}).find((a) => a.reason === "global-range");
		expect(item?.changes).toEqual([
			{ scope: "global", key: "minBitrate", before: 100_000, after: 50_000 },
		]);
		expect(item?.goal.rows?.[0]?.minBitrate).toBe(50_000);
	});
	it("suppresses existing explicit Auto policies because the immutable anchor is not provided", () => {
		for (const adjustments of [
			{
				global: {
					minBitrate: {
						mode: "auto" as const,
						method: "proportional" as const,
					},
				},
			},
			{
				streams: {
					a: {
						maxBitrate: {
							mode: "auto" as const,
							method: "logarithmic" as const,
						},
					},
				},
			},
		]) {
			const previous = { ...mixed, adjustments };
			expect(hasAutomaticPerTitleSettings(previous)).toBe(true);
			expect(
				perTitleAdvice(
					previous,
					{ ...previous, maxBitrate: 8_000_000 },
					{ scope: "global", key: "maxBitrate" },
				),
			).toEqual([]);
		}
	});
	it("offers a real step repair while preserving the newly fixed minimum step", () => {
		const previous: PerTitleGoal = {
			strategy: "count",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 8_000_000,
			minBitrateStepSize: 2,
			maxBitrateStepSize: 2,
			countPolicy: { kind: "exact", count: 3 },
		};
		const current = { ...previous, minBitrateStepSize: 5 };
		const item = perTitleAdvice(previous, current, {
			scope: "global",
			key: "minBitrateStepSize",
		}).find((a) => a.reason === "spacing");
		expect(item).toBeDefined();
		expect(item?.goal.minBitrateStepSize).toBe(5);
		expect(item?.changes.map((c) => c.key)).toEqual(["maxBitrateStepSize"]);
		expect(item?.proposal.api.global.maxBitrateStepSize).toBeGreaterThanOrEqual(
			5,
		);
		expect(item?.proposal.derivation?.targetSatisfied).toBe(true);
	});
	it.each([
		["maxBitrate", 8_000_000],
		["minBitrate", 400_000],
	] as const)("recalculates exact-count steps after editing global %s", (key, value) => {
		const previous: PerTitleGoal = {
			strategy: "count",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 4_000_000,
			minBitrateStepSize: 4,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "exact", count: 3 },
		};
		const current = { ...previous, [key]: value };
		const item = perTitleAdvice(previous, current, {
			scope: "global",
			key,
		}).find((a) => a.reason === "spacing");
		expect(item).toBeDefined();
		expect(item?.goal[key]).toBe(value);
		expect(item?.proof).toBe("model-count");
		expect(item?.proposal.derivation?.targetSatisfied).toBe(true);
		expect(
			item?.changes.every(
				(c) =>
					c.scope === "global" &&
					["minBitrateStepSize", "maxBitrateStepSize"].includes(c.key),
			),
		).toBe(true);
		expect(item?.goal.rows).toEqual(current.rows);
	});

	it("withholds row-range spacing advice when the final solver cannot establish a repair", () => {
		const previous: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 4_000_000,
			minBitrateStepSize: 2,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "unrestricted" },
			rows: [
				{ id: "a", height: 240, minBitrate: 200_000, maxBitrate: 200_000 },
				{ id: "b", height: 480, minBitrate: 400_000, maxBitrate: 800_000 },
				{ id: "c", height: 720, minBitrate: 1_200_000, maxBitrate: 1_200_000 },
			],
		};
		const current = changeRow(previous, "b", "minBitrate", 700_000);
		const item = perTitleAdvice(previous, current, {
			scope: "stream",
			key: "minBitrate",
			rowId: "b",
		}).find((a) => a.reason === "spacing");
		expect(item).toBeUndefined();
		expect(tunePerTitleSettings(current, current).proposal.applicable).toBe(
			false,
		);
		expect(current.rows?.[1]?.minBitrate).toBe(700_000);
	});
	it("does not turn a mixed range edit into unverified count advice", () => {
		const previous: PerTitleGoal = {
			...mixed,
			countPolicy: { kind: "exact", count: 6 },
		};
		const current = { ...previous, maxBitrate: 8_000_000 };
		const items = perTitleAdvice(previous, current, {
			scope: "global",
			key: "maxBitrate",
		});
		expect(items.filter((item) => item.reason === "spacing")).toEqual([]);
		expect(items.length).toBeLessThanOrEqual(3);
	});

	it("uses the mixed low recipe when Fixed unset disables automatic resolution generation", () => {
		const previous = { ...mixed, autoRepresentations: undefined };
		expect(
			tunePerTitleSettings(previous, previous).proposal.api.global
				.autoRepresentations,
		).toBeUndefined();
		const current = { ...previous, minBitrateStepSize: 1.5 };
		const item = perTitleAdvice(previous, current, {
			scope: "global",
			key: "minBitrateStepSize",
		}).find((a) => a.reason === "lower-boundary");
		expect(item).toBeDefined();
		expect(item?.changes.every((change) => change.after === 1_500_000)).toBe(
			true,
		);
		expect(item?.goal.autoRepresentations).toBeUndefined();
	});
});
