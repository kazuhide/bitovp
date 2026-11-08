import { describe, expect, it } from "vitest";
import type { LocalSemanticConfiguration } from "../content-editing/local-semantic-config";
import {
	localSemanticStageRegistry,
	localStoryIdentityForConfiguration,
	localStoryStageRegistry,
} from "../content-editing/local-semantic-stages";
import { LOCAL_STORY_FLOW_H1_POLICY } from "../content-editing/local-story-flow-contracts";
import { localStoryFlowIdentityForConfiguration } from "../content-editing/local-story-flow-stages";
import { hashEditingEvidence } from "../content-editing/verify-automatic-binding";
import { GENERATION_POLICY_FINGERPRINT } from "./generation-policy";
import { mediaTaskCacheKey, mediaTaskIntentHash } from "./identity";
import {
	LOCAL_STORY_HIERARCHICAL_WORKFLOW_VERSION,
	localStoryFlowGenerationPolicyFingerprint,
	localStoryFlowTaskIdentityForConfiguration,
	localStoryFlowTaskPolicyPartsSchema,
	resolveLocalStoryWorkflow,
} from "./local-story-workflow";
import { mediaTaskCreateSchema, mediaTaskEnvelopeSchema } from "./schema";

const id = "00000000-0000-4000-8000-000000000001";
const config: LocalSemanticConfiguration = {
	url: "https://fixture.invalid/",
	token: "synthetic-test-token-".repeat(3),
	caFile: "/never-read/fixture.pem",
	profile: "nvidia",
	configId: "44444444-4444-4444-8444-444444444444",
};
const legacyInput = mediaTaskCreateSchema.parse({
	kind: "GENERATE",
	mediaVersionId: id,
	analysisRevisionId: id,
	requestKey: id,
	parameters: {
		contentId: id,
		targetDurationFrames: 900,
		policy: "LOCAL_STORY",
		storyMode: "FLOW",
		renderMode: "DRAFT",
	},
});
const capturedLegacyGenerationPolicyFingerprint =
	"3cb7431ddb13a44a90f1ee2dc80eb8f9582696b89c0b2bced9de3357cc25ffc7";
const legacyIdentity = {
	organizationId: id,
	mediaSha256: "a".repeat(64),
	modelSha256: "b".repeat(64),
	analysisDocumentHash: "c".repeat(64),
	analysisRawHash: "d".repeat(64),
	timeMapHash: "e".repeat(64),
	localStoryModel: localStoryIdentityForConfiguration(config),
	generationPolicyFingerprint: capturedLegacyGenerationPolicyFingerprint,
};
const fields = [
	"workflowPolicyHash",
	"contextPolicyHash",
	"closurePolicyHash",
	"routePolicyHash",
	"scopePolicyHash",
	"promptPolicyHash",
	"engineValidationPolicyHash",
	"deliveryPolicyHash",
] as const;
const parts = {
	version: "local-story-flow-task-policies-v1" as const,
	workflowPolicyHash: hashEditingEvidence(LOCAL_STORY_FLOW_H1_POLICY),
	contextPolicyHash: "1".repeat(64),
	closurePolicyHash: "2".repeat(64),
	routePolicyHash: "3".repeat(64),
	scopePolicyHash: "4".repeat(64),
	promptPolicyHash: "5".repeat(64),
	engineValidationPolicyHash: "6".repeat(64),
	deliveryPolicyHash: "7".repeat(64),
};
const explicit = {
	policy: "LOCAL_STORY",
	storyMode: "FLOW",
	renderMode: "DRAFT",
	storyWorkflowVersion: "hierarchical-flow-v1",
};

