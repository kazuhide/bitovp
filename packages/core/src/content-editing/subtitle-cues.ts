import { COMPOSITION_CAPTION_SELECTION_POLICY } from "./composition-caption-source";
import type { CompositionCaption } from "./composition-schema";

type MeasuredWord = NonNullable<CompositionCaption["words"]>[number];
type Cue = Pick<CompositionCaption, "text" | "fromFrame" | "toFrame" | "words">;

// Layout limits at the composition's fixed 30 fps. An indivisible measured word
// or an unaligned text gap is retained rather than assigned invented timing.
const MAX_READING_UNITS = 42;
const MAX_WORDS = 8;
const MAX_FRAMES = 120;
const PAUSE_FRAMES = 18;
const opening = /[\p{Ps}\p{Pi}"']*$/u;
const alignedOpening = /[\p{Ps}\p{Pi}\p{Sc}\p{Sm}\p{Pd}"'\s]*$/u;
const closing = /^[\p{Pe}\p{Pf}.,!?;:、。！？…"'’]*/u;
const lexical = /[\p{L}\p{N}]/u;
const sentenceEnd = /[.!?。！？]/u;

/** Display support only: never split text or infer unobserved word timestamps. */
export function unmeasuredSubtitleWindows(
	segment: { startUs: number; endUs: number },
	intervals: readonly { startUs: number; endUs: number }[],
): { startUs: number; endUs: number }[] {
	const policy = COMPOSITION_CAPTION_SELECTION_POLICY.unmeasuredVad;
	// The caller validates ordering once. Search without copying the full source
	// for each selected run/segment; only actual intersections are materialized.
	let low = 0;
	let high = intervals.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		const interval = intervals[middle];
		if (!interval) throw new RangeError("Missing VAD interval");
		if (interval.endUs <= segment.startUs) low = middle + 1;
		else high = middle;
	}
	const support: { startUs: number; endUs: number; originalStartUs: number }[] =
		[];
	for (let index = low; index < intervals.length; index++) {
		const interval = intervals[index];
		if (!interval) throw new RangeError("Missing VAD interval");
		if (interval.startUs >= segment.endUs) break;
		const startUs = Math.max(segment.startUs, interval.startUs);
		const endUs = Math.min(segment.endUs, interval.endUs);
		if (endUs > startUs)
			support.push({ startUs, endUs, originalStartUs: interval.startUs });
	}
	const first = support[0];
	const next = support[1];
	if (first && next) {
		const firstDuration = first.endUs - first.startUs;
		const laterDuration = support
			.slice(1)
			.reduce((sum, interval) => sum + (interval.endUs - interval.startUs), 0);
		// A tiny tail of the preceding VAD island is not support for displaying
		// the following full sentence across a long silence. Every guard matters:
		// complete short utterances and isolated short support remain visible.
		if (
			first.originalStartUs < segment.startUs &&
			firstDuration <= policy.carryInMaxUs &&
			next.startUs - first.endUs >= policy.mergeGapUs &&
			laterDuration >= policy.laterSupportMinUs &&
			BigInt(firstDuration) * BigInt(policy.carryInSupportRatioDenominator) <=
				BigInt(firstDuration + laterDuration) &&
			segment.endUs - segment.startUs >= policy.segmentMinUs
		)
			support.shift();
	}
	const windows: { startUs: number; endUs: number }[] = [];
	for (const interval of support) {
		const previous = windows.at(-1);
		if (previous && interval.startUs - previous.endUs < policy.mergeGapUs)
			previous.endUs = interval.endUs;
		else windows.push({ startUs: interval.startUs, endUs: interval.endUs });
	}
	return windows.map((window) => ({
		startUs: window.startUs,
		endUs:
			window.endUs +
			Math.min(policy.endPaddingUs, segment.endUs - window.endUs),
	}));
}

function readingUnits(text: string) {
	return [...text].reduce(
		(sum, character) => sum + (character.charCodeAt(0) <= 0x7f ? 1 : 2),
		0,
	);
}

/** Exact source substrings and measured word intervals; no inferred speech. */
export function measuredSubtitleCues(input: {
	text: string;
	words: readonly MeasuredWord[];
	fromFrame: number;
	toFrame: number;
	requireAlignedText?: boolean;
	/** Verified VAD in this run's frame domain; display support, never word timing. */
	speechIntervals?: readonly { fromFrame: number; toFrame: number }[];
}): Cue[] {
	const { text, words } = input;
	const starts = words.map((word, index) => {
		const gap = text.slice(words[index - 1]?.endChar ?? 0, word.startChar);
		if (input.requireAlignedText && index === 0 && !lexical.test(gap)) return 0;
		return (
			word.startChar -
			(gap.match(input.requireAlignedText ? alignedOpening : opening)?.[0]
				.length ?? 0)
		);
	});
	const ends = words.map((word, index) => {
		const gap = text.slice(
			word.endChar,
			words[index + 1]?.startChar ?? text.length,
		);
		// Symbols have no independent speech timing, but must keep their original
		// meaning: −5℃ and $5 cannot become 5. Never include an unaligned word.
		if (input.requireAlignedText && !lexical.test(gap))
			return starts[index + 1] ?? text.length;
		return Math.min(
			word.endChar + (gap.match(closing)?.[0].length ?? 0),
			starts[index + 1] ?? text.length,
		);
	});
	const selected = words.flatMap((word, index) => {
		if (
			input.requireAlignedText &&
			(word.fromFrame < input.fromFrame || word.toFrame > input.toFrame)
		)
			return [];
		const fromFrame = Math.max(input.fromFrame, word.fromFrame);
		const toFrame = Math.min(input.toFrame, word.toFrame);
		return toFrame > fromFrame
			? [{ index, word: { ...word, fromFrame, toFrame } }]
			: [];
	});
	type Selected = (typeof selected)[number];
	const groups: Selected[][] = [];
	for (const item of selected) {
		const group = groups.at(-1);
		const first = group?.[0];
		const previous = group?.at(-1);
		if (!group || !first || !previous) {
			groups.push([item]);
			continue;
		}
		const gap = text.slice(previous.word.endChar, item.word.startChar);
		const canSeparate = !lexical.test(gap);
		const pause = item.word.fromFrame - previous.word.toFrame >= PAUSE_FRAMES;
		let speechAcrossPause = false;
		if (pause && input.speechIntervals) {
			// One island must cover the whole measured gap. Do not merge separate
			// islands, extend a word, or treat missing VAD as continuous speech.
			let low = 0;
			let high = input.speechIntervals.length;
			while (low < high) {
				const middle = Math.floor((low + high) / 2);
				const interval = input.speechIntervals[middle];
				if (!interval) throw new RangeError("Missing measured VAD interval");
				if (interval.toFrame < item.word.fromFrame) low = middle + 1;
				else high = middle;
			}
			const interval = input.speechIntervals[low];
			speechAcrossPause =
				interval !== undefined &&
				interval.fromFrame <= previous.word.toFrame &&
				interval.toFrame >= item.word.fromFrame;
		}
		const shouldSeparate =
			group.length >= MAX_WORDS ||
			item.word.toFrame - first.word.fromFrame > MAX_FRAMES ||
			(pause && !speechAcrossPause) ||
			sentenceEnd.test(gap) ||
			readingUnits(text.slice(starts[first.index], ends[item.index])) >
				MAX_READING_UNITS;
		if (
			(input.requireAlignedText && lexical.test(gap)) ||
			(canSeparate && shouldSeparate)
		)
			groups.push([item]);
		else group.push(item);
	}
	return groups.map((group) => {
		const first = group[0];
		const last = group.at(-1);
		if (!first || !last) throw new RangeError("Empty measured subtitle cue");
		const startChar = starts[first.index] ?? first.word.startChar;
		return {
			text: text.slice(startChar, ends[last.index]),
			fromFrame: first.word.fromFrame,
			toFrame: last.word.toFrame,
			words: group.map(({ word }) => ({
				...word,
				startChar: word.startChar - startChar,
				endChar: word.endChar - startChar,
			})),
		};
	});
}
