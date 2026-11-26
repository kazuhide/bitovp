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
export {
	transcriptionRawSegmentSchema,
	transcriptionSpeechIntervalSchema,
} from "./transcription-schema";
