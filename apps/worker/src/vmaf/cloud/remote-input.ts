import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ResolvedCredential } from "../../orchestrator/executor";
import type { DownloadProvenance } from "../download";

/** Server-generated capability; never accepted from a report/API request. */
export type CloudRemoteInput = { url: string; sha256: string; bytes: number };

export function validateCloudRemoteInput(
	input: CloudRemoteInput,
	local: { sha256: string; bytes: number },
): void {
	const url = new URL(input.url);
	if (
		url.protocol !== "https:" ||
		url.hostname !== "storage.googleapis.com" ||
		url.port ||
		url.username ||
		url.password ||
		url.hash ||
		!url.searchParams.has("X-Amz-Signature") ||
		input.sha256 !== local.sha256 ||
		input.bytes !== local.bytes
	)
		throw new Error("VMAF remote input does not match verified local media");
}

/** Reuses GCS HMAC read permission without copying multi-hour inputs to staging.
 * The cloud worker checks the full SHA-256 before scoring; no version pin is
 * claimed for this URL, so an overwrite fails closed instead of scoring it.
 */
export async function signGcsVmafInput(
	credential: ResolvedCredential,
	provenance: DownloadProvenance,
	expiresInSeconds: number,
): Promise<CloudRemoteInput | undefined> {
	if (credential.provider !== "GCS_HMAC") return undefined;
	if (
		!Number.isSafeInteger(expiresInSeconds) ||
		expiresInSeconds < 1 ||
		expiresInSeconds > 604800
	)
		throw new Error("Invalid VMAF remote input URL lifetime");
	if (
		!credential.secret.accessKey ||
		!credential.secret.secret ||
		!/^[a-f0-9]{64}$/.test(provenance.sha256) ||
		!Number.isSafeInteger(provenance.bytes) ||
		provenance.bytes < 0
	)
		throw new Error("Invalid VMAF remote input identity");
	const client = new S3Client({
		endpoint: "https://storage.googleapis.com",
		region: "auto",
		forcePathStyle: true,
		credentials: {
			accessKeyId: credential.secret.accessKey,
			secretAccessKey: credential.secret.secret,
		},
		requestChecksumCalculation: "WHEN_REQUIRED",
		responseChecksumValidation: "WHEN_REQUIRED",
	});
	try {
		const url = await getSignedUrl(
			client,
			new GetObjectCommand({ Bucket: provenance.bucket, Key: provenance.key }),
			{ expiresIn: expiresInSeconds },
		);
		const input = { url, sha256: provenance.sha256, bytes: provenance.bytes };
		validateCloudRemoteInput(input, provenance);
		return input;
	} finally {
		client.destroy();
	}
}
