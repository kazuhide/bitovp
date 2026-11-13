import { z } from "zod";

const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/);
const modelName = z
	.string()
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const inputExecution = z
	.object({
		backend: z.enum(["cpu", "cuda"]),
		reason: reasonCode.optional(),
	})
	.strict();

/** Safe per-result metadata; hardware decoding is separate from scoring. */
export const localVmafExecutionSchema = z
	.object({
		version: z.literal(1),
		selection: z
			.object({
				requested: z.enum(["CPU", "AUTO"]),
				reason: reasonCode.optional(),
			})
			.strict()
			.optional(),
		requestedDecode: z.enum(["cpu", "auto", "cuda"]),
		device: z.number().int().nonnegative().safe().optional(),
		decode: z
			.object({ reference: inputExecution, distorted: inputExecution })
			.strict(),
		scoring: z.union([
			z
				.object({
					backend: z.literal("cpu"),
					implementation: z.literal("libvmaf"),
					model: modelName,
				})
				.strict(),
			z
				.object({
					// Read-only provenance for generation 7; no executable backend exists.
					backend: z.literal("cuda"),
					implementation: z.literal("vmafx"),
					model: modelName,
					modelSha256: z.string().regex(/^[a-f0-9]{64}$/i),
					features: z
						.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/))
						.max(64),
					bitDepth: z.literal(10),
					distortedOriginal: z
						.object({
							width: z.number().int().positive().safe(),
							height: z.number().int().positive().safe(),
							bitdepth: z.number().refine((n) => [8, 10, 12, 16].includes(n)),
						})
						.strict(),
					revision: z
						.string()
						.regex(/^[a-f0-9]{40}$/i)
						.optional(),
				})
				.strict(),
			z
				.object({
					backend: z.enum(["cuda", "vulkan"]),
					implementation: z.literal("bitovp-owned"),
					model: modelName,
					modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
					features: z
						.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,511}$/))
						.min(7)
						.max(64),
					// The depth at which the pair was compared: the reference's since
					// generations 12 and 13, always 10 in generations 9 and 10.
					bitDepth: z.union([z.literal(8), z.literal(10)]),
					distortedOriginal: z
						.object({
							width: z.number().int().positive().safe(),
							height: z.number().int().positive().safe(),
							bitdepth: z.union([
								z.literal(8),
								z.literal(10),
								z.literal(12),
								z.literal(16),
							]),
						})
						.strict(),
					officialRevision: z.string().regex(/^[a-f0-9]{40}$/),
					sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
					device: z
						.object({
							index: z.number().int().nonnegative().safe(),
							name: z.string().min(1).max(512),
							uuid: z.string().min(1).max(128),
							vendorId: z.number().int().positive().safe(),
							deviceId: z.number().int().nonnegative().safe(),
							integrated: z.boolean(),
						})
						.strict(),
					cpuParity: z
						.object({
							checked: z.literal(true),
							featureCount: z.number().int().positive().safe(),
							scoreCount: z.number().int().positive().safe(),
							maxFeatureError: z.number().nonnegative(),
							maxScoreError: z.number().nonnegative().max(1e-4),
						})
						.strict(),
				})
				.strict(),
		]),
		attempts: z.union([z.literal(1), z.literal(2)]),
		fallbackReason: reasonCode.optional(),
	})
	.strict();
export type LocalVmafExecution = z.infer<typeof localVmafExecutionSchema>;

/** Historical, invalid and unknown provenance never reaches public reports. */
export function localVmafExecutionOf(
	provenance: unknown,
): LocalVmafExecution | undefined {
	if (
		typeof provenance !== "object" ||
		provenance === null ||
		Array.isArray(provenance)
	)
		return undefined;
	const parsed = localVmafExecutionSchema.safeParse(
		(provenance as { localExecution?: unknown }).localExecution,
	);
	return parsed.success ? parsed.data : undefined;
}
