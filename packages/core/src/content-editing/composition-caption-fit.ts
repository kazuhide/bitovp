/** Conservative Noto Sans CJK JP layout estimate, not a font-shaping measurement. */
export const COMPOSITION_CAPTION_LINE_HEIGHT = 1.15;
export const COMPOSITION_CAPTION_LAYOUT_POLICY = "caption-ja-orphan-word-v1";
const lineStartProhibited =
	/^[\p{Pe}\p{Pf}、。，．,.!?！？:;：；…‥％%ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ\u31f0-\u31ffｧｨｩｪｫｯｬｭｮーｰ々〻ゝゞヽヾ・･]/u;
const lineEndProhibited = /^[\p{Ps}\p{Pi}]/u;
const space = (value: string) =>
	/^\s+$/u.test(value) && !/[\u00a0\u202f\ufeff]/u.test(value);
function glyphEm(value: string): number {
	if (value === "\t") return 1.6;
	if (space(value)) return 0.4;
	// Deliberately overestimate narrow Latin glyphs; CJK and unknown glyphs
	// get more than one em. Combining/emoji sequences may be overestimated.
	return /^[\x20-\x7e]$/.test(value) && !/[@MW%&]/.test(value) ? 1 : 1.1;
}

type CaptionLayoutInput = { text: string; width: number; fontSizePx: number };
const graphemeSegmenter =
	typeof Intl.Segmenter === "function"
		? new Intl.Segmenter(undefined, { granularity: "grapheme" })
		: null;
const japaneseWordSegmenter = (() => {
	try {
		return graphemeSegmenter
			? new Intl.Segmenter("ja", { granularity: "word" })
			: null;
	} catch {
		return null;
	}
})();
function fallbackGraphemes(text: string) {
	const segments: { segment: string; index: number }[] = [];
	let index = 0;
	for (const point of text) {
		const previous = segments[segments.length - 1];
		if (
			previous &&
			(/^(?:\p{Mark}|\uFE0E|\uFE0F|\u200d|\p{Emoji_Modifier})$/u.test(point) ||
				previous.segment.endsWith("\u200d") ||
				(/^\p{Regional_Indicator}$/u.test(previous.segment) &&
					/^\p{Regional_Indicator}$/u.test(point)))
		)
			previous.segment += point;
		else segments.push({ segment: point, index });
		index += point.length;
	}
	return segments;
}
function captionRowsWithWidths(input: CaptionLayoutInput) {
	const size = Math.max(1, Math.round(input.fontSizePx));
	const available = Math.max(1, input.width - size * 0.16);
	const rows: { text: string; offset: number; estimatedWidth: number }[] = [];
	if (!input.text) return rows;
	const paragraphs: { text: string; offset: number }[] = [];
	let paragraphStart = 0;
	for (const delimiter of input.text.matchAll(/\r\n|\r|\n/g)) {
		paragraphs.push({
			text: input.text.slice(paragraphStart, delimiter.index),
			offset: paragraphStart,
		});
		paragraphStart = delimiter.index + delimiter[0].length;
	}
	paragraphs.push({
		text: input.text.slice(paragraphStart),
		offset: paragraphStart,
	});
	for (const paragraph of paragraphs) {
		const segments = graphemeSegmenter
			? [...graphemeSegmenter.segment(paragraph.text)]
			: fallbackGraphemes(paragraph.text);
		const chars = segments.map((s) => s.segment),
			prefix = [0];
		const index = (at: number) => segments[at]?.index ?? paragraph.text.length;
		for (const grapheme of chars) {
			let value = prefix[prefix.length - 1] ?? 0;
			for (const point of grapheme) value += glyphEm(point) * size;
			prefix.push(value);
		}
		const width = (start: number, end: number) =>
			(prefix[end] ?? 0) - (prefix[start] ?? 0);
		if (!chars.length) {
			rows.push({ text: "", offset: paragraph.offset, estimatedWidth: 0 });
			continue;
		}
		let start = 0;
		const canBreak = (at: number, lowerBound = start) => {
			let previous = at - 1,
				next = at;
			while (previous >= lowerBound && space(chars[previous] ?? "")) previous--;
			while (next < chars.length && space(chars[next] ?? "")) next++;
			return (
				!lineEndProhibited.test(chars[previous] ?? "") &&
				!lineStartProhibited.test(chars[next] ?? "")
			);
		};
		while (start < chars.length) {
			let end = start,
				spaceBreak = start;
			while (end < chars.length) {
				if (end > start && width(start, end + 1) > available) break;
				if (space(chars[end] ?? "")) spaceBreak = end + 1;
				end++;
			}
			if (end < chars.length) {
				if (spaceBreak > start && !space(chars[end] ?? "")) end = spaceBreak;
				let before = end;
				while (before > start + 1 && !canBreak(before)) before--;
				if (before < end && canBreak(before)) {
					let after = before + 1;
					while (after < chars.length && !canBreak(after)) after++;
					// Move the complete opening/content/nonstarter group together.
					// If it cannot fit, keep the width-first grapheme fallback.
					if (width(before, after) <= available) end = before;
				}
			}
			let visibleEnd = end;
			while (visibleEnd > start && space(chars[visibleEnd - 1] ?? ""))
				visibleEnd--;
			rows.push({
				text: paragraph.text.slice(index(start), index(visibleEnd)),
				offset: paragraph.offset + index(start),
				estimatedWidth: width(start, visibleEnd) + size * 0.16,
			});
			start = end;
			while (start < chars.length && space(chars[start] ?? "")) start++;
		}
		const first = rows[0],
			last = rows[1];
		// Restrict word balancing to a short Japanese orphan. Explicit newlines,
		// other row counts and ZWJ sequences retain the existing greedy policy.
		if (
			paragraphs.length === 1 &&
			rows.length === 2 &&
			first &&
			last &&
			japaneseWordSegmenter &&
			/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
				paragraph.text,
			) &&
			!paragraph.text.includes("\u200d")
		) {
			const boundaries = new Map(
				segments.map((segment, i) => [segment.index, i]),
			);
			const tailStart = boundaries.get(last.offset - paragraph.offset);
			let visibleEnd = chars.length;
			while (visibleEnd > 0 && space(chars[visibleEnd - 1] ?? "")) visibleEnd--;
			if (
				tailStart !== undefined &&
				visibleEnd - tailStart >= 1 &&
				visibleEnd - tailStart <= 2
			) {
				let best = Math.abs(first.estimatedWidth - last.estimatedWidth);
				for (const word of japaneseWordSegmenter.segment(paragraph.text)) {
					const at = boundaries.get(word.index);
					if (at === undefined || at >= tailStart || !canBreak(at, 0)) continue;
					let leftEnd = at,
						rightStart = at,
						leftStart = 0;
					while (leftEnd > 0 && space(chars[leftEnd - 1] ?? "")) leftEnd--;
					while (rightStart < visibleEnd && space(chars[rightStart] ?? ""))
						rightStart++;
					while (leftStart < leftEnd && space(chars[leftStart] ?? ""))
						leftStart++;
					if (leftEnd - leftStart < 3 || visibleEnd - rightStart < 3) continue;
					const leftWidth = width(0, leftEnd),
						rightWidth = width(rightStart, visibleEnd);
					if (leftWidth > available || rightWidth > available) continue;
					const score = Math.abs(leftWidth - rightWidth);
					if (score >= best) continue;
					best = score;
					rows[0] = {
						text: paragraph.text.slice(0, index(leftEnd)),
						offset: paragraph.offset,
						estimatedWidth: leftWidth + size * 0.16,
					};
					rows[1] = {
						text: paragraph.text.slice(index(rightStart), index(visibleEnd)),
						offset: paragraph.offset + index(rightStart),
						estimatedWidth: rightWidth + size * 0.16,
					};
				}
			}
		}
	}
	return rows;
}

