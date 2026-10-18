import { z } from "zod";
import { vmafCloudProfileSchema } from "./cloud";

const secret = z.string().min(1).max(32768);
/** Write-only material. Rotation creates a new ID; task snapshots retain old IDs. */
export const vmafComputeSecretSchema = z.discriminatedUnion("provider", [
	z
		.object({
			provider: z.literal("AWS"),
			accessKeyId: secret,
			secretAccessKey: secret,
		})
		.strict(),
	z
		.object({
			provider: z.literal("GCP"),
			clientEmail: z.email(),
			privateKey: secret,
			projectId: z.string().min(1).max(200).optional(),
		})
		.strict(),
	z
		.object({
			provider: z.literal("AZURE"),
			tenantId: secret,
			clientId: secret,
			clientSecret: secret,
		})
		.strict(),
	z.object({ provider: z.literal("AKAMAI"), token: secret }).strict(),
]);
export type VmafComputeSecret = z.infer<typeof vmafComputeSecretSchema>;
export const vmafComputeCredentialCreateSchema = z
	.object({
		label: z.string().trim().min(1).max(100),
		secret: vmafComputeSecretSchema,
	})
	.strict();
export const vmafExecutionProfileSaveSchema = z
	.object({
		profile: vmafCloudProfileSchema,
		enabled: z.boolean().default(true),
		/** Omit when creating; required to replace the exact existing version. */
		expectedVersion: z.number().int().positive().optional(),
	})
	.strict();
