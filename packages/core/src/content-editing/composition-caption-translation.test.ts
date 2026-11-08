import { describe, expect, it } from "vitest";
import {
	resolveCompositionCaptionDisplay,
	setCompositionCaptionDisplayText,
} from "./composition-caption-translation";
import { compositionCaptionSchema } from "./composition-schema";

const original = {
	id: "11111111-1111-4111-8111-111111111111",
	fromFrame: 10,
	toFrame: 40,
	text: "Hello world.",
	words: [
		{ text: "Hello", startChar: 0, endChar: 5, fromFrame: 10, toFrame: 20 },
	],
};
const translated = () =>
	compositionCaptionSchema.parse({
		...original,
		translation: {
			targetLanguage: "ja",
			text: "こんにちは。",
			sourceText: original.text,
			sourceTextHash: "a".repeat(64),
			origin: "LOCAL_LLM",
			evidenceHash: "b".repeat(64),
		},
	});

describe("original and translated caption layers", () => {
	it("keeps legacy captions and measured words in the original display", () => {
		expect(resolveCompositionCaptionDisplay(original)).toEqual({
			text: original.text,
			words: original.words,
			translated: false,
			staleTranslation: false,
		});
	});
	it("shows Japanese without assigning English word timings to Japanese characters", () => {
		const caption = translated();
		expect(resolveCompositionCaptionDisplay(caption, "ja")).toEqual({
			text: "こんにちは。",
			words: [],
			translated: true,
			staleTranslation: false,
		});
		expect(caption.text).toBe(original.text);
		expect(caption.words).toEqual(original.words);
		expect([caption.fromFrame, caption.toFrame]).toEqual([10, 40]);
	});
	it("never displays a translation bound to an older source text", () => {
		const caption = { ...translated(), text: "Goodbye world." };
		expect(resolveCompositionCaptionDisplay(caption, "ja")).toEqual({
			text: "Goodbye world.",
			words: original.words,
			translated: false,
			staleTranslation: true,
		});
	});
	it("marks a human translation edit as manual and retains only historical evidence lineage", () => {
		const caption = translated();
		const edited = setCompositionCaptionDisplayText(
			caption,
			"ja",
			"やあ、世界。",
		);
		expect(edited.translation).toMatchObject({
			text: "やあ、世界。",
			origin: "MANUAL",
			derivedFromEvidenceHash: "b".repeat(64),
		});
		expect(edited.translation?.evidenceHash).toBeUndefined();
		expect(caption.translation?.origin).toBe("LOCAL_LLM");
		expect(edited.text).toBe(original.text);
	});
	it("does not silently rebind an existing translation when the original is edited", () => {
		const edited = setCompositionCaptionDisplayText(
			translated(),
			"ORIGINAL",
			"Goodbye.",
		);
		expect(edited.words).toBeUndefined();
		expect(edited.translation?.sourceText).toBe(original.text);
		expect(
			resolveCompositionCaptionDisplay(edited, "ja").staleTranslation,
		).toBe(true);
	});
	it("requires native provenance only for untouched local translations", () => {
		const caption = translated();
		expect(
			compositionCaptionSchema.safeParse({
				...caption,
				translation: { ...caption.translation, evidenceHash: undefined },
			}).success,
		).toBe(false);
		expect(
			compositionCaptionSchema.safeParse({
				...caption,
				translation: { ...caption.translation, origin: "MANUAL" },
			}).success,
		).toBe(false);
	});
});
