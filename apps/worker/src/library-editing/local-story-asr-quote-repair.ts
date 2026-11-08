import {
	type LocalStoryChunk,
	type LocalStoryField,
	type LocalStoryInput,
	localStoryLedgerSchema,
} from "@bitovp/core";
import { LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY } from "@bitovp/core/local-story-flow-server";
import { localLedgerPrompt } from "./local-story-prompts";

const limit = 6144;
export const LOCAL_LEDGER_ASR_QUOTE_REPAIR_SUFFIX =
	LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY.suffixes.asr;
const whitespace = (value: string) => value.replace(/\s+/gu, " ").trim();

/** Offer only trusted fields that explain an exact, consecutive ASR join. Never fix model output. */
export function localAsrQuoteRepairPrompt(options: {
	input: LocalStoryInput;
	chunk: LocalStoryChunk;
	ledger: unknown;
}): string | undefined {
	const parsed = localStoryLedgerSchema.safeParse(options.ledger);
	if (!parsed.success) return undefined;
	const allowed = new Set(options.chunk.refs);
	const candidates: { ref: string; pointer: string; text: string }[] = [];
	const seen = new Set<string>();
	for (const event of parsed.data.events) {
		const quotedRefs = new Set(event.quotes.map((quote) => quote.ref));
		if (
			new Set(event.refs).size !== event.refs.length ||
			event.refs.length !== quotedRefs.size ||
			event.refs.some((ref) => !allowed.has(ref) || !quotedRefs.has(ref))
		)
			return undefined;
		for (const quote of event.quotes) {
			const shot = options.input.shots.find((shot) => shot.ref === quote.ref);
			if (!shot) return undefined;
			if (shot.fields.some((field) => field.text.includes(quote.quote)))
				continue;
			const fields = shot.fields.filter((field) => field.kind === "ASR");
			const expected = whitespace(quote.quote);
			let matched = false;
			for (let start = 0; start < fields.length - 1; start++) {
				let joined = "";
				const span: LocalStoryField[] = [];
				for (const field of fields.slice(start)) {
					const text = whitespace(field.text);
					if (!text) break;
					span.push(field);
					joined += `${joined ? " " : ""}${text}`;
					if (span.length > 1 && joined === expected) {
						matched = true;
						for (const source of span) {
							const key = JSON.stringify([
								quote.ref,
								source.pointer,
								source.text,
							]);
							if (!seen.has(key)) {
								seen.add(key);
								candidates.push({
									ref: quote.ref,
									pointer: source.pointer,
									text: source.text,
								});
							}
						}
					}
					if (joined.length >= expected.length) break;
				}
			}
			if (!matched) return undefined;
		}
	}
	const base =
		localLedgerPrompt(options.chunk) + LOCAL_LEDGER_ASR_QUOTE_REPAIR_SUFFIX;
	const selected: typeof candidates = [];
	for (const candidate of candidates) {
		if (
			Buffer.byteLength(base + JSON.stringify([...selected, candidate])) <=
			limit
		)
			selected.push(candidate);
	}
	return selected.length ? base + JSON.stringify(selected) : undefined;
}
