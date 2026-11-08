import { z } from "zod";
import { hashEditingEvidence } from "../content-editing/verify-automatic-binding";

/** Shared producer/admission identity. Model weights are pinned separately. */
export const TRANSCRIPTION_QUALITY_POLICY = {
	version: "whisper-vad-quality-v2",
	engineVersion: "1.9.5",
	jsonExporter: "bitovp-mapped-quality-v1",
	vadModelSha256:
		"2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
	vad: {
		threshold: 0.5,
		minSpeechMs: 250,
		minSilenceMs: 100,
		padMs: 30,
		overlapSeconds: 0.1,
		nativeEndPaddingMaxUs: 37000,
	},
	admission: {
		noSpeechThreshold: 0.6,
		logProbabilityThreshold: -1,
		isolatedSpeechMaxUs: 500000,
		isolatedGapUs: 500000,
		isolatedMaxLexicalTokens: 2,
		isolatedLogProbabilityThreshold: -2,
	},
	decoder: {
		temperature: 0,
		beamSize: 1,
		bestOf: 1,
		maxContext: 0,
		suppressNonSpeechTokens: true,
		noFallback: true,
	},
} as const;
export const TRANSCRIPTION_POLICY_FINGERPRINT = hashEditingEvidence(
	TRANSCRIPTION_QUALITY_POLICY,
);
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
