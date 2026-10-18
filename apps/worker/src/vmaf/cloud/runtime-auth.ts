import { BatchClient } from "@aws-sdk/client-batch";
import { S3Client } from "@aws-sdk/client-s3";
import { ClientSecretCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import type { VmafCloudProfile, VmafComputeSecret } from "@bitovp/core";
import { Storage } from "@google-cloud/storage";
import { GoogleAuth } from "google-auth-library";
import type { AwsDependencies } from "./provider-aws";
import { httpsEndpoint } from "./provider-common";
import type { StagingDependencies } from "./staging";

/** Controller-only credentials. Neither provider task payloads nor snapshots receive them. */
export function createCloudRuntimeAuth(
	reveal: (id: string) => Promise<VmafComputeSecret>,
	allowAmbient: () => boolean = () => true,
) {
	async function secret(id: string, provider: VmafComputeSecret["provider"]) {
		try {
			const value = await reveal(id);
			if (value.provider !== provider) throw new Error();
			return value;
		} catch {
			throw new Error("VMAF cloud credentials are unavailable");
		}
	}
	return {
		async computeAuth(profile: VmafCloudProfile): Promise<AwsDependencies> {
			if (!profile.computeCredentialId) {
				if (!allowAmbient())
					throw new Error("VMAF cloud credentials are unavailable");
				return {};
			}
			const provider = {
				AWS_BATCH: "AWS",
				GCP_BATCH: "GCP",
				AZURE_BATCH: "AZURE",
				AKAMAI_VM: "AKAMAI",
			} as const;
			const value = await secret(
				profile.computeCredentialId,
				provider[profile.provider],
			);
			switch (value.provider) {
				case "AWS":
					return {
						awsClient: new BatchClient({
							region: profile.region,
							maxAttempts: 1,
							credentials: {
								accessKeyId: value.accessKeyId,
								secretAccessKey: value.secretAccessKey,
							},
						}),
					};
				case "GCP": {
					const auth = new GoogleAuth({
						credentials: {
							client_email: value.clientEmail,
							private_key: value.privateKey,
						},
						projectId: value.projectId,
						scopes: ["https://www.googleapis.com/auth/cloud-platform"],
					});
					return {
						googleToken: async () => {
							const token = await auth.getAccessToken();
							if (!token) throw new Error("Missing GCP token");
							return token;
						},
					};
				}
				case "AZURE": {
					const credential = new ClientSecretCredential(
						value.tenantId,
						value.clientId,
						value.clientSecret,
					);
					return {
						azureToken: async () => {
							const token = await credential.getToken(
								"https://batch.core.windows.net/.default",
							);
							if (!token) throw new Error("Missing Azure token");
							return token.token;
						},
					};
				}
				case "AKAMAI":
					return { akamaiToken: () => value.token };
			}
		},
		async stagingAuth(profile: VmafCloudProfile): Promise<StagingDependencies> {
			if (!profile.stagingCredentialId) {
				if (!allowAmbient())
					throw new Error("VMAF cloud credentials are unavailable");
				return {};
			}
			const config = profile.staging;
			const provider = { S3: "AWS", GCS: "GCP", AZURE: "AZURE" } as const;
			const value = await secret(
				profile.stagingCredentialId,
				provider[config.provider],
			);
			if (config.provider === "S3" && value.provider === "AWS")
				return {
					s3: new S3Client({
						region: config.region,
						endpoint: config.endpoint,
						forcePathStyle: Boolean(config.endpoint),
						maxAttempts: 1,
						requestChecksumCalculation: "WHEN_REQUIRED",
						responseChecksumValidation: "WHEN_REQUIRED",
						credentials: {
							accessKeyId: value.accessKeyId,
							secretAccessKey: value.secretAccessKey,
						},
					}),
				};
			if (config.provider === "GCS" && value.provider === "GCP")
				return {
					gcs: new Storage({
						credentials: {
							client_email: value.clientEmail,
							private_key: value.privateKey,
						},
						projectId: value.projectId,
						retryOptions: { autoRetry: false },
					}),
				};
			if (config.provider === "AZURE" && value.provider === "AZURE")
				return {
					azure: new BlobServiceClient(
						httpsEndpoint(config.accountUrl, ".blob.core.windows.net"),
						new ClientSecretCredential(
							value.tenantId,
							value.clientId,
							value.clientSecret,
						),
						{ retryOptions: { maxTries: 1 } },
					),
				};
			throw new Error("VMAF staging credentials are incompatible");
		},
	};
}
