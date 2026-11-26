import { z } from "zod";

export const VOD_INPUT_FAVORITES_KEY = "vod.input-favorites.v1";
export const MAX_VOD_INPUT_FAVORITES = 64;
const cleanText = (value: string) =>
	[...value].every((character) => {
		const code = character.charCodeAt(0);
		return code >= 32 && code !== 127;
	});

export const vodInputFavoriteCreateSchema = z
	.strictObject({
		credentialId: z.uuid(),
		bucket: z
			.string()
			.min(1)
			.max(255)
			.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
		objectKey: z
			.string()
			.min(1)
			.max(1024)
			.refine(
				(value) =>
					cleanText(value) &&
					!value.startsWith("/") &&
					!value.endsWith("/") &&
					!value.includes("://") &&
					!/[?#\\]/.test(value) &&
					!value.split("/").includes(".."),
				"Use an opaque storage object key",
			),
		label: z.string().trim().min(1).max(120).refine(cleanText),
		kind: z.enum(["VIDEO", "AUDIO", "IMAGE"]),
	})
	.refine(
		(value) =>
			value.kind !== "IMAGE" || /\.(png|jpe?g)$/i.test(value.objectKey),
		"Choose a PNG or JPEG image",
	);
export type VodInputFavoriteCreate = z.infer<
	typeof vodInputFavoriteCreateSchema
>;
export const vodInputFavoriteSchema = vodInputFavoriteCreateSchema.extend({
	id: z.uuid(),
});
export type VodInputFavorite = z.infer<typeof vodInputFavoriteSchema>;
export const vodInputFavoritesSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		items: z.array(vodInputFavoriteSchema).max(MAX_VOD_INPUT_FAVORITES),
	})
	.superRefine((value, ctx) => {
		if (
			new Set(value.items.map((item) => item.id)).size !== value.items.length ||
			new Set(value.items.map(favoriteReferenceKey)).size !== value.items.length
		) {
			ctx.addIssue({ code: "custom", message: "Fixed sources must be unique" });
		}
	});
export type VodInputFavorites = z.infer<typeof vodInputFavoritesSchema>;

/** Only an absent row means an empty registry; corrupt JSON must remain visible. */
export function parseVodInputFavorites(value: unknown): VodInputFavorites {
	return vodInputFavoritesSchema.parse(
		value === undefined ? { schemaVersion: 1, items: [] } : value,
	);
}
export function favoriteReferenceKey(
	value: Pick<VodInputFavorite, "credentialId" | "bucket" | "objectKey">,
): string {
	return JSON.stringify([value.credentialId, value.bucket, value.objectKey]);
}
export const vodInputFavoriteWireSchema = vodInputFavoriteSchema.extend({
	availability: z.enum([
		"AVAILABLE",
		"CREDENTIAL_UNAVAILABLE",
		"UNSUPPORTED_PROVIDER",
	]),
	inputKind: z
		.enum(["S3", "GENERIC_S3", "GCS", "GCS_SERVICE_ACCOUNT"])
		.nullable(),
});
export type VodInputFavoriteWire = z.infer<typeof vodInputFavoriteWireSchema>;
export const vodInputFavoritesResponseSchema = z.strictObject({
	favorites: z.array(vodInputFavoriteWireSchema).max(MAX_VOD_INPUT_FAVORITES),
});

/** Same browsable storage kinds as the VOD wizard, narrowed to existing image signing. */
export function vodFavoriteInputKind(
	provider: string,
	kind: VodInputFavorite["kind"],
): VodInputFavoriteWire["inputKind"] {
	switch (provider) {
		case "AWS_S3":
			return "S3";
		case "AKAMAI_OBJECT_STORAGE":
		case "OCI_OBJECT_STORAGE":
		case "GENERIC_S3":
			return "GENERIC_S3";
		case "GCS_HMAC":
			return "GCS";
		case "GCS_SERVICE_ACCOUNT":
			return kind === "IMAGE" ? null : "GCS_SERVICE_ACCOUNT";
		default:
			return null;
	}
}
