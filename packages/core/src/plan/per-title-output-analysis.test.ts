import { describe, expect, it } from "vitest";
import { resolvePerTitleAnalysis } from "./per-title-output-analysis.js";
import type { PerTitleApiSettings } from "./per-title-simulator.js";

type Stream = PerTitleApiSettings["streams"][number];
type Rule = NonNullable<
	PerTitleApiSettings["global"]["fixedResolutionAndBitrateConfiguration"]
>;

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing fixture value");
	return value;
}

const fixed = (
	rowId: string,
	height: number,
	minBitrate = 200_000,
	width?: number,
): Stream => ({
	rowId,
	height,
	...(width !== undefined ? { width } : {}),
	mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	perTitleSettings: { minBitrate, maxBitrate: 1_200_000 },
});

const settings = (
	streams: Stream[] = [fixed("fixed", 720)],
): PerTitleApiSettings => ({
	global: {
		minBitrate: 100_000,
		maxBitrate: 4_000_000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 1.9,
	},
	streams,
});

describe("resolvePerTitleAnalysis", () => {
	it("uses the global minimum without a minimum-bitrate fixed range", () => {
		const api = settings([
			{ rowId: "automatic", mode: "PER_TITLE_TEMPLATE" },
			{
				rowId: "resolution",
				height: 720,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			},
		]);
		expect(resolvePerTitleAnalysis(api, 50_000)).toEqual({
			floor: 100_000,
			complexityInput: 100_000,
			usesAspectRatioAssumption: false,
		});
	});

	it("raises the assumed input to a fixed minimum using a stated aspect ratio assumption", () => {
		expect(resolvePerTitleAnalysis(settings(), 100_000)).toEqual({
			floor: 200_000,
			complexityInput: 200_000,
			usesAspectRatioAssumption: true,
		});
		expect(resolvePerTitleAnalysis(settings(), 500_000).complexityInput).toBe(
			500_000,
		);
	});

	it("does not require ordinary template dimensions to compare known fixed widths", () => {
		const api = settings([
			fixed("small", 360, 200_000, 640),
			fixed("large", 720, 600_000, 1280),
			{ rowId: "automatic", mode: "PER_TITLE_TEMPLATE" },
		]);
		expect(resolvePerTitleAnalysis(api, 400_000)).toEqual({
			floor: 600_000,
			complexityInput: 600_000,
			usesAspectRatioAssumption: false,
		});
	});

	it("uses known widths even when a fixed height is unspecified", () => {
		const row = fixed("width-only", 720, 200_000, 1280);
		delete row.height;
		expect(resolvePerTitleAnalysis(settings([row]), 300_000)).toEqual({
			floor: 200_000,
			complexityInput: 300_000,
			usesAspectRatioAssumption: false,
		});
	});

	it("counts fixed resolutions above the highest minimum, but not ordinary candidates", () => {
		const api = settings([
			fixed("range", 360, 200_000, 640),
			{
				rowId: "resolution",
				height: 720,
				width: 1280,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			},
			{ rowId: "automatic", height: 1080, mode: "PER_TITLE_TEMPLATE" },
		]);
		expect(resolvePerTitleAnalysis(api, 200_000).floor).toBe(300_000);
	});

	it("ignores ambiguous lower-width groups when the highest minimum has a unique width", () => {
		const api = settings([
			fixed("lower-a", 360, 200_000, 640),
			fixed("lower-b", 360, 300_000, 640),
			fixed("top", 720, 600_000, 1280),
		]);
		expect(resolvePerTitleAnalysis(api, 200_000).floor).toBe(600_000);
	});

	it("counts a tied highest group when every row has the same fixed minimum", () => {
		const api = settings([
			fixed("equal-a", 720, 200_000, 1280),
			fixed("equal-b", 720, 200_000, 1280),
			{
				rowId: "higher",
				height: 1080,
				width: 1920,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			},
		]);
		expect(resolvePerTitleAnalysis(api, 100_000).floor).toBe(450_000);
	});

	it.each([
		{
			streams: [fixed("a", 720, 200_000, 1280), fixed("b", 720, 300_000, 1280)],
		},
		{
			streams: [
				fixed("a", 720, 200_000, 1280),
				{
					rowId: "b",
					height: 720,
					width: 1280,
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" as const,
				},
			],
		},
		{ streams: [fixed("a", 360, 200_000, 640), fixed("b", 720)] },
	])("withholds a floor when the relevant ordering cannot be resolved: %j", ({
		streams,
	}) => {
		expect(resolvePerTitleAnalysis(settings(streams), 500_000)).toMatchObject({
			floor: null,
			complexityInput: null,
		});
	});

	it("treats a zero additional count like an absent rule without inventing other fields", () => {
		const api = settings();
		api.global.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 0,
		};
		expect(resolvePerTitleAnalysis(api, 100_000).floor).toBe(200_000);
	});

	it.each([
		undefined,
		"LAST_CALCULATED_BITRATE",
		"MINIMUM",
		"MAXIMUM",
		"AVERAGE",
		"UNKNOWN",
	])("does not make the floor depend on the additional calculation mode: %s", (mode) => {
		const api = settings();
		api.global.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 2,
			forcedRenditionAboveHighestFixedRepresentationFactor: 2,
			...(mode !== undefined
				? {
						forcedRenditionAboveHighestFixedRepresentationCalculationMode:
							mode as "MINIMUM",
					}
				: {}),
		};
		expect(resolvePerTitleAnalysis(api, 100_000).floor).toBe(800_000);
	});

	it("keeps the two truncation stages separate", () => {
		const api = settings([
			fixed("minimum", 360, 101, 640),
			{
				rowId: "higher",
				height: 720,
				width: 1280,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			},
		]);
		api.global.minBitrate = 10;
		api.global.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 1,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.01,
		};
		expect(resolvePerTitleAnalysis(api, 100).floor).toBe(152);
	});

	it("applies an additional factor as a power before truncating rather than rounding every step", () => {
		const api = settings([fixed("minimum", 720, 101, 1280)]);
		api.global.minBitrate = 10;
		api.global.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 2,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.5,
		};
		expect(resolvePerTitleAnalysis(api, 100).floor).toBe(227);
	});

	it("does not cap the floor or resulting complexity input at the global maximum", () => {
		const api = settings();
		api.global.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 2,
			forcedRenditionAboveHighestFixedRepresentationFactor: 10,
		};
		expect(resolvePerTitleAnalysis(api, 4_000_000)).toMatchObject({
			floor: 20_000_000,
			complexityInput: 20_000_000,
		});
	});

	it("does not raise a decreasing factor's floor to the global minimum", () => {
		const api = settings();
		api.global.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 2,
			forcedRenditionAboveHighestFixedRepresentationFactor: 0.5,
		};
		expect(resolvePerTitleAnalysis(api, 30_000).floor).toBe(50_000);
		api.global.fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentation = 20;
		expect(resolvePerTitleAnalysis(api, 30_000)).toMatchObject({
			floor: 0,
			complexityInput: 30_000,
		});
	});

	it.each([
		null,
		0,
		-1,
		1.5,
		Number.NaN,
		Infinity,
		Number.MAX_SAFE_INTEGER + 1,
	])("can retain a valid floor without a valid analysis input: %s", (input) => {
		expect(resolvePerTitleAnalysis(settings(), input)).toMatchObject({
			floor: 200_000,
			complexityInput: null,
		});
	});

	it.each([
		(api: PerTitleApiSettings) => {
			api.global.minBitrate = 0;
		},
		(api: PerTitleApiSettings) => {
			api.global.maxBitrate = 99_999;
		},
		(api: PerTitleApiSettings) => {
			api.global.minBitrateStepSize = 1;
		},
		(api: PerTitleApiSettings) => {
			api.global.maxBitrateStepSize = 1.4;
		},
		(api: PerTitleApiSettings) => {
			api.global.minBitrateStepSize = Infinity;
		},
		(api: PerTitleApiSettings) => {
			required(api.streams[0]).width = 0;
		},
		(api: PerTitleApiSettings) => {
			delete required(api.streams[0]).height;
		},
		(api: PerTitleApiSettings) => {
			delete required(required(api.streams[0]).perTitleSettings).minBitrate;
		},
		(api: PerTitleApiSettings) => {
			delete required(required(api.streams[0]).perTitleSettings).maxBitrate;
		},
		(api: PerTitleApiSettings) => {
			required(required(api.streams[0]).perTitleSettings).minBitrate =
				1_300_000;
		},
		(api: PerTitleApiSettings) => {
			required(required(api.streams[0]).perTitleSettings).minBitrate = 99_999;
		},
		(api: PerTitleApiSettings) => {
			required(required(api.streams[0]).perTitleSettings).maxBitrate =
				4_000_001;
		},
		(api: PerTitleApiSettings) => {
			api.global.fixedResolutionAndBitrateConfiguration = {};
		},
		(api: PerTitleApiSettings) => {
			api.global.fixedResolutionAndBitrateConfiguration =
				null as unknown as Rule;
		},
		(api: PerTitleApiSettings) => {
			api.global.fixedResolutionAndBitrateConfiguration = {
				forcedRenditionAboveHighestFixedRepresentation: null,
			} as unknown as Rule;
		},
		(api: PerTitleApiSettings) => {
			api.global.fixedResolutionAndBitrateConfiguration = {
				forcedRenditionAboveHighestFixedRepresentation: -1,
			};
		},
		(api: PerTitleApiSettings) => {
			api.global.fixedResolutionAndBitrateConfiguration = {
				forcedRenditionAboveHighestFixedRepresentation: 1,
			};
		},
		(api: PerTitleApiSettings) => {
			api.global.fixedResolutionAndBitrateConfiguration = {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 0,
			};
		},
		(api: PerTitleApiSettings) => {
			api.global.fixedResolutionAndBitrateConfiguration = {
				forcedRenditionAboveHighestFixedRepresentation: 0,
				forcedRenditionAboveHighestFixedRepresentationFactor: Infinity,
			};
		},
		(api: PerTitleApiSettings) => {
			api.global.fixedResolutionAndBitrateConfiguration = {
				forcedRenditionAboveHighestFixedRepresentation: 1.5,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
			};
		},
	])("withholds both results for invalid or incomplete arithmetic settings: %s", (change) => {
		const api = settings();
		change(api);
		expect(resolvePerTitleAnalysis(api, 500_000)).toMatchObject({
			floor: null,
			complexityInput: null,
		});
	});

	it("rejects unsafe intermediate arithmetic even if a later factor would reduce it", () => {
		const api = settings([
			fixed("minimum", 360, 200_000, 640),
			{
				rowId: "higher",
				height: 720,
				width: 1280,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			},
		]);
		api.global.minBitrateStepSize = 1e12;
		api.global.maxBitrateStepSize = 1e12;
		api.global.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 1,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1e-12,
		};
		expect(resolvePerTitleAnalysis(api, 100_000)).toMatchObject({
			floor: null,
			complexityInput: null,
		});
	});

	it("rejects overflow from the additional factor power", () => {
		const api = settings();
		api.global.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: 2,
			forcedRenditionAboveHighestFixedRepresentationFactor: Number.MAX_VALUE,
		};
		expect(resolvePerTitleAnalysis(api, 100_000)).toMatchObject({
			floor: null,
			complexityInput: null,
		});
	});
});
