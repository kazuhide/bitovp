import { z } from "zod";

/** Original ASR paragraph bounds identify the omission; they are not caption times. */
export const captionOmissionSchema = z
	.strictObject({
		segmentIndex: z.number().int().nonnegative().max(4999),
		sourceStartUs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		sourceEndUs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		textPreview: z.string().min(1).max(160),
		textHash: z.string().regex(/^[a-f0-9]{64}$/),
		reason: z.enum(["ZERO_DURATION_NO_ANCHOR", "NO_MEASURED_SPEECH_OVERLAP"]),
	})
	.refine((value) => value.sourceEndUs > value.sourceStartUs);
export const captionOmissionsSchema = z
	.array(captionOmissionSchema)
	.min(1)
	.max(5000)
	.refine(
		(values) =>
			new Set(values.map((value) => value.segmentIndex)).size === values.length,
	);
export type CaptionOmission = z.infer<typeof captionOmissionSchema>;
