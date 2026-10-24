import type { PerTitleGoal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	applyPerTitleAdvice,
	type PerTitleAdviceField,
	type PerTitleAdviceOptions,
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
});

const lowerBounds: PerTitleAdviceField[] = [
	{ scope: "stream", rowId: "a", key: "minBitrate" },
	{ scope: "stream", rowId: "a", key: "maxBitrate" },
];
const expansion = { scope: "global", key: "maxBitrate" } as const;
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Expected a protected adjustment.");
	return value;
}

describe("protected Per-Title advice", () => {
	it("regrounds free upper rows while retaining both protected lower bounds", () => {
		const previous = source();
		const current = { ...previous, maxBitrate: 8_000_000 };
		const snapshots = structuredClone({ previous, current });
		const options = { protectedFields: lowerBounds };
		const items = perTitleAdvice(previous, current, expansion, options);
		const advice = required(items[0]);
		expect(items).toHaveLength(1);
		expect(advice.reason).toBe("joint-range");
		expect(advice.goal.maxBitrate).toBe(8_000_000);
		expect(advice.goal.rows?.[0]).toMatchObject({
			id: "a",
			minBitrate: 200_000,
			maxBitrate: 400_000,
		});
		expect(advice.goal.rows?.[1]?.minBitrate).toBeGreaterThan(1_000_000);
		expect(advice.goal.rows?.[1]?.maxBitrate).toBeGreaterThan(1_600_000);
		for (const row of advice.goal.rows ?? []) {
			expect(row.minBitrate).toBeLessThanOrEqual(row.maxBitrate ?? 0);
			expect(row.minBitrate).toBeGreaterThanOrEqual(advice.goal.minBitrate);
			expect(row.maxBitrate).toBeLessThanOrEqual(advice.goal.maxBitrate);
		}
		expect(
			advice.changes.some(
				(change) =>
					change.rowId === "a" &&
					["minBitrate", "maxBitrate"].includes(change.key),
			),
		).toBe(false);
		expect(applyPerTitleAdvice(current, advice, options)).toEqual(advice.goal);
		expect({ previous, current }).toEqual(snapshots);
	});

	it("does not apply unprotected advice after protections have been added", () => {
		const previous = source();
		const current = { ...previous, maxBitrate: 8_000_000 };
		const advice = required(perTitleAdvice(previous, current, expansion)[0]);
		expect(advice.goal.rows?.[0]?.minBitrate).not.toBe(200_000);
		expect(
			applyPerTitleAdvice(current, advice, { protectedFields: lowerBounds }),
		).toBeNull();
	});

	it("keeps a protected upper complexity boundary while rebuilding free ranges", () => {
		const previous = source();
		const current = { ...previous, maxBitrate: 8_000_000 };
		const protectedFields: PerTitleAdviceField[] = [
			...lowerBounds,
			{
				scope: "stream",
				rowId: "a",
				key: "highComplexityBoundaryForMaxBitrate",
			},
		];
		const advice = required(
			perTitleAdvice(previous, current, expansion, { protectedFields })[0],
		);
		expect(advice.reason).toBe("joint-range");
		expect(advice.goal.rows?.[0]?.highComplexityBoundaryForMaxBitrate).toBe(
			4_000_000,
		);
		expect(advice.goal.rows?.[1]?.maxBitrate).toBeGreaterThan(1_600_000);
		expect(
			advice.changes.some(
				(change) =>
					change.rowId === "a" &&
					change.key === "highComplexityBoundaryForMaxBitrate",
			),
		).toBe(false);
	});

	it("retains a protected additional factor while recomputing free ranges", () => {
		const previous = source();
		const current = { ...previous, maxBitrate: 8_000_000 };
		const protectedFields: PerTitleAdviceField[] = [
			{
				scope: "global",
				key: "fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationFactor",
			},
		];
		const advice = required(
			perTitleAdvice(previous, current, expansion, { protectedFields })[0],
		);
		expect(advice.reason).toBe("joint-range");
		expect(
			advice.goal.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBe(1.2);
		expect(advice.goal.rows?.[1]?.maxBitrate).toBeGreaterThan(1_600_000);
	});

	it("retains both protected steps for a feasible increase with free range changes", () => {
		const previous = { ...source(), maxBitrateStepSize: 8 };
		const current = { ...previous, maxBitrate: 4_100_000 };
		const protectedFields: PerTitleAdviceField[] = [
			{ scope: "global", key: "minBitrateStepSize" },
			{ scope: "global", key: "maxBitrateStepSize" },
		];
		const advice = required(
			perTitleAdvice(previous, current, expansion, { protectedFields })[0],
		);
		expect(advice.reason).toBe("joint-range");
		expect(advice.goal.minBitrateStepSize).toBe(1.25);
		expect(advice.goal.maxBitrateStepSize).toBe(8);
		expect(advice.goal.rows?.[1]?.minBitrate).toBeGreaterThan(1_000_000);
		expect(advice.goal.maxBitrate).toBe(4_100_000);
	});

	it("withholds an expansion when a protected minimum step would add placement room", () => {
		const previous = source();
		const current = { ...previous, maxBitrate: 8_000_000 };
		const items = perTitleAdvice(previous, current, expansion, {
			protectedFields: [{ scope: "global", key: "minBitrateStepSize" }],
		});
		expect(items.some((item) => item.reason === "joint-range")).toBe(false);
		expect(current.minBitrateStepSize).toBe(1.25);
	});

	it("binds protected advice to its exact normalized protection set", () => {
		const previous = source();
		const current = { ...previous, maxBitrate: 8_000_000 };
		const options = { protectedFields: lowerBounds };
		const advice = required(
			perTitleAdvice(previous, current, expansion, options)[0],
		);
		expect(applyPerTitleAdvice(current, advice)).toBeNull();
		expect(
			applyPerTitleAdvice(current, advice, {
				protectedFields: [{ scope: "stream", rowId: "b", key: "minBitrate" }],
			}),
		).toBeNull();
		expect(applyPerTitleAdvice(current, advice, options)).toEqual(advice.goal);
		expect(
			applyPerTitleAdvice(
				{ ...current, maxBitrate: 9_000_000 },
				advice,
				options,
			),
		).toBeNull();
	});

	it("normalizes protection order and duplicate fields without changing the proposal", () => {
		const previous = source();
		const current = { ...previous, maxBitrate: 8_000_000 };
		const advice = required(
			perTitleAdvice(previous, current, expansion, {
				protectedFields: lowerBounds,
			})[0],
		);
		const reordered = {
			protectedFields: [
				required(lowerBounds[1]),
				required(lowerBounds[0]),
				required(lowerBounds[1]),
			],
		};
		const equivalent = required(
			perTitleAdvice(previous, current, expansion, reordered)[0],
		);
		expect(equivalent.proposal.api).toEqual(advice.proposal.api);
		expect(equivalent.inputFingerprint).toBe(advice.inputFingerprint);
		expect(applyPerTitleAdvice(current, advice, reordered)).toEqual(
			advice.goal,
		);
	});

	it("repairs only an unprotected local lower boundary", () => {
		const previous = source();
		const current = { ...previous, minBitrateStepSize: 1.5 };
		const options = {
			protectedFields: [
				{
					scope: "stream" as const,
					rowId: "a",
					key: "lowComplexityBoundaryForMaxBitrate",
				},
			],
		};
		const advice = required(
			perTitleAdvice(
				previous,
				current,
				{ scope: "global", key: "minBitrateStepSize" },
				options,
			).find((item) => item.reason === "lower-boundary"),
		);
		expect(advice.changes).toEqual([
			{
				scope: "stream",
				rowId: "b",
				key: "lowComplexityBoundaryForMaxBitrate",
				before: 1_250_000,
				after: 1_500_000,
			},
		]);
		expect(advice.goal.rows?.[0]?.lowComplexityBoundaryForMaxBitrate).toBe(
			1_250_000,
		);
		expect(advice.goal.minBitrateStepSize).toBe(1.5);
		expect(applyPerTitleAdvice(current, advice, options)).toEqual(advice.goal);
	});

	it("does not turn a count edit into changes to protected spacing", () => {
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
		const edit = { scope: "count", key: "count" } as const;
		expect(
			perTitleAdvice(previous, current, edit).some(
				(item) => item.reason === "spacing" && item.proof === "model-count",
			),
		).toBe(true);
		expect(
			perTitleAdvice(previous, current, edit, {
				protectedFields: [
					{ scope: "global", key: "minBitrateStepSize" },
					{ scope: "global", key: "maxBitrateStepSize" },
				],
			}),
		).toEqual([]);
		expect(current.countPolicy).toEqual({ kind: "exact", count: 3 });
	});

	it.each([
		["null list", null],
		["non-array list", {}],
		["null field", [null]],
		["unknown scope", [{ scope: "count", key: "count" }]],
		["unknown key", [{ scope: "global", key: "unknownSetting" }]],
		["missing row", [{ scope: "stream", key: "minBitrate" }]],
		["unknown row", [{ scope: "stream", rowId: "missing", key: "minBitrate" }]],
		[
			"oversized list",
			Array.from({ length: 4097 }, () => ({
				scope: "global",
				key: "maxBitrate",
			})),
		],
	])("rejects malformed protection input: %s", (_name, protectedFields) => {
		const previous = source();
		const current = { ...previous, maxBitrate: 8_000_000 };
		const advice = required(perTitleAdvice(previous, current, expansion)[0]);
		const options = {
			protectedFields,
		} as unknown as PerTitleAdviceOptions;
		expect(perTitleAdvice(previous, current, expansion, options)).toHaveLength(
			0,
		);
		expect(applyPerTitleAdvice(current, advice, options)).toBeNull();
	});
});
