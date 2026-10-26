import { describe, expect, it } from "vitest";
import {
	type PerTitleGoal,
	type PerTitleProposal,
	recommendPerTitleModel,
	recommendPerTitleSettings,
} from "./per-title-simulator.js";

const firstRange = {
	id: "a",
	height: 240,
	minBitrate: 160_000,
	maxBitrate: 200_000,
};
const fixed: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 2_400_000,
	countPolicy: { kind: "exact", count: 3 },
	rows: [
		firstRange,
		{ id: "b", height: 480, minBitrate: 400_000, maxBitrate: 480_000 },
		{ id: "c", height: 720, minBitrate: 1_000_000, maxBitrate: 1_200_000 },
	],
};

describe("joint Per-Title constraint optimization", () => {
	it("keeps a checked closed count when exact one is weakened to maximum one", () => {
		const goal: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 1_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			autoRepresentations: false,
			countPolicy: { kind: "exact", count: 1 },
			rows: [
				{
					id: "point",
					height: 720,
					minBitrate: 200_000,
					maxBitrate: 200_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 400_000,
					highComplexityBoundaryForMaxBitrate: 1_000_000,
				},
			],
		};
		const exact = recommendPerTitleSettings(goal);
		expect(exact.derivation?.constraints?.status).toBe("checked");
		expect(exact.derivation?.targetSatisfied).toBe(true);
		const maximum = recommendPerTitleSettings({
			...goal,
			countPolicy: { kind: "maximum", count: 1 },
		});
		expect(maximum.derivation?.constraints?.status).toBe("checked");
		expect(maximum.derivation?.targetSatisfied).toBe(true);
		expect(
			maximum.scenarios.every(
				(scenario) =>
					scenario.modelCountRange?.minimum === 1 &&
					scenario.modelCountRange.maximum === 1,
			),
		).toBe(true);
		expect(maximum.api).toEqual(exact.api);
		expect(maximum.countGuarantee).toBe(false);
	});
	it("certifies fewer closed outputs than the maximum without filling unused slots", () => {
		const goal: PerTitleGoal = {
			...fixed,
			countPolicy: { kind: "maximum", count: 6 },
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 5,
			rows: [
				{ id: "a", height: 360, minBitrate: 200_000, maxBitrate: 200_000 },
				{ id: "b", height: 720, minBitrate: 800_000, maxBitrate: 800_000 },
			],
		};
		const before = structuredClone(goal);
		const result = recommendPerTitleSettings(goal);
		expect(result.derivation?.constraints?.status).toBe("checked");
		expect(result.derivation?.targetSatisfied).toBe(true);
		expect(result.derivation?.desiredCount).toBe(6);
		expect(result.derivation?.constraints?.forced.count).toBe(0);
		expect(
			result.api.global.fixedResolutionAndBitrateConfiguration,
		).toBeUndefined();
		expect(
			result.scenarios.every(
				(scenario) =>
					scenario.modelCountRange?.minimum === 2 &&
					scenario.modelCountRange.maximum === 2 &&
					scenario.modelRungs.length === 2,
			),
		).toBe(true);
		expect(result.countGuarantee).toBe(false);
		expect(goal).toEqual(before);
	});
	it("does not certify a maximum below the closed row count", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			countPolicy: { kind: "maximum", count: 2 },
		});
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.derivation?.constraints?.status).not.toBe("checked");
		expect(result.applicable).toBe(false);
	});
	it.each([
		1, 2, 5,
	])("keeps a saved positive forced count within, rather than equal to, maximum %i", (count) => {
		const goal: PerTitleGoal = {
			...fixed,
			maxBitrate: 1_000_000,
			countPolicy: { kind: "maximum", count },
			rows: [
				{ id: "point", height: 720, minBitrate: 200_000, maxBitrate: 200_000 },
			],
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.5,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		};
		const result = recommendPerTitleSettings(goal);
		if (count === 1) {
			expect(result.derivation?.constraints?.status).not.toBe("checked");
			expect(result.derivation?.targetSatisfied).toBe(false);
		} else {
			expect(result.derivation?.constraints?.status).toBe("checked");
			expect(result.derivation?.targetSatisfied).toBe(true);
			expect(
				result.scenarios.every(
					(scenario) =>
						scenario.modelCountRange?.minimum === 2 &&
						scenario.modelCountRange.maximum === 2,
				),
			).toBe(true);
		}
		expect(result.api.global.fixedResolutionAndBitrateConfiguration).toEqual(
			goal.fixedResolutionAndBitrateConfiguration,
		);
		expect(result.countGuarantee).toBe(false);
	});
	it("calibrates a mixed ladder from the highest fixed minimum and minimum step", () => {
		const goal: PerTitleGoal = {
			...fixed,
			countPolicy: { kind: "unrestricted" },
			minBitrateStepSize: 1.25,
			maxBitrateStepSize: 4,
			autoRepresentations: false,
			automaticTemplates: [
				{ id: "start", height: 120 },
				{ id: "upper", height: 1080 },
			],
			settingLocks: { global: ["minBitrateStepSize", "maxBitrateStepSize"] },
		};
		const before = structuredClone(goal);
		for (const rule of [
			undefined,
			{
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.6,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE" as const,
			},
		]) {
			const result = recommendPerTitleSettings({
				...goal,
				fixedResolutionAndBitrateConfiguration: rule,
			});
			for (const stream of result.api.streams.filter(
				(item) =>
					item.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			))
				expect(stream.perTitleSettings).toMatchObject({
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 1_250_000,
					highComplexityBoundaryForMaxBitrate: 2_400_000,
				});
			expect(result.derivation?.constraints?.calibration).toMatchObject({
				low: 1_250_000,
				high: 2_400_000,
				origin: {
					kind: "fixed-minimum-step",
					minimumBitrate: 1_000_000,
					minimumStep: 1.25,
				},
			});
			expect(result.api.global.fixedResolutionAndBitrateConfiguration).toEqual(
				rule,
			);
			expect(result.applicable).toBe(rule === undefined);
			expect(result.derivation?.targetSatisfied).toBe(false);
			expect(result.derivation?.constraints?.status).toBe("unknown");
		}
		const heldAbsence = recommendPerTitleSettings({
			...goal,
			minBitrateStepSize: 1.5,
			autoRepresentations: undefined,
			settingLocks: {
				global: [
					"minBitrateStepSize",
					"maxBitrateStepSize",
					"autoRepresentations",
				],
			},
		});
		expect(heldAbsence.api.global.autoRepresentations).toBeUndefined();
		expect(heldAbsence.derivation?.constraints?.calibration).toMatchObject({
			low: 1_500_000,
			origin: { minimumStep: 1.5 },
		});
		expect(goal).toEqual(before);
	});
	it.each([
		"low",
		"high",
		"both",
	] as const)("keeps %s fixed calibration boundaries in a mixed ladder", (locked) => {
		const low = locked === "low" || locked === "both";
		const high = locked === "high" || locked === "both";
		const result = recommendPerTitleSettings({
			...fixed,
			countPolicy: { kind: "unrestricted" },
			minBitrateStepSize: 1.25,
			maxBitrateStepSize: 4,
			autoRepresentations: false,
			automaticTemplates: [{ id: "upper", height: 1080 }],
			rows: fixed.rows?.map((row) => ({
				...row,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				...(low ? { lowComplexityBoundaryForMaxBitrate: 700_000 } : {}),
				...(high ? { highComplexityBoundaryForMaxBitrate: 2_000_000 } : {}),
			})),
			settingLocks: {
				global: ["minBitrateStepSize", "maxBitrateStepSize"],
				streams: Object.fromEntries(
					(fixed.rows ?? []).map((row) => [
						row.id,
						[
							"bitrateSelectionMode",
							...(low ? ["lowComplexityBoundaryForMaxBitrate"] : []),
							...(high ? ["highComplexityBoundaryForMaxBitrate"] : []),
						],
					]),
				),
			},
		});
		for (const stream of result.api.streams.filter(
			(item) => item.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		))
			expect(stream.perTitleSettings).toMatchObject({
				lowComplexityBoundaryForMaxBitrate: low ? 700_000 : 1_250_000,
				highComplexityBoundaryForMaxBitrate: high ? 2_000_000 : 2_400_000,
			});
	});
	it("keeps the lower-limit calibration for closed and unresolved template sets", () => {
		for (const extra of [
			{},
			{ automaticTemplates: [{ id: "start", height: 120 }] },
			{ automaticTemplates: [{ id: "upper", height: 1080 }] },
			{
				automaticTemplates: [{ id: "upper", height: 1080 }],
				autoRepresentations: {},
			},
			{ automaticTemplates: [{ id: "upper" }] },
		]) {
			const result = recommendPerTitleSettings({
				...fixed,
				countPolicy: { kind: "unrestricted" },
				minBitrateStepSize: 1.25,
				maxBitrateStepSize: 4,
				...extra,
			});
			expect(result.derivation?.constraints?.calibration?.low).toBe(1_000_000);
			expect(
				result.derivation?.constraints?.calibration?.origin,
			).toBeUndefined();
		}
	});
	it("derives both automatic boundaries when only COMPLEXITY_RANGE mode is fixed", () => {
		const goal: PerTitleGoal = {
			...fixed,
			maxBitrate: 10000000,
			countPolicy: { kind: "unrestricted" },
			rows: fixed.rows?.map((row) =>
				row.id === "b"
					? { ...row, bitrateSelectionMode: "COMPLEXITY_RANGE" }
					: row,
			),
			settingLocks: { streams: { b: ["bitrateSelectionMode"] } },
		};
		const result = recommendPerTitleSettings(goal);
		const settings = result.api.streams.find(
			(stream) => stream.rowId === "b",
		)?.perTitleSettings;
		expect(settings).toMatchObject({
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			highComplexityBoundaryForMaxBitrate: 10000000,
		});
		expect(settings?.lowComplexityBoundaryForMaxBitrate).toBeGreaterThan(0);
		expect(settings?.lowComplexityBoundaryForMaxBitrate).toBeLessThan(10000000);
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "invalid-complexity-range" }),
		);
		const legacy = recommendPerTitleSettings({
			...goal,
			settingLocks: undefined,
		});
		expect(legacy.applicable).toBe(false);
		expect(legacy.diagnostics).toContainEqual(
			expect.objectContaining({ code: "invalid-complexity-range" }),
		);
	});
	it.each([
		["lowComplexityBoundaryForMaxBitrate", 3000000],
		["highComplexityBoundaryForMaxBitrate", 8000000],
	] as const)("completes an automatic boundary with both the mode and %s fixed", (key, value) => {
		const goal: PerTitleGoal = {
			...fixed,
			maxBitrate: 10000000,
			countPolicy: { kind: "unrestricted" },
			rows: fixed.rows?.map((row) =>
				row.id === "b"
					? { ...row, bitrateSelectionMode: "COMPLEXITY_RANGE", [key]: value }
					: row,
			),
			settingLocks: { streams: { b: ["bitrateSelectionMode", key] } },
		};
		const result = recommendPerTitleSettings(goal);
		const settings = result.api.streams.find(
			(stream) => stream.rowId === "b",
		)?.perTitleSettings;
		expect(settings).toMatchObject({
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			[key]: value,
		});
		expect(settings?.lowComplexityBoundaryForMaxBitrate).toBeGreaterThan(0);
		expect(settings?.highComplexityBoundaryForMaxBitrate).toBeGreaterThan(
			settings?.lowComplexityBoundaryForMaxBitrate ?? Infinity,
		);
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "invalid-complexity-range" }),
		);
	});
	it("does not defer invalid boundary data or a locked-unset counterpart", () => {
		for (const low of [0, NaN, Infinity, 3000000]) {
			const goal: PerTitleGoal = {
				...fixed,
				maxBitrate: 10000000,
				rows: fixed.rows?.map((row) =>
					row.id === "b"
						? {
								...row,
								bitrateSelectionMode: "COMPLEXITY_RANGE",
								lowComplexityBoundaryForMaxBitrate: low,
							}
						: row,
				),
				settingLocks: {
					streams: {
						b: [
							"bitrateSelectionMode",
							"lowComplexityBoundaryForMaxBitrate",
							...(low === 3000000
								? ["highComplexityBoundaryForMaxBitrate"]
								: []),
						],
					},
				},
			};
			const result = recommendPerTitleSettings(goal);
			expect(result.applicable).toBe(false);
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "invalid-complexity-range",
					severity: "conflict",
				}),
			);
			expect(
				result.api.streams.find((stream) => stream.rowId === "b")
					?.perTitleSettings?.highComplexityBoundaryForMaxBitrate,
			).toBeUndefined();
		}
	});
	it.each([
		[
			"lowComplexityBoundaryForMaxBitrate",
			3000000,
			"highComplexityBoundaryForMaxBitrate",
		],
		[
			"highComplexityBoundaryForMaxBitrate",
			8000000,
			"lowComplexityBoundaryForMaxBitrate",
		],
	] as const)("fills only the unlocked counterpart of a fixed %s", (key, value, automaticKey) => {
		const goal: PerTitleGoal = {
			...fixed,
			maxBitrate: 10000000,
			countPolicy: { kind: "unrestricted" },
			rows: fixed.rows?.map((row) =>
				row.id === "b" ? { ...row, [key]: value } : row,
			),
			settingLocks: { streams: { b: [key] } },
		};
		const result = recommendPerTitleSettings(goal);
		const settings = result.api.streams.find(
			(stream) => stream.rowId === "b",
		)?.perTitleSettings;
		expect(settings?.[key]).toBe(value);
		expect(settings?.bitrateSelectionMode).toBe("COMPLEXITY_RANGE");
		if (automaticKey === "highComplexityBoundaryForMaxBitrate")
			expect(settings?.[automaticKey]).toBe(10000000);
		else {
			expect(settings?.[automaticKey]).toBeGreaterThan(0);
			expect(settings?.[automaticKey]).toBeLessThan(value);
		}
	});
	it("does not fill a locked-unset mode or change legacy partial curves without calibration locks", () => {
		const goal: PerTitleGoal = {
			...fixed,
			maxBitrate: 10000000,
			countPolicy: { kind: "unrestricted" },
			rows: fixed.rows?.map((row) =>
				row.id === "b"
					? { ...row, lowComplexityBoundaryForMaxBitrate: 3000000 }
					: row,
			),
		};
		const legacy = recommendPerTitleSettings(goal).api.streams.find(
			(stream) => stream.rowId === "b",
		)?.perTitleSettings;
		expect(legacy?.bitrateSelectionMode).toBe("OPTIMIZED");
		expect(legacy?.highComplexityBoundaryForMaxBitrate).toBeUndefined();
		const held = recommendPerTitleSettings({
			...goal,
			settingLocks: {
				streams: {
					b: ["lowComplexityBoundaryForMaxBitrate", "bitrateSelectionMode"],
				},
			},
		});
		expect(
			held.api.streams.find((stream) => stream.rowId === "b")?.perTitleSettings,
		).not.toHaveProperty("bitrateSelectionMode");
		expect(held.derivation?.constraints?.status).not.toBe("checked");
	});
	it("discards a locked unsuccessful trial when its restored API steps differ", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			rows: [
				{ id: "a", height: 240, minBitrate: 200000, maxBitrate: 200000 },
				{ id: "b", height: 480, minBitrate: 400000, maxBitrate: 400000 },
				{ id: "c", height: 720, minBitrate: 800000, maxBitrate: 800000 },
			],
			maxBitrateStepSize: 1.2,
			settingLocks: { global: ["maxBitrateStepSize"] },
		});
		expect(result.api.global.minBitrateStepSize).toBe(1.2);
		expect(result.api.global.maxBitrateStepSize).toBe(1.2);
		expect(result.applicable).toBe(false);
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.derivation?.constraints).toMatchObject({
			status: "unknown",
			inputRange: null,
			floorRange: null,
			changes: [{ field: "minimumStep", before: undefined, after: 1.2 }],
			checkpoints: [],
		});
		expect(result.derivation?.constraints).not.toHaveProperty("calibration");
		expect(result.derivation?.constraints).not.toHaveProperty("spacing");
		expect(result.derivation?.selectedMinStep).toBe(
			result.api.global.minBitrateStepSize,
		);
	});
	it("does not certify a partial forced rule whose count is locked unset", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.1,
			},
			settingLocks: {
				global: [
					"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentation",
					"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationFactor",
				],
			},
		});
		expect(result.api.global.fixedResolutionAndBitrateConfiguration).toEqual({
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.1,
		});
		expect(result.applicable).toBe(false);
		expect(result.derivation?.targetSatisfied).not.toBe(true);
		expect(result.derivation?.constraints?.status).not.toBe("checked");
	});
	it("keeps outer SDK stream factors even when a joint trial remains unproven", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			rows: fixed.rows?.map((row) => ({
				...row,
				codecMaxBitrateFactor: 1.6,
				codecBufsizeFactor: 2,
			})),
			minBitrateStepSize: 20,
			settingLocks: { global: ["minBitrateStepSize"] },
		});
		expect(
			result.api.streams.every(
				(s) =>
					s.perTitleSettings?.codecMaxBitrateFactor === 1.6 &&
					s.perTitleSettings.codecBufsizeFactor === 2,
			),
		).toBe(true);
		expect(result.applicable).toBe(false);
	});
	it("keeps a locked minimum step while deriving only the maximum step", () => {
		const goal: PerTitleGoal = {
			...fixed,
			minBitrateStepSize: 1.8,
			settingLocks: { global: ["minBitrateStepSize"] },
		};
		const result = recommendPerTitleSettings(goal);
		expect(result.api.global.minBitrateStepSize).toBe(1.8);
		expect(result.derivation?.selectedMinStep).toBe(1.8);
		expect(result.derivation?.targetSatisfied).toBe(true);
	});
	it("does not reuse a proof after locked spacing makes the requested count infeasible", () => {
		for (const [key, value] of [
			["minBitrateStepSize", 4],
			["maxBitrateStepSize", 1.2],
		] as const) {
			const result = recommendPerTitleSettings({
				...fixed,
				[key]: value,
				settingLocks: { global: [key] },
			});
			expect(result.api.global[key]).toBe(value);
			expect(result.applicable).toBe(false);
			expect(result.derivation?.targetSatisfied).not.toBe(true);
			expect(result.derivation?.constraints?.status).not.toBe("checked");
		}
	});
	it("preserves a locked additional count instead of replacing it with the desired count", () => {
		const key =
			"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentation";
		const result = recommendPerTitleSettings({
			...fixed,
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.1,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
			settingLocks: { global: [key] },
		});
		expect(
			result.api.global.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentation,
		).toBe(1);
		expect(result.applicable).toBe(false);
		expect(result.derivation?.targetSatisfied).not.toBe(true);
	});
	it("retains locked optional absence rather than adding calibration or additional-rule defaults", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			countPolicy: { kind: "exact", count: 4 },
			settingLocks: {
				global: [
					"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationFactor",
				],
				streams: {
					a: [
						"bitrateSelectionMode",
						"lowComplexityBoundaryForMaxBitrate",
						"highComplexityBoundaryForMaxBitrate",
					],
				},
			},
		});
		expect(
			result.api.streams.find((s) => s.rowId === "a")?.perTitleSettings,
		).not.toHaveProperty("bitrateSelectionMode");
		expect(
			result.api.streams.find((s) => s.rowId === "a")?.perTitleSettings,
		).not.toHaveProperty("lowComplexityBoundaryForMaxBitrate");
		expect(
			result.api.global.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBeUndefined();
		expect(result.derivation?.targetSatisfied).not.toBe(true);
	});
	it("preserves a locked calculation mode and zero count without a false LAST proof", () => {
		for (const rule of [
			{
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.1,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"MINIMUM" as const,
			},
			{ forcedRenditionAboveHighestFixedRepresentation: 0 },
		]) {
			const result = recommendPerTitleSettings({
				...fixed,
				countPolicy: { kind: "exact", count: 4 },
				fixedResolutionAndBitrateConfiguration: rule,
				settingLocks: {
					global: Object.keys(rule).map(
						(k) => `fixedResolutionAndBitrateConfiguration.${k}`,
					),
				},
			});
			expect(
				result.api.global.fixedResolutionAndBitrateConfiguration,
			).toMatchObject(rule);
			expect(result.applicable).toBe(false);
			expect(result.derivation?.targetSatisfied).not.toBe(true);
		}
	});
	it("holds a saved additional factor while optimizing the remaining dependencies", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			countPolicy: { kind: "exact", count: 4 },
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.1,
			},
			settingLocks: {
				global: [
					"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationFactor",
				],
			},
		});
		expect(
			result.api.global.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBe(1.1);
		expect(result.derivation?.targetSatisfied).toBe(true);
	});
	it("derives the row calibration and spacing together for a fully specified count", () => {
		const source = structuredClone(fixed);
		const result = recommendPerTitleSettings(fixed);
		expect(result.derivation?.method).toBe("joint-constraints");
		expect(result.derivation?.constraints?.status).toBe("checked");
		expect(result.derivation?.constraints?.scope).toBe("closed-ladder");
		expect(result.derivation?.targetSatisfied).toBe(true);
		for (const stream of result.api.streams) {
			expect(stream.perTitleSettings).toMatchObject({
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 1_000_000,
				highComplexityBoundaryForMaxBitrate: 2_400_000,
			});
		}
		expect(result.api.global.minBitrateStepSize).toBeGreaterThan(1.26);
		expect(result.countGuarantee).toBe(false);
		expect(fixed).toEqual(source);
	});

	it("budgets additional renditions instead of asking the user to delete the rule", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			countPolicy: { kind: "exact", count: 5 },
		});
		expect(
			result.api.global.fixedResolutionAndBitrateConfiguration,
		).toMatchObject({
			forcedRenditionAboveHighestFixedRepresentation: 2,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"LAST_CALCULATED_BITRATE",
		});
		expect(result.derivation?.constraints?.status).toBe("checked");
		expect(result.derivation?.constraints?.forced.count).toBe(2);
		expect(
			result.scenarios.every((s) => s.modelCountRange?.maximum === 5),
		).toBe(true);
		for (const scenario of result.scenarios) {
			expect(scenario.modelRungs).toHaveLength(5);
			expect(scenario.modelRungs.at(-1)?.bitrate).toBeLessThanOrEqual(
				fixed.maxBitrate,
			);
		}
	});

	it("accounts for an unnecessary saved rule in the explicit derivation", () => {
		const goal: PerTitleGoal = {
			...fixed,
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 2,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.4,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"MAXIMUM",
			},
		};
		const before = structuredClone(goal);
		const result = recommendPerTitleSettings(goal);
		expect(
			result.api.global.fixedResolutionAndBitrateConfiguration,
		).toBeUndefined();
		expect(result.derivation?.constraints?.changes).toContainEqual(
			expect.objectContaining({
				field: "forcedCount",
				before: 2,
				after: undefined,
			}),
		);
		expect(result.derivation?.targetSatisfied).toBe(true);
		expect(goal).toEqual(before);
	});

	it("preserves explicit boundaries and exposes their coupled effect", () => {
		const goal: PerTitleGoal = {
			...fixed,
			rows: fixed.rows?.map((row) => ({
				...row,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 800_000,
				highComplexityBoundaryForMaxBitrate: 3_000_000,
			})),
		};
		const first = recommendPerTitleSettings(goal);
		const second = recommendPerTitleSettings({
			...goal,
			rows: goal.rows?.map((row) => ({
				...row,
				highComplexityBoundaryForMaxBitrate: 4_000_000,
			})),
		});
		expect(
			first.api.streams[0]?.perTitleSettings
				?.highComplexityBoundaryForMaxBitrate,
		).toBe(3_000_000);
		expect(
			second.api.streams[0]?.perTitleSettings
				?.highComplexityBoundaryForMaxBitrate,
		).toBe(4_000_000);
		expect(first.derivation?.constraints?.checkpoints).toBeDefined();
		expect(second.derivation?.constraints?.checkpoints).not.toEqual(
			first.derivation?.constraints?.checkpoints,
		);
	});

	it("keeps mixed automatic candidates and conditional rule behavior visible", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			countPolicy: { kind: "exact", count: 5 },
			automaticTemplates: [{ id: "automatic", height: 1080 }],
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.3,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		});
		expect(
			result.api.streams.some((stream) => stream.mode === "PER_TITLE_TEMPLATE"),
		).toBe(true);
		expect(
			result.api.global.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentation,
		).toBe(1);
		expect(result.derivation?.constraints?.scope).toBe("conditional");
		expect(result.derivation?.constraints?.forced.conditional).toBe(true);
		expect(result.derivation?.targetSatisfied).toBe(false);
	});

	it.each([
		"exact",
		"maximum",
	] as const)("does not certify a mixed %s count from an independent interval example", (kind) => {
		const result = recommendPerTitleSettings({
			...fixed,
			minBitrateStepSize: 1.9,
			maxBitrateStepSize: 3,
			countPolicy: { kind, count: 5 },
			automaticTemplates: [{ id: "automatic", height: 1080 }],
		});
		expect(result.derivation?.constraints?.scope).toBe("conditional");
		expect(result.derivation?.constraints?.status).toBe("unknown");
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.applicable).toBe(false);
		expect(result.status).not.toBe("candidate");
		expect(result.derivation?.selectedMinStep).toBe(
			result.api.global.minBitrateStepSize,
		);
		expect(result.derivation?.selectedMaxStep).toBe(
			result.api.global.maxBitrateStepSize,
		);
		expect(result.api.streams.map((stream) => stream.rowId)).toContain(
			"automatic",
		);
	});

	it("replaces unsafe near-unit spacing rather than certifying rounded duplicate points", () => {
		const result = recommendPerTitleModel({
			...fixed,
			minBitrate: 3,
			maxBitrate: 12,
			minBitrateStepSize: 1.01,
			maxBitrateStepSize: 2.5,
			countPolicy: { kind: "exact", count: 2 },
			rows: [
				{ id: "a", height: 240, minBitrate: 3, maxBitrate: 3 },
				{ id: "b", height: 480, minBitrate: 6, maxBitrate: 6 },
			],
		});
		expect(result.derivation?.constraints?.status).toBe("checked");
		for (const value of [3, 6]) {
			expect(
				Math.round(value * result.api.global.minBitrateStepSize),
			).toBeGreaterThan(value);
		}
		expect(result.api.global.minBitrateStepSize).toBeGreaterThan(1.01);
	});

	it.each([
		{ rows: [{ ...firstRange, id: "" }] },
		{ rows: [{ ...firstRange, minBitrate: 0 }] },
		{
			rows: [
				{
					...firstRange,
					lowComplexityBoundaryForMaxBitrate: 1000,
					bitrateSelectionMode: "COMPLEXITY_RANGE" as const,
				},
			],
		},
		{ countPolicy: { kind: "exact" as const, count: 0 } },
	])("never upgrades invalid requirements to a joint certificate: %j", (patch) => {
		const result = recommendPerTitleSettings({ ...fixed, ...patch });
		expect(result.applicable).toBe(false);
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.derivation?.constraints?.status).not.toBe("checked");
	});

	it("does not claim that arbitrary requested counts fit the reserved bitrate budget", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			maxBitrate: 1_200_000,
			countPolicy: { kind: "exact", count: 256 },
		});
		expect(result.derivation?.constraints?.status).not.toBe("checked");
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.applicable).toBe(false);
	});

	it("does not certify a count when the complexity calibration has no input span", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			maxBitrate: 1_200_000,
			rows: fixed.rows?.map((row) =>
				row.id === "c" ? { ...row, minBitrate: 1_200_000 } : row,
			),
		});
		expect(result.derivation?.constraints?.status).toBe("unknown");
		expect(result.derivation?.constraints?.inputRange).toBeNull();
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.applicable).toBe(false);
	});

	it("reports returned API settings rather than a discarded additional-rendition trial", () => {
		const configuration = {
			forcedRenditionAboveHighestFixedRepresentation: 2,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.5,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"LAST_CALCULATED_BITRATE" as const,
		};
		const result = recommendPerTitleSettings({
			...fixed,
			maxBitrate: 400_000,
			countPolicy: { kind: "exact", count: 1 },
			rows: [
				{ id: "a", height: 240, minBitrate: 400_000, maxBitrate: 400_000 },
			],
			fixedResolutionAndBitrateConfiguration: configuration,
		});
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.api.global.fixedResolutionAndBitrateConfiguration).toEqual(
			configuration,
		);
		expect(result.derivation?.constraints?.forced).toMatchObject({
			count: configuration.forcedRenditionAboveHighestFixedRepresentation,
			factor:
				configuration.forcedRenditionAboveHighestFixedRepresentationFactor,
			calculationMode:
				configuration.forcedRenditionAboveHighestFixedRepresentationCalculationMode,
			conditional: true,
			ranges: [],
		});
		expect(result.derivation?.constraints?.changes).toEqual([
			{
				field: "minimumStep",
				before: undefined,
				after: result.api.global.minBitrateStepSize,
			},
			{
				field: "maximumStep",
				before: undefined,
				after: result.api.global.maxBitrateStepSize,
			},
		]);
		expect(result.derivation?.constraints?.calibration).toBeUndefined();
		expect(result.derivation?.constraints?.spacing).toBeUndefined();
		expect(result.derivation?.constraints?.checkpoints).toEqual([]);
	});

	it("preserves a safe additional-rendition factor independently of ordinary spacing", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			countPolicy: { kind: "exact", count: 4 },
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.1,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		});
		expect(result.derivation?.targetSatisfied).toBe(true);
		expect(
			result.api.global.fixedResolutionAndBitrateConfiguration
				?.forcedRenditionAboveHighestFixedRepresentationFactor,
		).toBe(1.1);
		expect(result.api.global.minBitrateStepSize).toBeGreaterThan(1.1);
		expect(
			result.scenarios.every((scenario) => scenario.modelRungs.length === 4),
		).toBe(true);
	});

	it.each(
		[[Number.NaN], [-0.1], [1.1], Array(10).fill(1)].map(
			(scenarioFractions) => ({ scenarioFractions }),
		),
	)("preserves rejection of invalid or unbounded calculation inputs: %j", ({
		scenarioFractions,
	}) => {
		const result = recommendPerTitleSettings({ ...fixed, scenarioFractions });
		expect(result.applicable).toBe(false);
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.derivation?.constraints?.status).not.toBe("checked");
	});

	it("does not replace a failed coupled check with a successful independent interval example", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			minBitrate: 100_000,
			maxBitrate: 400_000,
			countPolicy: { kind: "exact", count: 2 },
			rows: [
				{
					id: "a",
					height: 240,
					minBitrate: 100_000,
					maxBitrate: 200_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 1,
					highComplexityBoundaryForMaxBitrate: 2,
				},
				{
					id: "b",
					height: 480,
					minBitrate: 150_000,
					maxBitrate: 300_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 1_000_000,
					highComplexityBoundaryForMaxBitrate: 2_000_000,
				},
			],
		});
		expect(result.derivation?.constraints?.status).toBe("unknown");
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.applicable).toBe(false);
		expect(result.derivation?.selectedMinStep).toBe(
			result.api.global.minBitrateStepSize,
		);
		expect(result.derivation?.selectedMaxStep).toBe(
			result.api.global.maxBitrateStepSize,
		);
		expect(
			result.scenarios.every(
				(scenario) =>
					scenario.status === "unknown" &&
					scenario.modelCountRange === null &&
					scenario.modelRungs.length === 0,
			),
		).toBe(true);
	});

	it("requires a common dimension when width-only and height-only rows are mixed", () => {
		const result = recommendPerTitleSettings({
			...fixed,
			rows: fixed.rows?.map(({ height, ...row }, index) =>
				index === 0 ? { ...row, width: 4000 } : { ...row, height },
			),
		});
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.applicable).toBe(false);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "row-order-unknown" }),
		);
	});

	it.each([
		{ kind: "exact", count: 2 },
		{ kind: "maximum", count: 10 },
	] as const)("leaves equal-dimension execution order unresolved for $kind counts", (countPolicy) => {
		const result = recommendPerTitleSettings({
			...fixed,
			maxBitrate: 600_000,
			countPolicy,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 2.1,
			rows: [
				{
					id: "a",
					width: 640,
					height: 360,
					minBitrate: 100_000,
					maxBitrate: 400_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 600_000,
					highComplexityBoundaryForMaxBitrate: 700_000,
				},
				{
					id: "b",
					width: 640,
					height: 360,
					minBitrate: 100_000,
					maxBitrate: 200_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 50_000,
					highComplexityBoundaryForMaxBitrate: 60_000,
				},
			],
		});
		expect(result.derivation?.constraints?.status).toBe("unknown");
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.applicable).toBe(false);
	});
});

