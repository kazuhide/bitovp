import { describe, expect, it } from "vitest";
import {
	LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
	PLAMO_CAPTION_TEMPLATE_HASH,
} from "./local-caption-translation";
import { localPlamoCaptionIdentityForManifest } from "./local-plamo-caption-manifest";
import {
	localPlamoCaptionJobRequestSchema,
	localPlamoCaptionReadinessSchema,
	localPlamoCaptionReceiptSchema,
} from "./local-plamo-caption-protocol";

const identity = localPlamoCaptionIdentityForManifest(
	{
		version: "bitovp-plamo-installed-manifest-v1",
		configId: "11111111-1111-4111-8111-111111111111",
		modelId: "pfnet/plamo-3-translate-31b",
		sourceRevision: "01eac57bf80ef8114decd998f8f3a803ba795557",
		weightSha256: "a".repeat(64),
		weightBytes: 1234,
		quantization: "Q8_0",
		promptTemplateHash: PLAMO_CAPTION_TEMPLATE_HASH,
		contextPolicyFingerprint: LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
		runtimes: {
			nvidia: { sourceRevision: "a".repeat(40), binarySha256: "b".repeat(64) },
		},
	},
	"nvidia",
);
describe("PLaMo dedicated protocol", () => {
	it("rejects ready without the exact selected identity and rejects raw diagnostic fields", () => {
		const ready = {
			version: "bitovp-plamo-readiness-v1",
			profile: "nvidia",
			scope: "METADATA_ONLY",
			ready: true,
			code: "READY",
			manifestHash: identity.manifestHash,
			identity,
		};
		expect(localPlamoCaptionReadinessSchema.safeParse(ready).success).toBe(
			true,
		);
		for (const changes of [
			{ identity: null },
			{ manifestHash: "f".repeat(64) },
			{ profile: "amd" },
			{ ready: false },
			{ runtimePath: "/private/model" },
		])
			expect(
				localPlamoCaptionReadinessSchema.safeParse({ ...ready, ...changes })
					.success,
			).toBe(false);
	});
	it("admits only fixed plain-caption jobs and enforces the UTF8 prompt budget", () => {
		const body = {
			version: "bitovp-plamo-caption-job-v1",
			requestKey: "11111111-1111-4111-8111-111111111111",
			organizationId: "22222222-2222-4222-8222-222222222222",
			profile: "nvidia",
			stage: "LOCAL_PLAMO_CAPTION_JA_V1",
			prompt: "a".repeat(5632),
			inputHash: "a".repeat(64),
			promptVersion: "plamo-pfml3-caption-v1",
			schemaHash: identity.schemaHash,
			manifestHash: identity.manifestHash,
		};
		expect(localPlamoCaptionJobRequestSchema.safeParse(body).success).toBe(
			true,
		);
		for (const changes of [
			{ prompt: "a".repeat(5633) },
			{ prompt: "日".repeat(1878) },
			{ model: "arbitrary" },
			{ stage: "LOCAL_LEDGER_V1" },
		])
			expect(
				localPlamoCaptionJobRequestSchema.safeParse({ ...body, ...changes })
					.success,
			).toBe(false);
	});
});

function receipt(model = identity, backend = "CUDA") {
	return {
		version: "bitovp-plamo-caption-receipt-v1",
		identity: model,
		profile: model.profile,
		manifestHash: model.manifestHash,
		inputHash: "c".repeat(64),
		promptHash: "d".repeat(64),
		schemaHash: model.schemaHash,
		promptVersion: model.promptVersion,
		context: 8192,
		maxOutputTokens: 1536,
		thinking: false,
		requestHash: "e".repeat(64),
		elapsedMs: 10,
		startupReadyMs: 1,
		apiStats: {
			promptEvalCount: 10,
			evalCount: 2,
			promptEvalMs: 1,
			evalMs: 1,
			doneReason: "stop",
		},
		placement: {
			backend,
			observedOwnedGpuMemoryBytes: 1024,
			source:
				model.profile === "nvidia" ? "NVIDIA_PROCESS_QUERY" : "DRM_FDINFO",
			gpuLayersRequested: 1,
		},
		cleanupConfirmed: true,
		runtimeProcessStopped: true,
		schemaVerified: false,
	};
}

describe("PLaMo backend-bound receipts", () => {
	it("preserves legacy CUDA and ROCM receipts without adding an identity field", () => {
		expect(
			localPlamoCaptionReceiptSchema.parse(receipt()).identity,
		).not.toHaveProperty("runtimeBackend");
		expect(
			localPlamoCaptionReceiptSchema.safeParse(
				receipt({ ...identity, profile: "amd" }, "ROCM"),
			).success,
		).toBe(true);
	});
	it("accepts AMD Vulkan only when the identity declares that exact backend", () => {
		const model = {
			...identity,
			profile: "amd" as const,
			runtimeBackend: "VULKAN" as const,
		};
		const good = receipt(model, "VULKAN");
		expect(localPlamoCaptionReceiptSchema.safeParse(good).success).toBe(true);
		for (const bad of [
			receipt(model, "ROCM"),
			receipt({ ...identity, profile: "amd" }, "VULKAN"),
			receipt({ ...model, profile: "nvidia" }, "VULKAN"),
			receipt(model, "UNKNOWN"),
			{
				...good,
				placement: { ...good.placement, source: "NVIDIA_PROCESS_QUERY" },
			},
		])
			expect(localPlamoCaptionReceiptSchema.safeParse(bad).success).toBe(false);
	});
});
