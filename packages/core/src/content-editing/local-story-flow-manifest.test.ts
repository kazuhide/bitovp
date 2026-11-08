import { describe, expect, it } from "vitest";
import { canonicalEditingJson } from "./automatic-binding";
import { localStoryStageRegistry } from "./local-semantic-stages";
import type {
	LocalStoryInput,
	LocalStoryLedger,
	LocalStoryModelIdentity,
} from "./local-story-contracts";
import {
	buildLocalStoryFlowLeafPages,
	buildLocalStoryFlowManifest,
	validateLocalStoryFlowLeafPages,
	validateLocalStoryFlowManifest,
} from "./local-story-flow-manifest";
import { buildLocalStoryChunks } from "./local-story-input";
import { cfrTimeMapSchema } from "./schema";
import { hashEditingEvidence } from "./verify-automatic-binding";

const hash = "a".repeat(64);
function fixture(count = 2) {
	const timeMap = cfrTimeMapSchema.parse({
		id: "22222222-2222-4222-8222-222222222222",
		mediaVersionId: "33333333-3333-4333-8333-333333333333",
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: count * 3_000_000,
		editingStartFrame: 0,
		editingEndFrame: count * 90,
		fps: { num: 30, den: 1 },
	});
	const input: LocalStoryInput = {
		version: "local-story-input-v1",
		title: "鍵を探す",
		description: "人物が鍵を見つける。",
		timeMap,
		timeMapHash: hashEditingEvidence(timeMap),
		segments: [],
		scenes: [{ sceneId: "scene", text: "鍵を探す場面", fields: [] }],
		shots: Array.from({ length: count }, (_, i) => ({
			ref: `s${i}`,
			sceneId: "scene",
			shotIndex: i,
			fromFrame: i * 90,
			toFrame: (i + 1) * 90,
			text: `人物は鍵を見つける。${"あ".repeat(900)}`,
			fields: [
				{ kind: "AISA", pointer: `/shots/${i}`, text: "人物は鍵を見つける。" },
			],
		})),
		coverage: Array.from({ length: count }, (_, i) => ({
			ref: `s${i}`,
			status: "ELIGIBLE",
		})),
	};
	const chunks = buildLocalStoryChunks(input);
	const ledgers: LocalStoryLedger[] = chunks.map((chunk) => {
		const ref = chunk.refs[0];
		if (!ref) throw new Error("FIXTURE_REF_MISSING");
		return {
			summary: "人物が鍵を探し、見つける。",
			events: [
				{
					id: "e0",
					label: "人物が鍵を見つける",
					role: "ACTION" as const,
					refs: [ref],
					quotes: [{ ref, quote: "人物は鍵を見つける。" }],
					subjects: ["人物", "鍵"],
					uncertainty: "文脈は未確認",
				},
			],
		};
	});
	const registry = localStoryStageRegistry();
	const model: LocalStoryModelIdentity = {
		version: "local-story-model-v1",
		provider: "LOCAL_OLLAMA",
		profile: "nvidia",
		model: "fixture-model",
		modelDigest: hash,
		runtimeVersion: "1.0.0",
		promptVersion: "local-story-v1",
		schemaHash: hashEditingEvidence(registry),
		configId: "44444444-4444-4444-8444-444444444444",
		context: 8192,
		thinking: false,
	};
	const ledgerRefs = chunks.map((chunk, chunkIndex) => {
		const stageInputHash = hashEditingEvidence({
			chunk,
			transcriptFingerprint: hash,
		});
		const schemaHash = registry.stages.LOCAL_LEDGER_V1.schemaHash;
		return {
			chunkIndex,
			stageInputHash,
			schemaHash,
			promptHash: hash,
			ledgerHash: hashEditingEvidence(ledgers[chunkIndex]),
			stageKeyHash: hashEditingEvidence({
				identity: model,
				stage: "LOCAL_LEDGER_V1",
				inputHash: stageInputHash,
				promptHash: hash,
				schemaHash,
			}),
		};
	});
	return {
		input,
		chunks,
		ledgers,
		model,
		transcriptFingerprint: hash,
		ledgerRefs,
	};
}

