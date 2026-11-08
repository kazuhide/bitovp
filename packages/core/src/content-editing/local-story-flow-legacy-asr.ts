import { TRANSCRIPTION_QUALITY_POLICY } from "../content-production/transcription-quality";

/** Historical JSON decoder rules, shared by worker and server evidence readers. No media or model IO. */
export const LOCAL_STORY_LEGACY_ASR_EVIDENCE_POLICY = Object.freeze({
	version: "legacy-whisper-json-evidence-v1",
	windowDurationUs: 180_000_000,
});
const MAX_ANALYSIS_DURATION_US =
	LOCAL_STORY_LEGACY_ASR_EVIDENCE_POLICY.windowDurationUs;
export class LocalStoryLegacyAsrError extends Error {
	constructor(
		readonly code:
			| "TRANSCRIPT_INVALID"
			| "TRANSCRIPT_LIMIT"
			| "TRANSCRIPT_QUALITY_INVALID",
	) {
		super(code);
	}
}
function boundedLegacyInteger(value: number, min: number, max: number) {
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw new RangeError("Invalid local analysis bound");
	return value;
}
export type LegacyTranscriptWord = {
	text: string;
	startChar: number;
	endChar: number;
	startUs: number;
	endUs: number;
	confidence: number;
};
export type LegacyTranscriptSegment = {
	startUs: number;
	endUs: number;
	text: string;
	words?: LegacyTranscriptWord[];
};
export type LegacySpeechInterval = { startUs: number; endUs: number };
export type LegacyRawTranscriptToken = {
	text: string;
	p: number;
	startUs?: number;
	endUs?: number;
};
export type LegacyRawTranscriptSegment = LegacySpeechInterval & {
	text: string;
	tokens?: LegacyRawTranscriptToken[];
	quality: {
		noSpeechProbability: number | null;
		meanTokenLogProbability: number | null;
		speechOverlapUs: number;
		decision:
			| "ADMITTED"
			| "NO_VAD_SPEECH"
			| "NO_SPEECH_LOW_CONFIDENCE"
			| "ISOLATED_LOW_CONFIDENCE"
			| "NO_LEXICAL_CONTENT";
	};
};
const qualityRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === "object" && !Array.isArray(v);
const qualityProbability = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const qualityMillis = (v: unknown): v is number =>
	typeof v === "number" &&
	Number.isSafeInteger(v) &&
	v >= 0 &&
	v <= MAX_ANALYSIS_DURATION_US / 1000;
function qualityInvalid(): never {
	throw new LocalStoryLegacyAsrError("TRANSCRIPT_QUALITY_INVALID");
}

export function parseLegacyWhisperSpeechIntervals(
	raw: unknown,
	durationUs: number,
	sourceStartUs: number,
): LegacySpeechInterval[] {
	if (!qualityRecord(raw) || !qualityRecord(raw.bitovp_quality))
		return qualityInvalid();
	const quality = raw.bitovp_quality;
	if (
		quality.version !== TRANSCRIPTION_QUALITY_POLICY.jsonExporter ||
		quality.vad !== true ||
		!Array.isArray(quality.speech_intervals) ||
		quality.speech_intervals.length > 10_000
	)
		return qualityInvalid();
	let priorEnd = 0;
	return quality.speech_intervals.map((value: unknown) => {
		if (!qualityRecord(value) || !qualityRecord(value.offsets))
			return qualityInvalid();
		const { from, to } = value.offsets;
		if (
			!qualityMillis(from) ||
			!qualityMillis(to) ||
			from * 1000 < priorEnd ||
			from * 1000 >= durationUs ||
			to <= from ||
			to * 1000 - durationUs >
				TRANSCRIPTION_QUALITY_POLICY.vad.nativeEndPaddingMaxUs
		)
			return qualityInvalid();
		priorEnd = to * 1000;
		return {
			startUs: sourceStartUs + from * 1000,
			// The pinned 512-sample VAD pads its last 32ms window, then rounds
			// to centiseconds (at most another 5ms). Only this bounded tail is
			// qualified against real audio; wholly padded intervals stay qualityInvalid.
			endUs: sourceStartUs + Math.min(to * 1000, durationUs),
		};
	});
}

