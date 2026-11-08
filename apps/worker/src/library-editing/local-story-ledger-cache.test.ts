import { createHash, randomUUID } from "node:crypto";
import {
	cfrTimeMapSchema,
	hashEditingEvidence,
	type LocalStoryChunk,
	type LocalStoryInput,
	localSemanticStageRegistry,
	localStoryIdentityForConfiguration,
} from "@bitovp/core";
import { LocalStoryLegacyLedgerError } from "@bitovp/core/local-story-flow-server";
import { describe, expect, it } from "vitest";
import { localAsrQuoteRepairPrompt } from "./local-story-asr-quote-repair";
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
	localLedgerPrompt,
	localLegacyV3StructuredLedgerRepairPrompt,
	localNumericLedgerRepairPrompt,
	localQuoteLedgerRepairPrompt,
	localStructuredLedgerRepairPrompt,
} from "./local-story-prompts";
import { MediaOperationError } from "./process";

function fixture(frozen = false) {
	const speech = [
		" Listen, Celia. I was young.",
		" and a dick.",
		" But there's no reason to destroy the world.",
	];
	const timeMap = cfrTimeMapSchema.parse({
		id: "11111111-1111-4111-8111-111111111111",
		mediaVersionId: "22222222-2222-4222-8222-222222222222",
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: 30_000_000,
		editingStartFrame: 0,
		editingEndFrame: 900,
		fps: { num: 30, den: 1 },
	});
	const input: LocalStoryInput = {
		version: "local-story-input-v1",
		title: "A supported conversation",
		description: "A character asks another character to stop.",
		timeMap,
		timeMapHash: hashEditingEvidence(timeMap),
		scenes: [],
		shots: [
			{
				ref: "s0",
				sceneId: "scene0",
				fromFrame: 0,
				toFrame: 900,
				text: speech.join(" "),
				fields: [
					{ pointer: "/shots/0/text", kind: "AISA", text: "A person speaks." },
					...speech.map((text, index) => ({
						pointer: `/segments/${index}`,
						kind: "ASR" as const,
						text,
					})),
				],
			},
		],
		coverage: [{ ref: "s0", status: "ELIGIBLE" }],
		segments: speech.map((text, index) => ({
			startUs: index * 1_000_000,
			endUs: (index + 1) * 1_000_000,
			text,
		})),
	};
	const chunk: LocalStoryChunk = {
		id: "c0",
		refs: ["s0"],
		context: [],
		shots: [{ ref: "s0", sceneId: "scene0", text: input.shots[0]?.text ?? "" }],
	};
	const options = {
		identity: localStoryIdentityForConfiguration({
			url: "https://fixture.invalid/",
			token: "fixture-token-".repeat(3),
			caFile: "/not-read/fixture.pem",
			profile: "nvidia",
			configId: "33333333-3333-4333-8333-333333333333",
		}),
		input,
		chunk,
		transcriptFingerprint: hashEditingEvidence(input.segments),
		definition: localSemanticStageRegistry().stages.LOCAL_LEDGER_V1,
		validationPolicyVersion: LOCAL_STORY_LEDGER_VALIDATION_POLICY,
	};
	if (!frozen) {
		const shot = input.shots[0],
			packed = chunk.shots[0];
		if (!shot || !packed) throw new Error("Expected authored source shot");
		shot.text = shot.fields.map((field) => field.text).join("\n");
		packed.text = shot.text;
		input.scenes = [{ sceneId: shot.sceneId, text: "", fields: [] }];
		chunk.context = [{ sceneId: shot.sceneId, text: "" }];
	}
	const joinedPrompt = localAsrQuoteRepairPrompt({
		input,
		chunk,
		ledger: {
			summary: "The conversation continues.",
			events: [
				{
					id: "e0",
					label: "A character asks the other to stop.",
					role: "ACTION",
					refs: ["s0"],
					quotes: [
						{ ref: "s0", quote: speech.join(" ").replace(/\s+/gu, " ").trim() },
					],
					subjects: [],
					uncertainty: "",
				},
			],
		},
	});
	if (!joinedPrompt) throw new Error("Expected the authored exact ASR join");
	return {
		options,
		joinedPrompt,
		cache: frozen
			? createLegacyV2LocalStoryLedgerCache(options)
			: createLocalStoryLedgerCache(options),
	};
}

