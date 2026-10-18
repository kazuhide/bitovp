import { z } from "zod";
import type { LiveChannelPlan } from "./schema";

/** References only: keys remain in the immutable channel plan, never the queue. */
export const liveRtmpIngestParamsSchema = z.strictObject({
	pointIndexes: z
		.array(z.number().int().min(0).max(15))
		.min(1)
		.max(16)
		.refine(
			(indexes) => new Set(indexes).size === indexes.length,
			"Duplicate ingest point",
		),
});
export type LiveRtmpIngestParams = z.infer<typeof liveRtmpIngestParamsSchema>;

export function selectRtmpIngestPoints(
	plan: LiveChannelPlan,
	params: LiveRtmpIngestParams,
) {
	const input = plan.liveInput;
	if (
		input.kind !== "REDUNDANT_RTMP" ||
		!input.ingestPoints ||
		input.ingestPoints.length > 16
	)
		throw new Error(
			"RTMP updates require declared dynamic redundant RTMP ingest points",
		);
	const points = params.pointIndexes.map((index) => {
		const point = input.ingestPoints?.[index];
		if (!point) throw new Error("Undeclared RTMP ingest point");
		return {
			applicationName: point.applicationName,
			streamKey: point.streamKey,
		};
	});
	if (
		new Set(points.map((point) => point.applicationName)).size !== points.length
	)
		throw new Error("RTMP application names must be unique");
	return points;
}
