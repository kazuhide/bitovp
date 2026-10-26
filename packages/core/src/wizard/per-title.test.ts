import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { compilePlan } from "../plan/compiler";
import { INTERNAL_HEVC_V2_BCF_VERSION } from "../plan/internal-hevc-v2";
import {
	perTitleTemplates,
	templateStreamRefSchema,
} from "../plan/per-title-results";
import {
	encodingPlanSchema,
	perTitleSchema,
	streamModeSchema,
} from "../plan/schema";
import { planToEncodingTemplateYaml } from "../plan/template";
import { loadPlan } from "../plan/test-support";
import { validatePlan } from "../plan/validate";
import { compileExpectedArtefacts } from "../verify/expected";
import { buildPlan } from "./build-plan";
import { planToWizardState } from "./plan-to-wizard";

const fixedConfiguration = {
	forcedRenditionAboveHighestFixedRepresentation: 0,
	forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
};

describe("wizard Per-Title authoring", () => {
	it.each([
		{ codecMaxBitrateFactor: 1.75 },
		{ codecBufsizeFactor: 2.5 },
	])("rejects unsupported outer H265V2 stream settings %j before compilation", (perTitleSettings) => {
		const source = loadPlan("pertitle-h265-fmp4-dash-hls-on-aws");
		const renditions = source.renditions.map((rendition) =>
			rendition.key === "v180" ? { ...rendition, perTitleSettings } : rendition,
		);
		const normal = encodingPlanSchema.parse({ ...source, renditions });
		expect(
			validatePlan(normal).filter(
				(issue) => issue.code === "PLAN_PER_TITLE_STREAM_CODEC_FACTOR",
			),
		).toEqual([]);
		const internal = encodingPlanSchema.parse({
			...normal,
			internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
			perTitle: { h265V2Configuration: {} },
		});
		expect(
			validatePlan(internal).filter(
				(issue) => issue.code === "PLAN_PER_TITLE_STREAM_CODEC_FACTOR",
			),
		).toEqual([
			expect.objectContaining({
				code: "PLAN_PER_TITLE_STREAM_CODEC_FACTOR",
				level: "error",
				path: "renditions.0.perTitleSettings",
			}),
		]);
	});
	it("retains H265V2 zero QP and fractional scale without unsupported CRF or buffer fields", () => {
		const source = loadPlan("pertitle-h265-fmp4-dash-hls-on-aws");
		const configuration = {
			targetQualityQp: 0,
			resolutionScaleFactor: 1.25,
			codecMinBitrateFactor: 0.5,
			codecMaxBitrateFactor: 1.8,
		};
		const plan = encodingPlanSchema.parse({
			...source,
			internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
			perTitle: { h265V2Configuration: configuration },
		});
		const state = planToWizardState(plan);
		expect(state.startOptions?.perTitle?.h265).toEqual(configuration);
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		expect(rebuilt.perTitle).toEqual(plan.perTitle);
		expect(
			compilePlan(rebuilt).find(
				(operation) => operation.kind === "START_ENCODING",
			)?.payload.perTitle,
		).toEqual(plan.perTitle);
	});
	it.each([
		-15, 0, 15,
	])("accepts documented resolutionScaleFactor endpoint %s", (resolutionScaleFactor) => {
		expect(
			perTitleSchema.parse({ av1Configuration: { resolutionScaleFactor } }),
		).toEqual({ av1Configuration: { resolutionScaleFactor } });
	});
	it.each([
		["h264", "pertitle-h264-fmp4-ts-dash-hls-on-aws"],
		["h265", "pertitle-h265-fmp4-dash-hls-on-aws"],
		["vp9", "pertitle-vp9-webm-fmp4-dash-on-aws"],
		["av1", "pertitle-av1-fmp4-dash-on-aws"],
	] as const)("round-trips the fractional %s resolution scale through the wizard and START", (codec, fixture) => {
		const source = loadPlan(fixture);
		const field = `${codec}Configuration` as const;
		const plan = encodingPlanSchema.parse({
			...source,
			perTitle: { [field]: { resolutionScaleFactor: -2.25 } },
		});
		const state = planToWizardState(plan);
		expect(state.startOptions?.perTitle?.[codec]).toEqual({
			resolutionScaleFactor: -2.25,
		});
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		expect(rebuilt.perTitle).toEqual(plan.perTitle);
		expect(
			compilePlan(rebuilt).find(
				(operation) => operation.kind === "START_ENCODING",
			)?.payload.perTitle,
		).toEqual(plan.perTitle);
	});

	it.each([
		"PER_TITLE_TEMPLATE",
		"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	] as const)("serializes outer codec factors separately for %s streams", (mode) => {
		const source = loadPlan("pertitle-h264-fmp4-ts-dash-hls-on-aws");
		const fixed =
			mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE"
				? {
						minBitrate: 200000,
						maxBitrate: 400000,
						bitrateSelectionMode: "OPTIMIZED" as const,
					}
				: {};
		const settings = {
			...fixed,
			codecMaxBitrateFactor: 1.75,
			codecBufsizeFactor: 2.5,
		};
		const plan = encodingPlanSchema.parse({
			...source,
			renditions: source.renditions.map((rendition) =>
				rendition.key === "v180"
					? { ...rendition, mode, perTitleSettings: settings }
					: rendition,
			),
		});
		const rebuilt = encodingPlanSchema.parse(
			buildPlan(planToWizardState(plan)),
		);
		expect(rebuilt.renditions.find((row) => row.key === "v180")).toMatchObject({
			perTitleSettings: settings,
		});
		const wire = {
			codecMaxBitrateFactor: 1.75,
			codecBufsizeFactor: 2.5,
			...(Object.keys(fixed).length
				? { fixedResolutionAndBitrateSettings: fixed }
				: {}),
		};
		expect(
			compilePlan(rebuilt).find((operation) => operation.step === "stream:v180")
				?.payload.perTitleSettings,
		).toEqual(wire);
		expect(
			perTitleTemplates(rebuilt).find((row) => row.rendition === "v180")
				?.perTitleSettings,
		).toEqual(wire);
		const yaml = parse(planToEncodingTemplateYaml(rebuilt));
		expect(
			yaml.encodings.main.streams.v180.properties.perTitleSettings,
		).toEqual(wire);
	});

	it.each([
		-15.01,
		15.01,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects out-of-range resolutionScaleFactor %s", (resolutionScaleFactor) => {
		expect(
			perTitleSchema.safeParse({ h264Configuration: { resolutionScaleFactor } })
				.success,
		).toBe(false);
	});
	it.each([
		["h264", "pertitle-h264-fmp4-ts-dash-hls-on-aws"],
		["h265", "pertitle-h265-fmp4-dash-hls-on-aws"],
		["vp9", "pertitle-vp9-webm-fmp4-dash-on-aws"],
		["av1", "pertitle-av1-fmp4-dash-on-aws"],
	] as const)("retains %s minimum bitrate ratio through import, wizard build and START", (codec, fixture) => {
		const source = loadPlan(fixture);
		const field = `${codec}Configuration` as const;
		const configuration = {
			...source.perTitle?.[field],
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 4,
		};
		const plan = encodingPlanSchema.parse({
			...source,
			perTitle: { [field]: configuration },
		});
		const state = planToWizardState(plan);
		expect(state.startOptions?.perTitle?.[codec]).toMatchObject({
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 4,
		});
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		expect(rebuilt.perTitle).toEqual(plan.perTitle);
		expect(
			compilePlan(rebuilt).find(
				(operation) => operation.kind === "START_ENCODING",
			)?.payload.perTitle,
		).toEqual(plan.perTitle);
	});

	it.each([
		0,
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects an invalid minimum bitrate ratio %s", (minBitrateStepSize) => {
		expect(
			perTitleSchema.safeParse({
				h264Configuration: { minBitrateStepSize },
			}).success,
		).toBe(false);
	});

	it("retains a fixed-resolution template through schema, wizard, stream and capture contracts", () => {
		const mode = streamModeSchema.parse("PER_TITLE_TEMPLATE_FIXED_RESOLUTION");
		const source = loadPlan("pertitle-av1-fmp4-dash-on-aws");
		const plan = encodingPlanSchema.parse({
			...source,
			renditions: source.renditions.map((rendition) =>
				rendition.key === "v360" ? { ...rendition, mode } : rendition,
			),
		});
		const state = planToWizardState(plan);
		expect(state.videos[0]?.extras?.mode).toBe(mode);
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		expect(rebuilt).toEqual(plan);
		expect(
			validatePlan(rebuilt).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const operations = compilePlan(rebuilt);
		expect(
			operations.find((operation) => operation.step === "stream:v360")?.payload,
		).toHaveProperty("mode", mode);
		const template = perTitleTemplates(rebuilt).find(
			(row) => row.rendition === "v360",
		);
		expect(templateStreamRefSchema.parse(template)).toMatchObject({
			rendition: "v360",
			mode,
			height: 360,
		});
		expect(
			operations.find(
				(operation) => operation.kind === "CAPTURE_PER_TITLE_RESULTS",
			)?.payload.templates,
		).toContainEqual(template);
		expect(
			compileExpectedArtefacts(rebuilt).muxings.find(
				(muxing) => muxing.streamKey === "v360",
			),
		).toMatchObject({
			perTitle: true,
			perTitleMode: "TEMPLATE",
		});
	});

	it.each([
		"LAST_CALCULATED_BITRATE",
		"MINIMUM",
		"MAXIMUM",
		"AVERAGE",
	] as const)("round-trips %s fixed-resolution-and-bitrate configuration into START", (mode) => {
		const configuration = {
			...fixedConfiguration,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode: mode,
		};
		const source = loadPlan("pertitle-av1-fmp4-dash-on-aws");
		const plan = encodingPlanSchema.parse({
			...source,
			perTitle: {
				av1Configuration: {
					fixedResolutionAndBitrateConfiguration: configuration,
				},
			},
		});
		const state = planToWizardState(plan);
		expect(state.startOptions?.perTitle?.av1).toMatchObject(configuration);
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		expect(rebuilt).toEqual(plan);
		expect(
			compilePlan(rebuilt).find(
				(operation) => operation.kind === "START_ENCODING",
			)?.payload.perTitle,
		).toEqual({
			av1Configuration: {
				fixedResolutionAndBitrateConfiguration: configuration,
			},
		});
	});

	it("rejects the unsupported LOWEST_FIXED_BITRATE calculation mode", () => {
		expect(
			perTitleSchema.safeParse({
				h264Configuration: {
					fixedResolutionAndBitrateConfiguration: {
						forcedRenditionAboveHighestFixedRepresentationCalculationMode:
							"LOWEST_FIXED_BITRATE",
					},
				},
			}).success,
		).toBe(false);
	});
});
