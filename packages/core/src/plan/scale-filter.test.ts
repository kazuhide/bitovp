import { describe, expect, it } from "vitest";
import { buildPlan } from "../wizard/build-plan";
import {
	planToWizardState,
	tryImportPresetIntoWizard,
} from "../wizard/plan-to-wizard";
import { compilePlan } from "./compiler";
import { curlForStep } from "./curl-from-step";
import { mediaFilterSchema } from "./media-filters";
import { buildResourceTree } from "./resource-tree";
import { encodingPlanSchema } from "./schema";
import { initStepLog, stepLogSchema } from "./steplog";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

const optionalParameters = [
	{},
	{ width: 1280 },
	{ height: 720 },
	{ scalingAlgorithm: "BICUBIC" },
	{
		width: 1920,
		height: 1080,
		scalingAlgorithm: "LANCZOS",
		sampleAspectRatioNumerator: 1,
		sampleAspectRatioDenominator: 1,
	},
] as const;

function scalePlan(parameters: Record<string, unknown>) {
	const plan = loadPlan("fixed-bitrate-hls-on-aws");
	return encodingPlanSchema.parse({
		...plan,
		filters: [{ key: "scale", kind: "SCALE", ...parameters }],
		renditions: plan.renditions.map((r) => ({
			...r,
			...(r.codec === "H264"
				? { filters: [{ filterKey: "scale", position: 3 }] }
				: {}),
		})),
	});
}

describe("Scale filter", () => {
	it.each(
		optionalParameters,
	)("preserves optional parameters %j through form hydration and rebuilding", (parameters) => {
		const plan = scalePlan(parameters);
		expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
		const hydrated = tryImportPresetIntoWizard(plan);
		expect(hydrated.ok).toBe(true);
		const state = planToWizardState(plan);
		expect(state.filters).toEqual(plan.filters);
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		expect(rebuilt.filters).toEqual(plan.filters);
		expect(rebuilt.renditions.map((r) => r.filters)).toEqual(
			plan.renditions.map((r) => r.filters),
		);
		const creates = compilePlan(rebuilt).filter(
			(o) => o.kind === "CREATE_FILTER_SCALE",
		);
		expect(creates).toHaveLength(
			plan.renditions.filter((r) => r.codec === "H264").length,
		);
		for (const op of creates) expect(op.payload).toEqual(parameters);
	});
	it("retains per-attachment resource keys and positions without changing codec dimensions", () => {
		const plan = scalePlan({ width: 640, scalingAlgorithm: "LANCZOS" });
		const ops = compilePlan(plan);
		for (const video of plan.renditions.filter((r) => r.codec === "H264")) {
			expect(ops.find((o) => o.step === `filter:${video.key}:scale`)).toEqual({
				step: `filter:${video.key}:scale`,
				kind: "CREATE_FILTER_SCALE",
				payload: { width: 640, scalingAlgorithm: "LANCZOS" },
				refs: {},
			});
			expect(
				ops.find((o) => o.step === `stream-filters:${video.key}`),
			).toMatchObject({
				payload: { positions: [3] },
				refs: { filterIds: [`filter:${video.key}:scale`] },
			});
			expect(
				ops.find((o) => o.step === `codec:${video.key}`)?.payload.height,
			).toBe(video.height);
		}
		const yaml = planToEncodingTemplateYaml(plan);
		expect(yaml).toContain("scale:");
		expect(yaml).toContain("$/filters/scale/");
		expect(yaml).toContain("scalingAlgorithm: LANCZOS");
	});
	it("does not add a Scale operation to existing plans", () => {
		expect(
			compilePlan(loadPlan("fixed-bitrate-hls-on-aws")).some(
				(o) => o.kind === "CREATE_FILTER_SCALE",
			),
		).toBe(false);
	});
	it("persists Scale operations and exposes their endpoint in existing job tools", () => {
		const ops = compilePlan(
			scalePlan({ width: 1280, scalingAlgorithm: "LANCZOS" }),
		);
		const log = stepLogSchema.parse(initStepLog(ops));
		const scale = log.find((entry) => entry.kind === "CREATE_FILTER_SCALE");
		if (!scale) throw new Error("missing Scale operation");
		scale.status = "DONE";
		scale.resourceId = "scale-id";
		scale.request = { ...scale.payload, refs: {} };
		const curl = curlForStep(scale);
		expect(curl.ok).toBe(true);
		if (curl.ok) {
			expect(curl.command).toContain("/encoding/filters/scale");
			expect(curl.command).toContain('"scalingAlgorithm": "LANCZOS"');
		}
		expect(buildResourceTree([scale])).toEqual([
			expect.objectContaining({
				id: "filters",
				nodes: [
					expect.objectContaining({
						resourceId: "scale-id",
						kind: "CREATE_FILTER_SCALE",
					}),
				],
			}),
		]);
	});
	it.each([
		{ scalingAlgorithm: "UNKNOWN" },
		{ width: 0 },
		{ width: 1.5 },
		{ height: -1 },
		{ height: 2147483648 },
		{ width: null },
		{ sampleAspectRatioNumerator: 1 },
		{ sampleAspectRatioDenominator: 1 },
		{ sampleAspectRatioNumerator: 0, sampleAspectRatioDenominator: 1 },
		{ sampleAspectRatioNumerator: 1, sampleAspectRatioDenominator: 0 },
		{ sampleAspectRatioNumerator: 1.5, sampleAspectRatioDenominator: 1 },
	])("rejects invalid parameters %j before form hydration", (parameters) => {
		const filter = { key: "scale", kind: "SCALE", ...parameters };
		expect(mediaFilterSchema.safeParse(filter).success).toBe(false);
		const plan = { ...loadPlan("fixed-bitrate-hls-on-aws"), filters: [filter] };
		expect(encodingPlanSchema.safeParse(plan).success).toBe(false);
		expect(tryImportPresetIntoWizard(plan).ok).toBe(false);
	});
	it("rejects Scale attachments on audio renditions", () => {
		const plan = scalePlan({});
		const audio = plan.renditions.find((r) => r.codec === "AAC");
		if (!audio) throw new Error("missing fixture audio");
		audio.filters = [{ filterKey: "scale", position: 0 }];
		expect(validatePlan(plan).map((i) => i.code)).toContain(
			"PLAN_FILTER_MEDIA_TYPE",
		);
	});
});
