import type { LocalTranscript } from "../src/library-editing/transcription";

export function hasBenchmarkSpeech(
	result: Pick<LocalTranscript, "speechIntervals" | "rawSegments">,
): boolean {
	return (
		result.speechIntervals.length > 0 &&
		result.rawSegments.some(
			({ quality }) =>
				quality.speechOverlapUs > 0 &&
				quality.decision !== "NO_LEXICAL_CONTENT",
		)
	);
}
