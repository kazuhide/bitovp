import { z } from "zod";

export const moqAnalyticsReadbackSchema = z.strictObject({
	runId: z.uuid(),
	encodingId: z.uuid(),
	impressionId: z.uuid(),
	videoId: z.string().max(128),
	source: z.literal("bitmovin-analytics-custom-data"),
	measurement: z.literal("moq-source-barcode"),
	nativeLatency: z.literal(false),
	unit: z.literal("ms"),
	status: z.enum(["available", "pending"]),
	points: z
		.array(
			z.strictObject({
				observedAt: z.iso.datetime(),
				latencyMs: z.number().int().min(0).max(600_000),
			}),
		)
		.max(600),
	truncated: z.boolean(),
});
export type MoqAnalyticsReadback = z.infer<typeof moqAnalyticsReadbackSchema>;
