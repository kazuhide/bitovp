import type { CompositionFrame, CompositionTextStyle } from "@bitovp/core";
import { expect, it } from "vitest";
import { paintCompositionFrame } from "./composition-preview";

const style: CompositionTextStyle = {
	fontSize: 0.1,
	color: "#FFFFFF",
	emphasisColor: "#FFE04B",
	backgroundColor: "#000000B3",
	align: "LEFT",
};

/** Independent measured advances: a joined emoji may be wider than its partial code points. */
function measuredWidth(text: string) {
	return Array.from(text.replaceAll("👩‍🚀", "@"))
		.map((character) =>
			character === "@" ? 3 : /[\p{Mark}\u200d]/u.test(character) ? 0 : 1,
		)
		.reduce<number>((sum, width) => sum + width, 0);
}

class MeasuredCanvas {
	width = 100;
	height = 100;
	fillStyle = "black";
	globalAlpha = 1;
	globalCompositeOperation = "source-over";
	font = "";
	textBaseline = "top";
	draws: { text: string; x: number; y: number; color: string }[] = [];
	backgrounds: {
		x: number;
		y: number;
		width: number;
		height: number;
		color: string;
	}[] = [];
	save() {}
	restore() {}
	beginPath() {}
	rect() {}
	clip() {}
	fillRect(x: number, y: number, width: number, height: number) {
		this.backgrounds.push({ x, y, width, height, color: this.fillStyle });
	}
	getContext() {
		return this;
	}
	measureText(text: string) {
		return { width: measuredWidth(text) };
	}
	fillText(text: string, x: number, y: number) {
		this.draws.push({ text, x, y, color: this.fillStyle });
	}
}

function paint(
	text: string,
	width: number,
	active: { startChar: number; endChar: number }[] = [],
	align: CompositionTextStyle["align"] = "LEFT",
	target: "CAPTION" | "OVERLAY" = "CAPTION",
) {
	const output = new MeasuredCanvas();
	const state: CompositionFrame = {
		frame: 0,
		timeUs: 0,
		canvas: { width, height: 100 },
		layers: [],
		audio: [],
		overlays: [],
		captions: [
			{
				id: "77777777-7777-4777-8777-777777777777",
				fromFrame: 0,
				toFrame: 30,
				text,
				rect: { x: 0, y: 0, w: width, h: 100 },
				style: { ...style, align },
				activeWords: active.map((range) => ({
					...range,
					text: text.slice(range.startChar, range.endChar),
					fromFrame: 0,
					toFrame: 30,
				})),
			},
		],
	};
	if (target === "OVERLAY") {
		state.captions = [];
		state.overlays = [
			{
				id: "88888888-8888-4888-8888-888888888888",
				kind: "TEXT",
				text,
				fromFrame: 0,
				toFrame: 30,
				rect: { x: 0, y: 0, w: 1, h: 1 },
				pixelRect: { x: 0, y: 0, w: width, h: 100 },
				resolvedStyle: { ...style, align },
				opacity: 1,
				zIndex: 0,
			},
		];
	}
	paintCompositionFrame(
		output as unknown as CanvasRenderingContext2D,
		state,
		new Map(),
		new Map(),
		new MeasuredCanvas() as unknown as HTMLCanvasElement,
		new MeasuredCanvas() as unknown as HTMLCanvasElement,
	);
	const rows = [...new Set(output.draws.map((draw) => draw.y))].map((y) => ({
		y,
		text: output.draws
			.filter((draw) => draw.y === y)
			.map((draw) => draw.text)
			.join(""),
	}));
	return { output, rows };
}

it("wraps the real English caption at spaces instead of orphaning its question mark", () => {
	const { rows } = paint(
		"What brings you to the land of the gatekeepers?",
		230,
	);
	expect(rows.map((row) => row.text)).toEqual([
		"What brings you to the",
		"land of the gatekeepers?",
	]);
	// These shared rows use the explicit 10px font, not the fake Canvas's
	// one-unit advances. Account for its conservative Latin/space budget.
	expect(
		rows.every(
			(row) =>
				[...row.text].reduce(
					(width, point) =>
						width + (point === " " ? 4 : /[@MW%&]/.test(point) ? 11 : 10),
					1.6,
				) <= 230,
		),
	).toBe(true);
});

it.each([
	{ text: "テストです。", width: 50, expected: ["テスト", "です。"] },
	{ text: "あいうえ）」", width: 40, expected: ["あいう", "え）」"] },
])("keeps closing Japanese punctuation with preceding text: $text", ({
	text,
	width,
	expected,
}) => {
	const { rows } = paint(text, width);
	expect(rows.map((row) => row.text)).toEqual(expected);
	expect(rows.map((row) => row.text).join("")).toBe(text);
	expect(rows.every((row) => measuredWidth(row.text) <= width)).toBe(true);
});

it("keeps explicit blank lines and original UTF-16 word offsets across soft wraps", () => {
	const text = "🙂🙂 alpha\n\nbeta éclair";
	const start = text.indexOf("éclair");
	const { output, rows } = paint(text, 80, [
		{ startChar: 2, endChar: 4 },
		{ startChar: start, endChar: start + "éclair".length },
	]);
	expect(rows).toEqual([
		{ text: "🙂🙂 alpha", y: 0 },
		{ text: "beta", y: 23 },
		{ text: "éclair", y: 34.5 },
	]);
	expect(
		output.draws.filter((draw) => draw.color === style.emphasisColor),
	).toEqual([
		{ text: "🙂", x: 1, y: 0, color: style.emphasisColor },
		{ text: "éclair", x: 0, y: 34.5, color: style.emphasisColor },
	]);
});

