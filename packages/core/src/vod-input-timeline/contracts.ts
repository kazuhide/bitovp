import { z } from "zod";

export const MAX_VOD_TIMELINE_SOURCES = 16;
export const MAX_VOD_TIMELINE_CLIPS = 64;
export const MAX_VOD_TIMELINE_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_VOD_INPUT_PREVIEW_DURATION_MS = 180_000;
export const DEFAULT_VOD_INPUT_PREVIEW_DURATION_MS = 30_000;
const timeMs = z.number().int().min(0).max(MAX_VOD_TIMELINE_DURATION_MS);
const key = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/);

export const vodInputTimelineClipSchema = z
	.strictObject({
		id: z.uuid(),
		sourceKey: key,
		inMs: timeMs,
		outMs: timeMs,
	})
	.refine((clip) => clip.outMs > clip.inMs, "Clip out must follow in");

export const vodInputTimelineDocumentSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		id: z.uuid(),
		audioEnabled: z.boolean(),
		clips: z.array(vodInputTimelineClipSchema).max(MAX_VOD_TIMELINE_CLIPS),
	})
	.superRefine((doc, ctx) => {
		if (new Set(doc.clips.map((clip) => clip.id)).size !== doc.clips.length) {
			ctx.addIssue({
				code: "custom",
				path: ["clips"],
				message: "Clip IDs must be unique",
			});
		}
		if (
			doc.clips.reduce((sum, clip) => sum + clip.outMs - clip.inMs, 0) >
			MAX_VOD_TIMELINE_DURATION_MS
		) {
			ctx.addIssue({
				code: "custom",
				path: ["clips"],
				message: "Sequence exceeds 24 hours",
			});
		}
	});
export type VodInputTimelineClip = z.infer<typeof vodInputTimelineClipSchema>;
export type VodInputTimelineDocument = z.infer<
	typeof vodInputTimelineDocumentSchema
>;

export const vodInputTimelineSourceSchema = z.strictObject({
	key,
	credentialId: z.uuid(),
	bucket: z.string().min(1).max(255),
	objectKey: z
		.string()
		.min(1)
		.max(1024)
		.refine((value) => !value.endsWith("/"), "Choose a file"),
});
export type VodInputTimelineSource = z.infer<
	typeof vodInputTimelineSourceSchema
>;

export const vodInputTimelineSourceFactsSchema = z.strictObject({
	key,
	durationMs: timeMs.positive(),
	video: z.strictObject({
		streamIndex: z.number().int().min(0).max(1024),
		width: z.number().int().positive().max(32768),
		height: z.number().int().positive().max(32768),
		frameRate: z
			.strictObject({
				num: z.number().int().positive().max(1_000_000),
				den: z.number().int().positive().max(1_000_000),
			})
			.optional(),
	}),
	audio: z
		.strictObject({
			streamIndex: z.number().int().min(0).max(1024),
			sampleRate: z.number().int().positive().max(384_000),
			channels: z.number().int().positive().max(64),
		})
		.nullable(),
	identity: z.strictObject({
		size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		etag: z.string().min(1).max(1024).optional(),
		versionId: z.string().min(1).max(1024).optional(),
		generation: z.string().min(1).max(1024).optional(),
	}),
});
export type VodInputTimelineSourceFacts = z.infer<
	typeof vodInputTimelineSourceFactsSchema
>;

const sourcesSchema = z
	.array(vodInputTimelineSourceSchema)
	.min(1)
	.max(MAX_VOD_TIMELINE_SOURCES)
	.refine(
		(sources) =>
			new Set(sources.map((source) => source.key)).size === sources.length,
		"Source keys must be unique",
	);
export const vodInputPreviewRangeSchema = z.strictObject({
	startMs: timeMs,
	durationMs: z
		.number()
		.int()
		.positive()
		.max(MAX_VOD_INPUT_PREVIEW_DURATION_MS),
});
export const vodInputPreviewRequestSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("PROBE"), sources: sourcesSchema }),
	z.strictObject({
		kind: z.literal("PREVIEW"),
		probeId: z.uuid(),
		document: vodInputTimelineDocumentSchema.refine(
			(doc) => doc.clips.length > 0,
			"Add a clip",
		),
		range: vodInputPreviewRangeSchema,
	}),
]);
export type VodInputPreviewRequest = z.infer<
	typeof vodInputPreviewRequestSchema
>;
export const vodInputPreviewResultSchema = z.strictObject({
	sources: z
		.array(vodInputTimelineSourceFactsSchema)
		.min(1)
		.max(MAX_VOD_TIMELINE_SOURCES)
		.optional(),
	preview: z
		.strictObject({
			startMs: timeMs,
			durationMs: z
				.number()
				.int()
				.positive()
				.max(MAX_VOD_INPUT_PREVIEW_DURATION_MS),
			size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
			sha256: z.string().regex(/^[a-f0-9]{64}$/),
		})
		.optional(),
});
export type VodInputPreviewResult = z.infer<typeof vodInputPreviewResultSchema>;
export const vodInputPreviewTaskSchema = z.strictObject({
	id: z.uuid(),
	kind: z.enum(["PROBE", "PREVIEW"]),
	status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"]),
	stage: z.string().min(1).max(64),
	requestHash: z.string().regex(/^[a-f0-9]{64}$/),
	createdAt: z.iso.datetime(),
	expiresAt: z.iso.datetime(),
	result: vodInputPreviewResultSchema.optional(),
	error: z
		.strictObject({
			code: z.string().min(1).max(128),
			message: z.string().min(1).max(500),
		})
		.optional(),
});
export type VodInputPreviewTask = z.infer<typeof vodInputPreviewTaskSchema>;