function expectEmittedConstraintChanges(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
) {
	const before = goal.fixedResolutionAndBitrateConfiguration;
	const global = proposal.api.global;
	const after = global.fixedResolutionAndBitrateConfiguration;
	const expected = [
		{
			field: "minimumStep",
			before: goal.minBitrateStepSize,
			after: global.minBitrateStepSize,
		},
		{
			field: "maximumStep",
			before: goal.maxBitrateStepSize,
			after: global.maxBitrateStepSize,
		},
		{
			field: "forcedCount",
			before: before?.forcedRenditionAboveHighestFixedRepresentation,
			after: after?.forcedRenditionAboveHighestFixedRepresentation,
		},
		{
			field: "forcedFactor",
			before: before?.forcedRenditionAboveHighestFixedRepresentationFactor,
			after: after?.forcedRenditionAboveHighestFixedRepresentationFactor,
		},
		{
			field: "forcedMode",
			before:
				before?.forcedRenditionAboveHighestFixedRepresentationCalculationMode,
			after:
				after?.forcedRenditionAboveHighestFixedRepresentationCalculationMode,
		},
	].filter((change) => !Object.is(change.before, change.after));
	expect(proposal.derivation?.constraints).toBeDefined();
	expect(proposal.derivation?.constraints?.changes).toEqual(expected);
}

