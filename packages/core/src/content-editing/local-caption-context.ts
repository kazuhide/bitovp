import { z } from "zod";
import {
	LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
	type LocalCaptionTranslationBatch,
	LocalCaptionTranslationError,
	localCaptionTranslationBatchSchema,
	validateLocalCaptionTranslation,
} from "./local-caption-translation";
import { hashEditingEvidence } from "./verify-automatic-binding";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const field = z.strictObject({
	sourceHash: hash,
	kind: z.enum(["SCENE", "SHOT", "CHARACTER"]),
	text: z.string().min(1).max(64000),
});
export type LocalCaptionCueContext = {
	sourceHash: string;
	scopeHash: string;
	fields: z.infer<typeof field>[];
};
export const contextualLocalCaptionBatchSchema =
	localCaptionTranslationBatchSchema.omit({ version: true }).extend({
		version: z.literal("caption-ja-input-v2"),
		contextPolicyFingerprint: z.literal(
			LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
		),
		bindings: z
			.array(
				z.strictObject({
					id: z.string().regex(/^c\d{1,3}$/),
					sourceHash: hash,
					scopeHash: hash,
					fieldIds: z.array(z.string().regex(/^f\d{1,2}$/)).max(16),
				}),
			)
			.min(1)
			.max(8),
		contextFields: z
			.array(field.extend({ id: z.string().regex(/^f\d{1,2}$/) }))
			.max(16),
		memory: z
			.array(
				z.strictObject({
					id: z.string().regex(/^c\d{1,3}$/),
					text: z.string().min(1).max(1000),
				}),
			)
			.max(8),
	});
export type ContextualLocalCaptionBatch = z.infer<
	typeof contextualLocalCaptionBatchSchema
>;

export function localCaptionBatchSource(
	batch: ContextualLocalCaptionBatch,
): LocalCaptionTranslationBatch {
	return localCaptionTranslationBatchSchema.parse({
		version: "caption-ja-input-v1",
		sourceLanguage: batch.sourceLanguage,
		targetLanguage: batch.targetLanguage,
		qualityPolicyFingerprint: batch.qualityPolicyFingerprint,
		cues: batch.cues,
	});
}

export function captionTranslationConsistencyKey(
	batch: ContextualLocalCaptionBatch,
	id: string,
) {
	const cue = batch.cues.find((c) => c.id === id),
		binding = batch.bindings.find((b) => b.id === id);
	if (!cue || !binding)
		throw new LocalCaptionTranslationError("LOCAL_CAPTION_TRANSLATION_INVALID");
	return hashEditingEvidence({
		version: batch.contextPolicyFingerprint,
		sourceLanguage: batch.sourceLanguage,
		qualityPolicyFingerprint: batch.qualityPolicyFingerprint,
		scopeHash: binding.scopeHash,
		text: cue.text,
	});
}

/** Only subtitle text and bounded reference DATA are visible to the model. */
export function localCaptionContextData(batch: ContextualLocalCaptionBatch) {
	return {
		sourceLanguage: batch.sourceLanguage,
		cues: batch.cues.map(({ id, text }) => ({
			id,
			text,
			context: batch.bindings.find((b) => b.id === id)?.fieldIds ?? [],
			...(batch.memory.find((m) => m.id === id)
				? { acceptedTranslation: batch.memory.find((m) => m.id === id)?.text }
				: {}),
		})),
		context: batch.contextFields.map(({ id, kind, text }) => ({
			id,
			kind,
			text,
		})),
	};
}
const bytes = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).length;

/** Optional metadata is selected as whole source fields; required speech/memory is never shortened. */
export function buildContextualLocalCaptionBatch(input: {
	batch: LocalCaptionTranslationBatch;
	contexts: ReadonlyMap<string, LocalCaptionCueContext>;
	accepted?: ReadonlyMap<string, string>;
}): ContextualLocalCaptionBatch {
	const source = localCaptionTranslationBatchSchema.parse(input.batch);
	const result: ContextualLocalCaptionBatch = {
		...source,
		version: "caption-ja-input-v2",
		contextPolicyFingerprint: LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
		bindings: source.cues.map((c) => {
			const context = input.contexts.get(c.captionId);
			return {
				id: c.id,
				sourceHash: context?.sourceHash ?? hashEditingEvidence(c),
				scopeHash:
					context?.scopeHash ??
					hashEditingEvidence({ unknownContext: c.captionId }),
				fieldIds: [],
			};
		}),
		contextFields: [],
		memory: [],
	};
	for (const c of source.cues) {
		const text = input.accepted?.get(
			captionTranslationConsistencyKey(result, c.id),
		);
		if (text !== undefined) result.memory.push({ id: c.id, text });
	}
	if (bytes(localCaptionContextData(result)) > 4500)
		throw new LocalCaptionTranslationError("LOCAL_CAPTION_CONTEXT_LIMIT");
	for (const cue of source.cues) {
		const binding = result.bindings.find((b) => b.id === cue.id);
		if (!binding)
			throw new LocalCaptionTranslationError(
				"LOCAL_CAPTION_TRANSLATION_INVALID",
			);
		for (const candidate of input.contexts.get(cue.captionId)?.fields ?? []) {
			field.parse(candidate);
			const existing = result.contextFields.find(
				(f) =>
					f.sourceHash === candidate.sourceHash &&
					f.kind === candidate.kind &&
					f.text === candidate.text,
			);
			if (existing) {
				if (!binding.fieldIds.includes(existing.id)) {
					binding.fieldIds.push(existing.id);
					if (bytes(localCaptionContextData(result)) > 4500)
						binding.fieldIds.pop();
				}
				continue;
			}
			if (result.contextFields.length >= 16) continue;
			const added = { ...candidate, id: `f${result.contextFields.length}` };
			result.contextFields.push(added);
			binding.fieldIds.push(added.id);
			if (
				bytes(result.contextFields) > 1400 ||
				bytes(localCaptionContextData(result)) > 4500
			) {
				result.contextFields.pop();
				binding.fieldIds.pop();
			}
		}
	}
	if (bytes(localCaptionContextData(result)) > 4500)
		throw new LocalCaptionTranslationError("LOCAL_CAPTION_CONTEXT_LIMIT");
	return contextualLocalCaptionBatchSchema.parse(result);
}

export function validateContextualLocalCaptionTranslation(
	batch: ContextualLocalCaptionBatch,
	value: unknown,
) {
	contextualLocalCaptionBatchSchema.parse(batch);
	const output = validateLocalCaptionTranslation(
		localCaptionBatchSource(batch),
		value,
	);
	const accepted = new Map<string, string>();
	for (const translated of output.translations) {
		const key = captionTranslationConsistencyKey(batch, translated.id),
			memory = batch.memory.find((m) => m.id === translated.id);
		if (
			(accepted.has(key) && accepted.get(key) !== translated.text) ||
			(memory && memory.text !== translated.text)
		) {
			throw new LocalCaptionTranslationError(
				"LOCAL_CAPTION_TRANSLATION_INVALID",
			);
		}
		accepted.set(key, translated.text);
	}
	return output;
}