/** Keep the model text/probabilities even when it is unsuitable for displayed captions. */
export function assessLegacyWhisperSegment(
	raw: Record<string, unknown>,
	segment: LegacySpeechInterval & { text: string },
	intervals: readonly LegacySpeechInterval[],
	sourceStartUs: number,
	wordAlignmentAvailable: boolean,
): LegacyRawTranscriptSegment {
	if (
		!qualityProbability(raw.no_speech_probability) ||
		!Array.isArray(raw.tokens) ||
		raw.tokens.length > 1024
	)
		return qualityInvalid();
	const tokens = raw.tokens.map((value: unknown): LegacyRawTranscriptToken => {
		if (
			!qualityRecord(value) ||
			typeof value.text !== "string" ||
			value.text.length > 4096 ||
			!qualityProbability(value.p)
		)
			return qualityInvalid();
		const offsets =
			qualityRecord(value.offsets) &&
			qualityMillis(value.offsets.from) &&
			qualityMillis(value.offsets.to) &&
			value.offsets.to >= value.offsets.from
				? {
						startUs: sourceStartUs + value.offsets.from * 1000,
						endUs: sourceStartUs + value.offsets.to * 1000,
					}
				: {};
		return { text: value.text, p: value.p, ...offsets };
	});
	const lexical = tokens.filter(
		(t) => !/^\[(?:_|\|).*\]$/.test(t.text) && /[\p{L}\p{N}]/u.test(t.text),
	);
	const meanTokenLogProbability = lexical.length
		? lexical.reduce(
				(sum, t) => sum + Math.log(Math.max(t.p, Number.MIN_VALUE)),
				0,
			) / lexical.length
		: null;
	const speechOverlapUs = intervals.reduce(
		(sum, interval) =>
			sum +
			Math.max(
				0,
				Math.min(interval.endUs, segment.endUs) -
					Math.max(interval.startUs, segment.startUs),
			),
		0,
	);
	const overlapping = intervals.filter(
		(interval) =>
			interval.startUs < segment.endUs && interval.endUs > segment.startUs,
	);
	const island = overlapping.length === 1 ? overlapping[0] : undefined;
	const isolatedWeakSpeech =
		!wordAlignmentAvailable &&
		lexical.length > 0 &&
		lexical.length <=
			TRANSCRIPTION_QUALITY_POLICY.admission.isolatedMaxLexicalTokens &&
		meanTokenLogProbability !== null &&
		meanTokenLogProbability <
			TRANSCRIPTION_QUALITY_POLICY.admission.isolatedLogProbabilityThreshold &&
		island !== undefined &&
		island.endUs - island.startUs <=
			TRANSCRIPTION_QUALITY_POLICY.admission.isolatedSpeechMaxUs &&
		intervals.every(
			(interval) =>
				interval === island ||
				interval.endUs <
					island.startUs -
						TRANSCRIPTION_QUALITY_POLICY.admission.isolatedGapUs ||
				interval.startUs >
					island.endUs + TRANSCRIPTION_QUALITY_POLICY.admission.isolatedGapUs,
		);
	const decision =
		speechOverlapUs === 0
			? "NO_VAD_SPEECH"
			: !lexical.length || !/[\p{L}\p{N}]/u.test(segment.text)
				? "NO_LEXICAL_CONTENT"
				: raw.no_speech_probability >=
							TRANSCRIPTION_QUALITY_POLICY.admission.noSpeechThreshold &&
						meanTokenLogProbability !== null &&
						meanTokenLogProbability <
							TRANSCRIPTION_QUALITY_POLICY.admission.logProbabilityThreshold
					? "NO_SPEECH_LOW_CONFIDENCE"
					: isolatedWeakSpeech
						? "ISOLATED_LOW_CONFIDENCE"
						: "ADMITTED";
	return {
		...segment,
		tokens,
		quality: {
			noSpeechProbability: raw.no_speech_probability,
			meanTokenLogProbability,
			speechOverlapUs,
			decision,
		},
	};
}

