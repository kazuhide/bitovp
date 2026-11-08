import { z } from "zod";
import type { CompositionCaption } from "./composition-schema";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export function isSupportedCaptionText(value: string) {
	return (
		value.trim().length > 0 &&
		[...value].every((character) => {
			const code = character.charCodeAt(0);
			return code >= 32 || code === 9 || code === 10 || code === 13;
		})
	);
}
const text = z.string().min(1).max(1000).refine(isSupportedCaptionText);
export const captionDisplayLanguageSchema = z.enum(["ORIGINAL", "ja"]);
export type CaptionDisplayLanguage = z.infer<
	typeof captionDisplayLanguageSchema
>;
export const compositionCaptionTranslationSchema = z
	.strictObject({
		targetLanguage: z.literal("ja"),
		text,
		/** Exact snapshot permits synchronous browser-safe stale detection. */
		sourceText: text,
		sourceTextHash: hash,
		origin: z.enum(["LOCAL_LLM", "MANUAL"]),
		evidenceHash: hash.optional(),
		derivedFromEvidenceHash: hash.optional(),
	})
	.superRefine((value, ctx) => {
		if ((value.origin === "LOCAL_LLM") !== (value.evidenceHash !== undefined)) {
			ctx.addIssue({
				code: "custom",
				message: "Only an untouched local translation carries native evidence",
			});
		}
	});

/** Translation changes text only; measured timing and original words remain in the document. */
export function resolveCompositionCaptionDisplay(
	caption: CompositionCaption,
	language: CaptionDisplayLanguage = "ORIGINAL",
) {
	const translation = caption.translation;
	const staleTranslation = Boolean(
		translation && translation.sourceText !== caption.text,
	);
	if (language === "ja" && translation && !staleTranslation) {
		return {
			text: translation.text,
			words: [] as NonNullable<CompositionCaption["words"]>,
			translated: true,
			staleTranslation: false,
		};
	}
	return {
		text: caption.text,
		words: caption.words ?? [],
		translated: false,
		staleTranslation,
	};
}

/** Editor changes are not a new model receipt. Old receipts remain historical lineage only. */
export function setCompositionCaptionDisplayText(
	caption: CompositionCaption,
	language: CaptionDisplayLanguage,
	value: string,
): CompositionCaption {
	text.parse(value);
	if (
		language === "ja" &&
		caption.translation &&
		caption.translation.sourceText === caption.text
	) {
		const { evidenceHash, ...previous } = caption.translation;
		return {
			...caption,
			translation: {
				...previous,
				text: value,
				origin: "MANUAL",
				...(evidenceHash ? { derivedFromEvidenceHash: evidenceHash } : {}),
			},
		};
	}
	const { words: _words, ...original } = caption;
	return { ...original, text: value };
}
