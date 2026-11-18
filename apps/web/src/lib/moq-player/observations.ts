import { z } from "zod";
import { MOQ_ARCHIVE_MAX_BYTES } from "../../../config/moq-policy";
import { moqHeartbeatHistorySchema } from "./heartbeat";

export const MOQ_OBSERVATION_LIMITS = {
	sessions: 5,
	samples: 600,
	events: 32,
	durationMs: 600_000,
	sampleIntervalMs: 1_000,
	archiveBytes: MOQ_ARCHIVE_MAX_BYTES,
	archiveDurationMs: 90_000,
	flushMs: 600_000,
} as const;
const elapsed = z.number().int().min(0).max(MOQ_OBSERVATION_LIMITS.durationMs);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
export const moqObservationSampleSchema = z.strictObject({
	elapsedMs: elapsed,
	latencyMs: z.number().min(0).max(600_000).nullable(),
	fps: z.number().min(0).max(1_000).nullable(),
	bufferSeconds: z.number().min(0).max(600).nullable(),
	bufferSource: z.enum(["player", "video"]).nullable().optional(),
	renderingSource: z.enum(["video", "canvas"]).nullable().optional(),
	droppedFrames: count,
	decodedFrames: count,
	presentedFrames: count,
	totalFrames: count,
	resolution: z
		.strictObject({
			width: z.number().int().min(1).max(16_384),
			height: z.number().int().min(1).max(16_384),
		})
		.nullable(),
});
export const moqObservationEventSchema = z.strictObject({
	elapsedMs: elapsed,
	type: z.enum(["started", "first-frame", "stopped", "failed", "ended"]),
});
const updateFields = {
	startedAt: z.iso.datetime(),
	endedAt: z.iso.datetime().nullable(),
	analyticsImpressionId: z.uuid().nullable().optional(),
	samples: z
		.array(moqObservationSampleSchema)
		.max(MOQ_OBSERVATION_LIMITS.samples),
	events: z.array(moqObservationEventSchema).max(MOQ_OBSERVATION_LIMITS.events),
};
const moqObservationPublicUpdateSchema = z
	.strictObject(updateFields)
	.superRefine((value, ctx) => {
		if (value.endedAt !== null) {
			const duration = Date.parse(value.endedAt) - Date.parse(value.startedAt);
			if (duration < 0 || duration > MOQ_OBSERVATION_LIMITS.durationMs)
				ctx.addIssue({
					code: "custom",
					message: "Observation duration is outside the budget",
				});
		}
		for (let i = 1; i < value.samples.length; i++) {
			const previous = value.samples[i - 1],
				current = value.samples[i];
			if (
				previous &&
				current &&
				current.elapsedMs - previous.elapsedMs <
					MOQ_OBSERVATION_LIMITS.sampleIntervalMs
			)
				ctx.addIssue({
					code: "custom",
					message: "Samples must be at least one second apart",
				});
		}
		for (let i = 1; i < value.events.length; i++) {
			const previous = value.events[i - 1],
				current = value.events[i];
			if (previous && current && current.elapsedMs < previous.elapsedMs)
				ctx.addIssue({ code: "custom", message: "Events must be ordered" });
		}
	});
export const moqObservationUpdateSchema = moqObservationPublicUpdateSchema
	.safeExtend({
		analyticsLicenseKeySha256: z
			.string()
			.regex(/^[0-9a-f]{64}$/)
			.optional(),
	})
	.superRefine((value, ctx) => {
		if (
			Boolean(value.analyticsImpressionId) !==
			Boolean(value.analyticsLicenseKeySha256)
		)
			ctx.addIssue({
				code: "custom",
				message:
					"Analytics impression requires its descriptor license fingerprint",
			});
	});
export const moqArchiveMetadataSchema = z.strictObject({
	contentType: z.literal("video/webm"),
	bytes: z.number().int().min(1).max(MOQ_OBSERVATION_LIMITS.archiveBytes),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	durationMs: z.number().min(1).max(MOQ_OBSERVATION_LIMITS.archiveDurationMs),
	recordedAt: z.iso.datetime(),
});
export const moqObservationSessionSchema =
	moqObservationPublicUpdateSchema.safeExtend({
		id: z.uuid(),
		createdAt: z.iso.datetime(),
		updatedAt: z.iso.datetime(),
		archive: moqArchiveMetadataSchema.nullable(),
		analyticsVideoId: z
			.string()
			.regex(/^bitovp-moq:[0-9a-f-]{36}:[0-9a-f-]{36}$/)
			.optional(),
	});
export const moqObservationHistorySchema = z.strictObject({
	runId: z.uuid(),
	configuration: z
		.strictObject({
			namespace: z.array(z.string().min(1).max(1_024)).min(1).max(32),
			draftVersion: z.union([z.literal(16), z.literal(18)]),
			catalogTrackName: z.literal("catalog"),
		})
		.optional(),
	sessions: z
		.array(moqObservationSessionSchema)
		.max(MOQ_OBSERVATION_LIMITS.sessions),
	heartbeat: moqHeartbeatHistorySchema,
});
export type MoqObservationSample = z.infer<typeof moqObservationSampleSchema>;
export type MoqObservationEvent = z.infer<typeof moqObservationEventSchema>;
export type MoqObservationUpdate = z.infer<typeof moqObservationUpdateSchema>;
export type MoqArchiveMetadata = z.infer<typeof moqArchiveMetadataSchema>;
export type MoqObservationSession = z.infer<typeof moqObservationSessionSchema>;
export type MoqObservationHistory = z.infer<typeof moqObservationHistorySchema>;