describe("accepted local ledger cache contract", () => {
	it("matches the frozen v3 key and structured pointers captured from the 762c9 source", () => {
		const f = fixture(),
			legacy = createLegacyV3LocalStoryLedgerCache(f.options);
		expect(legacy.key.validationPolicyVersion).toBe(
			"exact-source-ledger-validation-v3",
		);
		expect(hashEditingEvidence(legacy.key)).toBe(
			"647dedb941438f95e2eacde8f61d5bafca2418567954b87915fe9f8249714ef6",
		);
		expect(legacy.key.promptPolicyHash).toBe(
			"0a6446d4db23551e3fe4c71b3773cc5b6851ea6169331948c19252ccec54e40f",
		);
		expect(hashEditingEvidence(legacy.stageInput)).toBe(
			"2eabe84fd191653c4cf3abcae84f17323aba0d60142a7af67018e63e8d271a4c",
		);
		const expected = {
			QUOTE: {
				stageKeyHash:
					"04c47de2ffa9350cba2db98034f5edd6eb05519c409942f54d3f69d3a78a34a3",
				pointerHash:
					"fc37d0f1fca1dbe5fa71a20de7b584d7f2cad50c593448da7fc60ccedc66563a",
			},
			ASR: {
				stageKeyHash:
					"fa79e1fd025684324340392fd30d0cc7e25d9cec0b1d2bd408f0eb36292f98b8",
				pointerHash:
					"f9c9dae6d9e8dcc8b32254ecd34c17a35ec9685c01180624b408d971f05e8c8c",
			},
		};
		for (const family of ["QUOTE", "ASR"] as const) {
			const prompt = localLegacyV3StructuredLedgerRepairPrompt({
				...f.options,
				family,
			});
			if (!prompt) throw new Error("Expected the frozen v3 prompt");
			const pointer = legacy.pointer(prompt);
			expect(pointer.stageKeyHash).toBe(expected[family].stageKeyHash);
			expect(hashEditingEvidence(pointer)).toBe(expected[family].pointerHash);
			expect(legacy.parse(structuredClone(pointer))).toEqual(pointer);
			expect(f.cache.parse(f.cache.pointer(prompt)).prompt).toBe(prompt);
			expect(() =>
				legacy.pointer(
					localStructuredLedgerRepairPrompt({ ...f.options, family }) ?? "",
				),
			).toThrow("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		}
	});
	it("keeps the frozen v3 oversized-family null hashes and unchanged BASE repair bytes", () => {
		const f = fixture(),
			base = localLedgerPrompt(f.options.chunk);
		const sha = (prompt: string) =>
			createHash("sha256").update(prompt).digest("hex");
		expect(sha(base)).toBe(
			"9c4e75744d1efdd3b1bba1ce42e770e008a08e36f7653ec2504d68337c42e24d",
		);
		expect(sha(base + LOCAL_LEDGER_GENERIC_REPAIR_SUFFIX)).toBe(
			"f7a76619b641b99d5a0585d9a5542693936949dd1121ea661de9de414f785ea2",
		);
		const numeric = localNumericLedgerRepairPrompt(f.options.chunk);
		if (!numeric) throw new Error("Expected the frozen numeric prompt");
		expect(sha(numeric)).toBe(
			"3f982bccdb5798401f8024855999f44020f634c6cd5ebaf19c0762a5408df1d7",
		);
		const shot = f.options.input.shots[0],
			packed = f.options.chunk.shots[0];
		if (!shot || !packed || !shot.fields[0])
			throw new Error("Expected authored source fields");
		shot.fields[0].text += "x".repeat(6144);
		shot.text = shot.fields.map((field) => field.text).join("\n");
		packed.text = shot.text;
		const legacy = createLegacyV3LocalStoryLedgerCache(f.options);
		expect(hashEditingEvidence(legacy.key)).toBe(
			"7a680d3fb094caeb1aca82dbb4deb36b12ba914812a44ccc1b1d97edf1be5a74",
		);
		expect(legacy.key.promptPolicyHash).toBe(
			"e02d8f5abe7c49cd85b4d0b17c2a982c825f362398d8aa020acfddecf4c2259a",
		);
	});
	it("retains an exact legacy v3 prompt when only the new output instructions exceed the cap", () => {
		const f = fixture(),
			shot = f.options.input.shots[0],
			packed = f.options.chunk.shots[0],
			first = localLegacyV3StructuredLedgerRepairPrompt({
				...f.options,
				family: "QUOTE",
			});
		if (!shot || !packed || !shot.fields[0] || !first)
			throw new Error("Expected bounded authored fields");
		shot.fields[0].text += "x".repeat(6144 - Buffer.byteLength(first));
		shot.text = shot.fields.map((field) => field.text).join("\n");
		packed.text = shot.text;
		const prompt = localLegacyV3StructuredLedgerRepairPrompt({
			...f.options,
			family: "QUOTE",
		});
		if (!prompt) throw new Error("Expected the complete 6144-byte old prompt");
		expect(Buffer.byteLength(prompt)).toBe(6144);
		expect(
			localStructuredLedgerRepairPrompt({ ...f.options, family: "QUOTE" }),
		).toBeUndefined();
		const legacy = createLegacyV3LocalStoryLedgerCache(f.options),
			current = createLocalStoryLedgerCache(f.options);
		expect(legacy.parse(legacy.pointer(prompt)).prompt).toBe(prompt);
		expect(current.parse(current.pointer(prompt)).prompt).toBe(prompt);
	});
	it("matches the frozen v1 legacy key and four prompt pointers captured before the quote policy", () => {
		const f = fixture(true),
			legacy = createLegacyLocalStoryLedgerCache(f.options);
		expect(LOCAL_STORY_LEGACY_LEDGER_VALIDATION_POLICY).toBe(
			"exact-source-ledger-validation-v1",
		);
		expect(legacy.key.validationPolicyVersion).toBe(
			"exact-source-ledger-validation-v1",
		);
		expect(hashEditingEvidence(legacy.key)).toBe(
			"7d4d3d2aadd46b235063fd9774a5701ec3728265fdceb4d563a800a5e52443da",
		);
		expect(legacy.key.promptPolicyHash).toBe(
			"bb2ad7c98d216e9f4379c45bc68342db0281496050afd275323343570307dcd7",
		);
		const base = localLedgerPrompt(f.options.chunk);
		const families = [
			[
				base,
				"86752829cfd62eb0a03fcd46be216f48826ce643be58a680a7ed03ed5dee0027",
				"9b6fda116edddf149a75db02a1c577c99c9c1156db9315d513d7875e68650cd1",
			],
			[
				base + LOCAL_LEDGER_GENERIC_REPAIR_SUFFIX,
				"5c88bf0ef1689f9ce2d718451806b90ab1913a5b8d93d5a2aaec876484cca718",
				"4a88160a9da7a307850629ffd3ab8713402636a3010117970cb2b599e413fa02",
			],
			[
				localNumericLedgerRepairPrompt(f.options.chunk),
				"fbb9212b5928dc646b60d6ca68193cb7a0ff66177eda6f5da084650c73df24f8",
				"2a101bc5dac0f14ab5be845941ada2ddeda5dda3f0a93c570d629de21ef90b2a",
			],
			[
				f.joinedPrompt,
				"1b9c11fbdbb8af32d479e43b879e3fdfdb7889c1eb59b318d901b20ac66cdb02",
				"4afd5a02fb7704d106cd57af493a60a826cca61b6c8fe606ebe2933c4393828b",
			],
		];
		for (const [prompt, stageKeyHash, pointerHash] of families) {
			if (!prompt) throw new Error("Expected bounded frozen prompt");
			const pointer = legacy.pointer(prompt);
			expect(pointer.stageKeyHash).toBe(stageKeyHash);
			expect(hashEditingEvidence(pointer)).toBe(pointerHash);
			expect(legacy.parse(structuredClone(pointer))).toEqual(pointer);
		}
	});
	it("matches the frozen legacy numeric:null key when the numeric prompt cannot fit", () => {
		const f = fixture(true);
		const shot = f.options.chunk.shots[0];
		if (!shot) throw new Error("Expected authored shot");
		shot.text += "x".repeat(6144);
		expect(localNumericLedgerRepairPrompt(f.options.chunk)).toBeUndefined();
		const legacy = createLegacyLocalStoryLedgerCache(f.options);
		expect(hashEditingEvidence(legacy.key)).toBe(
			"66b6a55e0e26fb4b9bfebc5e3d66c592b8050f98ef7401d386aeb41d34a95b54",
		);
		expect(legacy.key.promptPolicyHash).toBe(
			"8dd64500737494fa1b9acd568e4bf02ff86c36131cde77768388dd03fd31a7e5",
		);
	});
	it("keeps the exact fixed v2 key and old quote family including the oversized quote hash", () => {
		const f = fixture(true),
			legacy = createLegacyV2LocalStoryLedgerCache(f.options);
		expect(legacy.key.validationPolicyVersion).toBe(
			"exact-source-ledger-validation-v2",
		);
		expect(hashEditingEvidence(legacy.key)).toBe(
			"5a17b336b2118857e84e2ca1ab4d448a7da114bb2ce703395b62721e4a41802c",
		);
		expect(legacy.key.promptPolicyHash).toBe(
			"ed268b8056bba89c62ad4de2da9b28fc9e96fde135039df2a3789baa9a3b525c",
		);
		const quote = localQuoteLedgerRepairPrompt(f.options.chunk);
		if (!quote) throw new Error("Expected frozen quote prompt");
		expect(legacy.pointer(quote).stageKeyHash).toBe(
			"99f07c641e37dc9a0387b16a9a5eaef0c0c0754620ea2a3b447eadb02088114a",
		);
		expect(hashEditingEvidence(legacy.pointer(quote))).toBe(
			"4b06afc018e0ddd17e732f458b374873776534b311dd7a94ade4f7d81bd07192",
		);
		const shot = f.options.chunk.shots[0];
		if (!shot) throw new Error("Expected frozen shot");
		shot.text += "x".repeat(6144);
		expect(localQuoteLedgerRepairPrompt(f.options.chunk)).toBeUndefined();
		expect(
			createLegacyV2LocalStoryLedgerCache(f.options).key.promptPolicyHash,
		).toBe("49f73d6932276ff57684486a7ac2f960d9850efe3c122a755b6bb15c0fa8ab92");
	});
	it("binds both compact structured families in v4 while fixed predecessors refuse them", () => {
		const f = fixture();
		expect(LOCAL_STORY_LEDGER_VALIDATION_POLICY).toBe(
			"exact-source-ledger-validation-v4",
		);
		for (const family of ["QUOTE", "ASR"] as const) {
			const prompt = localStructuredLedgerRepairPrompt({
				...f.options,
				family,
			});
			if (!prompt) throw new Error("Expected bounded structured prompt");
			expect(f.cache.parse(f.cache.pointer(prompt)).prompt).toBe(prompt);
			expect(() =>
				createLegacyV2LocalStoryLedgerCache(f.options).pointer(prompt),
			).toThrow();
			expect(() =>
				createLegacyLocalStoryLedgerCache(f.options).pointer(prompt),
			).toThrow();
		}
	});
	it("versions the quote family separately while the fixed legacy parser refuses it", () => {
		const f = fixture(),
			legacy = createLegacyLocalStoryLedgerCache(f.options),
			quote = localQuoteLedgerRepairPrompt(f.options.chunk);
		if (!quote) throw new Error("Expected the authored bounded quote prompt");
		expect(LOCAL_STORY_LEDGER_VALIDATION_POLICY).not.toBe(
			LOCAL_STORY_LEGACY_LEDGER_VALIDATION_POLICY,
		);
		expect(hashEditingEvidence(f.cache.key)).not.toBe(
			hashEditingEvidence(legacy.key),
		);
		expect(f.cache.key.promptPolicyHash).not.toBe(legacy.key.promptPolicyHash);
		expect(f.cache.parse(f.cache.pointer(quote)).prompt).toBe(quote);
		expect(() => legacy.pointer(quote)).toThrow(
			"LOCAL_STORY_ARTIFACT_UNVERIFIED",
		);
	});
	it("binds the original stage key while allowing all existing successful repair prompt families", () => {
		const f = fixture();
		const base = localLedgerPrompt(f.options.chunk);
		for (const prompt of [
			base,
			base + LOCAL_LEDGER_GENERIC_REPAIR_SUFFIX,
			localNumericLedgerRepairPrompt(f.options.chunk),
			f.joinedPrompt,
		]) {
			if (!prompt) throw new Error("Expected a bounded prompt");
			const pointer = f.cache.pointer(prompt);
			expect(f.cache.parse(structuredClone(pointer))).toEqual(pointer);
			expect(pointer.stageKeyHash).toMatch(/^[a-f0-9]{64}$/);
		}
	});

	it.each([
		"prompt",
		"stageKeyHash",
		"validationPolicyVersion",
		"version",
		"extra",
	])("rejects an altered accepted pointer %s", (field) => {
		const f = fixture();
		const pointer = {
			...f.cache.pointer(localLedgerPrompt(f.options.chunk)),
			[field]: "altered",
		};
		expect(() => f.cache.parse(pointer)).toThrow();
	});

	it("does not cross the model/profile/config, source input, ASR, schema or validation policy boundary", () => {
		const f = fixture();
		const changed = [
			{
				...f.options,
				identity: { ...f.options.identity, profile: "amd" as const },
			},
			{
				...f.options,
				identity: { ...f.options.identity, configId: randomUUID() },
			},
			{
				...f.options,
				identity: { ...f.options.identity, modelDigest: "c".repeat(64) },
			},
			{
				...f.options,
				input: { ...f.options.input, title: "Changed source context" },
			},
			{ ...f.options, transcriptFingerprint: "d".repeat(64) },
			{
				...f.options,
				definition: { ...f.options.definition, schemaHash: "e".repeat(64) },
			},
			{ ...f.options, validationPolicyVersion: "a-new-validation-policy" },
		];
		for (const options of changed) {
			const other = createLocalStoryLedgerCache(options);
			expect(hashEditingEvidence(other.key)).not.toBe(
				hashEditingEvidence(f.cache.key),
			);
		}
		const other = createLocalStoryLedgerCache(changed[6] ?? f.options);
		expect(() =>
			other.parse(f.cache.pointer(localLedgerPrompt(f.options.chunk))),
		).toThrow();
	});

	it.each([
		"text",
		"pointer",
		"ref",
		"duplicate",
		"aisa",
		"noncanonical",
	])("rejects %s source candidates in a stored ASR repair prompt", (change) => {
		const f = fixture();
		const marker = "\nSOURCE_FIELDS\n";
		const index = f.joinedPrompt.lastIndexOf(marker) + marker.length;
		const fields = JSON.parse(f.joinedPrompt.slice(index)) as {
			ref: string;
			pointer: string;
			text: string;
		}[];
		const field = fields[0];
		if (!field) throw new Error("Expected authored source candidate");
		if (change === "duplicate") fields.push({ ...field });
		else if (change === "aisa") {
			field.pointer = "/shots/0/text";
			field.text = "A person speaks.";
		} else if (change === "text") field.text = "altered";
		else if (change === "pointer") field.pointer = "altered";
		else if (change === "ref") field.ref = "altered";
		const prompt =
			f.joinedPrompt.slice(0, index) +
			JSON.stringify(fields, null, change === "noncanonical" ? 2 : undefined);
		expect(() => f.cache.pointer(prompt)).toThrow();
	});

	it("does not accept an arbitrary or oversized prompt", () => {
		const f = fixture();
		expect(() =>
			f.cache.pointer("Use outside knowledge to invent an ending."),
		).toThrow();
		expect(() => f.cache.pointer(f.joinedPrompt + " ".repeat(6144))).toThrow();
	});

	it.each([
		"LOCAL_STORY_ARTIFACT_UNVERIFIED",
		"LOCAL_STORY_REPAIR_INPUT_INVALID",
	] as const)("maps shared %s errors to the legacy worker class", (code) => {
		const f = fixture(),
			shared = new LocalStoryLegacyLedgerError(code);
		Object.defineProperty(f.options.input, "shots", {
			get() {
				throw shared;
			},
		});
		let caught: unknown;
		try {
			createLocalStoryLedgerCache(f.options);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(MediaOperationError);
		expect(caught).toMatchObject({
			code,
			message: code,
			name: "MediaOperationError",
			diagnostic: undefined,
		});
	});
	it("preserves an arbitrary same-code error object without class-based remapping", () => {
		const f = fixture(),
			foreign = new RangeError("authored foreign error");
		Reflect.set(foreign, "code", "LOCAL_STORY_ARTIFACT_UNVERIFIED");
		Object.defineProperty(f.options.input, "shots", {
			get() {
				throw foreign;
			},
		});
		let caught: unknown;
		try {
			createLocalStoryLedgerCache(f.options);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(foreign);
	});

	it.each([
		"current",
		"legacyV3",
	] as const)("keeps the %s prompt facade's original worker error class", (version) => {
		const f = fixture(),
			shared = new LocalStoryLegacyLedgerError(
				"LOCAL_STORY_REPAIR_INPUT_INVALID",
			);
		Object.defineProperty(f.options.input, "shots", {
			get() {
				throw shared;
			},
		});
		let caught: unknown;
		try {
			const prompt =
				version === "current"
					? localStructuredLedgerRepairPrompt
					: localLegacyV3StructuredLedgerRepairPrompt;
			prompt({ ...f.options, family: "QUOTE" });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(MediaOperationError);
		expect(caught).toMatchObject({
			code: "LOCAL_STORY_REPAIR_INPUT_INVALID",
			message: "LOCAL_STORY_REPAIR_INPUT_INVALID",
			diagnostic: undefined,
		});
	});
});
