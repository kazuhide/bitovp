import { z } from "zod";
import type { EncodingPlan } from "./schema";
import type { PlanIssue } from "./validate";

export const INTERNAL_HEVC_V2_BCF_VERSION = "v2.325.0-461-g85df7fd6c6";
export const internalHevcV2Schema = z.strictObject({
	bcfVersion: z
		.string()
		.max(128)
		.regex(/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9]+)*$/),
});
export type InternalHevcV2 = z.infer<typeof internalHevcV2Schema>;

/** Server configuration is an exact vault identity, never an editable label. */
export function isInternalHevcV2Account(
	accountId: string | undefined,
	configuredId: string | undefined,
): boolean {
	return z.uuid().safeParse(configuredId).success && accountId === configuredId;
}

// Codec-independent stream fields plus the supported H265V2 configuration subset.
const SUPPORTED_FIELDS = new Set([
	"key",
	"ingestKey",
	"conditions",
	"streamName",
	"filters",
	"encodingKey",
	"hlsMedia",
	"hlsVariantLabel",
	"hlsVariantUri",
	"dashSetKey",
	"codec",
	"name",
	"height",
	"bitrate",
	"mode",
	"rate",
	"pixelFormat",
	"colorConfig",
	"levelHighTier",
	"dynamicRangeFormat",
	"presetConfiguration",
	"encodingMode",
	"perTitleSettings",
	"motionCompensatedTemporalFiltering",
	"rateControlModeConfig",
]);

export function checkInternalHevcV2Plan(plan: EncodingPlan): PlanIssue[] {
	const issues: PlanIssue[] = [];
	const issue = (path: string, message: string) =>
		issues.push({
			level: "error",
			code: "PLAN_INTERNAL_HEVC_V2_UNSUPPORTED",
			path,
			message,
		});
	if (!plan.internal?.hevcV2) {
		for (const [index, rendition] of plan.renditions.entries()) {
			if (rendition.codec !== "H265") continue;
			for (const key of [
				"motionCompensatedTemporalFiltering",
				"rateControlModeConfig",
			] as const) {
				if (rendition[key] !== undefined)
					issue(
						`renditions.${index}.${key}`,
						"Native HEVCv2 quality controls require the enabled internal HEVC v2 profile",
					);
			}
		}
		if (plan.perTitle?.h265V2Configuration)
			issue(
				"perTitle.h265V2Configuration",
				"HEVCv2 Per-Title requires the enabled internal HEVC v2 profile",
			);
		if (
			plan.generation.encodingMode === "SMART_PASS" ||
			plan.renditions.some(
				(r) => "encodingMode" in r && r.encodingMode === "SMART_PASS",
			)
		)
			issue(
				"generation.encodingMode",
				"SMART_PASS is reserved for the enabled internal HEVC v2 profile",
			);
		return issues;
	}
	if (
		plan.perTitle &&
		Object.keys(plan.perTitle).some((key) => key !== "h265V2Configuration")
	)
		issue(
			"perTitle",
			"Internal HEVC v2 requires native h265V2Configuration; remove other codec configurations explicitly",
		);
	const video = plan.renditions.filter((r) =>
		["H264", "H265", "VP9", "AV1"].includes(r.codec),
	);
	if (!video.length)
		issue("renditions", "Internal HEVC v2 requires an H265 video rendition");
	for (const r of video) {
		const path = `renditions.${plan.renditions.indexOf(r)}`;
		if (r.codec !== "H265") {
			issue(path, "Internal HEVC v2 requires all video renditions to use H265");
			continue;
		}
		if (r.mode === "STANDARD" && (!r.height || !r.bitrate))
			issue(
				path,
				"Internal HEVC v2 requires fixed height and bitrate with STANDARD stream mode",
			);
		if (r.mode !== "STANDARD" && !r.mode.startsWith("PER_TITLE_TEMPLATE"))
			issue(
				`${path}.mode`,
				"Internal HEVC v2 accepts STANDARD or Per-Title template stream modes",
			);
		for (const [key, value] of Object.entries(r)) {
			if (value === undefined || (key === "level" && value === null)) continue;
			if (!SUPPORTED_FIELDS.has(key))
				issue(
					`${path}.${key}`,
					`Internal HEVC v2 does not support the H265 setting ${key}; remove it explicitly`,
				);
		}
		if (r.encodingMode && r.encodingMode !== "SMART_PASS")
			issue(
				`${path}.encodingMode`,
				"HEVCv2 requires SMART_PASS on the codec configuration",
			);
		if (r.presetConfiguration && r.presetConfiguration !== "VOD_HIGH_QUALITY")
			issue(
				`${path}.presetConfiguration`,
				"Internal HEVC v2 uses VOD_HIGH_QUALITY",
			);
		if (r.dynamicRangeFormat && r.dynamicRangeFormat !== "SDR")
			issue(
				`${path}.dynamicRangeFormat`,
				"Internal HEVC v2 currently supports SDR testing only",
			);
	}
	return issues;
}
