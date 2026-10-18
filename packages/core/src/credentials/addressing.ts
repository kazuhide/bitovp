import {
	AKAMAI_HOST_SUFFIX,
	type CredentialProviderId,
	ociCompatHost,
} from "./schemas";

/**
 * Where a storage credential's buckets live on the network.
 *
 * Two consumers need this and must not disagree: the browsing driver
 * (`packages/storage/src/factory.ts`, which hands an endpoint to an SDK) and
 * the public playback-URL builder (`playback/public-url.ts`, which needs the
 * origin objects are actually *served* from). Implemented twice they drift,
 * and the failure mode is specific and confusing — the storage browser lists
 * an object and the player 404s on it, for exactly one provider.
 *
 * This is addressing only. It says nothing about whether a bucket is public,
 * whether the credential can be browsed, or whether CORS allows a fetch.
 */
export type BucketAddressing = {
	/** Origin — scheme + host (+ port) — that serves this credential's buckets. */
	origin: string;
	/**
	 * `{origin}/{bucket}/{key}` addressing. When false the bucket is a
	 * subdomain instead: `{scheme}://{bucket}.{host}/{key}`.
	 */
	pathStyle: boolean;
	/** SigV4 signing region; "" for providers that do not sign with one. */
	region: string;
	/**
	 * True when `origin` is AWS's own regional endpoint. The AWS SDK derives
	 * that endpoint from `region` by itself, and passing it explicitly also
	 * pins the addressing style — so the browsing driver omits it.
	 */
	awsManaged: boolean;
	/**
	 * Name of the config field `origin` needs but this credential does not
	 * carry, else null. Every such field is `min(1)`-required by
	 * `CREDENTIAL_PROVIDER_SHAPES`, so a row missing one was written around the
	 * form. Browsing keeps its historical permissive behaviour and ignores
	 * this; a user-visible URL must not be built on the placeholder, so the
	 * public-URL builder refuses instead.
	 */
	missing: string | null;
};

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Akamai signing region is the cluster id encoded in the host
 * (jp-osa-1.linodeobjects.com → jp-osa-1). Defensive against
 * bucket-qualified hosts: only the label adjacent to the suffix counts.
 */
export function akamaiRegionFromHost(host: string): string {
	if (!host.endsWith(AKAMAI_HOST_SUFFIX)) {
		return "us-east-1";
	}
	const labels = host.slice(0, -AKAMAI_HOST_SUFFIX.length).split(".");
	return labels[labels.length - 1] || "us-east-1";
}

/**
 * Resolves the HTTP addressing for an object-storage credential, or null for
 * providers that hold no buckets at all (SFTP, DRM, live-ingest secrets).
 */
export function bucketAddressing(
	provider: CredentialProviderId,
	config: Record<string, unknown>,
): BucketAddressing | null {
	switch (provider) {
		case "AWS_S3":
		case "AWS_S3_ROLE_BASED": {
			const region = str(config.region, "us-east-1");
			return {
				origin: `https://s3.${region}.amazonaws.com`,
				pathStyle: false,
				region,
				awsManaged: true,
				missing: str(config.region) ? null : "region",
			};
		}
		case "AKAMAI_OBJECT_STORAGE": {
			const host = str(config.host);
			return {
				origin: `https://${host}`,
				pathStyle: true,
				region: akamaiRegionFromHost(host),
				awsManaged: false,
				missing: host ? null : "host",
			};
		}
		case "OCI_OBJECT_STORAGE": {
			const namespace = str(config.namespace);
			const region = str(config.region);
			return {
				// OCI S3-compat requires path-style addressing (C10).
				origin: `https://${ociCompatHost(namespace, region)}`,
				pathStyle: true,
				region,
				awsManaged: false,
				missing: namespace ? (region ? null : "region") : "namespace",
			};
		}
		case "GENERIC_S3": {
			const host = str(config.host);
			const port = typeof config.port === "number" ? `:${config.port}` : "";
			const scheme = config.ssl === false ? "http" : "https";
			return {
				origin: `${scheme}://${host}${port}`,
				pathStyle: true,
				// GENERIC_S3 carries no region: browsing signs V4 with us-east-1
				// (aws-sdk v3 has no V2 signer; the credential's signatureVersion
				// applies to Bitmovin I/O only).
				region: str(config.region, "us-east-1"),
				awsManaged: false,
				missing: host ? null : "host",
			};
		}
		case "GCS_HMAC":
		case "GCS_SERVICE_ACCOUNT":
			return {
				// The XML interop endpoint speaks S3 with HMAC keys and serves
				// public objects at the same path-style URL — which also sidesteps
				// dotted-bucket TLS entirely.
				origin: "https://storage.googleapis.com",
				pathStyle: true,
				region: "auto",
				awsManaged: false,
				missing: null,
			};
		case "AZURE_BLOB": {
			const account = str(config.accountName);
			return {
				origin: `https://${account}.blob.core.windows.net`,
				pathStyle: true,
				region: "",
				awsManaged: false,
				missing: account ? null : "accountName",
			};
		}
		case "SFTP":
		// . A NetStorage upload account holds no buckets to address:
		// the account IS the container, and paths hang off the CP code
		// directory it is scoped to. Grouped with SFTP for that reason, not
		// with AKAMAI_OBJECT_STORAGE, which is the S3-compatible service.
		case "AKAMAI_NETSTORAGE":
		// . MSL addresses a provisioned STREAM, not a container:
		// there is no bucket, no path and no object to browse — only a
		// streamId and an event name.
		case "AKAMAI_MSL":
		case "LIVE_MEDIA_INGEST":
		case "DRM_CENC":
		case "DRM_SPEKE":
		case "NEXGUARD":
		case "SRT_PASSPHRASE":
		case "ZIXI":
		case "POIS_ENDPOINT":
		case "KANTAR":
		case "NOTIFICATION_WEBHOOK":
			return null;
		default: {
			const exhaustive: never = provider;
			throw new Error(`Unknown credential provider ${exhaustive}`);
		}
	}
}
