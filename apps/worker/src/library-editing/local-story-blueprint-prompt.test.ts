import { randomUUID } from "node:crypto";
import {
	cfrTimeMapSchema,
	hashEditingEvidence,
	type LocalStoryBlueprint,
	type LocalStoryCorpus,
	type LocalStoryInput,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { prepareLocalBlueprintPrompt } from "./local-story-blueprint-prompt";
import {
	type LocalBlueprintRepairMeta,
	localBlueprintCoherenceRepairInstruction,
	localBlueprintExpansionRepairInstruction,
	localBlueprintFitRepairInstruction,
	localBlueprintPrompt,
	localBlueprintRoleRepairInstruction,
	localBlueprintSchemaRepairInstruction,
} from "./local-story-prompts";

function fixture(count = 52, shotFrames = 30) {
	const timeMap = cfrTimeMapSchema.parse({
		id: randomUUID(),
		mediaVersionId: randomUUID(),
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: (count * shotFrames * 1_000_000) / 30,
		editingStartFrame: 0,
		editingEndFrame: count * shotFrames,
		fps: { num: 30, den: 1 },
	});
	const roles = ["CONTEXT", "ACTION", "CHANGE", "OUTCOME", "POINT"] as const;
	const events: LocalStoryCorpus["events"] = Array.from(
		{ length: count },
		(_, i) => ({
			id: `l${i}_e0`,
			role: roles[i % roles.length] ?? "ACTION",
			label: "An observed event has a supported source quote.",
			refs: [`s${i}`],
			quotes: [
				{
					ref: `s${i}`,
					quote: "An observed event has a supported source quote.",
				},
			],
			subjects: ["speaker", "object"],
			uncertainty: "",
		}),
	);
	const input: LocalStoryInput = {
		version: "local-story-input-v1",
		title: "Source",
		description: "Observed events.",
		timeMap,
		timeMapHash: hashEditingEvidence(timeMap),
		scenes: [],
		segments: [],
		coverage: events.map((_, i) => ({ ref: `s${i}`, status: "ELIGIBLE" })),
		shots: events.map((_, i) => ({
			ref: `s${i}`,
			sceneId: "scene0",
			fromFrame: i * shotFrames,
			toFrame: (i + 1) * shotFrames,
			text: "An observed event has a supported source quote.",
			fields: [],
		})),
	};
	const ledger: LocalStoryCorpus = {
		version: "local-story-corpus-v1",
		summaries: ["Observed source events."],
		events,
		coveredRefs: events.flatMap((e) => e.refs),
	};
	return { input, ledger, mode: "FLOW" as const, targetDurationFrames: 900 };
}
const data = (prompt: string) =>
	JSON.parse(prompt.split("\nDATA\n")[1] ?? "{}");
const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function aliasFor(index: number): string {
	return index < 52
		? (alphabet[index] ?? "")
		: `${aliasFor(Math.floor(index / 52) - 1)}${alphabet[index % 52]}`;
}
// Reconstruct in original corpus order from explicit IDs, independently of the
// production packer. Group order must not become narrative/source order.
type TestRow = [string, string, number[], number, number | null];
function cardsFrom(wire: ReturnType<typeof data>, ids: string[]) {
	const byAlias = new Map<string, [string, TestRow]>(
		wire.eligible.flatMap(([role, rows]: [string, TestRow[]], i: number) =>
			[...rows, ...wire.contextOnly[i]].map((row) => [row[0], [role, row]]),
		),
	);
	return ids.map((id, i) => {
		const [role, row] = byAlias.get(aliasFor(i)) as [string, TestRow];
		return [
			id,
			role,
			row[1],
			row[2].map((j) => wire.s[j]),
			row[3],
			row[4],
		] as const;
	});
}
const rowsFrom = (wire: ReturnType<typeof data>) => [
	...wire.eligible.flatMap(([, rows]: [string, unknown[][]]) => rows),
	...wire.contextOnly.flat(),
];
function response(): LocalStoryBlueprint {
	return {
		mode: "FLOW",
		message: "出来事のつながり",
		uncertainty: "",
		beats: [
			{ id: "b0", role: "CONTEXT", eventIds: ["a"], requires: [] },
			{ id: "b1", role: "ACTION", eventIds: ["b"], requires: ["b0"] },
		],
	};
}
function padTo(f: ReturnType<typeof fixture>, bytes: number) {
	let remaining =
		bytes - Buffer.byteLength(prepareLocalBlueprintPrompt(f).prompt);
	expect(remaining).toBeGreaterThan(0);
	for (const event of f.ledger.events) {
		const padding = Math.min(remaining, 120 - event.label.length);
		event.label += "x".repeat(padding);
		remaining -= padding;
	}
	expect(remaining).toBe(0);
	expect(Buffer.byteLength(prepareLocalBlueprintPrompt(f).prompt)).toBe(bytes);
}

describe("bounded lossless Blueprint prompts", () => {
	it("declares distinct beat IDs, beat-only dependencies and the frame rate", () => {
		const prompt = prepareLocalBlueprintPrompt(fixture()).prompt;
		expect(prompt).toContain("Unique beat IDs b1,b2,...");
		expect(prompt).toContain("requires earlier BEAT IDs only");
		expect(prompt).toContain("frames@30fps");
	});

	it("preserves small prompts byte for byte and has no native decoder", () => {
		const f = fixture(3),
			result = prepareLocalBlueprintPrompt(f);
		expect(result.prompt).toBe(localBlueprintPrompt(f));
		expect(result.representation).toBe("FLAT");
		expect(result.decodeNativeOutput).toBeUndefined();
	});
	it("fits all long-form cards while retaining every field, order and eligibility", () => {
		const f = fixture(),
			before = structuredClone(f),
			flat = data(localBlueprintPrompt(f));
		expect(Buffer.byteLength(localBlueprintPrompt(f))).toBeGreaterThan(5632);
		const result = prepareLocalBlueprintPrompt(f),
			wire = data(result.prompt);
		expect(result.representation).toBe("ELIGIBLE_ALIASES_V1");
		expect(Buffer.byteLength(result.prompt)).toBeLessThanOrEqual(5632);
		expect(rowsFrom(wire)).toHaveLength(flat.events.length);
		expect(wire.eligible.map(([role]: [string]) => role)).toEqual([
			"CONTEXT",
			"ACTION",
			"CHANGE",
			"OUTCOME",
			"POINT",
		]);
		const decoded = cardsFrom(
			wire,
			f.ledger.events.map((event) => event.id),
		);
		expect(decoded).toEqual(flat.events);
		for (const [id, role, , , , min] of decoded)
			expect(min !== null && min <= wire.t).toBe(
				flat.allowedEventIdsByRole[role].includes(id),
			);
		for (const [role, rows] of wire.eligible as [string, TestRow[]][])
			expect(
				rows.map(
					([alias]) =>
						decoded.find(
							([id]) =>
								id ===
								f.ledger.events.find((_, i) => aliasFor(i) === alias)?.id,
						)?.[0],
				),
			).toEqual(flat.allowedEventIdsByRole[role]);
		expect(wire.m).toBe(flat.requestedMode);
		expect(wire.t).toBe(flat.targetFrames);
		expect(wire.t / 30).toBe(flat.targetSeconds);
		expect(f).toEqual(before);
	});
	it("retains Unicode distinctions, duplicate subject labels, null and oversized cards", () => {
		const f = fixture();
		const first = f.ledger.events[0];
		if (!first) throw new Error("fixture");
		first.label = '日本語\n"台詞"';
		first.subjects = ["e\u0301", "é", "e\u0301"];
		const firstShot = f.input.shots[0];
		if (!firstShot) throw new Error("fixture");
		firstShot.toFrame = 15;
		f.input.segments = [
			{ startUs: 0, endUs: 20_000_000, text: "One complete long utterance." },
		];
		const flat = data(localBlueprintPrompt(f)),
			wire = data(prepareLocalBlueprintPrompt(f).prompt);
		const restored = cardsFrom(
			wire,
			f.ledger.events.map((event) => event.id),
		);
		expect(restored[0]?.[2]).toBe(first.label);
		expect(restored[0]?.[3]).toEqual(first.subjects);
		expect(restored.map((r) => r[5])).toEqual(
			flat.events.map((r: unknown[]) => r[5]),
		);
		expect(restored.some((r) => r[5] === null)).toBe(true);
		expect(wire.contextOnly.flat().some((r: TestRow) => r[4] === null)).toBe(
			true,
		);
		expect(
			wire.eligible
				.flatMap(([, rows]: [string, TestRow[]]) => rows)
				.every((r: TestRow) => r[4] !== null && r[4] <= wire.t),
		).toBe(true);
		const long = fixture(52, 1200);
		const oversized = data(prepareLocalBlueprintPrompt(long).prompt);
		expect(
			cardsFrom(
				oversized,
				long.ledger.events.map((event) => event.id),
			).map((r) => r[5]),
		).toEqual(
			data(localBlueprintPrompt(long)).events.map((r: unknown[]) => r[5]),
		);
		expect(
			rowsFrom(oversized).some(
				(r: unknown[]) => typeof r[4] === "number" && r[4] > 900,
			),
		).toBe(true);
		expect(rowsFrom(oversized)).toHaveLength(52);
		expect(rowsFrom(wire)).toHaveLength(52);
	});
	it("rejects native selection of known context-only rows before saving a blueprint", () => {
		const f = fixture(52, 1200),
			prepared = prepareLocalBlueprintPrompt(f),
			wire = data(prepared.prompt);
		expect(rowsFrom(wire)).toHaveLength(52);
		expect(
			wire.eligible.every(([, rows]: [string, TestRow[]]) => rows.length === 0),
		).toBe(true);
		expect(wire.contextOnly.flat()).toHaveLength(52);
		expect(() => prepared.decodeNativeOutput?.(response())).toThrow(
			"LOCAL_STORY_NO_FITTING_PLAN",
		);
		const unknown = response();
		if (!unknown.beats[0]) throw new Error("fixture");
		unknown.beats[0].eventIds = ["unknown"];
		expect(() => prepared.decodeNativeOutput?.(unknown)).toThrow(
			"LOCAL_STORY_BLUEPRINT_INVALID",
		);
	});
	it("expands only event references and leaves beat dependencies unchanged", () => {
		const f = fixture(),
			prepared = prepareLocalBlueprintPrompt(f),
			raw = response(),
			before = structuredClone(raw);
		const decoded = prepared.decodeNativeOutput?.(raw) as LocalStoryBlueprint;
		expect(decoded.beats.map((b) => b.eventIds)).toEqual([
			["l0_e0"],
			["l1_e0"],
		]);
		expect(decoded.beats.map((b) => [b.id, b.requires, b.role])).toEqual(
			raw.beats.map((b) => [b.id, b.requires, b.role]),
		);
		expect(raw).toEqual(before);
		f.ledger.events.reverse();
		expect(
			(prepared.decodeNativeOutput?.(raw) as LocalStoryBlueprint).beats[0]
				?.eventIds,
		).toEqual(["l0_e0"]);
	});
	it("uses explicit IDs across alphabet boundaries and never changes a returned role", () => {
		const f = fixture(53),
			prepared = prepareLocalBlueprintPrompt(f),
			wire = data(prepared.prompt),
			raw = response();
		expect(
			cardsFrom(
				wire,
				f.ledger.events.map((event) => event.id),
			),
		).toEqual(data(localBlueprintPrompt(f)).events);
		expect(rowsFrom(wire).map((row: TestRow) => row[0])).toEqual(
			expect.arrayContaining(["z", "A", "Z", "aa"]),
		);
		const beat = raw.beats[0];
		if (!beat) throw new Error("fixture");
		beat.eventIds = ["Z", "aa"];
		// An invalid role is deliberately retained for the existing semantic
		// validator. Native ID decoding must never silently reclassify a beat.
		beat.role = "POINT";
		expect(prepared.decodeNativeOutput?.(raw).beats[0]).toEqual({
			...beat,
			eventIds: ["l51_e0", "l52_e0"],
		});
	});
	it.each([
		"l0_e0",
		"e0",
		"a\n",
		"a\r",
		"aa",
		"aaa",
		"A0",
		"0",
	])("rejects unknown or mixed native reference %s", (alias) => {
		const prepared = prepareLocalBlueprintPrompt(fixture()),
			raw = response();
		const beat = raw.beats[0];
		if (!beat) throw new Error("fixture");
		beat.eventIds = [alias];
		expect(() => prepared.decodeNativeOutput?.(raw)).toThrow();
	});
	it("rejects duplicate event aliases and unknown response fields", () => {
		const prepared = prepareLocalBlueprintPrompt(fixture()),
			raw = response();
		const beat = raw.beats[0];
		if (!beat) throw new Error("fixture");
		beat.eventIds = ["a", "a"];
		expect(() => prepared.decodeNativeOutput?.(raw)).toThrow();
		expect(() =>
			prepared.decodeNativeOutput?.({ ...response(), command: "run" }),
		).toThrow();
	});
	it("preserves every repair conflict with the same event mapping", () => {
		const f = fixture(),
			feedback = {
				beatId: "b0",
				beatRole: "ACTION" as const,
				eventId: "l0_e0",
				eventRole: "CONTEXT" as const,
			};
		const wire = data(
			prepareLocalBlueprintPrompt({ ...f, roleConflicts: [feedback] }).prompt,
		);
		expect(wire.roleConflicts).toEqual([{ ...feedback, eventId: "a" }]);
	});
	it("keeps all grouped role conflicts in the same alias namespace", () => {
		const f = fixture();
		const conflicts = f.ledger.events
			.slice(0, 20)
			.filter((e) => e.role !== "ACTION")
			.map((e) => ({
				beatId: "b0",
				beatRole: "ACTION" as const,
				eventId: e.id,
				eventRole: e.role,
			}));
		const flat = data(localBlueprintPrompt({ ...f, roleConflicts: conflicts }));
		expect(flat.roleConflictFields).toBeDefined();
		const packed = data(
			prepareLocalBlueprintPrompt({ ...f, roleConflicts: conflicts }).prompt,
		);
		expect(packed.roleConflictFields).toEqual(flat.roleConflictFields);
		expect(
			packed.roleConflicts.flatMap(
				(row: [string, string, [string, string][]]) => row[2],
			),
		).toEqual(
			conflicts.map((c) => [
				aliasFor(f.ledger.events.findIndex((e) => e.id === c.eventId)),
				c.eventRole,
			]),
		);
	});
	it("rejects a repair referencing an event outside the complete corpus", () => {
		const f = fixture();
		expect(() =>
			prepareLocalBlueprintPrompt({
				...f,
				roleConflicts: [
					{
						beatId: "b0",
						beatRole: "ACTION",
						eventId: "not_present",
						eventRole: "CONTEXT",
					},
				],
			}),
		).toThrow("LOCAL_STORY_BLUEPRINT_INVALID");
	});
	it("fits the registered role repair while retaining all four violations", () => {
		const f = fixture();
		// Match the full-source pilot's wire size, independently of customer text.
		padTo(f, 5464);
		const conflicts = [0, 2, 3, 4].map((i) => ({
			beatId: `b${i}`,
			beatRole: "ACTION" as const,
			eventId: f.ledger.events[i]?.id ?? "missing",
			eventRole: f.ledger.events[i]?.role ?? "ACTION",
		}));
		for (const attempt of [1, 2]) {
			const result = prepareLocalBlueprintPrompt({
				...f,
				repair: localBlueprintRoleRepairInstruction(attempt),
				roleConflicts: conflicts,
			});
			const wire = data(result.prompt);
			expect(Buffer.byteLength(result.prompt)).toBeLessThanOrEqual(5632);
			expect(rowsFrom(wire)).toHaveLength(52);
			expect(wire.conflicts).toEqual(
				conflicts.map((c) => [
					c.beatId,
					wire.eligible.findIndex(([role]: [string]) => role === c.beatRole),
					aliasFor(f.ledger.events.findIndex((e) => e.id === c.eventId)),
					wire.eligible.findIndex(([role]: [string]) => role === c.eventRole),
				]),
			);
			expect(wire.repair).toContain(`#${attempt}`);
			expect(wire.repair).toContain("[beat,wantedGroup#,id,actualGroup#]");
			expect(wire).not.toHaveProperty("roleConflicts");
			expect(wire).not.toHaveProperty("roleConflictFields");
		}
	});
	it("keeps known fit, coherence and expansion repairs bounded without changing their numeric facts", () => {
		const f = fixture();
		padTo(f, 5430);
		for (const attempt of [1, 2]) {
			const cases: [LocalBlueprintRepairMeta, string][] = [
				[
					{ kind: "SCHEMA", attempt },
					localBlueprintSchemaRepairInstruction(attempt),
				],
				[
					{ kind: "FIT", attempt },
					localBlueprintFitRepairInstruction({
						targetDurationFrames: 900,
						attempt,
					}),
				],
				[
					{ kind: "COHERENCE", attempt },
					localBlueprintCoherenceRepairInstruction(attempt),
				],
				[
					{ kind: "EXPAND", attempt, actualDurationFrames: 601 },
					localBlueprintExpansionRepairInstruction({
						actualDurationFrames: 601,
						targetDurationFrames: 900,
						attempt,
					}),
				],
			];
			for (const [repairMeta, repair] of cases) {
				const prepared = prepareLocalBlueprintPrompt({
						...f,
						repair,
						repairMeta,
					}),
					wire = data(prepared.prompt);
				expect(Buffer.byteLength(prepared.prompt)).toBeLessThanOrEqual(5632);
				expect(rowsFrom(wire)).toHaveLength(52);
				expect(wire.repair).not.toBe(repair);
				expect(wire.repair).toContain(`#${attempt}`);
				if (repairMeta.kind === "EXPAND") {
					expect(wire.repair).toContain("601");
					expect(wire.repair).toContain("900");
				}
				expect(
					cardsFrom(
						wire,
						f.ledger.events.map((e) => e.id),
					),
				).toEqual(data(localBlueprintPrompt(f)).events);
			}
		}
	});
	it("never compresses free-form repair text based only on a supplied repair kind", () => {
		const f = fixture();
		padTo(f, 5430);
		expect(() =>
			prepareLocalBlueprintPrompt({
				...f,
				repair: `${localBlueprintFitRepairInstruction({ targetDurationFrames: 900, attempt: 1 })} unregistered`,
				repairMeta: { kind: "FIT", attempt: 1 },
			}),
		).toThrow("LOCAL_STORY_CONTEXT_LIMIT");
		const small = fixture(3),
			repair = localBlueprintCoherenceRepairInstruction(1);
		expect(
			prepareLocalBlueprintPrompt({
				...small,
				repair,
				repairMeta: { kind: "COHERENCE", attempt: 1 },
			}).prompt,
		).toBe(localBlueprintPrompt({ ...small, repair }));
	});
	it("enforces the complete UTF-8 prompt budget without dropping cards", () => {
		const f = fixture(),
			once = prepareLocalBlueprintPrompt({ ...f, repair: "x" });
		const n = 5632 - Buffer.byteLength(once.prompt) + 1;
		expect(n).toBeGreaterThan(0);
		const exact = prepareLocalBlueprintPrompt({ ...f, repair: "x".repeat(n) });
		expect(Buffer.byteLength(exact.prompt)).toBe(5632);
		expect(rowsFrom(data(exact.prompt))).toHaveLength(52);
		expect(() =>
			prepareLocalBlueprintPrompt({ ...f, repair: `${"x".repeat(n)}日` }),
		).toThrow("LOCAL_STORY_CONTEXT_LIMIT");
	});
});
