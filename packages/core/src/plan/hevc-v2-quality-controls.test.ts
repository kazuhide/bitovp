import { describe, expect, it } from "vitest";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function plan(controls: Record<string, unknown>, native = true) {
	const base = loadPlan("fixed-bitrate-hls-on-aws");
	return {
		...base,
		...(native
			? { internal: { hevcV2: { bcfVersion: "v2.325.0-461-g85df7fd6c6" } } }
			: {}),
		renditions: base.renditions.map((r) =>
			r.codec === "H264"
				? {
						key: r.key,
						ingestKey: r.ingestKey,
						codec: "H265",
						height: 720,
						bitrate: 1_000_000,
						...controls,
					}
				: r,
		),
	};
}

const perceptual = {
	type: "PERCEPTUAL_QUALITY_MODE",
	perceptualEncodingMode: "CU_DELTA_QP",
	perceptualStrength: 0,
	perceptualPenaltyStrength: 1,
	perceptualPenaltyKnee: 0.5,
	perceptualTemporalStrength: 0,
	pixelPerDegree: 30,
};

describe("native HEVCv2 quality controls", () => {
	it.each([
		"AUTO",
		"OFF",
		"ON",
	])("preserves explicit MCTF %s through compilation", (mode) => {
		const parsed = encodingPlanSchema.parse(
			plan({ motionCompensatedTemporalFiltering: mode }),
		);
		expect(
			validatePlan(parsed).filter((i) =>
				i.code.startsWith("PLAN_INTERNAL_HEVC_V2"),
			),
		).toEqual([]);
		const codec = compilePlan(parsed).find(
			(o) => o.kind === "CREATE_CODEC_H265",
		);
		expect(codec?.payload.motionCompensatedTemporalFiltering).toBe(mode);
		expect(codec?.payload).not.toHaveProperty("rateControlModeConfig");
	});
	it.each([
		"OFF",
		"CU_DELTA_QP",
	])("preserves perceptual %s, zero strengths and exact nested fields", (mode) => {
		const config = { ...perceptual, perceptualEncodingMode: mode };
		const parsed = encodingPlanSchema.parse(
			plan({ rateControlModeConfig: config }),
		);
		expect(
			validatePlan(parsed).filter((i) =>
				i.code.startsWith("PLAN_INTERNAL_HEVC_V2"),
			),
		).toEqual([]);
		expect(
			compilePlan(parsed).find((o) => o.kind === "CREATE_CODEC_H265")?.payload
				.rateControlModeConfig,
		).toEqual(config);
	});
	it("leaves omitted controls absent", () => {
		const parsed = encodingPlanSchema.parse(plan({}));
		const codec = compilePlan(parsed).find(
			(o) => o.kind === "CREATE_CODEC_H265",
		);
		expect(codec?.payload).not.toHaveProperty(
			"motionCompensatedTemporalFiltering",
		);
		expect(codec?.payload).not.toHaveProperty("rateControlModeConfig");
	});
	it.each([
		{ motionCompensatedTemporalFiltering: "OFF" },
		{
			rateControlModeConfig: {
				type: "PERCEPTUAL_QUALITY_MODE",
				perceptualEncodingMode: "OFF",
			},
		},
	])("rejects native controls on ordinary H265 instead of stripping them", (controls) => {
		const parsed = encodingPlanSchema.parse(plan(controls, false));
		expect(validatePlan(parsed)).toContainEqual(
			expect.objectContaining({
				code: "PLAN_INTERNAL_HEVC_V2_UNSUPPORTED",
				level: "error",
			}),
		);
	});
	it.each([
		{ motionCompensatedTemporalFiltering: "INVALID" },
		{ rateControlModeConfig: { ...perceptual, type: "OTHER" } },
		{
			rateControlModeConfig: { ...perceptual, perceptualEncodingMode: "AUTO" },
		},
		{ rateControlModeConfig: { ...perceptual, perceptualStrength: -0.01 } },
		{
			rateControlModeConfig: { ...perceptual, perceptualPenaltyStrength: 1.01 },
		},
		{
			rateControlModeConfig: {
				...perceptual,
				perceptualPenaltyKnee: Number.NaN,
			},
		},
		{
			rateControlModeConfig: {
				...perceptual,
				perceptualTemporalStrength: Number.POSITIVE_INFINITY,
			},
		},
		{ rateControlModeConfig: { ...perceptual, pixelPerDegree: 0 } },
		{ rateControlModeConfig: { ...perceptual, qpMax: 25 } },
	])("rejects invalid or unsupported native input %j", (controls) => {
		expect(encodingPlanSchema.safeParse(plan(controls)).success).toBe(false);
	});
});
