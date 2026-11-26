import {
	AV1_DYNAMIC_RANGE_FORMATS,
	h264RenditionSchema,
	type ManifestPlaybackLink,
} from "@bitovp/core";
import { z } from "zod";

export type OutputJob = {
	id: string;
	name: string;
	status: string;
	plan: unknown;
	playbackLinks?: ManifestPlaybackLink[];
};
export type OutputLink = ManifestPlaybackLink & {
	url: string;
	kind: "HLS" | "DASH";
};

export function parseOutputJobIds(raw: string | null): string[] {
	const ids = raw?.split(",").map((id) => id.trim().toLowerCase()) ?? [];
	return (ids.length === 2 || ids.length === 3) &&
		ids.every((id) => z.uuid().safeParse(id).success) &&
		new Set(ids).size === ids.length
		? ids
		: [];
}

export function outputSides(count: number) {
	return count === 3
		? (["left", "center", "right"] as const)
		: (["left", "right"] as const);
}

export function outputLinks(job?: OutputJob): OutputLink[] {
	if (job?.status !== "FINISHED") return [];
	return (job.playbackLinks ?? []).filter(
		(link): link is OutputLink =>
			!!link.url &&
			!link.reason &&
			(link.kind === "HLS" || link.kind === "DASH"),
	);
}

/** Plan settings describe the output request, never the display's active HDR mode. */
const formatPlan = z.object({ renditions: z.array(z.unknown()) });
const videoFormat = z.object({
	codec: z.enum(["H264", "H265", "AV1", "VP9"]),
	dynamicRangeFormat: z
		.enum([
			...AV1_DYNAMIC_RANGE_FORMATS,
			"DOLBY_VISION",
			"DOLBY_VISION_PROFILE_5",
			"DOLBY_VISION_PROFILE_8_1",
			"HLG",
		])
		.optional()
		.catch(undefined),
	encodingMode: h264RenditionSchema.shape.encodingMode.catch(undefined),
	colorConfig: z
		.object({
			colorTransfer: z.enum(["SMPTE_2084", "ARIB_STD_B67", "BT_709"]),
		})
		.optional()
		.catch(undefined),
});

export function outputFormats(value: unknown): string {
	// Detail reports can withhold source locators independently of output settings.
	const plan = formatPlan.safeParse(value);
	if (!plan.success) return "";
	const formats = plan.data.renditions.flatMap((value) => {
		const parsed = videoFormat.safeParse(value);
		if (!parsed.success) return [];
		const row = parsed.data;
		const codec =
			row.codec === "H264"
				? "H.264"
				: row.codec === "H265"
					? "H.265"
					: row.codec;
		const range =
			row.dynamicRangeFormat
				?.replace("DOLBY_VISION_PROFILE_10_1", "Dolby Vision 10.1")
				.replace("DOLBY_VISION_PROFILE_10_0", "Dolby Vision 10.0") ??
			(row.colorConfig?.colorTransfer === "SMPTE_2084"
				? "HDR PQ"
				: row.colorConfig?.colorTransfer === "ARIB_STD_B67"
					? "HDR HLG"
					: row.colorConfig?.colorTransfer === "BT_709"
						? "SDR"
						: undefined);
		return [[codec, range, row.encodingMode].filter(Boolean).join(" · ")];
	});
	return [...new Set(formats)].join(", ");
}
