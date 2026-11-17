import { z } from "zod";

const metric = z.number().finite().nonnegative().nullable();

/** Encoder measurements retain their units and missing values; no playback inference. */
export const moqHeartbeatPointSchema = z.strictObject({
	observedAt: z.iso.datetime(),
	sampledAt: z.iso.datetime().nullable(),
	source: z.enum(["poll", "run-last"]),
	ingestStatus: z
		.enum([
			"CONNECTED",
			"DISCONNECTED",
			"WAITING_FOR_FIRST_CONNECT",
			"ERROR",
			"UNKNOWN",
		])
		.nullable(),
	ingestHealthy: z.boolean().nullable(),
	videoIncomingBitrateBps: metric,
	audioIncomingBitrateBps: metric,
	videoFps: metric,
	/** Cumulative input counters, never missing-as-zero or per-poll deltas. */
	droppedPacketsVideo: metric,
	droppedPacketsAudio: metric,
	corruptPacketsVideo: metric,
	corruptPacketsAudio: metric,
	/** Provider segment processing time, distinct from end-to-end latency. */
	segmentProcessingMeanMs: metric,
	segmentProcessingMinMs: metric,
	segmentProcessingMaxMs: metric,
});

export const moqHeartbeatHistorySchema = z.strictObject({
	source: z.literal("live-encoder-heartbeat"),
	points: z.array(moqHeartbeatPointSchema).max(600),
	truncated: z.boolean(),
});

export type MoqHeartbeatPoint = z.infer<typeof moqHeartbeatPointSchema>;
export type MoqHeartbeatHistory = z.infer<typeof moqHeartbeatHistorySchema>;
