import type { LocalTranscript } from "../src/library-editing/transcription";

export function hasBenchmarkSpeech(
	result: Pick<LocalTranscript, "segments" | "speechIntervals" | "rawSegments">,
): boolean {
	return (
		result.segments.length > 0 &&
		result.speechIntervals.length > 0 &&
		result.rawSegments.some(
			({ quality }) =>
				quality.speechOverlapUs > 0 && quality.decision === "ADMITTED",
		)
	);
}