export function legacyWordsInsideSpeech(
	words: readonly LegacySpeechInterval[],
	intervals: readonly LegacySpeechInterval[],
) {
	return words.every((word) =>
		intervals.some(
			(interval) =>
				word.startUs >= interval.startUs && word.endUs <= interval.endUs,
		),
	);
}

type LegacyWhisperRecord = {
	language: string;
	segments: LegacyTranscriptSegment[];
	warnings: string[];
	rawSegments: LegacyRawTranscriptSegment[];
	speechIntervals: LegacySpeechInterval[];
};
const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const millis = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isSafeInteger(value) &&
	value >= 0 &&
	value <= MAX_ANALYSIS_DURATION_US / 1000;
function readOffsets(value: unknown): { from: number; to: number } | undefined {
	if (record(value) && millis(value.from) && millis(value.to))
		return { from: value.from, to: value.to };
}
type WhisperToken = {
	text: string;
	offsets?: { from: number; to: number };
	p: number;
};
function readTokens(input: unknown[] | undefined): WhisperToken[] | undefined {
	if (!input || input.length > 10_000) return;
	const tokens: WhisperToken[] = [];
	for (const value of input) {
		if (
			!record(value) ||
			typeof value.text !== "string" ||
			value.text.length > 4096 ||
			typeof value.p !== "number" ||
			!Number.isFinite(value.p) ||
			value.p < 0 ||
			value.p > 1
		)
			return;
		tokens.push({
			text: value.text,
			offsets: readOffsets(value.offsets),
			p: value.p,
		});
	}
	return tokens;
}

function alignedWords(
	text: string,
	input: unknown[] | undefined,
	language: string,
	startMs: number,
	endMs: number,
	sourceStartUs: number,
): LegacyTranscriptWord[] | undefined {
	const parsed = readTokens(input);
	if (!parsed) return;
	const tokens = parsed.filter((token) => !/^\[(?:_|\|).*\]$/.test(token.text));
	if (!tokens.length || tokens.map((token) => token.text).join("") !== text)
		return;
	let position = 0,
		priorEnd = startMs;
	const ranges: {
		fromChar: number;
		toChar: number;
		from: number;
		to: number;
		p: number;
	}[] = [];
	for (const token of tokens) {
		const range = token.offsets;
		if (
			!range ||
			range.from < priorEnd ||
			range.to <= range.from ||
			range.to > endMs ||
			(/[\p{L}\p{N}]/u.test(token.text) && token.p < 0.35) ||
			token.text.includes("\uFFFD")
		)
			return;
		ranges.push({
			fromChar: position,
			toChar: position + token.text.length,
			from: range.from,
			to: range.to,
			p: token.p,
		});
		position += token.text.length;
		priorEnd = range.to;
	}
	const words: LegacyTranscriptWord[] = [];
	for (const word of new Intl.Segmenter(language, {
		granularity: "word",
	}).segment(text)) {
		if (!word.isWordLike) continue;
		const startChar = word.index,
			endChar = startChar + word.segment.length;
		const covered = ranges.filter(
			(range) => range.toChar > startChar && range.fromChar < endChar,
		);
		const first = covered[0],
			last = covered.at(-1);
		// Whitespace carried by a BPE token is harmless; splitting a token's
		// audible text into guessed sub-word timestamps is never permitted.
		if (
			!first ||
			!last ||
			text.slice(first.fromChar, startChar).trim() ||
			text.slice(endChar, last.toChar).trim()
		)
			return;
		words.push({
			text: word.segment,
			startChar,
			endChar,
			startUs: sourceStartUs + first.from * 1000,
			endUs: sourceStartUs + last.to * 1000,
			confidence: Math.min(...covered.map((range) => range.p)),
		});
	}
	return words.length ? words : undefined;
}

