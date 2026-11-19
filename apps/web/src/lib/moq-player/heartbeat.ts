import { z } from "zod";

// Previously loaded Web clients validate the history shape strictly.
export const MOQ_OUTPUT_HISTORY_HEADER = "X-BitOVP-MoQ-Output";

const metric = z.number().finite().nonnegative().nullable();
const segmentProcessingFields = {
	segmentProcessingMeanMs: metric,
	segmentProcessingMinMs: metric,
	segmentProcessingMaxMs: metric,
};

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
	...segmentProcessingFields,
});

const moqPushOutputPointSchema = z.strictObject({
	sampledAt: z.iso.datetime(),
	...segmentProcessingFields,
});

export const moqHeartbeatHistorySchema = z.strictObject({
	source: z.literal("live-encoder-heartbeat"),
	points: z.array(moqHeartbeatPointSchema).max(600),
	// Separate from Poll so a burst of Push receipts cannot evict input history.
	pushOutput: z.array(moqPushOutputPointSchema).max(600).optional(),
	pushOutputReadFailed: z.literal(true).optional(),
	truncated: z.boolean(),
});

export type MoqHeartbeatPoint = z.infer<typeof moqHeartbeatPointSchema>;
export type MoqPushOutput = z.infer<typeof moqPushOutputPointSchema>;
export type MoqHeartbeatHistory = z.infer<typeof moqHeartbeatHistorySchema>;
