import {
	assertStorageEndpointAllowed,
	bucketAddressing,
	type CredentialProviderId,
} from "@bitovp/core";
import { createAzureBrowser } from "./azure";
import { createGcsBrowser } from "./gcs";
import { createS3Browser } from "./s3";
import { type ObjectStorageBrowser, UnsupportedBrowseError } from "./types";

export type BrowserCredential = {
	provider: CredentialProviderId;
	/** Non-secret config as stored on the Credential row. */
	config: Record<string, unknown>;
	/** Decrypted secret material (JSON-parsed). Server-side only. */
	secret: Record<string, string>;
};

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function accessKeyPair(secret: Record<string, string>) {
	return {
		accessKeyId: secret.accessKeyId ?? "",
		secretAccessKey: secret.secretAccessKey ?? "",
	};
}

/**
 * Endpoint/region/addressing for the S3-speaking providers, shared with the
 * public playback-URL builder so browsing and playback can never disagree
 * about where a bucket lives (`packages/core/src/credentials/addressing.ts`).
 * Browsing keeps its historical permissiveness and ignores `missing`: the
 * fields are `min(1)`-required by the credential schemas, and an SDK request
 * against a placeholder host fails on its own with a clearer network error
 * than a driver-level throw would give.
 */
function s3Options(
	provider: CredentialProviderId,
	config: Record<string, unknown>,
	credentials: { accessKeyId: string; secretAccessKey: string },
) {
	const addressing = bucketAddressing(provider, config);
	if (!addressing) {
		throw new UnsupportedBrowseError(`${provider} holds no browsable buckets`);
	}
	return {
		credentials,
		region: addressing.region,
		// AWS derives its own regional endpoint; passing it explicitly would
		// also pin the addressing style.
		...(addressing.awsManaged
			? {}
			: {
					endpoint: addressing.origin,
					forcePathStyle: addressing.pathStyle,
				}),
	};
}

export type BrowserFactoryOptions = {
	/** Readiness-only SDK request timeout + no automatic retry; not a hard I/O deadline. */
	readTimeoutMs?: number;
	/**
	 * : the STORAGE_ENDPOINT_ALLOWED_HOSTS rail for GENERIC_S3 —
	 * the one provider whose endpoint is a free field. `undefined` =
	 * unconfigured (unrestricted, warned); a listed host must match.
	 * The other providers' hosts are derived or schema-anchored.
	 */
	endpointAllowlist?: readonly string[] | undefined;
	onWarning?: (message: string) => void;
};

/*
 * There used to be a `withoutBucketEnumeration` wrapper here, and two
 * constants explaining why Akamai Object Storage and GCS-HMAC "cannot"
 * enumerate buckets — one citing a 403 under both signing regions, the other a
 * structural project-id requirement. Both explanations were wrong, and both
 * were written as vendor facts.
 *
 * The real cause was one query parameter WE sent (`?x-id=<Operation>`, added by
 * aws-sdk-js) which both stores refuse on the SERVICE-LEVEL request. Stripping
 * it in `s3.ts` makes both list their buckets, measured against the real
 * credentials. Note what is NOT known: the same parameter rides GetObject and
 * PutObject and those succeed, so this is not a blanket canonicalisation bug —
 * see the note in `s3.ts` and .
 *
 * The lesson is the standing rule, and it took an owner asking "couldn't the
 * Linode CLI do this?" to apply it: on an API error, suspect our own request
 * construction before the vendor, and settle it with an implementation we did
 * not write. The AWS CLI and s3cmd both listed the buckets our client got a 403
 * on, with the same keys against the same endpoint.
 */

