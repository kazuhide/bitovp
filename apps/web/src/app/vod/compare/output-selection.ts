import { encodingPlanSchema, type ManifestPlaybackLink } from "@bitovp/core";
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
export function outputFormats(value: unknown): string {
	const plan = encodingPlanSchema.safeParse(value);
	if (!plan.success) return "";
	const formats = plan.data.renditions.flatMap((rendition) => {
		if (!["H264", "H265", "AV1", "VP9"].includes(rendition.codec)) return [];
		const row = rendition as typeof rendition & {
			dynamicRangeFormat?: string;
			encodingMode?: string;
			colorConfig?: { colorTransfer?: string };
		};
		const codec =
			rendition.codec === "H264"
				? "H.264"
				: rendition.codec === "H265"
					? "H.265"
					: rendition.codec;
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
