import { expect, it } from "vitest";
import { parse } from "yaml";
import { buildPlan } from "../wizard/build-plan";
import { planToWizardState } from "../wizard/plan-to-wizard";
import { compilePlan } from "./compiler";
import { curlForStep } from "./curl-from-step";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function withControls(codec: "H264" | "H265", controls: object) {
	const base = loadPlan("av1-fmp4-dash-hls");
	return encodingPlanSchema.parse({
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
	});
}

it.each([
	"H264",
	"H265",
] as const)("preserves %s picture controls and explicit false/zero", (codec) => {
	const controls = {
		width: 640,
		minGop: 0,
		maxGop: 48,
		openGop: false,
		sampleAspectRatioNumerator: 4,
		sampleAspectRatioDenominator: 3,
		...(codec === "H265"
			? { bframes: 0, refFrames: 0, qp: 0, qpMax: 69, strictCbr: false }
			: {}),
	};
	const plan = withControls(codec, controls);
	expect(encodingPlanSchema.parse(buildPlan(planToWizardState(plan)))).toEqual(
		plan,
	);
	expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
	for (const op of compilePlan(plan).filter(
		(op) => op.kind === `CREATE_CODEC_${codec}`,
	)) {
		expect(op.payload).toMatchObject(controls);
		const curl = curlForStep({
			...op,
			status: "DONE",
			request: { ...op.payload, refs: {} },
		});
		if (!curl.ok) throw new Error("Missing codec cURL");
		expect(curl.command).toContain('"openGop": false');
		expect(curl.command).toContain('"minGop": 0');
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
] as const)("retains %s display aspect ratio as a typed object", (codec) => {
	const displayAspectRatio = { numerator: 16, denominator: 9 };
	const plan = withControls(codec, { displayAspectRatio });
	expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
	expect(encodingPlanSchema.parse(buildPlan(planToWizardState(plan)))).toEqual(
		plan,
	);
	for (const op of compilePlan(plan).filter(
		(op) => op.kind === `CREATE_CODEC_${codec}`,
	))
		expect(op.payload.displayAspectRatio).toEqual(displayAspectRatio);
	const yaml = parse(planToEncodingTemplateYaml(plan));
	expect(
		yaml.configurations.video[codec.toLowerCase()].v360.properties
			.displayAspectRatio,
	).toEqual(displayAspectRatio);
});

it.each([
	[{ minBitrate: 900000, maxBitrate: 800000 }, "PLAN_CODEC_BITRATE_RANGE"],
	[{ minGop: 60, maxGop: 48 }, "PLAN_CODEC_GOP_RANGE"],
	[{ sampleAspectRatioNumerator: 4 }, "PLAN_CODEC_SAR_PAIR"],
	[
		{
			sampleAspectRatioNumerator: 4,
			sampleAspectRatioDenominator: 3,
			displayAspectRatio: { numerator: 16, denominator: 9 },
		},
		"PLAN_CODEC_ASPECT_CONFLICT",
	],
] as const)("rejects incompatible settings %j", (controls, code) => {
	for (const codec of ["H264", "H265"] as const)
		expect(validatePlan(withControls(codec, controls))).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code, level: "error" }),
			]),
		);
});

it("rejects reversed H265 quantizer bounds", () => {
	expect(validatePlan(withControls("H265", { qpMin: 40, qpMax: 20 }))).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ code: "PLAN_CODEC_QP_RANGE", level: "error" }),
		]),
	);
});

it.each([
	{ bitrate: null },
	{ crf: 0 },
	{ qp: 0 },
])("rejects strict CBR outside target-bitrate mode %j", (controls) => {
	expect(
		validatePlan(withControls("H265", { strictCbr: true, ...controls })),
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "PLAN_CODEC_STRICT_CBR_MODE",
				level: "error",
			}),
		]),
	);
});

it("accepts strict CBR in target-bitrate mode without rewriting its bitrate", () => {
	const plan = withControls("H265", { strictCbr: true, bitrate: 600000 });
	expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
	expect(
		compilePlan(plan).find((op) => op.kind === "CREATE_CODEC_H265")?.payload,
	).toMatchObject({ strictCbr: true, bitrate: 600000 });
});

it.each([
	{ minGop: -1 },
	{ maxGop: 1.5 },
	{ openGop: null },
	{ qp: 52 },
	{ qpMax: 70 },
	{ bframes: 17 },
	{ refFrames: -1 },
	{ strictCbr: null },
	{ width: 0 },
	{ sampleAspectRatioNumerator: 0 },
	{ displayAspectRatio: { numerator: 16 } },
	{ displayAspectRatio: { numerator: 16, denominator: 0 } },
])("rejects invalid H265 picture value %j", (controls) => {
	expect(() => withControls("H265", controls)).toThrow();
});

it("keeps new ordinary H265 controls outside the HEVCv2 gate", () => {
	const plan = withControls("H265", { qp: 0, openGop: false });
	plan.internal = { hevcV2: { bcfVersion: "v2.325.0-461-g85df7fd6c6" } };
	expect(validatePlan(plan)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ code: "PLAN_INTERNAL_HEVC_V2_UNSUPPORTED" }),
		]),
	);
});
