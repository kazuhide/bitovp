import { z } from "zod";
import { canonicalEditingJson } from "./automatic-binding";
import { localStoryStageRegistry } from "./local-semantic-stages";
import type {
	LocalStoryChunk,
	LocalStoryInput,
	LocalStoryModelIdentity,
} from "./local-story-contracts";
import { localStoryModelIdentitySchema } from "./local-story-contracts";
import {
	buildLocalStoryChunks,
	mergeLocalStoryLedgers,
	validateLocalStoryLedger,
} from "./local-story-input";
import { localStoryEventMinimumDurationFrames } from "./local-story-planner";
import { cfrTimeMapSchema } from "./schema";
import { hashEditingEvidence } from "./verify-automatic-binding";

export type RevalidatedFlowLedgerRef = {
	chunkIndex: number;
	stageInputHash: string;
	promptHash: string;
	schemaHash: string;
	stageKeyHash: string;
	ledgerHash: string;
};
export type LocalStoryFlowManifestOptions = {
	input: LocalStoryInput;
	chunks: readonly LocalStoryChunk[];
	ledgers: readonly unknown[];
	model: LocalStoryModelIdentity;
	transcriptFingerprint: string;
	ledgerRefs: readonly RevalidatedFlowLedgerRef[];
};

export class LocalStoryFlowError extends Error {
	constructor(
		readonly code:
			| "LOCAL_STORY_FLOW_MANIFEST_INVALID"
			| "LOCAL_STORY_FLOW_ITEM_TOO_LARGE"
			| "LOCAL_STORY_FLOW_PAGE_LIMIT",
	) {
		super(code);
		this.name = "LocalStoryFlowError";
	}
}
function requireFlow(valid: unknown): asserts valid {
	if (!valid)
		throw new LocalStoryFlowError("LOCAL_STORY_FLOW_MANIFEST_INVALID");
}
function sameJson(value: unknown, expected: unknown): boolean {
	if (value === null || typeof value !== "object")
		return Object.is(value, expected);
	if (
		expected === null ||
		typeof expected !== "object" ||
		Array.isArray(value) !== Array.isArray(expected) ||
		Object.getOwnPropertySymbols(value).length > 0
	)
		return false;
	if (
		Array.isArray(value) &&
		Array.isArray(expected) &&
		value.length !== expected.length
	)
		return false;
	if (
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) !== Object.prototype
	)
		return false;
	const keys = Object.keys(value).sort(),
		expectedKeys = Object.keys(expected).sort();
	return (
		keys.length === expectedKeys.length &&
		keys.every(
			(key, index) =>
				key === expectedKeys[index] &&
				sameJson(
					(value as Record<string, unknown>)[key],
					(expected as Record<string, unknown>)[key],
				),
		)
	);
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const ledgerRefSchema = z.strictObject({
	chunkIndex: z.number().int().min(0).max(127),
	stageInputHash: digest,
	promptHash: digest,
	schemaHash: digest,
	stageKeyHash: digest,
	ledgerHash: digest,
});

