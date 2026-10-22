import { type PerTitleGoal, recommendPerTitleSettings } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	getPerTitleAdjustment,
	getPerTitleGoalSetting,
	getPerTitleSetting,
	initializePerTitleSettings,
	perTitleGlobalFields,
	perTitleStreamFields,
	setPerTitleAdjustment,
	setPerTitleSetting,
	tunePerTitleSettings,
} from "./per-title-simulator-tuning";

const anchor: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 10_000_000,
	countPolicy: { kind: "unrestricted" },
	rows: [
		{ id: "a", height: 240, minBitrate: 100_000, maxBitrate: 200_000 },
		{ id: "b", height: 480, minBitrate: 500_000, maxBitrate: 1_000_000 },
		{ id: "c", height: 720, minBitrate: 2_000_000, maxBitrate: 5_000_000 },
	],
};

const automaticCalibration: PerTitleGoal = {
	...anchor,
	adjustments: {
		global: {
			minBitrateStepSize: { mode: "auto", method: "constraints" },
			maxBitrateStepSize: { mode: "auto", method: "constraints" },
		},
		streams: Object.fromEntries(
			(anchor.rows ?? []).map(({ id }) => [
				id,
				{
					bitrateSelectionMode: { mode: "auto", method: "constraints" },
					lowComplexityBoundaryForMaxBitrate: {
						mode: "auto",
						method: "constraints",
					},
					highComplexityBoundaryForMaxBitrate: {
						mode: "auto",
						method: "constraints",
					},
				},
			]),
		),
	},
};

