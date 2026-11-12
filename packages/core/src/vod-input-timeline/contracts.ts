import { z } from "zod";

export const MAX_VOD_TIMELINE_SOURCES = 16;
export const MAX_VOD_TIMELINE_CLIPS = 64;
/** Provider PaddingSequence is limited to 10 seconds per gap. */
export const MAX_VOD_TIMELINE_GAP_MS = 10_000;
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

// Keep the v1 wire shape and key order unchanged: queued tasks hash parsed JSON.
export const vodInputTimelineV1DocumentSchema = z
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
export type VodInputTimelineV1Document = z.infer<
	typeof vodInputTimelineV1DocumentSchema
>;

export const vodInputTimelinePlacedClipSchema = z
	.strictObject({
		id: z.uuid(),
		sourceKey: key,
		startMs: timeMs,
		inMs: timeMs,
		outMs: timeMs,
	})
	.refine((clip) => clip.outMs > clip.inMs, "Clip out must follow in");
export type VodInputTimelinePlacedClip = z.infer<
	typeof vodInputTimelinePlacedClipSchema
>;
export type VodInputTimelineTrack = "video" | "audio";

export const vodInputTimelineV2DocumentSchema = z
	.strictObject({
		schemaVersion: z.literal(2),
		id: z.uuid(),
		audioEnabled: z.boolean(),
		durationMs: timeMs,
		videoClips: z
			.array(vodInputTimelinePlacedClipSchema)
			.max(MAX_VOD_TIMELINE_CLIPS),
		audioClips: z
			.array(vodInputTimelinePlacedClipSchema)
			.max(MAX_VOD_TIMELINE_CLIPS),
	})
	.superRefine((document, ctx) => {
		if (
			new Set(
				[...document.videoClips, ...document.audioClips].map(
					(clip) => clip.sourceKey,
				),
			).size > MAX_VOD_TIMELINE_SOURCES
		) {
			ctx.addIssue({
				code: "custom",
				path: ["videoClips"],
				message: "Sequence references more than sixteen sources",
			});
		}
		for (const track of ["videoClips", "audioClips"] as const) {
			let endMs = 0;
			const ids = new Set<string>();
			for (const [index, clip] of document[track].entries()) {
				if (ids.has(clip.id)) {
					ctx.addIssue({
						code: "custom",
						path: [track, index, "id"],
						message: "Clip IDs must be unique within a track",
					});
				}
				ids.add(clip.id);
				if (clip.startMs < endMs) {
					ctx.addIssue({
						code: "custom",
						path: [track, index, "startMs"],
						message: "Track clips must be sorted without overlap",
					});
				}
				endMs = clip.startMs + clip.outMs - clip.inMs;
				if (endMs > document.durationMs) {
					ctx.addIssue({
						code: "custom",
						path: [track, index],
						message: "Clip exceeds program duration",
					});
				}
			}
		}
	});
export type VodInputTimelineV2Document = z.infer<
	typeof vodInputTimelineV2DocumentSchema
>;

/** Lossless wire union. Normalize explicitly only AFTER request-hash checks. */
export const vodInputTimelineDocumentSchema = z.discriminatedUnion(
	"schemaVersion",
	[vodInputTimelineV1DocumentSchema, vodInputTimelineV2DocumentSchema],
);
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

export const vodInputTimelineSourceFactsSchema = z
	.strictObject({
		key,
		durationMs: timeMs.positive(),
		video: z
			.strictObject({
				streamIndex: z.number().int().min(0).max(1024),
				width: z.number().int().positive().max(32768),
				height: z.number().int().positive().max(32768),
				displayAspectRatio: z
					.strictObject({
						num: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
						den: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
					})
					.optional(),
				frameRate: z
					.strictObject({
						num: z.number().int().positive().max(1_000_000),
						den: z.number().int().positive().max(1_000_000),
					})
					.optional(),
				durationMs: timeMs.positive().optional(),
			})
			.nullable(),
		audio: z
			.strictObject({
				streamIndex: z.number().int().min(0).max(1024),
				sampleRate: z.number().int().positive().max(384_000),
				channels: z.number().int().positive().max(64),
				durationMs: timeMs.positive().optional(),
			})
			.nullable(),
		identity: z.strictObject({
			size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
			etag: z.string().min(1).max(1024).optional(),
			versionId: z.string().min(1).max(1024).optional(),
			generation: z.string().min(1).max(1024).optional(),
		}),
	})
	.refine(
		(source) => source.video !== null || source.audio !== null,
		"A source must contain video or audio",
	);
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
			(doc) =>
				doc.schemaVersion === 1
					? doc.clips.length > 0
					: doc.videoClips.length > 0 ||
						(doc.audioEnabled && doc.audioClips.length > 0),
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
