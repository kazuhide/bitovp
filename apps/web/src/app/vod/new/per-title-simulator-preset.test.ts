import type { PerTitleGoal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	parsePerTitlePreset,
	serializePerTitlePreset,
} from "./per-title-simulator-preset";
import {
	setPerTitleSetting,
	tunePerTitleSettings,
} from "./per-title-simulator-tuning";

const goal: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100000,
	maxBitrate: 4000000,
	minBitrateStepSize: 1.4,
	maxBitrateStepSize: 3,
	countPolicy: { kind: "unrestricted" },
	rows: [
		{ id: "sample-low", height: 240, minBitrate: 200000, maxBitrate: 400000 },
	],
};
const reference = {
	codec: "H264",
	global: {
		minBitrate: 100000,
		maxBitrate: 4000000,
		minBitrateStepSize: 1.4,
		maxBitrateStepSize: 3,
		targetQualityCrf: 20,
		fixedResolutionAndBitrateConfiguration: {
			forcedRenditionAboveHighestFixedRepresentation: 1,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.3,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"LAST_CALCULATED_BITRATE",
		},
	},
	streams: [
		{
			id: "sample-auto",
			codec: "H264",
			mode: "PER_TITLE_TEMPLATE",
			height: 960,
			bitrate: null,
			level: null,
			profile: "HIGH",
			sao: false,
			adaptiveQuantizationStrength: 0.7,
			colorConfig: {
				colorSpace: "BT709",
				colorTransfer: "BT709",
				colorPrimaries: "BT709",
			},
		},
		{
			id: "sample-low",
			codec: "H264",
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			height: 240,
			perTitleSettings: {
				minBitrate: 200000,
				maxBitrate: 400000,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 900000,
				highComplexityBoundaryForMaxBitrate: 3500000,
			},
		},
	],
};
function parse(value: unknown) {
	return parsePerTitlePreset(JSON.stringify(value), ["H264", "H265"]);
}

