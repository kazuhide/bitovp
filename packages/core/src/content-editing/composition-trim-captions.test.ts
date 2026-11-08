import { expect, it } from "vitest";
import {
	compileComposition,
	evaluateCompositionFrame,
} from "./composition-frame";
import { trimCompositionClip } from "./composition-mutations";
import {
	compositionFixture,
	compositionIds as ids,
} from "./composition-test-fixtures";

function fixture() {
	const f = compositionFixture();
	f.document.captions = [
		{
			id: ids.item,
			anchorClipId: ids.clip,
			fromFrame: 10,
			toFrame: 40,
			text: "one two",
			words: [
				{
					text: "one",
					startChar: 0,
					endChar: 3,
					fromFrame: 10,
					toFrame: 20,
					confidence: 0.8,
				},
				{
					text: "two",
					startChar: 4,
					endChar: 7,
					fromFrame: 30,
					toFrame: 40,
					confidence: 0.9,
				},
			],
			translation: {
				targetLanguage: "ja",
				text: "ひとつ、ふたつ",
				sourceText: "one two",
				sourceTextHash: "a".repeat(64),
				origin: "MANUAL",
			},
		},
	];
	return f;
}
function trim(from: number, durationFrames: number) {
	const f = fixture();
	const sourceInUs = Number(
		1_000_000n + (BigInt(from + 1) * 1_000_000n + 29n) / 30n,
	);
	return {
		...f,
		result: trimCompositionClip(
			f.document,
			ids.clip,
			{ sourceInUs, durationFrames },
			[f.source],
		),
	};
}
it("removes words from an earlier cut and reindexes the surviving measured text", () => {
	const { result, source } = trim(25, 65);
	expect(result.captions).toEqual([
		{
			id: ids.item,
			anchorClipId: ids.clip,
			fromFrame: 5,
			toFrame: 15,
			text: "two",
			words: [
				{
					text: "two",
					startChar: 0,
					endChar: 3,
					fromFrame: 5,
					toFrame: 15,
					confidence: 0.9,
				},
			],
		},
	]);
	const compiled = compileComposition(result, [source]);
	expect(evaluateCompositionFrame(compiled, 4).captions).toEqual([]);
	expect(evaluateCompositionFrame(compiled, 5).captions[0]?.text).toBe("two");
	expect(evaluateCompositionFrame(compiled, 15).captions).toEqual([]);
});
it("never clamps half of a measured word into a new valid word", () => {
	const { result } = trim(15, 75);
	expect(result.captions?.[0]).toMatchObject({
		fromFrame: 15,
		toFrame: 25,
		text: "two",
		words: [
			{ text: "two", fromFrame: 15, toFrame: 25, startChar: 0, endChar: 3 },
		],
	});
});
it("removes trailing words and their obsolete translation", () => {
	const { result } = trim(0, 25);
	expect(result.captions?.[0]).toMatchObject({
		fromFrame: 10,
		toFrame: 20,
		text: "one",
		words: [{ text: "one", startChar: 0, endChar: 3 }],
	});
	expect(result.captions?.[0]?.translation).toBeUndefined();
});
it("omits a cue when neither complete measured word survives", () => {
	expect(trim(20, 10).result.captions).toEqual([]);
});
it("keeps signs and units attached to retained measurements", () => {
	const { document, source } = fixture();
	const caption = document.captions?.[0];
	if (!caption) throw Error("Missing caption");
	caption.text = "-5℃ 10%";
	caption.words = [
		{ text: "5℃", startChar: 1, endChar: 3, fromFrame: 10, toFrame: 20 },
		{ text: "10%", startChar: 4, endChar: 7, fromFrame: 30, toFrame: 40 },
	];
	delete caption.translation;
	const result = trimCompositionClip(
		document,
		ids.clip,
		{
			sourceInUs: document.clips[0]?.sourceInUs ?? 0,
			durationFrames: 25,
		},
		[source],
	);
	expect(result.captions?.[0]).toMatchObject({
		text: "-5℃",
		words: [
			{ text: "5℃", startChar: 1, endChar: 3, fromFrame: 10, toFrame: 20 },
		],
	});
});
it("retains complete manual text and translation when every word survives a time shift", () => {
	const { result } = trim(5, 85);
	expect(result.captions?.[0]).toMatchObject({
		text: "one two",
		fromFrame: 5,
		toFrame: 35,
		translation: { text: "ひとつ、ふたつ" },
		words: [
			{ fromFrame: 5, toFrame: 15 },
			{ fromFrame: 25, toFrame: 35 },
		],
	});
});
it("omits partially selected unmeasured text instead of displaying a full unrelated sentence", () => {
	const { document, source } = fixture();
	if (!document.captions?.[0]) throw Error("Missing caption");
	delete document.captions[0].words;
	const result = trimCompositionClip(
		document,
		ids.clip,
		{
			sourceInUs: 1_866_667,
			durationFrames: 65,
		},
		[source],
	);
	expect(result.captions).toEqual([]);
});
