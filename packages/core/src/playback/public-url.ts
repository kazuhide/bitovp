import { bucketAddressing } from "../credentials/addressing";
import {
	BASE_URL_HINT,
	normalizeBaseUrl,
	readPublicBaseUrls,
} from "../credentials/public-base-urls";
import type { CredentialProviderId } from "../credentials/schemas";
import type { Acl } from "../plan/schema";

/**
 * Public playback URL derivation .
 *
 * The order is fixed and short:
 *
 *   1. `publicBaseUrls[bucket]` is set → `{base}/{path}`. Wins unconditionally.
 *   2. the destination is `PUBLIC_READ` and the provider has a deterministic
 *      public URL shape → derive it .
 *   3. otherwise → no URL, and a *named* reason. Never a bare null: "why can
 *      I not play this" is the question the panel exists to answer.
 *
 * Only the credential's non-secret config is read. Nothing here signs, so no
 * URL this returns works against a private bucket — a private output is a
 * `NOT_PUBLIC` reason, never a link that 403s.
 */

export type PublicUrlCredential = {
	provider: CredentialProviderId;
	/** Non-secret config as stored on the Credential row. */
	config: Record<string, unknown>;
};

/**
 * Why a URL is missing or untrustworthy — as *data*, not prose. Each variant
 * is one distinct remedy, and carries whatever the remedy names (the config
 * field, the bucket). The UI renders it through the message catalogue, so this
 * type is the reason the panel can explain itself in Japanese;
 * `describePublicUrlReason` is the English rendering for logs and tests.
 */
export type PublicUrlReason =
	/** The output's credential row was not found (deleted, or not loaded). */
	| { code: "NO_CREDENTIAL" }
	/** No `publicBaseUrls` entry and the destination is not `PUBLIC_READ`. */
	| { code: "NOT_PUBLIC" }
	/** This provider's public URL shape is not derivable — declare it instead. */
	| {
			code: "NO_PATTERN";
			provider: "AZURE_BLOB" | "OCI_OBJECT_STORAGE" | "SFTP" | "OTHER";
	  }
	/** The credential lacks a config field the pattern is built from. */
	| { code: "MISSING_CONFIG"; field: string }
	/** `publicBaseUrls[bucket]` exists but is not a usable base. */
	| { code: "MISSING_BASE_URL"; bucket: string }
	/** Derived an `http://` URL: a https page blocks it as mixed content. */
	| { code: "INSECURE_ENDPOINT" }
	/**
	 * An `AKAMAI_MSL` output whose credential carries no `edgeBaseUrl`. The
	 * remedy is one field on one credential, so the reason names the row.
	 */
	| { code: "MSL_EDGE_URL_NOT_CONFIGURED"; credentialId: string };

export type PublicUrlReasonCode = PublicUrlReason["code"];

export type PublicUrlResult = {
	/** Absolute URL when one could be built, else null. */
	url: string | null;
	/**
	 * How `url` was obtained. `credential-edge` is the MSL case: the Akamai
	 * delivery root declared on the credential plus the manifest name — the
	 * viewer's edge, which says nothing about whether the encoder is publishing.
	 */
	via: "publicBaseUrls" | "derived" | "credential-edge" | "none";
	/**
	 * Why playback cannot be trusted. Present whenever `url` is null, and also
	 * alongside a non-null `url` that a browser may refuse (`INSECURE_ENDPOINT`)
	 * — the URL stays copyable because curl does not care.
	 */
	reason?: PublicUrlReason;
};

/** English rendering of a reason — for logs, tests, and non-UI callers. */
export function describePublicUrlReason(reason: PublicUrlReason): string {
	switch (reason.code) {
		case "NO_CREDENTIAL":
			return "The credential this output writes through is not available, so its public host is unknown.";
		case "NOT_PUBLIC":
			return "The destination is private (no PUBLIC_READ ACL). Re-run with a public-read destination, or declare the public base in publicBaseUrls.";
		case "NO_PATTERN":
			switch (reason.provider) {
				case "AZURE_BLOB":
					return "Azure has no per-blob ACL — anonymous access is a container-level setting, so a plan can never tell us the container is public. Declare it in publicBaseUrls.";
				case "OCI_OBJECT_STORAGE":
					return "OCI's S3-compatibility endpoint requires authentication even for objects with public access; the anonymous path is the native API or a Pre-Authenticated Request. Declare the base in publicBaseUrls.";
				case "SFTP":
					return "SFTP outputs are not served over HTTP — copy the path into whatever origin fronts them.";
				default:
					return "This credential holds no HTTP-addressable buckets, so no playback URL exists.";
			}
		case "MISSING_CONFIG":
			return `The credential carries no ${reason.field}, which its public URL is built from.`;
		case "MISSING_BASE_URL":
			return `publicBaseUrls["${reason.bucket}"] is not usable. ${BASE_URL_HINT}`;
		case "INSECURE_ENDPOINT":
			return "The output endpoint is http, not https — a page served over https blocks it as mixed content. Front the bucket with TLS and declare it in publicBaseUrls.";
		case "MSL_EDGE_URL_NOT_CONFIGURED":
			return `The Akamai MSL credential ${reason.credentialId} carries no edgeBaseUrl, so the delivery root this stream is served from is unknown. Register the Akamai edge base URL on that credential.`;
		default: {
			const exhaustive: never = reason;
			throw new Error(`Unknown reason ${JSON.stringify(exhaustive)}`);
		}
	}
}

