import { z } from "zod";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = integer.positive();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const rational = z.strictObject({ num: positive, den: positive });
export const editingNormalizationSourceSchema = z.strictObject({
	width: positive.min(2).max(8192),
	height: positive.min(2).max(8192),
	codec: z.enum(["h264", "hevc"]),
	fps: rational.refine(
		({ num, den }) =>
			(num === 24 && den === 1) ||
			(num === 25 && den === 1) ||
			(num === 30000 && den === 1001) ||
			(num === 30 && den === 1),
	),
	timeBase: rational,
	frameCount: positive.max(108000),
	durationUs: positive.max(3_600_000_000),
	videoPtsHash: sha,
	colorProfile: z.enum(["BT709_8BIT_LIMITED", "BT709_8BIT_LIMITED_ASSUMED"]),
	audio: z
		.strictObject({
			sampleRate: z.union([z.literal(44100), z.literal(48000)]),
			channels: z.union([z.literal(1), z.literal(2)]),
			sampleCount: positive.max(180_000_000),
			ptsHash: sha,
		})
		.nullable(),
});
export type EditingNormalizationSource = z.infer<
	typeof editingNormalizationSourceSchema
>;

export const editingNormalizationEvidenceSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		profile: z.literal("SDR_CFR30_INDEXED_V1"),
		mode: z.enum(["IDENTITY_COPY", "NORMALIZE"]),
		originalSha256: sha,
		preparedSha256: sha,
		originalBytes: positive,
		preparedBytes: positive,
		source: editingNormalizationSourceSchema,
		output: z.strictObject({
			width: positive,
			height: positive,
			frameCount: positive.max(108000),
			durationUs: positive,
			fps: z.strictObject({ num: z.literal(30), den: z.literal(1) }),
			hasAudio: z.boolean(),
		}),
		sourceStartUs: z.literal(0),
		sourceEndUs: positive,
		sourceFrameIndex: z.array(integer).min(1).max(108000),
		indexMapHash: sha,
		recipeHash: sha,
	})
	.superRefine((value, ctx) => {
		const target = Number(
			(BigInt(value.source.frameCount) * 30n * BigInt(value.source.fps.den)) /
				BigInt(value.source.fps.num),
		);
		if (
			value.output.frameCount !== target ||
			value.sourceFrameIndex.length !== target ||
			value.sourceEndUs !== Math.ceil((target * 1_000_000) / 30) ||
			value.output.durationUs !== value.sourceEndUs ||
			value.source.width !== value.output.width ||
			value.source.height !== value.output.height ||
			value.output.hasAudio !== (value.source.audio !== null)
		)
			ctx.addIssue({
				code: "custom",
				message:
					"Normalization must preserve the original clock, geometry and audio presence",
			});
		if (
			value.sourceFrameIndex.some(
				(entry, index) =>
					entry !==
					Number(
						(BigInt(index) * BigInt(value.source.fps.num)) /
							(30n * BigInt(value.source.fps.den)),
					),
			)
		)
			ctx.addIssue({
				code: "custom",
				path: ["sourceFrameIndex"],
				message:
					"Normalization index must identify each sampled original frame",
			});
		if (
			value.mode === "IDENTITY_COPY" &&
			(value.source.fps.num !== 30 ||
				value.source.fps.den !== 1 ||
				value.source.codec !== "h264" ||
				value.source.colorProfile !== "BT709_8BIT_LIMITED" ||
				value.originalSha256 !== value.preparedSha256 ||
				value.originalBytes !== value.preparedBytes)
		)
			ctx.addIssue({
				code: "custom",
				message: "Identity preparation must preserve the original bytes",
			});
	});
export type EditingNormalizationEvidence = z.infer<
	typeof editingNormalizationEvidenceSchema
>;

/** IDs are added by READY preparation, not by the byte-only native normalizer. */
export const normalizationCaptureReceiptSchema =
	editingNormalizationEvidenceSchema.safeExtend({
		organizationId: z.uuid(),
		sourceId: z.uuid(),
		mediaVersionId: z.uuid(),
		timeMapId: z.uuid(),
	});
export type NormalizationCaptureReceipt = z.infer<
	typeof normalizationCaptureReceiptSchema
>;