describe("complete FLOW corpus manifest", () => {
	it("keeps all 52 summaries and cards with global source IDs", () => {
		const options = fixture(52);
		const manifest = buildLocalStoryFlowManifest(options);
		expect(manifest.corpus.summaries).toHaveLength(52);
		expect(manifest.corpus.events.map((event) => event.id)).toEqual(
			Array.from({ length: 52 }, (_, i) => `l${i}_e0`),
		);
		expect(manifest.items).toHaveLength(104);
		expect(manifest.items.at(-1)?.id).toBe("l51_e0");
		expect(manifest.coverage).toMatchObject({
			totalChunks: 52,
			totalSummaries: 52,
			totalEvents: 52,
			totalShots: 52,
			eligibleShots: 52,
			processedShots: 52,
			excludedShots: 0,
			truncated: false,
		});
	});
});

function first<T>(values: readonly T[]): T {
	const value = values[0];
	if (value === undefined) throw new Error("FIXTURE_ITEM_MISSING");
	return value;
}
function reseal(options: ReturnType<typeof fixture>) {
	options.ledgerRefs = options.chunks.map((chunk, chunkIndex) => {
		const stageInputHash = hashEditingEvidence({
			chunk,
			transcriptFingerprint: options.transcriptFingerprint,
		});
		const promptHash = hash,
			schemaHash = localStoryStageRegistry().stages.LOCAL_LEDGER_V1.schemaHash;
		return {
			chunkIndex,
			stageInputHash,
			promptHash,
			schemaHash,
			ledgerHash: hashEditingEvidence(options.ledgers[chunkIndex]),
			stageKeyHash: hashEditingEvidence({
				identity: options.model,
				stage: "LOCAL_LEDGER_V1",
				inputHash: stageInputHash,
				promptHash,
				schemaHash,
			}),
		};
	});
}

describe("FLOW manifest input fences", () => {
	it.each([
		"stageInputHash",
		"promptHash",
		"schemaHash",
		"stageKeyHash",
		"ledgerHash",
	] as const)("rejects a changed %s instead of trusting a caller assertion", (field) => {
		const options = fixture();
		first(options.ledgerRefs)[field] = "b".repeat(64);
		expect(() => buildLocalStoryFlowManifest(options)).toThrow(
			"LOCAL_STORY_FLOW_MANIFEST_INVALID",
		);
	});
	it("rejects missing, duplicate and reordered revalidated references", () => {
		for (const change of ["missing", "duplicate", "reordered"]) {
			const options = fixture();
			if (change === "missing") options.ledgerRefs.pop();
			if (change === "duplicate")
				options.ledgerRefs[1] = first(options.ledgerRefs);
			if (change === "reordered") options.ledgerRefs.reverse();
			expect(() => buildLocalStoryFlowManifest(options)).toThrow(
				"LOCAL_STORY_FLOW_MANIFEST_INVALID",
			);
		}
	});
	it("rejects a noncanonical chunk even when its stage hashes are resealed", () => {
		const options = fixture();
		first(first(options.chunks).shots).text += "変更";
		reseal(options);
		expect(() => buildLocalStoryFlowManifest(options)).toThrow(
			"LOCAL_STORY_FLOW_MANIFEST_INVALID",
		);
	});
	it("rejects the aggregate registry hash in the leaf schema slot", () => {
		const options = fixture();
		first(options.ledgerRefs).schemaHash = options.model.schemaHash;
		expect(() => buildLocalStoryFlowManifest(options)).toThrow(
			"LOCAL_STORY_FLOW_MANIFEST_INVALID",
		);
	});
	it("rejects changed transcript and clock fingerprints", () => {
		const options = fixture();
		options.transcriptFingerprint = "b".repeat(64);
		expect(() => buildLocalStoryFlowManifest(options)).toThrow(
			"LOCAL_STORY_FLOW_MANIFEST_INVALID",
		);
		options.transcriptFingerprint = hash;
		options.input.timeMapHash = "b".repeat(64);
		expect(() => buildLocalStoryFlowManifest(options)).toThrow(
			"LOCAL_STORY_FLOW_MANIFEST_INVALID",
		);
	});
	it("does not silently trim a purportedly accepted ledger", () => {
		for (const field of ["summary", "label", "subjects"] as const) {
			const options = fixture(),
				ledger = first(options.ledgers);
			if (field === "summary") ledger.summary = ` ${ledger.summary}`;
			if (field === "label") first(ledger.events).label += " ";
			if (field === "subjects") first(ledger.events).subjects.push(" 鍵 ");
			reseal(options);
			expect(() => buildLocalStoryFlowManifest(options)).toThrow(
				"LOCAL_STORY_FLOW_MANIFEST_INVALID",
			);
		}
	});
	it("preserves canonical Unicode, internal spaces, line breaks and exact quotes", () => {
		const options = fixture(),
			ledger = first(options.ledgers),
			event = first(ledger.events);
		ledger.summary = "人物が\n鍵を  探す。";
		event.label = "人物が　鍵を  見つける";
		event.subjects = ["人物", "鍵  Ａ"];
		const source = first(first(options.input.shots).fields);
		source.text = "人物は\n  鍵を見つける。";
		first(options.input.shots).text = source.text + "あ".repeat(900);
		first(event.quotes).quote = source.text;
		options.chunks = buildLocalStoryChunks(options.input);
		reseal(options);
		const manifest = buildLocalStoryFlowManifest(options);
		expect(first(manifest.corpus.summaries)).toBe(ledger.summary);
		expect(first(manifest.corpus.events)).toMatchObject({
			label: event.label,
			subjects: event.subjects,
			quotes: event.quotes,
		});
	});
});

