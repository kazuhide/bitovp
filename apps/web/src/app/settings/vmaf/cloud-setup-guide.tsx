"use client";

import type { VmafCloudProfile } from "@bitovp/core";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";

type Provider = VmafCloudProfile["provider"];
const guides = {
	AWS_BATCH: {
		prefix: "aws",
		links: [
			"https://docs.aws.amazon.com/AmazonECR/latest/userguide/docker-push-ecr-image.html",
			"https://docs.aws.amazon.com/batch/latest/userguide/create-job-definition-EC2.html",
			"https://docs.aws.amazon.com/AmazonS3/latest/userguide/create-bucket-overview.html",
			"https://docs.aws.amazon.com/batch/latest/userguide/security-iam.html",
		],
	},
	GCP_BATCH: {
		prefix: "gcp",
		links: [
			"https://docs.cloud.google.com/artifact-registry/docs/docker/pushing-and-pulling",
			"https://docs.cloud.google.com/batch/docs/get-started",
			"https://docs.cloud.google.com/storage/docs/creating-buckets",
			"https://docs.cloud.google.com/batch/docs/authentication",
		],
	},
	AZURE_BATCH: {
		prefix: "azure",
		links: [
			"https://learn.microsoft.com/en-us/azure/container-registry/container-registry-get-started-docker-cli",
			"https://learn.microsoft.com/en-us/azure/batch/batch-docker-container-workloads",
			"https://learn.microsoft.com/en-us/azure/storage/blobs/storage-quickstart-blobs-portal",
			"https://learn.microsoft.com/en-us/azure/batch/batch-aad-auth",
		],
	},
	AKAMAI_VM: {
		prefix: "akamai",
		links: [
			"https://docs.docker.com/docker-hub/repos/manage/access/",
			"https://techdocs.akamai.com/cloud-computing/docs/getting-started",
			"https://techdocs.akamai.com/cloud-computing/docs/object-storage",
			"https://techdocs.akamai.com/linode-api/reference/get-started",
		],
	},
} as const;

const imageBuild = `docker buildx build --platform linux/amd64 -f Dockerfile \
  -t <REGISTRY_PATH>:base --push .
# <BASE_DIGEST>: sha256 digest copied from the published base image
docker buildx build --platform linux/amd64 -f Dockerfile.vmaf-cloud \
  --build-arg WORKER_IMAGE=<REGISTRY_PATH>@sha256:<BASE_DIGEST> \
  -t <REGISTRY_PATH>:vmaf --push .`;

/** Preparation is informational: no upload, provisioning or connection request. */
export function CloudSetupGuide({ provider }: { provider: Provider }) {
	const { t } = useT();
	const guide = guides[provider];
	return (
		<section className="space-y-4">
			<div>
				<h3 className="font-medium text-sm">{t("vmafSetup.preparation")}</h3>
				<p className="mt-1 text-sm text-zinc-400">
					{t("vmafSetup.preparationHint")}
				</p>
			</div>
			<ol className="space-y-4">
				{(["Image", "Compute", "Storage", "Auth"] as const).map((part, i) => (
					<li key={part}>
						<details
							open={i === 0}
							className="space-y-2 border-zinc-800 border-l-2 pl-3"
						>
							<summary className="cursor-pointer font-medium text-sm">
								{t(`vmafSetup.${guide.prefix}${part}Title`)}
							</summary>
							<p className="text-sm text-zinc-400 leading-relaxed">
								{t(`vmafSetup.${guide.prefix}${part}Body`)}
							</p>
							<a
								className="text-xs text-zinc-300 underline underline-offset-4"
								href={guide.links[i]}
								target="_blank"
								rel="noopener noreferrer"
							>
								{t("vmafSetup.officialInstructions")}
							</a>
						</details>
					</li>
				))}
			</ol>
			<details className="rounded-md border border-zinc-800 p-3">
				<summary className="cursor-pointer text-sm">
					{t("vmafSetup.buildTitle")}
				</summary>
				<p className="my-3 text-sm text-zinc-400">{t("vmafSetup.buildHelp")}</p>
				<pre className="overflow-x-auto rounded bg-zinc-950 p-3 text-xs">
					<code>{imageBuild}</code>
				</pre>
			</details>
			<div className="space-y-2">
				<p className="text-sm text-zinc-400">{t("vmafSetup.identityHelp")}</p>
				<a
					href="/settings/vmaf#cloud-credentials"
					target="_blank"
					rel="noopener noreferrer"
					className="text-sm text-zinc-200 underline underline-offset-4"
				>
					{t("vmafSetup.credentialsLink")}
				</a>
			</div>
			<p className="text-xs text-zinc-400">{t("vmafSetup.exampleHint")}</p>
		</section>
	);
}