it("falls back at grapheme boundaries and clips a single over-wide joined emoji intact", () => {
	const { rows } = paint("a👩‍🚀b éZ", 20);
	expect(rows.map((row) => row.text)).toEqual(["a", "👩‍🚀", "b", "é", "Z"]);
	expect(rows.map((row) => row.text).join("")).toBe("a👩‍🚀béZ");
});

it("keeps a measured word highlighted across fallback rows after a UTF-16 surrogate pair", () => {
	const text = "🙂abcdefghij";
	const { output } = paint(text, 40, [
		{ startChar: text.indexOf("c"), endChar: text.indexOf("h") + 1 },
	]);
	expect(
		output.draws
			.filter((draw) => draw.color === style.emphasisColor)
			.map(({ text, x, y }) => ({ text, x, y })),
	).toEqual([
		{ text: "cde", x: 0, y: 11.5 },
		{ text: "fgh", x: 0, y: 23 },
	]);
});

it("uses the same natural wrapping for text overlays and preserves their explicit newline", () => {
	const { rows } = paint("alpha beta\ngamma delta", 10, [], "LEFT", "OVERLAY");
	expect(rows).toEqual([
		{ text: "alpha beta", y: 0 },
		{ text: "gamma", y: 11.5 },
		{ text: "delta", y: 23 },
	]);
});

it("terminates for an unbreakable word and unavoidable narrow punctuation without overflow", () => {
	const text = "a".repeat(500);
	const { rows } = paint(text, 70);
	expect(rows.map((row) => row.text).join("")).toBe(text);
	expect(rows).toHaveLength(84);
	expect(rows.every((row) => measuredWidth(row.text) <= 7)).toBe(true);
	expect(paint("あ。」", 10).rows.map((row) => row.text)).toEqual([
		"あ",
		"。",
		"」",
	]);
});

it.each([
	"LEFT",
	"CENTER",
	"RIGHT",
] as const)("aligns naturally wrapped rows independently: %s", (align) => {
	const { output, rows } = paint("one two three", 70, [], align);
	expect(rows.map((row) => row.text)).toEqual(["one two", "three"]);
	expect(output.draws.at(-1)?.x).toBe(
		align === "LEFT" ? 0 : align === "RIGHT" ? 65 : 32.5,
	);
});

it("keeps blank-line spacing without painting empty caption background strips", () => {
	const { output, rows } = paint("first\n\nsecond\n", 200);
	expect(rows).toEqual([
		{ text: "first", y: 0 },
		{ text: "second", y: 23 },
	]);
	expect(
		output.backgrounds
			.filter((rect) => rect.color === style.backgroundColor)
			.map((rect) => rect.y),
	).toEqual([0, 23]);
});

it.each([
	{
		text: "あいうえおかきく。",
		expected: [
			{ text: "あいうえ", y: 0 },
			{ text: "おかきく。", y: 11.5 },
		],
	},
	{
		text: "alpha beta gamma",
		expected: [
			{ text: "alpha", y: 0 },
			{ text: "beta", y: 11.5 },
			{ text: "gamma", y: 23 },
		],
	},
	{
		text: "first\r\n\rsecond\n",
		expected: [
			{ text: "first", y: 0 },
			{ text: "second", y: 23 },
		],
	},
])("uses shared caption rows rather than Canvas-only measured wraps: $text", ({
	text,
	expected,
}) => {
	const { output, rows } = paint(text, 80);
	expect(rows).toEqual(expected);
	expect(
		output.backgrounds
			.filter((rect) => rect.color === style.backgroundColor)
			.map((rect) => rect.y),
	).toEqual(expected.map((row) => row.y));
});

it("uses the shared balanced Japanese orphan rows and moves whole-word emphasis with its source offset", () => {
	const text = "あれ俺のお守りあらへんで";
	const { output, rows } = paint(text, 113, [{ startChar: 7, endChar: 12 }]);
	expect(rows).toEqual([
		{ text: "あれ俺のお守り", y: 0 },
		{ text: "あらへんで", y: 11.5 },
	]);
	expect(
		output.draws
			.filter((draw) => draw.color === style.emphasisColor)
			.map(({ text, x, y }) => ({ text, x, y })),
	).toEqual([{ text: "あらへんで", x: 0, y: 11.5 }]);
});

it("keeps original UTF-16 emphasis across shared caption soft rows and CRLF", () => {
	const text = "🙂abc👩‍🚀de\r\nalpha beta gamma";
	const from = text.indexOf("beta");
	const { output } = paint(text, 80, [{ startChar: from, endChar: from + 4 }]);
	expect(
		output.draws
			.filter((draw) => draw.color === style.emphasisColor)
			.map(({ text, x, y }) => ({ text, x, y })),
	).toEqual([{ text: "beta", x: 0, y: 34.5 }]);
});

it("retains measured Canvas wrapping for generic overlays", () => {
	expect(paint("alpha beta gamma", 80, [], "LEFT", "OVERLAY").rows).toEqual([
		{ text: "alpha beta gamma", y: 0 },
	]);
});
