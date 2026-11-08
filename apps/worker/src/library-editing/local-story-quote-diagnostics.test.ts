import { createHash } from "node:crypto";
import {
	type LocalStoryChunk,
	LocalStoryError,
	type LocalStoryInput,
	type LocalStoryLedger,
	validateLocalStoryLedger,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	diagnoseLocalStoryQuotes,
	localStoryQuoteDiagnosticsProgress,
} from "./local-story-quote-diagnostics";

function fixture(quote = "Unobserved synthetic phrase.") {
	const fields = [
		{ pointer: "/f/0", kind: "AISA" as const, text: "Alpha  passage." },
		{ pointer: "/f/1", kind: "ASR" as const, text: " Beta passage." },
		{ pointer: "/f/2", kind: "AISA" as const, text: "A “quoted” line — ends." },
	];
	const context = { sceneId: "scene0", text: "Scene context only." };
	const input: LocalStoryInput = {
		version: "local-story-input-v1",
		title: "Fixture",
		description: "Fixture",
		timeMap: {
			id: "11111111-1111-4111-8111-111111111111",
			mediaVersionId: "22222222-2222-4222-8222-222222222222",
			kind: "CFR",
			sourceStartUs: 0,
			sourceEndUs: 10_000_000,
			editingStartFrame: 0,
			editingEndFrame: 300,
			fps: { num: 30, den: 1 },
		},
		timeMapHash: "a".repeat(64),
		segments: [],
		scenes: [
			{
				...context,
				fields: [{ pointer: "/context", kind: "AISA", text: context.text }],
			},
		],
		coverage: [
			{ ref: "s0", status: "ELIGIBLE" },
			{ ref: "s1", status: "ELIGIBLE" },
		],
		shots: [
			{
				ref: "s0",
				sceneId: "scene0",
				fromFrame: 0,
				toFrame: 150,
				fields,
				text: fields.map((field) => field.text).join("\n"),
			},
			{
				ref: "s1",
				sceneId: "scene0",
				fromFrame: 150,
				toFrame: 300,
				fields: [
					{ pointer: "/other", kind: "AISA", text: "Other shot literal." },
				],
				text: "Other shot literal.",
			},
		],
	};
	const chunk: LocalStoryChunk = {
		id: "chunk0",
		refs: ["s0", "s1"],
		context: [context],
		shots: input.shots.map(({ ref, sceneId, text }) => ({
			ref,
			sceneId,
			text,
		})),
	};
	const ledger: LocalStoryLedger = {
		summary: "A synthetic observation.",
		events: [
			{
				id: "e0",
				label: "A source claim.",
				role: "ACTION",
				refs: ["s0"],
				quotes: [{ ref: "s0", quote }],
				subjects: [],
				uncertainty: "",
			},
		],
	};
	const error = new LocalStoryError(
		"LOCAL_STORY_EVIDENCE_INVALID",
		"QUOTE_NOT_EXACT_SOURCE_SUBSTRING",
	);
	return {
		input,
		chunk,
		ledger,
		error,
		attempt: 1 as const,
		family: "BASE" as const,
	};
}

