import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
	assertStorageEndpointAllowed,
	bucketAddressing,
	type CredentialProviderId,
	planInputSchema,
} from "@bitovp/core";
import type { ExecutorContext } from "../executor";

/** Generated immediately before filter creation; never persisted in a plan or step log.
 * Seven days accommodates provider queueing. S3-compatible signatures use the same
 * addressing contract as the storage browser. No object is fetched by this worker.
 */
export async function signWatermarkImage(
	raw: unknown,
	path: string,
	resolve: ExecutorContext["resolveCredential"],
): Promise<string> {
	const input = planInputSchema.parse(raw);
	if (
		input.kind !== "S3" &&
		input.kind !== "GENERIC_S3" &&
		input.kind !== "GCS"
	)
		throw new Error("Unsupported watermark input");
	const credential = await resolve(input.credentialId);
	const supported =
		input.kind === "S3"
			? ["AWS_S3"]
			: input.kind === "GCS"
				? ["GCS_HMAC"]
				: ["GENERIC_S3", "AKAMAI_OBJECT_STORAGE", "OCI_OBJECT_STORAGE"];
	if (!supported.includes(credential.provider))
		throw new Error("Watermark input credential does not match input type");
	const address = bucketAddressing(
		credential.provider as CredentialProviderId,
		credential.config,
	);
	if (!address || address.missing || !address.origin.startsWith("https://"))
		throw new Error("Watermark requires a configured HTTPS storage endpoint");
	if (credential.provider === "GENERIC_S3")
		assertStorageEndpointAllowed(
			String(credential.config.host ?? ""),
			process.env.STORAGE_ENDPOINT_ALLOWED_HOSTS?.split(",")
				.map((v) => v.trim())
				.filter(Boolean),
			() => {},
		);
	const accessKeyId =
		credential.provider === "GCS_HMAC"
			? credential.secret.accessKey
			: credential.secret.accessKeyId;
	const secretAccessKey =
		credential.provider === "GCS_HMAC"
			? credential.secret.secret
			: credential.secret.secretAccessKey;
	if (!accessKeyId || !secretAccessKey)
		throw new Error("Watermark input credential is incomplete");
	const client = new S3Client({
		region: address.region,
		...(address.awsManaged
			? {}
			: { endpoint: address.origin, forcePathStyle: address.pathStyle }),
		credentials: { accessKeyId, secretAccessKey },
		requestChecksumCalculation: "WHEN_REQUIRED",
		responseChecksumValidation: "WHEN_REQUIRED",
	});
	try {
		return await getSignedUrl(
			client,
			new GetObjectCommand({
				Bucket: input.bucket,
				Key: path.replace(/^\/+/, ""),
			}),
			{ expiresIn: 604800 },
		);
	} catch {
		throw new Error("Watermark image signing failed");
	} finally {
		client.destroy();
	}
}