describe("local story workflow task pin", () => {
	it("preserves the captured legacy parse, intent, cache, policy and leaf-model goldens", () => {
		const envelope = {
			schemaVersion: 1,
			input: legacyInput,
			identity: legacyIdentity,
		};
		expect(mediaTaskEnvelopeSchema.parse(envelope)).toEqual(envelope);
		expect(legacyInput.parameters).not.toHaveProperty("storyWorkflowVersion");
		expect({
			parsedLegacyInputHash: hashEditingEvidence(legacyInput),
			parsedLegacyEnvelopeHash: hashEditingEvidence(envelope),
			legacyIntentHash: mediaTaskIntentHash(legacyInput),
			legacyCacheKey: mediaTaskCacheKey(legacyInput, legacyIdentity),
			generationPolicyFingerprint: capturedLegacyGenerationPolicyFingerprint,
			storyRegistryHash: hashEditingEvidence(localStoryStageRegistry()),
			semanticRegistryHash: hashEditingEvidence(localSemanticStageRegistry()),
			nvidiaModelHash: hashEditingEvidence(legacyIdentity.localStoryModel),
			amdModelHash: hashEditingEvidence(
				localStoryIdentityForConfiguration({ ...config, profile: "amd" }),
			),
		}).toEqual({
			amdModelHash:
				"e7ab33e74e162e6cc45f0db1d1e9f723eafc1a7864b61d6f7157bbd93e3e738e",
			generationPolicyFingerprint:
				"3cb7431ddb13a44a90f1ee2dc80eb8f9582696b89c0b2bced9de3357cc25ffc7",
			legacyCacheKey:
				"5271da5e33e90198ea14aa2b9a24d0f22c652de30281bd4bd8e9c927b155dc65",
			legacyIntentHash:
				"6e27558d425d402e0872f5c9bcc5e02985df35c195fc1e142b4c06992fd066c6",
			nvidiaModelHash:
				"dd2fd082d0cca8c4d8313ceb92163acdcdb077a8eb1dac283ced32d87c8bb3bf",
			parsedLegacyEnvelopeHash:
				"fc74c12d10ace1f624c5849c1cdeac447786a6336cac4a5b05a9a52ebe04bcd4",
			parsedLegacyInputHash:
				"02e48761dca4674d012b0ffe46d6d1e02eba593e8354a77610fef240b3b91d5e",
			semanticRegistryHash:
				"cca2b05de7299f0a87569dd225d8646d2f78aab398a8c5479957a2135de4b50e",
			storyRegistryHash:
				"c6e24f37dddb8dbf8ff046f91d82142f130463f3fa6ddecb66a74eadad5c0189",
		});
	});

	it("separates the current generation namespace while preserving the captured legacy intent and leaf model", () => {
		const currentIdentity = {
			...legacyIdentity,
			generationPolicyFingerprint: GENERATION_POLICY_FINGERPRINT,
		};
		const envelope = {
			schemaVersion: 1,
			input: legacyInput,
			identity: currentIdentity,
		};
		const parsed = mediaTaskEnvelopeSchema.parse(envelope);
		expect(parsed).toEqual(envelope);
		expect(parsed.input).toEqual(legacyInput);
		expect(parsed.identity.localStoryModel).toEqual(
			legacyIdentity.localStoryModel,
		);
		expect({
			generationPolicyFingerprint: parsed.identity.generationPolicyFingerprint,
			intentHash: mediaTaskIntentHash(parsed.input),
			modelHash: hashEditingEvidence(parsed.identity.localStoryModel),
			cacheKey: mediaTaskCacheKey(parsed.input, parsed.identity),
			parsedEnvelopeHash: hashEditingEvidence(parsed),
		}).toEqual({
			generationPolicyFingerprint:
				"fbb75b3fdcee8130af72f9ff5adce832f4f8038d5281e8687cdc47757d4233b2",
			intentHash:
				"6e27558d425d402e0872f5c9bcc5e02985df35c195fc1e142b4c06992fd066c6",
			modelHash:
				"dd2fd082d0cca8c4d8313ceb92163acdcdb077a8eb1dac283ced32d87c8bb3bf",
			cacheKey:
				"e09427fb22532478a69bc8e9f27b8605debf3e35b347c17b4d595c38a727da00",
			parsedEnvelopeHash:
				"68cd089ef1b825c20e1a401f0d4ce0fda3d409a5d5edd7712ed2290a1897b3c9",
		});
		expect(mediaTaskIntentHash(parsed.input)).toBe(
			mediaTaskIntentHash(legacyInput),
		);
		expect(mediaTaskCacheKey(parsed.input, parsed.identity)).not.toBe(
			mediaTaskCacheKey(legacyInput, legacyIdentity),
		);
		expect(hashEditingEvidence(parsed)).not.toBe(
			hashEditingEvidence({ ...envelope, identity: legacyIdentity }),
		);
	});

	it("classifies only an absent marker as legacy and never inserts a workflow", () => {
		const parameters = {
			policy: "LOCAL_STORY",
			storyMode: "FLOW",
			renderMode: "DRAFT",
		};
		expect(resolveLocalStoryWorkflow(parameters)).toBe("LEGACY_FLAT");
		expect(parameters).not.toHaveProperty("storyWorkflowVersion");
		for (const policy of ["AUTO", "STORY", "COHESION", "DURATION"])
			expect(resolveLocalStoryWorkflow({ policy })).toBe("NOT_LOCAL_STORY");
		expect(LOCAL_STORY_HIERARCHICAL_WORKFLOW_VERSION).toBe(
			"hierarchical-flow-v1",
		);
		expect(resolveLocalStoryWorkflow(explicit)).toBe("HIERARCHICAL_FLOW_V1");
	});

	it("rejects malformed explicit markers and incompatible selection instead of falling back", () => {
		for (const storyWorkflowVersion of [
			undefined,
			null,
			"",
			"flat-v1",
			"hierarchical-flow-v2",
		]) {
			expect(() =>
				resolveLocalStoryWorkflow({ ...explicit, storyWorkflowVersion }),
			).toThrow("LOCAL_STORY_WORKFLOW_INVALID");
		}
		for (const change of [
			{ policy: "AUTO" },
			{ policy: "STORY" },
			{ policy: "COHESION" },
			{ policy: "DURATION" },
			{ storyMode: "AUTO" },
			{ storyMode: "THEME" },
			{ storyMode: undefined },
			{ renderMode: "EXPORT" },
			{ renderMode: undefined },
		]) {
			expect(() =>
				resolveLocalStoryWorkflow({ ...explicit, ...change }),
			).toThrow("LOCAL_STORY_WORKFLOW_INVALID");
		}
		for (const value of [null, undefined, [], "LOCAL_STORY"])
			expect(() => resolveLocalStoryWorkflow(value)).toThrow(
				"LOCAL_STORY_WORKFLOW_INVALID",
			);
	});

	it("requires the exact complete versioned eight-part policy record without defaults", () => {
		expect(localStoryFlowTaskPolicyPartsSchema.parse(parts)).toEqual(parts);
		for (const field of fields) {
			const missing = Object.fromEntries(
				Object.entries(parts).filter(([name]) => name !== field),
			);
			for (const invalid of [
				missing,
				{ ...parts, [field]: undefined },
				{ ...parts, [field]: null },
				{ ...parts, [field]: "a".repeat(63) },
				{ ...parts, [field]: "A".repeat(64) },
				{ ...parts, [field]: `${"a".repeat(64)}\n` },
			]) {
				expect(
					localStoryFlowTaskPolicyPartsSchema.safeParse(invalid).success,
				).toBe(false);
				expect(() =>
					localStoryFlowGenerationPolicyFingerprint(invalid),
				).toThrow();
				expect(() =>
					localStoryFlowTaskIdentityForConfiguration(config, invalid),
				).toThrow();
			}
		}
		for (const invalid of [
			{ ...parts, version: "local-story-flow-task-policies-v2" },
			{ ...parts, extra: undefined },
			{ ...parts, extra: "synthetic" },
			null,
		])
			expect(
				localStoryFlowTaskPolicyPartsSchema.safeParse(invalid).success,
			).toBe(false);
	});

	it("binds the independent fingerprint to the old generation policy, explicit version and all exact parts", () => {
		const expected = hashEditingEvidence({
			version: "clip-generation-hierarchical-flow-policy-v1",
			baseGenerationPolicyFingerprint:
				capturedLegacyGenerationPolicyFingerprint,
			storyWorkflowVersion: "hierarchical-flow-v1",
			policies: parts,
		});
		expect(localStoryFlowGenerationPolicyFingerprint(parts)).toBe(expected);
		expect(expected).not.toBe(GENERATION_POLICY_FINGERPRINT);
		expect(
			localStoryFlowGenerationPolicyFingerprint(
				Object.fromEntries(Object.entries(parts).reverse()),
			),
		).toBe(expected);
	});

	it("keeps the FLOW v1 base immutable while ordinary generation adopts the current caption policy", () => {
		expect(GENERATION_POLICY_FINGERPRINT).toBe(
			"fbb75b3fdcee8130af72f9ff5adce832f4f8038d5281e8687cdc47757d4233b2",
		);
		expect(GENERATION_POLICY_FINGERPRINT).not.toBe(
			capturedLegacyGenerationPolicyFingerprint,
		);
		const capturedV1Fingerprint = hashEditingEvidence({
			version: "clip-generation-hierarchical-flow-policy-v1",
			baseGenerationPolicyFingerprint:
				capturedLegacyGenerationPolicyFingerprint,
			storyWorkflowVersion: "hierarchical-flow-v1",
			policies: parts,
		});
		const currentBaseFingerprint = hashEditingEvidence({
			version: "clip-generation-hierarchical-flow-policy-v1",
			baseGenerationPolicyFingerprint: GENERATION_POLICY_FINGERPRINT,
			storyWorkflowVersion: "hierarchical-flow-v1",
			policies: parts,
		});
		expect(localStoryFlowGenerationPolicyFingerprint(parts)).toBe(
			capturedV1Fingerprint,
		);
		expect(localStoryFlowGenerationPolicyFingerprint(parts)).not.toBe(
			currentBaseFingerprint,
		);
		const identity = localStoryFlowTaskIdentityForConfiguration(config, parts);
		expect(identity.generationPolicyFingerprint).toBe(capturedV1Fingerprint);
		expect(identity.localStoryWorkflow.baseModel).toEqual(
			legacyIdentity.localStoryModel,
		);
	});

	it.each(
		fields,
	)("changes replay identity when %s changes without changing leaf identity", (field) => {
		const changed = { ...parts, [field]: "f".repeat(64) };
		const original = localStoryFlowTaskIdentityForConfiguration(config, parts);
		const next = localStoryFlowTaskIdentityForConfiguration(config, changed);
		expect(next.generationPolicyFingerprint).not.toBe(
			original.generationPolicyFingerprint,
		);
		expect(next.localStoryWorkflow).toEqual(original.localStoryWorkflow);
		expect(next.localStoryWorkflow.baseModel).toEqual(
			legacyIdentity.localStoryModel,
		);
	});

	it.each([
		"amd",
		"nvidia",
	] as const)("returns only the FLOW identity fragment on %s and cuts caller aliases", (profile) => {
		const selected = { ...config, profile };
		const mutableParts = { ...parts };
		const pin = localStoryFlowTaskIdentityForConfiguration(
			selected,
			mutableParts,
		);
		expect(pin).toEqual({
			localStoryWorkflow: localStoryFlowIdentityForConfiguration(
				selected,
				"FLOW",
			),
			generationPolicyFingerprint:
				localStoryFlowGenerationPolicyFingerprint(parts),
		});
		expect(Object.keys(pin).sort()).toEqual([
			"generationPolicyFingerprint",
			"localStoryWorkflow",
		]);
		expect(pin.localStoryWorkflow.baseModel).toEqual(
			localStoryIdentityForConfiguration(selected),
		);
		const saved = structuredClone(pin);
		mutableParts.deliveryPolicyHash = "f".repeat(64);
		pin.localStoryWorkflow.baseModel.profile =
			profile === "amd" ? "nvidia" : "amd";
		expect(localStoryFlowTaskIdentityForConfiguration(selected, parts)).toEqual(
			saved,
		);
		for (const privateValue of [config.token, config.url, config.caFile])
			expect(JSON.stringify(saved)).not.toContain(privateValue);
	});
});
