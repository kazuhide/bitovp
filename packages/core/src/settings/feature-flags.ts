import { z } from "zod";

/**
 * App-wide feature flags . Stored as ONE `AppSetting` row under
 * `FEATURE_FLAGS_KEY`; the value is parsed here so a hand-edited or
 * half-migrated row degrades to defaults instead of crashing a render.
 *
 * The DEFAULTS live here rather than in the database, which is what makes an
 * absent row and a fresh install the same state — no seed step, and deleting
 * the row is a valid "back to defaults".
 */
export const FEATURE_FLAGS_KEY = "featureFlags";

export const featureFlagsSchema = z
	.object({
		/**
		 * The VMAF lab and everything QC (owner 2026-08-18: default OFF).
		 *
		 * OFF means nothing new can START and the browsing surfaces are gone —
		 * it does NOT mean work that already exists becomes unreachable. The
		 * override route, the evidence export and the QC gate panel of a job
		 * that carries a gate stay available in both states, because a job
		 * parked at AWAITING_QC under a BLOCK_MANIFESTS gate can only be
		 * released there .
		 */
		qcVmaf: z.boolean().default(false),
	})
	.strip();

export type FeatureFlags = z.infer<typeof featureFlagsSchema>;

/**
 * The PATCH shape: every flag optional, and — the point — with NO defaults.
 *
 * `featureFlagsSchema.partial` does not do this: `.partial` wraps each
 * field in optional but leaves the inner `.default(false)`, so parsing `{}`
 * yields `{ qcVmaf: false }` and a patch that named nothing turned the flag
 * OFF (review-265 131-A6 found it through the merge test). Absent must mean
 * absent, so the merge below can leave untouched flags alone.
 *
 * The duplicated key list is guarded: a test asserts these two schemas
 * describe the same set, so adding a flag to one and not the other fails.
 */
export const featureFlagsPatchSchema = z
	.object({
		qcVmaf: z.boolean().optional(),
	})
	.strip();

export type FeatureFlagsPatch = z.infer<typeof featureFlagsPatchSchema>;

/** Every flag at its default — the meaning of an absent or unusable row. */
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = featureFlagsSchema.parse({});

/**
 * Parse a stored value into flags, falling back to defaults per the contract
 * above. Never throws: the caller is a page render or a worker tick, and a
 * malformed settings row must not take either down.
 */
export function parseFeatureFlags(value: unknown): FeatureFlags {
	const parsed = featureFlagsSchema.safeParse(value ?? {});
	return parsed.success ? parsed.data : DEFAULT_FEATURE_FLAGS;
}
