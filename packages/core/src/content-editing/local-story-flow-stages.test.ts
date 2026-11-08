import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LocalSemanticConfiguration } from "./local-semantic-config";
import { localSemanticStageSchema } from "./local-semantic-protocol";
import {
	localSemanticStageRegistry,
	localStoryIdentityForConfiguration,
	localStoryIdentityForModelPin,
	localStoryStageRegistry,
} from "./local-semantic-stages";
import { localStoryModeSchema } from "./local-story-contracts";
import {
	LOCAL_STORY_FLOW_CONTEXT_PROMPT_VERSION,
	LOCAL_STORY_FLOW_H1_POLICY,
	LOCAL_STORY_FLOW_ROUTE_PROMPT_VERSION,
	localStoryFlowContextOutputSchema,
	localStoryFlowRouteOutputSchema,
} from "./local-story-flow-contracts";
import {
	localSemanticCombinedStageRegistry,
	localStoryFlowIdentityForConfiguration,
	localStoryFlowIdentityForModelPin,
	localStoryFlowStageRegistry,
	validateLocalStoryFlowWorkflowIdentity,
	validateLocalStoryFlowWorkflowIdentityForModelPin,
} from "./local-story-flow-stages";
import { hashEditingEvidence } from "./verify-automatic-binding";

const config: LocalSemanticConfiguration = {
	url: "https://fixture.invalid/",
	token: "synthetic-fixture-token-".repeat(3),
	caFile: "/never-read/fixture.pem",
	profile: "nvidia",
	configId: "33333333-3333-4333-8333-333333333333",
};
const golden = {
	story: "c6e24f37dddb8dbf8ff046f91d82142f130463f3fa6ddecb66a74eadad5c0189",
	semantic: "cca2b05de7299f0a87569dd225d8646d2f78aab398a8c5479957a2135de4b50e",
	nvidia: "651e61b705049e70a07adda5bff85a9e9d71bc02e5f1858e8f9aedbfebf953d0",
	amd: "bece8496cda72749433ebe022004a3ea8cc59746070294eb629d5b83fc305257",
};
function checkStrictObjects(value: unknown) {
	if (!value || typeof value !== "object") return;
	if ("type" in value && value.type === "object")
		expect("additionalProperties" in value && value.additionalProperties).toBe(
			false,
		);
	for (const child of Object.values(value)) checkStrictObjects(child);
}