describe("bounded quote mismatch diagnostics", () => {
	it.each([
		["passage.\n Beta", "sameRefText"],
		["passage. Beta", "sameRefSpaceJoined"],
		["Scene context only.", "chunkContext"],
		["Other shot literal.", "otherChunkRefField"],
		["Alpha passage.", "whitespaceFold"],
		["alpha  passage.", "caseFold"],
		['A "quoted" line - ends.', "typographicFold"],
	] as const)("describes %s as %s while the strict validator still rejects it", (quote, relation) => {
		const f = fixture(quote);
		expect(() => validateLocalStoryLedger(f)).toThrow(
			"LOCAL_STORY_EVIDENCE_INVALID",
		);
		const result = diagnoseLocalStoryQuotes(f);
		expect(result?.mismatchCount).toBe(1);
		expect(result?.mismatches[0]?.matches[relation]).toBe(true);
		expect(result?.mismatches[0]?.matches.sameRefField).toBe(false);
		expect(result?.mismatches[0]?.quoteSha256).toBe(
			createHash("sha256").update(quote).digest("hex"),
		);
		expect(result?.mismatches[0]?.quoteUtf8Bytes).toBe(
			Buffer.byteLength(quote),
		);
	});
	it("caps summaries at two and records only fixed fields, hashes and lengths", () => {
		const f = fixture("RAW_QUOTE_SENTINEL");
		f.ledger.events = Array.from({ length: 6 }, (_, event) => ({
			...(f.ledger.events[0] as LocalStoryLedger["events"][number]),
			id: `e${event}`,
			quotes: Array.from({ length: 3 }, (_, quote) => ({
				ref: "s0",
				quote: `RAW_QUOTE_SENTINEL_${event}_${quote}`,
			})),
		}));
		const result = diagnoseLocalStoryQuotes(f);
		expect(result?.mismatchCount).toBe(18);
		expect(result?.truncated).toBe(true);
		expect(result?.mismatches.map((mismatch) => mismatch.quoteIndex)).toEqual([
			0, 1,
		]);
		const progress = localStoryQuoteDiagnosticsProgress(result ? [result] : []);
		expect(progress).toHaveLength(1);
		expect(JSON.stringify(progress)).not.toContain("RAW_QUOTE_SENTINEL");
		expect(JSON.stringify(progress)).not.toContain("Alpha");
		expect(JSON.stringify(progress).length).toBeLessThan(2048);
		expect(Object.keys(progress?.[0] ?? {}).sort()).toEqual([
			"attempt",
			"family",
			"mismatchCount",
			"mismatches",
			"truncated",
		]);
	});
	it("counts only mismatches and retains the event-local quote ordinal", () => {
		const f = fixture();
		f.ledger.events[0]?.quotes.unshift({ ref: "s0", quote: "Alpha  passage." });
		expect(diagnoseLocalStoryQuotes(f)?.mismatches[0]?.quoteIndex).toBe(1);
		expect(diagnoseLocalStoryQuotes(f)?.mismatchCount).toBe(1);
		expect(diagnoseLocalStoryQuotes(f)?.mismatches[0]?.eventIndex).toBe(0);
		expect(diagnoseLocalStoryQuotes(f)?.truncated).toBe(false);
	});
	it("retains the event index of the first rejected quote after a valid event", () => {
		const f = fixture(),
			event = f.ledger.events[0];
		if (!event) throw new Error("Expected authored event");
		f.ledger.events = [
			{ ...event, quotes: [{ ref: "s0", quote: "Alpha  passage." }] },
			{ ...event, id: "e1" },
		];
		expect(diagnoseLocalStoryQuotes(f)?.mismatches[0]).toMatchObject({
			eventIndex: 1,
			quoteIndex: 0,
		});
	});
	it("keeps multiple relationship flags and at most three bounded attempts", () => {
		const f = fixture("Other shot literal.");
		const context = f.chunk.context[0];
		if (!context) throw new Error("Expected authored context");
		context.text = "Other shot literal.";
		const first = diagnoseLocalStoryQuotes(f),
			second = diagnoseLocalStoryQuotes({ ...f, attempt: 2, family: "QUOTE" }),
			third = diagnoseLocalStoryQuotes({ ...f, attempt: 3, family: "ASR" });
		if (!first || !second || !third)
			throw new Error("Expected authored diagnostics");
		expect(first.mismatches[0]?.matches).toMatchObject({
			chunkContext: true,
			otherChunkRefField: true,
		});
		const progress = localStoryQuoteDiagnosticsProgress([first, second, third]);
		expect(progress).toHaveLength(3);
		expect(Buffer.byteLength(JSON.stringify(progress))).toBeLessThan(4096);
	});
	it("requires the trusted error, strict output schema, and a real mismatch", () => {
		const f = fixture();
		expect(
			diagnoseLocalStoryQuotes({
				...f,
				error: { code: f.error.code, rule: f.error.rule },
			}),
		).toBeUndefined();
		expect(
			diagnoseLocalStoryQuotes({
				...f,
				error: new LocalStoryError(
					"LOCAL_STORY_EVIDENCE_INVALID",
					"EVENT_REFS_INVALID",
				),
			}),
		).toBeUndefined();
		expect(
			diagnoseLocalStoryQuotes({
				...f,
				ledger: { ...f.ledger, RAW_EXTRA_SENTINEL: "https://secret.invalid/" },
			}),
		).toBeUndefined();
		expect(
			diagnoseLocalStoryQuotes(fixture("Alpha  passage.")),
		).toBeUndefined();
	});
	it("fails closed for unbounded attempt/family and source lookup failures", () => {
		const f = fixture();
		expect(
			diagnoseLocalStoryQuotes({ ...f, attempt: 4 as never }),
		).toBeUndefined();
		expect(
			diagnoseLocalStoryQuotes({
				...f,
				family: "RAW_FAMILY_SENTINEL" as never,
			}),
		).toBeUndefined();
		expect(diagnoseLocalStoryQuotes({ ...f, family: "ASR" })).toBeUndefined();
		Object.defineProperty(f.input, "shots", {
			get: () => {
				throw new Error("RAW_LOOKUP_SENTINEL");
			},
		});
		expect(diagnoseLocalStoryQuotes(f)).toBeUndefined();
	});
	it("does not publish caller-forged metadata or duplicate/unbounded attempt objects", () => {
		const result = diagnoseLocalStoryQuotes(fixture());
		expect(result).toBeDefined();
		expect(
			localStoryQuoteDiagnosticsProgress([
				{ attempt: 1, family: "BASE", RAW_SENTINEL: true } as never,
			]),
		).toBeUndefined();
		if (!result) throw new Error("Expected authored diagnostic");
		expect(
			localStoryQuoteDiagnosticsProgress([{ ...result } as never]),
		).toBeUndefined();
		expect(
			localStoryQuoteDiagnosticsProgress([result, result]),
		).toBeUndefined();
		expect(
			localStoryQuoteDiagnosticsProgress([result, result, result, result]),
		).toBeUndefined();
	});
});
