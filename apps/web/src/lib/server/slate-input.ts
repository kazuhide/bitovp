import "server-only";
import type BitmovinApi from "@bitmovin/api-sdk";
import {
	AzureInput,
	GcsInput,
	GenericS3Input,
	S3Input,
	S3SignatureVersion,
} from "@bitmovin/api-sdk";
import { ociCompatHost, SLATE_SUPPORTED_PROVIDERS } from "@bitovp/core";
import type { ServerContext } from "./context";

/**
 * Mint the Bitmovin INPUT a picked slate object is downloaded from (WP-A1).
 *
 * The web mirror of the worker's `slate-register.ts` `createSourceInput` —
 * same provider table, same secret fields, same GenericS3 endpoint rules as
 * `ops/exec-shared.ts` `genericS3Endpoint` (Akamai is HTTPS on 443 unless the
 * credential says otherwise; OCI derives its S3-compat host from
 * namespace+region, C10; GENERIC_S3 carries host/port/ssl/signatureVersion on
 * its config). Kept as a table here rather than importing the worker: the
 * worker's version speaks through its audited SDK facade, which this app
 * does not load. The two are pinned against each other by
 * `slate-input.test.ts`'s per-provider wire params.
 *
 * Account-scoped and deliberately re-created on every registration (ledger
 * #38's documented trade): a duplicate input is inert, and adopting by name
 * would need a list the direct path has no reason to pay for.
 *
 * NEVER audited with the secret: the caller snapshots `{name, bucket,
 * provider}` only. A missing secret field refuses BY NAME instead of sending
 * empty credentials and letting Bitmovin's 4xx name the problem.
 */

export type SlateInputPlan =
	| {
			ok: true;
			provider: string;
			/** The Bitmovin API path the create hits — the audit key. */
			path: string;
			create: (api: BitmovinApi) => Promise<string>;
	  }
	| { ok: false; reason: string };

function requireSecret(
	secret: Record<string, string>,
	field: string,
	label: string,
): string | { missing: string } {
	const value = secret[field];
	return value ? value : { missing: `${label} credential carries no ${field}` };
}

function idOf(result: { id?: string }): string {
	if (typeof result.id !== "string" || result.id.length === 0) {
		throw new Error("Bitmovin returned an input without an id");
	}
	return result.id;
}

