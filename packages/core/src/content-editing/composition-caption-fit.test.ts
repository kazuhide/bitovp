import { describe, expect, it, vi } from "vitest";
import {
	compositionCaptionRows,
	estimateCompositionCaptionLayout,
	fitCompositionCaptionFontSize,
} from "./composition-caption-fit";

const nativeJapanese =
	"トム、シリア、我々は情熱に従わなきゃ。お前はロボティクス、私は宇宙で最高になりたいんだ";
const rect = { w: 972, h: 326 };
describe("explicit caption rows retain original UTF-16 coordinates", () => {
	it("moves a Japanese two-grapheme orphan to a balanced word boundary without changing text or style", () => {
		const text = "あれ俺のお守りあらへんで";
		const input = { text, width: 972, fontSizePx: 86 },
			before = structuredClone(input);
		const rows = compositionCaptionRows(input);
		expect(rows).toEqual([
			{ text: "あれ俺のお守り", offset: 0 },
			{ text: "あらへんで", offset: 7 },
		]);
		expect(rows.map((row) => row.text).join("")).toBe(text);
		expect(
			rows.map((row) => text.slice(row.offset, row.offset + row.text.length)),
		).toEqual(rows.map((row) => row.text));
		expect(estimateCompositionCaptionLayout(input).width).toBeLessThanOrEqual(
			input.width,
		);
		expect(
			fitCompositionCaptionFontSize({
				text,
				rect,
				canvasHeight: 1920,
				fontSize: 0.045,
			}),
		).toBe(0.045);
		const emphasis = { startChar: 7, endChar: 12 },
			second = rows[1];
		if (!second) throw new Error("second row");
		expect(
			second.text.slice(
				emphasis.startChar - second.offset,
				emphasis.endChar - second.offset,
			),
		).toBe(text.slice(emphasis.startChar, emphasis.endChar));
		expect(input).toEqual(before);
	});
	it("keeps English, explicit newlines, and a three-row Japanese caption on their existing wraps", () => {
		expect(
			compositionCaptionRows({
				text: "あいうえお",
				width: 46,
				fontSizePx: 10,
			}).map((row) => row.text),
		).toEqual(["あいうえ", "お"]);
		expect(
			compositionCaptionRows({
				text: "abcdefghijklm",
				width: 972,
				fontSizePx: 86,
			}).map((row) => row.text),
		).toEqual(["abcdefghijk", "lm"]);
		expect(
			compositionCaptionRows({
				text: "あれ俺のお守りあらへ\nんで",
				width: 972,
				fontSizePx: 86,
			}),
		).toEqual([
			{ text: "あれ俺のお守りあらへ", offset: 0 },
			{ text: "んで", offset: 11 },
		]);
		expect(
			compositionCaptionRows({
				text: "あれ俺のお守りあらへんで".repeat(2),
				width: 972,
				fontSizePx: 86,
			}).map((row) => row.text),
		).toEqual(["あれ俺のお守りあらへ", "んであれ俺のお守りあ", "らへんで"]);
	});
	it("keeps actual UTF-16 source coordinates when an orphan moves after a non-BMP grapheme", () => {
		const text = "🙂あれ俺のお守りあらへんで";
		const rows = compositionCaptionRows({ text, width: 1070, fontSizePx: 86 });
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.text).join("")).toBe(text);
		for (const row of rows)
			expect(text.slice(row.offset, row.offset + row.text.length)).toBe(
				row.text,
			);
		const range = {
			startChar: text.indexOf("あらへんで"),
			endChar: text.length,
		};
		const row = rows.find((row) => row.text.includes("あらへんで"));
		if (!row) throw new Error("word row");
		expect(
			row.text.slice(range.startChar - row.offset, range.endChar - row.offset),
		).toBe("あらへんで");
	});
	it("preserves the existing ZWJ emoji wrap even beside a Japanese orphan", () => {
		const text = "あれ俺の👩‍👩‍👧‍👦お守りあらへんで";
		const rows = compositionCaptionRows({ text, width: 205, fontSizePx: 10 });
		expect(rows.map((row) => row.text)).toEqual([
			"あれ俺の👩‍👩‍👧‍👦お守りあらへん",
			"で",
		]);
		expect(
			rows.map((row) => text.slice(row.offset, row.offset + row.text.length)),
		).toEqual(rows.map((row) => row.text));
	});
	it("uses the existing greedy rows when Intl.Segmenter is unavailable", async () => {
		vi.resetModules();
		vi.stubGlobal("Intl", { Segmenter: undefined });
		try {
			const fallback = await import("./composition-caption-fit");
			expect(
				fallback.compositionCaptionRows({
					text: "あれ俺のお守りあらへんで",
					width: 972,
					fontSizePx: 86,
				}),
			).toEqual([
				{ text: "あれ俺のお守りあらへ", offset: 0 },
				{ text: "んで", offset: 10 },
			]);
		} finally {
			vi.unstubAllGlobals();
			vi.resetModules();
		}
	});
	it("keeps CRLF, CR, LF and empty-line offsets on the unmodified source", () => {
		expect(
			compositionCaptionRows({
				text: "A\r\n\rB\n\nC\r",
				width: 1000,
				fontSizePx: 10,
			}),
		).toEqual([
			{ text: "A", offset: 0 },
			{ text: "", offset: 3 },
			{ text: "B", offset: 4 },
			{ text: "", offset: 6 },
			{ text: "C", offset: 7 },
			{ text: "", offset: 9 },
		]);
	});
	it("preserves source offsets across soft-wrap whitespace and long-word breaks", () => {
		expect(
			compositionCaptionRows({
				text: "  Hello   world  ",
				width: 65,
				fontSizePx: 10,
			}),
		).toEqual([
			{ text: "  Hello", offset: 0 },
			{ text: "world", offset: 10 },
		]);
		expect(
			compositionCaptionRows({
				text: "😀 abcdefghijkl",
				width: 35,
				fontSizePx: 10,
			}),
		).toEqual([
			{ text: "😀", offset: 0 },
			{ text: "abc", offset: 3 },
			{ text: "def", offset: 6 },
			{ text: "ghi", offset: 9 },
			{ text: "jkl", offset: 12 },
		]);
	});
	it("keeps common emoji and combining graphemes intact without changing their UTF-16 offsets", () => {
		const text = "👩‍👩‍👧‍👦🇯🇵e\u0301";
		const rows = compositionCaptionRows({ text, width: 20, fontSizePx: 10 });
		expect(rows.map((row) => row.text)).toEqual(["👩‍👩‍👧‍👦", "🇯🇵", "e\u0301"]);
		expect(
			rows.map((row) => text.slice(row.offset, row.offset + row.text.length)),
		).toEqual(rows.map((row) => row.text));
	});
	it.each([
		["一緒に踊っちゃおう", ["一緒に", "踊っちゃ", "おう"]],
		["映画のキャスト", ["映画の", "キャスト"]],
		["あいう文）。", ["あいう", "文）。"]],
		["あいう「えおか", ["あいう", "「えおか"]],
		["あい「『うえお", ["あい", "「『うえ", "お"]],
		["あいうえ ゃか", ["あいう", "え ゃか"]],
	])("keeps Japanese prohibited line boundaries together for %s", (text, expected) => {
		const rows = compositionCaptionRows({ text, width: 46, fontSizePx: 10 });
		expect(rows.map((row) => row.text)).toEqual(expected);
		expect(
			rows.map((row) => text.slice(row.offset, row.offset + row.text.length)),
		).toEqual(expected);
		expect(
			estimateCompositionCaptionLayout({ text, width: 46, fontSizePx: 10 })
				.width,
		).toBeLessThanOrEqual(46);
	});
	it("keeps UTF-16 emphasis coordinates after moving a Japanese break beside an emoji", () => {
		const text = "😀あいうかゃえお";
		const rows = compositionCaptionRows({ text, width: 57, fontSizePx: 10 });
		expect(rows).toEqual([
			{ text: "😀あいう", offset: 0 },
			{ text: "かゃえお", offset: 5 },
		]);
		const word = { startChar: 5, endChar: 7 },
			row = rows[1];
		if (!row) throw Error("second row");
		expect(
			row.text.slice(word.startChar - row.offset, word.endChar - row.offset),
		).toBe(text.slice(word.startChar, word.endChar));
	});
	it("keeps explicit newlines and uses width-first fallback when a prohibited group cannot fit", () => {
		expect(
			compositionCaptionRows({
				text: "あい「\nゃう",
				width: 100,
				fontSizePx: 10,
			}),
		).toEqual([
			{ text: "あい「", offset: 0 },
			{ text: "ゃう", offset: 4 },
		]);
		for (const text of ["あっゃゃ", "あ「いう"]) {
			const input = { text, width: 13, fontSizePx: 10 };
			expect(compositionCaptionRows(input).map((row) => row.text)).toEqual([
				...text,
			]);
			expect(estimateCompositionCaptionLayout(input).width).toBeLessThanOrEqual(
				13,
			);
		}
	});
	it.each([
		nativeJapanese,
		"括弧と句読点（テスト）。別の文、続きます！",
		"English words, spaces and (closing punctuation).",
	])("retains every nonseparator character and shares the fitted layout for %s", (text) => {
		const size = fitCompositionCaptionFontSize({
				text,
				rect,
				canvasHeight: 1920,
				fontSize: 0.045,
			}),
			fontSizePx = Math.round(size * 1920);
		const rows = compositionCaptionRows({ text, width: rect.w, fontSizePx });
		expect(
			rows.every(
				(row) =>
					text.slice(row.offset, row.offset + row.text.length) === row.text,
			),
		).toBe(true);
		expect(
			rows
				.map((row) => row.text)
				.join("")
				.replace(/\s/g, ""),
		).toBe(text.replace(/\s/g, ""));
		expect(
			estimateCompositionCaptionLayout({ text, width: rect.w, fontSizePx })
				.lines,
		).toBe(rows.length);
	});
	it("keeps the native Japanese fitting result and the public estimate shape compatible", () => {
		const fontSize = fitCompositionCaptionFontSize({
			text: nativeJapanese,
			rect,
			canvasHeight: 1920,
			fontSize: 0.045,
		});
		expect(Math.round(fontSize * 1920)).toBe(58);
		const input = { text: nativeJapanese, width: rect.w, fontSizePx: 58 };
		expect(
			compositionCaptionRows(input)
				.map((row) => row.text)
				.join(""),
		).toBe(nativeJapanese);
		expect(Object.keys(estimateCompositionCaptionLayout(input)).sort()).toEqual(
			["height", "lines", "width"],
		);
		expect(
			compositionCaptionRows({ text: "", width: 100, fontSizePx: 10 }),
		).toEqual([]);
	});
});
describe("caption-only font fit", () => {
	it.each([
		nativeJapanese,
		"An English subtitle with several long words should wrap inside its existing caption rectangle without removing any words. ".repeat(
			3,
		),
		"日本語の字幕を残す。\n明示的な改行も残す。\n最後の行も表示する。\n四行目も残す。",
		"LongUnbrokenEnglishSubtitleWithoutSpaces".repeat(4),
	])("fits a conservative complete-text estimate below the user size for %s", (text) => {
		const fontSize = fitCompositionCaptionFontSize({
			text,
			rect,
			canvasHeight: 1920,
			fontSize: 0.045,
		});
		const estimate = estimateCompositionCaptionLayout({
			text,
			width: rect.w,
			fontSizePx: Math.round(fontSize * 1920),
		});
		expect(fontSize).toBeGreaterThan(0);
		expect(fontSize).toBeLessThanOrEqual(0.045);
		expect(estimate.height).toBeLessThanOrEqual(rect.h);
		expect(estimate.width).toBeLessThanOrEqual(rect.w);
	});
	it("reduces the actual native first cue and leaves short captions at their configured upper bound", () => {
		expect(
			fitCompositionCaptionFontSize({
				text: nativeJapanese,
				rect,
				canvasHeight: 1920,
				fontSize: 0.045,
			}),
		).toBeLessThan(0.045);
		expect(
			fitCompositionCaptionFontSize({
				text: "こんにちは。",
				rect,
				canvasHeight: 1920,
				fontSize: 0.045,
			}),
		).toBe(0.045);
		expect(
			fitCompositionCaptionFontSize({
				text: "Hi",
				rect,
				canvasHeight: 1920,
				fontSize: 0.02,
			}),
		).toBe(0.02);
	});
	it("is deterministic for the displayed language and respects smaller output rounding", () => {
		for (const height of [640, 1920]) {
			const scaled = { w: (972 * height) / 1920, h: (326 * height) / 1920 };
			const options = {
				text: nativeJapanese,
				rect: scaled,
				canvasHeight: height,
				fontSize: 0.045,
			};
			const a = fitCompositionCaptionFontSize(options),
				b = fitCompositionCaptionFontSize(options);
			expect(a).toBe(b);
			expect(a).toBeLessThanOrEqual(options.fontSize);
			expect(
				estimateCompositionCaptionLayout({
					text: nativeJapanese,
					width: scaled.w,
					fontSizePx: Math.round(a * height),
				}).height,
			).toBeLessThanOrEqual(scaled.h);
		}
	});
});
