import { describe, expect, it } from "vitest";
import {
	localStoryBlueprintSchema,
	localStoryCorpusSchema,
	localStoryEvidenceSchema,
	localStoryLedgerSchema,
	localStoryModelIdentitySchema,
} from "./local-story-contracts";
import {
	buildLocalStoryChunks,
	buildLocalStoryInput,
	mergeLocalStoryLedgers,
	validateLocalStoryBlueprint,
	validateLocalStoryLedger,
} from "./local-story-input";
import { selectLocalStoryClips } from "./local-story-planner";
import { buildPreparedShotPartition } from "./prepared-shot-partition";
import {
	fixtureItem as item,
	preparedClockFixture,
} from "./prepared-shot-partition.test-fixtures";

const sceneId = "11111111-1111-4111-8111-111111111111";
function fixture() {
	const descriptions = [
		"A bag is missing from the owner.",
		"A dog approaches the bag.",
		"The dog picks up the bag.",
		"The dog carries the bag.",
		"The dog gives the bag to its owner.",
		"The owner receives the bag.",
	];
	const analysis = {
		providerVersion: "fixture-v1",
		duration: 30,
		title: "The returned bag",
		description: "A dog returns a missing bag.",
		scenes: [
			{
				id: sceneId,
				startInSeconds: 0,
				endInSeconds: 30,
				type: "MAIN_CONTENT",
				title: "A bag returns",
				summary: "A dog returns the owner's bag.",
				content: {
					objects: [
						{
							category: "bag",
							description: "The missing bag is the object being returned.",
						},
					],
				},
				shots: descriptions.map((detailedDescription, i) => ({
					startInSeconds: i * 5,
					endInSeconds: (i + 1) * 5,
					detailedDescription,
					mainSubjects: [
						{
							classification: "dog",
							description: "A small brown dog.",
							appearanceTimeInSeconds: 0,
							centerX: 50,
							centerY: 50,
						},
					],
				})),
			},
		],
	};
	const timeMap = {
		id: "22222222-2222-4222-8222-222222222222",
		mediaVersionId: "33333333-3333-4333-8333-333333333333",
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: 30_000_000,
		editingStartFrame: 0,
		editingEndFrame: 900,
		fps: { num: 30, den: 1 },
	};
	const input = buildLocalStoryInput({ analysis, timeMap });
	const ledger = localStoryLedgerSchema.parse({
		summary: "The bag is missing and the dog returns it.",
		events: [0, 2, 4].map((n, i) => ({
			id: `e${i}`,
			label: [
				"The bag is missing",
				"The dog picks up the bag",
				"The owner gets the bag",
			][i],
			role: ["CONTEXT", "ACTION", "OUTCOME"][i],
			refs: [`s${n}`],
			quotes: [{ ref: `s${n}`, quote: descriptions[n] }],
			subjects: ["dog", "bag"],
			uncertainty: "",
		})),
	});
	const blueprint = localStoryBlueprintSchema.parse({
		mode: "FLOW",
		message: "A dog returns a missing bag.",
		beats: [0, 1, 2].map((i) => ({
			id: `b${i}`,
			role: ["CONTEXT", "ACTION", "OUTCOME"][i],
			eventIds: [`e${i}`],
			requires: i ? [`b${i - 1}`] : [],
		})),
		uncertainty: "",
	});
	return { analysis, timeMap, input, ledger, blueprint };
}

