import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	LOCAL_SEMANTIC_MODEL,
	LOCAL_SEMANTIC_MODEL_DIGEST,
	LOCAL_SEMANTIC_RUNTIME_VERSION,
	type LocalSemanticReceipt,
} from "./local-semantic-protocol";
import {
	localSemanticStageRegistry,
	localStoryIdentityForConfiguration,
} from "./local-semantic-stages";
import type { LocalStoryChunk, LocalStoryInput } from "./local-story-contracts";
import {
	createLocalStoryLegacyLedgerCacheRecipe,
	createLocalStoryLegacyLedgerStageRecipe,
	LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY,
	localStoryLegacyLedgerPrompt,
} from "./local-story-flow-legacy-ledger";
import { cfrTimeMapSchema } from "./schema";
import { hashEditingEvidence } from "./verify-automatic-binding";

function item<T>(value: T | null | undefined): T {
	if (value === undefined || value === null)
		throw new Error("Missing authored fixture value");
	return value;
}
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
		sourceEndUs: 30000000,
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
			startUs: index * 1000000,
			endUs: (index + 1) * 1000000,
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
		validationPolicyVersion: "exact-source-ledger-validation-v4",
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
	return { options };
}
const BEFORE_BASE = {
	BASE: {
		utf8Bytes: 1337,
		sha256: "9c4e75744d1efdd3b1bba1ce42e770e008a08e36f7653ec2504d68337c42e24d",
	},
	GENERIC: {
		utf8Bytes: 1687,
		sha256: "f7a76619b641b99d5a0585d9a5542693936949dd1121ea661de9de414f785ea2",
	},
	NUMERIC: {
		utf8Bytes: 1610,
		sha256: "3f982bccdb5798401f8024855999f44020f634c6cd5ebaf19c0762a5408df1d7",
	},
	QUOTE: {
		utf8Bytes: 1655,
		sha256: "70d71f816b66d8df2ef9a2edb88e33ed3ff92e140a4cf312af6563fd8f65adf8",
	},
	V3_QUOTE: {
		utf8Bytes: 1249,
		sha256: "221bb52adc9da19a37e87d9ecabdc8e95005f6fdfff49f3b6fcf127b8db87a32",
	},
	V4_QUOTE: {
		utf8Bytes: 1521,
		sha256: "8ddb3d6a420fbbf850acf09fb511247fd333a6d8bb7bd2181d05f0eee1521095",
	},
	V3_ASR: {
		utf8Bytes: 1252,
		sha256: "e0ed2f00c9c79f86977cd4165ebb18615cd50e6a47bcf556c570d91337a9c671",
	},
	V4_ASR: {
		utf8Bytes: 1524,
		sha256: "a1277943aec36805a712a548430110f80c716d3704b7f4f38cd465dc48f74d46",
	},
};
type CacheVersion = "V1" | "V2" | "V3" | "V4";
// Pointer hash: accepted. null: original prompt refused. false: complete prompt could not fit.
// Full captured originals remain in author evidence.
type BeforeCacheRow = {
	version: CacheVersion;
	oversized: boolean;
	keyHash: string;
	stageInputHash: string;
	inputHash: string;
	promptPolicyHash: string;
	families: Record<string, string | null | false>;
};
const BEFORE_CACHES: BeforeCacheRow[] = [
	{
		version: "V1",
		oversized: false,
		keyHash: "7d4d3d2aadd46b235063fd9774a5701ec3728265fdceb4d563a800a5e52443da",
		stageInputHash:
			"bf15ce3b10f4a309388ea2c579c2d399e91eff8ea519dcd907c6be08170ecb44",
		inputHash:
			"2dc96d11bbfb9a37d5f52c321a210691ae543da33427cd7a5a534f358516ec43",
		promptPolicyHash:
			"bb2ad7c98d216e9f4379c45bc68342db0281496050afd275323343570307dcd7",
		families: {
			BASE: "9b6fda116edddf149a75db02a1c577c99c9c1156db9315d513d7875e68650cd1",
			GENERIC:
				"4a88160a9da7a307850629ffd3ab8713402636a3010117970cb2b599e413fa02",
			NUMERIC:
				"2a101bc5dac0f14ab5be845941ada2ddeda5dda3f0a93c570d629de21ef90b2a",
			QUOTE: null,
			OLD_ASR:
				"4afd5a02fb7704d106cd57af493a60a826cca61b6c8fe606ebe2933c4393828b",
		},
	},
	{
		version: "V1",
		oversized: true,
		keyHash: "66b6a55e0e26fb4b9bfebc5e3d66c592b8050f98ef7401d386aeb41d34a95b54",
		stageInputHash:
			"4ab7d94e7a59e59e9951edfbe8d492b645a191d5d809aea2e1f75d6b7edb0aa6",
		inputHash:
			"2dc96d11bbfb9a37d5f52c321a210691ae543da33427cd7a5a534f358516ec43",
		promptPolicyHash:
			"8dd64500737494fa1b9acd568e4bf02ff86c36131cde77768388dd03fd31a7e5",
		families: {
			BASE: null,
			GENERIC: null,
			NUMERIC: false,
			QUOTE: false,
			OLD_ASR: null,
		},
	},
	{
		version: "V2",
		oversized: false,
		keyHash: "5a17b336b2118857e84e2ca1ab4d448a7da114bb2ce703395b62721e4a41802c",
		stageInputHash:
			"bf15ce3b10f4a309388ea2c579c2d399e91eff8ea519dcd907c6be08170ecb44",
		inputHash:
			"2dc96d11bbfb9a37d5f52c321a210691ae543da33427cd7a5a534f358516ec43",
		promptPolicyHash:
			"ed268b8056bba89c62ad4de2da9b28fc9e96fde135039df2a3789baa9a3b525c",
		families: {
			BASE: "4d54f721184632c477623c5cc77f3d4e2aee79fefa8f3a433103ece0323d6954",
			GENERIC:
				"658c1eca7dca48cd392b082061217ecc3a350559fa2809d84fc67e1d034fefd3",
			NUMERIC:
				"b1b5fbf29dac65eda844efe87d9db75ecc7f45cc99157ff45ab6d64c308680ae",
			QUOTE: "4b06afc018e0ddd17e732f458b374873776534b311dd7a94ade4f7d81bd07192",
			OLD_ASR:
				"0abbda5eb5aa912e104ef834e23445ec648df377c09f0b35f5c16888e9ac3319",
		},
	},
	{
		version: "V2",
		oversized: true,
		keyHash: "3027d73168d4f9be45e307893a079767b92f707a0f9f0c356992822c547560ea",
		stageInputHash:
			"4ab7d94e7a59e59e9951edfbe8d492b645a191d5d809aea2e1f75d6b7edb0aa6",
		inputHash:
			"2dc96d11bbfb9a37d5f52c321a210691ae543da33427cd7a5a534f358516ec43",
		promptPolicyHash:
			"49f73d6932276ff57684486a7ac2f960d9850efe3c122a755b6bb15c0fa8ab92",
		families: {
			BASE: null,
			GENERIC: null,
			NUMERIC: false,
			QUOTE: false,
			OLD_ASR: null,
		},
	},
	{
		version: "V3",
		oversized: false,
		keyHash: "647dedb941438f95e2eacde8f61d5bafca2418567954b87915fe9f8249714ef6",
		stageInputHash:
			"2eabe84fd191653c4cf3abcae84f17323aba0d60142a7af67018e63e8d271a4c",
		inputHash:
			"29aad33bf48f817a30132fb7907e628cbe2c5c7d0dd169a1eee3aec4e4f765eb",
		promptPolicyHash:
			"0a6446d4db23551e3fe4c71b3773cc5b6851ea6169331948c19252ccec54e40f",
		families: {
			BASE: "3d9d0690722128c84a178e005e5ad83fc916a01d00eed07deb70f4d65f5acad7",
			GENERIC:
				"46d674400060a88167c45e5ce443d826f1f00f98819f1c55fbcd7977845d3e83",
			NUMERIC:
				"850875d0fd1ad85580b26afc2936024357a7290219ee026e244cbb7dd244b857",
			QUOTE: "11ae94fec287e2a8ecfcf3a492a5dd946846c81344bf55a4a0b1f7f10db0d4f6",
			OLD_ASR:
				"5e123020f7a3f90e3b01619711015f86ba2a60949582f3b568d4c79208da713a",
			V3_QUOTE:
				"fc37d0f1fca1dbe5fa71a20de7b584d7f2cad50c593448da7fc60ccedc66563a",
			V4_QUOTE: null,
			V3_ASR:
				"f9c9dae6d9e8dcc8b32254ecd34c17a35ec9685c01180624b408d971f05e8c8c",
			V4_ASR: null,
		},
	},
	{
		version: "V3",
		oversized: true,
		keyHash: "7a680d3fb094caeb1aca82dbb4deb36b12ba914812a44ccc1b1d97edf1be5a74",
		stageInputHash:
			"f521f0ed5e31b6bbf874bc6536244e34978a8766c0ef1888d9f4be9028d5483e",
		inputHash:
			"dda0bbd03486c51e5150e0aa027ef9cd0d3143167b936ab098534bc54e01c0ea",
		promptPolicyHash:
			"e02d8f5abe7c49cd85b4d0b17c2a982c825f362398d8aa020acfddecf4c2259a",
		families: {
			BASE: null,
			GENERIC: null,
			NUMERIC: false,
			QUOTE: false,
			OLD_ASR: null,
			V3_QUOTE: false,
			V4_QUOTE: false,
			V3_ASR: false,
			V4_ASR: false,
		},
	},
	{
		version: "V4",
		oversized: false,
		keyHash: "ec6f690d44a272e2e25bfd027c3ea98104092e4ea2f2a9153f35c18565c4b381",
		stageInputHash:
			"2eabe84fd191653c4cf3abcae84f17323aba0d60142a7af67018e63e8d271a4c",
		inputHash:
			"29aad33bf48f817a30132fb7907e628cbe2c5c7d0dd169a1eee3aec4e4f765eb",
		promptPolicyHash:
			"4720d1ed1f6fb56141c22d757da76cf5222872a145ab3fbc3bac1eb1cc00c876",
		families: {
			BASE: "d657e2e6255c3ae0a61aea70a341d6e070ad16d9f724a80777994c26c420fcf0",
			GENERIC:
				"8e0e75cbdf0d8e09d325b333a666e1624de0663e1a3f7119b4a1abf56f2d3e53",
			NUMERIC:
				"685d4d4b48ddffd6b66d1817401546bfcb5982508a1720369ad71837ef22c5ea",
			QUOTE: "877cd63a5139e8ae24fb863a6eecbc03ecf2a7f2a9a14f4be81aebaae5801ed5",
			OLD_ASR:
				"f58094d803d364d28ebf9355279978937bf9078fadd66bfaa5655d65d67d2f6a",
			V3_QUOTE:
				"87e4dca2b4bb3ece533adb3210dfbe334195da277aa88dbb5256abcdce2061c2",
			V4_QUOTE:
				"4d69c3c73c793696d7fa4e328376e8a32f61c681ef494c4db92545ac50af37b4",
			V3_ASR:
				"3a6803997a049985e0567388fd519ec6a9a5e87495d70f68c90bf8f8791d5a76",
			V4_ASR:
				"a376fd8ae2e8b8b39540d161151203eb98659276760af1c314c9b536baaae740",
		},
	},
	{
		version: "V4",
		oversized: true,
		keyHash: "7f63b976c1cdfdf59c857aa847dd57c562a38c71d218ad557e91d12d6b099284",
		stageInputHash:
			"f521f0ed5e31b6bbf874bc6536244e34978a8766c0ef1888d9f4be9028d5483e",
		inputHash:
			"dda0bbd03486c51e5150e0aa027ef9cd0d3143167b936ab098534bc54e01c0ea",
		promptPolicyHash:
			"6756bc75d12cf0f182cc1b808e772e64dfe5dc01c3668888a2611076e7229218",
		families: {
			BASE: null,
			GENERIC: null,
			NUMERIC: false,
			QUOTE: false,
			OLD_ASR: null,
			V3_QUOTE: false,
			V4_QUOTE: false,
			V3_ASR: false,
			V4_ASR: false,
		},
	},
];
function cacheOptions(
	options: ReturnType<typeof fixture>["options"],
	version: CacheVersion,
) {
	const { validationPolicyVersion, ...expected } = options;
	return version === "V4"
		? { ...expected, version, validationPolicyVersion }
		: { ...expected, version };
}
function stageFixture() {
	const { options } = fixture();
	const prompt = localStoryLegacyLedgerPrompt({
		kind: "BASE",
		chunk: options.chunk,
	});
	const recipe = createLocalStoryLegacyLedgerStageRecipe({
		...options,
		organizationId: "00000000-0000-4000-8000-000000000001",
		prompt,
	});
	const requestKey = "44444444-4444-4444-8444-444444444444";
	const body = recipe.bodyFor(requestKey);
	const receipt: LocalSemanticReceipt = {
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
		maxOutputTokens: 1024,
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
				size: 29000000000,
				sizeVram: 14000000000,
				contextLength: 8192,
			},
		],
		cleanupConfirmed: true,
		schemaVerified: false,
	};
	const output = {
		summary: "A person speaks.",
		events: [
			{
				id: "e0",
				label: "A person speaks.",
				role: "ACTION" as const,
				refs: ["s0"],
				quotes: [{ ref: "s0", quote: "A person speaks." }],
				subjects: [],
				uncertainty: "",
			},
		],
	};
	return {
		options,
		recipe,
		body,
		stored: {
			version: "local-semantic-stage-result-v1" as const,
			requestKey,
			receipt,
			output,
		},
	};
}
describe("shared legacy ledger recipes", () => {
	it("keeps exact BASE bytes captured before extraction", () => {
		const { options } = fixture();
		const prompt = localStoryLegacyLedgerPrompt({
			kind: "BASE",
			chunk: options.chunk,
		});
		expect(Buffer.byteLength(prompt)).toBe(BEFORE_BASE.BASE.utf8Bytes);
		expect(createHash("sha256").update(prompt).digest("hex")).toBe(
			BEFORE_BASE.BASE.sha256,
		);
	});
	it("keeps exact GENERIC, NUMERIC and legacy QUOTE bytes", () => {
		const { options } = fixture();
		const base = localStoryLegacyLedgerPrompt({
			kind: "BASE",
			chunk: options.chunk,
		});
		const prompts = {
			GENERIC: base + LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY.suffixes.generic,
			NUMERIC: localStoryLegacyLedgerPrompt({
				kind: "NUMERIC",
				chunk: options.chunk,
			}),
			QUOTE: localStoryLegacyLedgerPrompt({
				kind: "QUOTE",
				chunk: options.chunk,
			}),
		};
		for (const family of ["GENERIC", "NUMERIC", "QUOTE"] as const) {
			const prompt = prompts[family];
			expect(prompt).toBeDefined();
			expect(Buffer.byteLength(item(prompt))).toBe(
				BEFORE_BASE[family].utf8Bytes,
			);
			expect(createHash("sha256").update(item(prompt)).digest("hex")).toBe(
				BEFORE_BASE[family].sha256,
			);
		}
	});
	it.each([
		"V3",
		"V4",
	] as const)("keeps exact %s structured QUOTE and ASR bytes", (version) => {
		const { options } = fixture();
		for (const family of ["QUOTE", "ASR"] as const) {
			const prompt = localStoryLegacyLedgerPrompt({
				kind: "STRUCTURED",
				version,
				family,
				...options,
			});
			const expected =
				BEFORE_BASE[
					`${version}_${family}` as
						| "V3_QUOTE"
						| "V3_ASR"
						| "V4_QUOTE"
						| "V4_ASR"
				];
			expect(prompt).toBeDefined();
			expect(Buffer.byteLength(item(prompt))).toBe(expected.utf8Bytes);
			expect(createHash("sha256").update(item(prompt)).digest("hex")).toBe(
				expected.sha256,
			);
		}
	});
	it("preserves every original field including embedded newline and Unicode", () => {
		const { options } = fixture(),
			shot = item(options.input.shots[0]),
			chunkShot = item(options.chunk.shots[0]);
		item(shot.fields[0]).text = "人物  A\n鍵の所在は不明。";
		shot.text = shot.fields.map((field) => field.text).join("\n");
		chunkShot.text = shot.text;
		const prompt = item(
			localStoryLegacyLedgerPrompt({
				kind: "STRUCTURED",
				version: "V4",
				family: "QUOTE",
				...options,
			}),
		);
		const data = JSON.parse(prompt.slice(prompt.indexOf("\nDATA\n") + 6));
		expect(data.shots[0].fields).toEqual(
			shot.fields.map((field) => field.text),
		);
		expect(data.shots[0].fields[0]).toBe("人物  A\n鍵の所在は不明。");
	});
	it("rejects a flat text that no longer equals its complete original fields", () => {
		const { options } = fixture();
		item(options.chunk.shots[0]).text += " changed";
		expect(() =>
			localStoryLegacyLedgerPrompt({
				kind: "STRUCTURED",
				version: "V4",
				family: "QUOTE",
				...options,
			}),
		).toThrow("LOCAL_STORY_REPAIR_INPUT_INVALID");
	});
	it("retains all fields at the inclusive 6144-byte v3 boundary and returns no oversized v4 prompt", () => {
		const { options } = fixture();
		const original = item(
			localStoryLegacyLedgerPrompt({
				kind: "STRUCTURED",
				version: "V3",
				family: "QUOTE",
				...options,
			}),
		);
		const shot = item(options.input.shots[0]);
		item(shot.fields[0]).text += "x".repeat(6144 - Buffer.byteLength(original));
		shot.text = shot.fields.map((field) => field.text).join("\n");
		item(options.chunk.shots[0]).text = shot.text;
		expect(
			Buffer.byteLength(
				item(
					localStoryLegacyLedgerPrompt({
						kind: "STRUCTURED",
						version: "V3",
						family: "QUOTE",
						...options,
					}),
				),
			),
		).toBe(6144);
		expect(
			localStoryLegacyLedgerPrompt({
				kind: "STRUCTURED",
				version: "V4",
				family: "QUOTE",
				...options,
			}),
		).toBeUndefined();
	});
	for (const row of BEFORE_CACHES)
		it(
			"keeps the captured " +
				row.version +
				(row.oversized ? " oversized" : " complete") +
				" key and pointers",
			() => {
				const { options } = fixture(
					row.version === "V1" || row.version === "V2",
				);
				const oldAsr =
					localStoryLegacyLedgerPrompt({ kind: "BASE", chunk: options.chunk }) +
					LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY.suffixes.asr +
					JSON.stringify(
						item(options.input.shots[0])
							.fields.filter((field) => field.kind === "ASR")
							.map((field) => ({
								ref: "s0",
								pointer: field.pointer,
								text: field.text,
							})),
					);
				if (row.oversized) {
					item(options.chunk.shots[0]).text += "x".repeat(6144);
					if (row.version === "V3" || row.version === "V4") {
						const shot = item(options.input.shots[0]);
						item(shot.fields[0]).text += "x".repeat(6144);
						shot.text = shot.fields.map((field) => field.text).join("\n");
						item(options.chunk.shots[0]).text = shot.text;
					}
				}
				const recipe = createLocalStoryLegacyLedgerCacheRecipe(
					cacheOptions(options, row.version),
				);
				expect(Object.keys(recipe.key)).toHaveLength(9);
				expect(hashEditingEvidence(recipe.key)).toBe(row.keyHash);
				expect(recipe.key.inputHash).toBe(row.inputHash);
				expect(recipe.key.promptPolicyHash).toBe(row.promptPolicyHash);
				expect(hashEditingEvidence(recipe.stageInput)).toBe(row.stageInputHash);
				const base = localStoryLegacyLedgerPrompt({
					kind: "BASE",
					chunk: options.chunk,
				});
				const prompts: Record<string, string | undefined> = {
					BASE: base,
					GENERIC:
						base + LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY.suffixes.generic,
					NUMERIC: localStoryLegacyLedgerPrompt({
						kind: "NUMERIC",
						chunk: options.chunk,
					}),
					QUOTE: localStoryLegacyLedgerPrompt({
						kind: "QUOTE",
						chunk: options.chunk,
					}),
					OLD_ASR: oldAsr,
				};
				if (row.version === "V3" || row.version === "V4")
					for (const version of ["V3", "V4"] as const)
						for (const family of ["QUOTE", "ASR"] as const)
							prompts[`${version}_${family}`] = localStoryLegacyLedgerPrompt({
								kind: "STRUCTURED",
								version,
								family,
								...options,
							});
				for (const [family, expected] of Object.entries(row.families)) {
					const prompt = prompts[family];
					if (expected === false) {
						expect(prompt).toBeUndefined();
						continue;
					}
					expect(prompt).toBeDefined();
					if (expected === null) {
						expect(() => recipe.pointer(item(prompt))).toThrow(
							"LOCAL_STORY_ARTIFACT_UNVERIFIED",
						);
						continue;
					}
					const pointer = recipe.pointer(item(prompt));
					expect(Object.keys(pointer)).toHaveLength(4);
					expect(hashEditingEvidence(pointer)).toBe(expected);
					expect(recipe.parse(structuredClone(pointer))).toEqual(pointer);
				}
			},
		);
	it("reads the complete four-field original stage using its stored request key", () => {
		const f = stageFixture(),
			parsed = f.recipe.parse(structuredClone(f.stored));
		expect(Object.keys(f.recipe.key)).toHaveLength(5);
		expect(Object.keys(f.body)).toHaveLength(9);
		expect(parsed).toEqual(f.stored);
		expect(hashEditingEvidence(parsed)).toBe(hashEditingEvidence(f.stored));
		expect(f.recipe.key.stage).toBe("LOCAL_LEDGER_V1");
		expect(f.recipe.key.schemaHash).toBe(f.options.definition.schemaHash);
		expect(f.recipe.key.schemaHash).not.toBe(f.options.identity.schemaHash);
	});
	it.each([
		"profile",
		"promptHash",
		"inputHash",
		"schemaHash",
		"requestHash",
		"promptVersion",
		"maxOutputTokens",
	] as const)("rejects stage receipt %s crossbinding", (field) => {
		const f = stageFixture();
		Reflect.set(
			f.stored.receipt,
			field,
			field === "profile"
				? "amd"
				: field === "maxOutputTokens"
					? 1536
					: field === "promptVersion"
						? "caption-ja-v1"
						: "f".repeat(64),
		);
		expect(() => f.recipe.parse(f.stored)).toThrow();
	});
	it.each([
		"model",
		"modelDigest",
		"runtimeVersion",
		"cleanupConfirmed",
		"schemaVerified",
		"doneReason",
		"placement",
	] as const)("keeps strict registered stage receipt %s checks", (field) => {
		const f = stageFixture();
		if (field === "doneReason")
			Reflect.set(f.stored.receipt.apiStats, "doneReason", "length");
		else
			Reflect.set(
				f.stored.receipt,
				field,
				field === "cleanupConfirmed"
					? false
					: field === "schemaVerified"
						? true
						: field === "placement"
							? []
							: "altered",
			);
		expect(() => f.recipe.parse(f.stored)).toThrow();
	});
	it.each([
		"version",
		"requestKey",
		"extra",
	] as const)("rejects a changed stage wrapper %s", (field) => {
		const f = stageFixture();
		Reflect.set(f.stored, field, "altered");
		expect(() => f.recipe.parse(f.stored)).toThrow();
	});
	it("revalidates same-field source quotations without joining or rewriting output", () => {
		const f = stageFixture(),
			before = structuredClone(f.stored);
		item(item(f.stored.output.events[0]).quotes[0]).quote =
			"A person speaks. Listen, Celia.";
		expect(() => f.recipe.parse(f.stored)).toThrow();
		expect(item(item(f.stored.output.events[0]).quotes[0]).quote).not.toBe(
			item(item(before.output.events[0]).quotes[0]).quote,
		);
	});
	it.each([
		"version",
		"validationPolicyVersion",
		"prompt",
		"stageKeyHash",
		"extra",
	] as const)("rejects changed accepted pointer %s", (field) => {
		const { options } = fixture();
		const recipe = createLocalStoryLegacyLedgerCacheRecipe(
			cacheOptions(options, "V4"),
		);
		const pointer = recipe.pointer(
			localStoryLegacyLedgerPrompt({ kind: "BASE", chunk: options.chunk }),
		);
		Reflect.set(pointer, field, "altered");
		expect(() => recipe.parse(pointer)).toThrow(
			"LOCAL_STORY_ARTIFACT_UNVERIFIED",
		);
	});
	it.each([
		"text",
		"pointer",
		"ref",
		"duplicate",
		"noncanonical",
		"aisa",
	] as const)("rejects %s changes in old SOURCE_FIELDS", (change) => {
		const { options } = fixture();
		const recipe = createLocalStoryLegacyLedgerCacheRecipe(
			cacheOptions(options, "V4"),
		);
		const fields = item(options.input.shots[0])
			.fields.filter((field) => field.kind === "ASR")
			.map((field) => ({
				ref: "s0",
				pointer: field.pointer,
				text: field.text,
			}));
		if (change === "duplicate") fields.push({ ...item(fields[0]) });
		else if (change === "aisa") {
			item(fields[0]).pointer = "/shots/0/text";
			item(fields[0]).text = "A person speaks.";
		} else if (change !== "noncanonical")
			Reflect.set(item(fields[0]), change, "altered");
		const prompt =
			localStoryLegacyLedgerPrompt({ kind: "BASE", chunk: options.chunk }) +
			LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY.suffixes.asr +
			JSON.stringify(fields, null, change === "noncanonical" ? 2 : undefined);
		expect(() => recipe.pointer(prompt)).toThrow(
			"LOCAL_STORY_ARTIFACT_UNVERIFIED",
		);
	});
	it("keeps old field membership separate from historical ASR attempt eligibility", () => {
		const { options } = fixture();
		const recipe = createLocalStoryLegacyLedgerCacheRecipe(
			cacheOptions(options, "V1"),
		);
		const field = item(
			item(options.input.shots[0]).fields.find((field) => field.kind === "ASR"),
		);
		const prompt =
			localStoryLegacyLedgerPrompt({ kind: "BASE", chunk: options.chunk }) +
			LOCAL_STORY_LEGACY_LEDGER_RECIPE_POLICY.suffixes.asr +
			JSON.stringify([{ ref: "s0", pointer: field.pointer, text: field.text }]);
		expect(recipe.parse(recipe.pointer(prompt)).prompt).toBe(prompt);
	});
	it("keeps private cache expectations independent from original and returned aliases", () => {
		const { options } = fixture();
		const recipe = createLocalStoryLegacyLedgerCacheRecipe(
			cacheOptions(options, "V4"),
		);
		const prompt = localStoryLegacyLedgerPrompt({
				kind: "BASE",
				chunk: options.chunk,
			}),
			pointer = recipe.pointer(prompt);
		options.identity.profile = "amd";
		options.definition.schemaHash = "f".repeat(64);
		item(item(options.input.shots[0]).fields[0]).text = "changed original";
		recipe.key.identity.profile = "amd";
		recipe.stageInput.chunk.refs[0] = "s9";
		expect(recipe.parse(pointer)).toEqual(pointer);
		expect(recipe.pointer(prompt)).toEqual(pointer);
	});
	it("keeps private stage expectations independent from original and returned aliases", () => {
		const f = stageFixture(),
			original = structuredClone(f.stored);
		f.options.identity.profile = "amd";
		f.options.definition.schemaHash = "f".repeat(64);
		item(item(f.options.input.shots[0]).fields[0]).text = "changed original";
		f.recipe.key.identity.profile = "amd";
		expect(f.recipe.parse(f.stored)).toEqual(original);
	});
	it("leaves canonical hash equality to the outer seal reader", () => {
		const f = stageFixture();
		item(f.stored.output.events[0]).label = "  A person speaks.  ";
		const before = hashEditingEvidence(f.stored);
		const parsed = f.recipe.parse(f.stored);
		expect(item(parsed.output.events[0]).label).toBe("A person speaks.");
		expect(hashEditingEvidence(parsed)).not.toBe(before);
		expect(item(f.stored.output.events[0]).label).toBe("  A person speaks.  ");
	});
	it("retains a complete legacy v3 6144-byte pointer when current repair cannot fit", () => {
		const { options } = fixture();
		const first = item(
			localStoryLegacyLedgerPrompt({
				kind: "STRUCTURED",
				version: "V3",
				family: "QUOTE",
				...options,
			}),
		);
		const shot = item(options.input.shots[0]);
		item(shot.fields[0]).text += "x".repeat(6144 - Buffer.byteLength(first));
		shot.text = shot.fields.map((field) => field.text).join("\n");
		item(options.chunk.shots[0]).text = shot.text;
		const old = item(
			localStoryLegacyLedgerPrompt({
				kind: "STRUCTURED",
				version: "V3",
				family: "QUOTE",
				...options,
			}),
		);
		const recipe = createLocalStoryLegacyLedgerCacheRecipe(
			cacheOptions(options, "V4"),
		);
		expect(Buffer.byteLength(old)).toBe(6144);
		expect(recipe.parse(recipe.pointer(old)).prompt).toBe(old);
		expect(
			localStoryLegacyLedgerPrompt({
				kind: "STRUCTURED",
				version: "V4",
				family: "QUOTE",
				...options,
			}),
		).toBeUndefined();
	});
});