describe("FLOW manifest coverage and strict cached reader", () => {
	it("retains zero-event summaries and distinguishes excluded from processed refs", () => {
		const options = fixture();
		first(options.ledgers).events = [];
		options.input.coverage.push({ ref: "s99", status: "EXCLUDED" });
		reseal(options);
		const manifest = buildLocalStoryFlowManifest(options);
		expect(manifest.items.map((item) => item.id)).toEqual([
			"u0",
			"u1",
			"l1_e0",
		]);
		expect(manifest.coverage).toMatchObject({
			totalChunks: 2,
			totalSummaries: 2,
			totalEvents: 1,
			totalShots: 3,
			eligibleShots: 2,
			processedShots: 2,
			processedRefs: ["s0", "s1"],
			excludedShots: 1,
		});
	});
	it("rejects inconsistent eligible coverage and duplicate source refs", () => {
		for (const change of ["missing", "duplicate", "wrong-status"]) {
			const options = fixture();
			if (change === "missing") options.input.coverage.pop();
			if (change === "duplicate")
				options.input.coverage.push(first(options.input.coverage));
			if (change === "wrong-status")
				first(options.input.coverage).status = "EXCLUDED";
			expect(() => buildLocalStoryFlowManifest(options)).toThrow(
				"LOCAL_STORY_FLOW_MANIFEST_INVALID",
			);
		}
	});
	it("preserves existing ledger quote and incomplete coverage errors", () => {
		const options = fixture();
		first(first(options.ledgers).events).quotes[0] = {
			ref: "s0",
			quote: "原文に存在しない引用",
		};
		expect(() => buildLocalStoryFlowManifest(options)).toThrow(
			"LOCAL_STORY_EVIDENCE_INVALID",
		);
		const incomplete = fixture();
		incomplete.ledgers.pop();
		expect(() => buildLocalStoryFlowManifest(incomplete)).toThrow(
			"LOCAL_STORY_COVERAGE_INVALID",
		);
	});
	it("validates the entire manifest rather than a self-consistent replacement hash", () => {
		const options = fixture(),
			expected = buildLocalStoryFlowManifest(options);
		for (const change of [
			"tail",
			"label",
			"quote",
			"hash",
			"unknown",
			"undefined-field",
		]) {
			const value = structuredClone(expected);
			if (change === "tail") value.items.pop();
			if (change === "label") first(value.corpus.events).label += "改";
			if (change === "quote")
				first(first(value.corpus.events).quotes).quote += "改";
			if (change === "unknown") Object.assign(value, { extra: 1 });
			if (change === "undefined-field")
				Object.assign(first(value.items), { extra: undefined });
			const { manifestHash: _old, ...body } = value;
			value.manifestHash = change === "hash" ? hash : hashEditingEvidence(body);
			expect(() => validateLocalStoryFlowManifest(value, options)).toThrow(
				"LOCAL_STORY_FLOW_MANIFEST_INVALID",
			);
		}
	});
	it("binds cached manifests to the supplied full input and model", () => {
		const options = fixture(),
			value = buildLocalStoryFlowManifest(options);
		options.model.profile = "amd";
		reseal(options);
		expect(() => validateLocalStoryFlowManifest(value, options)).toThrow(
			"LOCAL_STORY_FLOW_MANIFEST_INVALID",
		);
		const clockOptions = fixture();
		clockOptions.input.timeMap.id = "55555555-5555-4555-8555-555555555555";
		clockOptions.input.timeMapHash = hashEditingEvidence(
			clockOptions.input.timeMap,
		);
		expect(() => validateLocalStoryFlowManifest(value, clockOptions)).toThrow(
			"LOCAL_STORY_FLOW_MANIFEST_INVALID",
		);
	});
	it("does not share mutable caller, corpus, item or cached-reader references", () => {
		const options = fixture(),
			before = canonicalEditingJson(options);
		const manifest = buildLocalStoryFlowManifest(options);
		expect(canonicalEditingJson(options)).toBe(before);
		const read = validateLocalStoryFlowManifest(manifest, options);
		first(manifest.corpus.events).subjects.push("変更");
		const card = manifest.items.find(
			(item) => item.kind === "GROUNDED_LEAF_EVENT_CARD",
		);
		if (card?.kind !== "GROUNDED_LEAF_EVENT_CARD")
			throw new Error("FIXTURE_CARD_MISSING");
		expect(card.subjects).toEqual(["人物", "鍵"]);
		manifest.model.profile = "amd";
		first(manifest.ledgerRefs).promptHash = "b".repeat(64);
		expect(canonicalEditingJson(options)).toBe(before);
		expect(first(read.corpus.events).subjects).toEqual(["人物", "鍵"]);
		expect(read.model.profile).toBe("nvidia");
	});
});

