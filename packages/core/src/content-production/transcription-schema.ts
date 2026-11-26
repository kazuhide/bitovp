import { z } from "zod";

const us = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const transcriptionSpeechIntervalSchema = z
	.strictObject({ startUs: us, endUs: us })
	.refine((v) => v.endUs > v.startUs);
export const transcriptionRawSegmentSchema = z
	.strictObject({
		startUs: us,
		endUs: us,
		text: z.string().max(16000),
		tokens: z
			.array(
				z
					.strictObject({
						text: z.string().max(4096),
						p: z.number().finite().min(0).max(1),
						startUs: us.optional(),
						endUs: us.optional(),
					})
					.refine(
						(v) =>
							(v.startUs === undefined) === (v.endUs === undefined) &&
							(v.startUs === undefined ||
								(v.endUs !== undefined && v.endUs >= v.startUs)),
					),
			)
			.max(1024)
			.optional(),
		quality: z.strictObject({
			noSpeechProbability: z.number().finite().min(0).max(1).nullable(),
			meanTokenLogProbability: z.number().finite().max(0).nullable(),
			speechOverlapUs: us,
			decision: z.enum([
				"ADMITTED",
				"NO_VAD_SPEECH",
				"NO_SPEECH_LOW_CONFIDENCE",
				"NO_LEXICAL_CONTENT",
				"ISOLATED_LOW_CONFIDENCE",
			]),
		}),
	})
	.refine((v) => v.endUs >= v.startUs);