/** Drawing rows only: every text is an exact source substring at a UTF-16 offset.
 * Soft-wrap separator whitespace is omitted as in Canvas. Stored cues are untouched.
 */
export function compositionCaptionRows(
	input: CaptionLayoutInput,
): { text: string; offset: number }[] {
	return captionRowsWithWidths(input).map(({ text, offset }) => ({
		text,
		offset,
	}));
}

export function estimateCompositionCaptionLayout(input: CaptionLayoutInput) {
	const size = Math.max(1, Math.round(input.fontSizePx));
	const rows = captionRowsWithWidths(input),
		lines = rows.length;
	if (!lines) return { lines: 0, width: 0, height: 0 };
	// Reserve more line height than Canvas (1.15 em), plus outline headroom.
	return {
		lines,
		width: Math.max(...rows.map((row) => row.estimatedWidth)),
		height: (lines * 1.5 + 0.16) * size,
	};
}

/** User font size is an upper bound; only the evaluated caption style shrinks. */
export function fitCompositionCaptionFontSize(input: {
	text: string;
	rect: { w: number; h: number };
	canvasHeight: number;
	fontSize: number;
}): number {
	if (
		![input.rect.w, input.rect.h, input.canvasHeight, input.fontSize].every(
			(v) => Number.isFinite(v) && v > 0,
		)
	)
		throw new RangeError("Invalid caption fit geometry");
	const fits = (size: number) => {
		const layout = estimateCompositionCaptionLayout({
			text: input.text,
			width: input.rect.w,
			fontSizePx: size,
		});
		return layout.width <= input.rect.w && layout.height <= input.rect.h;
	};
	const maximum = Math.max(1, Math.round(input.fontSize * input.canvasHeight));
	if (fits(maximum)) return input.fontSize;
	let low = 1,
		high = maximum - 1,
		best = 1;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		if (fits(middle)) {
			best = middle;
			low = middle + 1;
		} else high = middle - 1;
	}
	// One pixel is the renderers' minimum. Extremely small rectangles or
	// hundreds of explicit newlines can still overflow at that physical limit.
	return Math.min(input.fontSize, best / input.canvasHeight);
}