/** Only recorded CLI offsets are admitted. Word timing remains a model estimate. */
export function parseLegacyWhisperTranscript(
	raw: unknown,
	durationUs: number,
	sourceStartUs = 0,
	options: { requireQuality?: boolean } = {},
): Pick<LegacyWhisperRecord, "language" | "segments" | "warnings"> &
	Partial<Pick<LegacyWhisperRecord, "rawSegments" | "speechIntervals">> {
	boundedLegacyInteger(durationUs, 1, MAX_ANALYSIS_DURATION_US);
	boundedLegacyInteger(sourceStartUs, 0, Number.MAX_SAFE_INTEGER - durationUs);
	if (
		!record(raw) ||
		!record(raw.result) ||
		typeof raw.result.language !== "string" ||
		!/^[a-z]{2,3}$/.test(raw.result.language) ||
		!Array.isArray(raw.transcription) ||
		raw.transcription.length > 10_000
	)
		throw new LocalStoryLegacyAsrError("TRANSCRIPT_INVALID");
	const language = raw.result.language;
	const warnings = new Set<string>();
	const speechIntervals = options.requireQuality
		? parseLegacyWhisperSpeechIntervals(raw, durationUs, sourceStartUs)
		: undefined;
	const rawSegments: LegacyRawTranscriptSegment[] = [];
	let priorEnd = 0,
		totalWords = 0;
	const segments = raw.transcription.map(
		(segment: unknown): LegacyTranscriptSegment => {
			if (
				!record(segment) ||
				typeof segment.text !== "string" ||
				!segment.text.length ||
				segment.text.length > 16_000
			)
				throw new LocalStoryLegacyAsrError("TRANSCRIPT_INVALID");
			const offsets = readOffsets(segment.offsets);
			if (!offsets) throw new LocalStoryLegacyAsrError("TRANSCRIPT_INVALID");
			const from = offsets.from * 1000,
				to = offsets.to * 1000;
			if (
				from < priorEnd ||
				to <= from ||
				from >= durationUs ||
				to - durationUs >= 1_000_000 ||
				segment.text.includes("\uFFFD") ||
				!segment.text.trim()
			)
				throw new LocalStoryLegacyAsrError("TRANSCRIPT_INVALID");
			const boundedEnd = Math.min(to, durationUs);
			priorEnd = boundedEnd;
			// Whisper can close its last segment in padded decoder audio. Retain
			// only a short tail correction, record it, and discard word alignment.
			if (to > durationUs) warnings.add("SEGMENT_END_CLAMPED");
			let words =
				to > durationUs
					? undefined
					: alignedWords(
							segment.text,
							Array.isArray(segment.tokens) ? segment.tokens : undefined,
							language,
							offsets.from,
							offsets.to,
							sourceStartUs,
						);
			if (!words) warnings.add("WORD_ALIGNMENT_UNAVAILABLE");
			if (speechIntervals) {
				if (words && !legacyWordsInsideSpeech(words, speechIntervals)) {
					words = undefined;
					warnings.add("WORD_ALIGNMENT_UNAVAILABLE");
				}
				const evidence = assessLegacyWhisperSegment(
					segment,
					{
						startUs: sourceStartUs + from,
						endUs: sourceStartUs + to,
						text: segment.text,
					},
					speechIntervals,
					sourceStartUs,
					words !== undefined,
				);
				rawSegments.push(evidence);
			}
			totalWords += words?.length ?? 0;
			if (totalWords > 30_000)
				throw new LocalStoryLegacyAsrError("TRANSCRIPT_LIMIT");
			return {
				startUs: sourceStartUs + from,
				endUs: sourceStartUs + boundedEnd,
				text: segment.text,
				...(words ? { words } : {}),
			};
		},
	);
	const admitted = speechIntervals
		? segments.filter(
				(_, index) => rawSegments[index]?.quality.decision === "ADMITTED",
			)
		: segments;
	if (!admitted.length) warnings.add("NO_SPEECH");
	return {
		language,
		segments: admitted,
		warnings: [...warnings],
		...(speechIntervals ? { rawSegments, speechIntervals } : {}),
	};
}
