import { z } from "zod";
import type { CredentialProviderId } from "../credentials/schemas";

/** Storage location presets (REQUIREMENTS §3.2, ARCHITECTURE §8). */

export const STORAGE_ROLES = ["INPUT", "OUTPUT"] as const;
export const storageRoleSchema = z.enum(STORAGE_ROLES);
export type StorageRoleId = z.infer<typeof storageRoleSchema>;

export const createStoragePresetSchema = z.object({
	credentialId: z.uuid(),
	label: z.string().min(1, "Label is required").max(120),
	bucket: z.string().min(1, "Bucket is required"),
	prefix: z.string().default(""),
	role: storageRoleSchema,
});

export type CreateStoragePresetRequest = z.infer<
	typeof createStoragePresetSchema
>;

export const storagePresetWireSchema = z.object({
	id: z.uuid(),
	credentialId: z.uuid(),
	label: z.string(),
	bucket: z.string(),
	prefix: z.string(),
	role: storageRoleSchema,
	createdAt: z.string(),
	updatedAt: z.string(),
});

export type StoragePresetWire = z.infer<typeof storagePresetWireSchema>;

/**
 * Display/copy URI for an object or prefix, in the scheme each ecosystem
 * expects. Pure + client-safe (the heavy SDK drivers live in
 * @bitovp/storage, server-side only).
 */
export function objectUri(
	provider: CredentialProviderId,
	bucket: string,
	key = "",
): string {
	switch (provider) {
		case "GCS_HMAC":
		case "GCS_SERVICE_ACCOUNT":
			return `gs://${bucket}/${key}`;
		case "AZURE_BLOB":
			// A neutral scheme on purpose: the real https URL needs the storage
			// *account* name, which lives in credential config and is not an input
			// here — and Bitmovin's AzureInput/Output address blobs by
			// container + path exactly like this.
			return `azure-blob://${bucket}/${key}`;
		default:
			return `s3://${bucket}/${key}`;
	}
}
