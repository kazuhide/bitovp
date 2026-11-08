import { createHash } from "node:crypto";
import {
	hashEditingEvidence,
	isSupportedCaptionText,
	type PlamoCaptionInput,
	plamoCaptionInputSchema,
	PLAMO_CAPTION_TEMPLATE as recipe,
} from "@bitovp/core";

export {
	PLAMO_CAPTION_TEMPLATE_HASH,
	type PlamoCaptionModelIdentity,
	plamoCaptionModelIdentitySchema,
} from "@bitovp/core";

import { MediaOperationError } from "./process";

// Pure preparation only. It enables no model downloads, service or fallback.
/** Official PFML3 raw completions format; source clocks and cue ids are never generated. */
export function buildPlamoCaptionRequest(value: PlamoCaptionInput) {
	let input: PlamoCaptionInput;
	try {
		input = plamoCaptionInputSchema.parse(value);
	} catch {
		throw new MediaOperationError("LOCAL_CAPTION_TRANSLATION_INVALID");
	}
	if (input.history.some((h) => h.contextScopeHash !== input.contextScopeHash))
		throw new MediaOperationError("LOCAL_CAPTION_SOURCE_CHANGED");
	if (
		Buffer.byteLength(
			JSON.stringify([{ id: input.cueId, text: input.sourceText }]),
			"utf8",
		) > 2000
	)
		throw new MediaOperationError("LOCAL_CAPTION_CONTEXT_LIMIT");
	const language =
		input.sourceLanguage === "auto"
			? ""
			: recipe.language + input.sourceLanguage;
	let prompt: string = recipe.dataset;
	if (input.context) prompt += recipe.context + input.context;
	for (const history of input.history) {
		prompt +=
			recipe.input +
			language +
			recipe.message +
			history.sourceText +
			recipe.output +
			recipe.message +
			history.translatedText;
	}
	if (input.glossary.length)
		prompt +=
			recipe.glossary +
			input.glossary
				.map(
					(term) => recipe.term + term.source + recipe.definition + term.target,
				)
				.join("");
	prompt +=
		recipe.input +
		language +
		recipe.message +
		input.sourceText +
		recipe.output +
		recipe.style +
		recipe.message;
	if (Buffer.byteLength(prompt, "utf8") > 5632)
		throw new MediaOperationError("LOCAL_CAPTION_CONTEXT_LIMIT");
	return {
		identity: input.identity,
		inputHash: hashEditingEvidence(input),
		prompt,
		promptHash: createHash("sha256").update(prompt).digest("hex"),
		cacheKey: hashEditingEvidence({ version: recipe.version, input }),
		stop: [...recipe.stop],
		maxTokens: 1536 as const,
		temperature: 0 as const,
		seed: 41 as const,
	};
}

export function parsePlamoCaptionOutput(cueId: string, value: unknown) {
	if (!/^c\d{1,3}$/.test(cueId) || typeof value !== "string")
		throw new MediaOperationError("LOCAL_CAPTION_TRANSLATION_INVALID");
	const text = value.replace(/(?:<\|plamo:tag\|>|<\|plamo:bos\|>)$/, "").trim();
	if (
		!(
			isSupportedCaptionText(text) &&
			text.length <= 1000 &&
			!text.includes("<|plamo:")
		)
	)
		throw new MediaOperationError("LOCAL_CAPTION_TRANSLATION_INVALID");
	return { id: cueId, text };
}