describe("local story contracts and complete evidence input", () => {
	it("rejects a legacy coding-agent identity and model supplied media times", () => {
		expect(
			localStoryModelIdentitySchema.safeParse({ provider: "CODEX_CLI" })
				.success,
		).toBe(false);
		const f = fixture();
		expect(localStoryLedgerSchema.safeParse(f.ledger).success).toBe(true);
		expect(
			localStoryBlueprintSchema.safeParse({ ...f.blueprint, startInSeconds: 1 })
				.success,
		).toBe(false);
	});
	it("covers every shot and includes source object, subject and transcript evidence", () => {
		const f = fixture();
		const input = buildLocalStoryInput({
			...f,
			segments: [
				{ startUs: 500_000, endUs: 1_000_000, text: "Where is my bag?" },
			],
		});
		expect(input.coverage).toHaveLength(6);
		expect(input.shots).toHaveLength(6);
		expect(
			input.shots[0]?.fields.some(
				(v) => v.kind === "ASR" && v.text === "Where is my bag?",
			),
		).toBe(true);
		expect(
			input.shots[0]?.fields.some((v) => v.text.includes("small brown dog")),
		).toBe(true);
		expect(input.scenes[0]?.text).toContain("missing bag is the object");
	});
	it("splits into bounded chunks without sampling away the middle or end", () => {
		const f = fixture();
		const chunks = buildLocalStoryChunks(f.input, {
			maxBytes: 1600,
			maxShots: 2,
		});
		expect(chunks.flatMap((c) => c.refs)).toEqual(
			f.input.shots.map((s) => s.ref),
		);
		expect(
			chunks.every(
				(c) => new TextEncoder().encode(JSON.stringify(c)).byteLength <= 1600,
			),
		).toBe(true);
	});
	it("rejects a single field that cannot fit rather than truncating its evidence", () => {
		const f = fixture();
		item(item(f.analysis.scenes[0]).shots[0]).detailedDescription = "x".repeat(
			10_000,
		);
		const input = buildLocalStoryInput(f);
		expect(() => buildLocalStoryChunks(input)).toThrow(
			"LOCAL_STORY_INPUT_LIMIT",
		);
	});
	it("uses factory-owned prepared shot boundaries and rejects a copied partition", () => {
		const f = preparedClockFixture();
		const preparedPartition = buildPreparedShotPartition({
			...f,
			normalization: f.proof,
		});
		const input = buildLocalStoryInput({ ...f, preparedPartition });
		expect(input.normalizationReceiptHash).toBe(
			preparedPartition.normalizationReceiptHash,
		);
		expect(input.shots[0]?.fromFrame).toBe(
			preparedPartition.entries[0]?.fromFrame,
		);
		expect(() =>
			buildLocalStoryInput({
				...f,
				preparedPartition: { ...preparedPartition },
			}),
		).toThrow("PREPARED_PARTITION_FACTORY_REQUIRED");
	});
	it("rejects invented refs, quotations and numerals omitted from the quotation", () => {
		const f = fixture(),
			chunk = item(buildLocalStoryChunks(f.input)[0]);
		expect(() =>
			validateLocalStoryLedger({
				input: f.input,
				chunk,
				ledger: {
					...f.ledger,
					events: [{ ...f.ledger.events[0], refs: ["s99"] }],
				},
			}),
		).toThrow();
		expect(() =>
			validateLocalStoryLedger({
				input: f.input,
				chunk,
				ledger: {
					...f.ledger,
					events: [
						{
							...f.ledger.events[0],
							quotes: [{ ref: "s0", quote: "invented words" }],
						},
					],
				},
			}),
		).toThrow();
		expect(() =>
			validateLocalStoryLedger({
				input: f.input,
				chunk,
				ledger: {
					...f.ledger,
					events: [
						{ ...f.ledger.events[0], label: "The overwrite is 100% complete" },
					],
				},
			}),
		).toThrow("LOCAL_STORY_EVIDENCE_UNSUPPORTED");
	});
	it.each([
		["duplicate-id", "EVENT_IDS_DUPLICATED"],
		["reference", "EVENT_REFS_INVALID"],
		["quote-reference", "EVENT_QUOTE_REFS_MISMATCH"],
		["quotation", "QUOTE_NOT_EXACT_SOURCE_SUBSTRING"],
		["number", "LABEL_NUMBERS_UNSUPPORTED"],
		["chunk", "CHUNK_REFS_SHOTS_MISMATCH"],
	])("classifies rejected ledger %s with a static failure rule only", (change, rule) => {
		const f = fixture(),
			chunk = structuredClone(item(buildLocalStoryChunks(f.input)[0])),
			ledger = structuredClone(f.ledger),
			event = item(ledger.events[0]),
			sentinel = "RAW_DIAGNOSTIC_SENTINEL";
		if (change === "duplicate-id") ledger.events.push(structuredClone(event));
		if (change === "reference") event.refs = ["s9999"];
		if (change === "quote-reference")
			event.quotes[0] = { ref: "s1", quote: sentinel };
		if (change === "quotation")
			event.quotes[0] = { ref: "s0", quote: sentinel };
		if (change === "number") event.label = "The bag reaches 100%";
		if (change === "chunk") chunk.refs.reverse();
		let failure: unknown;
		try {
			validateLocalStoryLedger({ input: f.input, chunk, ledger });
		} catch (error) {
			failure = error;
		}
		const code =
			change === "number"
				? "LOCAL_STORY_EVIDENCE_UNSUPPORTED"
				: "LOCAL_STORY_EVIDENCE_INVALID";
		expect(failure).toMatchObject({ code, rule, message: code });
		expect(JSON.stringify(failure)).not.toContain(sentinel);
	});
	it("merges chunk-local event IDs deterministically and rejects missing coverage", () => {
		const f = fixture(),
			chunks = buildLocalStoryChunks(f.input, { maxShots: 2 });
		const ledgers = chunks.map((chunk) => ({
			summary: "Observed interval",
			events: [
				{
					...item(f.ledger.events[0]),
					id: "e0",
					refs: [item(chunk.refs[0])],
					quotes: [
						{
							ref: item(chunk.refs[0]),
							quote: item(
								item(f.input.shots.find((s) => s.ref === chunk.refs[0]))
									.fields[0],
							).text,
						},
					],
				},
			],
		}));
		const merged = mergeLocalStoryLedgers({ input: f.input, chunks, ledgers });
		expect(new Set(merged.events.map((e) => e.id)).size).toBe(3);
		expect(() =>
			mergeLocalStoryLedgers({
				input: f.input,
				chunks,
				ledgers: ledgers.slice(1),
			}),
		).toThrow();
	});
	it("requires the actual numeric token and allows equivalent decimal percentage notation", () => {
		const f = fixture();
		item(item(f.analysis.scenes[0]).shots[0]).detailedDescription =
			"The process reaches 1100% then stops.";
		const input = buildLocalStoryInput(f),
			chunk = item(buildLocalStoryChunks(input)[0]);
		const event = {
			...item(f.ledger.events[0]),
			label: "The process reaches 100%",
			quotes: [{ ref: "s0", quote: "The process reaches 1100% then stops." }],
		};
		expect(() =>
			validateLocalStoryLedger({
				input,
				chunk,
				ledger: { summary: "Process", events: [event] },
			}),
		).toThrow("LOCAL_STORY_EVIDENCE_UNSUPPORTED");
		item(item(f.analysis.scenes[0]).shots[0]).detailedDescription =
			"The process reaches 100.00% then stops.";
		const decimalInput = buildLocalStoryInput(f);
		expect(() =>
			validateLocalStoryLedger({
				input: decimalInput,
				chunk: item(buildLocalStoryChunks(decimalInput)[0]),
				ledger: {
					summary: "Process",
					events: [
						{
							...event,
							quotes: [
								{ ref: "s0", quote: "The process reaches 100.00% then stops." },
							],
						},
					],
				},
			}),
		).not.toThrow();
	});
	it("recognizes the percent word used in real AISA as the same quoted numeric unit", () => {
		const f = fixture();
		item(item(f.analysis.scenes[0]).shots[0]).detailedDescription =
			"The progress indicates 4.58 percent.";
		const input = buildLocalStoryInput(f);
		expect(() =>
			validateLocalStoryLedger({
				input,
				chunk: item(buildLocalStoryChunks(input)[0]),
				ledger: {
					summary: "Progress",
					events: [
						{
							...item(f.ledger.events[0]),
							label: "The progress is 4.58%",
							quotes: [
								{ ref: "s0", quote: "The progress indicates 4.58 percent." },
							],
						},
					],
				},
			}),
		).not.toThrow();
	});
	it("requires persisted selection order, one chosen event per beat and complete input coverage", () => {
		const f = fixture(),
			selected = selectLocalStoryClips({ ...f, targetDurationFrames: 450 });
		const value = {
			version: "local-story-evidence-v1",
			method: "LOCAL_LLM_BEAT_PLAN",
			model: {
				version: "local-story-model-v1",
				provider: "LOCAL_OLLAMA",
				profile: "nvidia",
				model: "qwen3.8:27b-q8_0",
				modelDigest: "a".repeat(64),
				runtimeVersion: "0.40.14",
				promptVersion: "local-story-v1",
				schemaHash: "b".repeat(64),
				configId: sceneId,
				context: 8192,
				thinking: false,
			},
			inputHash: "a".repeat(64),
			artifactHash: "a".repeat(64),
			ledgerHash: "a".repeat(64),
			blueprintHash: "a".repeat(64),
			ledger: localStoryCorpusSchema.parse({
				version: "local-story-corpus-v1",
				summaries: [f.ledger.summary],
				events: f.ledger.events,
				coveredRefs: f.input.shots.map((s) => s.ref),
			}),
			blueprint: f.blueprint,
			selection: selected.localStorySelection,
			inputCoverage: {
				totalShots: 6,
				eligibleShots: 6,
				processedShots: 6,
				excludedShots: 0,
				truncated: false,
			},
		};
		expect(localStoryEvidenceSchema.safeParse(value).success).toBe(true);
		expect(
			localStoryEvidenceSchema.safeParse({
				...value,
				selection: { ...value.selection, selectedEventIds: ["e2", "e1", "e0"] },
			}).success,
		).toBe(false);
		expect(
			localStoryEvidenceSchema.safeParse({
				...value,
				ledger: { ...value.ledger, coveredRefs: ["s0"] },
			}).success,
		).toBe(false);
	});
});

