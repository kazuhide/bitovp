import { z } from "zod";

export const BANDING_DETECTOR_ID = "CAMBI";
export const BANDING_SCORING_VERSION = 1;
/** Reserved job family; VMAF generations 1–10 retain their existing meanings. */
export const BANDING_JOB_SCORING_VERSION = 11;

const score = z.number().finite().nonnegative();
export const bandingFrameSchema = z.strictObject({
	frameNum: z.number().int().nonnegative(),
	timestampSeconds: z.number().finite().nonnegative(),
	durationSeconds: z.number().finite().positive(),
	/** Canonical official CPU value, including when a GPU computed this frame. */
	cambi: score,
	/** Actual GPU value, before the independent CPU-reference decision. */
	computedCambi: score.optional(),
	/** Unrounded official CPU oracle value when native extraction is used. */
	cpuReferenceCambi: score.optional(),
});
export type BandingFrame = z.infer<typeof bandingFrameSchema>;

export const bandingPooledSchema = z
	.strictObject({
		mean: score,
		min: score,
		max: score,
		frameCount: z.number().int().positive(),
		durationSeconds: z.number().finite().positive(),
	})
	.refine((value) => value.min <= value.mean && value.mean <= value.max, {
		message: "Banding minimum, mean and maximum must be ordered",
	});
export type BandingPooled = z.infer<typeof bandingPooledSchema>;
export type BandingSeverity = "PASS" | "WARN" | "FAIL";
export type BandingThresholds = {
	warningThreshold?: number;
	failureThreshold?: number;
};
export type BandingRange = {
	startSeconds: number;
	endSeconds: number;
	startFrame: number;
	endFrame: number;
	peak: number;
	severity: "WARN" | "FAIL";
};
export type BandingAssessment = {
	severity: BandingSeverity;
	ranges: BandingRange[];
	affectedSeconds: number;
	warningSeconds: number;
	failureSeconds: number;
};
