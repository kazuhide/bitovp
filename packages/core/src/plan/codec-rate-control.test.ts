import { expect, it } from "vitest";
import { parse } from "yaml";
import { buildPlan } from "../wizard/build-plan";
import { planToWizardState } from "../wizard/plan-to-wizard";
import { compilePlan } from "./compiler";
import { curlForStep } from "./curl-from-step";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";

function withControls(codec: "H264" | "H265", controls: object) {
	const base = loadPlan("av1-fmp4-dash-hls");
	return {
		...base,
		renditions: base.renditions.map((r) =>
			r.codec === "AV1"
				? {
						key: r.key,
						ingestKey: r.ingestKey,
						codec,
						height: r.height,
						bitrate: r.bitrate,
						...controls,
					}
				: r,
		),
	};
}

it.each([
	"H264",
	"H265",
] as const)("retains %s rate controls through saved-plan readback, compiler, YAML and cURL", (codec) => {
	const controls = {
		crf: 0,
		minBitrate: 0,
		maxBitrate: 900000,
		bufsize: 1800000,
	};
	const plan = encodingPlanSchema.parse(withControls(codec, controls));
	expect(encodingPlanSchema.parse(buildPlan(planToWizardState(plan)))).toEqual(
		plan,
	);
	for (const op of compilePlan(plan).filter(
		(op) => op.kind === `CREATE_CODEC_${codec}`,
	)) {
		expect(op.payload).toMatchObject(controls);
		const curl = curlForStep({
			...op,
			status: "DONE",
			request: { ...op.payload, refs: {} },
		});
		if (!curl.ok) throw new Error("Expected codec cURL");
		for (const [key, value] of Object.entries(controls))
			expect(curl.command).toContain(`"${key}": ${value}`);
	}
	const yaml = parse(planToEncodingTemplateYaml(plan));
	for (const key of ["v360", "v720"])
		expect(
			yaml.configurations.video[codec.toLowerCase()][key].properties,
		).toMatchObject(controls);
});

it.each([
	"H264",
	"H265",
] as const)("accepts %s CRF without a target bitrate", (codec) => {
	const plan = encodingPlanSchema.parse(
		withControls(codec, { bitrate: null, crf: 23.5 }),
	);
	const op = compilePlan(plan).find(
		(op) => op.kind === `CREATE_CODEC_${codec}`,
	);
	expect(op?.payload.crf).toBe(23.5);
	expect(encodingPlanSchema.parse(buildPlan(planToWizardState(plan)))).toEqual(
		plan,
	);
});

it.each([
	"H264",
	"H265",
] as const)("does not materialize optional %s rate controls", (codec) => {
	const plan = encodingPlanSchema.parse(withControls(codec, {}));
	for (const op of compilePlan(plan).filter(
		(op) => op.kind === `CREATE_CODEC_${codec}`,
	))
		for (const key of ["crf", "minBitrate", "maxBitrate", "bufsize"])
			expect(op.payload).not.toHaveProperty(key);
});

it.each([
	{ crf: -1 },
	{ crf: 52 },
	{ crf: null },
	{ minBitrate: -1 },
	{ maxBitrate: 1.5 },
	{ bufsize: -1 },
])("rejects invalid rate controls %j", (controls) => {
	for (const codec of ["H264", "H265"] as const)
		expect(
			encodingPlanSchema.safeParse(withControls(codec, controls)).success,
		).toBe(false);
});
