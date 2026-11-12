import { z } from "zod";

export const MAX_VOD_TIMELINE_SOURCES = 16;
export const MAX_VOD_TIMELINE_CLIPS = 64;
/** Each native PaddingSequence is limited to 10 seconds. */
export const MAX_VOD_TIMELINE_GAP_MS = 10_000;
/** An interior gap can use the preceding after-pad and following before-pad. */
export const MAX_VOD_TIMELINE_INTERIOR_GAP_MS = MAX_VOD_TIMELINE_GAP_MS * 2;
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
const probeRequestSchema = z.strictObject({
	kind: z.literal("PROBE"),
	sources: sourcesSchema,
});
const previewRequestSchema = z.strictObject({
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
	sourcePreviewKey: key.optional(),
});
export const MAX_VOD_INPUT_IMAGE_BYTES = 32 * 1024 ** 2;
export const MAX_VOD_INPUT_IMAGE_PIXELS = 4096 * 2160;
export const VOD_INPUT_IMAGE_OUTPUT_PROVIDERS = [
	"AWS_S3",
	"AKAMAI_OBJECT_STORAGE",
	"OCI_OBJECT_STORAGE",
	"GENERIC_S3",
	"GCS_HMAC",
] as const;
const hasImagePathControl = (value: string, includeSpace = false) =>
	[...value].some((character) => {
		const code = character.charCodeAt(0);
		return code < (includeSpace ? 33 : 32) || code === 127;
	});
export const vodInputImagePrepareInputSchema = z.strictObject({
	kind: z.literal("IMAGE_PREPARE"),
	source: vodInputTimelineSourceSchema,
	durationMs: z.number().int().min(1000).max(60_000),
	output: z.strictObject({
		credentialId: z.uuid(),
		bucket: vodInputTimelineSourceSchema.shape.bucket.refine(
			(value) => !/[\\/?#]/.test(value) && !hasImagePathControl(value, true),
			"Choose an output bucket",
		),
		prefix: z
			.string()
			.max(512)
			.refine(
				(value) =>
					new TextEncoder().encode(value).length <= 768 &&
					!/[\\?#]/.test(value) &&
					!hasImagePathControl(value) &&
					!value.includes("://") &&
					!value.split("/").some((part) => part === "." || part === ".."),
				"Choose an output folder",
			),
	}),
});
export type VodInputImagePrepareInput = z.infer<
	typeof vodInputImagePrepareInputSchema
>;
export const vodInputImagePrepareRequestSchema =
	vodInputImagePrepareInputSchema.extend({
		sourceIdentity: vodInputTimelineSourceFactsSchema.shape.identity
			.refine(
				(identity) => identity.size <= MAX_VOD_INPUT_IMAGE_BYTES,
				"Image exceeds 32 MiB",
			)
			.refine(
				(identity) =>
					Boolean(
						identity.etag?.trim() ||
							(identity.versionId?.trim() && identity.versionId !== "null") ||
							identity.generation?.trim(),
					),
				"Seal the current source version",
			),
	});
export type VodInputImagePrepareRequest = z.infer<
	typeof vodInputImagePrepareRequestSchema
>;
/** Public image submissions are sealed with server-observed identity before hashing. */
export const vodInputPreviewSubmissionSchema = z.discriminatedUnion("kind", [
	probeRequestSchema,
	previewRequestSchema,
	vodInputImagePrepareInputSchema,
]);
export type VodInputPreviewSubmission = z.infer<
	typeof vodInputPreviewSubmissionSchema
>;
export const vodInputPreviewRequestSchema = z.discriminatedUnion("kind", [
	probeRequestSchema,
	previewRequestSchema,
	vodInputImagePrepareRequestSchema,
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
	prepared: z
		.strictObject({
			source: vodInputTimelineSourceSchema,
			facts: vodInputTimelineSourceFactsSchema,
			requestedDurationMs: z.number().int().min(1000).max(60_000),
			sha256: z.string().regex(/^[a-f0-9]{64}$/),
		})
		.refine(
			(value) =>
				value.source.key === value.facts.key &&
				value.facts.video !== null &&
				value.facts.audio !== null &&
				value.facts.durationMs >= value.requestedDurationMs,
			"A prepared image needs matching video/audio source evidence",
		)
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
	kind: z.enum(["PROBE", "PREVIEW", "IMAGE_PREPARE"]),
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
