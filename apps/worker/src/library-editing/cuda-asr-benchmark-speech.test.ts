import { describe, expect, it } from "vitest";
import { hasBenchmarkSpeech } from "../../scripts/cuda-asr-benchmark-speech";
import type { LocalTranscript } from "./transcription";

const speech = [{ startUs: 0, endUs: 1_000_000 }];
const raw: LocalTranscript["rawSegments"][number] = {
	startUs: 0,
	endUs: 1_000_000,
	text: " Hello",
	quality: {
		noSpeechProbability: 0.1,
		meanTokenLogProbability: -0.2,
		speechOverlapUs: 1_000_000,
		decision: "ADMITTED",
	},
};

describe("CUDA ASR benchmark sample evidence", () => {
	it("rejects detector-only runs with no emitted transcript", () => {
		expect(hasBenchmarkSpeech({ speechIntervals: [], rawSegments: [] })).toBe(
			false,
		);
		expect(
			hasBenchmarkSpeech({ speechIntervals: speech, rawSegments: [] }),
		).toBe(false);
		expect(
			hasBenchmarkSpeech({ speechIntervals: [], rawSegments: [raw] }),
		).toBe(false);
	});
	it("requires lexical raw speech overlapping a detected interval", () => {
		expect(
			hasBenchmarkSpeech({
				speechIntervals: speech,
				rawSegments: [
					{
						...raw,
						quality: { ...raw.quality, decision: "NO_LEXICAL_CONTENT" },
					},
				],
			}),
		).toBe(false);
		expect(
			hasBenchmarkSpeech({ speechIntervals: speech, rawSegments: [raw] }),
		).toBe(true);
	});
});
