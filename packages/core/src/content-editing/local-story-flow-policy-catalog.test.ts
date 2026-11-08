import { describe, expect, it } from "vitest";
import { localStoryIdentityForModelPin } from "./local-semantic-stages";
import {
	getCompiledLocalStoryFlowPolicyCatalog,
	LocalStoryFlowPolicyCatalogError,
	resolveLocalStoryFlowPolicyCatalogForTaskIdentity,
} from "./local-story-flow-policy-catalog";
import { localStoryFlowIdentityForModelPin } from "./local-story-flow-stages";

const uuid = "00000000-0000-4000-8000-000000000001",
	hash = "a".repeat(64);
function identity() {
	const pin = { profile: "nvidia", configId: uuid };
	return {
		organizationId: uuid,
		mediaSha256: hash,
		modelSha256: null,
		analysisDocumentHash: hash,
		analysisRawHash: hash,
		timeMapHash: hash,
		localStoryModel: localStoryIdentityForModelPin(pin),
		localStoryWorkflow: localStoryFlowIdentityForModelPin(pin, "FLOW"),
		generationPolicyFingerprint: hash,
	};
}
function unverified(value: unknown) {
	let error: unknown;
	try {
		resolveLocalStoryFlowPolicyCatalogForTaskIdentity(value);
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(LocalStoryFlowPolicyCatalogError);
	expect(error).toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		message: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(error).not.toHaveProperty("cause");
	expect(String(error)).not.toContain("PRIVATE");
}
describe("actual complete FLOW policy versions", () => {
	it("reports the two missing actual parts without returning policies, fingerprints or readiness", () => {
		expect(getCompiledLocalStoryFlowPolicyCatalog()).toEqual({
			status: "UNAVAILABLE",
			missing: ["engineValidationPolicyHash", "deliveryPolicyHash"],
		});
	});
	it("never recognizes an arbitrary original fingerprint through unavailable latest parts", () => {
		for (const fingerprint of [hash, "b".repeat(64), "0".repeat(64)])
			unverified({ ...identity(), generationPolicyFingerprint: fingerprint });
		expect(getCompiledLocalStoryFlowPolicyCatalog().status).toBe("UNAVAILABLE");
	});
	it("does not accept policy injection, a borrowed START or a public provider callback", () => {
		let calls = 0;
		const supplied = {
			status: "SUPPORTED",
			policies: { engineValidationPolicyHash: hash, deliveryPolicyHash: hash },
			generationPolicyFingerprint: hash,
			callback() {
				calls++;
			},
		};
		expect(
			Reflect.apply(getCompiledLocalStoryFlowPolicyCatalog, null, [supplied])
				.status,
		).toBe("UNAVAILABLE");
		unverified({ ...identity(), policies: supplied.policies, start: supplied });
		expect(calls).toBe(0);
	});
	it("keeps returned availability immutable and independent across calls", () => {
		const first = getCompiledLocalStoryFlowPolicyCatalog();
		if (first.status !== "UNAVAILABLE")
			throw new Error("Expected actual incomplete catalog");
		Reflect.set(first.missing, "0", "workflowPolicyHash");
		Reflect.set(first, "status", "SUPPORTED");
		expect(getCompiledLocalStoryFlowPolicyCatalog()).toEqual({
			status: "UNAVAILABLE",
			missing: ["engineValidationPolicyHash", "deliveryPolicyHash"],
		});
	});
	it.each([
		"missingModel",
		"missingWorkflow",
		"missingFingerprint",
		"badFingerprint",
		"modelMismatch",
		"unknownRegistry",
		"unknownPin",
		"extra",
		"undefined",
		"symbol",
		"hidden",
		"prototype",
		"cycle",
		"ownProto",
	] as const)("rejects %s identity with a fixed code", (change) => {
		const value = identity();
		if (change === "missingModel")
			Reflect.deleteProperty(value, "localStoryModel");
		if (change === "missingWorkflow")
			Reflect.deleteProperty(value, "localStoryWorkflow");
		if (change === "missingFingerprint")
			Reflect.deleteProperty(value, "generationPolicyFingerprint");
		if (change === "badFingerprint")
			value.generationPolicyFingerprint = "PRIVATE_HASH";
		if (change === "modelMismatch")
			value.localStoryModel.configId = "00000000-0000-4000-8000-000000000002";
		if (change === "unknownRegistry")
			value.localStoryWorkflow.flowRegistryHash = "f".repeat(64);
		if (change === "unknownPin")
			Reflect.set(value.localStoryWorkflow.baseModel, "profile", "unknown");
		if (change === "extra") Reflect.set(value, "extra", true);
		if (change === "undefined")
			Reflect.set(value, "generationPolicyFingerprint", undefined);
		if (change === "symbol") Reflect.set(value, Symbol("PRIVATE"), true);
		if (change === "hidden")
			Object.defineProperty(value, "extra", { value: true });
		if (change === "prototype") Object.setPrototypeOf(value, { extra: true });
		if (change === "cycle") Reflect.set(value, "self", value);
		if (change === "ownProto")
			Object.defineProperty(value.localStoryWorkflow.baseModel, "__proto__", {
				value: { x: 1 },
				enumerable: true,
			});
		unverified(value);
	});
	it("validates descriptors without executing nested getters or propagating proxy errors", () => {
		const value = identity();
		let reads = 0;
		Object.defineProperty(value.localStoryWorkflow.baseModel, "configId", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("PRIVATE_IDENTITY_GETTER");
			},
		});
		unverified(value);
		expect(reads).toBe(0);
		unverified(
			new Proxy(identity(), {
				getPrototypeOf() {
					throw new Error("PRIVATE_PROXY");
				},
			}),
		);
		unverified(null);
	});
});
