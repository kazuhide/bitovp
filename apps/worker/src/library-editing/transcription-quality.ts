import {
	assessLegacyWhisperSegment,
	LocalStoryLegacyAsrError,
	legacyWordsInsideSpeech,
	parseLegacyWhisperSpeechIntervals,
	type LegacyRawTranscriptSegment as RawTranscriptSegment,
	type LegacySpeechInterval as SpeechInterval,
} from "@bitovp/core/local-story-flow-server";
import { MediaOperationError } from "./process";

export type {
	LegacyRawTranscriptSegment as RawTranscriptSegment,
	LegacyRawTranscriptToken as RawTranscriptToken,
	LegacySpeechInterval as SpeechInterval,
} from "@bitovp/core/local-story-flow-server";

function legacyError<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof LocalStoryLegacyAsrError)
			throw new MediaOperationError(error.code);
		throw error;
	}
}
export function parseWhisperSpeechIntervals(
	raw: unknown,
	durationUs: number,
	sourceStartUs: number,
): SpeechInterval[] {
	return legacyError(() =>
		parseLegacyWhisperSpeechIntervals(raw, durationUs, sourceStartUs),
	);
}
export function assessWhisperSegment(
	raw: Record<string, unknown>,
	segment: SpeechInterval & { text: string },
	intervals: readonly SpeechInterval[],
	sourceStartUs: number,
	wordAlignmentAvailable: boolean,
): RawTranscriptSegment {
	return legacyError(() =>
		assessLegacyWhisperSegment(
			raw,
			segment,
			intervals,
			sourceStartUs,
			wordAlignmentAvailable,
		),
	);
}
export function wordsInsideSpeech(
	words: readonly SpeechInterval[],
	intervals: readonly SpeechInterval[],
) {
	return legacyWordsInsideSpeech(words, intervals);
}
