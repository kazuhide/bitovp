import { z } from "zod";
import {
	LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
	localCaptionModelIdentityV3Schema,
	localPlamoCaptionOutputSchema,
	PLAMO_CAPTION_TEMPLATE,
	PLAMO_CAPTION_TEMPLATE_HASH,
	PLAMO_CAPTION_VALIDATION_POLICY_FINGERPRINT,
} from "./local-caption-translation";
import { hashEditingEvidence } from "./verify-automatic-binding";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const runtime = z.strictObject({
	sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
	binarySha256: hash,
	buildRecipeHash: hash.optional(),
	backend: z.enum(["CUDA", "ROCM", "VULKAN"]).optional(),
});
/** Public projection: no runtime path, argv, URL, token or license assumption. */
export const publicPlamoCaptionManifestSchema = z
	.strictObject({
		version: z.literal("bitovp-plamo-installed-manifest-v1"),
		configId: z.uuid(),
		modelId: z.literal("pfnet/plamo-3-translate-31b"),
		sourceRevision: z.literal("01eac57bf80ef8114decd998f8f3a803ba795557"),
		weightSha256: hash,
		weightBytes: z
			.number()
			.int()
			.positive()
			.max(128 * 1024 ** 3),
		quantization: z.enum(["BF16", "F16", "Q8_0", "Q4_K_M"]),
		conversionRecipeHash: hash.optional(),
		promptTemplateHash: z.literal(PLAMO_CAPTION_TEMPLATE_HASH),
		contextPolicyFingerprint: z.literal(
			LOCAL_CAPTION_CONTEXT_POLICY_FINGERPRINT,
		),
		runtimes: z
			.strictObject({ amd: runtime.optional(), nvidia: runtime.optional() })
			.refine((value) => value.amd !== undefined || value.nvidia !== undefined),
	})
	.superRefine((value, context) => {
		for (const profile of ["amd", "nvidia"] as const) {
			const backend = value.runtimes[profile]?.backend;
			if (
				backend !== undefined &&
				(profile === "nvidia" ? backend !== "CUDA" : backend === "CUDA")
			)
				context.addIssue({
					code: "custom",
					path: ["runtimes", profile, "backend"],
					message: "Runtime backend does not match profile",
				});
		}
	});
export type PublicPlamoCaptionManifest = z.infer<
	typeof publicPlamoCaptionManifestSchema
>;

export function localPlamoCaptionIdentityForManifest(
	value: unknown,
	profile: "amd" | "nvidia",
) {
	const manifest = publicPlamoCaptionManifestSchema.parse(value),
		selected = manifest.runtimes[profile];
	if (!selected) throw new Error("LOCAL_CAPTION_PROFILE_UNAVAILABLE");
	return localCaptionModelIdentityV3Schema.parse({
		version: "local-caption-model-v3",
		provider: "LOCAL_LLAMA_CPP",
		profile,
		modelId: manifest.modelId,
		sourceRevision: manifest.sourceRevision,
		weightSha256: manifest.weightSha256,
		weightBytes: manifest.weightBytes,
		quantization: manifest.quantization,
		...(manifest.conversionRecipeHash
			? { conversionRecipeHash: manifest.conversionRecipeHash }
			: {}),
		runtimeSourceRevision: selected.sourceRevision,
		runtimeBinarySha256: selected.binarySha256,
		...(selected.backend ? { runtimeBackend: selected.backend } : {}),
		...(selected.buildRecipeHash
			? { runtimeBuildRecipeHash: selected.buildRecipeHash }
			: {}),
		promptTemplateHash: manifest.promptTemplateHash,
		promptVersion: PLAMO_CAPTION_TEMPLATE.version,
		contextPolicyFingerprint: manifest.contextPolicyFingerprint,
		validationPolicyFingerprint: PLAMO_CAPTION_VALIDATION_POLICY_FINGERPRINT,
		schemaHash: hashEditingEvidence(
			z.toJSONSchema(localPlamoCaptionOutputSchema),
		),
		manifestHash: hashEditingEvidence(manifest),
		configId: manifest.configId,
		context: 8192,
		maxOutputTokens: 1536,
		temperature: 0,
		seed: 41,
		thinking: false,
	});
}
