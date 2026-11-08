import { z } from "zod";
import {
	localCaptionModelIdentityV3Schema,
	PLAMO_CAPTION_TEMPLATE,
} from "./local-caption-translation";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ms = z.number().finite().nonnegative();
export const localPlamoCaptionReadinessSchema = z
	.strictObject({
		version: z.literal("bitovp-plamo-readiness-v1"),
		profile: z.enum(["amd", "nvidia"]),
		scope: z.literal("METADATA_ONLY"),
		ready: z.boolean(),
		code: z.enum([
			"READY",
			"GATEWAY_STOPPING",
			"RUNTIME_QUARANTINED",
			"MODEL_NOT_INSTALLED",
			"MODEL_MISMATCH",
			"RUNTIME_UNAVAILABLE",
		]),
		manifestHash: hash.nullable(),
		identity: localCaptionModelIdentityV3Schema.nullable(),
	})
	.superRefine((value, context) => {
		if (
			value.ready !== (value.code === "READY") ||
			(value.ready &&
				(!value.identity ||
					value.identity.profile !== value.profile ||
					value.identity.manifestHash !== value.manifestHash)) ||
			(!value.ready && (value.identity !== null || value.manifestHash !== null))
		)
			context.addIssue({
				code: "custom",
				message: "Readiness identity mismatch",
			});
	});
export const localPlamoCaptionJobRequestSchema = z.strictObject({
	version: z.literal("bitovp-plamo-caption-job-v1"),
	requestKey: z.uuid(),
	organizationId: z.uuid(),
	profile: z.enum(["amd", "nvidia"]),
	stage: z.literal("LOCAL_PLAMO_CAPTION_JA_V1"),
	prompt: z
		.string()
		.min(1)
		.refine((value) => new TextEncoder().encode(value).length <= 5632),
	inputHash: hash,
	promptVersion: z.literal(PLAMO_CAPTION_TEMPLATE.version),
	schemaHash: hash,
	manifestHash: hash,
});
export type LocalPlamoCaptionJobRequest = z.infer<
	typeof localPlamoCaptionJobRequestSchema
>;
export const localPlamoCaptionReceiptSchema = z
	.strictObject({
		version: z.literal("bitovp-plamo-caption-receipt-v1"),
		identity: localCaptionModelIdentityV3Schema,
		profile: z.enum(["amd", "nvidia"]),
		manifestHash: hash,
		inputHash: hash,
		promptHash: hash,
		schemaHash: hash,
		promptVersion: z.literal(PLAMO_CAPTION_TEMPLATE.version),
		context: z.literal(8192),
		maxOutputTokens: z.literal(1536),
		thinking: z.literal(false),
		requestHash: hash,
		elapsedMs: ms,
		startupReadyMs: ms,
		apiStats: z.strictObject({
			promptEvalCount: count.max(6656),
			evalCount: count.max(1536),
			promptEvalMs: ms,
			evalMs: ms,
			doneReason: z.literal("stop"),
		}),
		placement: z.strictObject({
			backend: z.enum(["CUDA", "ROCM", "VULKAN"]),
			observedOwnedGpuMemoryBytes: count.positive(),
			source: z.enum(["NVIDIA_PROCESS_QUERY", "DRM_FDINFO"]),
			gpuLayersRequested: z.number().int().min(1).max(999),
		}),
		cleanupConfirmed: z.literal(true),
		runtimeProcessStopped: z.literal(true),
		schemaVerified: z.literal(false),
	})
	.superRefine((value, context) => {
		if (
			value.identity.profile !== value.profile ||
			value.identity.manifestHash !== value.manifestHash ||
			value.identity.schemaHash !== value.schemaHash ||
			value.placement.backend !==
				(value.identity.runtimeBackend ??
					(value.profile === "amd" ? "ROCM" : "CUDA")) ||
			value.placement.source !==
				(value.profile === "amd" ? "DRM_FDINFO" : "NVIDIA_PROCESS_QUERY")
		)
			context.addIssue({
				code: "custom",
				message: "Receipt identity mismatch",
			});
	});
export type LocalPlamoCaptionReceipt = z.infer<
	typeof localPlamoCaptionReceiptSchema
>;
export const localPlamoCaptionJobSchema = z.strictObject({
	id: z.uuid(),
	state: z.enum([
		"QUEUED",
		"LOADING",
		"RUNNING",
		"VALIDATING",
		"CANCELLING",
		"SUCCEEDED",
		"FAILED",
		"CANCELLED",
	]),
	stage: z.literal("LOCAL_PLAMO_CAPTION_JA_V1"),
	requestHash: hash,
	cleanupConfirmed: z.boolean(),
	result: z
		.strictObject({
			content: z.string().min(1).max(16384),
			receipt: localPlamoCaptionReceiptSchema,
		})
		.optional(),
	errorCode: z
		.string()
		.regex(/^[A-Z][A-Z0-9_]{0,95}$/)
		.optional(),
});
