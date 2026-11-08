import { MediaOperationError } from "./process";
import type { LocalTranscript } from "./transcription";

/** Model/decoder time is media-relative; all saved proof fields use original presentation time. */
export function transcriptInOriginalTime(
	result: LocalTranscript,
	originUs: number,
) {
	const shift = (value: number) => {
		const mapped = value + originUs;
		if (
			!Number.isSafeInteger(originUs) ||
			originUs < 0 ||
			!Number.isSafeInteger(value) ||
			value < 0 ||
			!Number.isSafeInteger(mapped)
		)
			throw new MediaOperationError("TRANSCRIPT_INVALID");
		return mapped;
	};
	return {
		...result,
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US" as const,
		segments: result.segments.map((segment) => ({
			...segment,
			startUs: shift(segment.startUs),
			endUs: shift(segment.endUs),
			...(segment.words
				? {
						words: segment.words.map((word) => ({
							...word,
							startUs: shift(word.startUs),
							endUs: shift(word.endUs),
						})),
					}
				: {}),
		})),
		rawSegments: result.rawSegments.map((segment) => ({
			...segment,
			startUs: shift(segment.startUs),
			endUs: shift(segment.endUs),
			...(segment.tokens
				? {
						tokens: segment.tokens.map((token) => ({
							...token,
							...(token.startUs !== undefined && token.endUs !== undefined
								? { startUs: shift(token.startUs), endUs: shift(token.endUs) }
								: {}),
						})),
					}
				: {}),
		})),
		speechIntervals: result.speechIntervals.map((interval) => ({
			startUs: shift(interval.startUs),
			endUs: shift(interval.endUs),
		})),
	};
}