/**
 * The declared base for a bucket, or undefined.
 *
 * `Object.hasOwn` rather than a bare index: `constructor` is a valid S3 bucket
 * name and every prototype key would otherwise resolve to something truthy.
 * `readPublicBaseUrls` returns a null-prototype map, so this is belt-and-braces
 * for a caller that hands over a plain object.
 */
export function declaredBaseFor(
	config: Record<string, unknown>,
	bucket: string,
): string | undefined {
	const map = readPublicBaseUrls(config);
	return Object.hasOwn(map, bucket) ? map[bucket] : undefined;
}

/** Percent-encodes each path segment, exactly as the S3 link builder did. */
function encodePath(key: string): string {
	return key.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

/** `https://s3.eu-1.amazonaws.com` + `b` → `https://b.s3.eu-1.amazonaws.com`. */
function withBucketHost(origin: string, bucket: string): string {
	const at = origin.indexOf("://");
	return `${origin.slice(0, at + 3)}${bucket}.${origin.slice(at + 3)}`;
}

function refuse(reason: PublicUrlReason): PublicUrlResult {
	return { url: null, via: "none", reason };
}

function built(url: string, via: PublicUrlResult["via"]): PublicUrlResult {
	return url.startsWith("http://")
		? { url, via, reason: { code: "INSECURE_ENDPOINT" } }
		: { url, via };
}

/** Providers whose public URL we refuse to guess. */
const NEVER_DERIVED = {
	AZURE_BLOB: "AZURE_BLOB",
	OCI_OBJECT_STORAGE: "OCI_OBJECT_STORAGE",
	SFTP: "SFTP",
} as const;

export type PublicObjectUrlArgs = {
	credential: PublicUrlCredential | undefined;
	/** Bucket, or container for Azure. Null for outputs that have neither. */
	bucket: string | null;
	/** Object key, relative to the bucket root. */
	key: string;
	/** The destination ACL from the plan; absent means private. */
	acl?: Acl | undefined;
};

/**
 * Object-level entry point: one credential + bucket + key → one URL or one
 * named reason. Everything else in this file is built on it.
 */
export function publicObjectUrl(args: PublicObjectUrlArgs): PublicUrlResult {
	const { credential, bucket, key, acl } = args;
	if (!credential) {
		return refuse({ code: "NO_CREDENTIAL" });
	}

	// 1. A declared base wins over everything, including a private ACL: the
	//    operator is telling us a CDN fronts this bucket, which is knowledge
	//    the plan does not contain.
	const declared = bucket
		? declaredBaseFor(credential.config, bucket)
		: undefined;
	if (declared !== undefined) {
		const base = normalizeBaseUrl(declared);
		return base
			? built(`${base}/${encodePath(key)}`, "publicBaseUrls")
			: refuse({ code: "MISSING_BASE_URL", bucket: bucket ?? "" });
	}

	// 2. Providers we refuse to guess for — checked before the ACL, because for
	//    these the ACL is not the thing standing in the way.
	const never =
		NEVER_DERIVED[credential.provider as keyof typeof NEVER_DERIVED];
	if (never) {
		return refuse({ code: "NO_PATTERN", provider: never });
	}
	const addressing = bucketAddressing(credential.provider, credential.config);
	if (!addressing || !bucket) {
		return refuse({ code: "NO_PATTERN", provider: "OTHER" });
	}

	if (acl !== "PUBLIC_READ") {
		return refuse({ code: "NOT_PUBLIC" });
	}
	if (addressing.missing) {
		return refuse({ code: "MISSING_CONFIG", field: addressing.missing });
	}

	// Dotted buckets break TLS on virtual-host URLs — use path-style.
	const pathStyle = addressing.pathStyle || bucket.includes(".");
	const origin = pathStyle
		? `${addressing.origin}/${bucket}`
		: withBucketHost(addressing.origin, bucket);
	return built(`${origin}/${encodePath(key)}`, "derived");
}

/**
 * The `AKAMAI_MSL` entry point (2026-09-02). MSL is Akamai's INGEST: the
 * encoding writes to a provisioned stream, not to a bucket, so no object URL
 * can be derived and `publicObjectUrl` answered `NO_PATTERN` for every MSL
 * channel. What a viewer loads is the Akamai property in front of the stream,
 * and Bitmovin never learns its hostname — only the operator does, from the
 * Akamai console — so it is registered on the credential as `edgeBaseUrl`
 * (the event root, no trailing slash) and this appends `/<manifestName>`.
 *
 * Only the manifest NAME rides along, not the plan's destination path: MSL
 * serves the event root, and the path the encoder was told to write to is
 * ingest-side (the measured MSL4 master is `<root>/stream.m3u8`).
 *
 * The URL is the viewer's EDGE, which is exactly what the panel should hand
 * out and exactly what it must not be mistaken for: a link that resolves says
 * nothing about whether the encoder is publishing. Observation of the edge is
 * the verifier's job, not this helper's.
 */
export function mslEdgeManifestUrl(args: {
	credential: ({ id: string } & PublicUrlCredential) | undefined;
	manifestName: string;
}): PublicUrlResult {
	const { credential, manifestName } = args;
	if (!credential) {
		return refuse({ code: "NO_CREDENTIAL" });
	}
	const declared = credential.config.edgeBaseUrl;
	if (typeof declared !== "string" || declared.trim() === "") {
		return refuse({
			code: "MSL_EDGE_URL_NOT_CONFIGURED",
			credentialId: credential.id,
		});
	}
	// The schema already refused a trailing slash at save; a row edited by
	// hand in Postgres is the one this strip exists for.
	const base = declared.trim().replace(/\/+$/, "");
	return built(`${base}/${encodePath(manifestName)}`, "credential-edge");
}
