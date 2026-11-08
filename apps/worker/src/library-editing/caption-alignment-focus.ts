import {
	CAPTION_ALIGNMENT_POLICY,
	type CaptionTimingEvidence,
	type CompositionSourceSegment,
	captionTimingEvidenceSchema,
	hashEditingEvidence,
	TRANSCRIPTION_POLICY_FINGERPRINT,
} from "@bitovp/core";
import profiles from "../../native/asr-model-profiles.json" with {
	type: "json",
};
import { MediaOperationError } from "./process";

type Range = { startUs: number; endUs: number };
type Word = NonNullable<CompositionSourceSegment["words"]>[number];
export type CaptionFocusCandidate = Range & {
	id: string;
	kind: "TOKEN_END_ISLAND" | "SUPPORTED_SUFFIX";
	segmentIndex: number;
	startChar: number;
	endChar: number;
	rawSegmentIndex: number;
	rawTokenIndices: number[];
	rawStartUs: number;
	rawEndUs: number;
	text: string;
	island: Range;
};
type PlanningInput = {
	segments: readonly CompositionSourceSegment[];
	selectedRanges: readonly Range[];
	sourceOriginUs: number;
	sourceDurationUs: number;
	mediaSha256: string;
	language: "ja" | "en" | "auto";
	captionTimingEvidence?: CaptionTimingEvidence;
	remainingAudioUs?: number;
	remainingWindowCount?: number;
	remainingTextChars?: number;
};
const policy = CAPTION_ALIGNMENT_POLICY.focus;
function invalid(): never {
	throw new MediaOperationError("CAPTION_ALIGNMENT_INPUT_INVALID");
}
const lexical = (text: string) =>
	Array.from(text)
		.filter((c) => /[\p{L}\p{N}']/u.test(c))
		.join("");
function chars(text: string) {
	let offset = 0;
	return Array.from(text).flatMap((c) => {
		const start = offset;
		offset += c.length;
		return lexical(c) ? [{ text: c, start, end: offset }] : [];
	});
}
function merged(ranges: readonly Range[]) {
	const out: Range[] = [];
	for (const r of [...ranges].sort((a, b) => a.startUs - b.startUs)) {
		const last = out.at(-1);
		if (last && r.startUs <= last.endUs)
			last.endUs = Math.max(last.endUs, r.endUs);
		else out.push({ ...r });
	}
	return out;
}
const contains = (r: Range, w: Range) =>
	r.startUs <= w.startUs && w.endUs <= r.endUs;
function firstAfter(intervals: readonly Range[], start: number) {
	let a = 0,
		b = intervals.length;
	while (a < b) {
		const mid = (a + b) >>> 1;
		if ((intervals[mid]?.endUs ?? 0) <= start) a = mid + 1;
		else b = mid;
	}
	return a;
}
function supportIndex(intervals: readonly Range[], w: Range) {
	const i = firstAfter(intervals, w.startUs);
	return intervals[i] && contains(intervals[i], w) ? i : -1;
}
function longGap(intervals: readonly Range[], w: Range) {
	let cursor = w.startUs,
		gap = 0,
		count = 0;
	for (let i = firstAfter(intervals, w.startUs); i < intervals.length; i++) {
		const r = intervals[i];
		if (!r || r.startUs >= w.endUs) break;
		const a = Math.max(w.startUs, r.startUs),
			b = Math.min(w.endUs, r.endUs);
		gap = Math.max(gap, a - cursor);
		cursor = Math.max(cursor, b);
		count++;
	}
	return count >= 2 && Math.max(gap, w.endUs - cursor) >= policy.longGapUs;
}
function focusBounds(
	target: Range,
	islandIndex: number,
	intervals: readonly Range[],
	run: Range,
	source: Range,
) {
	const island = intervals[islandIndex];
	if (!island || !contains(run, island) || !contains(source, island)) return;
	const startUs = Math.max(
		source.startUs,
		run.startUs,
		intervals[islandIndex - 1]?.endUs ?? 0,
		target.startUs - policy.contextUs,
	);
	const endUs = Math.min(
		source.endUs,
		run.endUs,
		intervals[islandIndex + 1]?.startUs ?? source.endUs,
		target.endUs + policy.contextUs,
	);
	if (
		endUs <= startUs ||
		endUs - startUs > policy.maxWindowUs ||
		!contains({ startUs, endUs }, target)
	)
		return;
	return { startUs, endUs };
}
export function planCaptionAlignmentFocus(input: PlanningInput) {
	if (!input.captionTimingEvidence)
		return { candidates: [] as CaptionFocusCandidate[], evidence: undefined };
	const parsed = captionTimingEvidenceSchema.safeParse(
		input.captionTimingEvidence,
	);
	if (!parsed.success) invalid();
	const e = parsed.data;
	if (
		e.mediaSha256 !== input.mediaSha256 ||
		e.qualityPolicyFingerprint !== TRANSCRIPTION_POLICY_FINGERPRINT ||
		!Object.values(profiles).some((p) => p.sha256 === e.modelSha256)
	)
		invalid();
	const source = {
		startUs: input.sourceOriginUs,
		endUs: input.sourceOriginUs + input.sourceDurationUs,
	};
	let prior = source.startUs;
	for (const r of e.speechIntervals) {
		if (r.startUs < prior || !contains(source, r)) invalid();
		prior = r.endUs;
	}
	const runs = merged(input.selectedRanges),
		buckets = runs.map(() => [] as CaptionFocusCandidate[]);
	const rawByKey = new Map<
		string,
		{ index: number; raw: (typeof e.rawSegments)[number] }[]
	>();
	for (const [index, raw] of e.rawSegments.entries()) {
		const key = JSON.stringify([raw.startUs, raw.endUs, raw.text]);
		const list = rawByKey.get(key) ?? [];
		list.push({ index, raw });
		rawByKey.set(key, list);
	}
	for (const [segmentIndex, segment] of input.segments.entries()) {
		if (segment.words?.length) continue;
		if (
			!runs.some((r) => r.startUs < segment.endUs && segment.startUs < r.endUs)
		)
			continue;
		const entries = rawByKey.get(
			JSON.stringify([segment.startUs, segment.endUs, segment.text]),
		);
		if (entries?.length !== 1) continue;
		const entry = entries[0];
		if (entry?.raw.quality.decision !== "ADMITTED") continue;
		const projected = chars(segment.text);
		let cursor = 0,
			valid = true;
		const tokens: {
			startChar: number;
			endChar: number;
			rawIndex: number;
			text: string;
			p: number;
			startUs: number;
			endUs: number;
			island: number;
		}[] = [];
		for (const [rawIndex, t] of (entry.raw.tokens ?? []).entries()) {
			if (/^\[(?:_|\|).*\]$/.test(t.text)) continue;
			const part = Array.from(lexical(t.text));
			const span = projected.slice(cursor, cursor + part.length);
			cursor += part.length;
			if (
				span.length !== part.length ||
				span.some((c, i) => c.text !== part[i]) ||
				t.text.includes("\ufffd")
			) {
				valid = false;
				break;
			}
			if (!part.length) continue;
			const first = span[0],
				last = span.at(-1);
			if (!first || !last) {
				valid = false;
				break;
			}
			if (
				t.startUs === undefined ||
				t.endUs === undefined ||
				t.endUs <= t.startUs ||
				t.startUs < segment.startUs ||
				t.endUs > segment.endUs
			)
				continue;
			tokens.push({
				startChar: first.start,
				endChar: last.end,
				rawIndex,
				text: segment.text.slice(first.start, last.end),
				p: t.p,
				startUs: t.startUs,
				endUs: t.endUs,
				island: supportIndex(e.speechIntervals, {
					startUs: t.startUs,
					endUs: t.endUs,
				}),
			});
		}
		if (!valid || cursor !== projected.length) continue;
		for (const t of tokens) {
			const runIndex = runs.findIndex((r) => contains(r, t));
			const run = runs[runIndex];
			if (
				!run ||
				tokens.some(
					(other) =>
						other.rawIndex !== t.rawIndex &&
						other.startUs < t.endUs &&
						t.startUs < other.endUs,
				) ||
				t.p < policy.minProbability ||
				t.text.length > policy.maxChars ||
				!longGap(e.speechIntervals, t)
			)
				continue;
			// A whole BPE token may not be split into guessed audible words.
			if (
				typeof Intl.Segmenter !== "function" ||
				[
					...new Intl.Segmenter(
						input.language === "auto" ? "ja" : input.language,
						{ granularity: "word" },
					).segment(t.text),
				].filter((w) => w.isWordLike).length !== 1
			)
				continue;
			const islandIndex = e.speechIntervals.findIndex(
				(r) => r.startUs < t.endUs && t.endUs <= r.endUs,
			);
			const island = e.speechIntervals[islandIndex];
			if (!island) continue;
			const bounds = focusBounds(
				island,
				islandIndex,
				e.speechIntervals,
				run,
				source,
			);
			if (!bounds) continue;
			buckets[runIndex]?.push({
				...bounds,
				id: "",
				kind: "TOKEN_END_ISLAND",
				segmentIndex,
				startChar: t.startChar,
				endChar: t.endChar,
				rawSegmentIndex: entry.index,
				rawTokenIndices: [t.rawIndex],
				rawStartUs: t.startUs,
				rawEndUs: t.endUs,
				text: t.text,
				island: { ...island },
			});
		}
		// Only a complete trailing raw-token phrase is eligible, never a paragraph
		// whose initial token crossed a separate speech island.
		const suffix: typeof tokens = [];
		const last = tokens.at(-1);
		if (!last || last.island < 0) continue;
		let previousStart = Number.MAX_SAFE_INTEGER;
		for (
			let i = tokens.length - 1;
			i >= 0 && suffix.length < policy.maxRawTokens;
			i--
		) {
			const t = tokens[i];
			if (
				!t ||
				t.island !== last.island ||
				t.p < policy.minProbability ||
				t.endUs > previousStart
			)
				break;
			suffix.unshift(t);
			previousStart = t.startUs;
		}
		const first = suffix[0];
		if (
			!first ||
			suffix.length < 2 ||
			lexical(segment.text.slice(last.endChar)) ||
			last.endChar - first.startChar > policy.maxChars
		)
			continue;
		if (
			suffix.some(
				(t, i) =>
					i > 0 &&
					lexical(segment.text.slice(suffix[i - 1]?.endChar ?? 0, t.startChar)),
			)
		)
			continue;
		const span = { startUs: first.startUs, endUs: last.endUs };
		if (
			tokens.some(
				(t) =>
					!suffix.includes(t) &&
					t.startUs < span.endUs &&
					span.startUs < t.endUs,
			)
		)
			continue;
		const runIndex = runs.findIndex((r) => contains(r, span));
		const run = runs[runIndex];
		const island = e.speechIntervals[last.island];
		if (!run || !island) continue;
		const bounds = focusBounds(
			span,
			last.island,
			e.speechIntervals,
			run,
			source,
		);
		if (!bounds) continue;
		buckets[runIndex]?.push({
			...bounds,
			id: "",
			kind: "SUPPORTED_SUFFIX",
			segmentIndex,
			startChar: first.startChar,
			endChar: last.endChar,
			rawSegmentIndex: entry.index,
			rawTokenIndices: suffix.map((t) => t.rawIndex),
			rawStartUs: first.startUs,
			rawEndUs: last.endUs,
			text: segment.text.slice(first.startChar, last.endChar),
			island: { ...island },
		});
	}
	for (const bucket of buckets)
		bucket.sort(
			(a, b) =>
				(a.kind === b.kind ? 0 : a.kind === "TOKEN_END_ISLAND" ? -1 : 1) ||
				a.segmentIndex - b.segmentIndex ||
				a.startChar - b.startChar,
		);
	const candidates: CaptionFocusCandidate[] = [];
	let audio = 0,
		textChars = 0;
	const limit = Math.min(
			policy.maxCandidates,
			input.remainingWindowCount ?? policy.maxCandidates,
		),
		audioLimit = input.remainingAudioUs ?? CAPTION_ALIGNMENT_POLICY.maxAudioUs;
	while (candidates.length < limit && buckets.some((b) => b.length))
		for (const bucket of buckets) {
			const c = bucket.shift();
			if (!c) continue;
			const duration = c.endUs - c.startUs;
			if (
				audio + duration > audioLimit ||
				textChars + c.text.length > (input.remainingTextChars ?? 200000)
			)
				continue;
			textChars += c.text.length;
			audio += duration;
			candidates.push({ ...c, id: `f${candidates.length}` });
			if (candidates.length === limit) break;
		}
	return {
		candidates,
		evidence: {
			sourceTimeDomain: e.sourceTimeDomain,
			mediaSha256: e.mediaSha256,
			modelSha256: e.modelSha256,
			qualityPolicyFingerprint: e.qualityPolicyFingerprint,
			transcriptHash: e.transcriptHash,
			rawSegmentsHash: hashEditingEvidence(e.rawSegments),
			speechIntervalsHash: hashEditingEvidence(e.speechIntervals),
		},
	};
}
function degenerate(words: readonly Word[]) {
	return words.some((w, i) => {
		const d = w.endUs - w.startUs;
		return (
			d <= policy.shortWordMaxUs &&
			[words[i - 1], words[i + 1]].some(
				(n) =>
					n &&
					n.endUs - n.startUs >=
						Math.max(
							policy.adjacentLongMinUs,
							d * policy.adjacentDurationRatio,
						),
			)
		);
	});
}
function rawSupportedGroup(
	c: CaptionFocusCandidate,
	original: CompositionSourceSegment,
	input: {
		captionTimingEvidence?: CaptionTimingEvidence;
		evidence?: ReturnType<typeof planCaptionAlignmentFocus>["evidence"];
		selectedRanges: readonly Range[];
	},
): Word | undefined {
	if (
		c.kind !== "SUPPORTED_SUFFIX" ||
		original.words?.length ||
		!input.captionTimingEvidence ||
		!input.evidence
	)
		return;
	const checked = captionTimingEvidenceSchema.safeParse(
		input.captionTimingEvidence,
	);
	if (!checked.success) return;
	const e = checked.data,
		p = input.evidence;
	if (
		e.sourceTimeDomain !== p.sourceTimeDomain ||
		e.mediaSha256 !== p.mediaSha256 ||
		e.modelSha256 !== p.modelSha256 ||
		e.qualityPolicyFingerprint !== p.qualityPolicyFingerprint ||
		e.transcriptHash !== p.transcriptHash ||
		hashEditingEvidence(e.rawSegments) !== p.rawSegmentsHash ||
		hashEditingEvidence(e.speechIntervals) !== p.speechIntervalsHash
	)
		return;
	const raw = e.rawSegments[c.rawSegmentIndex];
	if (
		raw?.quality.decision !== "ADMITTED" ||
		raw.text !== original.text ||
		raw.startUs !== original.startUs ||
		raw.endUs !== original.endUs
	)
		return;
	const projected = chars(original.text),
		chosen: {
			rawIndex: number;
			startChar: number;
			endChar: number;
			startUs: number;
			endUs: number;
		}[] = [];
	let cursor = 0,
		prior = -1;
	for (const [rawIndex, t] of (raw.tokens ?? []).entries()) {
		if (/^\[(?:_|\|).*\]$/.test(t.text)) continue;
		const part = Array.from(lexical(t.text)),
			span = projected.slice(cursor, cursor + part.length);
		cursor += part.length;
		if (
			span.length !== part.length ||
			span.some((x, i) => x.text !== part[i]) ||
			t.text.includes("\ufffd")
		)
			return;
		const first = span[0],
			last = span.at(-1);
		if (!first || !last) continue;
		if (last.end <= c.startChar || first.start >= c.endChar) continue;
		if (
			first.start < c.startChar ||
			last.end > c.endChar ||
			!c.rawTokenIndices.includes(rawIndex) ||
			t.p < policy.minProbability ||
			t.startUs === undefined ||
			t.endUs === undefined ||
			t.endUs <= t.startUs ||
			t.startUs < prior ||
			!contains(c.island, { startUs: t.startUs, endUs: t.endUs })
		)
			return;
		chosen.push({
			rawIndex,
			startChar: first.start,
			endChar: last.end,
			startUs: t.startUs,
			endUs: t.endUs,
		});
		prior = t.endUs;
	}
	const first = chosen[0],
		last = chosen.at(-1);
	if (
		cursor !== projected.length ||
		chosen.length !== c.rawTokenIndices.length ||
		chosen.length < 2 ||
		!first ||
		!last ||
		first.startChar !== c.startChar ||
		last.endChar !== c.endChar ||
		first.startUs !== c.rawStartUs ||
		last.endUs !== c.rawEndUs ||
		!contains(original, { startUs: first.startUs, endUs: last.endUs }) ||
		!merged(input.selectedRanges).some((r) =>
			contains(r, { startUs: first.startUs, endUs: last.endUs }),
		)
	)
		return;
	const island = supportIndex(e.speechIntervals, {
		startUs: first.startUs,
		endUs: last.endUs,
	});
	if (
		island < 0 ||
		e.speechIntervals[island]?.startUs !== c.island.startUs ||
		e.speechIntervals[island]?.endUs !== c.island.endUs
	)
		return;
	return {
		text: original.text.slice(c.startChar, c.endChar),
		startChar: c.startChar,
		endChar: c.endChar,
		startUs: first.startUs,
		endUs: last.endUs,
		confidence: 0,
	};
}
export function applyCaptionAlignmentFocus(input: {
	segments: readonly CompositionSourceSegment[];
	base: Map<number, CompositionSourceSegment>;
	candidates: readonly CaptionFocusCandidate[];
	focused: Map<string, Word[]>;
	selectedRanges: readonly Range[];
	captionTimingEvidence?: CaptionTimingEvidence;
	evidence?: ReturnType<typeof planCaptionAlignmentFocus>["evidence"];
}) {
	const aligned = new Map(
			[...input.base].map(([i, s]) => [i, structuredClone(s)]),
		),
		runs = merged(input.selectedRanges);
	const outcomes: {
		id: string;
		outcome:
			| "ADOPTED"
			| "ANOMALY_NOT_CONFIRMED"
			| "ZERO_OR_UNSUPPORTED"
			| "CONFLICT"
			| "RAW_SUPPORTED_GROUP";
	}[] = [];
	for (const c of input.candidates) {
		const target = aligned.get(c.segmentIndex),
			original = input.segments[c.segmentIndex];
		const words = target?.words ?? [];
		const covered = words.filter(
			(w) => w.endChar > c.startChar && w.startChar < c.endChar,
		);
		const exact =
			covered.length > 0 &&
			covered[0]?.startChar === c.startChar &&
			covered.at(-1)?.endChar === c.endChar &&
			lexical(covered.map((w) => w.text).join("")) === lexical(c.text);
		const anomaly =
			exact &&
			(c.kind === "TOKEN_END_ISLAND"
				? covered.some((w) => !runs.some((r) => contains(r, w)))
				: covered.length >= 2 && degenerate(covered));
		if (!target || !original || target.text !== original.text || !anomaly) {
			outcomes.push({ id: c.id, outcome: "ANOMALY_NOT_CONFIRMED" });
			continue;
		}
		const focus = input.focused.get(c.id) ?? [];
		let previousEnd = -1,
			previousChar = c.startChar;
		let usable = focus.length > 0;
		for (const w of focus) {
			if (
				w.endUs <= w.startUs ||
				w.startUs < previousEnd ||
				w.startChar < previousChar ||
				w.startChar < c.startChar ||
				w.endChar > c.endChar ||
				w.text !== original.text.slice(w.startChar, w.endChar) ||
				!contains(c, w) ||
				!contains(c.island, w) ||
				!runs.some((r) => contains(r, w))
			)
				usable = false;
			previousEnd = w.endUs;
			previousChar = w.endChar;
		}
		if (
			!usable ||
			focus[0]?.startChar !== c.startChar ||
			focus.at(-1)?.endChar !== c.endChar ||
			lexical(focus.map((w) => w.text).join("")) !== lexical(c.text)
		) {
			outcomes.push({ id: c.id, outcome: "ZERO_OR_UNSUPPORTED" });
			continue;
		}
		let replacement = focus,
			outcome: "ADOPTED" | "RAW_SUPPORTED_GROUP" = "ADOPTED";
		if (c.kind === "SUPPORTED_SUFFIX") {
			const short = covered.filter(
				(w, i) =>
					w.endUs - w.startUs <= policy.shortWordMaxUs &&
					[covered[i - 1], covered[i + 1]].some(
						(n) =>
							n &&
							n.endUs - n.startUs >=
								Math.max(
									policy.adjacentLongMinUs,
									(w.endUs - w.startUs) * policy.adjacentDurationRatio,
								),
					),
			);
			const unresolved = short.some((w) => {
				const match = focus.filter(
					(f) => f.endChar > w.startChar && f.startChar < w.endChar,
				);
				return (
					match[0]?.startChar !== w.startChar ||
					match.at(-1)?.endChar !== w.endChar ||
					(match.at(-1)?.endUs ?? 0) - (match[0]?.startUs ?? 0) <=
						policy.shortWordMaxUs
				);
			});
			if (unresolved || degenerate(focus)) {
				const raw = rawSupportedGroup(c, original, input);
				if (!raw) {
					outcomes.push({ id: c.id, outcome: "ZERO_OR_UNSUPPORTED" });
					continue;
				}
				replacement = [raw];
				outcome = "RAW_SUPPORTED_GROUP";
			}
		}
		const first = replacement[0],
			last = replacement.at(-1);
		if (!first || !last) invalid();
		const outside = words.filter((w) => !covered.includes(w));
		let conflict = false;
		for (const [index, s] of aligned)
			for (const w of s.words ?? []) {
				if (index === c.segmentIndex && covered.includes(w)) continue;
				if (
					index < c.segmentIndex ||
					(index === c.segmentIndex && w.endChar <= c.startChar)
				) {
					if (w.endUs > first.startUs) conflict = true;
				} else if (
					index > c.segmentIndex ||
					(index === c.segmentIndex && w.startChar >= c.endChar)
				) {
					if (w.startUs < last.endUs) conflict = true;
				} else conflict = true;
			}
		if (conflict) {
			outcomes.push({ id: c.id, outcome: "CONFLICT" });
			continue;
		}
		const next = [
			...outside,
			...replacement.map((w) => ({ ...w, confidence: 0 })),
		].sort((a, b) => a.startChar - b.startChar);
		const a = next[0],
			b = next.at(-1);
		if (!a || !b) invalid();
		aligned.set(c.segmentIndex, {
			...target,
			startUs: a.startUs,
			endUs: b.endUs,
			words: next,
		});
		outcomes.push({ id: c.id, outcome });
	}
	return { aligned, outcomes };
}
