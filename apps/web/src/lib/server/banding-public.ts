import "server-only";
import { BANDING_DECISION_PRECISION, bandingPooledSchema } from "@bitovp/core";
import { z } from "zod";

/** Deliberate public projection: native receipts and private object identities
 * stay server-side, just as they do for existing local VMAF reports. */
const executionSchema = z
	.object({
		version: z.literal(1),
		metric: z.literal("CAMBI_NR"),
		scoringVersion: z.literal(1).optional(),
		backend: z.enum(["cpu", "cuda", "vulkan"]),
		decodeBackend: z.literal("cpu").optional(),
		implementation: z.enum(["libvmaf", "bitovp-owned"]),
		libvmafVersion: z.string().min(1).max(128).optional(),
		decisionSource: z.literal("CPU_REFERENCE"),
		decisionPrecision: z.literal(BANDING_DECISION_PRECISION).optional(),
		selection: z
			.object({
				requested: z.enum(["CPU", "AUTO"]),
				reason: z
					.enum(["GPU_NOT_AVAILABLE", "GPU_RUNTIME_UNAVAILABLE"])
					.optional(),
			})
			.optional(),
		coverage: z.object({
			complete: z.literal(true),
			frameCount: z.number().int().positive(),
			durationSeconds: z.number().finite().positive(),
			startTimeSeconds: z.number().finite().nonnegative().optional(),
			endTimeSeconds: z.number().finite().positive().optional(),
			timingSource: z
				.literal("PRESENTATION_TIMESTAMPS_AND_FRAME_DURATION")
				.optional(),
		}),
	})
	.refine((execution) =>
		execution.backend === "cpu"
			? execution.implementation === "libvmaf"
			: execution.implementation === "bitovp-owned",
	);
export type PublicBandingExecution = z.infer<typeof executionSchema>;

const nonnegative = z.number().finite().nonnegative();
const rangeSchema = z
	.object({
		startSeconds: nonnegative,
		endSeconds: z.number().finite().positive(),
		startFrame: z.number().int().nonnegative(),
		endFrame: z.number().int().nonnegative(),
		peak: nonnegative,
		severity: z.enum(["WARN", "FAIL"]),
	})
	.refine(
		(range) =>
			range.endSeconds > range.startSeconds &&
			range.endFrame >= range.startFrame,
	);
const assessmentSchema = z.object({
	severity: z.enum(["PASS", "WARN", "FAIL"]),
	ranges: z.array(rangeSchema),
	affectedSeconds: nonnegative,
	warningSeconds: nonnegative,
	failureSeconds: nonnegative,
	warningThreshold: nonnegative.optional(),
	failureThreshold: nonnegative.optional(),
});
export type PublicBandingAssessment = z.infer<typeof assessmentSchema>;

export function bandingExecutionOf(
	provenance: unknown,
): PublicBandingExecution | undefined {
	if (
		!provenance ||
		typeof provenance !== "object" ||
		!("bandingExecution" in provenance)
	)
		return undefined;
	return executionSchema.safeParse(provenance.bandingExecution).data;
}

export function bandingPooledOf(pooled: unknown) {
	if (!pooled || typeof pooled !== "object" || !("banding" in pooled))
		return undefined;
	return bandingPooledSchema.safeParse(pooled.banding).data;
}

export function bandingAssessmentOf(
	pooled: unknown,
): PublicBandingAssessment | undefined {
	if (!pooled || typeof pooled !== "object" || !("bandingAssessment" in pooled))
		return undefined;
	return assessmentSchema.safeParse(pooled.bandingAssessment).data;
}
