import { createHash, randomUUID } from "node:crypto";
import {
	buildLocalStoryChunks,
	buildLocalStoryFlowManifest,
	buildLocalStoryInput,
	cfrTimeMapSchema,
	hashEditingEvidence,
	LOCAL_SEMANTIC_MODEL,
	LOCAL_SEMANTIC_MODEL_DIGEST,
	LOCAL_SEMANTIC_OUTPUT_TOKENS,
	LOCAL_SEMANTIC_RUNTIME_VERSION,
	type LocalSemanticReceipt,
	type LocalStoryBlueprint,
	type LocalStoryChunk,
	LocalStoryError,
	type LocalStoryLedger,
	localSemanticJobRequestSchema,
	localSemanticReceiptSchema,
	localSemanticStageRegistry,
	localStoryChoiceStageRegistry,
	localStoryEvidenceSchema,
	normalizeSceneAnalysis,
	TRANSCRIPTION_POLICY_FINGERPRINT,
} from "@bitovp/core";
import type { AppPrismaClient, LibraryMediaTask } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createLocalSemanticClient } from "./local-semantic-client";
import type { LocalStoryArtifactStore } from "./local-story-artifacts";
import * as asrQuoteRepair from "./local-story-asr-quote-repair";
import * as blueprintPrompt from "./local-story-blueprint-prompt";
import { createLocalStoryEngine } from "./local-story-engine";
import {
	createLegacyLocalStoryLedgerCache,
	createLegacyV2LocalStoryLedgerCache,
	createLegacyV3LocalStoryLedgerCache,
	createLocalStoryLedgerCache,
	LOCAL_STORY_LEDGER_VALIDATION_POLICY,
	LOCAL_STORY_LEGACY_LEDGER_VALIDATION_POLICY,
} from "./local-story-ledger-cache";
import {
	LOCAL_LEDGER_GENERIC_REPAIR_SUFFIX,
	localBlueprintCoherenceRepairInstruction,
	localBlueprintExpansionRepairInstruction,
	localBlueprintFitRepairInstruction,
	localBlueprintSchemaRepairInstruction,
	localLedgerPrompt,
	localLegacyV3StructuredLedgerRepairPrompt,
	localNumericLedgerRepairPrompt,
	localQuoteLedgerRepairPrompt,
	localStructuredLedgerRepairPrompt,
} from "./local-story-prompts";
import * as quoteDiagnostics from "./local-story-quote-diagnostics";
import type { VerifiedMediaTask } from "./media-task-execution";
import { MediaOperationError } from "./process";

const mocks = vi.hoisted(() => ({
	createStore: vi.fn(),
	prepareTranscript: vi.fn(),
}));
vi.mock("./local-story-artifacts", () => ({
	createLocalStoryArtifactStore: mocks.createStore,
}));
vi.mock("./local-story-transcript", () => ({
	prepareLocalStoryTranscript: mocks.prepareTranscript,
}));

type Run = ReturnType<typeof createLocalSemanticClient>["run"];
type Request = ReturnType<typeof localSemanticJobRequestSchema.parse>;
type BlueprintData = {
	targetSeconds: number;
	events: [
		string,
		LocalStoryLedger["events"][number]["role"],
		string,
		string[],
		number,
		number,
	][];
};
function payload<T>(prompt: string): T {
	const marker = "\nDATA\n",
		index = prompt.lastIndexOf(marker);
	if (index < 0) throw new Error("Missing source-data block in stage prompt");
	// JSON.stringify escapes source newlines. A later repair instruction is a separate line.
	return JSON.parse(
		prompt.slice(index + marker.length).split("\n", 1)[0] ?? "",
	) as T;
}

type CompactBlueprintData = {
	t: number;
	s: string[];
	eligible: [
		LocalStoryLedger["events"][number]["role"],
		[string, string, number[], number, number | null][],
	][];
	contextOnly: [string, string, number[], number, number | null][][];
};
function compactAliasOrder(alias: string): number {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
	return (
		[...alias].reduce((ordinal, character) => {
			const index = alphabet.indexOf(character);
			if (index < 0) throw new Error("Unexpected native test alias");
			return ordinal * alphabet.length + index + 1;
		}, 0) - 1
	);
}
/** The fake model reads both public prompt representations; it emits native aliases only. */
function blueprintData(prompt: string): BlueprintData {
	const data = payload<BlueprintData | CompactBlueprintData>(prompt);
	if (!("eligible" in data)) return data;
	return {
		targetSeconds: data.t / 30,
		events: data.eligible
			.flatMap(([role, rows]) =>
				rows.map<BlueprintData["events"][number]>((event) => [
					event[0],
					role,
					event[1],
					event[2].map((subject) => item(data.s[subject])),
					event[3],
					event[4] ?? Number.POSITIVE_INFINITY,
				]),
			)
			.sort(
				(a, b) =>
					a[4] - b[4] || compactAliasOrder(a[0]) - compactAliasOrder(b[0]),
			),
	};
}

function item<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing authored test item");
	return value;
}
function receipt(body: Request): LocalSemanticReceipt {
	return {
		version: "bitovp-semantic-receipt-v1",
		profile: body.profile,
		model: LOCAL_SEMANTIC_MODEL,
		modelDigest: LOCAL_SEMANTIC_MODEL_DIGEST,
		runtimeVersion: LOCAL_SEMANTIC_RUNTIME_VERSION,
		inputHash: body.inputHash,
		promptHash: createHash("sha256").update(body.prompt).digest("hex"),
		schemaHash: body.schemaHash,
		promptVersion: body.promptVersion,
		context: 8192,
		maxOutputTokens: LOCAL_SEMANTIC_OUTPUT_TOKENS[body.stage],
		thinking: false,
		requestHash: hashEditingEvidence(body),
		elapsedMs: 10,
		apiStats: {
			promptEvalCount: 300,
			evalCount: 100,
			doneReason: "stop",
			loadDurationNs: 1,
			promptEvalDurationNs: 1,
			evalDurationNs: 1,
		},
		placement: [
			{
				name: LOCAL_SEMANTIC_MODEL,
				size: 29_000_000_000,
				sizeVram: 14_000_000_000,
				contextLength: 8192,
			},
		],
		cleanupConfirmed: true,
		schemaVerified: false,
	};
}

