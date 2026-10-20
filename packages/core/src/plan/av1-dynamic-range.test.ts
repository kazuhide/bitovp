import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

const formats = [
	"SDR",
	"HDR10",
	"DOLBY_VISION_PROFILE_10_0",
	"DOLBY_VISION_PROFILE_10_1",
] as const;

function withFormat(dynamicRangeFormat?: string) {
	const plan = loadPlan("av1-fmp4-dash-hls");
	return {
		...plan,
		renditions: plan.renditions.map((rendition) =>
			rendition.codec === "AV1" && dynamicRangeFormat !== undefined
				? { ...rendition, dynamicRangeFormat }
				: rendition,
		),
	};
}

describe("AV1 dynamic range", () => {
	it.each(
		formats,
	)("preserves %s through schema, compiler and template", (format) => {
		const plan = encodingPlanSchema.parse(withFormat(format));
		const rendition = plan.renditions.find((r) => r.codec === "AV1");
		expect(rendition).toHaveProperty("dynamicRangeFormat", format);
		const ops = compilePlan(plan).filter(
			(op) => op.kind === "CREATE_CODEC_AV1",
		);
		expect(ops).toHaveLength(2);
		for (const op of ops) expect(op.payload.dynamicRangeFormat).toBe(format);
		const template = parse(planToEncodingTemplateYaml(plan));
		for (const key of ["v360", "v720"]) {
			expect(
				template.configurations.video.av1[key].properties.dynamicRangeFormat,
			).toBe(format);
		}
	});

	it("leaves an unspecified format absent at every output boundary", () => {
		const plan = encodingPlanSchema.parse(withFormat());
		for (const rendition of plan.renditions.filter((r) => r.codec === "AV1")) {
			expect(rendition).not.toHaveProperty("dynamicRangeFormat");
		}
		for (const op of compilePlan(plan).filter(
			(op) => op.kind === "CREATE_CODEC_AV1",
		)) {
			expect(op.payload).not.toHaveProperty("dynamicRangeFormat");
		}
		const template = parse(planToEncodingTemplateYaml(plan));
		expect(
			template.configurations.video.av1.v360.properties,
		).not.toHaveProperty("dynamicRangeFormat");
	});

	it.each([
		"HLG",
		"DOLBY_VISION_PROFILE_5",
		"DOLBY_VISION_PROFILE_8_1",
		"10.1",
		"",
	])("rejects the non-AV1 enum value %s", (format) =>
		expect(encodingPlanSchema.safeParse(withFormat(format)).success).toBe(
			false,
		));

	it.each(formats)("accepts a VISION input for AV1 %s", (format) => {
		const base = withFormat(format);
		const plan = encodingPlanSchema.parse({
			...base,
			dolbyStreams: [
				{
					key: "vision",
					kind: "VISION",
					inputKey: base.inputs[0]?.key,
					videoInputPath: "video.mov",
				},
			],
			renditions: base.renditions.map((r) =>
				r.codec === "AV1" ? { ...r, ingestKey: "vision" } : r,
			),
		});
		expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
		const streams = compilePlan(plan)
			.filter((op) => op.kind === "CREATE_STREAM")
			.slice(0, 2);
		expect(streams).toHaveLength(2);
		expect(
			streams.every((op) =>
				Object.values(op.refs).some((ref) => ref.includes("vision")),
			),
		).toBe(true);
	});

	it.each([
		"DOLBY_VISION_PROFILE_10_0",
		"DOLBY_VISION_PROFILE_10_1",
	])("limits the new %s output path to fMP4, including additional streams", (format) => {
		for (const additional of [false, true]) {
			const base = withFormat("SDR");
			const plan = encodingPlanSchema.parse({
				...base,
				renditions: base.renditions.map((r) =>
					r.key === (additional ? "v720" : "v360")
						? { ...r, dynamicRangeFormat: format }
						: r,
				),
				muxings: [
					additional
						? {
								key: "mp4",
								kind: "MP4",
								streamKey: base.renditions.find((r) => r.codec === "AAC")?.key,
								additionalStreamKeys: ["v720"],
								filename: "video.mp4",
								destination: base.muxings[0]?.destination,
							}
						: {
								key: "webm",
								kind: "WEBM",
								streamKey: "v360",
								segmentLength: 6,
								destination: base.muxings[0]?.destination,
							},
				],
				manifests: [],
			});
			expect(
				validatePlan(plan).filter(
					(i) => i.code === "PLAN_MUXING_CODEC_MISMATCH",
				),
			).toEqual([
				expect.objectContaining({
					level: "error",
					message: expect.stringContaining("fMP4"),
					path: additional
						? "muxings[0].additionalStreamKeys[0]"
						: "muxings[0].streamKey",
				}),
			]);
		}
	});

	it.each(["SDR", "HDR10"])("keeps existing AV1 %s WebM support", (format) => {
		const base = withFormat(format);
		const plan = encodingPlanSchema.parse({
			...base,
			muxings: [
				{
					key: "webm",
					kind: "WEBM",
					streamKey: "v360",
					segmentLength: 6,
					destination: base.muxings[0]?.destination,
				},
			],
			manifests: [],
		});
		expect(
			validatePlan(plan).filter((i) => i.code === "PLAN_MUXING_CODEC_MISMATCH"),
		).toEqual([]);
	});
});
