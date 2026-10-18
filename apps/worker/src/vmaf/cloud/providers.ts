import {
	type VmafCloudProfile,
	type VmafComputeAdapter,
	vmafCloudProfileSchema,
} from "@bitovp/core";
import { akamaiAdapter } from "./provider-akamai.js";
import { type AwsDependencies, awsAdapter } from "./provider-aws.js";
import { azureAdapter } from "./provider-azure.js";
import { safeAdapter } from "./provider-common.js";
import { gcpAdapter } from "./provider-gcp.js";

export function createComputeAdapter(
	profile: VmafCloudProfile,
	dependencies: AwsDependencies = {},
): VmafComputeAdapter {
	const parsed = vmafCloudProfileSchema.parse(profile);
	switch (parsed.provider) {
		case "AWS_BATCH":
			return safeAdapter(awsAdapter(parsed, dependencies));
		case "GCP_BATCH":
			return safeAdapter(gcpAdapter(parsed, dependencies));
		case "AZURE_BATCH":
			return safeAdapter(azureAdapter(parsed, dependencies));
		case "AKAMAI_VM":
			return safeAdapter(akamaiAdapter(parsed, dependencies));
	}
}
