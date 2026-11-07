import { BITMOVIN_CLOUD_REGIONS } from "@bitovp/core";
import { z } from "zod";

export const AISA_ANALYSIS_STATUSES = [
	"CREATED",
	"QUEUED",
	"RUNNING",
	"FINISHED",
	"CANCELED",
	"ERROR",
	"TRANSFER_ERROR",
] as const;

const streamKey = z.string().regex(/^[a-zA-Z]{3,20}$/);
const identifier = z.string().refine((value) => value.trim().length > 0);
const seconds = z.number().finite().nonnegative();
const sequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const version = z.preprocess(
	(value) =>
		typeof value === "string" && value.trim() === "" ? undefined : value,
	z
		.string()
		.trim()
		.max(256)
		.regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/)
		.optional(),
);
const timestamp = z.preprocess(
	(value) =>
		value instanceof Date
			? Number.isNaN(value.getTime())
				? ""
				: value.toISOString()
			: value,
	z.iso
		.datetime({ offset: true })
		.transform((value) => new Date(value).toISOString()),
);

const destination = z.strictObject({
	outputId: z.uuid(),
	outputPath: z
		.string()
		.min(1)
		.max(2048)
		.refine((value) => !value.includes("\0")),
});
const destinations = z.array(destination).min(1);
const input = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("RTMP"), streamKey }),
	z.strictObject({
		type: z.literal("HLS"),
		url: z
			.string()
			.max(8192)
			.refine((value) => {
				try {
					const parsed = new URL(value);
					return (
						(parsed.protocol === "http:" || parsed.protocol === "https:") &&
						parsed.hostname.length > 0 &&
						!parsed.username &&
						!parsed.password &&
						!parsed.hash
					);
				} catch {
					return false;
				}
			}),
	}),
	z.strictObject({
		type: z.literal("REFERENCE"),
		inputId: z.uuid(),
		streamKey: streamKey.optional(),
	}),
]);

export const aisaCreateBodySchema = z.strictObject({
	bitmovinAccountId: z.uuid(),
	analysis: z.strictObject({
		name: z.string().trim().min(1).max(200),
		input,
		cloudRegion: z
			.enum(BITMOVIN_CLOUD_REGIONS)
			.refine((value) => value !== "EXTERNAL")
			.optional(),
		encoderVersion: version,
		recording: z.strictObject({ outputs: destinations }),
		outputs: destinations,
	}),
});

export const aisaActionBodySchema = z
	.strictObject({
		bitmovinAccountId: z.uuid(),
		action: z.enum(["start", "stop"]),
		esVersion: version,
		aicaVersion: version,
	})
	.refine(
		(value) =>
			value.action === "start" ||
			(value.esVersion === undefined && value.aicaVersion === undefined),
		"Component overrides apply only to start",
	);

/** Allowlists deliberately exclude ingest, Outputs and raw upstream errors. */
export const aisaAnalysisSchema = z.object({
	analysisId: z.uuid(),
	encodingId: z.uuid(),
	status: z.enum(AISA_ANALYSIS_STATUSES),
	name: z.string().optional(),
	createdAt: timestamp.optional(),
	inputId: z.uuid().optional(),
});

export const aisaAnalysisPageSchema = z.object({
	items: z.array(aisaAnalysisSchema),
	totalCount: z.number().int().nonnegative().optional(),
	offset: z.number().int().nonnegative().optional(),
	limit: z.number().int().min(1).max(100).optional(),
});

/** This response is served only by the separately role-protected ingest route. */
export const aisaIngestSchema = z
	.object({
		rtmpIngest: z
			.object({
				encoderIp: z.string().min(1),
				streamKey,
				application: z.string().optional(),
			})
			.optional(),
		srtIngest: z
			.object({
				mode: z.literal("LISTENER"),
				encoderIp: z.string().min(1),
				port: z.number().int().min(1).max(65535),
			})
			.optional(),
	})
	.refine((value) => !value.rtmpIngest || !value.srtIngest);

const observation = z
	.object({
		id: identifier,
		text: z.string().refine((value) => value.trim().length > 0),
		startTimeSeconds: seconds,
		endTimeSeconds: seconds,
	})
	.refine((value) => value.endTimeSeconds >= value.startTimeSeconds);

const sourceGap = z
	.object({
		startTimeSeconds: seconds,
		endTimeSeconds: seconds,
		reason: z.string(),
	})
	.refine((value) => value.endTimeSeconds >= value.startTimeSeconds);

const keyMoment = z
	.object({
		id: identifier,
		lastUpdatedSequence: sequence,
		importanceLevel: sequence,
		startInSeconds: seconds,
		endInSeconds: seconds,
		anchorInSeconds: seconds,
		observations: z
			.array(identifier)
			.min(1)
			.refine((values) => new Set(values).size === values.length),
		// Classifications are extensible; unfamiliar categories remain visible.
		categories: z
			.array(z.string())
			.default([])
			.refine((values) => new Set(values).size === values.length),
	})
	.refine(
		(value) =>
			value.endInSeconds >= value.startInSeconds &&
			value.anchorInSeconds >= value.startInSeconds &&
			value.anchorInSeconds <= value.endInSeconds,
	);

export const aisaResultSchema = z
	.object({
		analysisId: z.uuid(),
		encodingId: z.uuid(),
		sequence,
		producedAt: timestamp,
		mediaTimeOriginUnixMs: z.number().finite().positive(),
		isFinal: z.boolean(),
		analyzedStartTimeSeconds: seconds,
		analyzedEndTimeSeconds: seconds,
		metadata: z.object({ version: z.string(), disclaimer: z.string() }),
		observations: z.array(observation).default([]),
		keyMoments: z.array(keyMoment).default([]),
		sourceGaps: z.array(sourceGap).default([]),
	})
	.superRefine((value, ctx) => {
		const observations = new Set(value.observations.map((item) => item.id));
		const moments = new Set(value.keyMoments.map((item) => item.id));
		if (
			value.analyzedEndTimeSeconds < value.analyzedStartTimeSeconds ||
			observations.size !== value.observations.length ||
			moments.size !== value.keyMoments.length ||
			value.keyMoments.some(
				(moment) =>
					moment.lastUpdatedSequence > value.sequence ||
					moment.observations.some((id) => !observations.has(id)),
			)
		) {
			ctx.addIssue({
				code: "custom",
				message: "Invalid cumulative analysis result",
			});
		}
	});

export type AisaAnalysis = z.infer<typeof aisaAnalysisSchema>;
export type AisaAnalysisPage = z.infer<typeof aisaAnalysisPageSchema>;
export type AisaCreateBody = z.infer<typeof aisaCreateBodySchema>;
export type AisaActionBody = z.infer<typeof aisaActionBodySchema>;
export type AisaIngest = z.infer<typeof aisaIngestSchema>;
export type AisaResultSnapshot = z.infer<typeof aisaResultSchema>;
export type AisaResultsResponse =
	| { availability: "pending" }
	| { availability: "available"; snapshot: AisaResultSnapshot };