describe("constraint changes describe the final emitted API", () => {
	const ruleKey = "fixedResolutionAndBitrateConfiguration.";
	const point: PerTitleGoal = {
		strategy: "fixed-ranges",
		codec: "H264",
		minBitrate: 100_000,
		maxBitrate: 1_000_000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 1.9,
		countPolicy: { kind: "maximum", count: 1 },
		rows: [
			{ id: "point", height: 720, minBitrate: 200_000, maxBitrate: 200_000 },
		],
	};
	const modes = [
		"LAST_CALCULATED_BITRATE",
		"MINIMUM",
		"MAXIMUM",
		"AVERAGE",
	] as const;
	const rules: Array<{
		name: string;
		rule: PerTitleGoal["fixedResolutionAndBitrateConfiguration"];
	}> = [
		{ name: "omitted", rule: undefined },
		{
			name: "explicit zero",
			rule: { forcedRenditionAboveHighestFixedRepresentation: 0 },
		},
		...modes.flatMap((mode) =>
			([0, 1] as const).map((count) => ({
				name: `count ${count}, ${mode}`,
				rule: {
					forcedRenditionAboveHighestFixedRepresentation: count,
					forcedRenditionAboveHighestFixedRepresentationFactor: 1.37,
					forcedRenditionAboveHighestFixedRepresentationCalculationMode: mode,
				},
			})),
		),
		{
			name: "partial count",
			rule: { forcedRenditionAboveHighestFixedRepresentation: 1 },
		},
		{
			name: "partial factor",
			rule: { forcedRenditionAboveHighestFixedRepresentationFactor: 1.37 },
		},
		{
			name: "partial mode",
			rule: {
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"MINIMUM",
			},
		},
	];
	const cases = (["H264", "H265", "H265V2", "VP9", "AV1"] as const).flatMap(
		(codec) =>
			(
				[
					{ kind: "exact", count: 1 },
					{ kind: "maximum", count: 1 },
					{ kind: "unrestricted" },
				] as const
			).flatMap((policy) =>
				[false, true].flatMap((locked) =>
					rules.map(({ name, rule }) => ({
						codec,
						policy,
						locked,
						name,
						rule,
					})),
				),
			),
	);

	it.each(
		cases,
	)("matches every changed field: $codec/$policy.kind/locked=$locked/$name", ({
		codec,
		policy,
		locked,
		rule,
		name,
	}) => {
		const goal: PerTitleGoal = {
			...point,
			codec,
			countPolicy: policy,
			fixedResolutionAndBitrateConfiguration: rule,
			...(locked
				? {
						settingLocks: {
							global: [
								`${ruleKey}forcedRenditionAboveHighestFixedRepresentation`,
								`${ruleKey}forcedRenditionAboveHighestFixedRepresentationFactor`,
								`${ruleKey}forcedRenditionAboveHighestFixedRepresentationCalculationMode`,
							],
						},
					}
				: {}),
		};
		const before = structuredClone(goal);
		const result = recommendPerTitleSettings(goal);
		if (locked && name === "partial count") {
			// A locked missing factor rejects the trial before a report exists.
			expect(result.derivation?.constraints).toBeUndefined();
			expect(result.applicable).toBe(false);
			expect(result.derivation?.targetSatisfied).not.toBe(true);
			expect(result.api.global.fixedResolutionAndBitrateConfiguration).toEqual(
				rule,
			);
		} else expectEmittedConstraintChanges(goal, result);
		expect(result.countGuarantee).toBe(false);
		expect(goal).toEqual(before);
	});

	it("reports neither a phantom zero nor removal of retained zero-rule metadata", () => {
		const unchanged = { ...point, maxBitrateStepSize: 1.5 };
		const omitted = recommendPerTitleSettings(unchanged);
		expect(omitted.api.global).not.toHaveProperty(
			"fixedResolutionAndBitrateConfiguration",
		);
		expect(omitted.derivation?.constraints?.changes).toEqual([]);
		const rule = {
			forcedRenditionAboveHighestFixedRepresentation: 0,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.37,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"MINIMUM" as const,
		};
		const result = recommendPerTitleSettings({
			...unchanged,
			fixedResolutionAndBitrateConfiguration: rule,
		});
		expect(result.api.global.fixedResolutionAndBitrateConfiguration).toEqual(
			rule,
		);
		expect(result.derivation?.constraints?.changes).toEqual([]);
		expect(result.derivation?.constraints?.status).toBe("checked");
		expect(result.derivation?.targetSatisfied).toBe(true);
	});

	it("reports actual additions and deletions without substituting an inferred zero", () => {
		const addedGoal: PerTitleGoal = {
			...fixed,
			countPolicy: { kind: "exact", count: 4 },
		};
		const added = recommendPerTitleSettings(addedGoal);
		expectEmittedConstraintChanges(addedGoal, added);
		expect(
			added.derivation?.constraints?.changes.map((change) => change.field),
		).toEqual([
			"minimumStep",
			"maximumStep",
			"forcedCount",
			"forcedFactor",
			"forcedMode",
		]);
		expect(added.derivation?.constraints?.status).toBe("checked");
		const removedGoal: PerTitleGoal = {
			...point,
			maxBitrateStepSize: 1.5,
			countPolicy: { kind: "exact", count: 1 },
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.37,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"MINIMUM",
			},
		};
		const removed = recommendPerTitleSettings(removedGoal);
		expectEmittedConstraintChanges(removedGoal, removed);
		expect(removed.derivation?.constraints?.changes).toEqual([
			{ field: "forcedCount", before: 1, after: undefined },
			{ field: "forcedFactor", before: 1.37, after: undefined },
			{ field: "forcedMode", before: "MINIMUM", after: undefined },
		]);
		expect(removed.api.global).not.toHaveProperty(
			"fixedResolutionAndBitrateConfiguration",
		);
	});

	it("retains real step edits when a trial is discarded and its count remains unknown", () => {
		const goal: PerTitleGoal = {
			...fixed,
			rows: [
				{ id: "a", height: 240, minBitrate: 200_000, maxBitrate: 200_000 },
				{ id: "b", height: 480, minBitrate: 400_000, maxBitrate: 400_000 },
				{ id: "c", height: 720, minBitrate: 800_000, maxBitrate: 800_000 },
			],
			maxBitrateStepSize: 1.2,
			settingLocks: { global: ["maxBitrateStepSize"] },
		};
		const result = recommendPerTitleSettings(goal);
		expectEmittedConstraintChanges(goal, result);
		expect(result.derivation?.constraints?.changes).toEqual([
			{ field: "minimumStep", before: undefined, after: 1.2 },
		]);
		expect(result.derivation?.constraints?.status).toBe("unknown");
		expect(result.derivation?.constraints?.inputRange).toBeNull();
		expect(result.applicable).toBe(false);
		expect(result.derivation?.targetSatisfied).toBe(false);
	});

	it("keeps final-API differences visible in a conditional mixed layout", () => {
		const goal: PerTitleGoal = {
			...fixed,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "maximum", count: 6 },
			autoRepresentations: false,
			automaticTemplates: [
				{ id: "lower", height: 120 },
				{ id: "upper", height: 1080 },
			],
		};
		const result = recommendPerTitleSettings(goal);
		expectEmittedConstraintChanges(goal, result);
		expect(result.derivation?.constraints?.scope).toBe("conditional");
		expect(result.derivation?.constraints?.status).toBe("unknown");
		expect(result.applicable).toBe(false);
		expect(result.derivation?.targetSatisfied).toBe(false);
		expect(result.countGuarantee).toBe(false);
	});
});
