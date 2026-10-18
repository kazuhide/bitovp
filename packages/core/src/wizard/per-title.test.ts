import { describe, expect, it } from "vitest";
import { compilePlan } from "../plan/compiler";
import {
	perTitleTemplates,
	templateStreamRefSchema,
} from "../plan/per-title-results";
import {
	encodingPlanSchema,
	perTitleSchema,
	streamModeSchema,
} from "../plan/schema";
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