describe("separate flow stages and workflow identity", () => {
	it.each([
		"amd",
		"nvidia",
	] as const)("reconstructs unchanged identities from only a %s model pin", (profile) => {
		const selected = { ...config, profile };
		const pin = { profile, configId: config.configId };
		expect(localStoryIdentityForModelPin(pin)).toEqual(
			localStoryIdentityForConfiguration(selected),
		);
		expect(localStoryFlowIdentityForModelPin(pin, "FLOW")).toEqual(
			localStoryFlowIdentityForConfiguration(selected, "FLOW"),
		);
		const protectedConfig = { ...selected };
		for (const field of ["url", "token", "caFile"])
			Object.defineProperty(protectedConfig, field, {
				enumerable: true,
				get: () => {
					throw new Error("PRIVATE_CONFIGURATION_MUST_NOT_BE_READ");
				},
			});
		expect(
			localStoryFlowIdentityForConfiguration(protectedConfig, "FLOW"),
		).toEqual(localStoryFlowIdentityForModelPin(pin, "FLOW"));
	});
	it("rejects invalid model pins and accessors before reading their values", () => {
		const pin = { profile: "nvidia", configId: config.configId };
		let reads = 0;
		const getter = Object.defineProperty({ ...pin }, "profile", {
			enumerable: true,
			get: () => {
				reads++;
				throw new Error("PRIVATE_PIN");
			},
		});
		for (const invalid of [
			null,
			[],
			{ ...pin, profile: "other" },
			{ profile: "nvidia" },
			{ ...pin, configId: "not-a-uuid" },
			{ ...pin, url: "https://fixture.invalid" },
			{ ...pin, extra: undefined },
			Object.create(pin),
			getter,
			Object.defineProperty({ ...pin }, "profile", {
				value: "nvidia",
				enumerable: false,
			}),
			{ ...pin, [Symbol("extra")]: true },
		]) {
			expect(() => localStoryIdentityForModelPin(invalid)).toThrow(
				"LOCAL_STORY_MODEL_PIN_INVALID",
			);
			expect(() => localStoryFlowIdentityForModelPin(invalid, "FLOW")).toThrow(
				"LOCAL_STORY_MODEL_PIN_INVALID",
			);
		}
		expect(reads).toBe(0);
		const first = localStoryIdentityForModelPin(pin);
		first.profile = "amd";
		expect(localStoryIdentityForModelPin(pin).profile).toBe("nvidia");
	});
	it("keeps the before-golden legacy two/four registries and both model identities", () => {
		expect(hashEditingEvidence(localStoryStageRegistry())).toBe(golden.story);
		expect(hashEditingEvidence(localSemanticStageRegistry())).toBe(
			golden.semantic,
		);
		expect(
			hashEditingEvidence(localStoryIdentityForConfiguration(config)),
		).toBe(golden.nvidia);
		expect(
			hashEditingEvidence(
				localStoryIdentityForConfiguration({ ...config, profile: "amd" }),
			),
		).toBe(golden.amd);
		expect(localStoryModeSchema.parse("AUTO")).toBe("AUTO");
		expect(localStoryModeSchema.parse("THEME")).toBe("THEME");
		expect(localSemanticStageSchema.options).toHaveLength(7);
		expect(
			localSemanticStageSchema.safeParse("LOCAL_FLOW_ROUTE_V1").success,
		).toBe(true);
	});
	it("publishes only two new strict schemas with their own prompt versions and 1536-token caps", () => {
		const registry = localStoryFlowStageRegistry();
		expect(registry.version).toBe("local-story-flow-stages-v1");
		expect(Object.keys(registry.stages)).toEqual([
			"LOCAL_FLOW_CONTEXT_V1",
			"LOCAL_FLOW_ROUTE_V1",
		]);
		const context = registry.stages.LOCAL_FLOW_CONTEXT_V1,
			route = registry.stages.LOCAL_FLOW_ROUTE_V1;
		expect(context.promptVersion).toBe(LOCAL_STORY_FLOW_CONTEXT_PROMPT_VERSION);
		expect(route.promptVersion).toBe(LOCAL_STORY_FLOW_ROUTE_PROMPT_VERSION);
		expect(context.schema).toEqual(
			z.toJSONSchema(localStoryFlowContextOutputSchema),
		);
		expect(route.schema).toEqual(
			z.toJSONSchema(localStoryFlowRouteOutputSchema),
		);
		for (const definition of Object.values(registry.stages)) {
			expect(definition.maxOutputTokens).toBe(1536);
			expect(definition.schemaHash).toBe(
				hashEditingEvidence(definition.schema),
			);
			expect(definition.promptVersion).not.toBe("local-story-v1");
			checkStrictObjects(definition.schema);
		}
	});
	it("combines metadata without changing the legacy values or sharing mutable factory results", () => {
		const combined = localSemanticCombinedStageRegistry(),
			legacy = localSemanticStageRegistry(),
			flow = localStoryFlowStageRegistry();
		expect(combined.version).toBe("bitovp-semantic-stages-combined-v1");
		expect(Object.keys(combined.stages)).toHaveLength(6);
		expect(combined.legacyRegistryHash).toBe(golden.semantic);
		expect(combined.flowRegistryHash).toBe(hashEditingEvidence(flow));
		for (const name of Object.keys(legacy.stages))
			expect(Reflect.get(combined.stages, name)).toEqual(
				Reflect.get(legacy.stages, name),
			);
		Reflect.set(combined.stages.LOCAL_FLOW_CONTEXT_V1.schema, "extra", true);
		Reflect.set(combined.stages.LOCAL_LEDGER_V1.schema, "extra", true);
		expect(hashEditingEvidence(localSemanticStageRegistry())).toBe(
			golden.semantic,
		);
		expect(
			localSemanticCombinedStageRegistry().stages.LOCAL_FLOW_CONTEXT_V1,
		).toEqual(flow.stages.LOCAL_FLOW_CONTEXT_V1);
	});
	it("binds the separate identity to the unchanged base, each registry and fixed policy", () => {
		const identity = localStoryFlowIdentityForConfiguration(config, "FLOW");
		expect(identity.baseModel).toEqual(
			localStoryIdentityForConfiguration(config),
		);
		expect(identity.legacyStoryRegistryHash).toBe(golden.story);
		expect(identity.legacySemanticRegistryHash).toBe(golden.semantic);
		expect(identity.flowRegistryHash).toBe(
			hashEditingEvidence(localStoryFlowStageRegistry()),
		);
		expect(identity.policyHash).toBe(
			hashEditingEvidence(LOCAL_STORY_FLOW_H1_POLICY),
		);
		expect(
			validateLocalStoryFlowWorkflowIdentity(identity, config, "FLOW"),
		).toEqual(identity);
		expect(identity).not.toHaveProperty("rootCommitmentProofHash");
		expect(identity).not.toHaveProperty("workflowHash");
		Reflect.set(identity.baseModel, "profile", "amd");
		expect(
			hashEditingEvidence(localStoryIdentityForConfiguration(config)),
		).toBe(golden.nvidia);
	});
	it.each([
		"AUTO",
		"THEME",
		undefined,
		null,
	])("never coerces unsupported workflow mode %s", (mode) => {
		expect(() =>
			Reflect.apply(localStoryFlowIdentityForConfiguration, null, [
				config,
				mode,
			]),
		).toThrow();
	});
	it("rejects altered policy/registry/model/profile/config identities and extra fields", () => {
		const identity = localStoryFlowIdentityForConfiguration(config, "FLOW");
		for (const field of [
			"policyHash",
			"flowRegistryHash",
			"legacyStoryRegistryHash",
			"legacySemanticRegistryHash",
		])
			expect(() =>
				validateLocalStoryFlowWorkflowIdentity(
					{ ...identity, [field]: "a".repeat(64) },
					config,
					"FLOW",
				),
			).toThrow();
		for (const baseModel of [
			{ ...identity.baseModel, profile: "amd" },
			{ ...identity.baseModel, modelDigest: "a".repeat(64) },
			{
				...identity.baseModel,
				configId: "44444444-4444-4444-8444-444444444444",
			},
		])
			expect(() =>
				validateLocalStoryFlowWorkflowIdentity(
					{ ...identity, baseModel },
					config,
					"FLOW",
				),
			).toThrow();
		expect(() =>
			validateLocalStoryFlowWorkflowIdentity(
				{ ...identity, extra: true },
				config,
				"FLOW",
			),
		).toThrow();
	});
});