/** Maps a vault credential to a browsing driver (ARCHITECTURE §5 table). */
export function createBrowserForCredential(
	credential: BrowserCredential,
	options: BrowserFactoryOptions = {},
): ObjectStorageBrowser {
	const { provider, config, secret } = credential;
	switch (provider) {
		case "AWS_S3":
		case "AKAMAI_OBJECT_STORAGE":
		// OCI S3-compat requires path-style addressing (C10).
		case "OCI_OBJECT_STORAGE":
		// GENERIC_S3 browsing always signs V4 (aws-sdk v3 has no V2 signer);
		// the credential's signatureVersion=S3_V2 applies to Bitmovin I/O only.
		case "GENERIC_S3": {
			if (provider === "GENERIC_S3") {
				assertStorageEndpointAllowed(
					str(config.host),
					options.endpointAllowlist,
					options.onWarning ?? (() => {}),
				);
			}
			const browser = createS3Browser({
				...s3Options(provider, config, accessKeyPair(secret)),
				readTimeoutMs: options.readTimeoutMs,
			});
			return browser;
		}
		case "GCS_HMAC":
			// GCS XML interop endpoint speaks S3 with HMAC keys. It used to be
			// wrapped in a bucket-enumeration refusal too; that refusal was the
			// `x-id` defect misread as a protocol limitation (see s3.ts).
			return createS3Browser({
				...s3Options(provider, config, {
					accessKeyId: secret.accessKey ?? "",
					secretAccessKey: secret.secret ?? "",
				}),
				readTimeoutMs: options.readTimeoutMs,
				rangeChecksumsAreWholeObject: true,
			});
		case "GCS_SERVICE_ACCOUNT":
			return createGcsBrowser(
				secret.serviceAccountJson ?? "",
				options.readTimeoutMs,
			);
		case "AWS_S3_ROLE_BASED":
			throw new UnsupportedBrowseError(
				"Role-based credentials need an STS broker — browsing lands in P2; use a key-based credential to browse",
			);
		case "AZURE_BLOB":
			return createAzureBrowser({
				accountName: str(config.accountName),
				accountKey: secret.accountKey ?? "",
				readTimeoutMs: options.readTimeoutMs,
			});
		case "SFTP":
			throw new UnsupportedBrowseError(
				"SFTP credentials are encoding outputs only — no object browsing",
			);
		case "DRM_CENC":
		case "DRM_SPEKE":
		case "NEXGUARD":
			throw new UnsupportedBrowseError(
				"DRM/watermarking credentials hold key material — nothing to browse",
			);
		case "SRT_PASSPHRASE":
		case "ZIXI":
			throw new UnsupportedBrowseError(
				"Live ingest credentials hold connection secrets — nothing to browse",
			);
		case "POIS_ENDPOINT":
			throw new UnsupportedBrowseError(
				"POIS (ESAM) credentials hold endpoint basic-auth — nothing to browse",
			);
		case "KANTAR":
			throw new UnsupportedBrowseError(
				"Kantar credentials hold a service login — nothing to browse",
			);
		case "NOTIFICATION_WEBHOOK":
			throw new UnsupportedBrowseError(
				"Notification webhooks hold a delivery URL — nothing to browse",
			);
		case "LIVE_MEDIA_INGEST":
		case "AKAMAI_MSL":
			// . A provisioned live stream, not a container: nothing
			// to list, and no path to enter either.
			throw new UnsupportedBrowseError(
				"Akamai MSL is a live delivery stream, not object storage — there is nothing to browse",
			);
		case "AKAMAI_NETSTORAGE":
			// . NetStorage speaks its own HTTP API (and rsync/ssh),
			// not S3, so no driver here can list it — the same honest refusal
			// SFTP gets. Note this is NOT `AKAMAI_OBJECT_STORAGE`, which IS
			// browsable through the S3 driver (C10); a reader who conflates the
			// two Akamai products will expect browsing to work.
			throw new UnsupportedBrowseError(
				"Akamai NetStorage is not an S3-compatible store — enter the path manually",
			);
		default: {
			const exhaustive: never = provider;
			throw new UnsupportedBrowseError(`Unknown provider ${exhaustive}`);
		}
	}
}
