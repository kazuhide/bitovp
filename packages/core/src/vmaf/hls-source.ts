import { z } from "zod";

const bytes = z
	.number()
	.int()
	.positive()
	.safe()
	.max(8 * 1024 ** 3);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().min(1).max(4096);
const identity = z
	.object({
		size: bytes,
		etag: z.string().min(1).max(512).optional(),
		versionId: z.string().min(1).max(512).optional(),
		generation: z.string().min(1).max(128).optional(),
		lastModified: z.string().max(128).optional(),
	})
	.refine((value) =>
		Boolean(
			value.etag ||
				(value.versionId && value.versionId !== "null") ||
				value.generation,
		),
	);
const captured = z
	.strictObject({
		role: z.enum(["MASTER", "MEDIA", "INIT", "SEGMENT"]),
		key,
		bytes,
		sha256,
		identity,
	})
	.refine((value) => value.bytes === value.identity.size);

/** Private immutable source witness. Public projections intentionally omit all
 * storage coordinates and provider identities. */
export const hlsQcEvidenceSchema = z
	.strictObject({
		version: z.literal(1),
		method: z.literal("FMP4_INIT_SEGMENTS"),
		vmafJobId: z.uuid(),
		renditionKey: z.string().regex(/^[A-Za-z0-9_-]+$/),
		muxingKey: z.string().min(1).max(128),
		bucket: z.string().min(1).max(255),
		masterKey: key,
		mediaKey: key,
		objects: z.array(captured).min(4).max(4099),
		segmentCount: z.number().int().positive().max(4096),
		durationSeconds: z.number().finite().positive().max(3600),
		assembledSha256: sha256,
		assembledBytes: bytes,
		complete: z.literal(true),
	})
	.refine(
		(value) =>
			value.objects.length === value.segmentCount + 3 &&
			value.objects[0]?.role === "MASTER" &&
			value.objects[0].key === value.masterKey &&
			value.objects[1]?.role === "MEDIA" &&
			value.objects[1].key === value.mediaKey &&
			value.objects[2]?.role === "INIT" &&
			value.objects.slice(3).every((object) => object.role === "SEGMENT") &&
			new Set(value.objects.map((object) => object.key)).size ===
				value.objects.length &&
			value.objects
				.slice(2)
				.reduce((total, object) => total + object.bytes, 0) ===
				value.assembledBytes &&
			JSON.stringify(value).length <= 4 * 1024 * 1024,
	);
export type HlsQcEvidence = z.infer<typeof hlsQcEvidenceSchema>;

export function hlsQcEvidenceOf(
	provenance: unknown,
): HlsQcEvidence | undefined {
	if (
		!provenance ||
		typeof provenance !== "object" ||
		!("hlsSource" in provenance)
	)
		return undefined;
	return hlsQcEvidenceSchema.safeParse(provenance.hlsSource).data;
}

export function publicHlsQcEvidenceOf(provenance: unknown) {
	const evidence = hlsQcEvidenceOf(provenance);
	if (!evidence) return undefined;
	const {
		version,
		method,
		segmentCount,
		durationSeconds,
		assembledSha256,
		assembledBytes,
		complete,
	} = evidence;
	return {
		version,
		method,
		segmentCount,
		durationSeconds,
		assembledSha256,
		assembledBytes,
		complete,
	};
}