/** A complete derived view; callers own native receipt and accepted-pointer verification. */
export function buildLocalStoryFlowManifest(
	options: LocalStoryFlowManifestOptions,
) {
	const { input, chunks } = options;
	const corpus = mergeLocalStoryLedgers(options);
	requireFlow(sameJson(chunks, buildLocalStoryChunks(input)));
	const modelResult = localStoryModelIdentitySchema.safeParse(options.model);
	const refsResult = ledgerRefSchema
		.array()
		.length(chunks.length)
		.safeParse(options.ledgerRefs);
	requireFlow(
		modelResult.success &&
			refsResult.success &&
			digest.safeParse(options.transcriptFingerprint).success,
	);
	const model = modelResult.data,
		ledgerRefs = refsResult.data;
	const registry = localStoryStageRegistry();
	requireFlow(model.schemaHash === hashEditingEvidence(registry));
	requireFlow(
		cfrTimeMapSchema.safeParse(input.timeMap).success &&
			input.timeMapHash === hashEditingEvidence(input.timeMap),
	);
	for (const [index, chunk] of chunks.entries()) {
		const ledger = validateLocalStoryLedger({
			input,
			chunk,
			ledger: options.ledgers[index],
		});
		requireFlow(sameJson(options.ledgers[index], ledger));
		const reference = ledgerRefs[index];
		requireFlow(reference && reference.chunkIndex === index);
		const stageInputHash = hashEditingEvidence({
			chunk,
			transcriptFingerprint: options.transcriptFingerprint,
		});
		requireFlow(
			reference.ledgerHash === hashEditingEvidence(ledger) &&
				reference.stageInputHash === stageInputHash &&
				reference.schemaHash === registry.stages.LOCAL_LEDGER_V1.schemaHash &&
				reference.stageKeyHash ===
					hashEditingEvidence({
						identity: model,
						stage: "LOCAL_LEDGER_V1",
						inputHash: stageInputHash,
						promptHash: reference.promptHash,
						schemaHash: reference.schemaHash,
					}),
		);
	}
	const coverage = z
		.array(
			z.strictObject({
				ref: z.string().regex(/^s\d{1,5}$/),
				status: z.enum([
					"ELIGIBLE",
					"EXCLUDED",
					"OUTSIDE_MEDIA",
					"UNREPRESENTABLE",
				]),
			}),
		)
		.max(10000)
		.safeParse(input.coverage);
	requireFlow(coverage.success);
	const eligible = coverage.data.filter((entry) => entry.status === "ELIGIBLE");
	const shots = new Map(input.shots.map((shot) => [shot.ref, shot]));
	requireFlow(
		new Set(coverage.data.map((entry) => entry.ref)).size ===
			coverage.data.length &&
			eligible.length === input.shots.length &&
			eligible.every((entry) => shots.has(entry.ref)),
	);
	const order = (refs: readonly string[]) => {
		const from = Math.min(
			...refs.map((ref) => {
				const shot = shots.get(ref);
				requireFlow(shot);
				return shot.fromFrame;
			}),
		);
		requireFlow(Number.isSafeInteger(from) && from >= 0);
		return from;
	};
	const items = chunks.flatMap((chunk, chunkIndex) => {
		const summary = corpus.summaries[chunkIndex];
		requireFlow(typeof summary === "string");
		return [
			{
				id: `u${chunkIndex}`,
				kind: "DERIVED_CHUNK_SUMMARY" as const,
				chunkIndex,
				sourceOrder: order(chunk.refs),
				summary,
			},
			...corpus.events
				.filter((event) => event.id.startsWith(`l${chunkIndex}_`))
				.map((event) => ({
					id: event.id,
					kind: "GROUNDED_LEAF_EVENT_CARD" as const,
					chunkIndex,
					sourceOrder: order(event.refs),
					label: event.label,
					role: event.role,
					subjects: [...event.subjects],
					minimumFrames:
						localStoryEventMinimumDurationFrames(input, event) ?? null,
					eventHash: hashEditingEvidence(event),
				})),
		];
	});
	const body = {
		version: "local-story-flow-manifest-v1" as const,
		policy: "full-ledger-context-view-v1" as const,
		model,
		modelHash: hashEditingEvidence(model),
		inputHash: hashEditingEvidence(input),
		chunkManifestHash: hashEditingEvidence(chunks),
		corpusHash: hashEditingEvidence(corpus),
		transcriptFingerprint: options.transcriptFingerprint,
		ledgerRefs,
		corpus,
		items,
		coverage: {
			totalChunks: chunks.length,
			totalSummaries: corpus.summaries.length,
			totalEvents: corpus.events.length,
			totalShots: input.coverage.length,
			eligibleShots: input.shots.length,
			processedShots: corpus.coveredRefs.length,
			processedRefs: [...corpus.coveredRefs],
			excludedShots: input.coverage.length - input.shots.length,
			truncated: false as const,
		},
	};
	return structuredClone({ ...body, manifestHash: hashEditingEvidence(body) });
}
export type LocalStoryFlowManifest = ReturnType<
	typeof buildLocalStoryFlowManifest
>;
export type LocalStoryFlowContextItem = LocalStoryFlowManifest["items"][number];

/** Rebuild from caller-verified evidence; a stored self-consistent hash is insufficient. */
export function validateLocalStoryFlowManifest(
	value: unknown,
	options: LocalStoryFlowManifestOptions,
): LocalStoryFlowManifest {
	const expected = buildLocalStoryFlowManifest(options);
	try {
		requireFlow(
			sameJson(value, expected) &&
				canonicalEditingJson(value) === canonicalEditingJson(expected),
		);
	} catch {
		throw new LocalStoryFlowError("LOCAL_STORY_FLOW_MANIFEST_INVALID");
	}
	return expected;
}

