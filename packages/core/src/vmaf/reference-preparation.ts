import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const positiveSafeInteger = z.number().int().positive().safe();
const matrixInteger = z.number().int().min(-2147483648).max(2147483647);
const streamToken = z.string().regex(/^[A-Za-z0-9_]{1,32}$/);
const timeBase = z
	.string()
	.max(33)
	.regex(/^[1-9][0-9]*\/[1-9][0-9]*$/)
	.refine((value) =>
		value.split("/").every((part) => Number.isSafeInteger(Number(part))),
	);

/** Public proof of display-scale-only remuxing; local paths never belong here. */
export const vmafReferencePreparationEvidenceSchema = z.strictObject({
	version: z.literal(1),
	method: z.literal("LOSSLESS_DISPLAY_SCALE_REMUX"),
	comparisonSpace: z.literal("CODED_RASTER"),
	inputSha256: sha256,
	preparedSha256: sha256,
	preparedBytes: positiveSafeInteger,
	sourceDisplayMatrix: z.tuple([
		matrixInteger,
		matrixInteger,
		matrixInteger,
		matrixInteger,
		matrixInteger,
		matrixInteger,
		matrixInteger,
		matrixInteger,
		matrixInteger,
	]),
	width: positiveSafeInteger.max(16384),
	height: positiveSafeInteger.max(16384),
	codec: streamToken,
	pixelFormat: streamToken,
	timeBase,
	packetCount: positiveSafeInteger,
	frameCount: positiveSafeInteger,
	packetSha256: sha256,
	frameSha256: sha256,
	streamIdentitySha256: sha256,
	packetTimingVerified: z.literal(true),
	frameTimingVerified: z.literal(true),
});
export type VmafReferencePreparationEvidence = z.infer<
	typeof vmafReferencePreparationEvidenceSchema
>;

/** Missing, malformed or private evidence is absent, never a preparation claim. */
export function referencePreparationOf(
	provenance: unknown,
): VmafReferencePreparationEvidence | undefined {
	if (
		typeof provenance !== "object" ||
		provenance === null ||
		Array.isArray(provenance)
	)
		return undefined;
	const parsed = vmafReferencePreparationEvidenceSchema.safeParse(
		(provenance as { referencePreparation?: unknown }).referencePreparation,
	);
	return parsed.success ? parsed.data : undefined;
}