describe("beat-based local story planning", () => {
	it("includes quiet setup, action and outcome across source gaps without importance ranking", () => {
		const f = fixture();
		const selected = selectLocalStoryClips({ ...f, targetDurationFrames: 450 });
		expect(selected.clips.map((c) => c.shotIndex)).toEqual([0, 2, 4]);
		expect(selected.actualDurationFrames).toBe(450);
		expect(selected.localStorySelection.selectedEventIds).toEqual([
			"e0",
			"e1",
			"e2",
		]);
	});
	it("fails the whole plan when a required premise cannot fit instead of keeping only the result", () => {
		const f = fixture();
		expect(() =>
			selectLocalStoryClips({ ...f, targetDurationFrames: 300 }),
		).toThrow("LOCAL_STORY_NO_FITTING_PLAN");
	});
	it("rejects a future or unknown context dependency and backward story order", () => {
		const f = fixture();
		expect(() =>
			validateLocalStoryBlueprint({
				ledger: f.ledger,
				blueprint: {
					...f.blueprint,
					beats: [
						{ ...f.blueprint.beats[0], requires: ["b2"] },
						...f.blueprint.beats.slice(1),
					],
				},
			}),
		).toThrow();
		expect(() =>
			selectLocalStoryClips({
				...f,
				blueprint: {
					...f.blueprint,
					beats: [...f.blueprint.beats]
						.reverse()
						.map((b) => ({ ...b, requires: [] })),
				},
				targetDurationFrames: 450,
			}),
		).toThrow("LOCAL_STORY_NO_FITTING_PLAN");
	});
	it("expands through a whole utterance and splits the extra source footage at real cuts", () => {
		const f = fixture();
		const input = buildLocalStoryInput({
			...f,
			segments: [
				{ startUs: 4_500_000, endUs: 5_500_000, text: "Where is my bag?" },
			],
		});
		const result = selectLocalStoryClips({
			...f,
			input,
			ledger: { ...f.ledger, events: [f.ledger.events[0]] },
			blueprint: {
				...f.blueprint,
				beats: [{ ...f.blueprint.beats[0], requires: [] }],
			},
			targetDurationFrames: 180,
		});
		expect(result.clips.map((c) => c.shotIndex)).toEqual([0, 1]);
		expect(result.actualDurationFrames).toBeGreaterThanOrEqual(165);
		expect(result.actualDurationFrames).toBeLessThanOrEqual(180);
	});
	it("uses timed quoted speech for a shorter expression without guessing an AISA event time", () => {
		const f = fixture(),
			input = buildLocalStoryInput({
				...f,
				segments: [
					{ startUs: 500_000, endUs: 1_000_000, text: "Where is my bag?" },
				],
			});
		const result = selectLocalStoryClips({
			...f,
			input,
			ledger: {
				summary: "The owner is looking for the bag",
				events: [
					{
						...item(f.ledger.events[0]),
						quotes: [{ ref: "s0", quote: "Where is my bag?" }],
					},
				],
			},
			blueprint: {
				...f.blueprint,
				beats: [{ ...f.blueprint.beats[0], requires: [] }],
			},
			targetDurationFrames: 45,
		});
		expect(result.clips[0]?.sourceInUs).toBe(400_000);
		expect(result.actualDurationFrames).toBe(21);
		expect(() =>
			selectLocalStoryClips({
				...f,
				input,
				ledger: { ...f.ledger, events: [f.ledger.events[0]] },
				blueprint: {
					...f.blueprint,
					beats: [{ ...f.blueprint.beats[0], requires: [] }],
				},
				targetDurationFrames: 45,
			}),
		).toThrow("LOCAL_STORY_NO_FITTING_PLAN");
	});
	it("keeps nonzero original presentation origins in the final source timestamps", () => {
		const f = fixture();
		f.timeMap.sourceStartUs = 10_000_000;
		f.timeMap.sourceEndUs = 40_000_000;
		f.analysis.duration = 40;
		item(f.analysis.scenes[0]).startInSeconds = 10;
		item(f.analysis.scenes[0]).endInSeconds = 40;
		for (const shot of item(f.analysis.scenes[0]).shots) {
			shot.startInSeconds += 10;
			shot.endInSeconds += 10;
		}
		const input = buildLocalStoryInput(f),
			result = selectLocalStoryClips({
				...f,
				input,
				targetDurationFrames: 450,
			});
		expect(result.clips.map((s) => s.sourceInUs)).toEqual([
			10_000_000, 20_000_000, 30_000_000,
		]);
	});
});
