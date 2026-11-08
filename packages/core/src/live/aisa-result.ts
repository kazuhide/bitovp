import { z } from "zod";

const identifier = z.string().refine((value) => value.trim().length > 0);
const seconds = z.number().finite().nonnegative();
const sequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.preprocess(
	(value) => (value instanceof Date ? value.toISOString() : value),
	z.iso
		.datetime({ offset: true })
		.transform((value) => new Date(value).toISOString()),
);

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

export type AisaLiveResultSnapshot = z.infer<typeof aisaResultSchema>;
