import { TRANSCRIPTION_POLICY_FINGERPRINT } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { transcriptInOriginalTime } from "./transcript-clock";
import type { LocalTranscript } from "./transcription";

describe("measured transcript source clock", () => {
	it("shifts accepted words, raw tokens and VAD intervals together without changing recognition evidence", () => {
		const result = {
			schemaVersion: 1,
			engine: "whisper.cpp",
			engineVersion: "1.9.5",
			modelSha256: "a".repeat(64),
			mediaSha256: "b".repeat(64),
			language: "en",
			cacheKey: "c".repeat(64),
			qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
			warnings: [],
			segments: [
				{
					startUs: 100,
					endUs: 500,
					text: "Hi",
					words: [
						{
							text: "Hi",
							startChar: 0,
							endChar: 2,
							startUs: 100,
							endUs: 500,
							confidence: 0.8,
						},
					],
				},
			],
			rawSegments: [
				{
					startUs: 50,
					endUs: 500,
					text: " Hi",
					tokens: [{ text: " Hi", p: 0.8, startUs: 50, endUs: 500 }],
					quality: {
						noSpeechProbability: 0.1,
						meanTokenLogProbability: -0.2,
						speechOverlapUs: 300,
						decision: "ADMITTED",
					},
				},
			],
			speechIntervals: [{ startUs: 200, endUs: 500 }],
		} as LocalTranscript;
		const original = structuredClone(result),
			mapped = transcriptInOriginalTime(result, 5_000_000);
		expect(mapped.sourceTimeDomain).toBe("ORIGINAL_PRESENTATION_US");
		expect(mapped.segments[0]).toMatchObject({
			startUs: 5_000_100,
			endUs: 5_000_500,
			words: [{ startUs: 5_000_100, endUs: 5_000_500 }],
		});
		expect(mapped.rawSegments[0]).toMatchObject({
			startUs: 5_000_050,
			endUs: 5_000_500,
			tokens: [{ startUs: 5_000_050, endUs: 5_000_500, p: 0.8 }],
		});
		expect(mapped.speechIntervals).toEqual([
			{ startUs: 5_000_200, endUs: 5_000_500 },
		]);
		expect(mapped.rawSegments[0]?.quality).toEqual(
			result.rawSegments[0]?.quality,
		);
		expect(result).toEqual(original);
	});
});