describe("descriptor-safe model-pin workflow reader", () => {
	const fixture = () => {
		const pin = { profile: "nvidia" as const, configId: config.configId };
		return { pin, value: localStoryFlowIdentityForModelPin(pin, "FLOW") };
	};
	function rejected(value: unknown, pin: unknown) {
		let caught: unknown;
		try {
			validateLocalStoryFlowWorkflowIdentityForModelPin(value, pin, "FLOW");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught).toMatchObject({
			name: "Error",
			message: "LOCAL_STORY_FLOW_IDENTITY_INVALID",
		});
		expect(caught).not.toHaveProperty("cause");
		expect(caught).not.toHaveProperty("diagnostic");
		expect(String(caught)).not.toContain("PRIVATE");
	}
	it.each([
		"baseModel",
		"profile",
		"policyHash",
	] as const)("rejects workflow %s accessors before reading any getter", (field) => {
		const { value, pin } = fixture();
		let reads = 0;
		Object.defineProperty(
			field === "profile" ? value.baseModel : value,
			field,
			{
				enumerable: true,
				get() {
					reads++;
					throw new Error("PRIVATE_WORKFLOW_GETTER");
				},
			},
		);
		rejected(value, pin);
		expect(reads).toBe(0);
	});
	it.each([
		"profile",
		"configId",
	] as const)("rejects pin %s accessors before reading any getter", (field) => {
		const { value, pin } = fixture();
		let reads = 0;
		Object.defineProperty(pin, field, {
			enumerable: true,
			get() {
				reads++;
				throw new Error("PRIVATE_PIN_GETTER");
			},
		});
		rejected(value, pin);
		expect(reads).toBe(0);
	});
	it.each([
		["value", "getPrototypeOf"],
		["value", "ownKeys"],
		["value", "getOwnPropertyDescriptor"],
		["pin", "getPrototypeOf"],
		["pin", "ownKeys"],
		["pin", "getOwnPropertyDescriptor"],
	] as const)("fixes arbitrary %s proxy %s exceptions to the identity code", (target, trap) => {
		const f = fixture();
		const proxy = new Proxy(f[target], {
			[trap]() {
				throw Object.assign(new Error("PRIVATE_PROXY_EXCEPTION"), {
					diagnostic: "PRIVATE_METADATA",
					cause: new Error("PRIVATE_CAUSE"),
				});
			},
		});
		rejected(
			target === "value" ? proxy : f.value,
			target === "pin" ? proxy : f.pin,
		);
	});
	it("rejects hidden, symbolic, inherited and non-JSON values in either input", () => {
		const f = fixture(),
			cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const sparse = [1, 2];
		delete sparse[0];
		let deep: unknown = null;
		for (let i = 0; i < 130; i++) deep = { deep };
		for (const invalid of [
			null,
			[],
			new Date(0),
			Object.create({ inherited: true }),
			Object.defineProperty({ ...f.value }, "hidden", { value: true }),
			{ ...f.value, [Symbol("PRIVATE_SYMBOL")]: true },
			{ ...f.value, baseModel: Object.create(f.value.baseModel) },
			{ ...f.value, baseModel: { ...f.value.baseModel, extra: undefined } },
			{ ...f.value, baseModel: { ...f.value.baseModel, extra: Infinity } },
			{ ...f.value, baseModel: { ...f.value.baseModel, extra: NaN } },
			{ ...f.value, extra: cyclic },
			{ ...f.value, extra: sparse },
			{ ...f.value, extra: () => "PRIVATE_FUNCTION" },
			{ ...f.value, extra: "あ".repeat(100_000) },
			{ ...f.value, extra: deep },
			{ ...f.value, extra: Array.from({ length: 1000 }, () => null) },
		])
			rejected(invalid, f.pin);
		for (const invalid of [
			null,
			[],
			Object.create(f.pin),
			Object.defineProperty({ ...f.pin }, "profile", {
				value: "nvidia",
				enumerable: false,
			}),
			{ ...f.pin, [Symbol("PRIVATE_SYMBOL")]: true },
			{ ...f.pin, extra: undefined },
			{ ...f.pin, extra: Infinity },
			{ ...f.pin, extra: cyclic },
			{ ...f.pin, extra: deep },
			{ ...f.pin, configId: "あ".repeat(100_000) },
		])
			rejected(f.value, invalid);
	});
	it.each([
		"nvidia",
		"amd",
	] as const)("keeps the supported %s identity and detached copies unchanged", (profile) => {
		const pin = { profile, configId: config.configId };
		const value = localStoryFlowIdentityForConfiguration(
			{ ...config, profile },
			"FLOW",
		);
		const expected = structuredClone(value);
		const parsed = validateLocalStoryFlowWorkflowIdentityForModelPin(
			value,
			pin,
			"FLOW",
		);
		expect(parsed).toEqual(expected);
		expect(parsed).not.toBe(value);
		expect(parsed.baseModel).not.toBe(value.baseModel);
		value.baseModel.configId = "44444444-4444-4444-8444-444444444444";
		pin.configId = value.baseModel.configId;
		expect(parsed).toEqual(expected);
		expect(hashEditingEvidence(parsed.baseModel)).toBe(golden[profile]);
	});
});
