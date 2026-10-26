import { expect, it } from "vitest";
import { parse } from "yaml";
import { buildPlan } from "../wizard/build-plan";
import { planToWizardState } from "../wizard/plan-to-wizard";
import { compilePlan } from "./compiler";
import { encodingPlanSchema, renditionSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

const masterDisplay =
	"G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)";

function av1Plan(fields: Record<string, unknown>) {
	const base = loadPlan("av1-fmp4-dash-hls");
	return encodingPlanSchema.parse({
		...base,
		renditions: base.renditions.map((row) =>
			row.codec === "AV1" ? { ...row, ...fields } : row,
		),
	});
}

it.each([
	["VP9", "vp9-webm-fixed-dash"],
	["AV1", "av1-fmp4-dash-hls"],
] as const)("preserves explicit %s width through plans, operations and templates", (codec, fixture) => {
	const base = loadPlan(fixture);
	const state = planToWizardState(base);
	for (const row of state.videos) row.width = 640;
	const plan = encodingPlanSchema.parse(buildPlan(state));
	expect(encodingPlanSchema.parse(buildPlan(planToWizardState(plan)))).toEqual(
		plan,
	);
	expect(validatePlan(plan).filter((issue) => issue.level === "error")).toEqual(
		[],
	);
	for (const operation of compilePlan(plan).filter(
		(op) => op.kind === `CREATE_CODEC_${codec}`,
	))
		expect(operation.payload).toHaveProperty("width", 640);
	const yaml = parse(planToEncodingTemplateYaml(plan));
	for (const row of plan.renditions.filter((row) => row.codec === codec))
		expect(
			yaml.configurations.video[codec.toLowerCase()][row.key].properties,
		).toHaveProperty("width", 640);
});

it.each([
	"L4_1",
	"4.1",
])("normalizes AV1 maximum level %s and retains HDR10 metadata", (maxLevel) => {
	const fields = {
		width: 1920,
		maxLevel,
		dynamicRangeFormat: "HDR10",
		masterDisplay,
		maxContentLightLevel: 0,
		maxPictureAverageLightLevel: 65_535,
	};
	const plan = av1Plan(fields);
	expect(validatePlan(plan).filter((issue) => issue.level === "error")).toEqual(
		[],
	);
	expect(encodingPlanSchema.parse(buildPlan(planToWizardState(plan)))).toEqual(
		plan,
	);
	for (const op of compilePlan(plan).filter(
		(op) => op.kind === "CREATE_CODEC_AV1",
	))
		expect(op.payload).toMatchObject({ ...fields, maxLevel: "L4_1" });
	const yaml = parse(planToEncodingTemplateYaml(plan));
	expect(yaml.configurations.video.av1.v360.properties).toMatchObject({
		...fields,
		maxLevel: "4.1",
	});
});

it("warns about an inactive AV1 maximum level without changing or rejecting it", () => {
	const plan = av1Plan({ maxLevel: "L4_1", autoLevelSetup: "DISABLED" });
	const issues = validatePlan(plan);
	expect(issues.filter((issue) => issue.level === "error")).toEqual([]);
	expect(issues).toContainEqual(
		expect.objectContaining({
			code: "PLAN_AV1_MAX_LEVEL_DISABLED",
			level: "warning",
			path: "renditions[1].maxLevel",
		}),
	);
	expect(
		compilePlan(plan).find((op) => op.kind === "CREATE_CODEC_AV1")?.payload,
	).toMatchObject({ maxLevel: "L4_1", autoLevelSetup: "DISABLED" });
});

it.each([
	"VP9",
	"AV1",
])("preserves %s width-only templates without inventing height", (codec) => {
	const row = renditionSchema.parse({
		key: "width-only",
		ingestKey: "video",
		codec,
		width: 1280,
		height: null,
		bitrate: null,
		mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
	});
	expect(row).toMatchObject({ width: 1280, height: null, bitrate: null });
});

it.each([
	{ width: 0 },
	{ width: -1 },
	{ width: 1.5 },
	{ width: null },
	{ maxLevel: "INVALID_ENUM" },
	{ maxLevel: null },
	{ maxLevel: "" },
	{ masterDisplay: "" },
	{ masterDisplay: null },
	{ maxContentLightLevel: -1 },
	{ maxContentLightLevel: 65_536 },
	{ maxContentLightLevel: 1.5 },
	{ maxContentLightLevel: null },
	{ maxPictureAverageLightLevel: -1 },
	{ maxPictureAverageLightLevel: 65_536 },
	{ maxPictureAverageLightLevel: 1.5 },
])("rejects invalid explicit AV1 values %j", (fields) => {
	expect(() => av1Plan(fields)).toThrow();
});

it("keeps unspecified codec settings absent and accepts the provider's automatic-level default", () => {
	const plan = av1Plan({ maxLevel: "L4_1", autoLevelSetup: undefined });
	expect(validatePlan(plan)).not.toContainEqual(
		expect.objectContaining({ code: "PLAN_AV1_MAX_LEVEL_DISABLED" }),
	);
	for (const op of compilePlan(loadPlan("av1-fmp4-dash-hls")).filter(
		(op) => op.kind === "CREATE_CODEC_AV1",
	)) {
		for (const key of [
			"width",
			"maxLevel",
			"masterDisplay",
			"maxContentLightLevel",
			"maxPictureAverageLightLevel",
		])
			expect(op.payload).not.toHaveProperty(key);
	}
});