export const LOCAL_STORY_FLOW_LEAF_PAGE_LIMITS = Object.freeze({
	context: 8192,
	maxOutputTokens: 1536,
	maxPromptUtf8Bytes: 5632,
	instructionUtf8Bytes: 1536,
	maxDataUtf8Bytes: 4096,
	maxItems: 32,
	maxPages: 32,
});
type SummaryItem = Extract<
	LocalStoryFlowContextItem,
	{ kind: "DERIVED_CHUNK_SUMMARY" }
>;
type CardItem = Extract<
	LocalStoryFlowContextItem,
	{ kind: "GROUNDED_LEAF_EVENT_CARD" }
>;
export type LocalStoryFlowLeafDataItem =
	| SummaryItem
	| Omit<CardItem, "eventHash">;
function leafDataItem(
	item: LocalStoryFlowContextItem,
): LocalStoryFlowLeafDataItem {
	if (item.kind === "GROUNDED_LEAF_EVENT_CARD") {
		const { eventHash: _hash, ...data } = item;
		return structuredClone(data);
	}
	return structuredClone(item);
}
function leafPage(
	manifest: LocalStoryFlowManifest,
	items: readonly LocalStoryFlowContextItem[],
	pageIndex: number,
) {
	const pageId = `flow-page${pageIndex}`;
	const data = { pageId, items: items.map(leafDataItem) };
	const body = {
		version: "local-story-flow-leaf-page-v1" as const,
		policy: "full-ledger-context-pages-v1" as const,
		pageId,
		pageIndex,
		manifestHash: manifest.manifestHash,
		itemIds: items.map((item) => item.id),
		itemHashes: items.map(hashEditingEvidence),
		data,
		dataHash: hashEditingEvidence(data),
		dataUtf8Bytes: new TextEncoder().encode(JSON.stringify(data)).byteLength,
	};
	return { ...body, pageHash: hashEditingEvidence(body) };
}
export type LocalStoryFlowLeafPage = ReturnType<typeof leafPage>;

/** Takes a factory-built or strictly revalidated manifest; never establishes native provenance. */
export function buildLocalStoryFlowLeafPages(
	manifest: LocalStoryFlowManifest,
): LocalStoryFlowLeafPage[] {
	const { manifestHash, ...body } = manifest;
	requireFlow(
		manifestHash === hashEditingEvidence(body) && manifest.items.length > 0,
	);
	const limits = LOCAL_STORY_FLOW_LEAF_PAGE_LIMITS;
	const pages: LocalStoryFlowLeafPage[] = [];
	let current: LocalStoryFlowContextItem[] = [];
	for (const item of manifest.items) {
		if (
			current.length &&
			(current.length >= limits.maxItems ||
				leafPage(manifest, [...current, item], pages.length).dataUtf8Bytes >
					limits.maxDataUtf8Bytes)
		) {
			pages.push(leafPage(manifest, current, pages.length));
			current = [];
		}
		if (
			leafPage(manifest, [item], pages.length).dataUtf8Bytes >
			limits.maxDataUtf8Bytes
		)
			throw new LocalStoryFlowError("LOCAL_STORY_FLOW_ITEM_TOO_LARGE");
		if (pages.length >= limits.maxPages)
			throw new LocalStoryFlowError("LOCAL_STORY_FLOW_PAGE_LIMIT");
		current.push(item);
	}
	if (current.length) pages.push(leafPage(manifest, current, pages.length));
	return pages;
}

/** The caller must revalidate the manifest against its complete source inputs first. */
export function validateLocalStoryFlowLeafPages(
	value: unknown,
	manifest: LocalStoryFlowManifest,
): LocalStoryFlowLeafPage[] {
	const expected = buildLocalStoryFlowLeafPages(manifest);
	try {
		requireFlow(
			sameJson(value, expected) &&
				canonicalEditingJson(value) === canonicalEditingJson(expected),
		);
	} catch {
		throw new LocalStoryFlowError("LOCAL_STORY_FLOW_MANIFEST_INVALID");
	}
	return expected;
}