describe("Per-Title adjustment controls", () => {
	it.each([
		"H264",
		"H265",
		"H265V2",
		"VP9",
		"AV1",
	] as const)("defaults every supported setting to fixed, including absent optional values (%s)", (codec) => {
		const loaded: PerTitleGoal = {
			...anchor,
			codec,
			minBitrateStepSize: 1.2,
			maxBitrateStepSize: 4,
			resolutionScaleFactor: 0,
			autoRepresentations: false,
			automaticTemplates: [{ id: "candidate", height: 1080 }],
		};
		for (const { key } of perTitleGlobalFields(loaded.codec))
			expect(getPerTitleAdjustment(loaded, loaded, "global", key)).toEqual({
				mode: "fixed",
			});
		for (const row of [
			...(loaded.rows ?? []),
			...(loaded.automaticTemplates ?? []),
		])
			for (const { key } of perTitleStreamFields(loaded.codec))
				expect(
					getPerTitleAdjustment(loaded, loaded, "stream", key, row.id),
				).toEqual({ mode: "fixed" });
	});

	it("preserves imported settings when a different fixed input changes", () => {
		const loaded: PerTitleGoal = {
			...anchor,
			minBitrateStepSize: 1.2,
			maxBitrateStepSize: 4,
			resolutionScaleFactor: 0,
			autoRepresentations: false,
			rows: anchor.rows?.map((row) => ({
				...row,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 6_000_000,
				highComplexityBoundaryForMaxBitrate: 10_000_000,
			})),
		};
		const snapshot = structuredClone(loaded);
		const result = tunePerTitleSettings(
			{ ...loaded, maxBitrate: 20_000_000 },
			loaded,
		);
		expect(result.goal.rows).toEqual(loaded.rows);
		expect(result.proposal.api.global).toMatchObject({
			minBitrateStepSize: 1.2,
			maxBitrateStepSize: 4,
			resolutionScaleFactor: 0,
		});
		expect(result.proposal.api.global.autoRepresentations).toBeUndefined();
		expect(result.proposal.api.global.targetQualityCrf).toBeUndefined();
		expect(loaded).toEqual(snapshot);
	});

	it("materializes only missing required step defaults before fixing them", () => {
		const snapshot = structuredClone(anchor);
		const result = tunePerTitleSettings(anchor, anchor);
		expect(result.goal).toMatchObject({
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
		});
		expect(result.goal.rows).toEqual(anchor.rows);
		expect(result.goal.targetQualityCrf).toBeUndefined();
		expect(result.goal.resolutionScaleFactor).toBeUndefined();
		expect(result.proposal.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "invalid-setting" }),
		);
		expect(anchor).toEqual(snapshot);
	});

	it("initializes optional unset, zero, false and saved automatic policies without altering the source", () => {
		const loaded: PerTitleGoal = {
			...anchor,
			resolutionScaleFactor: 0,
			autoRepresentations: false,
			adjustments: {
				global: { minBitrateStepSize: { mode: "auto", method: "constraints" } },
				inactiveAutoRepresentationThreshold: 0,
			},
		};
		const snapshot = structuredClone(loaded);
		const initialized = initializePerTitleSettings(loaded);
		expect(initialized).toEqual({ ...loaded, maxBitrateStepSize: 1.9 });
		expect(initialized.minBitrateStepSize).toBeUndefined();
		expect(initialized.targetQualityCrf).toBeUndefined();
		expect(initialized).not.toBe(loaded);
		expect(loaded).toEqual(snapshot);
	});

	it("keeps a supplied step when the missing peer's default creates a conflict", () => {
		const loaded = { ...anchor, minBitrateStepSize: 2 };
		const result = tunePerTitleSettings(loaded, loaded);
		expect(result.goal).toMatchObject({
			minBitrateStepSize: 2,
			maxBitrateStepSize: 1.9,
		});
		expect(result.proposal.api.global).toMatchObject({
			minBitrateStepSize: 2,
			maxBitrateStepSize: 1.9,
		});
		expect(result.proposal.status).toBe("conflict");
		expect(result.proposal.applicable).toBe(false);
	});

	it("restores explicit automatic policies without making their peers automatic", () => {
		const optedIn: PerTitleGoal = {
			...anchor,
			minBitrateStepSize: 1.2,
			maxBitrateStepSize: 4,
			adjustments: {
				streams: {
					b: { maxBitrate: { mode: "auto", method: "proportional" } },
				},
			},
		};
		const result = tunePerTitleSettings(
			{ ...optedIn, maxBitrate: 20_000_000 },
			optedIn,
		);
		expect(result.goal.rows?.find((row) => row.id === "b")).toEqual({
			...optedIn.rows?.find((row) => row.id === "b"),
			maxBitrate: 2_000_000,
		});
		expect(result.goal.rows?.find((row) => row.id === "a")).toEqual(
			optedIn.rows?.find((row) => row.id === "a"),
		);
		expect(result.proposal.api.global).toMatchObject({
			minBitrateStepSize: 1.2,
			maxBitrateStepSize: 4,
		});
	});

	it("captures the displayed automatic value when it is fixed, independently for each endpoint", () => {
		let draft: PerTitleGoal = {
			...anchor,
			maxBitrate: 20_000_000,
			adjustments: {
				streams: {
					b: {
						minBitrate: { mode: "auto", method: "logarithmic" },
						maxBitrate: { mode: "auto", method: "logarithmic" },
					},
				},
			},
		};
		const current = tunePerTitleSettings(draft, anchor);
		const fixed = getPerTitleSetting(
			current.proposal,
			"stream",
			"maxBitrate",
			"b",
		);
		expect(fixed).not.toBe(anchor.rows?.[1]?.maxBitrate);
		draft = setPerTitleAdjustment(
			draft,
			current.proposal,
			"stream",
			"maxBitrate",
			{ mode: "fixed" },
			"b",
		);
		const next = tunePerTitleSettings(
			{ ...draft, maxBitrate: 30_000_000 },
			anchor,
		);
		expect(getPerTitleSetting(next.proposal, "stream", "maxBitrate", "b")).toBe(
			fixed,
		);
		expect(next.goal.rows?.[1]?.minBitrate).not.toBe(
			current.goal.rows?.[1]?.minBitrate,
		);
	});

	it("uses the loaded reference for proportional scaling without cumulative drift", () => {
		let draft = setPerTitleAdjustment(
			anchor,
			recommendPerTitleSettings(anchor),
			"stream",
			"maxBitrate",
			{ mode: "auto", method: "proportional" },
			"b",
		);
		for (const [maximum, expected] of [
			[20_000_000, 2_000_000],
			[30_000_000, 3_000_000],
			[10_000_000, 1_000_000],
		] as const) {
			const result = tunePerTitleSettings(
				{ ...draft, maxBitrate: maximum },
				anchor,
			);
			expect(
				getPerTitleSetting(result.proposal, "stream", "maxBitrate", "b"),
			).toBe(expected);
			draft = result.goal;
		}
	});

	it("offers logarithmic placement separately from proportional scaling", () => {
		const draft: PerTitleGoal = {
			...anchor,
			maxBitrate: 20_000_000,
			adjustments: {
				streams: {
					b: { maxBitrate: { mode: "auto", method: "logarithmic" } },
				},
			},
		};
		const logarithmic = tunePerTitleSettings(draft, anchor);
		const proportional = tunePerTitleSettings(
			setPerTitleAdjustment(
				draft,
				logarithmic.proposal,
				"stream",
				"maxBitrate",
				{ mode: "auto", method: "proportional" },
				"b",
			),
			anchor,
		);
		expect(logarithmic.goal.rows?.[1]?.maxBitrate).toBe(
			Math.round(Math.sqrt(100_000 * 20_000_000)),
		);
		expect(proportional.goal.rows?.[1]?.maxBitrate).toBe(2_000_000);
	});

	it("derives new bands from current requirements when constraints is selected", () => {
		const start = tunePerTitleSettings(anchor, anchor);
		const draft = setPerTitleAdjustment(
			anchor,
			start.proposal,
			"stream",
			"maxBitrate",
			{ mode: "auto", method: "constraints" },
			"b",
		);
		expect(tunePerTitleSettings(draft, anchor).goal.rows?.[1]?.maxBitrate).toBe(
			Math.round(Math.exp(Math.log(100_000) + (3 / 5) * Math.log(100))),
		);
	});

	it("keeps fixed steps and boundaries while other automatic fields move", () => {
		let draft = setPerTitleSetting(
			anchor,
			"global",
			"minBitrateStepSize",
			1.75,
		);
		draft = setPerTitleSetting(draft, "global", "maxBitrateStepSize", 4);
		draft = setPerTitleSetting(
			draft,
			"stream",
			"lowComplexityBoundaryForMaxBitrate",
			3_000_000,
			"b",
		);
		draft = setPerTitleSetting(
			draft,
			"stream",
			"highComplexityBoundaryForMaxBitrate",
			8_000_000,
			"b",
		);
		draft = setPerTitleSetting(
			draft,
			"stream",
			"bitrateSelectionMode",
			"COMPLEXITY_RANGE",
			"b",
		);
		const result = tunePerTitleSettings(
			{ ...draft, maxBitrate: 12_000_000 },
			anchor,
		);
		expect(result.proposal.api.global).toMatchObject({
			minBitrateStepSize: 1.75,
			maxBitrateStepSize: 4,
		});
		expect(
			result.proposal.api.streams.find((s) => s.rowId === "b")
				?.perTitleSettings,
		).toMatchObject({
			lowComplexityBoundaryForMaxBitrate: 3_000_000,
			highComplexityBoundaryForMaxBitrate: 8_000_000,
		});
	});

	it("does not repair a fixed contradictory value or carry a previous proof forward", () => {
		const draft = setPerTitleSetting(
			anchor,
			"stream",
			"maxBitrate",
			40_000_000,
			"b",
		);
		const result = tunePerTitleSettings(draft, anchor);
		expect(result.goal.rows?.[1]?.maxBitrate).toBe(40_000_000);
		expect(result.proposal.status).toBe("conflict");
		expect(result.proposal.applicable).toBe(false);
		expect(result.proposal.derivation?.targetSatisfied ?? false).toBe(false);
	});

	it.each([
		[
			"lowComplexityBoundaryForMaxBitrate",
			3_000_000,
			"highComplexityBoundaryForMaxBitrate",
			false,
		],
		[
			"highComplexityBoundaryForMaxBitrate",
			8_000_000,
			"lowComplexityBoundaryForMaxBitrate",
			false,
		],
		[
			"lowComplexityBoundaryForMaxBitrate",
			3_000_000,
			"highComplexityBoundaryForMaxBitrate",
			true,
		],
		[
			"highComplexityBoundaryForMaxBitrate",
			8_000_000,
			"lowComplexityBoundaryForMaxBitrate",
			true,
		],
	] as const)("keeps %s fixed while calculating %s/%s (fixed selection %s)", (key, value, automatic, fixedSelection) => {
		let draft = setPerTitleSetting(
			automaticCalibration,
			"stream",
			key,
			value,
			"b",
		);
		if (fixedSelection)
			draft = setPerTitleSetting(
				draft,
				"stream",
				"bitrateSelectionMode",
				"COMPLEXITY_RANGE",
				"b",
			);
		const { proposal } = tunePerTitleSettings(draft, anchor);
		const actual = proposal.api.streams.find(
			(stream) => stream.rowId === "b",
		)?.perTitleSettings;
		expect(actual?.[key]).toBe(value);
		expect(actual?.bitrateSelectionMode).toBe("COMPLEXITY_RANGE");
		expect(actual?.[automatic]).toBeTypeOf("number");
		expect(actual?.lowComplexityBoundaryForMaxBitrate).toBeLessThan(
			actual?.highComplexityBoundaryForMaxBitrate ?? 0,
		);
	});

	it("supports automatic overall minimum and maximum without a feedback loop", () => {
		const current = tunePerTitleSettings(anchor, anchor).proposal;
		let draft = setPerTitleAdjustment(anchor, current, "global", "minBitrate", {
			mode: "auto",
			method: "proportional",
		});
		expect(
			tunePerTitleSettings({ ...draft, maxBitrate: 20_000_000 }, anchor).goal
				.minBitrate,
		).toBe(200_000);
		draft = setPerTitleAdjustment(draft, current, "global", "maxBitrate", {
			mode: "auto",
			method: "proportional",
		});
		const result = tunePerTitleSettings(
			{ ...draft, minBitrate: 500_000, maxBitrate: 90_000_000 },
			anchor,
		);
		expect(result.goal).toMatchObject({
			minBitrate: anchor.minBitrate,
			maxBitrate: anchor.maxBitrate,
		});
	});

	it("calculates both automatic boundaries when only the selection method is fixed", () => {
		const draft = setPerTitleSetting(
			automaticCalibration,
			"stream",
			"bitrateSelectionMode",
			"COMPLEXITY_RANGE",
			"b",
		);
		const { proposal } = tunePerTitleSettings(draft, anchor);
		const settings = proposal.api.streams.find(
			(stream) => stream.rowId === "b",
		)?.perTitleSettings;
		expect(settings?.bitrateSelectionMode).toBe("COMPLEXITY_RANGE");
		expect(settings?.lowComplexityBoundaryForMaxBitrate).toBeTypeOf("number");
		expect(settings?.highComplexityBoundaryForMaxBitrate).toBe(
			anchor.maxBitrate,
		);
		expect(
			proposal.diagnostics.some(
				(item) => item.code === "invalid-complexity-range",
			),
		).toBe(false);
	});

	it("preserves a fixed additional-rendition rule when the count requirement changes", () => {
		const loaded: PerTitleGoal = {
			...anchor,
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		};
		const result = tunePerTitleSettings(
			{ ...loaded, countPolicy: { kind: "exact", count: 6 } },
			loaded,
		);
		expect(
			result.proposal.api.global.fixedResolutionAndBitrateConfiguration,
		).toEqual(loaded.fixedResolutionAndBitrateConfiguration);
	});

	it("uses provider defaults for optional automatic quality and retains fixed zero", () => {
		const loaded: PerTitleGoal = {
			...anchor,
			targetQualityCrf: 24,
			resolutionScaleFactor: 0,
		};
		expect(
			getPerTitleAdjustment(loaded, loaded, "global", "targetQualityCrf"),
		).toEqual({ mode: "fixed" });
		const before = tunePerTitleSettings(loaded, loaded);
		expect(before.proposal.api.global).toMatchObject({
			targetQualityCrf: 24,
			resolutionScaleFactor: 0,
		});
		let draft = setPerTitleAdjustment(
			loaded,
			before.proposal,
			"global",
			"targetQualityCrf",
			{ mode: "auto", method: "default" },
		);
		const automatic = tunePerTitleSettings(draft, loaded);
		expect(automatic.proposal.api.global.targetQualityCrf).toBeUndefined();
		draft = setPerTitleAdjustment(
			draft,
			automatic.proposal,
			"global",
			"targetQualityCrf",
			{ mode: "fixed" },
		);
		expect(
			tunePerTitleSettings(draft, loaded).proposal.api.global.targetQualityCrf,
		).toBeUndefined();
	});

	it("scales complexity boundaries in bitrate units and does not cap them to the overall maximum", () => {
		const loaded: PerTitleGoal = {
			...anchor,
			rows: anchor.rows?.map((r) => ({
				...r,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 5_000_000,
				highComplexityBoundaryForMaxBitrate: 20_000_000,
			})),
		};
		let draft = setPerTitleAdjustment(
			loaded,
			recommendPerTitleSettings(loaded),
			"stream",
			"lowComplexityBoundaryForMaxBitrate",
			{ mode: "auto", method: "proportional" },
			"b",
		);
		draft = setPerTitleAdjustment(
			draft,
			recommendPerTitleSettings(loaded),
			"stream",
			"highComplexityBoundaryForMaxBitrate",
			{ mode: "auto", method: "proportional" },
			"b",
		);
		const result = tunePerTitleSettings(
			{ ...draft, maxBitrate: 20_000_000 },
			loaded,
		);
		expect(result.goal.rows?.[1]).toMatchObject({
			lowComplexityBoundaryForMaxBitrate: 10_000_000,
			highComplexityBoundaryForMaxBitrate: 40_000_000,
		});
	});

	it("does not mutate either source or allow adjustment metadata into API settings", () => {
		const draft = setPerTitleSetting(anchor, "global", "complexityFactor", 1.5);
		const snapshot = structuredClone(draft);
		const result = tunePerTitleSettings(draft, anchor);
		expect(draft).toEqual(snapshot);
		expect(JSON.stringify(result.proposal.api)).not.toContain("adjustments");
		expect(JSON.stringify(result.proposal.api)).not.toContain("settingLocks");
	});

	it("limits fields and adjustment methods to their codec and unit semantics", () => {
		expect(perTitleGlobalFields("H265V2").map((f) => f.key)).toContain(
			"targetQualityQp",
		);
		expect(perTitleGlobalFields("H265V2").map((f) => f.key)).not.toContain(
			"codecBufsizeFactor",
		);
		expect(perTitleGlobalFields("AV1").map((f) => f.key)).not.toContain(
			"codecMaxBitrateFactor",
		);
		expect(perTitleStreamFields("VP9").map((f) => f.key)).not.toContain(
			"codecBufsizeFactor",
		);
		expect(
			perTitleGlobalFields("H264").find((f) => f.key === "targetQualityCrf")
				?.methods,
		).toEqual(["default"]);
	});

	it("parks a fixed zero threshold while automatic resolutions are disabled", () => {
		const loaded: PerTitleGoal = {
			...anchor,
			strategy: "required-resolutions",
			autoRepresentations: { adoptConfigurationThreshold: 0 },
		};
		const disabled = setPerTitleSetting(
			loaded,
			"global",
			"autoRepresentations",
			false,
		);
		const off = tunePerTitleSettings(disabled, loaded);
		expect(off.proposal.api.global.autoRepresentations).toBeUndefined();
		expect(
			getPerTitleGoalSetting(
				disabled,
				"global",
				"autoRepresentations.adoptConfigurationThreshold",
			),
		).toBe(0);
		const enabled = setPerTitleSetting(
			off.goal,
			"global",
			"autoRepresentations",
			true,
		);
		expect(
			tunePerTitleSettings(enabled, loaded).proposal.api.global
				.autoRepresentations,
		).toEqual({ adoptConfigurationThreshold: 0 });
	});

	it("materializes implicit automatic templates for editable stream factors", () => {
		const loaded: PerTitleGoal = {
			...anchor,
			strategy: "automatic",
			rows: undefined,
		};
		const before = tunePerTitleSettings(loaded, loaded);
		const template = before.proposal.api.streams.find(
			(stream) => stream.mode === "PER_TITLE_TEMPLATE",
		);
		expect(template).toBeDefined();
		const draft = setPerTitleSetting(
			loaded,
			"stream",
			"codecMaxBitrateFactor",
			1.4,
			template?.rowId,
		);
		const result = tunePerTitleSettings(draft, loaded);
		expect(
			result.proposal.api.streams.find(
				(stream) => stream.rowId === template?.rowId,
			)?.perTitleSettings,
		).toEqual({ codecMaxBitrateFactor: 1.4 });
	});

	it("retains a fixed zero threshold when the parent follows the requirements", () => {
		const loaded: PerTitleGoal = {
			...anchor,
			strategy: "required-resolutions",
			autoRepresentations: { adoptConfigurationThreshold: 0 },
		};
		const before = tunePerTitleSettings(loaded, loaded);
		const draft = setPerTitleAdjustment(
			loaded,
			before.proposal,
			"global",
			"autoRepresentations",
			{ mode: "auto", method: "constraints" },
		);
		expect(
			tunePerTitleSettings(draft, loaded).proposal.api.global
				.autoRepresentations,
		).toEqual({ adoptConfigurationThreshold: 0 });
	});

	it("rejects a dimensionless field's incompatible scaling method without a stale proof", () => {
		const invalid: PerTitleGoal = {
			...anchor,
			adjustments: {
				global: { targetQualityCrf: { mode: "auto", method: "proportional" } },
			},
		};
		const result = tunePerTitleSettings(invalid, anchor);
		expect(result.proposal).toMatchObject({
			status: "conflict",
			applicable: false,
			scenarios: [],
		});
		expect(result.proposal.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "invalid-setting",
				severity: "conflict",
			}),
		);
		expect(result.proposal.derivation).toBeUndefined();
	});

	it("uses the same documented default steps as the core model", () => {
		let draft = setPerTitleAdjustment(
			anchor,
			recommendPerTitleSettings(anchor),
			"global",
			"minBitrateStepSize",
			{ mode: "auto", method: "default" },
		);
		draft = setPerTitleAdjustment(
			draft,
			recommendPerTitleSettings(anchor),
			"global",
			"maxBitrateStepSize",
			{ mode: "auto", method: "default" },
		);
		expect(
			tunePerTitleSettings(draft, anchor).proposal.api.global,
		).toMatchObject({ minBitrateStepSize: 1.5, maxBitrateStepSize: 1.9 });
	});

	it.each([
		{ global: { unknown: { mode: "auto", method: "constraints" } } },
		{ streams: { missing: { minBitrate: { mode: "fixed" } } } },
		{ streams: { a: { unsupported: { mode: "fixed" } } } },
	] as const)("rejects unknown tuning paths and row identities: %j", (adjustments) => {
		const result = tunePerTitleSettings(
			{ ...anchor, adjustments } as unknown as PerTitleGoal,
			anchor,
		);
		expect(result.proposal).toMatchObject({
			status: "conflict",
			applicable: false,
			scenarios: [],
		});
		expect(result.proposal.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "invalid-setting",
				severity: "conflict",
			}),
		);
	});

	it.each([
		"__proto__",
		"constructor",
	])("keeps row identities opaque: %s", (id) => {
		const goal = JSON.parse(
			JSON.stringify({
				...anchor,
				rows: [{ id, height: 360, minBitrate: 100_000, maxBitrate: 500_000 }],
			}),
		) as PerTitleGoal;
		const manual = setPerTitleSetting(
			goal,
			"stream",
			"maxBitrate",
			600_000,
			id,
		);
		expect(
			tunePerTitleSettings(manual, goal).proposal.api.streams[0]
				?.perTitleSettings?.maxBitrate,
		).toBe(600_000);
	});

	it.each([
		{ global: { minBitrateStepSize: null } },
		{ global: { minBitrateStepSize: false } },
		{ streams: { a: null } },
		{ streams: [] },
		{ global: { maxBitrate: { mode: "fixed", method: "constraints" } } },
		{ inactiveAutoRepresentationThreshold: Number.NaN },
		{ inactiveAutoRepresentationThreshold: -1 },
	])("rejects malformed direct adjustment metadata without throwing: %j", (adjustments) => {
		const result = tunePerTitleSettings(
			{ ...anchor, adjustments } as unknown as PerTitleGoal,
			anchor,
		);
		expect(result.proposal).toMatchObject({
			status: "conflict",
			applicable: false,
			scenarios: [],
		});
		expect(result.proposal.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "invalid-setting",
				severity: "conflict",
			}),
		);
	});
});