function fixture(
	options: {
		useSpeechEvidence?: boolean;
		firstClause?: string;
		clauses?: string[];
		shotPaddingRepeats?: number;
		segments?: { startUs: number; endUs: number; text: string }[];
		modelSha256?: string;
		pinnedAsrModelSha256?: string | null;
		changeLedger?(
			ledger: LocalStoryLedger,
			chunk: LocalStoryChunk,
			prompt: string,
		): LocalStoryLedger;
		blueprint?(data: BlueprintData, attempt: number): LocalStoryBlueprint;
		choice?(
			data: { plans: [string, string, number, string[]][] },
			attempt: number,
		): unknown;
		choiceEnabled?: boolean;
		choiceProbeCode?: string;
	} = {},
) {
	const organizationId = randomUUID(),
		mediaId = randomUUID(),
		sceneId = randomUUID();
	const clauses = options.clauses ?? [
		options.firstClause ?? "The owner's bag is missing.",
		"The dog approaches the bag.",
		"The dog picks up the bag.",
		"The dog carries the bag.",
		"The dog returns the bag to its owner.",
		"The owner receives the bag.",
	];
	const analysis = normalizeSceneAnalysis({
		metadata: { version: "authored-local-story-engine-test" },
		title: "A returned bag",
		description: "A dog returns a missing bag.",
		duration: clauses.length * 5,
		scenes: [
			{
				id: sceneId,
				type: "MAIN_CONTENT",
				title: "The bag",
				summary: "A missing bag is returned.",
				startInSeconds: 0,
				endInSeconds: clauses.length * 5,
				content: {
					objects: [{ category: "bag", description: "The missing bag." }],
				},
				shots: clauses.map((clause, index) => ({
					startInSeconds: index * 5,
					endInSeconds: (index + 1) * 5,
					// Long but valid source fields ensure the real byte budget creates several chunks.
					detailedDescription:
						clause +
						" An authored background observation.".repeat(
							options.shotPaddingRepeats ?? 50,
						),
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
	});
	const timeMap = cfrTimeMapSchema.parse({
		id: randomUUID(),
		mediaVersionId: mediaId,
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: clauses.length * 5_000_000,
		editingStartFrame: 0,
		editingEndFrame: clauses.length * 150,
		fps: { num: 30, den: 1 },
	});
	const segments = options.segments ?? [
		{ startUs: 500_000, endUs: 1_000_000, text: "Where is my bag?" },
	];
	const values = new Map<string, unknown>();
	const loads: unknown[] = [];
	const loadFault = vi.fn<(key: unknown) => void>();
	const saveFault = vi.fn<(key: unknown) => void>();
	const store: LocalStoryArtifactStore = {
		async load<T>(request: {
			kind: string;
			key: unknown;
			parse(value: unknown): T;
			build(): Promise<T>;
		}) {
			loads.push(structuredClone(request.key));
			loadFault(request.key);
			const key = hashEditingEvidence({ kind: request.kind, key: request.key });
			const cached = values.has(key);
			let value: T;
			if (cached) {
				try {
					value = request.parse(structuredClone(values.get(key)));
				} catch {
					throw new MediaOperationError("LOCAL_STORY_ARTIFACT_UNVERIFIED");
				}
			} else value = request.parse(await request.build());
			if (!cached) {
				saveFault(request.key);
				// Mirror the store transaction's winner re-read after the ordinary save fence.
				if (values.has(key)) {
					try {
						value = request.parse(structuredClone(values.get(key)));
					} catch {
						throw new MediaOperationError("LOCAL_STORY_ARTIFACT_UNVERIFIED");
					}
					return { value, cached: true, hash: hashEditingEvidence(value) };
				}
				values.set(key, structuredClone(value));
			}
			return { value, cached, hash: hashEditingEvidence(value) };
		},
	};
	mocks.createStore.mockReturnValue(store);
	mocks.prepareTranscript.mockResolvedValue({
		qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
		segments,
		status: "READY",
		fingerprint: hashEditingEvidence(segments),
		warnings: [],
		modelSha256: "b".repeat(64),
		cached: true,
	});
	const requests: Request[] = [];
	let blueprintAttempt = 0;
	let choiceAttempt = 0;
	const choiceProbe = vi.fn(async () => ({
		code: options.choiceProbeCode ?? "READY",
	}));
	const run = vi.fn<Run>(async (input) => {
		input.signal.throwIfAborted();
		const { signal: _signal, ...bodyFields } = input;
		const body = localSemanticJobRequestSchema.parse(bodyFields);
		expect(Buffer.byteLength(body.prompt)).toBeLessThanOrEqual(
			8192 - LOCAL_SEMANTIC_OUTPUT_TOKENS[body.stage] - 1024,
		);
		requests.push(body);
		let content: unknown;
		if (body.stage === "LOCAL_LEDGER_V1") {
			const packed = payload<
				Omit<LocalStoryChunk, "shots"> & {
					shots: {
						ref: string;
						sceneId: string;
						text?: string;
						fields?: string[];
					}[];
				}
			>(body.prompt);
			const chunk: LocalStoryChunk = {
					...packed,
					shots: packed.shots.map((shot) => {
						const text = shot.text ?? shot.fields?.join("\n");
						if (text === undefined)
							throw new Error("Missing authored source text");
						return { ref: shot.ref, sceneId: shot.sceneId, text };
					}),
				},
				shot = item(chunk.shots[0]);
			const index = Number(shot.ref.slice(1));
			const useSpeech = options.useSpeechEvidence && index === 0;
			const ledger: LocalStoryLedger = {
				summary: "The owner, dog and bag form one observed situation.",
				events: [
					{
						id: "e0",
						label: useSpeech
							? "The owner asks where the bag is"
							: item(clauses[index]),
						role: index === 0 ? "CONTEXT" : index < 4 ? "ACTION" : "OUTCOME",
						refs: [shot.ref],
						quotes: [
							{
								ref: shot.ref,
								quote: useSpeech
									? (segments[0]?.text ?? "")
									: item(clauses[index]),
							},
						],
						subjects: ["dog", "bag"],
						uncertainty: "",
					},
				],
			};
			content = options.changeLedger
				? options.changeLedger(ledger, chunk, body.prompt)
				: ledger;
		} else if (body.stage === "LOCAL_STORY_CHOICE_V1") {
			const data = payload<{ plans: [string, string, number, string[]][] }>(
				body.prompt,
			);
			choiceAttempt++;
			content = options.choice
				? options.choice(data, choiceAttempt)
				: {
						planId: item(data.plans[0])[0],
						message: "犬と鞄の様子を紹介する。",
						uncertainty: "",
					};
		} else {
			const data = blueprintData(body.prompt);
			blueprintAttempt++;
			content = options.blueprint
				? options.blueprint(data, blueprintAttempt)
				: {
						mode: "FLOW",
						message: "犬が忘れ物の鞄を持ち主へ返す。",
						beats: data.events.map((event, i) => ({
							id: `b${i}`,
							role: event[1],
							eventIds: [event[0]],
							requires: i ? [`b${i - 1}`] : [],
						})),
						uncertainty: "",
					};
		}
		return { content, receipt: receipt(body) };
	});
	const config = {
		url: "https://fixture.invalid/",
		token: "test-token-".repeat(4),
		caFile: "/not-read/ca.pem",
		profile: "nvidia" as const,
		configId: randomUUID(),
	};
	const engine = createLocalStoryEngine({
		prisma: {} as AppPrismaClient,
		config,
		client: { run } satisfies Pick<
			ReturnType<typeof createLocalSemanticClient>,
			"run"
		>,
		env: {
			BITOVP_LOCAL_STORY_CHOICE_ENABLED: options.choiceEnabled
				? "1"
				: undefined,
		},
		choiceProbe,
		...(options.modelSha256
			? { model: { path: "/not-read/model.bin", sha256: options.modelSha256 } }
			: {}),
	});
	const task = {
		id: randomUUID(),
		organizationId,
		mediaVersionId: mediaId,
		analysisRevisionId: randomUUID(),
		kind: "GENERATE",
	} as LibraryMediaTask;
	const verified = {
		envelope: {
			identity: { modelSha256: options.pinnedAsrModelSha256 ?? null },
		},
		media: {
			id: mediaId,
			organizationId,
			sourceId: randomUUID(),
			sha256: "a".repeat(64),
		},
		map: timeMap,
		analysisDocument: analysis,
	} as VerifiedMediaTask;
	const parameters = {
		contentId: randomUUID(),
		targetDurationFrames: 450,
		policy: "LOCAL_STORY" as const,
		storyMode: "AUTO" as const,
		renderMode: "DRAFT" as const,
		draftPolicyVersion: "duration-review-v2" as const,
		variants: 1 as const,
		captions: "OFF" as const,
		tracking: false,
		language: "en" as const,
	};
	const context = {
		task,
		verified,
		parameters,
		leaseToken: randomUUID(),
		sourcePath: "/not-read/source.mp4",
		hasAudio: true,
		signal: new AbortController().signal,
		onProgress: vi.fn(
			async (_phase: string, _progress?: Record<string, unknown>) => {},
		),
	};
	const input = buildLocalStoryInput({ analysis, timeMap, segments });
	const chunks = buildLocalStoryChunks(input);
	return {
		engine,
		context,
		run,
		requests,
		values,
		loads,
		loadFault,
		saveFault,
		input,
		chunks,
		segments,
		config,
		choiceProbe,
	};
}

function artifactsOfVersion(values: Map<string, unknown>, version: string) {
	return [...values.values()].filter(
		(value): value is Record<string, unknown> =>
			!!value &&
			typeof value === "object" &&
			"version" in value &&
			value.version === version,
	);
}

function failures(f: ReturnType<typeof fixture>) {
	return f.context.onProgress.mock.calls.flatMap(([, progress]) =>
		progress?.localStoryFailure ? [progress.localStoryFailure] : [],
	);
}

function acceptedPolicy(key: unknown) {
	return key && typeof key === "object" && "validationPolicyVersion" in key
		? key.validationPolicyVersion
		: undefined;
}

/** Synthetic v1 receipts around the unchanged successful stage; never a production migration. */
function seedLegacyPointers(
	f: ReturnType<typeof fixture>,
	version: 1 | 2 | 3 = 1,
	family?:
		| "base"
		| "generic"
		| "numeric"
		| "quote"
		| "asr"
		| "structured-quote"
		| "structured-asr",
) {
	return f.chunks.map((chunk) => {
		const options = {
			identity: f.engine.identity,
			input: f.input,
			chunk,
			transcriptFingerprint: hashEditingEvidence(f.segments),
			definition: localSemanticStageRegistry().stages.LOCAL_LEDGER_V1,
			validationPolicyVersion: LOCAL_STORY_LEDGER_VALIDATION_POLICY,
		};
		const current = createLocalStoryLedgerCache(options),
			legacy =
				version === 3
					? createLegacyV3LocalStoryLedgerCache(options)
					: version === 2
						? createLegacyV2LocalStoryLedgerCache(options)
						: createLegacyLocalStoryLedgerCache(options);
		const mapKey = (key: unknown) =>
			hashEditingEvidence({ kind: "LOCAL_STORY_LEDGER_V1", key });
		const currentKey = mapKey(current.key),
			legacyKey = mapKey(legacy.key);
		const pointer = current.parse(f.values.get(currentKey));
		let prompt = pointer.prompt;
		if (family && chunk.refs.includes("s0")) {
			const base = localLedgerPrompt(chunk);
			if (family === "base") prompt = base;
			if (family === "generic")
				prompt = base + LOCAL_LEDGER_GENERIC_REPAIR_SUFFIX;
			if (family === "numeric")
				prompt = item(localNumericLedgerRepairPrompt(chunk));
			if (family === "quote")
				prompt = item(localQuoteLedgerRepairPrompt(chunk));
			if (family === "structured-quote" || family === "structured-asr")
				prompt = item(
					localLegacyV3StructuredLedgerRepairPrompt({
						input: f.input,
						chunk,
						family: family === "structured-quote" ? "QUOTE" : "ASR",
					}),
				);
			if (family === "asr") {
				const fields = item(
					f.input.shots.find((shot) => shot.ref === "s0"),
				).fields.filter((field) => field.kind === "ASR");
				prompt = item(
					asrQuoteRepair.localAsrQuoteRepairPrompt({
						input: f.input,
						chunk,
						ledger: {
							summary: "Observed speech.",
							events: [
								{
									id: "e0",
									label: "A speaker responds.",
									role: "ACTION",
									refs: ["s0"],
									quotes: [
										{
											ref: "s0",
											quote: fields
												.map((field) => field.text.replace(/\s+/gu, " ").trim())
												.join(" "),
										},
									],
									subjects: [],
									uncertainty: "",
								},
							],
						},
					}),
				);
			}
			if (prompt !== pointer.prompt) {
				const original = item(
					artifactsOfVersion(f.values, "local-semantic-stage-result-v1").find(
						(value) =>
							(value.receipt as LocalSemanticReceipt).promptHash ===
							createHash("sha256").update(pointer.prompt).digest("hex"),
					),
				);
				const body = localSemanticJobRequestSchema.parse({
					version: "bitovp-semantic-job-v1",
					organizationId: f.context.task.organizationId,
					requestKey: original.requestKey,
					profile: f.engine.identity.profile,
					stage: "LOCAL_LEDGER_V1",
					prompt,
					inputHash: hashEditingEvidence(current.stageInput),
					promptVersion: f.engine.identity.promptVersion,
					schemaHash: options.definition.schemaHash,
				});
				const key = {
					identity: f.engine.identity,
					stage: "LOCAL_LEDGER_V1",
					inputHash: body.inputHash,
					promptHash: createHash("sha256").update(prompt).digest("hex"),
					schemaHash: body.schemaHash,
				};
				f.values.set(mapKey(key), {
					...structuredClone(original),
					receipt: receipt(body),
				});
			}
		}
		f.values.delete(currentKey);
		f.values.set(legacyKey, legacy.pointer(prompt));
		return { current, legacy, currentKey, legacyKey, prompt, options };
	});
}

function joinedQuoteFixture(
	options: { thirdQuote?: string; onAttempt?(attempt: number): void } = {},
) {
	const speech = [
		" Listen, Celia. I was young.",
		" and a dick.",
		" But there's no reason to destroy the world.",
	].map((text, index) => ({
		text,
		startUs: 100_000 + index * 800_000,
		endUs: 700_000 + index * 800_000,
	}));
	let attempts = 0;
	const f = fixture({
		segments: speech,
		changeLedger: (ledger, chunk) => {
			if (!chunk.refs.includes("s0")) return ledger;
			attempts++;
			options.onAttempt?.(attempts);
			return {
				...ledger,
				events: [
					{
						...item(ledger.events[0]),
						label: "A speaker addresses Celia.",
						quotes: [
							{
								ref: "s0",
								quote:
									attempts < 3
										? speech.map((segment) => segment.text.trim()).join(" ")
										: (options.thirdQuote ?? item(speech[2]).text),
							},
						],
					},
				],
			};
		},
	});
	return { ...f, attempts: () => attempts };
}

beforeEach(() => {
	mocks.createStore.mockReset();
	mocks.prepareTranscript.mockReset();
});

describe("local story engine with real evidence contracts and a fake local model", () => {
	it.each([
		"QUOTE",
		"ASR",
	] as const)("promotes exact v3 structured %s stages without inference or changing old receipts", async (family) => {
		const f = fixture();
		const first = await f.engine.plan(f.context),
			beforeCalls = f.run.mock.calls.length,
			seeded = seedLegacyPointers(
				f,
				3,
				family === "QUOTE" ? "structured-quote" : "structured-asr",
			),
			old = structuredClone([...f.values]);
		f.loads.length = 0;
		f.loadFault.mockImplementation((key) => {
			if (
				acceptedPolicy(key) === "exact-source-ledger-validation-v2" ||
				acceptedPolicy(key) === "exact-source-ledger-validation-v1"
			)
				throw new Error("A valid v3 stage must not fall back further");
		});
		const second = await f.engine.plan({
			...f.context,
			task: { ...f.context.task, id: randomUUID() },
		});
		expect(f.run).toHaveBeenCalledTimes(beforeCalls);
		expect(second.evidence).toEqual(first.evidence);
		for (const [key, value] of old) expect(f.values.get(key)).toEqual(value);
		for (const entry of seeded) {
			expect(f.values.get(entry.currentKey)).toEqual(
				entry.current.pointer(entry.prompt),
			);
			expect(f.values.get(entry.legacyKey)).toEqual(
				entry.legacy.pointer(entry.prompt),
			);
		}
		expect(item(seeded[0]).prompt).toBe(
			localLegacyV3StructuredLedgerRepairPrompt({
				input: f.input,
				chunk: item(f.chunks[0]),
				family,
			}),
		);
		expect(f.values.size).toBe(old.length + f.chunks.length);
	});
	it.each([
		"pointer",
		"stage",
	] as const)("does not rescue corrupt v3 %s with a valid v2 pointer", async (change) => {
		const f = fixture();
		await f.engine.plan(f.context);
		const beforeCalls = f.run.mock.calls.length,
			entries = seedLegacyPointers(f, 3, "structured-quote"),
			first = item(entries[0]);
		for (const entry of entries) {
			const lower = createLegacyV2LocalStoryLedgerCache(entry.options);
			f.values.set(
				hashEditingEvidence({ kind: "LOCAL_STORY_LEDGER_V1", key: lower.key }),
				lower.pointer(localLedgerPrompt(entry.options.chunk)),
			);
		}
		if (change === "pointer")
			f.values.set(first.legacyKey, {
				...first.legacy.pointer(first.prompt),
				stageKeyHash: "f".repeat(64),
			});
		else {
			const promptHash = createHash("sha256")
				.update(first.prompt)
				.digest("hex");
			for (const [key, value] of f.values)
				if (
					value &&
					typeof value === "object" &&
					"receipt" in value &&
					(value.receipt as LocalSemanticReceipt).promptHash === promptHash
				)
					f.values.delete(key);
		}
		f.loads.length = 0;
		await expect(
			f.engine.plan({
				...f.context,
				task: { ...f.context.task, id: randomUUID() },
			}),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
		expect(f.run).toHaveBeenCalledTimes(beforeCalls);
		expect(
			f.loads.some(
				(key) => acceptedPolicy(key) === "exact-source-ledger-validation-v2",
			),
		).toBe(false);
		expect(f.values.has(first.currentKey)).toBe(false);
	});
	it.each([
		"CANCELED",
		"LEASE_LOST",
		"LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		"LOOKALIKE_CACHE_MISS",
	])("does not turn v3 lookup %s into any lower-policy fallback", async (code) => {
		const f = fixture(),
			failure = new MediaOperationError(code);
		f.loadFault.mockImplementation((key) => {
			if (acceptedPolicy(key) === "exact-source-ledger-validation-v3")
				throw failure;
		});
		await expect(f.engine.plan(f.context)).rejects.toBe(failure);
		expect(f.run).not.toHaveBeenCalled();
		expect(
			f.loads.some(
				(key) => acceptedPolicy(key) === "exact-source-ledger-validation-v2",
			),
		).toBe(false);
	});
	it.each([
		"valid",
		"corrupt",
	])("retains the %s parallel v4 winner instead of overwriting it during legacy promotion", async (kind) => {
		const f = fixture();
		await f.engine.plan(f.context);
		const before = f.run.mock.calls.length,
			entries = seedLegacyPointers(f, 2, "generic"),
			first = item(entries[0]);
		const winner = {
			...first.current.pointer(localLedgerPrompt(item(f.chunks[0]))),
			...(kind === "corrupt" ? { stageKeyHash: "f".repeat(64) } : {}),
		};
		let injected = false;
		f.saveFault.mockImplementation((key) => {
			if (
				!injected &&
				hashEditingEvidence({ kind: "LOCAL_STORY_LEDGER_V1", key }) ===
					first.currentKey
			) {
				injected = true;
				f.values.set(first.currentKey, winner);
			}
		});
		const next = f.engine.plan({
			...f.context,
			task: { ...f.context.task, id: randomUUID() },
		});
		if (kind === "valid") await expect(next).resolves.toBeDefined();
		else
			await expect(next).rejects.toMatchObject({
				code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
			});
		expect(injected).toBe(true);
		expect(f.values.get(first.currentKey)).toEqual(winner);
		expect(f.run).toHaveBeenCalledTimes(before);
	});
	it("looks up only normally absent accepted keys in v4, v3, v2, v1 order", async () => {
		const f = fixture();
		await f.engine.plan(f.context);
		expect(f.loads.map(acceptedPolicy).filter(Boolean).slice(0, 4)).toEqual([
			"exact-source-ledger-validation-v4",
			"exact-source-ledger-validation-v3",
			"exact-source-ledger-validation-v2",
			"exact-source-ledger-validation-v1",
		]);
		expect(f.run).toHaveBeenCalledTimes(f.chunks.length + 1);
	});
	it("uses a verified v2 pointer without looking up v1", async () => {
		const f = fixture();
		await f.engine.plan(f.context);
		const before = f.run.mock.calls.length;
		seedLegacyPointers(f, 2, "base");
		f.loadFault.mockImplementation((key) => {
			if (acceptedPolicy(key) === "exact-source-ledger-validation-v1")
				throw new Error("Must not look up v1");
		});
		await expect(
			f.engine.plan({
				...f.context,
				task: { ...f.context.task, id: randomUUID() },
			}),
		).resolves.toBeDefined();
		expect(f.run).toHaveBeenCalledTimes(before);
	});
	it.each([
		"pointer",
		"stage",
	])("does not rescue corrupt v2 %s with a valid v1 pointer", async (change) => {
		const f = fixture();
		await f.engine.plan(f.context);
		const before = f.run.mock.calls.length,
			entries = seedLegacyPointers(f, 2, "base"),
			first = item(entries[0]);
		for (const entry of entries) {
			const v1 = createLegacyLocalStoryLedgerCache(entry.options);
			f.values.set(
				hashEditingEvidence({ kind: "LOCAL_STORY_LEDGER_V1", key: v1.key }),
				v1.pointer(entry.prompt),
			);
		}
		if (change === "pointer")
			f.values.set(first.legacyKey, {
				...first.legacy.pointer(first.prompt),
				stageKeyHash: "f".repeat(64),
			});
		else {
			const stage = item(
				artifactsOfVersion(f.values, "local-semantic-stage-result-v1")[0],
			);
			for (const [key, value] of f.values)
				if (value === stage) f.values.delete(key);
		}
		f.loads.length = 0;
		await expect(
			f.engine.plan({
				...f.context,
				task: { ...f.context.task, id: randomUUID() },
			}),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
		expect(f.run).toHaveBeenCalledTimes(before);
		expect(
			f.loads.some(
				(key) => acceptedPolicy(key) === "exact-source-ledger-validation-v1",
			),
		).toBe(false);
		expect(f.values.has(first.currentKey)).toBe(false);
	});
	it.each([
		"CANCELED",
		"LEASE_LOST",
		"LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		"LOOKALIKE_CACHE_MISS",
	])("does not turn v2 lookup %s into a v1 fallback", async (code) => {
		const f = fixture(),
			failure = new MediaOperationError(code);
		f.loadFault.mockImplementation((key) => {
			if (acceptedPolicy(key) === "exact-source-ledger-validation-v2")
				throw failure;
		});
		await expect(f.engine.plan(f.context)).rejects.toBe(failure);
		expect(f.run).not.toHaveBeenCalled();
		expect(
			f.loads.some(
				(key) => acceptedPolicy(key) === "exact-source-ledger-validation-v1",
			),
		).toBe(false);
	});
	it("keeps the original chunk and old ASR eligibility gate even when the structured third prompt fits", async () => {
		const f = joinedQuoteFixture(),
			spy = vi
				.spyOn(asrQuoteRepair, "localAsrQuoteRepairPrompt")
				.mockReturnValue(undefined);
		try {
			expect(
				localStructuredLedgerRepairPrompt({
					input: f.input,
					chunk: item(f.chunks[0]),
					family: "ASR",
				}),
			).toBeDefined();
			await expect(f.engine.plan(f.context)).rejects.toMatchObject({
				code: "LOCAL_STORY_EVIDENCE_INVALID",
			});
			expect(f.run).toHaveBeenCalledTimes(2);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[0].chunk).toEqual(item(f.chunks[0]));
		} finally {
			spy.mockRestore();
		}
	});
	it("records bounded BASE and QUOTE mismatches only at terminal failure", async () => {
		const sentinel = "RAW_QUOTE_ATTEMPT_SENTINEL";
		const f = fixture({
			changeLedger: (ledger) => ({
				...ledger,
				events: [
					{
						...item(ledger.events[0]),
						quotes: [{ ref: "s0", quote: sentinel }],
					},
				],
			}),
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_EVIDENCE_INVALID",
		});
		expect(failures(f)).toMatchObject([
			{
				quoteAttempts: [
					{
						attempt: 1,
						family: "BASE",
						mismatchCount: 1,
						truncated: false,
						mismatches: [
							{
								eventIndex: 0,
								quoteIndex: 0,
								quoteSha256: createHash("sha256")
									.update(sentinel)
									.digest("hex"),
								quoteUtf8Bytes: Buffer.byteLength(sentinel),
							},
						],
					},
					{ attempt: 2, family: "QUOTE", mismatchCount: 1, truncated: false },
				],
			},
		]);
		expect(f.run).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(f.context.onProgress.mock.calls)).not.toContain(
			sentinel,
		);
	});
	it("records the actual NUMERIC second family when its new quotation is invalid", async () => {
		const f = fixture({
			firstClause: "The display shows 42% progress.",
			changeLedger: (ledger, _chunk, prompt) => ({
				...ledger,
				events: [
					{
						...item(ledger.events[0]),
						label: "The display shows 73% progress.",
						...(prompt.includes("\nNUMERIC_REPAIR:")
							? {
									quotes: [
										{ ref: "s0", quote: "Invented numeric repair quotation." },
									],
								}
							: {}),
					},
				],
			}),
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_EVIDENCE_INVALID",
		});
		expect(failures(f)).toMatchObject([
			{ quoteAttempts: [{ attempt: 2, family: "NUMERIC" }] },
		]);
		expect(f.run).toHaveBeenCalledTimes(2);
	});
	it.each([
		"diagnoseLocalStoryQuotes",
		"localStoryQuoteDiagnosticsProgress",
	] as const)("does not replace validation failure when %s is unable to produce diagnostics", async (method) => {
		const spy = vi.spyOn(quoteDiagnostics, method).mockImplementation(() => {
			throw new Error("RAW_DIAGNOSTIC_ERROR_SENTINEL");
		});
		try {
			const f = fixture({
				changeLedger: (ledger) => ({
					...ledger,
					events: [
						{
							...item(ledger.events[0]),
							quotes: [{ ref: "s0", quote: "Invented unsupported quotation." }],
						},
					],
				}),
			});
			await expect(f.engine.plan(f.context)).rejects.toMatchObject({
				code: "LOCAL_STORY_EVIDENCE_INVALID",
				rule: "QUOTE_NOT_EXACT_SOURCE_SUBSTRING",
			});
			expect(spy).toHaveBeenCalled();
			expect(f.run).toHaveBeenCalledTimes(2);
			expect(failures(f)).toEqual([
				{
					stage: "LOCAL_LEDGER_V1",
					chunkIndex: 0,
					rule: "QUOTE_NOT_EXACT_SOURCE_SUBSTRING",
				},
			]);
			expect(JSON.stringify(f.context.onProgress.mock.calls)).not.toContain(
				"RAW_DIAGNOSTIC_ERROR_SENTINEL",
			);
		} finally {
			spy.mockRestore();
		}
	});
	it("does not publish forged helper output or model error metadata", async () => {
		const spy = vi
			.spyOn(quoteDiagnostics, "diagnoseLocalStoryQuotes")
			.mockReturnValue({
				RAW_DIAGNOSTIC_SENTINEL: "https://private.invalid/",
			} as never);
		try {
			const f = fixture({
				changeLedger: (ledger) => ({
					...ledger,
					events: [
						{
							...item(ledger.events[0]),
							quotes: [{ ref: "s0", quote: "Invented unsupported quotation." }],
						},
					],
				}),
			});
			await expect(f.engine.plan(f.context)).rejects.toMatchObject({
				code: "LOCAL_STORY_EVIDENCE_INVALID",
			});
			expect(spy).toHaveBeenCalledTimes(2);
			expect(failures(f)).toEqual([
				{
					stage: "LOCAL_LEDGER_V1",
					chunkIndex: 0,
					rule: "QUOTE_NOT_EXACT_SOURCE_SUBSTRING",
				},
			]);
			expect(f.run).toHaveBeenCalledTimes(2);
			expect(JSON.stringify(f.context.onProgress.mock.calls)).not.toContain(
				"RAW_DIAGNOSTIC_SENTINEL",
			);
		} finally {
			spy.mockRestore();
		}
	});
	it("does no diagnostic scan on success or corrupt cached stage reads", async () => {
		const spy = vi.spyOn(quoteDiagnostics, "diagnoseLocalStoryQuotes");
		try {
			const f = fixture();
			await f.engine.plan(f.context);
			expect(spy).not.toHaveBeenCalled();
			const before = f.run.mock.calls.length;
			const stage = item(
				artifactsOfVersion(f.values, "local-semantic-stage-result-v1")[0],
			);
			item((stage.output as LocalStoryLedger).events[0]).quotes = [
				{ ref: "s0", quote: "Invalid cached quotation." },
			];
			await expect(
				f.engine.plan({
					...f.context,
					task: { ...f.context.task, id: randomUUID() },
				}),
			).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
			expect(spy).not.toHaveBeenCalled();
			expect(f.run).toHaveBeenCalledTimes(before);
			expect(failures(f)).toEqual([
				{ stage: "LOCAL_LEDGER_V1", chunkIndex: 0, rule: "UNCLASSIFIED" },
			]);
		} finally {
			spy.mockRestore();
		}
	});
	it("does not take quote attempt metadata from a client error", async () => {
		const f = fixture(),
			error = Object.assign(
				new LocalStoryError(
					"LOCAL_STORY_EVIDENCE_INVALID",
					"QUOTE_NOT_EXACT_SOURCE_SUBSTRING",
				),
				{ quoteAttempts: [{ RAW_ERROR_METADATA_SENTINEL: true }] },
			);
		f.run.mockRejectedValue(error);
		await expect(f.engine.plan(f.context)).rejects.toBe(error);
		expect(f.run).toHaveBeenCalledTimes(2);
		expect(failures(f)).toEqual([
			{
				stage: "LOCAL_LEDGER_V1",
				chunkIndex: 0,
				rule: "QUOTE_NOT_EXACT_SOURCE_SUBSTRING",
			},
		]);
		expect(JSON.stringify(f.context.onProgress.mock.calls)).not.toContain(
			"RAW_ERROR_METADATA_SENTINEL",
		);
	});
	it("does not carry repaired quote diagnostics into the next failed chunk", async () => {
		const firstQuote = "FIRST_CHUNK_REPAIRED_SENTINEL",
			secondQuote = "SECOND_CHUNK_FAILURE_SENTINEL";
		const f = fixture({
			changeLedger: (ledger, chunk, prompt) => {
				const first = chunk.refs.includes("s0"),
					event = item(ledger.events[0]);
				return first && prompt.includes("\nQUOTE_REPAIR:")
					? ledger
					: {
							...ledger,
							events: [
								{
									...event,
									quotes: [
										{
											ref: item(event.refs[0]),
											quote: first ? firstQuote : secondQuote,
										},
									],
								},
							],
						};
			},
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_EVIDENCE_INVALID",
		});
		expect(failures(f)).toMatchObject([
			{
				chunkIndex: 1,
				quoteAttempts: [
					{ attempt: 1, family: "BASE" },
					{ attempt: 2, family: "QUOTE" },
				],
			},
		]);
		expect(f.run).toHaveBeenCalledTimes(4);
		const progress = JSON.stringify(f.context.onProgress.mock.calls);
		expect(progress).not.toContain(
			createHash("sha256").update(firstQuote).digest("hex"),
		);
		expect(progress).not.toContain(firstQuote);
		expect(progress).not.toContain(secondQuote);
	});
	it("uses only the first quote rule to choose the bounded static second request", async () => {
		const sentinel = "RAW_INVALID_QUOTE_SENTINEL";
		const f = fixture({
			changeLedger: (ledger, chunk, prompt) =>
				!chunk.refs.includes("s0") || prompt.includes("\nQUOTE_REPAIR:")
					? ledger
					: {
							...ledger,
							events: [
								{
									...item(ledger.events[0]),
									quotes: [{ ref: "s0", quote: sentinel }],
								},
							],
						},
		});
		const result = await f.engine.plan(f.context);
		const ledger = f.requests.filter(
			(request) => request.stage === "LOCAL_LEDGER_V1",
		);
		expect(ledger).toHaveLength(f.chunks.length + 1);
		expect(item(ledger[0]).prompt).toBe(localLedgerPrompt(item(f.chunks[0])));
		expect(item(ledger[1]).prompt).toBe(
			localStructuredLedgerRepairPrompt({
				input: f.input,
				chunk: item(f.chunks[0]),
				family: "QUOTE",
			}),
		);
		expect(ledger.every((request) => !request.prompt.includes(sentinel))).toBe(
			true,
		);
		const data = payload<{
			refs: string[];
			context: unknown[];
			shots: { ref: string; fields: string[] }[];
		}>(item(ledger[1]).prompt);
		expect(data.refs).toEqual(item(f.chunks[0]).refs);
		expect(data.context).toEqual(item(f.chunks[0]).context);
		for (const shot of data.shots)
			expect(shot.fields).toEqual(
				item(
					f.input.shots.find((candidate) => candidate.ref === shot.ref),
				).fields.map((field) => field.text),
			);
		expect(result.evidence.ledger.events[0]?.quotes[0]?.quote).toBe(
			"The owner's bag is missing.",
		);
		expect(failures(f)).toEqual([]);
	});
	it.each([
		[1, "base"],
		[1, "generic"],
		[1, "numeric"],
		[1, "asr"],
		[2, "base"],
		[2, "generic"],
		[2, "numeric"],
		[2, "quote"],
		[2, "asr"],
	] as const)("promotes legacy v%s %s pointers with no inference and preserves every old receipt", async (version, family) => {
		const f =
			family === "asr"
				? joinedQuoteFixture()
				: fixture({
						...(family === "numeric"
							? { firstClause: "The display shows 42% progress." }
							: {}),
						changeLedger: (ledger, chunk, prompt) => {
							if (
								!chunk.refs.includes("s0") ||
								family === "base" ||
								prompt.includes(
									family === "numeric"
										? "\nNUMERIC_REPAIR:"
										: family === "quote"
											? "\nQUOTE_REPAIR:"
											: "\nREPAIR:",
								)
							)
								return ledger;
							const event = item(ledger.events[0]);
							return {
								...ledger,
								events: [
									{
										...event,
										...(family === "numeric"
											? { label: "The display shows 73% progress." }
											: family === "quote"
												? {
														quotes: [
															{
																ref: "s0",
																quote: "Invented unsupported quotation.",
															},
														],
													}
												: {
														refs: [
															...event.refs,
															item(
																chunk.refs.find(
																	(ref) => !event.refs.includes(ref),
																),
															),
														],
													}),
									},
								],
							};
						},
					});
		const first = await f.engine.plan(f.context),
			beforeCalls = f.run.mock.calls.length;
		const seeded = seedLegacyPointers(f, version, family),
			old = structuredClone([...f.values]);
		expect(item(seeded[0]).prompt).toContain(
			family === "generic"
				? "\nREPAIR:"
				: family === "numeric"
					? "\nNUMERIC_REPAIR:"
					: family === "asr"
						? "\nSOURCE_FIELDS\n"
						: family === "quote"
							? "\nQUOTE_REPAIR:"
							: "\nDATA\n",
		);
		const second = await f.engine.plan({
			...f.context,
			task: { ...f.context.task, id: randomUUID() },
		});
		expect(f.run).toHaveBeenCalledTimes(beforeCalls);
		expect(second.evidence).toEqual(first.evidence);
		for (const [key, value] of old) expect(f.values.get(key)).toEqual(value);
		for (const entry of seeded) {
			expect(f.values.get(entry.currentKey)).toEqual(
				entry.current.pointer(entry.prompt),
			);
			expect(f.values.get(entry.legacyKey)).toEqual(
				entry.legacy.pointer(entry.prompt),
			);
		}
		expect(f.values.size).toBe(old.length + f.chunks.length);
	});
	it.each([
		"new-pointer",
		"new-stage",
		"legacy-pointer",
		"missing-stage",
		"receipt-identity",
		"grounding",
	] as const)("fails closed for %s corruption with valid legacy state instead of inference", async (change) => {
		const f = fixture();
		await f.engine.plan(f.context);
		const before = f.run.mock.calls.length,
			seeded = seedLegacyPointers(f),
			entry = item(seeded[0]);
		const stage = item(
			artifactsOfVersion(f.values, "local-semantic-stage-result-v1")[0],
		);
		if (change === "new-pointer")
			f.values.set(entry.currentKey, {
				...entry.current.pointer(entry.prompt),
				stageKeyHash: "f".repeat(64),
			});
		if (change === "new-stage")
			f.values.set(entry.currentKey, entry.current.pointer(entry.prompt));
		if (change === "legacy-pointer")
			f.values.set(entry.legacyKey, {
				...entry.legacy.pointer(entry.prompt),
				validationPolicyVersion: "corrupt",
			});
		if (change === "missing-stage" || change === "new-stage")
			for (const [key, value] of f.values) {
				if (value === stage) f.values.delete(key);
			}
		if (change === "receipt-identity")
			(stage.receipt as LocalSemanticReceipt).profile = "amd";
		if (change === "grounding")
			item((stage.output as LocalStoryLedger).events[0]).quotes = [
				{ ref: "s0", quote: "Invented quotation absent from the source." },
			];
		f.loads.length = 0;
		await expect(
			f.engine.plan({
				...f.context,
				task: { ...f.context.task, id: randomUUID() },
			}),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
		expect(f.run).toHaveBeenCalledTimes(before);
		if (change === "new-pointer" || change === "new-stage")
			expect(
				f.loads.some(
					(key) =>
						acceptedPolicy(key) === LOCAL_STORY_LEGACY_LEDGER_VALIDATION_POLICY,
				),
			).toBe(false);
		else expect(f.values.has(entry.currentKey)).toBe(false);
	});
	it.each([
		"CANCELED",
		"LEASE_LOST",
		"LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		"LOOKALIKE_CACHE_MISS",
	])("does not turn an arbitrary legacy lookup %s error into a cache miss", async (code) => {
		const f = fixture(),
			failure = new MediaOperationError(code);
		f.loadFault.mockImplementation((key) => {
			if (acceptedPolicy(key) === LOCAL_STORY_LEGACY_LEDGER_VALIDATION_POLICY)
				throw failure;
		});
		await expect(f.engine.plan(f.context)).rejects.toBe(failure);
		expect(f.run).not.toHaveBeenCalled();
	});
	it("does not accept a different opaque object as the legacy build-miss sentinel", async () => {
		const f = fixture(),
			failure = Object.freeze({});
		f.loadFault.mockImplementation((key) => {
			if (acceptedPolicy(key) === LOCAL_STORY_LEGACY_LEDGER_VALIDATION_POLICY)
				throw failure;
		});
		await expect(f.engine.plan(f.context)).rejects.toBe(failure);
		expect(f.run).not.toHaveBeenCalled();
	});
	it.each([
		"CANCELED",
		"LEASE_LOST",
	])("keeps the normal %s save fence when promoting a legacy pointer", async (code) => {
		const f = fixture();
		await f.engine.plan(f.context);
		const before = f.run.mock.calls.length,
			seeded = seedLegacyPointers(f),
			old = structuredClone([...f.values]),
			failure = new MediaOperationError(code);
		f.saveFault.mockImplementation((key) => {
			if (acceptedPolicy(key) === LOCAL_STORY_LEDGER_VALIDATION_POLICY)
				throw failure;
		});
		await expect(
			f.engine.plan({
				...f.context,
				task: { ...f.context.task, id: randomUUID() },
			}),
		).rejects.toBe(failure);
		expect(f.run).toHaveBeenCalledTimes(before);
		for (const [key, value] of old) expect(f.values.get(key)).toEqual(value);
		expect(f.values.has(item(seeded[0]).currentKey)).toBe(false);
	});
	it("repairs a missing FLOW premise dependency within the existing three-attempt budget", async () => {
		const f = fixture({
			blueprint: (data, attempt) => ({
				mode: "FLOW",
				message: "犬が鞄を持ち主へ返す。",
				beats: data.events.map((event, i) => ({
					id: `b${i}`,
					role: event[1],
					eventIds: [event[0]],
					requires: i && attempt > 1 ? [`b${i - 1}`] : [],
				})),
				uncertainty: "",
			}),
		});
		const result = await f.engine.plan(f.context);
		expect(result.metrics.localStoryPlanRepairs).toBe(1);
		expect(
			f.requests.filter((request) => request.stage === "LOCAL_BLUEPRINT_V1"),
		).toHaveLength(2);
	});
	it("repairs a numerical ending not supported by the actually selected quotes", async () => {
		const f = fixture({
			blueprint: (data, attempt) => ({
				mode: "FLOW",
				message:
					attempt === 1 ? "鞄が100%返却された。" : "犬が鞄を持ち主へ返す。",
				beats: data.events.map((event, i) => ({
					id: `b${i}`,
					role: event[1],
					eventIds: [event[0]],
					requires: i ? [`b${i - 1}`] : [],
				})),
				uncertainty: "",
			}),
		});
		const result = await f.engine.plan(f.context);
		expect(result.evidence.blueprint.message).not.toContain("100%");
		expect(result.metrics.localStoryPlanRepairs).toBe(1);
	});
	it("tries a fuller supported arc instead of silently returning five seconds for a fifteen-second intent", async () => {
		const f = fixture({
			blueprint: (data, attempt) => ({
				mode: "FLOW",
				message: "鞄を持ち主へ返す。",
				beats: (attempt === 1 ? data.events.slice(0, 1) : data.events).map(
					(event, i) => ({
						id: `b${i}`,
						role: event[1],
						eventIds: [event[0]],
						requires: i ? [`b${i - 1}`] : [],
					}),
				),
				uncertainty: "",
			}),
		});
		const result = await f.engine.plan(f.context);
		expect(result.selection.actualDurationFrames).toBe(450);
		expect(result.metrics.localStoryPlanRepairs).toBe(1);
		expect(
			f.requests.filter((request) => request.stage === "LOCAL_LEDGER_V1"),
		).toHaveLength(f.chunks.length);
	});
	it.each([
		false,
		true,
	])("retains only an already supported short plan after bounded expansion, later invalid=%s", async (laterInvalid) => {
		const f = fixture({
			blueprint: (data, attempt) => ({
				mode: "FLOW",
				message:
					laterInvalid && attempt > 1 ? "鞄が100%返却された。" : "鞄を運ぶ。",
				beats: data.events.slice(0, 1).map((event) => ({
					id: "b0",
					role: event[1],
					eventIds: [event[0]],
					requires: [],
				})),
				uncertainty: "",
			}),
		});
		const result = await f.engine.plan(f.context);
		expect(result.selection.actualDurationFrames).toBe(150);
		expect(result.evidence.blueprint.message).toBe("鞄を運ぶ。");
		expect(result.warnings).toContain(
			"LOCAL_STORY_DURATION_LIMITED_BY_EVIDENCE",
		);
		expect(result.metrics.localStoryPlanRepairs).toBe(2);
		expect(
			f.requests.filter((request) => request.stage === "LOCAL_BLUEPRINT_V1"),
		).toHaveLength(3);
	});
	it("fails closed after three unsupported FLOW graphs without expanding the model-job budget", async () => {
		const f = fixture({
			blueprint: (data) => ({
				mode: "FLOW",
				message: "犬が鞄を持ち主へ返す。",
				beats: data.events.map((event, i) => ({
					id: `b${i}`,
					role: event[1],
					eventIds: [event[0]],
					requires: [],
				})),
				uncertainty: "",
			}),
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_BLUEPRINT_COHERENCE_INVALID",
		});
		expect(
			f.requests.filter((request) => request.stage === "LOCAL_BLUEPRINT_V1"),
		).toHaveLength(3);
	});
	it("rejects a changed transcription quality pin before any transcript or cache work", async () => {
		const f = fixture();
		f.context.verified.envelope.identity.transcriptionPolicyFingerprint =
			"f".repeat(64);
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "ASR_QUALITY_POLICY_CHANGED",
		});
		expect(mocks.prepareTranscript).not.toHaveBeenCalled();
		expect(mocks.createStore).not.toHaveBeenCalled();
		expect(f.run).not.toHaveBeenCalled();
	});
	it("does not feed a mismatched transcription producer into a semantic model", async () => {
		const f = fixture();
		f.context.verified.envelope.identity.transcriptionPolicyFingerprint =
			TRANSCRIPTION_POLICY_FINGERPRINT;
		mocks.prepareTranscript.mockResolvedValueOnce({
			segments: f.segments,
			status: "READY",
			fingerprint: hashEditingEvidence(f.segments),
			warnings: [],
			modelSha256: "b".repeat(64),
			cached: true,
			qualityPolicyFingerprint: "f".repeat(64),
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "ASR_QUALITY_POLICY_CHANGED",
		});
		expect(f.run).not.toHaveBeenCalled();
		expect(f.values.size).toBe(0);
	});
	it("rejects a changed ASR model before transcript/cache/model work even with captions off", async () => {
		const f = fixture({
			modelSha256: "c".repeat(64),
			pinnedAsrModelSha256: "b".repeat(64),
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "ASR_MODEL_CHANGED",
		});
		expect(mocks.prepareTranscript).not.toHaveBeenCalled();
		expect(mocks.createStore).not.toHaveBeenCalled();
		expect(f.run).not.toHaveBeenCalled();
	});
	it("uses a transcript with the same model pinned by intake", async () => {
		const f = fixture({
			modelSha256: "b".repeat(64),
			pinnedAsrModelSha256: "b".repeat(64),
		});
		await expect(f.engine.plan(f.context)).resolves.toMatchObject({
			evidence: { method: "LOCAL_LLM_BEAT_PLAN" },
		});
	});
	it("rejects a FLOW blueprint when the user explicitly requested THEME", async () => {
		const f = fixture();
		await expect(
			f.engine.plan({
				...f.context,
				parameters: { ...f.context.parameters, storyMode: "THEME" },
			}),
		).rejects.toMatchObject({ code: "LOCAL_STORY_MODE_MISMATCH" });
	});
	it("accepts a supported THEME blueprint for an explicit THEME intent", async () => {
		const f = fixture({
			changeLedger: (ledger) => ({
				...ledger,
				events: ledger.events.map((event) => ({
					...event,
					role: "POINT" as const,
				})),
			}),
			blueprint: (data) => ({
				mode: "THEME",
				message: "犬が鞄を運ぶ行動を紹介する。",
				beats: data.events.map((event, i) => ({
					id: `b${i}`,
					role: "POINT",
					eventIds: [event[0]],
					requires: [],
				})),
				uncertainty: "",
			}),
		});
		const result = await f.engine.plan({
			...f.context,
			parameters: { ...f.context.parameters, storyMode: "THEME" },
		});
		expect(result.evidence.blueprint.mode).toBe("THEME");
	});
	it("reuses every duration-independent ledger while replanning 15 and 30 seconds", async () => {
		const f = fixture();
		const short = await f.engine.plan(f.context);
		const long = await f.engine.plan({
			...f.context,
			task: { ...f.context.task, id: randomUUID() },
			parameters: { ...f.context.parameters, targetDurationFrames: 900 },
		});
		expect(f.chunks.length).toBeGreaterThan(1);
		expect(
			f.requests.filter((r) => r.stage === "LOCAL_LEDGER_V1"),
		).toHaveLength(f.chunks.length);
		const blueprints = f.requests.filter(
			(r) => r.stage === "LOCAL_BLUEPRINT_V1",
		);
		expect(
			blueprints.map((r) => payload<BlueprintData>(r.prompt).targetSeconds),
		).toEqual([15, 30]);
		expect(long.evidence.ledgerHash).toBe(short.evidence.ledgerHash);
		expect(long.metrics.localStoryStagesCached).toBe(f.chunks.length);
		expect(long.metrics.localStoryStagesExecuted).toBe(1);
	});
	it("reuses validated repair ledgers for another duration without regenerating rejected BASE outputs", async () => {
		const f = fixture({
			changeLedger: (ledger, chunk, prompt) => {
				if (prompt.includes("\nREPAIR:")) return ledger;
				const event = item(ledger.events[0]);
				const neighbor = item(
					chunk.refs.find((ref) => !event.refs.includes(ref)),
				);
				return {
					...ledger,
					events: [{ ...event, refs: [...event.refs, neighbor] }],
				};
			},
		});
		const first = await f.engine.plan(f.context);
		const firstLedgerCalls = f.requests.filter(
			(request) => request.stage === "LOCAL_LEDGER_V1",
		).length;
		expect(firstLedgerCalls).toBe(f.chunks.length * 2);
		const second = await f.engine.plan({
			...f.context,
			task: { ...f.context.task, id: randomUUID() },
			parameters: { ...f.context.parameters, targetDurationFrames: 900 },
		});
		expect(
			f.requests.filter((request) => request.stage === "LOCAL_LEDGER_V1"),
		).toHaveLength(firstLedgerCalls);
		expect(second.evidence.ledgerHash).toBe(first.evidence.ledgerHash);
		expect(second.metrics.localStoryStagesCached).toBe(f.chunks.length);
		expect(second.metrics.localStoryStagesExecuted).toBe(1);
	});
	it.each([
		"numeric",
		"asr",
	] as const)("reuses the accepted %s repair stage and its original receipt", async (kind) => {
		const f =
			kind === "asr"
				? joinedQuoteFixture()
				: fixture({
						firstClause: "The display shows 42% progress.",
						changeLedger: (ledger, chunk, prompt) =>
							!chunk.refs.includes("s0") || prompt.includes("\nNUMERIC_REPAIR:")
								? ledger
								: {
										...ledger,
										events: ledger.events.map((event) => ({
											...event,
											label: "The display shows 73% progress.",
										})),
									},
					});
		const first = await f.engine.plan(f.context);
		const before = f.requests.filter(
			(r) => r.stage === "LOCAL_LEDGER_V1",
		).length;
		expect(before).toBeGreaterThan(f.chunks.length);
		const second = await f.engine.plan({
			...f.context,
			task: { ...f.context.task, id: randomUUID() },
			parameters: { ...f.context.parameters, targetDurationFrames: 900 },
		});
		expect(
			f.requests.filter((r) => r.stage === "LOCAL_LEDGER_V1"),
		).toHaveLength(before);
		expect(second.evidence.ledgerHash).toBe(first.evidence.ledgerHash);
		expect(second.metrics.localStoryStagesCached).toBe(f.chunks.length);
		expect(second.metrics.localStoryStagesExecuted).toBe(1);
	});
	it.each([
		"missing-stage",
		"request-key",
		"receipt-request",
		"receipt-profile",
		"receipt-model",
		"output-evidence",
		"pointer-policy",
		"pointer-prompt",
	] as const)("fails closed without inference for an accepted cache with %s corruption", async (change) => {
		const f = fixture();
		await f.engine.plan(f.context);
		const before = f.run.mock.calls.length;
		const stage = item(
			artifactsOfVersion(f.values, "local-semantic-stage-result-v1")[0],
		);
		const receipt = stage.receipt as LocalSemanticReceipt;
		const pointer = item(
			artifactsOfVersion(f.values, "local-story-accepted-ledger-v1")[0],
		);
		if (change === "missing-stage") {
			for (const [key, value] of f.values)
				if (value === stage) f.values.delete(key);
		} else if (change === "request-key") stage.requestKey = randomUUID();
		else if (change === "receipt-request") receipt.requestHash = "f".repeat(64);
		else if (change === "receipt-profile") receipt.profile = "amd";
		else if (change === "receipt-model")
			receipt.modelDigest = "f".repeat(64) as typeof receipt.modelDigest;
		else if (change === "output-evidence")
			item((stage.output as LocalStoryLedger).events[0]).quotes = [
				{ ref: "s0", quote: "An invented unsupported quotation." },
			];
		else if (change === "pointer-policy")
			pointer.validationPolicyVersion = "obsolete-policy";
		else pointer.prompt = "Invent an unsupported conclusion.";
		await expect(
			f.engine.plan({
				...f.context,
				task: { ...f.context.task, id: randomUUID() },
				parameters: { ...f.context.parameters, targetDurationFrames: 900 },
			}),
		).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
		expect(f.run).toHaveBeenCalledTimes(before);
	});
	it.each([
		"asr",
		"profile",
		"config",
	] as const)("does not adopt accepted ledgers across a changed %s identity", async (change) => {
		const f = fixture();
		await f.engine.plan(f.context);
		if (change === "asr")
			mocks.prepareTranscript.mockResolvedValue({
				segments: f.segments,
				status: "READY",
				fingerprint: "f".repeat(64),
				warnings: [],
				modelSha256: "b".repeat(64),
				cached: true,
			});
		const engine =
			change === "asr"
				? f.engine
				: createLocalStoryEngine({
						prisma: {} as AppPrismaClient,
						client: { run: f.run } satisfies Pick<
							ReturnType<typeof createLocalSemanticClient>,
							"run"
						>,
						config: {
							...f.config,
							...(change === "profile"
								? { profile: "amd" as const }
								: { configId: randomUUID() }),
						},
					});
		await engine.plan({
			...f.context,
			task: { ...f.context.task, id: randomUUID() },
			parameters: { ...f.context.parameters, targetDurationFrames: 900 },
		});
		expect(
			f.requests.filter((r) => r.stage === "LOCAL_LEDGER_V1"),
		).toHaveLength(f.chunks.length * 2);
	});
	it("warms legacy repaired stage evidence once without changing its prompts or stage keys", async () => {
		const f = fixture({
			changeLedger: (ledger, chunk, prompt) => {
				if (prompt.includes("\nREPAIR:")) return ledger;
				const event = item(ledger.events[0]);
				return {
					...ledger,
					events: [
						{
							...event,
							refs: [
								...event.refs,
								item(chunk.refs.find((ref) => !event.refs.includes(ref))),
							],
						},
					],
				};
			},
		});
		const first = await f.engine.plan(f.context);
		for (const [key, value] of f.values) {
			if (
				value &&
				typeof value === "object" &&
				"version" in value &&
				value.version === "local-story-accepted-ledger-v1"
			)
				f.values.delete(key);
		}
		const before = f.requests.filter(
			(r) => r.stage === "LOCAL_LEDGER_V1",
		).length;
		const second = await f.engine.plan({
			...f.context,
			task: { ...f.context.task, id: randomUUID() },
			parameters: { ...f.context.parameters, targetDurationFrames: 900 },
		});
		expect(
			f.requests.filter((r) => r.stage === "LOCAL_LEDGER_V1"),
		).toHaveLength(before + f.chunks.length);
		await f.engine.plan({
			...f.context,
			task: { ...f.context.task, id: randomUUID() },
			parameters: { ...f.context.parameters, targetDurationFrames: 1800 },
		});
		expect(
			f.requests.filter((r) => r.stage === "LOCAL_LEDGER_V1"),
		).toHaveLength(before + f.chunks.length);
		expect(second.evidence.ledgerHash).toBe(first.evidence.ledgerHash);
	});
	it("uses the prior full-source transcript as semantic evidence even with captions disabled", async () => {
		const f = fixture({ useSpeechEvidence: true });
		const result = await f.engine.plan(f.context);
		expect(f.context.parameters.captions).toBe("OFF");
		expect(mocks.prepareTranscript).toHaveBeenCalledTimes(1);
		expect(
			f.requests.find((r) => r.stage === "LOCAL_LEDGER_V1")?.prompt,
		).toContain("Where is my bag?");
		expect(result.evidence.ledger.events[0]?.quotes[0]?.quote).toBe(
			"Where is my bag?",
		);
		expect(result.segments).toEqual(f.segments);
	});
	it("processes all complete source chunks and returns nontruncated coverage proof", async () => {
		const f = fixture(),
			result = await f.engine.plan(f.context);
		const observed = f.requests
			.filter((r) => r.stage === "LOCAL_LEDGER_V1")
			.flatMap((r) => payload<LocalStoryChunk>(r.prompt).refs);
		expect(observed).toEqual(f.input.shots.map((s) => s.ref));
		expect(result.evidence.inputCoverage).toEqual({
			totalShots: 6,
			eligibleShots: 6,
			processedShots: 6,
			excludedShots: 0,
			truncated: false,
		});
		expect(result.evidence.ledger.coveredRefs).toEqual(observed);
		expect(localStoryEvidenceSchema.safeParse(result.evidence).success).toBe(
			true,
		);
		expect(result.selection.clips.map((c) => c.shotIndex)).toEqual([0, 2, 4]);
	});
	it.each([
		"reference",
		"quotation",
	])("rejects a model's invented %s before planning or saving evidence", async (change) => {
		const f = fixture({
			changeLedger: (ledger) => ({
				...ledger,
				events: ledger.events.map((e) =>
					change === "reference"
						? { ...e, refs: ["s9999"] }
						: {
								...e,
								quotes: [
									{
										ref: item(e.refs[0]),
										quote: "The spaceship wins an invented battle.",
									},
								],
							},
				),
			}),
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_EVIDENCE_INVALID",
		});
		expect(f.requests.some((r) => r.stage === "LOCAL_BLUEPRINT_V1")).toBe(
			false,
		);
		expect(f.values.size).toBe(0);
	});
	it("repairs an unquoted neighboring reference without caching the rejected evidence", async () => {
		const f = fixture({
			changeLedger: (ledger, chunk, prompt) => {
				if (prompt.includes("\nREPAIR:")) return ledger;
				const event = item(ledger.events[0]);
				const neighbor = item(
					chunk.refs.find((ref) => !event.refs.includes(ref)),
				);
				return {
					...ledger,
					events: [{ ...event, refs: [...event.refs, neighbor] }],
				};
			},
		});
		const result = await f.engine.plan(f.context);
		const requests = f.requests.filter((r) => r.stage === "LOCAL_LEDGER_V1");
		expect(requests).toHaveLength(f.chunks.length * 2);
		for (let index = 0; index < requests.length; index += 2) {
			expect(payload(item(requests[index]).prompt)).toEqual(
				payload(item(requests[index + 1]).prompt),
			);
		}
		expect(
			artifactsOfVersion(f.values, "local-semantic-stage-result-v1"),
		).toHaveLength(f.chunks.length + 1);
		expect(
			artifactsOfVersion(f.values, "local-story-accepted-ledger-v1"),
		).toHaveLength(f.chunks.length);
		for (const event of result.evidence.ledger.events)
			expect(event.refs).toEqual([
				...new Set(event.quotes.map((quote) => quote.ref)),
			]);
		expect(failures(f)).toEqual([]);
	});
	it("records only the final failed chunk and rule after the existing two attempts", async () => {
		let failedAttempts = 0;
		const sentinel = "RAW_DIAGNOSTIC_SENTINEL https://private.invalid/secret";
		const f = fixture({
			changeLedger: (ledger, chunk) => {
				if (chunk.refs.includes("s0")) return ledger;
				failedAttempts++;
				const event = item(ledger.events[0]);
				return {
					...ledger,
					events: [
						{
							...event,
							...(failedAttempts === 1
								? { refs: ["s9999"] }
								: { quotes: [{ ref: item(event.refs[0]), quote: sentinel }] }),
						},
					],
				};
			},
		});
		expect(f.chunks.length).toBeGreaterThan(1);
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_EVIDENCE_INVALID",
		});
		expect(failures(f)).toEqual([
			{
				stage: "LOCAL_LEDGER_V1",
				chunkIndex: 1,
				rule: "QUOTE_NOT_EXACT_SOURCE_SUBSTRING",
				quoteAttempts: [
					expect.objectContaining({ attempt: 2, family: "GENERIC" }),
				],
			},
		]);
		expect(f.run).toHaveBeenCalledTimes(3);
		const second = item(
			f.requests.filter((request) => request.stage === "LOCAL_LEDGER_V1")[2],
		);
		expect(second.prompt).toBe(
			localLedgerPrompt(item(f.chunks[1])) + LOCAL_LEDGER_GENERIC_REPAIR_SUFFIX,
		);
		expect(JSON.stringify(f.context.onProgress.mock.calls)).not.toContain(
			sentinel,
		);
		expect(
			f.requests.some((request) => request.stage === "LOCAL_BLUEPRINT_V1"),
		).toBe(false);
	});
	it.each([
		"LOCAL_LEDGER_V1",
		"LOCAL_BLUEPRINT_V1",
	] as const)("classifies terminal %s schema failures without copying Zod issues or model fields", async (stage) => {
		const sentinel = "RAW_DIAGNOSTIC_SENTINEL";
		const f = fixture(),
			original = item(f.run.getMockImplementation());
		f.run.mockImplementation(async (request) => {
			const result = await original(request);
			return request.stage === stage
				? { ...result, content: { [sentinel]: sentinel } }
				: result;
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject(
			stage === "LOCAL_LEDGER_V1"
				? { name: "ZodError" }
				: {
						code: "LOCAL_STORY_BLUEPRINT_INVALID",
						rule: "BLUEPRINT_REFS_OR_DEPENDENCIES_INVALID",
					},
		);
		expect(failures(f)).toEqual([
			{
				stage,
				...(stage === "LOCAL_LEDGER_V1" ? { chunkIndex: 0 } : {}),
				rule:
					stage === "LOCAL_LEDGER_V1"
						? "SCHEMA_INVALID"
						: "BLUEPRINT_REFS_OR_DEPENDENCIES_INVALID",
			},
		]);
		expect(f.run).toHaveBeenCalledTimes(
			stage === "LOCAL_LEDGER_V1" ? 2 : f.chunks.length + 3,
		);
		if (stage === "LOCAL_LEDGER_V1") expect(f.values.size).toBe(0);
		expect(JSON.stringify(f.context.onProgress.mock.calls)).not.toContain(
			sentinel,
		);
	});
	it("does not trust an arbitrary error message or forged diagnostic rule", async () => {
		const sentinel = "RAW_DIAGNOSTIC_SENTINEL";
		const f = fixture();
		const error = Object.assign(
			new LocalStoryError("LOCAL_STORY_EVIDENCE_INVALID"),
			{ rule: sentinel, message: sentinel },
		);
		f.run.mockRejectedValue(error);
		await expect(f.engine.plan(f.context)).rejects.toBe(error);
		expect(failures(f)).toEqual([
			{ stage: "LOCAL_LEDGER_V1", chunkIndex: 0, rule: "UNCLASSIFIED" },
		]);
		expect(f.run).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(f.context.onProgress.mock.calls)).not.toContain(
			sentinel,
		);
	});
	it.each([
		"CANCELED",
		"LEASE_LOST",
	])("keeps the progress %s guard when terminal diagnostics cannot be written", async (code) => {
		const f = fixture({
			changeLedger: (ledger) => ({
				...ledger,
				events: [{ ...item(ledger.events[0]), refs: ["s9999"] }],
			}),
		});
		f.context.onProgress.mockImplementation(async (_phase, progress) => {
			if (progress?.localStoryFailure) throw new MediaOperationError(code);
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code,
		});
		expect(f.run).toHaveBeenCalledTimes(2);
	});
	it.each([
		["LOCAL_LEDGER_V1", "CANCELED"],
		["LOCAL_LEDGER_V1", "LEASE_LOST"],
		["LOCAL_BLUEPRINT_V1", "CANCELED"],
		["LOCAL_BLUEPRINT_V1", "LEASE_LOST"],
	] as const)("preserves unconfirmed %s cleanup before the diagnostic %s guard with a nonaborted signal", async (stage, guardCode) => {
		const f = fixture(),
			original = item(f.run.getMockImplementation()),
			failure = new MediaOperationError("LOCAL_SEMANTIC_CANCEL_UNCONFIRMED");
		f.run.mockImplementation(async (request) => {
			if (request.stage === stage) throw failure;
			return original(request);
		});
		f.context.onProgress.mockImplementation(async (_phase, progress) => {
			if (progress?.localStoryFailure) throw new MediaOperationError(guardCode);
		});
		expect(f.context.signal.aborted).toBe(false);
		await expect(f.engine.plan(f.context)).rejects.toBe(failure);
		expect(f.context.signal.aborted).toBe(false);
		expect(failures(f)).toEqual([]);
		expect(
			f.run.mock.calls.filter(([request]) => request.stage === stage),
		).toHaveLength(1);
		expect(f.run).toHaveBeenCalledTimes(
			stage === "LOCAL_LEDGER_V1" ? 1 : f.chunks.length + 1,
		);
	});
	it("asks once more for a single exact field after both outputs join the three observed ASR utterances", async () => {
		const speech = [
			" Listen, Celia. I was young.",
			" and a dick.",
			" But there's no reason to destroy the world.",
		].map((text, index) => ({
			text,
			startUs: 100_000 + index * 800_000,
			endUs: 700_000 + index * 800_000,
		}));
		let attempts = 0;
		const f = fixture({
			segments: speech,
			changeLedger: (ledger, chunk) => {
				if (!chunk.refs.includes("s0")) return ledger;
				attempts++;
				return {
					...ledger,
					events: [
						{
							...item(ledger.events[0]),
							label: "A speaker addresses Celia.",
							quotes: [
								{
									ref: "s0",
									quote:
										attempts < 3
											? speech.map((segment) => segment.text.trim()).join(" ")
											: item(speech[2]).text,
								},
							],
						},
					],
				};
			},
		});
		const result = await f.engine.plan(f.context);
		const ledgerRequests = f.requests.filter(
			(request) => request.stage === "LOCAL_LEDGER_V1",
		);
		expect(attempts).toBe(3);
		expect(failures(f)).toEqual([]);
		expect(ledgerRequests).toHaveLength(f.chunks.length + 2);
		const [first, second, third] = ledgerRequests.map(
			(request) => request.prompt,
		);
		expect(second).toContain("\nQUOTE_REPAIR:");
		expect(first).toBe(localLedgerPrompt(item(f.chunks[0])));
		expect(third).toBe(
			localStructuredLedgerRepairPrompt({
				input: f.input,
				chunk: item(f.chunks[0]),
				family: "ASR",
			}),
		);
		expect(
			payload<{ shots: { ref: string; fields: string[] }[] }>(
				item(third),
			).shots.map((shot) => shot.fields),
		).toEqual(
			item(f.chunks[0]).refs.map((ref) =>
				item(f.input.shots.find((shot) => shot.ref === ref)).fields.map(
					(field) => field.text,
				),
			),
		);
		expect(Buffer.byteLength(item(third))).toBeLessThanOrEqual(6144);
		expect(result.evidence.ledger.events[0]?.quotes[0]?.quote).toBe(
			item(speech[2]).text,
		);
		expect(
			artifactsOfVersion(f.values, "local-semantic-stage-result-v1"),
		).toHaveLength(f.chunks.length + 1);
		expect(
			artifactsOfVersion(f.values, "local-story-accepted-ledger-v1"),
		).toHaveLength(f.chunks.length);
	});
	it("never asks a fourth time or saves a third response with another unsupported quotation", async () => {
		const f = joinedQuoteFixture({
			thirdQuote: "An invented ending never present in a source field.",
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_EVIDENCE_INVALID",
		});
		expect(f.run).toHaveBeenCalledTimes(3);
		expect(f.values.size).toBe(0);
		expect(failures(f)).toEqual([
			{
				stage: "LOCAL_LEDGER_V1",
				chunkIndex: 0,
				rule: "QUOTE_NOT_EXACT_SOURCE_SUBSTRING",
				quoteAttempts: [
					expect.objectContaining({ attempt: 1, family: "BASE" }),
					expect.objectContaining({ attempt: 2, family: "QUOTE" }),
					expect.objectContaining({ attempt: 3, family: "ASR" }),
				],
			},
		]);
	});
	it.each([
		"same-ref-fabrication",
		"different-ref",
		"nonconsecutive",
	])("keeps a joined ASR quote mixed with %s bounded to two requests", async (change) => {
		const f = joinedQuoteFixture(),
			original = item(f.run.getMockImplementation());
		f.run.mockImplementation(async (input) => {
			const result = await original(input);
			const content = structuredClone(result.content) as LocalStoryLedger;
			const event = item(content.events[0]);
			const ref = change === "different-ref" ? "s1" : "s0";
			if (ref === "s1") event.refs.push(ref);
			event.quotes.push({
				ref,
				quote:
					change === "nonconsecutive"
						? "Listen, Celia. I was young. But there's no reason to destroy the world."
						: change === "different-ref"
							? "Listen, Celia. I was young. and a dick."
							: "A claim absent from every source field.",
			});
			return { ...result, content };
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_EVIDENCE_INVALID",
		});
		expect(f.run).toHaveBeenCalledTimes(2);
		expect(f.values.size).toBe(0);
	});
	it("still repairs the ASR join when another quote is valid in its own single source field", async () => {
		const f = joinedQuoteFixture(),
			original = item(f.run.getMockImplementation());
		f.run.mockImplementation(async (input) => {
			const result = await original(input);
			if (
				input.stage !== "LOCAL_LEDGER_V1" ||
				!payload<LocalStoryChunk>(input.prompt).refs.includes("s0")
			)
				return result;
			const content = structuredClone(result.content) as LocalStoryLedger;
			item(content.events[0]).quotes.push({
				ref: "s0",
				quote: "The owner's bag is missing.",
			});
			return { ...result, content };
		});
		await expect(f.engine.plan(f.context)).resolves.toMatchObject({
			evidence: { method: "LOCAL_LLM_BEAT_PLAN" },
		});
		expect(f.attempts()).toBe(3);
	});
	it("applies the same receipt binding before storing the third response", async () => {
		const f = joinedQuoteFixture(),
			original = item(f.run.getMockImplementation());
		f.run.mockImplementation(async (input) => {
			const result = await original(input);
			return f.attempts() === 3
				? {
						...result,
						receipt: { ...result.receipt, inputHash: "c".repeat(64) },
					}
				: result;
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		});
		expect(f.run).toHaveBeenCalledTimes(3);
		expect(f.values.size).toBe(0);
	});
	it.each([
		"CANCELED",
		"TIMED_OUT",
	])("does not start the extra request after %s", async (code) => {
		const controller = new AbortController();
		const f = joinedQuoteFixture({
			onAttempt: (attempt) => {
				if (attempt === 2) controller.abort(new MediaOperationError(code));
			},
		});
		await expect(
			f.engine.plan({ ...f.context, signal: controller.signal }),
		).rejects.toMatchObject({ code });
		expect(f.run).toHaveBeenCalledTimes(2);
		expect(f.values.size).toBe(0);
	});
	it.each([
		2, 3,
	])("does not retry a fatal remote cleanup failure on request %s", async (fatalAttempt) => {
		const f = joinedQuoteFixture(),
			original = item(f.run.getMockImplementation());
		let calls = 0;
		f.run.mockImplementation(async (input) => {
			if (++calls === fatalAttempt)
				throw new MediaOperationError("LOCAL_SEMANTIC_CANCEL_UNCONFIRMED");
			return original(input);
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		});
		expect(f.run).toHaveBeenCalledTimes(fatalAttempt);
		expect(f.values.size).toBe(0);
	});
	it("keeps an unquoted-reference failure bounded to the existing two requests", async () => {
		const f = fixture({
			changeLedger: (ledger, chunk) => ({
				...ledger,
				events: ledger.events.map((event) => ({ ...event, refs: chunk.refs })),
			}),
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_EVIDENCE_INVALID",
		});
		expect(f.run).toHaveBeenCalledTimes(2);
		expect(f.values.size).toBe(0);
	});
	it("stops after one numeric repair when the new quotation still does not support its claim", async () => {
		const f = fixture({
			changeLedger: (ledger) => ({
				...ledger,
				events: ledger.events.map((event) => ({
					...event,
					label: "1000 bags are returned.",
				})),
			}),
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_EVIDENCE_UNSUPPORTED",
		});
		expect(f.run).toHaveBeenCalledTimes(2);
		expect(
			f.requests.some((request) => request.stage === "LOCAL_BLUEPRINT_V1"),
		).toBe(false);
		expect(f.values.size).toBe(0);
		expect(item(f.requests[1]).prompt).toContain("\nNUMERIC_REPAIR:");
	});
	it("keeps a supported numerical correction and never adopts the first unsupported number", async () => {
		const f = fixture({
			firstClause: "The display shows 42% progress.",
			changeLedger: (ledger, chunk, prompt) =>
				!chunk.refs.includes("s0") || prompt.includes("\nNUMERIC_REPAIR:")
					? ledger
					: {
							...ledger,
							events: ledger.events.map((event) => ({
								...event,
								label: "The display shows 73% progress.",
							})),
						},
		});
		const result = await f.engine.plan(f.context);
		expect(result.evidence.ledger.events[0]?.label).toBe(
			"The display shows 42% progress.",
		);
		expect(result.evidence.ledger.events[0]?.quotes[0]?.quote).toBe(
			"The display shows 42% progress.",
		);
		expect(
			f.requests.filter((request) => request.stage === "LOCAL_LEDGER_V1"),
		).toHaveLength(f.chunks.length + 1);
		expect(JSON.stringify([...f.values.values()])).not.toContain("73%");
		expect(
			artifactsOfVersion(f.values, "local-semantic-stage-result-v1"),
		).toHaveLength(f.chunks.length + 1);
		expect(
			artifactsOfVersion(f.values, "local-story-accepted-ledger-v1"),
		).toHaveLength(f.chunks.length);
	});
	it("keeps qualitative progress qualitative when no exact percentage is quoted", async () => {
		const f = fixture({
			firstClause: "A progress message appears.",
			changeLedger: (ledger, chunk, prompt) =>
				!chunk.refs.includes("s0") || prompt.includes("\nNUMERIC_REPAIR:")
					? ledger
					: {
							...ledger,
							events: ledger.events.map((event) => ({
								...event,
								label: "The progress reaches 73%.",
							})),
						},
		});
		const result = await f.engine.plan(f.context);
		expect(result.evidence.ledger.events[0]?.label).toBe(
			"A progress message appears.",
		);
		expect(item(f.requests[1]).prompt).not.toContain("73%");
		expect(item(f.requests[1]).inputHash).toBe(item(f.requests[0]).inputHash);
	});
	it("does not add numeric recovery after the ordinary quotation repair", async () => {
		const f = fixture({
			changeLedger: (ledger, chunk, prompt) => ({
				...ledger,
				events: ledger.events.map((event) =>
					prompt.includes("\nREPAIR:")
						? { ...event, label: "The progress reaches 73%." }
						: { ...event, refs: chunk.refs },
				),
			}),
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_EVIDENCE_UNSUPPORTED",
		});
		expect(f.run).toHaveBeenCalledTimes(2);
		expect(item(f.requests[1]).prompt).not.toContain("\nNUMERIC_REPAIR:");
		expect(f.values.size).toBe(0);
	});
	it("does not enter ASR third repair after a numeric failure followed by invalid ASR evidence", async () => {
		const f = joinedQuoteFixture(),
			original = item(f.run.getMockImplementation());
		f.run.mockImplementation(async (input) => {
			const result = await original(input);
			if (f.attempts() !== 1) return result;
			const content = structuredClone(result.content) as LocalStoryLedger,
				event = item(content.events[0]);
			event.quotes = [{ ref: "s0", quote: item(f.segments[0]).text }];
			event.label = "The progress reaches 73%.";
			return { ...result, content };
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_EVIDENCE_INVALID",
		});
		expect(f.run).toHaveBeenCalledTimes(2);
		expect(item(f.requests[1]).prompt).toContain("\nNUMERIC_REPAIR:");
		expect(f.values.size).toBe(0);
	});
	it.each([
		"CANCELED",
		"TIMED_OUT",
	])("does not request numeric correction after %s", async (code) => {
		const controller = new AbortController();
		const f = fixture({
			changeLedger: (ledger) => {
				controller.abort(new MediaOperationError(code));
				return {
					...ledger,
					events: ledger.events.map((event) => ({
						...event,
						label: "The progress reaches 73%.",
					})),
				};
			},
		});
		await expect(
			f.engine.plan({ ...f.context, signal: controller.signal }),
		).rejects.toMatchObject({ code });
		expect(f.run).toHaveBeenCalledTimes(1);
		expect(f.values.size).toBe(0);
	});
	it.each([
		"LOCAL_SEMANTIC_UNAVAILABLE",
		"LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
	])("never treats %s as a semantic retry", async (code) => {
		const f = fixture();
		f.run.mockRejectedValue(new MediaOperationError(code));
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({ code });
		expect(f.run).toHaveBeenCalledTimes(1);
	});
	it("bounds the pure numeric suffix and preserves the complete chunk", () => {
		const f = fixture(),
			chunk = item(f.chunks[0]);
		const base = localLedgerPrompt(chunk),
			prompt = item(localNumericLedgerRepairPrompt(chunk));
		expect(prompt.startsWith(base)).toBe(true);
		expect(
			Buffer.byteLength(prompt) - Buffer.byteLength(base),
		).toBeLessThanOrEqual(533);
		expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(6144);
		expect(payload(prompt)).toEqual(chunk);
		const tooLarge = structuredClone(chunk);
		item(tooLarge.shots[0]).text += "x".repeat(6144 - Buffer.byteLength(base));
		expect(localNumericLedgerRepairPrompt(tooLarge)).toBeUndefined();
	});
	it("does not add a third request when the first failure was a schema error", async () => {
		const f = joinedQuoteFixture(),
			original = item(f.run.getMockImplementation());
		f.run.mockImplementation(async (input) => {
			const result = await original(input);
			if (f.attempts() !== 1) return result;
			const content = structuredClone(result.content) as LocalStoryLedger;
			item(content.events[0]).quotes = [];
			return { ...result, content };
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_EVIDENCE_INVALID",
		});
		expect(f.run).toHaveBeenCalledTimes(2);
		expect(f.values.size).toBe(0);
	});
	it("stops after three complete-plan attempts when the required story cannot fit", async () => {
		const f = fixture();
		await expect(
			f.engine.plan({
				...f.context,
				parameters: { ...f.context.parameters, targetDurationFrames: 90 },
			}),
		).rejects.toMatchObject({ code: "LOCAL_STORY_NO_FITTING_PLAN" });
		expect(
			f.requests.filter((r) => r.stage === "LOCAL_BLUEPRINT_V1"),
		).toHaveLength(3);
		expect(
			f.requests.filter((r) => r.stage === "LOCAL_LEDGER_V1"),
		).toHaveLength(f.chunks.length);
	});
	it("repairs a Blueprint role mismatch without repeating accepted ledger work", async () => {
		const f = fixture({
			blueprint: (data, attempt) => ({
				mode: "FLOW",
				message: "持ち主が鞄を探している。",
				beats: [
					{
						id: "b0",
						role: attempt === 1 ? "OUTCOME" : item(data.events[0])[1],
						eventIds: [item(data.events[0])[0]],
						requires: [],
					},
				],
				uncertainty: "",
			}),
		});
		const result = await f.engine.plan({
			...f.context,
			parameters: { ...f.context.parameters, targetDurationFrames: 150 },
		});
		expect(result.metrics.localStoryPlanRepairs).toBe(1);
		expect(result.evidence.blueprint.beats[0]?.role).toBe("CONTEXT");
		expect(
			f.requests.filter((r) => r.stage === "LOCAL_BLUEPRINT_V1"),
		).toHaveLength(2);
		expect(
			f.requests.filter((r) => r.stage === "LOCAL_LEDGER_V1"),
		).toHaveLength(f.chunks.length);
		expect(
			item(f.requests.filter((r) => r.stage === "LOCAL_BLUEPRINT_V1")[1])
				.prompt,
		).toContain("exactly that beat's role");
		const repairData = payload<BlueprintData & { roleConflicts: unknown }>(
			item(f.requests.filter((r) => r.stage === "LOCAL_BLUEPRINT_V1")[1])
				.prompt,
		);
		expect(repairData.roleConflicts).toEqual([
			{
				beatId: "b0",
				beatRole: "OUTCOME",
				eventId: item(repairData.events[0])[0],
				eventRole: "CONTEXT",
			},
		]);
		expect(
			artifactsOfVersion(f.values, "local-semantic-stage-result-v1"),
		).toHaveLength(f.chunks.length + 1);
		expect(failures(f)).toEqual([]);
	});
	it("keeps a repeated Blueprint role mismatch bounded to three attempts", async () => {
		const f = fixture({
			blueprint: (data) => ({
				mode: "FLOW",
				message: "Unsupported completion.",
				beats: [
					{
						id: "b0",
						role: "OUTCOME",
						eventIds: [item(data.events[0])[0]],
						requires: [],
					},
				],
				uncertainty: "",
			}),
		});
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_BLUEPRINT_ROLE_MISMATCH",
		});
		expect(
			f.requests.filter((r) => r.stage === "LOCAL_BLUEPRINT_V1"),
		).toHaveLength(3);
		expect(
			artifactsOfVersion(f.values, "local-semantic-stage-result-v1"),
		).toHaveLength(f.chunks.length);
		expect(failures(f)).toEqual([
			{ stage: "LOCAL_BLUEPRINT_V1", rule: "BLUEPRINT_ROLE_MISMATCH" },
		]);
	});
	it("does not replace an unconfirmed remote Blueprint cleanup with cancellation or retry it", async () => {
		const f = fixture(),
			controller = new AbortController();
		const original = item(f.run.getMockImplementation());
		f.run.mockImplementation(async (request) => {
			if (request.stage !== "LOCAL_BLUEPRINT_V1") return original(request);
			controller.abort(new MediaOperationError("CANCELED"));
			throw new MediaOperationError("LOCAL_SEMANTIC_CANCEL_UNCONFIRMED");
		});
		await expect(
			f.engine.plan({ ...f.context, signal: controller.signal }),
		).rejects.toMatchObject({
			code: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		});
		expect(
			f.run.mock.calls.filter(
				([request]) => request.stage === "LOCAL_BLUEPRINT_V1",
			),
		).toHaveLength(1);
	});
	it.each([
		1, 3,
	])("preserves the parent deadline at Blueprint role attempt %s", async (stopAt) => {
		const controller = new AbortController();
		const f = fixture({
			blueprint: (data, attempt) => {
				if (attempt === stopAt)
					controller.abort(new MediaOperationError("TIMED_OUT"));
				return {
					mode: "FLOW",
					message: "Unsupported completion.",
					beats: [
						{
							id: "b0",
							role: "OUTCOME",
							eventIds: [item(data.events[0])[0]],
							requires: [],
						},
					],
					uncertainty: "",
				};
			},
		});
		await expect(
			f.engine.plan({ ...f.context, signal: controller.signal }),
		).rejects.toMatchObject({ code: "TIMED_OUT" });
		expect(
			f.requests.filter((request) => request.stage === "LOCAL_BLUEPRINT_V1"),
		).toHaveLength(stopAt);
	});
	it("accepts a smaller supported blueprint after repair without keeping an unsupported result alone", async () => {
		const f = fixture({
			blueprint: (data, attempt) => ({
				mode: "FLOW",
				message:
					attempt < 3 ? "鞄が持ち主へ返る。" : "持ち主が鞄を探している。",
				beats: (attempt < 3 ? data.events : data.events.slice(0, 1)).map(
					(event, i) => ({
						id: `b${i}`,
						role: event[1],
						eventIds: [event[0]],
						requires: i ? [`b${i - 1}`] : [],
					}),
				),
				uncertainty: "",
			}),
		});
		const result = await f.engine.plan({
			...f.context,
			parameters: { ...f.context.parameters, targetDurationFrames: 150 },
		});
		expect(result.metrics.localStoryPlanRepairs).toBe(2);
		expect(result.evidence.blueprint.message).toBe("持ち主が鞄を探している。");
		expect(result.selection.clips.map((c) => c.shotIndex)).toEqual([0]);
		expect(result.evidence.selection.selectedBeatIds).toEqual(["b0"]);
	});
	it("does no semantic or transcript work after a pre-existing cancellation", async () => {
		const f = fixture(),
			controller = new AbortController();
		controller.abort(new Error("CANCELED"));
		await expect(
			f.engine.plan({ ...f.context, signal: controller.signal }),
		).rejects.toThrow("CANCELED");
		expect(mocks.prepareTranscript).not.toHaveBeenCalled();
		expect(f.run).not.toHaveBeenCalled();
	});
});

describe("shared full-source preparation", () => {
	it("prepares the same complete source without creating a flat blueprint", async () => {
		const f = fixture();
		const first = await f.engine.prepareFullSource(f.context);
		expect(first.input).toEqual(f.input);
		expect(first.chunks).toEqual(f.chunks);
		expect(first.ledgerRefs).toHaveLength(f.chunks.length);
		expect(first.inputHash).toBe(hashEditingEvidence(first.input));
		expect(first.ledgerHash).toBe(hashEditingEvidence(first.ledger));
		expect(first.counters).toEqual({
			cachedStages: 0,
			executedStages: f.chunks.length,
		});
		expect(f.requests.every((r) => r.stage === "LOCAL_LEDGER_V1")).toBe(true);
		const legacy = await f.engine.plan(f.context);
		expect(legacy.evidence.inputHash).toBe(first.inputHash);
		expect(legacy.evidence.ledger).toEqual(first.ledger);
		expect(legacy.evidence.ledgerHash).toBe(first.ledgerHash);
		expect(legacy.metrics.localStoryStagesCached).toBe(f.chunks.length);
		expect(
			f.requests.filter((r) => r.stage === "LOCAL_LEDGER_V1"),
		).toHaveLength(f.chunks.length);
	});
	it("reuses all 52 accepted ledger stages through the real parsers and builds a full H0 manifest", async () => {
		const f = fixture({
			clauses: Array.from(
				{ length: 52 },
				(_, i) => `Synthetic observation ${i}.`,
			),
			shotPaddingRepeats: 80,
		});
		expect(f.chunks).toHaveLength(52);
		const first = await f.engine.prepareFullSource(f.context);
		expect(f.requests).toHaveLength(52);
		const before = structuredClone(f.values);
		f.run.mockClear();
		const second = await f.engine.prepareFullSource({
			...f.context,
			task: { ...f.context.task, id: randomUUID() },
		});
		expect(f.run).not.toHaveBeenCalled();
		expect(f.values).toEqual(before);
		expect(second.counters).toEqual({ cachedStages: 52, executedStages: 0 });
		expect(second.ledgerRefs).toEqual(first.ledgerRefs);
		const manifest = buildLocalStoryFlowManifest({
			input: second.input,
			chunks: second.chunks,
			ledgers: second.ledgers,
			model: second.model,
			transcriptFingerprint: second.transcript.fingerprint,
			ledgerRefs: second.ledgerRefs,
		});
		expect(manifest.ledgerRefs).toHaveLength(52);
		expect(second.ledger.coveredRefs).toEqual(first.ledger.coveredRefs);
	});
	it.each([
		"UNAVAILABLE",
		"NO_AUDIO",
	] as const)("requires READY for audible source returning %s, keeping legacy behavior", async (status) => {
		const f = fixture();
		mocks.prepareTranscript.mockResolvedValue({
			qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
			segments: [],
			status,
			fingerprint: hashEditingEvidence([]),
			warnings: ["ASR_UNAVAILABLE"],
			modelSha256: null,
			cached: true,
		});
		await expect(f.engine.prepareFullSource(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_TRANSCRIPT_REQUIRED",
		});
		expect(f.run).not.toHaveBeenCalled();
		await expect(f.engine.plan(f.context)).resolves.toMatchObject({
			evidence: { version: "local-story-evidence-v1" },
		});
	});
	it.each([
		"READY",
		"NO_AUDIO",
	] as const)("accepts %s without manufacturing speech", async (status) => {
		const f = fixture();
		mocks.prepareTranscript.mockResolvedValue({
			qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
			segments: [],
			status,
			fingerprint: hashEditingEvidence([]),
			warnings: [],
			modelSha256: null,
			cached: true,
		});
		const result = await f.engine.prepareFullSource({
			...f.context,
			hasAudio: status === "READY",
		});
		expect(result.transcript.segments).toEqual([]);
		expect(result.input.segments).toEqual([]);
		expect(result.transcript.status).toBe(status);
	});
	it.each([
		"UNAVAILABLE",
		"NO_AUDIO",
	] as const)("preserves an abort arriving at the %s transcript await boundary", async (status) => {
		const f = fixture(),
			controller = new AbortController(),
			reason = new Error("AUTHORED_CALLER_ABORT");
		mocks.prepareTranscript.mockResolvedValue({
			qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
			segments: [],
			status,
			fingerprint: hashEditingEvidence([]),
			warnings: [],
			modelSha256: null,
			cached: true,
		});
		const pending = f.engine.prepareFullSource({
			...f.context,
			hasAudio: status !== "NO_AUDIO",
			signal: controller.signal,
		});
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		expect(f.run).not.toHaveBeenCalled();
	});
	it("cuts mutable aliases from returned source, model, metrics and counters", async () => {
		const f = fixture(),
			a = await f.engine.prepareFullSource(f.context);
		const expectedInput = structuredClone(a.input),
			expectedModel = structuredClone(a.model);
		item(a.input.shots[0]).text = "CALLER_MUTATION";
		item(a.ledgers[0]).summary = "CALLER_MUTATION";
		a.model.configId = randomUUID();
		a.metrics.caller = 1;
		a.counters.cachedStages = 999;
		const b = await f.engine.prepareFullSource(f.context);
		expect(b.input).toEqual(expectedInput);
		expect(b.model).toEqual(expectedModel);
		expect(f.engine.identity).toEqual(expectedModel);
		expect(b.metrics).not.toHaveProperty("caller");
		expect(b.counters.cachedStages).toBe(f.chunks.length);
	});
});

function longCompactFixture(
	options: Pick<
		NonNullable<Parameters<typeof fixture>[0]>,
		"choice" | "choiceEnabled" | "choiceProbeCode"
	> & { invalidId?: string; nativeSchema?: "FIRST" | "ALWAYS" } = {},
) {
	return fixture({
		choice: options.choice,
		choiceEnabled: options.choiceEnabled,
		choiceProbeCode: options.choiceProbeCode,
		clauses: Array.from(
			{ length: 52 },
			(_, index) =>
				`A small brown dog approaches a bag in observed segment ${index}.`,
		),
		shotPaddingRepeats: 110,
		blueprint: (data, attempt) => {
			const invalidSchema =
				options.nativeSchema === "ALWAYS" ||
				(options.nativeSchema === "FIRST" && attempt === 1);
			return {
				mode: "FLOW",
				message: "犬と鞄の様子を紹介する。",
				beats: data.events
					.slice(0, invalidSchema ? 5 : 4)
					.map((event, index) => ({
						id: invalidSchema ? "FLOW" : `b${index}`,
						role: event[1],
						eventIds: options.invalidId
							? [event[0], options.invalidId]
							: [event[0]],
						requires: index
							? [
									invalidSchema
										? item(data.events[index - 1])[0]
										: `b${index - 1}`,
								]
							: [],
					})),
				uncertainty: "",
			};
		},
	});
}

describe("registered Blueprint repair metadata", () => {
	it.each([
		"COHERENCE",
		"FIT",
		"EXPAND",
	] as const)("carries only the engine-owned %s repair facts to the prompt adapter", async (kind) => {
		const spy = vi.spyOn(blueprintPrompt, "prepareLocalBlueprintPrompt");
		try {
			const f = fixture({
				blueprint: (data, attempt) => ({
					mode: "FLOW",
					message: "鞄と犬の様子を紹介する。",
					uncertainty: "",
					beats: data.events
						.slice(
							0,
							kind === "FIT"
								? attempt === 1
									? 3
									: 1
								: kind === "EXPAND" && attempt === 1
									? 1
									: 3,
						)
						.map((event, index) => ({
							id: `b${index}`,
							role: event[1],
							eventIds: [event[0]],
							requires:
								index && !(kind === "COHERENCE" && attempt === 1)
									? [`b${index - 1}`]
									: [],
						})),
				}),
			});
			if (kind === "FIT") f.context.parameters.targetDurationFrames = 150;
			const result = await f.engine.plan(f.context);
			expect(result.metrics.localStoryPlanRepairs).toBe(1);
			expect(spy.mock.calls.map(([options]) => options.repairMeta)).toEqual([
				undefined,
				{
					kind,
					attempt: 1,
					...(kind === "EXPAND" ? { actualDurationFrames: 150 } : {}),
				},
			]);
			const expectedRepair =
				kind === "COHERENCE"
					? localBlueprintCoherenceRepairInstruction(1)
					: kind === "FIT"
						? localBlueprintFitRepairInstruction({
								targetDurationFrames: 150,
								attempt: 1,
							})
						: localBlueprintExpansionRepairInstruction({
								actualDurationFrames: 150,
								targetDurationFrames: 450,
								attempt: 1,
							});
			const requests = f.requests.filter(
				(request) => request.stage === "LOCAL_BLUEPRINT_V1",
			);
			expect(requests).toHaveLength(2);
			expect(payload<{ repair: string }>(item(requests[1]).prompt).repair).toBe(
				expectedRepair,
			);
			expect(
				f.requests.filter((request) => request.stage === "LOCAL_LEDGER_V1"),
			).toHaveLength(f.chunks.length);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("additive feasible-choice planner", () => {
	it("reuses 52 accepted ledgers, compiles one native choice and reuses its sealed choice across tasks with zero inference", async () => {
		const f = longCompactFixture({ choiceEnabled: true });
		const context = {
			...f.context,
			parameters: {
				...f.context.parameters,
				targetDurationFrames: 600,
				storyPlanner: "FEASIBLE_CHOICE_V1" as const,
			},
		};
		await f.engine.prepareFullSource(context);
		const before = structuredClone([...f.values]);
		f.requests.length = 0;
		f.run.mockClear();
		const first = await f.engine.plan(context);
		expect(f.requests.map((request) => request.stage)).toEqual([
			"LOCAL_STORY_CHOICE_V1",
		]);
		expect(item(f.requests[0]).promptVersion).toBe("local-story-choice-v1");
		expect(item(f.requests[0]).schemaHash).toBe(
			localStoryChoiceStageRegistry().stages.LOCAL_STORY_CHOICE_V1.schemaHash,
		);
		expect(first.evidence.inputCoverage.processedShots).toBe(52);
		expect(first.metrics.localStoryStagesCached).toBe(52);
		expect(first.metrics.localStoryStagesExecuted).toBe(1);
		expect(first.metrics.localStoryChoiceNativeAttempts).toBe(1);
		expect(first.selection.actualDurationFrames).toBeLessThanOrEqual(600);
		for (const [key, value] of before) expect(f.values.get(key)).toEqual(value);
		const choices = artifactsOfVersion(
			f.values,
			"local-story-choice-stage-result-v1",
		);
		expect(choices).toHaveLength(1);
		expect(choices[0]).not.toHaveProperty("output");
		expect(
			(item(choices[0]).receipt as LocalSemanticReceipt).maxOutputTokens,
		).toBe(512);
		f.requests.length = 0;
		f.run.mockClear();
		const second = await f.engine.plan({
			...context,
			task: { ...context.task, id: randomUUID() },
		});
		expect(f.run).not.toHaveBeenCalled();
		expect(second.evidence).toEqual(first.evidence);
		expect(second.metrics.localStoryStagesCached).toBe(53);
		expect(second.metrics.localStoryStagesExecuted).toBe(0);
		expect(second.metrics.localStoryChoiceNativeAttempts).toBe(0);
	});
	it("repairs an unknown plan only with owned instructions and reuses the accepted repair without inference", async () => {
		const f = longCompactFixture({
			choiceEnabled: true,
			choice: (data, attempt) => ({
				planId: attempt === 1 ? "p999999" : item(data.plans[0])[0],
				message: "犬と鞄の様子を紹介する。",
				uncertainty: "",
			}),
		});
		const context = {
			...f.context,
			parameters: {
				...f.context.parameters,
				targetDurationFrames: 600,
				storyPlanner: "FEASIBLE_CHOICE_V1" as const,
			},
		};
		await f.engine.prepareFullSource(context);
		f.requests.length = 0;
		f.run.mockClear();
		const first = await f.engine.plan(context);
		expect(f.requests.map((request) => request.stage)).toEqual([
			"LOCAL_STORY_CHOICE_V1",
			"LOCAL_STORY_CHOICE_V1",
		]);
		expect(item(f.requests[1]).prompt).toContain("Previous choice was invalid");
		expect(item(f.requests[1]).prompt).not.toContain("p999999");
		expect(first.metrics.localStoryChoiceNativeAttempts).toBe(2);
		expect(first.metrics.localStoryStagesExecuted).toBe(1);
		expect(
			artifactsOfVersion(f.values, "local-story-choice-stage-result-v1"),
		).toHaveLength(1);
		f.run.mockClear();
		const second = await f.engine.plan({
			...context,
			task: { ...context.task, id: randomUUID() },
		});
		expect(f.run).not.toHaveBeenCalled();
		expect(second.evidence).toEqual(first.evidence);
	});
	it("rejects a five-day explanation and accepts only the later qualitative message without rewriting the rejected native choice", async () => {
		const nativeChoices: {
			planId: string;
			message: string;
			uncertainty: string;
		}[] = [];
		const f = fixture({
			choiceEnabled: true,
			choice: (data, attempt) => {
				const choice = {
					planId: item(data.plans[0])[0],
					message:
						attempt === 1 ? "犬が5日かけて鞄を届ける。" : "犬が鞄を運ぶ。",
					uncertainty: "",
				};
				nativeChoices.push(choice);
				return choice;
			},
		});
		const context = {
			...f.context,
			parameters: {
				...f.context.parameters,
				storyPlanner: "FEASIBLE_CHOICE_V1" as const,
			},
		};
		await f.engine.prepareFullSource(context);
		const before = structuredClone([...f.values]);
		f.requests.length = 0;
		f.run.mockClear();
		const result = await f.engine.plan(context);
		expect(f.requests.map((request) => request.stage)).toEqual([
			"LOCAL_STORY_CHOICE_V1",
			"LOCAL_STORY_CHOICE_V1",
		]);
		expect(result.evidence.blueprint.message).toBe("犬が鞄を運ぶ。");
		expect(result.metrics.localStoryChoiceNativeAttempts).toBe(2);
		expect(result.metrics.localStoryStagesExecuted).toBe(1);
		expect(result.metrics.localStoryStagesCached).toBe(f.chunks.length);
		expect(item(nativeChoices[0]).message).toBe("犬が5日かけて鞄を届ける。");
		expect(item(f.requests[1]).prompt).toContain(
			"no quantities/counts/dates/days/durations/measurements",
		);
		const saved = artifactsOfVersion(
			f.values,
			"local-story-choice-stage-result-v1",
		);
		expect(saved).toHaveLength(1);
		expect(item(saved[0]).choice).toMatchObject({ message: "犬が鞄を運ぶ。" });
		for (const [key, value] of before) expect(f.values.get(key)).toEqual(value);
	});
	it("rejects three unsupported numerical choices without saving any native choice", async () => {
		const f = longCompactFixture({
			choiceEnabled: true,
			choice: (data) => ({
				planId: item(data.plans[0])[0],
				message: "777人が解決した。",
				uncertainty: "",
			}),
		});
		const context = {
			...f.context,
			parameters: {
				...f.context.parameters,
				targetDurationFrames: 600,
				storyPlanner: "FEASIBLE_CHOICE_V1" as const,
			},
		};
		await f.engine.prepareFullSource(context);
		const before = structuredClone([...f.values]);
		f.requests.length = 0;
		f.run.mockClear();
		await expect(f.engine.plan(context)).rejects.toMatchObject({
			code: "LOCAL_STORY_PLAN_UNAVAILABLE",
		});
		expect(f.requests.map((request) => request.stage)).toEqual([
			"LOCAL_STORY_CHOICE_V1",
			"LOCAL_STORY_CHOICE_V1",
			"LOCAL_STORY_CHOICE_V1",
		]);
		expect([...f.values]).toEqual(before);
	});
	it.each([
		"choice",
		"receipt",
		"legacy",
	] as const)("rejects a tampered %s choice-cache record without inference or fallback", async (kind) => {
		const f = longCompactFixture({ choiceEnabled: true });
		const context = {
			...f.context,
			parameters: {
				...f.context.parameters,
				targetDurationFrames: 600,
				storyPlanner: "FEASIBLE_CHOICE_V1" as const,
			},
		};
		await f.engine.plan(context);
		const saved = item(
			artifactsOfVersion(f.values, "local-story-choice-stage-result-v1")[0],
		);
		const [key] = item([...f.values].find(([, value]) => value === saved));
		f.values.set(
			key,
			kind === "legacy"
				? { ...saved, version: "local-semantic-stage-result-v1" }
				: kind === "receipt"
					? {
							...saved,
							receipt: {
								...(saved.receipt as object),
								requestHash: "f".repeat(64),
							},
						}
					: {
							...saved,
							choice: { ...(saved.choice as object), planId: "p999999" },
						},
		);
		const before = structuredClone([...f.values]);
		f.run.mockClear();
		await expect(f.engine.plan(context)).rejects.toMatchObject({
			code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		});
		expect(f.run).not.toHaveBeenCalled();
		expect([...f.values]).toEqual(before);
	});
	it.each([
		false,
		true,
	])("fails before ASR or native work when choice is unavailable, enabled=%s", async (enabled) => {
		const f = longCompactFixture({
			choiceEnabled: enabled,
			choiceProbeCode: "COMPATIBILITY_MISMATCH",
		});
		const context = {
			...f.context,
			parameters: {
				...f.context.parameters,
				storyPlanner: "FEASIBLE_CHOICE_V1" as const,
			},
		};
		await expect(f.engine.plan(context)).rejects.toMatchObject({
			code: "LOCAL_STORY_ENGINE_UNAVAILABLE",
		});
		expect(mocks.prepareTranscript).not.toHaveBeenCalled();
		expect(f.run).not.toHaveBeenCalled();
		expect(f.choiceProbe).toHaveBeenCalledTimes(enabled ? 1 : 0);
	});
	it("keeps old absent-planner tasks on the old Blueprint path even when Choice is enabled", async () => {
		const f = longCompactFixture({ choiceEnabled: true });
		f.context.parameters.targetDurationFrames = 600;
		await f.engine.plan(f.context);
		expect(f.choiceProbe).not.toHaveBeenCalled();
		expect(
			f.requests
				.filter((request) => request.stage !== "LOCAL_LEDGER_V1")
				.map((request) => request.stage),
		).toEqual(["LOCAL_BLUEPRINT_V1"]);
	});
	it.each([
		"CANCELED",
		"LEASE_LOST",
		"TIMED_OUT",
	] as const)("preserves uncertain Choice cleanup during simultaneous %s without retry or cache writes", async (code) => {
		const f = longCompactFixture({ choiceEnabled: true });
		const controller = new AbortController();
		const context = {
			...f.context,
			signal: controller.signal,
			parameters: {
				...f.context.parameters,
				targetDurationFrames: 600,
				storyPlanner: "FEASIBLE_CHOICE_V1" as const,
			},
		};
		await f.engine.prepareFullSource(context);
		const before = structuredClone([...f.values]);
		const failure = new MediaOperationError(
			"LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		);
		f.run.mockClear();
		f.run.mockImplementation(async () => {
			controller.abort(new MediaOperationError(code));
			throw failure;
		});
		await expect(f.engine.plan(context)).rejects.toBe(failure);
		expect(f.run).toHaveBeenCalledTimes(1);
		expect([...f.values]).toEqual(before);
		expect(
			artifactsOfVersion(f.values, "local-story-choice-stage-result-v1"),
		).toHaveLength(0);
	});
	it("preserves uncertain cleanup as terminal rather than retrying another choice", async () => {
		const f = longCompactFixture({ choiceEnabled: true });
		const context = {
			...f.context,
			parameters: {
				...f.context.parameters,
				targetDurationFrames: 600,
				storyPlanner: "FEASIBLE_CHOICE_V1" as const,
			},
		};
		await f.engine.prepareFullSource(context);
		const failure = new MediaOperationError(
			"LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
		);
		f.run.mockClear();
		f.run.mockRejectedValue(failure);
		await expect(f.engine.plan(context)).rejects.toBe(failure);
		expect(f.run).toHaveBeenCalledTimes(1);
		expect(
			artifactsOfVersion(f.values, "local-story-choice-stage-result-v1"),
		).toHaveLength(0);
	});
});

describe("fresh native Blueprint schema repair boundaries", () => {
	it("rejects duplicate mode IDs and event dependencies, then saves only a corrected canonical Blueprint with all 52 ledgers cached", async () => {
		const spy = vi.spyOn(blueprintPrompt, "prepareLocalBlueprintPrompt");
		try {
			const f = longCompactFixture({ nativeSchema: "FIRST" });
			f.context.parameters.targetDurationFrames = 600;
			const full = await f.engine.prepareFullSource(f.context);
			expect(full.ledger.events).toHaveLength(52);
			const before = structuredClone([...f.values]);
			f.requests.length = 0;
			f.run.mockClear();
			const result = await f.engine.plan(f.context);
			expect(f.requests.map((request) => request.stage)).toEqual([
				"LOCAL_BLUEPRINT_V1",
				"LOCAL_BLUEPRINT_V1",
			]);
			expect(spy.mock.calls.map(([options]) => options.repairMeta)).toEqual([
				undefined,
				{ kind: "SCHEMA", attempt: 1 },
			]);
			expect(item(spy.mock.calls[1])[0].repair).toBe(
				localBlueprintSchemaRepairInstruction(1),
			);
			expect(result.metrics.localStoryStagesCached).toBe(52);
			expect(result.metrics.localStoryStagesExecuted).toBe(1);
			expect(result.metrics.localStoryPlanRepairs).toBe(1);
			expect(
				result.evidence.blueprint.beats.flatMap((beat) => beat.eventIds),
			).toEqual(full.ledger.events.slice(0, 4).map((event) => event.id));
			for (const [key, value] of before)
				expect(f.values.get(key)).toEqual(value);
			const saved = artifactsOfVersion(
				f.values,
				"local-semantic-stage-result-v1",
			).filter(
				(value) =>
					(value.receipt as LocalSemanticReceipt).schemaHash ===
					localSemanticStageRegistry().stages.LOCAL_BLUEPRINT_V1.schemaHash,
			);
			expect(saved).toHaveLength(1);
			expect(item(saved[0]).output).toEqual(result.evidence.blueprint);
			expect(f.values.size).toBe(before.length + 1);
		} finally {
			spy.mockRestore();
		}
	});
	it("stops after three schema-invalid native outputs without saving a Blueprint or repeating accepted ledger work", async () => {
		const spy = vi.spyOn(blueprintPrompt, "prepareLocalBlueprintPrompt");
		try {
			const f = longCompactFixture({ nativeSchema: "ALWAYS" });
			f.context.parameters.targetDurationFrames = 600;
			await f.engine.prepareFullSource(f.context);
			const before = structuredClone([...f.values]);
			f.requests.length = 0;
			f.run.mockClear();
			await expect(f.engine.plan(f.context)).rejects.toMatchObject({
				code: "LOCAL_STORY_BLUEPRINT_INVALID",
				rule: "BLUEPRINT_REFS_OR_DEPENDENCIES_INVALID",
			});
			expect(f.requests.map((request) => request.stage)).toEqual([
				"LOCAL_BLUEPRINT_V1",
				"LOCAL_BLUEPRINT_V1",
				"LOCAL_BLUEPRINT_V1",
			]);
			expect(spy.mock.calls.map(([options]) => options.repairMeta)).toEqual([
				undefined,
				{ kind: "SCHEMA", attempt: 1 },
				{ kind: "SCHEMA", attempt: 2 },
			]);
			expect([...f.values]).toEqual(before);
		} finally {
			spy.mockRestore();
		}
	});
	it("does not classify a client receipt ZodError as a repairable native-output schema failure", async () => {
		const f = longCompactFixture();
		f.context.parameters.targetDurationFrames = 600;
		await f.engine.prepareFullSource(f.context);
		const before = structuredClone([...f.values]),
			invalid = localSemanticReceiptSchema.safeParse({});
		if (invalid.success) throw new Error("Malformed receipt fixture accepted");
		f.run.mockClear();
		f.run.mockRejectedValue(invalid.error);
		await expect(f.engine.plan(f.context)).rejects.toBe(invalid.error);
		expect(f.run).toHaveBeenCalledTimes(1);
		expect([...f.values]).toEqual(before);
		expect(failures(f)).toEqual([
			{ stage: "LOCAL_BLUEPRINT_V1", rule: "SCHEMA_INVALID" },
		]);
	});
	it("does not repair or replace a schema-invalid cached canonical Blueprint", async () => {
		const f = longCompactFixture();
		f.context.parameters.targetDurationFrames = 600;
		const result = await f.engine.plan(f.context);
		const stored = item(
			artifactsOfVersion(f.values, "local-semantic-stage-result-v1").find(
				(value) =>
					(value.receipt as LocalSemanticReceipt).schemaHash ===
					localSemanticStageRegistry().stages.LOCAL_BLUEPRINT_V1.schemaHash,
			),
		);
		const [key] = item([...f.values].find(([, value]) => value === stored));
		f.values.set(key, {
			...stored,
			output: {
				...result.evidence.blueprint,
				beats: result.evidence.blueprint.beats.map((beat) => ({
					...beat,
					id: "FLOW",
				})),
			},
		});
		const before = structuredClone([...f.values]);
		f.run.mockClear();
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		});
		expect(f.run).not.toHaveBeenCalled();
		expect([...f.values]).toEqual(before);
	});
	it("does not retry a later evidence-schema ZodError after a valid native Blueprint", async () => {
		const f = longCompactFixture();
		f.context.parameters.targetDurationFrames = 600;
		await f.engine.prepareFullSource(f.context);
		const invalid = localStoryEvidenceSchema.safeParse({});
		if (invalid.success) throw new Error("Malformed evidence fixture accepted");
		const spy = vi
			.spyOn(localStoryEvidenceSchema, "parse")
			.mockImplementation(() => {
				throw invalid.error;
			});
		try {
			f.requests.length = 0;
			f.run.mockClear();
			await expect(f.engine.plan(f.context)).rejects.toBe(invalid.error);
			expect(f.requests.map((request) => request.stage)).toEqual([
				"LOCAL_BLUEPRINT_V1",
			]);
			expect(f.run).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("compact Blueprint native and artifact boundaries", () => {
	it("reuses all 52 accepted ledgers, stores canonical IDs once and reloads across tasks without inference", async () => {
		const f = longCompactFixture();
		f.context.parameters.targetDurationFrames = 600;
		const full = await f.engine.prepareFullSource(f.context);
		expect(full.chunks).toHaveLength(52);
		expect(full.ledger.events).toHaveLength(52);
		expect(
			f.requests.filter((request) => request.stage === "LOCAL_LEDGER_V1"),
		).toHaveLength(52);
		const beforeLedgerValues = structuredClone([...f.values]);
		f.requests.length = 0;
		f.run.mockClear();
		const first = await f.engine.plan(f.context);
		expect(f.requests).toHaveLength(1);
		const request = item(f.requests[0]);
		expect(request.stage).toBe("LOCAL_BLUEPRINT_V1");
		const wire = payload<CompactBlueprintData>(request.prompt);
		expect(wire.eligible.map(([role]) => role)).toEqual([
			"CONTEXT",
			"ACTION",
			"CHANGE",
			"OUTCOME",
			"POINT",
		]);
		expect([
			...wire.eligible.flatMap(([, rows]) => rows),
			...wire.contextOnly.flat(),
		]).toHaveLength(52);
		expect(Buffer.byteLength(request.prompt)).toBeLessThanOrEqual(5632);
		const expectedIds = full.ledger.events.slice(0, 4).map((event) => event.id);
		expect(
			first.evidence.blueprint.beats.flatMap((beat) => beat.eventIds),
		).toEqual(expectedIds);
		expect(first.evidence.inputCoverage.processedShots).toBe(52);
		for (const [key, value] of beforeLedgerValues)
			expect(f.values.get(key)).toEqual(value);
		const savedBlueprints = artifactsOfVersion(
			f.values,
			"local-semantic-stage-result-v1",
		).filter(
			(value) =>
				(value.receipt as LocalSemanticReceipt).schemaHash ===
				localSemanticStageRegistry().stages.LOCAL_BLUEPRINT_V1.schemaHash,
		);
		expect(savedBlueprints).toHaveLength(1);
		expect(item(savedBlueprints[0]).output).toEqual(first.evidence.blueprint);
		f.requests.length = 0;
		f.run.mockClear();
		const second = await f.engine.plan({
			...f.context,
			task: { ...f.context.task, id: randomUUID() },
		});
		expect(f.run).not.toHaveBeenCalled();
		expect(f.requests).toEqual([]);
		expect(second.evidence).toEqual(first.evidence);
		expect(second.metrics.localStoryStagesCached).toBe(53);
		expect(second.metrics.localStoryStagesExecuted).toBe(0);
	});

	it.each([
		"e999999",
		"aa",
		"c0_e0",
	])("rejects unknown or mixed original native ID %s without saving a Blueprint", async (invalidId) => {
		const f = longCompactFixture({ invalidId });
		f.context.parameters.targetDurationFrames = 600;
		await f.engine.prepareFullSource(f.context);
		const before = structuredClone([...f.values]);
		f.requests.length = 0;
		f.run.mockClear();
		await expect(f.engine.plan(f.context)).rejects.toMatchObject({
			code: "LOCAL_STORY_BLUEPRINT_INVALID",
			rule: "BLUEPRINT_REFS_OR_DEPENDENCIES_INVALID",
		});
		expect(f.requests.map((request) => request.stage)).toEqual([
			"LOCAL_BLUEPRINT_V1",
		]);
		expect([...f.values]).toEqual(before);
	});
});

describe("caption-only VAD projection with unchanged semantic caches", () => {
	it.each([
		{ choice: false, language: "ja" },
		{ choice: true, language: "ja" },
		{ choice: false, language: "en" },
		{ choice: true, language: "en" },
		{ choice: false, language: "mixed" },
		{ choice: true, language: "mixed" },
	])("passes caption metadata through planner choice=$choice language=$language without changing semantic input or caches", async ({
		choice,
		language,
	}) => {
		const f = fixture({ choiceEnabled: choice });
		const support = [{ startUs: 1_000_000, endUs: 2_000_000 }];
		const captionLanguage = language === "mixed" ? undefined : language;
		const languageWindows = [
			{ startUs: 0, endUs: 5_000_000, language: captionLanguage ?? "ja" },
			{
				startUs: 5_000_000,
				endUs: 10_000_000,
				language: captionLanguage ?? "ko",
			},
		];
		const meaning = {
			qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
			segments: f.segments,
			status: "READY" as const,
			fingerprint: hashEditingEvidence(f.segments),
			warnings: [],
			modelSha256: "b".repeat(64),
			cached: true,
		};
		const captionTimingEvidence = {
			sourceTimeDomain: "ORIGINAL_PRESENTATION_US" as const,
			mediaSha256: f.context.verified.media.sha256,
			modelSha256: meaning.modelSha256,
			qualityPolicyFingerprint: meaning.qualityPolicyFingerprint,
			transcriptHash: meaning.fingerprint,
			rawSegments: [],
			speechIntervals: support,
		};
		mocks.prepareTranscript.mockImplementation(
			async (input: {
				includeSpeechIntervals?: boolean;
				includeCaptionLanguage?: boolean;
			}) => ({
				...structuredClone(meaning),
				...(input.includeCaptionLanguage
					? {
							captionTimingEvidence: structuredClone(captionTimingEvidence),
							...(captionLanguage ? { language: captionLanguage } : {}),
							languageWindows: structuredClone(languageWindows),
						}
					: {}),
				...(input.includeSpeechIntervals
					? { speechIntervals: structuredClone(support) }
					: {}),
			}),
		);
		const context = {
			...f.context,
			parameters: {
				...f.context.parameters,
				captions: "ORIGINAL" as const,
				...(choice ? { storyPlanner: "FEASIBLE_CHOICE_V1" as const } : {}),
			},
		};
		const first = await f.engine.plan(context);
		expect(first.speechIntervals).toEqual(support);
		expect(first.transcriptLanguage).toBe(captionLanguage);
		expect(first.transcriptLanguageWindows).toEqual(languageWindows);
		expect(first.captionTimingEvidence).toEqual(captionTimingEvidence);
		expect(mocks.prepareTranscript).toHaveBeenLastCalledWith(
			expect.objectContaining({
				includeSpeechIntervals: true,
				includeCaptionLanguage: true,
			}),
		);
		const storedBefore = structuredClone([...f.values]);
		f.requests.length = 0;
		f.run.mockClear();
		const second = await f.engine.plan({
			...context,
			task: { ...context.task, id: randomUUID() },
		});
		expect(second.speechIntervals).toEqual(support);
		expect(second.transcriptLanguage).toBe(captionLanguage);
		expect(second.transcriptLanguageWindows).toEqual(languageWindows);
		expect(second.captionTimingEvidence).toEqual(captionTimingEvidence);
		expect(second.evidence).toEqual(first.evidence);
		expect(second.segments).toEqual(first.segments);
		expect(f.run).not.toHaveBeenCalled();
		expect([...f.values]).toEqual(storedBefore);
		expect(second.evidence.inputHash).toBe(hashEditingEvidence(f.input));
		const full = await f.engine.prepareFullSource(context);
		expect(full.transcript).not.toHaveProperty("speechIntervals");
		expect(full.transcript).not.toHaveProperty("language");
		expect(full.transcript).not.toHaveProperty("languageWindows");
		expect(full.transcript).not.toHaveProperty("captionTimingEvidence");
		expect(mocks.prepareTranscript).toHaveBeenLastCalledWith(
			expect.objectContaining({
				includeSpeechIntervals: false,
				includeCaptionLanguage: false,
			}),
		);
		expect(full.transcript.fingerprint).toBe(meaning.fingerprint);
	});
	it.each([
		false,
		true,
	])("does not extract caption timing evidence with captions OFF (choice=%s)", async (choice) => {
		const f = fixture({ choiceEnabled: choice });
		const result = await f.engine.plan({
			...f.context,
			parameters: {
				...f.context.parameters,
				...(choice ? { storyPlanner: "FEASIBLE_CHOICE_V1" as const } : {}),
			},
		});
		expect(mocks.prepareTranscript).toHaveBeenLastCalledWith(
			expect.objectContaining({
				includeCaptionLanguage: false,
			}),
		);
		expect(result).not.toHaveProperty("captionTimingEvidence");
		expect(result.evidence.inputHash).toBe(hashEditingEvidence(f.input));
	});
});
