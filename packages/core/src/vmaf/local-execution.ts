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
		requestedDecode: z.enum(["cpu", "auto", "cuda"]),
		device: z.number().int().nonnegative().safe().optional(),
		decode: z
			.object({ reference: inputExecution, distorted: inputExecution })
			.strict(),
		scoring: z.discriminatedUnion("backend", [
			z
				.object({
					backend: z.literal("cpu"),
					implementation: z.literal("libvmaf"),
					model: modelName,
				})
				.strict(),
			z
				.object({
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
