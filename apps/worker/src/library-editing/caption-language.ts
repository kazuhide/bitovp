import { CAPTION_ALIGNMENT_POLICY } from "@bitovp/core";

type Interval = { startUs: number; endUs: number };
type Observation = Interval & { language: string };

/** Use only observed ASR windows covering the full audio the aligner will hear. */
export function captionLanguageForSelectedSegments(
	segments: readonly Interval[],
	observations: readonly Observation[],
	source: Interval,
): "ja" | "en" | undefined {
	if (!segments.length || !observations.length) return;
	let previousEnd = source.startUs;
	for (const window of observations) {
		if (
			!Number.isSafeInteger(window.startUs) ||
			!Number.isSafeInteger(window.endUs) ||
			window.startUs < previousEnd ||
			window.endUs <= window.startUs ||
			window.endUs > source.endUs
		)
			return;
		previousEnd = window.endUs;
	}
	let language: "ja" | "en" | undefined;
	for (const segment of segments) {
		if (
			segment.startUs < source.startUs ||
			segment.endUs > source.endUs ||
			segment.endUs <= segment.startUs
		)
			return;
		const from = Math.max(
			source.startUs,
			segment.startUs - CAPTION_ALIGNMENT_POLICY.contextUs,
		);
		const to = Math.min(
			source.endUs,
			segment.endUs + CAPTION_ALIGNMENT_POLICY.contextUs,
		);
		let covered = from;
		for (const window of observations) {
			if (window.endUs <= from) continue;
			if (window.startUs >= to) break;
			if (
				window.startUs > covered ||
				(window.language !== "ja" && window.language !== "en") ||
				(language && language !== window.language)
			)
				return;
			language = window.language;
			covered = Math.max(covered, Math.min(to, window.endUs));
		}
		if (covered < to) return;
	}
	return language;
}