describe("Per-Title local presets", () => {
	it.each([
		"both",
		"low",
		"high",
	] as const)("round-trips a tuned fixed selection with %s boundary requirements", (fixedBoundary) => {
		let draft = setPerTitleSetting(
			{
				...goal,
				adjustments: {
					streams: {
						"sample-low": {
							lowComplexityBoundaryForMaxBitrate: {
								mode: "auto",
								method: "constraints",
							},
							highComplexityBoundaryForMaxBitrate: {
								mode: "auto",
								method: "constraints",
							},
						},
					},
				},
			},
			"stream",
			"bitrateSelectionMode",
			"COMPLEXITY_RANGE",
			"sample-low",
		);
		if (fixedBoundary === "low")
			draft = setPerTitleSetting(
				draft,
				"stream",
				"lowComplexityBoundaryForMaxBitrate",
				800000,
				"sample-low",
			);
		if (fixedBoundary === "high")
			draft = setPerTitleSetting(
				draft,
				"stream",
				"highComplexityBoundaryForMaxBitrate",
				3000000,
				"sample-low",
			);
		const before = structuredClone(draft);
		const tuned = tunePerTitleSettings(draft, goal);
		const settings = tuned.proposal.api.streams[0]?.perTitleSettings;
		expect(settings?.bitrateSelectionMode).toBe("COMPLEXITY_RANGE");
		expect(settings?.lowComplexityBoundaryForMaxBitrate).toBeTypeOf("number");
		expect(settings?.highComplexityBoundaryForMaxBitrate).toBeTypeOf("number");
		const loaded = parse(JSON.parse(serializePerTitlePreset(tuned.goal)));
		expect(loaded.goal).toEqual(tuned.goal);
		expect(tunePerTitleSettings(loaded.goal, loaded.goal).proposal.api).toEqual(
			tuned.proposal.api,
		);
		expect(draft).toEqual(before);
	});

	it("does not allow missing source-reference boundaries or a fixed-unset boundary", () => {
		const incomplete = {
			minBitrate: 200000,
			maxBitrate: 400000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 800000,
		};
		expect(() =>
			parse({
				version: 1,
				goal: {
					...goal,
					rows: [{ id: "sample-low", height: 240, ...incomplete }],
				},
			}),
		).toThrow("Invalid Per-Title preset.");
		expect(() =>
			parse({
				version: 1,
				reference: {
					...reference,
					streams: [{ ...reference.streams[1], perTitleSettings: incomplete }],
				},
			}),
		).toThrow("Invalid Per-Title preset.");
		const fixedUnset = {
			...goal,
			rows: [{ id: "sample-low", height: 240, ...incomplete }],
			adjustments: {
				streams: {
					"sample-low": {
						highComplexityBoundaryForMaxBitrate: { mode: "fixed" },
					},
				},
			},
			settingLocks: {
				streams: {
					"sample-low": [
						"bitrateSelectionMode",
						"highComplexityBoundaryForMaxBitrate",
					],
				},
			},
		};
		expect(() => parse({ version: 1, goal: fixedUnset })).toThrow(
			"Invalid Per-Title preset.",
		);
	});
	it("accepts explicit automatic boundary policies without derived locks", () => {
		const draft: PerTitleGoal = {
			...goal,
			rows: goal.rows?.map((row) => ({
				...row,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
			})),
			adjustments: {
				streams: {
					"sample-low": {
						bitrateSelectionMode: { mode: "fixed" },
						lowComplexityBoundaryForMaxBitrate: {
							mode: "auto",
							method: "constraints",
						},
						highComplexityBoundaryForMaxBitrate: {
							mode: "auto",
							method: "constraints",
						},
					},
				},
			},
		};
		const loaded = parse(JSON.parse(serializePerTitlePreset(draft))).goal;
		expect(
			tunePerTitleSettings(loaded, loaded).proposal.api.streams[0]
				?.perTitleSettings?.bitrateSelectionMode,
		).toBe("COMPLEXITY_RANGE");
	});
	it.each([
		{ lowComplexityBoundaryForMaxBitrate: 0 },
		{
			lowComplexityBoundaryForMaxBitrate: 3000000,
			highComplexityBoundaryForMaxBitrate: 2000000,
		},
	])("rejects defined invalid automatic boundary values %j", (boundaries) => {
		expect(() =>
			parse({
				version: 1,
				goal: {
					...goal,
					rows: goal.rows?.map((row) => ({
						...row,
						bitrateSelectionMode: "COMPLEXITY_RANGE",
						...boundaries,
					})),
					adjustments: {
						streams: {
							"sample-low": {
								lowComplexityBoundaryForMaxBitrate: {
									mode: "auto",
									method: "constraints",
								},
								highComplexityBoundaryForMaxBitrate: {
									mode: "auto",
									method: "constraints",
								},
							},
						},
					},
				},
			}),
		).toThrow("Invalid Per-Title preset.");
	});
	it.each([
		["minBitrateStepSize", 3],
		["maxBitrateStepSize", 1.2],
	] as const)("round-trips a tuned fixed %s with an automatic unset peer", (key, value) => {
		const peer =
			key === "minBitrateStepSize"
				? "maxBitrateStepSize"
				: "minBitrateStepSize";
		const draft = setPerTitleSetting(
			{
				...goal,
				adjustments: {
					global: { [peer]: { mode: "auto", method: "constraints" } },
				},
			},
			"global",
			key,
			value,
		);
		const tuned = tunePerTitleSettings(draft, goal);
		expect(tuned.goal[key]).toBe(value);
		expect(tuned.goal[peer]).toBeUndefined();
		expect(parse(JSON.parse(serializePerTitlePreset(tuned.goal))).goal).toEqual(
			tuned.goal,
		);
	});
	it.each([
		0, 0.35, 1,
	])("preserves a parked automatic-representation threshold %s", (inactiveAutoRepresentationThreshold) => {
		const edited = {
			...goal,
			autoRepresentations: false as const,
			adjustments: { inactiveAutoRepresentationThreshold },
		};
		expect(parse(JSON.parse(serializePerTitlePreset(edited))).goal).toEqual(
			edited,
		);
	});
	it.each([
		-0.01, 1.01,
	])("rejects an out-of-range parked threshold %s", (inactiveAutoRepresentationThreshold) => {
		expect(() =>
			parse({
				version: 1,
				goal: { ...goal, adjustments: { inactiveAutoRepresentationThreshold } },
			}),
		).toThrow("Invalid Per-Title preset.");
	});
	it("retains all supported global and outer stream settings in an editable reference", () => {
		const original = {
			...reference,
			global: {
				...reference.global,
				targetQualityCrf: 0,
				complexityFactor: 0.8,
				resolutionScaleFactor: -1.25,
				codecMinBitrateFactor: 0.5,
				codecMaxBitrateFactor: 1.8,
				codecBufsizeFactor: 2.4,
			},
			streams: reference.streams.map((stream) => ({
				...stream,
				perTitleSettings: {
					...stream.perTitleSettings,
					codecMaxBitrateFactor: 1.6,
					codecBufsizeFactor: 2.2,
				},
			})),
		};
		const parsed = parse({ version: 1, reference: original });
		expect(parsed.goal).toMatchObject(original.global);
		expect(parsed.goal.automaticTemplates?.[0]).toMatchObject({
			codecMaxBitrateFactor: 1.6,
			codecBufsizeFactor: 2.2,
		});
		expect(parsed.goal.rows?.[0]).toMatchObject({
			codecMaxBitrateFactor: 1.6,
			codecBufsizeFactor: 2.2,
		});
		expect(
			parse(JSON.parse(serializePerTitlePreset(parsed.goal, parsed.reference))),
		).toEqual(parsed);
	});

	it("round-trips canonical setting locks and automatic adjustment methods", () => {
		const edited = {
			...goal,
			settingLocks: {
				global: [
					"resolutionScaleFactor",
					"autoRepresentations.adoptConfigurationThreshold",
				],
				streams: { "sample-low": ["codecMaxBitrateFactor", "minBitrate"] },
			},
			adjustments: {
				global: {
					resolutionScaleFactor: { mode: "fixed" as const },
					maxBitrateStepSize: {
						mode: "auto" as const,
						method: "constraints" as const,
					},
				},
				streams: {
					"sample-low": {
						minBitrate: {
							mode: "auto" as const,
							method: "proportional" as const,
						},
					},
				},
			},
		};
		expect(parse(JSON.parse(serializePerTitlePreset(edited))).goal).toEqual(
			edited,
		);
	});

	it.each([
		{ settingLocks: { global: ["credentials"] } },
		{ settingLocks: { streams: { "sample-low": ["codecMinBitrateFactor"] } } },
		{
			adjustments: {
				global: { maxBitrate: { mode: "auto", method: "guess" } },
			},
		},
		{
			adjustments: { streams: { "sample-low": { secret: { mode: "fixed" } } } },
		},
		{
			adjustments: {
				global: { targetQualityCrf: { mode: "auto", method: "proportional" } },
			},
		},
	])("rejects unsupported tuning metadata %j", (metadata) => {
		expect(() => parse({ version: 1, goal: { ...goal, ...metadata } })).toThrow(
			"Invalid Per-Title preset.",
		);
	});
	it("rejects a fixed required step without a stored value", () => {
		const edited = {
			...goal,
			minBitrateStepSize: undefined,
			adjustments: { global: { minBitrateStepSize: { mode: "fixed" } } },
		};
		expect(() => parse({ version: 1, goal: edited })).toThrow(
			"Invalid Per-Title preset.",
		);
	});

	it.each([
		["VP9", { codecMaxBitrateFactor: 1.5 }],
		["AV1", { codecBufsizeFactor: 2 }],
		["H265V2", { targetQualityCrf: 20 }],
		["H265", { targetQualityQp: 20 }],
	] as const)("rejects unsupported %s global settings", (codec, fields) => {
		expect(() =>
			parsePerTitlePreset(
				JSON.stringify({ version: 1, goal: { ...goal, codec, ...fields } }),
				[codec],
			),
		).toThrow("Invalid Per-Title preset.");
	});

	it("supports a zero H265V2 probe QP without adding a CRF", () => {
		const edited = {
			...goal,
			codec: "H265V2" as const,
			targetQualityQp: 0,
			resolutionScaleFactor: 0,
		};
		expect(
			parsePerTitlePreset(serializePerTitlePreset(edited), ["H265V2"]).goal,
		).toEqual(edited);
	});
	it("preserves disabled auto representations when the original reference omits the object", () => {
		const parsed = parse({ version: 1, reference });
		expect(parsed.goal.autoRepresentations).toBe(false);
		expect(parsed.reference).toEqual(reference);
		expect(
			parse(JSON.parse(serializePerTitlePreset(parsed.goal, parsed.reference)))
				.goal.autoRepresentations,
		).toBe(false);
	});
	it.each([
		{},
		{ adoptConfigurationThreshold: 0 },
		{ adoptConfigurationThreshold: 0.35 },
		{ adoptConfigurationThreshold: 1 },
	])("preserves explicit automatic representation configuration %j", (autoRepresentations) => {
		const original = {
			...reference,
			global: { ...reference.global, autoRepresentations },
		};
		const parsed = parse({ version: 1, reference: original });
		expect(parsed.goal.autoRepresentations).toEqual(autoRepresentations);
		expect(parsed.reference).toEqual(original);
		expect(
			parse(JSON.parse(serializePerTitlePreset(parsed.goal, parsed.reference)))
				.goal,
		).toEqual(parsed.goal);
	});
	it.each([
		false,
		{},
		{ adoptConfigurationThreshold: 0.6 },
	] as const)("roundtrips an editable goal auto representation setting %j", (autoRepresentations) => {
		const edited: PerTitleGoal = { ...goal, autoRepresentations };
		expect(parse(JSON.parse(serializePerTitlePreset(edited))).goal).toEqual(
			edited,
		);
	});
	it.each([
		false,
		true,
		{ adoptConfigurationThreshold: -0.01 },
		{ adoptConfigurationThreshold: 1.01 },
		{ adoptConfigurationThreshold: "0.5" },
		{ unknown: "sentinel" },
	])("rejects unsupported reference automatic representation data %j", (autoRepresentations) => {
		expect(() =>
			parse({
				version: 1,
				reference: {
					...reference,
					global: { ...reference.global, autoRepresentations },
				},
			}),
		).toThrow("Invalid Per-Title preset.");
	});
	it.each([
		{
			codec: "H264",
			metadata: {
				profile: "MAIN",
				subMe: "RD_IP",
				slices: 2,
				trellis: "ENABLED_FINAL_MB",
				mvSearchRangeMax: 24,
				motionEstimationMethod: "HEX",
				mvPredictionMode: "TEMPORAL",
				psyTrellis: 0.2,
			},
		},
		{
			codec: "H265",
			metadata: { profile: "MAIN", subMe: 2, sao: true },
		},
		{
			codec: "VP9",
			metadata: {
				cpuUsed: -2,
				tileColumns: 1,
				qpMax: 48,
				rateUndershootPct: 20,
				rateOvershootPct: 30,
				quality: "GOOD",
				aqMode: "VARIANCE",
				arnrType: "CENTERED",
				arnrMaxFrames: 5,
				arnrStrength: 2,
			},
		},
	] as const)("roundtrips synthetic $codec comparison metadata without adding encoding requirements", ({
		codec,
		metadata,
	}) => {
		const original = {
			codec,
			global: {
				minBitrate: 100000,
				maxBitrate: 2000000,
				complexityFactor: 1.25,
			},
			streams: [
				{
					id: "generic-auto",
					mode: "PER_TITLE_TEMPLATE",
					height: 720,
					level: null,
					...metadata,
					colorConfig: {
						colorSpace: "BT709",
						copyColorPrimariesFlag: true,
						copyColorTransferFlag: false,
						copyColorSpaceFlag: true,
						copyChromaLocationFlag: false,
						copyColorRangeFlag: true,
					},
				},
				{
					id: "generic-required",
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					height: 360,
					...metadata,
					perTitleSettings: { minBitrate: 200000, maxBitrate: 600000 },
				},
			],
		};
		const parsed = parsePerTitlePreset(
			JSON.stringify({ version: 1, reference: original }),
			[codec],
		);
		expect(parsed.reference).toEqual(original);
		expect(
			parsePerTitlePreset(
				serializePerTitlePreset(parsed.goal, parsed.reference),
				[codec],
			),
		).toEqual(parsed);
		expect(parsed.goal).toHaveProperty("complexityFactor", 1.25);
		expect(parsed.goal.rows?.[0]).toEqual({
			id: "generic-required",
			height: 360,
			minBitrate: 200000,
			maxBitrate: 600000,
		});
		expect(parsed.goal.automaticTemplates?.[0]).toEqual({
			id: "generic-auto",
			height: 720,
		});
	});

	it.each([
		["subMe", true],
		["subMe", -1],
		["slices", "2"],
		["trellis", 1],
		["mvSearchRangeMax", -1],
		["motionEstimationMethod", []],
		["mvPredictionMode", null],
		["psyTrellis", -0.1],
		["cpuUsed", 1.5],
		["cpuUsed", "-2"],
		["cpuUsed", Number.MAX_SAFE_INTEGER + 1],
		["tileColumns", false],
		["qpMax", "48"],
		["rateUndershootPct", -1],
		["rateOvershootPct", null],
		["quality", {}],
		["aqMode", "lowercase"],
		["arnrType", "CENTERED;OTHER"],
		["arnrMaxFrames", -1],
		["arnrStrength", false],
		["unexpectedMetadata", 1],
	] as const)("rejects invalid reference metadata %s=%j", (key, value) => {
		expect(() =>
			parse({
				version: 1,
				reference: {
					...reference,
					streams: [{ ...reference.streams[0], [key]: value }],
				},
			}),
		).toThrow("Invalid Per-Title preset.");
	});

	it.each([
		0,
		-1,
		"1.25",
		null,
	])("rejects invalid reference complexity factor %j", (complexityFactor) => {
		expect(() =>
			parse({
				version: 1,
				reference: {
					...reference,
					global: { ...reference.global, complexityFactor },
				},
			}),
		).toThrow("Invalid Per-Title preset.");
	});

	it.each([
		"copyColorPrimariesFlag",
		"copyColorTransferFlag",
		"copyColorSpaceFlag",
		"copyChromaLocationFlag",
		"copyColorRangeFlag",
	])("requires a boolean for %s", (flag) => {
		expect(() =>
			parse({
				version: 1,
				reference: {
					...reference,
					streams: [
						{ ...reference.streams[0], colorConfig: { [flag]: "true" } },
					],
				},
			}),
		).toThrow("Invalid Per-Title preset.");
	});

	it("roundtrips a generic goal without inventing defaults", () => {
		expect(
			parsePerTitlePreset(serializePerTitlePreset(goal), ["H264"]),
		).toEqual({ goal });
	});
	it("preserves the reference and separates automatic templates from required rows", () => {
		const parsed = parse({ version: 1, reference });
		expect(parsed.reference).toEqual(reference);
		expect(parsed.goal.countPolicy).toEqual({ kind: "unrestricted" });
		expect(parsed.goal.rows?.map((row) => row.id)).toEqual(["sample-low"]);
		expect(parsed.goal).toMatchObject({
			automaticTemplates: [{ id: "sample-auto", height: 960 }],
		});
		expect(
			parsePerTitlePreset(
				serializePerTitlePreset(parsed.goal, parsed.reference),
				["H264"],
			),
		).toEqual(parsed);
	});
	it("preserves optional automatic range metadata without turning it into a required row", () => {
		const automaticRow = {
			...reference.streams[0],
			perTitleSettings: {
				minBitrate: 180000,
				maxBitrate: 320000,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 800000,
				highComplexityBoundaryForMaxBitrate: 3000000,
			},
		};
		const parsed = parse({
			version: 1,
			reference: {
				...reference,
				streams: [automaticRow, reference.streams[1]],
			},
		});
		expect(parsed.goal.automaticTemplates?.[0]).toMatchObject({
			id: "sample-auto",
			...automaticRow.perTitleSettings,
		});
		expect(parsed.goal.rows?.map((row) => row.id)).toEqual(["sample-low"]);
		expect(parsed.reference?.streams[0]).toEqual(automaticRow);
	});

	it("accepts a matching editable goal and immutable original reference", () => {
		expect(
			parse({ version: 1, goal: { ...goal, maxBitrate: 5000000 }, reference })
				.goal.maxBitrate,
		).toBe(5000000);
	});
	it("gates codecs for both payload variants", () => {
		for (const value of [
			{ version: 1, goal: { ...goal, codec: "H265V2" } },
			{ version: 1, reference: { ...reference, codec: "H265V2" } },
		])
			expect(() => parse(value)).toThrow("Invalid Per-Title preset.");
		expect(
			parsePerTitlePreset(
				JSON.stringify({ version: 1, goal: { ...goal, codec: "H265V2" } }),
				["H265V2"],
			).goal.codec,
		).toBe("H265V2");
	});
	it.each([
		{},
		{ version: 2, goal },
		{ version: 1, goal, credential: "sensitive-sentinel" },
		{ version: 1, goal: { ...goal, secretAccessKey: "sensitive-sentinel" } },
		{ version: 1, goal: { ...goal, countPolicy: { kind: "exact", count: 0 } } },
		{
			version: 1,
			goal: { ...goal, countPolicy: { kind: "unrestricted", count: 2 } },
		},
		{ version: 1, goal: { ...goal, rows: [goal.rows?.[0], goal.rows?.[0]] } },
		{ version: 1, goal: { ...goal, maxBitrate: Number.MAX_SAFE_INTEGER + 1 } },
		{ version: 1, goal: { ...goal, minBitrateStepSize: 1 } },
		{
			version: 1,
			reference: {
				...reference,
				global: { ...reference.global, token: "sensitive-sentinel" },
			},
		},
		{
			version: 1,
			reference: {
				...reference,
				streams: reference.streams.map((row) => ({
					...row,
					ingestKey: "private",
				})),
			},
		},
		{ version: 1, goal: { ...goal, codec: "H265" }, reference },
		{
			version: 1,
			goal: {
				...goal,
				rows: Array.from({ length: 65 }, (_, i) => ({
					...goal.rows?.[0],
					id: `row-${i}`,
				})),
			},
		},
	])("rejects invalid and non-allowlisted payloads without leaking values %#", (value) => {
		expect(() => parse(value)).toThrow("Invalid Per-Title preset.");
	});
	it.each([
		{
			version: 1,
			reference: {
				...reference,
				streams: [reference.streams[0], reference.streams[0]],
			},
		},
		{
			version: 1,
			reference: {
				...reference,
				streams: [{ ...reference.streams[1], height: undefined }],
			},
		},
		{
			version: 1,
			reference: {
				...reference,
				streams: [{ ...reference.streams[1], perTitleSettings: undefined }],
			},
		},
		{
			version: 1,
			reference: {
				...reference,
				streams: [
					{ ...reference.streams[0], colorConfig: { token: "sentinel" } },
				],
			},
		},
		{
			version: 1,
			goal: {
				...goal,
				automaticTemplates: Array.from({ length: 64 }, (_, i) => ({
					id: `auto-${i}`,
				})),
			},
		},
		{
			version: 1,
			goal: { ...goal, rows: [{ ...goal.rows?.[0], height: 1.5 }] },
		},
		{
			version: 1,
			goal: {
				...goal,
				rows: [{ ...goal.rows?.[0], minBitrate: 500000, maxBitrate: 200000 }],
			},
		},
		{ version: 1, goal: { ...goal, rows: [{ ...goal.rows?.[0], id: "" }] } },
		{
			version: 1,
			goal: { ...goal, minBitrateStepSize: 4, maxBitrateStepSize: 2 },
		},
		{ version: 1, goal: { ...goal, scenarioFractions: [Number.NaN] } },
	])("rejects invalid nested fields and aggregate template limits %#", (value) => {
		expect(() => parse(value)).toThrow("Invalid Per-Title preset.");
	});
	it("allows exactly 64 explicit automatic templates and does not infer their output count", () => {
		const parsed = parse({
			version: 1,
			reference: {
				...reference,
				streams: Array.from({ length: 64 }, (_, i) => ({
					...reference.streams[0],
					id: `auto-${i}`,
				})),
			},
		});
		expect(parsed.goal.automaticTemplates).toHaveLength(64);
		expect(parsed.goal.rows).toEqual([]);
		expect(parsed.goal.countPolicy).toEqual({ kind: "unrestricted" });
	});
	it("retains all documented forced calculation modes", () => {
		for (const mode of [
			"LAST_CALCULATED_BITRATE",
			"MINIMUM",
			"MAXIMUM",
			"AVERAGE",
		]) {
			const parsed = parse({
				version: 1,
				reference: {
					...reference,
					global: {
						...reference.global,
						fixedResolutionAndBitrateConfiguration: {
							forcedRenditionAboveHighestFixedRepresentationCalculationMode:
								mode,
						},
					},
				},
			});
			expect(
				parsed.goal.fixedResolutionAndBitrateConfiguration
					?.forcedRenditionAboveHighestFixedRepresentationCalculationMode,
			).toBe(mode);
		}
	});
	it("rejects unsupported mixed fixed modes instead of silently adding bitrate ranges", () => {
		expect(() =>
			parse({
				version: 1,
				reference: {
					...reference,
					streams: [
						reference.streams[1],
						{
							id: "plain-fixed",
							mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
							height: 480,
						},
					],
				},
			}),
		).toThrow("Invalid Per-Title preset.");
	});

	it("roundtrips identifiers generated by the UI", () => {
		for (const value of ["_r_4_-new-1", ":r2:-new-1"]) {
			const own = {
				...goal,
				rows: [{ ...goal.rows?.[0], id: value }],
			} as PerTitleGoal;
			expect(
				parsePerTitlePreset(serializePerTitlePreset(own), ["H264"]).goal
					.rows?.[0]?.id,
			).toBe(value);
		}
	});

	it("roundtrips parked rows in automatic and count modes without treating them as requirements", () => {
		for (const strategy of ["automatic", "count"] as const) {
			const parked: PerTitleGoal = {
				...goal,
				strategy,
				countPolicy:
					strategy === "count"
						? { kind: "exact", count: 1 }
						: { kind: "unrestricted" },
				rows: [
					{
						id: "parked",
						height: 360,
						minBitrate: 9000000,
						maxBitrate: 8000000,
					},
				],
			};
			expect(
				parsePerTitlePreset(serializePerTitlePreset(parked), ["H264"]).goal,
			).toEqual(parked);
			expect(() =>
				serializePerTitlePreset({ ...parked, strategy: "fixed-ranges" }),
			).toThrow("Invalid Per-Title preset.");
		}
	});

	it("roundtrips independently optional automatic bitrate bounds", () => {
		for (const bounds of [
			{ minBitrate: 150000 },
			{ maxBitrate: 300000 },
			{ lowComplexityBoundaryForMaxBitrate: 700000 },
		]) {
			const auto = { id: "optional-auto", height: 720, ...bounds };
			const edited = { ...goal, automaticTemplates: [auto] };
			expect(
				parsePerTitlePreset(serializePerTitlePreset(edited), ["H264"]).goal,
			).toEqual(edited);
			const imported = parse({
				version: 1,
				reference: {
					...reference,
					streams: [
						{
							id: "optional-auto",
							mode: "PER_TITLE_TEMPLATE",
							perTitleSettings: bounds,
						},
					],
				},
			});
			expect(imported.goal.automaticTemplates?.[0]).toEqual({
				id: "optional-auto",
				...bounds,
			});
		}
		const incomplete = {
			...goal,
			automaticTemplates: [
				{
					id: "auto",
					bitrateSelectionMode: "COMPLEXITY_RANGE" as const,
					lowComplexityBoundaryForMaxBitrate: 700000,
				},
			],
		};
		expect(
			parsePerTitlePreset(serializePerTitlePreset(incomplete), ["H264"]).goal,
		).toEqual(incomplete);
	});
	it("retains inactive fixed-mode settings as source data without validating them as automatic constraints", () => {
		const inactive = {
			minBitrate: 800000,
			maxBitrate: 300000,
			bitrateSelectionMode: "COMPLEXITY_RANGE" as const,
			lowComplexityBoundaryForMaxBitrate: 2000000,
		};
		const original = {
			...reference,
			streams: [
				{ ...reference.streams[0], perTitleSettings: inactive },
				reference.streams[1],
			],
		};
		const loaded = parse({ version: 1, reference: original });
		expect(loaded.reference).toEqual(original);
		expect(loaded.goal.automaticTemplates?.[0]).toMatchObject(inactive);
		expect(
			parsePerTitlePreset(
				serializePerTitlePreset(loaded.goal, loaded.reference),
				["H264"],
			),
		).toEqual(loaded);
	});
	it("preserves hidden bitrate ranges after switching to fixed resolutions", () => {
		const edited: PerTitleGoal = {
			...goal,
			strategy: "fixed-resolutions",
			maxBitrate: 500000,
			rows: [
				{ id: "retained", height: 360, minBitrate: 200000, maxBitrate: 600000 },
			],
		};
		expect(
			parsePerTitlePreset(serializePerTitlePreset(edited), ["H264"]).goal,
		).toEqual(edited);
		expect(() =>
			serializePerTitlePreset({ ...edited, strategy: "fixed-ranges" }),
		).toThrow("Invalid Per-Title preset.");
		const oneSided = {
			...edited,
			rows: [{ id: "retained", height: 360, minBitrate: 200000 }],
		};
		expect(
			parsePerTitlePreset(serializePerTitlePreset(oneSided), ["H264"]).goal,
		).toEqual(oneSided);
		expect(() =>
			serializePerTitlePreset({ ...oneSided, strategy: "fixed-ranges" }),
		).toThrow("Invalid Per-Title preset.");
	});

	it("bounds UTF-8 input before parsing and sanitizes JSON errors", () => {
		for (const text of [
			"{sensitive-sentinel",
			" ".repeat(128 * 1024 + 1),
			JSON.stringify({ unknown: "界".repeat(44000) }),
		]) {
			expect(() => parsePerTitlePreset(text, ["H264"])).toThrow(
				"Invalid Per-Title preset.",
			);
		}
	});
	it("validates serialization instead of exporting unexpected metadata", () => {
		expect(() =>
			serializePerTitlePreset({
				...goal,
				credential: "sensitive-sentinel",
			} as PerTitleGoal),
		).toThrow("Invalid Per-Title preset.");
	});
});
