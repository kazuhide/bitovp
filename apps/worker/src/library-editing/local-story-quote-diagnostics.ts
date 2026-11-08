import { createHash } from "node:crypto";
import {
	type LocalStoryChunk,
	LocalStoryError,
	type LocalStoryInput,
	localStoryLedgerSchema,
} from "@bitovp/core";

export type LocalStoryLedgerAttemptFamily =
	| "BASE"
	| "GENERIC"
	| "NUMERIC"
	| "QUOTE"
	| "ASR";
type Matches = Readonly<{
	sameRefField: boolean;
	sameRefText: boolean;
	sameRefSpaceJoined: boolean;
	chunkContext: boolean;
	otherChunkRefField: boolean;
	whitespaceFold: boolean;
	caseFold: boolean;
	typographicFold: boolean;
}>;
type Mismatch = Readonly<{
	eventIndex: number;
	quoteIndex: number;
	quoteSha256: string;
	quoteUtf8Bytes: number;
	matches: Matches;
}>;
type Progress = Readonly<{
	attempt: 1 | 2 | 3;
	family: LocalStoryLedgerAttemptFamily;
	mismatchCount: number;
	truncated: boolean;
	mismatches: readonly Mismatch[];
}>;
const brand = Symbol("local-story-quote-diagnostic");
const trusted = new WeakSet<object>();
export type LocalStoryQuoteDiagnostic = Progress & { readonly [brand]: true };
const whitespaceFold = (text: string) => text.replace(/\s+/gu, " ").trim();
const typographicFold = (text: string) =>
	text
		.normalize("NFKC")
		.replace(/[‘’]/gu, "'")
		.replace(/[“”]/gu, '"')
		.replace(/[‐‑‒–—−]/gu, "-");

/** Comparisons describe a rejection; no folded text is accepted, returned or persisted. */
export function diagnoseLocalStoryQuotes(options: {
	error: unknown;
	input: LocalStoryInput;
	chunk: LocalStoryChunk;
	ledger: unknown;
	attempt: 1 | 2 | 3;
	family: LocalStoryLedgerAttemptFamily;
}): LocalStoryQuoteDiagnostic | undefined {
	try {
		const { error, input, chunk, attempt, family } = options;
		if (
			!(error instanceof LocalStoryError) ||
			error.code !== "LOCAL_STORY_EVIDENCE_INVALID" ||
			error.rule !== "QUOTE_NOT_EXACT_SOURCE_SUBSTRING"
		)
			return undefined;
		if (
			!(attempt === 1 && family === "BASE") &&
			!(attempt === 2 && ["GENERIC", "NUMERIC", "QUOTE"].includes(family)) &&
			!(attempt === 3 && family === "ASR")
		)
			return undefined;
		const parsed = localStoryLedgerSchema.safeParse(options.ledger);
		if (!parsed.success) return undefined;
		const allowed = new Set(chunk.refs);
		const shots = new Map(
			input.shots
				.filter((shot) => allowed.has(shot.ref))
				.map((shot) => [shot.ref, shot]),
		);
		const mismatches: Mismatch[] = [];
		let mismatchCount = 0;
		for (const [eventIndex, event] of parsed.data.events.entries()) {
			for (const [quoteIndex, quote] of event.quotes.entries()) {
				const shot = shots.get(quote.ref);
				if (!shot || !event.refs.includes(quote.ref)) return undefined;
				const sameRefField = shot.fields.some((field) =>
					field.text.includes(quote.quote),
				);
				if (sameRefField) continue;
				mismatchCount++;
				if (mismatches.length === 2) continue;
				mismatches.push(
					Object.freeze({
						eventIndex,
						quoteIndex,
						quoteSha256: createHash("sha256").update(quote.quote).digest("hex"),
						quoteUtf8Bytes: Buffer.byteLength(quote.quote),
						matches: Object.freeze({
							sameRefField,
							sameRefText: shot.text.includes(quote.quote),
							// Trim only field edges before inserting one join-space; comparison only.
							sameRefSpaceJoined: shot.fields
								.map((field) => field.text.trim())
								.join(" ")
								.includes(quote.quote),
							chunkContext: chunk.context.some((context) =>
								context.text.includes(quote.quote),
							),
							otherChunkRefField: [...shots.values()].some(
								(other) =>
									other.ref !== quote.ref &&
									other.fields.some((field) =>
										field.text.includes(quote.quote),
									),
							),
							whitespaceFold: shot.fields.some((field) =>
								whitespaceFold(field.text).includes(
									whitespaceFold(quote.quote),
								),
							),
							caseFold: shot.fields.some((field) =>
								field.text.toLowerCase().includes(quote.quote.toLowerCase()),
							),
							typographicFold: shot.fields.some((field) =>
								typographicFold(field.text).includes(
									typographicFold(quote.quote),
								),
							),
						}),
					}),
				);
			}
		}
		if (!mismatchCount) return undefined;
		const result = {
			attempt,
			family,
			mismatchCount,
			truncated: mismatchCount > mismatches.length,
			mismatches: Object.freeze(mismatches),
		};
		Object.defineProperty(result, brand, { value: true });
		trusted.add(result);
		return Object.freeze(result) as LocalStoryQuoteDiagnostic;
	} catch {
		// Best-effort diagnostics must never replace the original validation error.
		return undefined;
	}
}

/** Only this module's bounded, immutable factory products can cross the progress boundary. */
export function localStoryQuoteDiagnosticsProgress(
	diagnostics: readonly LocalStoryQuoteDiagnostic[],
): readonly Progress[] | undefined {
	try {
		if (!diagnostics.length || diagnostics.length > 3) return undefined;
		let previous = 0;
		const progress: Progress[] = [];
		for (const value of diagnostics) {
			if (
				!value ||
				typeof value !== "object" ||
				!trusted.has(value) ||
				value.attempt <= previous
			)
				return undefined;
			previous = value.attempt;
			progress.push({
				attempt: value.attempt,
				family: value.family,
				mismatchCount: value.mismatchCount,
				truncated: value.truncated,
				mismatches: value.mismatches.map((mismatch) => ({
					eventIndex: mismatch.eventIndex,
					quoteIndex: mismatch.quoteIndex,
					quoteSha256: mismatch.quoteSha256,
					quoteUtf8Bytes: mismatch.quoteUtf8Bytes,
					matches: {
						sameRefField: mismatch.matches.sameRefField,
						sameRefText: mismatch.matches.sameRefText,
						sameRefSpaceJoined: mismatch.matches.sameRefSpaceJoined,
						chunkContext: mismatch.matches.chunkContext,
						otherChunkRefField: mismatch.matches.otherChunkRefField,
						whitespaceFold: mismatch.matches.whitespaceFold,
						caseFold: mismatch.matches.caseFold,
						typographicFold: mismatch.matches.typographicFold,
					},
				})),
			});
		}
		return progress;
	} catch {
		return undefined;
	}
}
