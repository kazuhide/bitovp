import { z } from "zod";
import type { EncodingPlan } from "./schema";
import type { PlanIssue } from "./validate";

/** Frame counts and aspect ratios use the SDK's units, not seconds. */
export const h26xPictureControlsSchema = z.strictObject({
	minGop: z.number().int().nonnegative().optional(),
	maxGop: z.number().int().nonnegative().optional(),
	openGop: z.boolean().optional(),
	sampleAspectRatioNumerator: z.number().int().positive().optional(),
	sampleAspectRatioDenominator: z.number().int().positive().optional(),
	displayAspectRatio: z
		.strictObject({
			numerator: z.number().int().positive().optional(),
			denominator: z.number().int().positive().optional(),
		})
		.refine(
			(ratio) =>
				ratio.numerator !== undefined && ratio.denominator !== undefined,
			"Display aspect ratio requires both numerator and denominator",
		)
		.optional(),
});

type Controls = z.infer<typeof h26xPictureControlsSchema>;
export type H26xPictureControls = Controls;
/** Preserve explicit false/zero while keeping legacy compiled payloads unchanged. */
export function h26xPictureControls(value: Controls): Partial<Controls> {
	return Object.fromEntries(
		(Object.keys(h26xPictureControlsSchema.shape) as (keyof Controls)[])
			.filter((key) => value[key] !== undefined)
			.map((key) => [key, value[key]]),
	);
}

export function checkH26xCodecControls(
	renditions: EncodingPlan["renditions"],
): PlanIssue[] {
	const issues: PlanIssue[] = [];
	for (const [index, r] of renditions.entries()) {
		if (r.codec !== "H264" && r.codec !== "H265") continue;
		const issue = (code: string, field: string, message: string) =>
			issues.push({
				code,
				path: `renditions[${index}].${field}`,
				level: "error",
				message,
			});
		if (
			r.minBitrate !== undefined &&
			r.maxBitrate !== undefined &&
			r.minBitrate > r.maxBitrate
		)
			issue(
				"PLAN_CODEC_BITRATE_RANGE",
				"minBitrate",
				"Minimum codec bitrate must not exceed maximum codec bitrate (both in bps)",
			);
		if (r.minGop !== undefined && r.maxGop !== undefined && r.minGop > r.maxGop)
			issue(
				"PLAN_CODEC_GOP_RANGE",
				"minGop",
				"Minimum GOP length must not exceed maximum GOP length (both in frames)",
			);
		const numerator = r.sampleAspectRatioNumerator !== undefined;
		const denominator = r.sampleAspectRatioDenominator !== undefined;
		if (numerator !== denominator)
			issue(
				"PLAN_CODEC_SAR_PAIR",
				"sampleAspectRatioNumerator",
				"Sample aspect ratio requires both numerator and denominator",
			);
		if (r.displayAspectRatio !== undefined && (numerator || denominator))
			issue(
				"PLAN_CODEC_ASPECT_CONFLICT",
				"displayAspectRatio",
				"Choose sample aspect ratio or display aspect ratio, not both",
			);
		if (r.codec === "H265") {
			if (r.qpMin !== undefined && r.qpMax !== undefined && r.qpMin > r.qpMax)
				issue(
					"PLAN_CODEC_QP_RANGE",
					"qpMax",
					"Maximum quantization factor must not be less than the minimum",
				);
			if (
				r.strictCbr === true &&
				(r.bitrate === null || r.crf !== undefined || r.qp !== undefined)
			)
				issue(
					"PLAN_CODEC_STRICT_CBR_MODE",
					"strictCbr",
					"Strict CBR requires target-bitrate mode without CRF or constant QP",
				);
		}
	}
	return issues;
}

/** Preserve explicit provider settings while explaining a documented no-effect value. */
export function checkAv1CodecControls(
	renditions: EncodingPlan["renditions"],
): PlanIssue[] {
	return renditions.flatMap((rendition, index) =>
		rendition.codec === "AV1" &&
		rendition.maxLevel !== undefined &&
		rendition.autoLevelSetup === "DISABLED"
			? [
					{
						code: "PLAN_AV1_MAX_LEVEL_DISABLED",
						path: `renditions[${index}].maxLevel`,
						level: "warning" as const,
						message:
							"AV1 maximum level has no effect while automatic level setup is disabled",
					},
				]
			: [],
	);
}