/** Wire-level parameters per provider, exposed for the pin test. */
export function planSlateInput(
	credential: {
		provider: string;
		config: Record<string, unknown>;
		secret: Record<string, string>;
	},
	bucket: string,
	name: string,
): SlateInputPlan {
	const { provider, config, secret } = credential;
	const str = (value: unknown) =>
		typeof value === "string" && value.length > 0 ? value : undefined;
	switch (provider) {
		case "AWS_S3": {
			const accessKey = requireSecret(secret, "accessKeyId", "S3");
			const secretKey = requireSecret(secret, "secretAccessKey", "S3");
			if (typeof accessKey !== "string")
				return { ok: false, reason: accessKey.missing };
			if (typeof secretKey !== "string")
				return { ok: false, reason: secretKey.missing };
			return {
				ok: true,
				provider,
				path: "/encoding/inputs/s3",
				create: async (api) =>
					idOf(
						await api.encoding.inputs.s3.create(
							new S3Input({ name, bucketName: bucket, accessKey, secretKey }),
						),
					),
			};
		}
		case "GENERIC_S3":
		case "AKAMAI_OBJECT_STORAGE":
		case "OCI_OBJECT_STORAGE": {
			const accessKey = requireSecret(secret, "accessKeyId", "Generic S3");
			const secretKey = requireSecret(secret, "secretAccessKey", "Generic S3");
			if (typeof accessKey !== "string")
				return { ok: false, reason: accessKey.missing };
			if (typeof secretKey !== "string")
				return { ok: false, reason: secretKey.missing };
			let endpoint: {
				host: string;
				port?: number;
				ssl?: boolean;
				signatureVersion: S3SignatureVersion;
			};
			if (provider === "OCI_OBJECT_STORAGE") {
				const namespace = str(config.namespace);
				const region = str(config.region);
				if (!namespace || !region) {
					return {
						ok: false,
						reason: "OCI credential is missing namespace/region",
					};
				}
				endpoint = {
					host: ociCompatHost(namespace, region),
					signatureVersion: S3SignatureVersion.V4,
				};
			} else {
				const host = str(config.host);
				if (!host) {
					return {
						ok: false,
						reason: `${provider} credential is missing host`,
					};
				}
				const port = typeof config.port === "number" ? config.port : undefined;
				const ssl = typeof config.ssl === "boolean" ? config.ssl : undefined;
				endpoint =
					provider === "AKAMAI_OBJECT_STORAGE"
						? {
								host,
								port: port ?? 443,
								ssl: ssl ?? true,
								signatureVersion: S3SignatureVersion.V4,
							}
						: {
								host,
								...(port !== undefined ? { port } : {}),
								...(ssl !== undefined ? { ssl } : {}),
								signatureVersion:
									config.signatureVersion === "S3_V2"
										? S3SignatureVersion.V2
										: S3SignatureVersion.V4,
							};
			}
			return {
				ok: true,
				provider,
				path: "/encoding/inputs/generic-s3",
				create: async (api) =>
					idOf(
						await api.encoding.inputs.genericS3.create(
							new GenericS3Input({
								name,
								bucketName: bucket,
								...endpoint,
								accessKey,
								secretKey,
							}),
						),
					),
			};
		}
		case "GCS_HMAC": {
			const accessKey = requireSecret(secret, "accessKey", "GCS HMAC");
			const secretKey = requireSecret(secret, "secret", "GCS HMAC");
			if (typeof accessKey !== "string")
				return { ok: false, reason: accessKey.missing };
			if (typeof secretKey !== "string")
				return { ok: false, reason: secretKey.missing };
			return {
				ok: true,
				provider,
				path: "/encoding/inputs/gcs",
				create: async (api) =>
					idOf(
						await api.encoding.inputs.gcs.create(
							new GcsInput({ name, bucketName: bucket, accessKey, secretKey }),
						),
					),
			};
		}
		case "AZURE_BLOB": {
			const accountName = str(config.accountName);
			if (!accountName) {
				return { ok: false, reason: "Azure credential carries no accountName" };
			}
			const accountKey = requireSecret(secret, "accountKey", "Azure");
			if (typeof accountKey !== "string")
				return { ok: false, reason: accountKey.missing };
			return {
				ok: true,
				provider,
				path: "/encoding/inputs/azure",
				create: async (api) =>
					idOf(
						await api.encoding.inputs.azure.create(
							new AzureInput({
								name,
								container: bucket,
								accountName,
								accountKey,
							}),
						),
					),
			};
		}
		default:
			return {
				ok: false,
				reason: `slate source provider ${provider} is not supported for insertable content (supported: ${SLATE_SUPPORTED_PROVIDERS.join(", ")})`,
			};
	}
}

/** Resolve the vaulted credential (decrypting its secret) and plan the input. */
export async function planSlateInputForCredential(
	ctx: ServerContext,
	credentialId: string,
	bucket: string,
	name: string,
): Promise<SlateInputPlan | null> {
	const credential = await ctx.credentials.get(credentialId);
	if (!credential) {
		return null;
	}
	const secretJson = await ctx.credentials.revealSecret(credentialId);
	let secret: Record<string, string>;
	try {
		secret = JSON.parse(secretJson) as Record<string, string>;
	} catch {
		// Constant message: V8 SyntaxErrors embed input snippets and routeError
		// logs messages (secrets redacted in logs).
		throw new Error("Stored secret payload is corrupted");
	}
	return planSlateInput(
		{
			provider: credential.provider,
			config: (credential.config ?? {}) as Record<string, unknown>,
			secret,
		},
		bucket,
		name,
	);
}