describe("complete FLOW leaf pages", () => {
	it("pages every summary and card in order without leaking machine-only evidence into DATA", () => {
		const manifest = buildLocalStoryFlowManifest(fixture(52));
		const pages = buildLocalStoryFlowLeafPages(manifest);
		expect(pages.length).toBeGreaterThan(1);
		expect(pages.length).toBeLessThanOrEqual(32);
		expect(
			pages.flatMap((page) => page.data.items.map((item) => item.id)),
		).toEqual(manifest.items.map((item) => item.id));
		for (const page of pages) {
			expect(page.data.items.length).toBeLessThanOrEqual(32);
			expect(
				new TextEncoder().encode(JSON.stringify(page.data)).byteLength,
			).toBe(page.dataUtf8Bytes);
			expect(page.dataUtf8Bytes).toBeLessThanOrEqual(4096);
			expect(page.manifestHash).toBe(manifest.manifestHash);
			expect(page.itemIds).toEqual(page.data.items.map((item) => item.id));
			expect(page.itemHashes).toHaveLength(page.itemIds.length);
			expect(page.dataHash).toBe(hashEditingEvidence(page.data));
			expect(JSON.stringify(page.data)).not.toContain("eventHash");
			expect(JSON.stringify(page.data)).not.toContain("quotes");
			expect(JSON.stringify(page.data)).not.toContain("manifestHash");
		}
	});
	it("is deterministic and cuts aliases between returned pages and the manifest", () => {
		const manifest = buildLocalStoryFlowManifest(fixture(20)),
			before = canonicalEditingJson(manifest);
		const pages = buildLocalStoryFlowLeafPages(manifest);
		expect(buildLocalStoryFlowLeafPages(structuredClone(manifest))).toEqual(
			pages,
		);
		const read = validateLocalStoryFlowLeafPages(pages, manifest);
		expect(read).toEqual(pages);
		const card = pages
			.flatMap((page) => page.data.items)
			.find((item) => item.kind === "GROUNDED_LEAF_EVENT_CARD");
		if (card?.kind !== "GROUNDED_LEAF_EVENT_CARD")
			throw new Error("FIXTURE_CARD_MISSING");
		card.subjects.push("変更");
		expect(
			read
				.flatMap((page) => page.data.items)
				.find((item) => item.kind === "GROUNDED_LEAF_EVENT_CARD"),
		).toMatchObject({ subjects: ["人物", "鍵"] });
		expect(canonicalEditingJson(manifest)).toBe(before);
		expect(() => validateLocalStoryFlowLeafPages(pages, manifest)).toThrow(
			"LOCAL_STORY_FLOW_MANIFEST_INVALID",
		);
	});
	it("rejects missing, reordered, duplicated or self-rehashed cached pages", () => {
		const manifest = buildLocalStoryFlowManifest(fixture(52));
		const expected = buildLocalStoryFlowLeafPages(manifest);
		for (const change of [
			"tail",
			"reorder",
			"duplicate",
			"text",
			"hash",
			"unknown",
		]) {
			const pages = structuredClone(expected),
				page = first(pages);
			if (change === "tail") pages.pop();
			if (change === "reorder") pages.reverse();
			if (change === "duplicate") pages[1] = page;
			if (change === "text") first(page.data.items).sourceOrder += 1;
			if (change === "hash") page.dataHash = hash;
			if (change === "unknown") Object.assign(page, { extra: true });
			const { pageHash: _old, ...body } = page;
			page.pageHash = hashEditingEvidence(body);
			expect(() => validateLocalStoryFlowLeafPages(pages, manifest)).toThrow(
				"LOCAL_STORY_FLOW_MANIFEST_INVALID",
			);
		}
	});
});

