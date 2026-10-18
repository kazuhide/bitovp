import { z } from "zod";

// An allowlist, not recursive key-name redaction: even signed provider strings
// can contain credentials. Unknown fields and malformed known fields disappear.
const number = z.number().finite().nonnegative().optional().catch(undefined);
const time = z.iso
	.datetime({ offset: true })
	.transform((v) => new Date(v).toISOString())
	.optional()
	.catch(undefined);
const stats = z
	.object({ mean: number, min: number, max: number })
	.optional()
	.catch(undefined);
const stream = z.object({
	mediaType: z
		.enum(["VIDEO", "AUDIO", "video", "audio"])
		.optional()
		.catch(undefined),
	rate: number,
	incomingBitrate: number,
	bitrate: number,
	width: number,
	height: number,
	sampleRate: number,
	keyFrameIntervalAvg: number,
	keyFrameIntervalMax: number,
	keyFrameIntervalAvgLastMinute: number,
	keyFrameIntervalMaxLastMinute: number,
});
const updates = z.object({ manifestUpdateWallClockTime: time });
const manifest = z.object({
	manifestUpdates: z.array(updates).max(64).optional().catch(undefined),
});
export const heartbeatReceiptValue = z.object({
	timestamp: time,
	ingest: z
		.object({
			status: z
				.enum([
					"CONNECTED",
					"DISCONNECTED",
					"WAITING_FOR_FIRST_CONNECT",
					"ERROR",
					"UNKNOWN",
				])
				.optional()
				.catch(undefined),
			healthy: z.boolean().optional().catch(undefined),
			streams: z.array(stream).max(32).optional().catch(undefined),
			droppedPacketsVideo: number,
			droppedPacketsAudio: number,
			corruptPacketsVideo: number,
			corruptPacketsAudio: number,
		})
		.optional()
		.catch(undefined),
	output: z
		.object({
			manifests: z
				.object({ hls: z.array(manifest).max(64).optional().catch(undefined) })
				.optional()
				.catch(undefined),
			segments: z
				.object({ totalProcessingStatsMs: stats })
				.optional()
				.catch(undefined),
		})
		.optional()
		.catch(undefined),
});
export type HeartbeatReceiptValue = z.infer<typeof heartbeatReceiptValue>;
const envelope = z.object({
	eventType: z.literal("LIVE_ENCODING_HEARTBEAT"),
	webhookId: z.uuid(),
	encoding: z.object({ id: z.uuid() }),
	value: heartbeatReceiptValue,
});
export function safeHeartbeatReceipt(raw: unknown, encodingId: string) {
	const parsed = envelope.safeParse(raw);
	return parsed.success && parsed.data.encoding.id === encodingId
		? parsed.data.value
		: null;
}

export type HeartbeatReceiptPage = {
	run: { id: string; status: string };
	rows: {
		id: string;
		receivedAt: string;
		sampledAt: string | null;
		value: HeartbeatReceiptValue;
	}[];
	nextCursor?: string;
};
