import { describe, expect, it } from "vitest";
import {
	LocalStoryLegacyAsrError,
	parseLegacyWhisperTranscript,
} from "./local-story-flow-legacy-asr";

// Synthetic outputs captured from the existing worker parser before extraction.
// These fixtures contain no media, customer text, model calls or decoded source assets.
const cases = [
	{
		name: "qualified words at nonzero source offset",
		raw: {
			result: {
				language: "en",
			},
			bitovp_quality: {
				version: "bitovp-mapped-quality-v1",
				vad: true,
				speech_intervals: [
					{
						offsets: {
							from: 0,
							to: 5000,
						},
					},
				],
			},
			transcription: [
				{
					text: "Hello world.",
					offsets: {
						from: 1000,
						to: 3000,
					},
					no_speech_probability: 0.01,
					tokens: [
						{
							text: "Hello",
							p: 0.95,
							offsets: {
								from: 1000,
								to: 1800,
							},
						},
						{
							text: " world",
							p: 0.9,
							offsets: {
								from: 1800,
								to: 2800,
							},
						},
						{
							text: ".",
							p: 0.9,
							offsets: {
								from: 2800,
								to: 3000,
							},
						},
					],
				},
			],
		},
		durationUs: 10000000,
		sourceStartUs: 7000000,
		requireQuality: true,
		expected: {
			kind: "VALUE",
			value: {
				language: "en",
				segments: [
					{
						startUs: 8000000,
						endUs: 10000000,
						text: "Hello world.",
						words: [
							{
								text: "Hello",
								startChar: 0,
								endChar: 5,
								startUs: 8000000,
								endUs: 8800000,
								confidence: 0.95,
							},
							{
								text: "world",
								startChar: 6,
								endChar: 11,
								startUs: 8800000,
								endUs: 9800000,
								confidence: 0.9,
							},
						],
					},
				],
				warnings: [],
				rawSegments: [
					{
						startUs: 8000000,
						endUs: 10000000,
						text: "Hello world.",
						tokens: [
							{
								text: "Hello",
								p: 0.95,
								startUs: 8000000,
								endUs: 8800000,
							},
							{
								text: " world",
								p: 0.9,
								startUs: 8800000,
								endUs: 9800000,
							},
							{
								text: ".",
								p: 0.9,
								startUs: 9800000,
								endUs: 10000000,
							},
						],
						quality: {
							noSpeechProbability: 0.01,
							meanTokenLogProbability: -0.07832690502268844,
							speechOverlapUs: 2000000,
							decision: "ADMITTED",
						},
					},
				],
				speechIntervals: [
					{
						startUs: 7000000,
						endUs: 12000000,
					},
				],
			},
		},
	},
	{
		name: "quiet window keeps raw evidence but no displayed speech",
		raw: {
			result: {
				language: "en",
			},
			bitovp_quality: {
				version: "bitovp-mapped-quality-v1",
				vad: true,
				speech_intervals: [],
			},
			transcription: [
				{
					text: "Hello world.",
					offsets: {
						from: 1000,
						to: 3000,
					},
					no_speech_probability: 0.01,
					tokens: [
						{
							text: "Hello",
							p: 0.95,
							offsets: {
								from: 1000,
								to: 1800,
							},
						},
						{
							text: " world",
							p: 0.9,
							offsets: {
								from: 1800,
								to: 2800,
							},
						},
						{
							text: ".",
							p: 0.9,
							offsets: {
								from: 2800,
								to: 3000,
							},
						},
					],
				},
			],
		},
		durationUs: 10000000,
		sourceStartUs: 0,
		requireQuality: true,
		expected: {
			kind: "VALUE",
			value: {
				language: "en",
				segments: [],
				warnings: ["WORD_ALIGNMENT_UNAVAILABLE", "NO_SPEECH"],
				rawSegments: [
					{
						startUs: 1000000,
						endUs: 3000000,
						text: "Hello world.",
						tokens: [
							{
								text: "Hello",
								p: 0.95,
								startUs: 1000000,
								endUs: 1800000,
							},
							{
								text: " world",
								p: 0.9,
								startUs: 1800000,
								endUs: 2800000,
							},
							{
								text: ".",
								p: 0.9,
								startUs: 2800000,
								endUs: 3000000,
							},
						],
						quality: {
							noSpeechProbability: 0.01,
							meanTokenLogProbability: -0.07832690502268844,
							speechOverlapUs: 0,
							decision: "NO_VAD_SPEECH",
						},
					},
				],
				speechIntervals: [],
			},
		},
	},
	{
		name: "low confidence speech is not displayed",
		raw: {
			result: {
				language: "en",
			},
			bitovp_quality: {
				version: "bitovp-mapped-quality-v1",
				vad: true,
				speech_intervals: [
					{
						offsets: {
							from: 0,
							to: 5000,
						},
					},
				],
			},
			transcription: [
				{
					text: "Hello world.",
					offsets: {
						from: 1000,
						to: 3000,
					},
					no_speech_probability: 0.99,
					tokens: [
						{
							text: "Hello",
							p: 0.01,
							offsets: {
								from: 1000,
								to: 1800,
							},
						},
						{
							text: " world",
							p: 0.01,
							offsets: {
								from: 1800,
								to: 2800,
							},
						},
						{
							text: ".",
							p: 0.01,
							offsets: {
								from: 2800,
								to: 3000,
							},
						},
					],
				},
			],
		},
		durationUs: 10000000,
		sourceStartUs: 0,
		requireQuality: true,
		expected: {
			kind: "VALUE",
			value: {
				language: "en",
				segments: [],
				warnings: ["WORD_ALIGNMENT_UNAVAILABLE", "NO_SPEECH"],
				rawSegments: [
					{
						startUs: 1000000,
						endUs: 3000000,
						text: "Hello world.",
						tokens: [
							{
								text: "Hello",
								p: 0.01,
								startUs: 1000000,
								endUs: 1800000,
							},
							{
								text: " world",
								p: 0.01,
								startUs: 1800000,
								endUs: 2800000,
							},
							{
								text: ".",
								p: 0.01,
								startUs: 2800000,
								endUs: 3000000,
							},
						],
						quality: {
							noSpeechProbability: 0.99,
							meanTokenLogProbability: -4.605170185988091,
							speechOverlapUs: 2000000,
							decision: "NO_SPEECH_LOW_CONFIDENCE",
						},
					},
				],
				speechIntervals: [
					{
						startUs: 0,
						endUs: 5000000,
					},
				],
			},
		},
	},
	{
		name: "bounded EOF clamp never invents word timing",
		raw: {
			result: {
				language: "en",
			},
			bitovp_quality: {
				version: "bitovp-mapped-quality-v1",
				vad: true,
				speech_intervals: [
					{
						offsets: {
							from: 8800,
							to: 10020,
						},
					},
				],
			},
			transcription: [
				{
					text: "Last words.",
					offsets: {
						from: 9000,
						to: 10010,
					},
					no_speech_probability: 0.01,
					tokens: [
						{
							text: "Last words.",
							p: 0.95,
							offsets: {
								from: 9000,
								to: 10010,
							},
						},
					],
				},
			],
		},
		durationUs: 10000000,
		sourceStartUs: 0,
		requireQuality: true,
		expected: {
			kind: "VALUE",
			value: {
				language: "en",
				segments: [
					{
						startUs: 9000000,
						endUs: 10000000,
						text: "Last words.",
					},
				],
				warnings: ["SEGMENT_END_CLAMPED", "WORD_ALIGNMENT_UNAVAILABLE"],
				rawSegments: [
					{
						startUs: 9000000,
						endUs: 10010000,
						text: "Last words.",
						tokens: [
							{
								text: "Last words.",
								p: 0.95,
								startUs: 9000000,
								endUs: 10010000,
							},
						],
						quality: {
							noSpeechProbability: 0.01,
							meanTokenLogProbability: -0.05129329438755058,
							speechOverlapUs: 1000000,
							decision: "ADMITTED",
						},
					},
				],
				speechIntervals: [
					{
						startUs: 8800000,
						endUs: 10000000,
					},
				],
			},
		},
	},
	{
		name: "missing quality provenance",
		raw: {
			result: {
				language: "en",
			},
			transcription: [
				{
					text: "Hello world.",
					offsets: {
						from: 1000,
						to: 3000,
					},
					no_speech_probability: 0.01,
					tokens: [
						{
							text: "Hello",
							p: 0.95,
							offsets: {
								from: 1000,
								to: 1800,
							},
						},
						{
							text: " world",
							p: 0.9,
							offsets: {
								from: 1800,
								to: 2800,
							},
						},
						{
							text: ".",
							p: 0.9,
							offsets: {
								from: 2800,
								to: 3000,
							},
						},
					],
				},
			],
		},
		durationUs: 10000000,
		sourceStartUs: 0,
		requireQuality: true,
		expected: {
			kind: "ERROR",
			name: "MediaOperationError",
			message: "TRANSCRIPT_QUALITY_INVALID",
			code: "TRANSCRIPT_QUALITY_INVALID",
		},
	},
	{
		name: "maximum existing decoder window",
		raw: {
			result: {
				language: "ja",
			},
			bitovp_quality: {
				version: "bitovp-mapped-quality-v1",
				vad: true,
				speech_intervals: [],
			},
			transcription: [],
		},
		durationUs: 180000000,
		sourceStartUs: 0,
		requireQuality: true,
		expected: {
			kind: "VALUE",
			value: {
				language: "ja",
				segments: [],
				warnings: ["NO_SPEECH"],
				rawSegments: [],
				speechIntervals: [],
			},
		},
	},
	{
		name: "decoder window overflow",
		raw: {
			result: {
				language: "en",
			},
			bitovp_quality: {
				version: "bitovp-mapped-quality-v1",
				vad: true,
				speech_intervals: [
					{
						offsets: {
							from: 0,
							to: 5000,
						},
					},
				],
			},
			transcription: [
				{
					text: "Hello world.",
					offsets: {
						from: 1000,
						to: 3000,
					},
					no_speech_probability: 0.01,
					tokens: [
						{
							text: "Hello",
							p: 0.95,
							offsets: {
								from: 1000,
								to: 1800,
							},
						},
						{
							text: " world",
							p: 0.9,
							offsets: {
								from: 1800,
								to: 2800,
							},
						},
						{
							text: ".",
							p: 0.9,
							offsets: {
								from: 2800,
								to: 3000,
							},
						},
					],
				},
			],
		},
		durationUs: 180000001,
		sourceStartUs: 0,
		requireQuality: true,
		expected: {
			kind: "ERROR",
			name: "RangeError",
			message: "Invalid local analysis bound",
			code: null,
		},
	},
	{
		name: "source offset overflow",
		raw: {
			result: {
				language: "en",
			},
			bitovp_quality: {
				version: "bitovp-mapped-quality-v1",
				vad: true,
				speech_intervals: [
					{
						offsets: {
							from: 0,
							to: 5000,
						},
					},
				],
			},
			transcription: [
				{
					text: "Hello world.",
					offsets: {
						from: 1000,
						to: 3000,
					},
					no_speech_probability: 0.01,
					tokens: [
						{
							text: "Hello",
							p: 0.95,
							offsets: {
								from: 1000,
								to: 1800,
							},
						},
						{
							text: " world",
							p: 0.9,
							offsets: {
								from: 1800,
								to: 2800,
							},
						},
						{
							text: ".",
							p: 0.9,
							offsets: {
								from: 2800,
								to: 3000,
							},
						},
					],
				},
			],
		},
		durationUs: 10000000,
		sourceStartUs: 9007199254740991,
		requireQuality: true,
		expected: {
			kind: "ERROR",
			name: "RangeError",
			message: "Invalid local analysis bound",
			code: null,
		},
	},
];

describe("shared legacy ASR parser compatibility", () => {
	it.each(cases)("$name", (c) => {
		const execute = () =>
			parseLegacyWhisperTranscript(c.raw, c.durationUs, c.sourceStartUs, {
				requireQuality: c.requireQuality,
			});
		if (c.expected.kind === "VALUE") {
			expect(execute()).toEqual(c.expected.value);
		} else {
			try {
				execute();
				throw new Error("Expected authored legacy rejection");
			} catch (error) {
				expect(error).toBeInstanceOf(
					c.expected.code ? LocalStoryLegacyAsrError : RangeError,
				);
				expect(error).toMatchObject({ message: c.expected.message });
				if (c.expected.code)
					expect(error).toMatchObject({ code: c.expected.code });
			}
		}
	});
});
