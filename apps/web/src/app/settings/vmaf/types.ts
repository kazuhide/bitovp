import type { VmafCloudProfile } from "@bitovp/core";

export type CredentialRow = {
	id: string;
	label: string;
	provider: "AWS" | "GCP" | "AZURE" | "AKAMAI";
	disabledAt: string | null;
};
export type ProfileRow = {
	id: string;
	label: string;
	config: VmafCloudProfile;
	version: number;
	enabled: boolean;
};
export const CLOUD_NAMES = {
	AWS_BATCH: "AWS Batch",
	GCP_BATCH: "Google Cloud Batch",
	AZURE_BATCH: "Azure Batch",
	AKAMAI_VM: "Akamai VM",
} as const;
export const COMPUTE_AUTH = {
	AWS_BATCH: "AWS",
	GCP_BATCH: "GCP",
	AZURE_BATCH: "AZURE",
	AKAMAI_VM: "AKAMAI",
} as const;
export const STORAGE_AUTH = { S3: "AWS", GCS: "GCP", AZURE: "AZURE" } as const;

export const STORAGE_NAMES = {
	S3: "S3 / S3-compatible",
	GCS: "Google Cloud Storage",
	AZURE: "Azure Blob",
} as const;