function exactPageBoundary() {
	const options = fixture(),
		initial = first(
			buildLocalStoryFlowLeafPages(buildLocalStoryFlowManifest(options)),
		);
	let remaining = 4096 - initial.dataUtf8Bytes;
	const grow = (text: string, max: number) => {
		const japanese = Math.min(Math.floor(remaining / 3), max - text.length);
		remaining -= japanese * 3;
		const ascii = Math.min(remaining, max - text.length - japanese);
		remaining -= ascii;
		return text + "あ".repeat(japanese) + "x".repeat(ascii);
	};
	for (const ledger of options.ledgers) {
		ledger.summary = grow(ledger.summary, 320);
		for (const event of ledger.events) {
			event.label = grow(event.label, 120);
			event.subjects = event.subjects.map((subject) => grow(subject, 80));
		}
	}
	expect(remaining).toBe(0);
	reseal(options);
	return options;
}

describe("FLOW page resource boundaries", () => {
	it("keeps exact 4096 UTF-8 bytes and moves the entire last item at +1 byte", () => {
		const options = exactPageBoundary();
		const exact = buildLocalStoryFlowLeafPages(
			buildLocalStoryFlowManifest(options),
		);
		expect(exact).toHaveLength(1);
		expect(first(exact).dataUtf8Bytes).toBe(4096);
		const event = first(first(options.ledgers).events);
		const lastLedger = options.ledgers.at(-1);
		if (!lastLedger) throw new Error("FIXTURE_LEDGER_MISSING");
		const lastEvent = first(lastLedger.events);
		const subject = lastEvent.subjects.findIndex((text) => text.length < 80);
		expect(subject).toBeGreaterThanOrEqual(0);
		lastEvent.subjects[subject] += "x";
		reseal(options);
		const manifest = buildLocalStoryFlowManifest(options),
			split = buildLocalStoryFlowLeafPages(manifest);
		expect(split).toHaveLength(2);
		expect(split.flatMap((page) => page.itemIds)).toEqual(
			manifest.items.map((item) => item.id),
		);
		expect(first(manifest.corpus.events).label).toBe(event.label);
	});
	it("splits item 33 without dropping same-text zero-event chunks", () => {
		const options = fixture(33);
		for (const ledger of options.ledgers) {
			ledger.summary = "x";
			ledger.events = [];
		}
		reseal(options);
		const pages = buildLocalStoryFlowLeafPages(
			buildLocalStoryFlowManifest(options),
		);
		expect(pages.map((page) => page.itemIds.length)).toEqual([32, 1]);
		expect(pages.flatMap((page) => page.itemIds)).toHaveLength(33);
	});
	it("allows 32 complete pages and refuses page 33 without returning a prefix", () => {
		for (const count of [96, 97]) {
			const options = fixture(count);
			for (const ledger of options.ledgers) {
				ledger.summary = "あ".repeat(320);
				ledger.events = [];
			}
			reseal(options);
			const manifest = buildLocalStoryFlowManifest(options);
			if (count === 96)
				expect(buildLocalStoryFlowLeafPages(manifest)).toHaveLength(32);
			else
				expect(() => buildLocalStoryFlowLeafPages(manifest)).toThrow(
					"LOCAL_STORY_FLOW_PAGE_LIMIT",
				);
		}
	});
	it("defensively refuses a self-rehashed oversized DTO without returning or exposing its text", () => {
		const manifest = buildLocalStoryFlowManifest(fixture());
		const summary = first(manifest.items);
		if (summary.kind !== "DERIVED_CHUNK_SUMMARY")
			throw new Error("FIXTURE_SUMMARY_MISSING");
		summary.summary = "未公開".repeat(4096);
		const { manifestHash: _old, ...body } = manifest;
		manifest.manifestHash = hashEditingEvidence(body);
		expect(() => buildLocalStoryFlowLeafPages(manifest)).toThrow(
			/^LOCAL_STORY_FLOW_ITEM_TOO_LARGE$/,
		);
	});
});

