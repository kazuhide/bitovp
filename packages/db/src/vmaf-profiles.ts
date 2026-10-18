import { randomUUID } from "node:crypto";
import {
	parseVmafCloudProfiles,
	type SecretCipher,
	type VmafCloudProfile,
	type VmafComputeSecret,
	vmafCloudProfileSchema,
	vmafComputeCredentialCreateSchema,
	vmafComputeSecretSchema,
	vmafExecutionProfileSaveSchema,
} from "@bitovp/core";
import type { VmafComputeCredential } from "../generated/client";
import type { AppPrismaClient } from "./client";
import { DEFAULT_ORGANIZATION_ID, tenantOrganizationId } from "./tenant-client";

export class VmafProfileError extends Error {
	constructor(readonly code: "INVALID" | "CONFLICT" | "CREDENTIAL") {
		super(
			code === "CONFLICT"
				? "Profile changed; reload before saving"
				: code === "CREDENTIAL"
					? "Credential is missing, disabled, or incompatible"
					: "Invalid VMAF profile configuration",
		);
	}
}
const aad = (id: string, provider: string) =>
	`vmaf-compute-credential:${id}:${provider}`;
export type VmafComputeCredentialSummary = Omit<
	VmafComputeCredential,
	"encryptedSecret"
>;
export function createVmafComputeCredentialStore(
	prisma: AppPrismaClient,
	cipher: SecretCipher,
) {
	return {
		async create(input: {
			label: string;
			secret: VmafComputeSecret;
		}): Promise<VmafComputeCredentialSummary> {
			const parsed = vmafComputeCredentialCreateSchema.safeParse(input);
			if (!parsed.success) throw new VmafProfileError("INVALID");
			const id = randomUUID();
			const { label, secret } = parsed.data;
			const encryptedSecret = await cipher.encrypt(
				JSON.stringify(secret),
				aad(id, secret.provider),
			);
			return prisma.vmafComputeCredential.create({
				data: { id, label, provider: secret.provider, encryptedSecret },
			});
		},
		list: () =>
			prisma.vmafComputeCredential.findMany({
				where: { disabledAt: null },
				orderBy: { createdAt: "desc" },
			}),
		get: (id: string) =>
			prisma.vmafComputeCredential.findUnique({ where: { id } }),
		/** Never destroy historical material while cloud cleanup may still need it. */
		disable: (id: string) =>
			prisma.vmafComputeCredential.update({
				where: { id },
				data: { disabledAt: new Date() },
			}),
		async revealSecret(id: string): Promise<VmafComputeSecret> {
			const row = await prisma.vmafComputeCredential.findUniqueOrThrow({
				where: { id },
				select: { provider: true, encryptedSecret: true },
			});
			const parsed = vmafComputeSecretSchema.safeParse(
				JSON.parse(
					await cipher.decrypt(row.encryptedSecret, aad(id, row.provider)),
				),
			);
			if (!parsed.success || parsed.data.provider !== row.provider)
				throw new VmafProfileError("INVALID");
			return parsed.data;
		},
	};
}

type CredentialReader = Pick<AppPrismaClient, "vmafComputeCredential">;
/** Metadata only: no provider access and no decryption during profile selection. */
export async function validateVmafProfileCredentials(
	prisma: CredentialReader,
	profile: VmafCloudProfile,
): Promise<void> {
	const expectedCompute = {
		AWS_BATCH: "AWS",
		GCP_BATCH: "GCP",
		AZURE_BATCH: "AZURE",
		AKAMAI_VM: "AKAMAI",
	}[profile.provider];
	const expectedStaging = { S3: "AWS", GCS: "GCP", AZURE: "AZURE" }[
		profile.staging.provider
	];
	for (const [id, provider] of [
		[profile.computeCredentialId, expectedCompute],
		[profile.stagingCredentialId, expectedStaging],
	]) {
		if (!id) continue; // Ambient workload identity remains supported.
		const row = await prisma.vmafComputeCredential.findUnique({
			where: { id },
			select: { provider: true, disabledAt: true },
		});
		if (!row || row.disabledAt || row.provider !== provider)
			throw new VmafProfileError("CREDENTIAL");
	}
}

export function createVmafExecutionProfileStore(prisma: AppPrismaClient) {
	return {
		list: () =>
			prisma.vmafExecutionProfile.findMany({
				where: { resetAt: null },
				orderBy: { label: "asc" },
			}),
		get: (id: string) =>
			prisma.vmafExecutionProfile.findUnique({ where: { id } }),
		async save(input: unknown) {
			const parsed = vmafExecutionProfileSaveSchema.safeParse(input);
			if (!parsed.success) throw new VmafProfileError("INVALID");
			const { profile, enabled, expectedVersion } = parsed.data;
			try {
				return await prisma.$transaction(
					async (tx) => {
						await validateVmafProfileCredentials(
							tx as CredentialReader,
							profile,
						);
						const current = await tx.vmafExecutionProfile.findUnique({
							where: { id: profile.id },
						});
						if (
							current && !current.resetAt
								? current.version !== expectedVersion
								: expectedVersion !== undefined
						)
							throw new VmafProfileError("CONFLICT");
						const version = (current?.version ?? 0) + 1;
						const data = {
							label: profile.label,
							config: { ...profile, profileVersion: version },
							version,
							enabled,
							resetAt: null,
						};
						return current
							? tx.vmafExecutionProfile.update({
									where: { id: profile.id },
									data,
								})
							: tx.vmafExecutionProfile.create({
									data: { id: profile.id, ...data },
								});
					},
					{ isolationLevel: "Serializable" },
				);
			} catch (error) {
				if (
					["P2002", "P2034"].includes((error as { code?: string }).code ?? "")
				)
					throw new VmafProfileError("CONFLICT");
				throw error;
			}
		},
		disable: (id: string) =>
			prisma.vmafExecutionProfile.update({
				where: { id },
				data: { enabled: false, version: { increment: 1 } },
			}),
	};
}

/** DB IDs shadow environment IDs, including disabled rows: no fallback resurrection. */
export async function listVmafCloudProfiles(
	prisma: AppPrismaClient,
	envRaw?: string,
): Promise<VmafCloudProfile[]> {
	const rows = await prisma.vmafExecutionProfile.findMany();
	const ids = new Set(rows.map((row) => row.id));
	const profiles = [
		...parseVmafCloudProfiles(
			tenantOrganizationId(prisma) &&
				tenantOrganizationId(prisma) !== DEFAULT_ORGANIZATION_ID
				? undefined
				: envRaw,
		).filter((profile) => !ids.has(profile.id)),
		...rows
			.filter((row) => row.enabled && !row.resetAt)
			.map((row) =>
				vmafCloudProfileSchema.parse({
					...(row.config as object),
					id: row.id,
					label: row.label,
					profileVersion: row.version,
				}),
			),
	];
	const available: VmafCloudProfile[] = [];
	for (const profile of profiles) {
		try {
			await validateVmafProfileCredentials(prisma, profile);
			available.push(profile);
		} catch (error) {
			if (!(error instanceof VmafProfileError)) throw error;
		}
	}
	return available;
}
