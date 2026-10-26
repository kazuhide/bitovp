import { type PerTitleGoal, recommendPerTitleSettings } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	autoTunePerTitleGoal,
	bitrateSliderBounds,
} from "./per-title-simulator-auto";

const anchor: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100000,
	maxBitrate: 10000000,
	countPolicy: { kind: "exact", count: 3 },
	rows: [
		{ id: "a", height: 240, minBitrate: 100000, maxBitrate: 200000 },
		{ id: "b", height: 480, minBitrate: 500000, maxBitrate: 1000000 },
		{ id: "c", height: 720, minBitrate: 2000000, maxBitrate: 5000000 },
	],
};

describe("automatic Per-Title requirements", () => {
	it("allocates a mixed ladder's active band without changing parked resolution-only fields", () => {
		const loaded: PerTitleGoal = {
			...anchor,
			strategy: "fixed-resolutions",
			maxBitrate: 5_000_000,
			countPolicy: { kind: "unrestricted" },
			rows: [
				{
					id: "resolution",
					height: 360,
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
					minBitrate: 120_000,
					maxBitrate: 240_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 300_000,
					highComplexityBoundaryForMaxBitrate: 600_000,
				},
				{
					id: "range",
					height: 720,
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					minBitrate: 1_000_000,
					maxBitrate: 2_000_000,
				},
			],
		};
		const goal = { ...loaded, maxBitrate: 1_500_000 };
		const before = structuredClone(goal);
		const result = autoTunePerTitleGoal(
			goal,
			{ ...loaded, rows: [] },
			{ range: { min: true } },
		);
		expect(result.rows?.[0]).toEqual(goal.rows?.[0]);
		expect(result.rows?.[1]).toMatchObject({
			minBitrate: 1_000_000,
			maxBitrate: 1_500_000,
		});
		expect(goal).toEqual(before);
	});
	it("preserves an explicit additional-rendition rule in every strategy", () => {
		const rule = {
			forcedRenditionAboveHighestFixedRepresentation: 1,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"LAST_CALCULATED_BITRATE" as const,
		};
		for (const strategy of [
			"automatic",
			"count",
			"required-resolutions",
			"fixed-resolutions",
			"fixed-ranges",
		] as const) {
			const goal = {
				...anchor,
				strategy,
				fixedResolutionAndBitrateConfiguration: rule,
			};
			const snapshot = structuredClone(goal);
			expect(
				autoTunePerTitleGoal(goal, goal, {})
					.fixedResolutionAndBitrateConfiguration,
			).toEqual(rule);
			expect(goal).toEqual(snapshot);
		}
	});
	it("passes a loaded out-of-global row through to the core conflict instead of inventing another band", () => {
		const loaded: PerTitleGoal = {
			...anchor,
			maxBitrate: 4000000,
			countPolicy: { kind: "unrestricted" },
			rows: [
				{
					id: "outside",
					height: 360,
					minBitrate: 100000,
					maxBitrate: 40000000,
				},
			],
		};
		const effective = autoTunePerTitleGoal(loaded, loaded, {});
		expect(effective.rows).toEqual(loaded.rows);
		const proposal = recommendPerTitleSettings(effective);
		expect(proposal.applicable).toBe(false);
		expect(proposal.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "row-outside-global-range",
				severity: "conflict",
				rowIds: ["outside"],
			}),
		);
		expect(proposal.api.streams[0]?.perTitleSettings?.maxBitrate).toBe(
			40000000,
		);
	});
	it("preserves matched explicit rows when repairing an invalid anchor global range", () => {
		for (const global of [
			{ minBitrate: 0, maxBitrate: 4000000 },
			{ minBitrate: 100000, maxBitrate: 0 },
			{ minBitrate: 5000000, maxBitrate: 4000000 },
		]) {
			const loaded: PerTitleGoal = {
				...anchor,
				...global,
				countPolicy: { kind: "unrestricted" },
				rows: [
					{
						id: "loaded",
						height: 360,
						minBitrate: 200000,
						maxBitrate: 40000000,
					},
				],
			};
			const snapshot = structuredClone(loaded);
			const repaired = { ...loaded, minBitrate: 100000, maxBitrate: 4000000 };
			const effective = autoTunePerTitleGoal(repaired, loaded, {});
			expect(effective.rows).toEqual(loaded.rows);
			expect(recommendPerTitleSettings(effective).diagnostics).toContainEqual(
				expect.objectContaining({
					code: "row-outside-global-range",
					severity: "conflict",
				}),
			);
			for (const fresh of [
				{ ...repaired, rows: [{ id: "new", height: 360 }] },
				{ ...repaired, codec: "VP9" as const },
			]) {
				expect(autoTunePerTitleGoal(fresh, loaded, {}).rows?.[0]).toMatchObject(
					{
						minBitrate: 100000,
						maxBitrate: 4000000,
					},
				);
			}
			expect(loaded).toEqual(snapshot);
		}
	});
	it("keeps valid explicit row bounds without logarithmic remapping from an invalid anchor", () => {
		const loaded: PerTitleGoal = {
			...anchor,
			minBitrate: 0,
			rows: [
				{ id: "loaded", height: 360, minBitrate: 200000, maxBitrate: 400000 },
			],
		};
		expect(
			autoTunePerTitleGoal({ ...loaded, minBitrate: 100000 }, loaded, {}).rows,
		).toEqual(loaded.rows);
	});
	it("retains a mixed unrestricted rule in the actual proposal rather than only in source metadata", () => {
		const loaded: PerTitleGoal = {
			...anchor,
			countPolicy: { kind: "unrestricted" },
			automaticTemplates: [{ id: "candidate", height: 1080 }],
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		};
		const result = recommendPerTitleSettings(
			autoTunePerTitleGoal(loaded, loaded, {}),
		);
		expect(result.api.global.fixedResolutionAndBitrateConfiguration).toEqual(
			loaded.fixedResolutionAndBitrateConfiguration,
		);
		expect(result.applicable).toBe(false);
	});
	it("preserves explicit malformed matched-anchor ranges for diagnostics while missing new bands still derive", () => {
		for (const row of [
			{ id: "invalid", height: 360, minBitrate: 900000, maxBitrate: 100000 },
			{ id: "invalid", height: 360, minBitrate: NaN, maxBitrate: 100000 },
			{ id: "invalid", height: 360, minBitrate: 0, maxBitrate: 100000 },
			{ id: "invalid", height: 360, minBitrate: 200000 },
		]) {
			const loaded = { ...anchor, rows: [row] };
			const effective = autoTunePerTitleGoal(loaded, loaded, {});
			expect(effective.rows).toEqual([row]);
			expect(recommendPerTitleSettings(effective).diagnostics).toContainEqual(
				expect.objectContaining({
					code: "invalid-row-range",
					severity: "conflict",
				}),
			);
			const fresh = autoTunePerTitleGoal(
				{ ...loaded, rows: [{ id: "new", height: 360 }] },
				loaded,
				{},
			);
			expect(fresh.rows?.[0]?.minBitrate).toBeGreaterThan(0);
			expect(fresh.rows?.[0]?.maxBitrate).toBeGreaterThanOrEqual(
				fresh.rows?.[0]?.minBitrate ?? Infinity,
			);
		}
	});
	it("does not automatically repair the other explicit invalid anchor endpoint during a manual edit", () => {
		const loaded: PerTitleGoal = {
			...anchor,
			rows: [
				{ id: "reversed", height: 360, minBitrate: 900000, maxBitrate: 100000 },
			],
		};
		const raw: PerTitleGoal = {
			...loaded,
			rows: [
				{ id: "reversed", height: 360, minBitrate: 150000, maxBitrate: 100000 },
			],
		};
		const next = autoTunePerTitleGoal(raw, loaded, { reversed: { min: true } });
		expect(next.rows).toEqual(raw.rows);
		expect(recommendPerTitleSettings(next).diagnostics).toContainEqual(
			expect.objectContaining({ code: "invalid-row-range" }),
		);
	});
	it("anchors a usable slider domain and caps it at the supported integer limit", () => {
		expect(bitrateSliderBounds(anchor)).toEqual({
			min: 100000,
			max: 40000000,
			step: 10000,
		});
		expect(bitrateSliderBounds({ ...anchor, maxBitrate: 2000000000 }).max).toBe(
			2147483647,
		);
		for (const maxBitrate of [Number.NaN, Infinity, -1]) {
			const domain = bitrateSliderBounds({ ...anchor, maxBitrate });
			expect(domain.max).toBeGreaterThan(domain.min);
			expect(domain.step).toBeGreaterThan(0);
		}
	});
	it("preserves loaded valid bands exactly at unchanged global bounds", () => {
		expect(autoTunePerTitleGoal(anchor, anchor, {}).rows).toEqual(anchor.rows);
	});
	it("does not change anchored requirements when only the requested count changes", () => {
		for (const count of [1, 6, 256]) {
			const goal = {
				...anchor,
				countPolicy: { kind: "exact" as const, count },
			};
			expect(autoTunePerTitleGoal(goal, anchor, {}).rows).toEqual(anchor.rows);
			expect(autoTunePerTitleGoal(goal, anchor, {}).countPolicy).toEqual(
				goal.countPolicy,
			);
		}
	});
	it("maps anchor positions in log space without cumulative slider drift", () => {
		const next = autoTunePerTitleGoal(
			{ ...anchor, minBitrate: 10000, maxBitrate: 100000000 },
			anchor,
			{},
		);
		expect(next.rows?.[1]).toMatchObject({
			minBitrate: 250000,
			maxBitrate: 1000000,
		});
		expect(
			autoTunePerTitleGoal(
				{
					...next,
					minBitrate: anchor.minBitrate,
					maxBitrate: anchor.maxBitrate,
				},
				anchor,
				{},
			).rows,
		).toEqual(anchor.rows);
	});
	it("scales all automatic bounds monotonically as the global maximum rises", () => {
		let previous = autoTunePerTitleGoal(anchor, anchor, {});
		for (const maxBitrate of [12000000, 20000000, 100000000]) {
			const next = autoTunePerTitleGoal({ ...anchor, maxBitrate }, anchor, {});
			for (let i = 0; i < 3; i++) {
				expect(next.rows?.[i]?.minBitrate).toBeGreaterThanOrEqual(
					previous.rows?.[i]?.minBitrate ?? 0,
				);
				expect(next.rows?.[i]?.maxBitrate).toBeGreaterThanOrEqual(
					previous.rows?.[i]?.maxBitrate ?? 0,
				);
			}
			previous = next;
		}
	});
	it("pins either manual bound verbatim and moves only its automatic counterpart", () => {
		const goal: PerTitleGoal = {
			...anchor,
			maxBitrate: 20000000,
			rows: [{ id: "a", height: 240, minBitrate: 7000000 }],
		};
		const minimum = autoTunePerTitleGoal(goal, anchor, { a: { min: true } });
		expect(minimum.rows?.[0]).toMatchObject({
			minBitrate: 7000000,
			maxBitrate: 7000000,
		});
		const maximum = autoTunePerTitleGoal(
			{ ...goal, rows: [{ id: "a", height: 240, maxBitrate: 150000 }] },
			anchor,
			{ a: { max: true } },
		);
		expect(maximum.rows?.[0]).toMatchObject({
			minBitrate: 100000,
			maxBitrate: 150000,
		});
	});
	it("never repairs an invalid manual value or reversed manual band", () => {
		for (const value of [0, -1, Number.NaN, 20000000, 9999999999, undefined]) {
			const goal = {
				...anchor,
				rows: [{ id: "a", height: 240, minBitrate: value }],
			};
			expect(
				autoTunePerTitleGoal(goal, anchor, { a: { min: true } }).rows?.[0]
					?.minBitrate,
			).toBe(value);
		}
		const rows = [{ id: "a", height: 240, minBitrate: 900000, maxBitrate: 1 }];
		expect(
			autoTunePerTitleGoal({ ...anchor, rows }, anchor, {
				a: { min: true, max: true },
			}).rows,
		).toEqual(rows);
	});
	it("allocates new bands by resolution order and reserves requested surplus above fixed rows", () => {
		const rows = [
			{ id: "high", height: 720 },
			{ id: "low", height: 240 },
		];
		const before = {
			...anchor,
			rows,
			countPolicy: { kind: "exact" as const, count: 4 },
		};
		const next = autoTunePerTitleGoal(before, { ...anchor, rows: [] }, {});
		const high = next.rows?.[0];
		const low = next.rows?.[1];
		expect(next.rows?.map((row) => row.id)).toEqual(["high", "low"]);
		expect(low?.minBitrate).toBe(anchor.minBitrate);
		expect(low?.maxBitrate).toBeLessThan(high?.minBitrate ?? 0);
		expect(high?.maxBitrate).toBeLessThan(anchor.maxBitrate);
		expect(autoTunePerTitleGoal(before, { ...anchor, rows: [] }, {})).toEqual(
			next,
		);
	});
	it("does not reuse anchor bands for changed dimensions or codecs", () => {
		for (const goal of [
			{ ...anchor, rows: [{ id: "a", height: 360 }] },
			{ ...anchor, rows: [{ id: "a", height: 240, width: 640 }] },
			{ ...anchor, codec: "VP9" as const, rows: [{ id: "a", height: 240 }] },
		]) {
			expect(autoTunePerTitleGoal(goal, anchor, {}).rows?.[0]).toMatchObject({
				minBitrate: anchor.minBitrate,
			});
			expect(
				autoTunePerTitleGoal(goal, anchor, {}).rows?.[0]?.maxBitrate,
			).not.toBe(200000);
		}
	});
	it("allocates width-only bands in declared width order without adding a height", () => {
		const goal: PerTitleGoal = {
			...anchor,
			rows: [
				{ id: "high", width: 1280 },
				{ id: "low", width: 640 },
			],
		};
		const next = autoTunePerTitleGoal(goal, { ...anchor, rows: [] }, {});
		expect(next.rows?.[1]?.minBitrate).toBe(anchor.minBitrate);
		expect(next.rows?.[1]?.maxBitrate).toBeLessThan(
			next.rows?.[0]?.minBitrate ?? 0,
		);
		expect(next.rows?.every((row) => !Object.hasOwn(row, "height"))).toBe(true);
	});
	it("preserves incomparable dimensions instead of assigning bands in arbitrary order", () => {
		const goal: PerTitleGoal = {
			...anchor,
			rows: [
				{ id: "width", width: 640 },
				{ id: "height", height: 720 },
			],
		};
		expect(
			autoTunePerTitleGoal(goal, { ...anchor, rows: [] }, {}).rows,
		).toEqual(goal.rows);
	});
	it("drops automatic tuning overrides while retaining explicit rules and automatic source metadata", () => {
		const goal: PerTitleGoal = {
			...anchor,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 2,
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
			},
			rows: anchor.rows?.map((row) => ({
				...row,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 100000,
				highComplexityBoundaryForMaxBitrate: 10000000,
			})),
			automaticTemplates: [
				{
					id: "source",
					width: 640,
					minBitrate: 123456,
					bitrateSelectionMode: "OPTIMIZED",
				},
			],
		};
		const snapshot = structuredClone(goal);
		const next = autoTunePerTitleGoal(goal, anchor, {});
		expect(next.minBitrateStepSize).toBeUndefined();
		expect(next.maxBitrateStepSize).toBeUndefined();
		expect(next.fixedResolutionAndBitrateConfiguration).toEqual(
			goal.fixedResolutionAndBitrateConfiguration,
		);
		expect(next.rows).toEqual(anchor.rows);
		expect(next.automaticTemplates).toEqual(goal.automaticTemplates);
		expect(goal).toEqual(snapshot);
		expect(anchor.rows?.[0]?.maxBitrate).toBe(200000);
	});
	it("preserves parked rows and invalid global inputs for core diagnostics", () => {
		for (const strategy of [
			"automatic",
			"count",
			"fixed-resolutions",
			"required-resolutions",
		] as const) {
			const goal = { ...anchor, strategy, maxBitrate: 100000000 };
			expect(autoTunePerTitleGoal(goal, anchor, {}).rows).toEqual(goal.rows);
		}
		for (const maxBitrate of [
			0,
			99999,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			2147483648,
		]) {
			const goal = { ...anchor, maxBitrate };
			const next = autoTunePerTitleGoal(goal, anchor, {});
			expect(next.rows).toEqual(goal.rows);
			expect(next.maxBitrate).toBe(maxBitrate);
		}
	});
	it("keeps tiny and point global intervals in range without claiming distinct rates", () => {
		for (const maxBitrate of [1, 2]) {
			const next = autoTunePerTitleGoal(
				{
					...anchor,
					minBitrate: 1,
					maxBitrate,
					rows: [{ id: "x", height: 240 }],
				},
				{ ...anchor, rows: [] },
				{},
			);
			expect(next.rows?.[0]?.minBitrate).toBeGreaterThanOrEqual(1);
			expect(next.rows?.[0]?.maxBitrate).toBeLessThanOrEqual(maxBitrate);
		}
	});
	it("handles degenerate global anchors or unrelated invalid rows without dividing by zero", () => {
		for (const baseline of [
			{ ...anchor, minBitrate: 0 },
			{ ...anchor, minBitrate: 100000, maxBitrate: 100000 },
			{
				...anchor,
				rows: [{ id: "unrelated", height: 240, minBitrate: -1, maxBitrate: 2 }],
			},
		]) {
			const next = autoTunePerTitleGoal(
				{ ...anchor, rows: [{ id: "a", height: 240 }] },
				baseline,
				{},
			);
			expect(next.rows?.[0]).toMatchObject({ minBitrate: 100000 });
			expect(Number.isSafeInteger(next.rows?.[0]?.maxBitrate)).toBe(true);
		}
	});
});