describe("FLOW view boundary regressions", () => {
	it("rejects a resealed unknown model registry or unknown ref field", () => {
		const options = fixture();
		options.model.schemaHash = "b".repeat(64);
		reseal(options);
		expect(() => buildLocalStoryFlowManifest(options)).toThrow(
			"LOCAL_STORY_FLOW_MANIFEST_INVALID",
		);
		const extra = fixture();
		Object.assign(first(extra.ledgerRefs), { extra: undefined });
		expect(() => buildLocalStoryFlowManifest(extra)).toThrow(
			"LOCAL_STORY_FLOW_MANIFEST_INVALID",
		);
	});
	it("retains Japanese, escaped quote and newline text in serialized page DATA", () => {
		const options = fixture();
		first(options.ledgers).summary =
			'人物は"鍵"を探す。\n次の場面でも探し続ける。';
		reseal(options);
		const manifest = buildLocalStoryFlowManifest(options),
			pages = buildLocalStoryFlowLeafPages(manifest);
		const wire = JSON.stringify(first(pages).data);
		const decoded: unknown = JSON.parse(wire);
		expect(decoded).toEqual(first(pages).data);
		const summary = first(pages).data.items.find(
			(item) => item.kind === "DERIVED_CHUNK_SUMMARY",
		);
		expect(summary).toMatchObject({ summary: first(options.ledgers).summary });
	});
});

describe("FLOW original complete-coverage errors", () => {
	it("rejects balanced missing, duplicate and reordered chunks without repairing their order", () => {
		for (const change of ["missing", "duplicate", "reorder"]) {
			const options = fixture();
			if (change === "missing") {
				options.chunks.pop();
				options.ledgers.pop();
			}
			if (change === "duplicate") options.chunks[1] = first(options.chunks);
			if (change === "reorder") {
				options.chunks.reverse();
				options.ledgers.reverse();
			}
			reseal(options);
			expect(() => buildLocalStoryFlowManifest(options)).toThrow(
				"LOCAL_STORY_COVERAGE_INVALID",
			);
		}
	});
	it("rejects duplicate or reordered local ledgers whose source refs no longer match the chunk", () => {
		for (const duplicate of [true, false]) {
			const options = fixture();
			if (duplicate) options.ledgers[1] = first(options.ledgers);
			else options.ledgers.reverse();
			reseal(options);
			expect(() => buildLocalStoryFlowManifest(options)).toThrow(
				"LOCAL_STORY_EVIDENCE_INVALID",
			);
		}
	});
	it("rejects the old cache view when a source field changes but the flat chunk still looks the same", () => {
		const options = fixture(),
			cached = buildLocalStoryFlowManifest(options);
		first(first(options.input.shots).fields).text += "別の記述";
		expect(() => validateLocalStoryFlowManifest(cached, options)).toThrow(
			"LOCAL_STORY_FLOW_MANIFEST_INVALID",
		);
	});
});