const common: Record<string, { example: string; helpKey: MessageKey }> = {
	label: { example: "VMAF test", helpKey: "vmafSetup.labelHelp" },
	id: { example: "vmaf-test", helpKey: "vmafSetup.idHelp" },
	jobQueue: { example: "vmaf", helpKey: "vmafSetup.queueHelp" },
	jobDefinition: {
		example: "vmaf:1",
		helpKey: "vmafSetup.definitionHelp",
	},
	project: { example: "your-project-id", helpKey: "vmafSetup.projectHelp" },
	serviceAccount: {
		example: "vmaf-task@your-project-id.iam.gserviceaccount.com",
		helpKey: "vmafSetup.serviceAccountHelp",
	},
	accountUrl: {
		example: "https://your-account.eastus.batch.azure.com",
		helpKey: "vmafSetup.accountUrlHelp",
	},
	poolId: { example: "vmaf-linux", helpKey: "vmafSetup.poolHelp" },
	bootImage: { example: "linode/ubuntu24.04", helpKey: "vmafSetup.bootHelp" },
	bucket: {
		example: "your-unique-vmaf-work-bucket",
		helpKey: "vmafSetup.bucketHelp",
	},
	container: { example: "vmaf-work", helpKey: "vmafSetup.containerHelp" },
	endpoint: {
		example: "https://us-east-1.linodeobjects.com",
		helpKey: "vmafSetup.endpointHelp",
	},
	storageAccountUrl: {
		example: "https://youraccount.blob.core.windows.net",
		helpKey: "vmafSetup.blobHelp",
	},
	computeCredentialId: { example: "", helpKey: "vmafSetup.computeAuthHelp" },
	stagingCredentialId: { example: "", helpKey: "vmafSetup.storageAuthHelp" },
	timeoutSeconds: { example: "1800", helpKey: "vmafSetup.runHelp" },
	queueTimeoutSeconds: { example: "900", helpKey: "vmafSetup.queueTimeHelp" },
	maxCostUsdPerHour: { example: "", helpKey: "vmafSetup.hourlyHelp" },
	transferUsdPerGiB: { example: "", helpKey: "vmafSetup.costTransferHelp" },
	overheadUsd: { example: "", helpKey: "vmafSetup.overheadHelp" },
	maxStagingGiB: { example: "50", helpKey: "vmafSetup.stagingHelp" },
};
const examples = {
	AWS_BATCH: {
		region: "us-east-1",
		image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/vmaf@sha256:…",
	},
	GCP_BATCH: {
		region: "us-central1",
		image: "us-central1-docker.pkg.dev/your-project-id/vmaf/vmaf@sha256:…",
	},
	AZURE_BATCH: {
		region: "eastus",
		image: "yourregistry.azurecr.io/vmaf@sha256:…",
	},
	AKAMAI_VM: {
		region: "us-east",
		image: "docker.io/your-org/vmaf@sha256:…",
	},
} as const;

export function getCloudFieldHelp(
	provider: Provider,
	key: string,
): { example: string; helpKey: MessageKey } | undefined {
	if (key === "region")
		return {
			example: examples[provider].region,
			helpKey: "vmafSetup.regionHelp",
		};
	if (key === "storageRegion")
		return { example: "us-east-1", helpKey: "vmafSetup.regionHelp" };
	if (key === "image")
		return {
			example: examples[provider].image,
			helpKey: "vmafSetup.imageHelp",
		};
	return common[key];
}
