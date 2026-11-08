import { describe, expect, it } from "vitest";
import { hashEditingEvidence } from "../content-editing/verify-automatic-binding";
import {
	TRANSCRIPTION_POLICY_FINGERPRINT,
	TRANSCRIPTION_QUALITY_POLICY,
	transcriptionRawSegmentSchema,
} from "./transcription-quality";

describe("shared transcription quality identity", () => {
	it("binds model-independent VAD, admission and decoder policy in a canonical fingerprint", () => {
		expect(TRANSCRIPTION_QUALITY_POLICY.version).toBe("whisper-vad-quality-v2");
		expect(TRANSCRIPTION_QUALITY_POLICY.vadModelSha256).toBe(
			"2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
		);
		expect(TRANSCRIPTION_POLICY_FINGERPRINT).toBe(
			hashEditingEvidence(TRANSCRIPTION_QUALITY_POLICY),
		);
		expect(
			hashEditingEvidence({
				...TRANSCRIPTION_QUALITY_POLICY,
				vad: { ...TRANSCRIPTION_QUALITY_POLICY.vad, threshold: 0.7 },
			}),
		).not.toBe(TRANSCRIPTION_POLICY_FINGERPRINT);
	});
	it("seals bounded native EOF padding and the conjunctive isolated speech gate separately from old caches", () => {
		expect(TRANSCRIPTION_QUALITY_POLICY.vad.nativeEndPaddingMaxUs).toBe(37000);
		expect(TRANSCRIPTION_QUALITY_POLICY.admission).toEqual({
			noSpeechThreshold: 0.6,
			logProbabilityThreshold: -1,
			isolatedSpeechMaxUs: 500000,
			isolatedGapUs: 500000,
			isolatedMaxLexicalTokens: 2,
			isolatedLogProbabilityThreshold: -2,
		});
		const v1 = {
			...TRANSCRIPTION_QUALITY_POLICY,
			version: "whisper-vad-quality-v1",
			vad: {
				threshold: 0.5,
				minSpeechMs: 250,
				minSilenceMs: 100,
				padMs: 30,
				overlapSeconds: 0.1,
			},
			admission: { noSpeechThreshold: 0.6, logProbabilityThreshold: -1 },
		};
		expect(TRANSCRIPTION_POLICY_FINGERPRINT).not.toBe(hashEditingEvidence(v1));
		for (const [key, value] of Object.entries({
			isolatedSpeechMaxUs: 500001,
			isolatedGapUs: 500001,
			isolatedMaxLexicalTokens: 3,
			isolatedLogProbabilityThreshold: -3,
		})) {
			expect(
				hashEditingEvidence({
					...TRANSCRIPTION_QUALITY_POLICY,
					admission: {
						...TRANSCRIPTION_QUALITY_POLICY.admission,
						[key]: value,
					},
				}),
			).not.toBe(TRANSCRIPTION_POLICY_FINGERPRINT);
		}
	});
	it.each([
		"ADMITTED",
		"NO_VAD_SPEECH",
		"NO_SPEECH_LOW_CONFIDENCE",
		"NO_LEXICAL_CONTENT",
		"ISOLATED_LOW_CONFIDENCE",
	])("retains raw recognition and known decision %s", (decision) => {
		const raw = {
			startUs: 100,
			endUs: 380100,
			text: " you",
			tokens: [{ text: " you", p: 0.0672, startUs: 100, endUs: 380100 }],
			quality: {
				noSpeechProbability: 0.000019,
				meanTokenLogProbability: Math.log(0.0672),
				speechOverlapUs: 380000,
				decision,
			},
		};
		expect(transcriptionRawSegmentSchema.parse(raw)).toEqual(raw);
		expect(
			transcriptionRawSegmentSchema.safeParse({
				...raw,
				quality: { ...raw.quality, decision: "UNVERIFIED" },
			}).success,
		).toBe(false);
	});
});
