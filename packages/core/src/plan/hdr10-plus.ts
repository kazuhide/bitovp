import { inputStreamAncestry } from "./input-stream-graph";
import type { EncodingPlan } from "./schema";
import type { PlanIssue } from "./validate";

/** REST 1.289.0 / Encoder 2.294.0 introduce HDR10+ for HEVC VOD.
 * The public contract adds no profile, container or pass-mode restriction. */
export function checkHdr10PlusPlan(plan: EncodingPlan): PlanIssue[] {
	if (!plan.hdr10PlusStreams.length) return [];
	const issues: PlanIssue[] = [];
	const keys = new Set(plan.hdr10PlusStreams.map((stream) => stream.key));
	for (const [index, stream] of plan.hdr10PlusStreams.entries()) {
		const owner =
			plan.encodings?.find((encoding) => encoding.key === stream.encodingKey) ??
			plan.encodings?.[0];
		const selected = owner?.encoderVersion ?? plan.bitmovin.encoderVersion;
		const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.-]+)?$/.exec(selected);
		const parts = match?.slice(1, 4).map(Number);
		const version = parts?.every(Number.isSafeInteger) ? parts : undefined;
		if (
			version &&
			((version[0] ?? 0) - 2 || (version[1] ?? 0) - 294 || (version[2] ?? 0)) >=
				0
		)
			continue;
		issues.push({
			code: version
				? "PLAN_HDR10_PLUS_ENCODER_VERSION"
				: "PLAN_HDR10_PLUS_ENCODER_VERSION_UNRESOLVED",
			level: version ? "error" : "warning",
			path: `hdr10PlusStreams[${index}].encodingKey`,
			message: version
				? `HDR10+ requires Encoder 2.294.0 or newer; selected ${selected}.`
				: `HDR10+ requires Encoder 2.294.0 or newer. The selected version ${selected} is unresolved; pin a supported numeric version to confirm compatibility.`,
		});
	}
	for (const [index, rendition] of plan.renditions.entries()) {
		if (
			!inputStreamAncestry(plan, rendition.ingestKey)?.some((key) =>
				keys.has(key),
			)
		)
			continue;
		if (rendition.codec !== "H265") {
			issues.push({
				code: "PLAN_HDR10_PLUS_CODEC",
				level: "error",
				path: `renditions[${index}].ingestKey`,
				message: "HDR10+ input streams require an H265 video rendition.",
			});
			continue;
		}
		if (rendition.dolbyVisionMetadata) {
			issues.push({
				code: "PLAN_HDR10_PLUS_DOLBY_VISION_CONFLICT",
				level: "error",
				path: `renditions[${index}].dolbyVisionMetadata`,
				message:
					"HDR10+ and Dolby Vision metadata cannot be attached to the same rendition in this app.",
			});
		}
		if (
			rendition.dynamicRangeFormat &&
			rendition.dynamicRangeFormat !== "HDR10"
		) {
			issues.push({
				code: "PLAN_HDR10_PLUS_DYNAMIC_RANGE_CONFLICT",
				level: "error",
				path: `renditions[${index}].dynamicRangeFormat`,
				message:
					"An HDR10+ rendition must preserve HDR10 rather than request a different output dynamic range format.",
			});
		}
	}
	return issues;
}
