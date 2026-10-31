import { z } from "zod";

export const NATIVE_OFFICIAL_REVISION =
	"74f930d17de8c58e7c2ce55e2b897b0030ebd8ef";

/** Native protocol structure; the worker also checks invocation-specific identities. */
const integer = z.number().int().nonnegative().safe();
const dimension = integer.positive().max(16384);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const originalSchema = z
	.object({
		width: dimension,
		height: dimension,
		bitdepth: z.union([
			z.literal(8),
			z.literal(10),
			z.literal(12),
			z.literal(16),
		]),
	})
	.strict();
const pooledSchema = z
	.object({
		min: z.number(),
		max: z.number(),
		mean: z.number(),
		harmonicMean: z.number(),
	})
	.strict();
export const nativeVmafReceiptSchema = z
	.object({
		schema: z.literal(1),
		implementation: z.literal("bitovp-owned"),
		officialRevision: z.literal(NATIVE_OFFICIAL_REVISION),
		sourceSha256: sha,
		backend: z.enum(["cuda", "vulkan"]),
		frames: integer.positive(),
		width: dimension,
		height: dimension,
		bitDepth: z.literal(10),
		requestedDeviceIndex: integer,
		referenceSha256: sha,
		distortedSha256: sha,
		distortedOriginal: originalSchema,
		device: z
			.object({
				index: integer,
				name: z.string().min(1).max(512),
				uuid: z.string().min(1).max(128),
				vendorId: integer.positive(),
				deviceId: integer,
				integrated: z.boolean(),
				memoryBudgetBytes: integer,
			})
			.strict(),
		cpuParity: z
			.object({
				checked: z.literal(true),
				featureCount: integer.positive(),
				scoreCount: integer.positive(),
				maxFeatureError: z.number().nonnegative(),
				maxScoreError: z.number().nonnegative().max(1e-4),
			})
			.strict(),
		models: z
			.array(
				z
					.object({
						id: z.string(),
						sha256: sha,
						pooled: pooledSchema,
						frames: z.array(z.number()),
					})
					.strict(),
			)
			.length(1),
		extractors: z
			.array(
				z
					.object({
						name: z.string(),
						options: z.record(z.string(), z.string()),
						features: z
							.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,511}$/))
							.min(1)
							.max(3),
					})
					.strict(),
			)
			.length(5),
		features: z
			.array(
				z
					.object({ index: integer, name: z.string(), value: z.number() })
					.strict(),
			)
			.min(1),
	})
	.passthrough();
