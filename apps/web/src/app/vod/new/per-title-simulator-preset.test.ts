import type { PerTitleGoal } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	parsePerTitlePreset,
	serializePerTitlePreset,
} from "./per-title-simulator-preset";

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
		expect(() => serializePerTitlePreset(incomplete)).toThrow(
			"Invalid Per-Title preset.",
		);
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
