/**
 * Unified object-storage browsing interface (ARCHITECTURE §5). One driver
 * per credential family; the same credential later powers Bitmovin
 * Input/Output creation, VMAF downloads, and live segment capture.
 */

export type StorageObject = {
	key: string;
	size: number;
	lastModified?: string;
};

export type ListObjectsInput = {
	bucket: string;
	prefix?: string;
	cursor?: string;
	/** Capped at 100 per page (constraint C6 mindset: always paginate). */
	limit?: number;
	/**
	 * Recursive listing: omit the `/` delimiter so objects nested ANY depth
	 * below `prefix` are returned in `objects` (folder-by-folder browsing leaves
	 * this false and returns child folders as `prefixes`). Used by the VMAF
	 * runner to find per-title `qc/<key>.mp4` mirrors under a placeholder-free
	 * prefix. When true, `prefixes` is empty.
	 */
	recursive?: boolean;
};

export type ListObjectsResult = {
	/** Virtual folders (CommonPrefixes equivalents), full prefix paths. */
	prefixes: string[];
	objects: StorageObject[];
	nextCursor?: string;
};

/**
 * A provider's name for ONE version of an object's bytes —
 * CRITICAL-2, slice 1.
 *
 * The defect this exists to make fixable: nothing in this package could name a
 * version, so nothing downstream could demand one. `StorageObject` carries key,
 * size and lastModified, all of which a same-size overwrite preserves, and every
 * `getObject` was an unconditional "whatever is there now". QC therefore scored
 * output(A) against source(B) after an overwrite and reported a plausible PASS.
 *
 * Every field is optional because the providers genuinely disagree about which
 * they have, and a required field would force a driver to invent one:
 *
 * - `etag` — S3 and Azure both return one. GCS returns an `etag` too, but it is
 * NOT its md5Hash/crc32c and must not be treated as a content digest.
 * - `versionId` — S3 only, and only on a version-enabled bucket.
 * - `generation` — GCS only. Carried as a string because that is how the API
 * returns it and how it round-trips through JSON and the database without a
 * lossy hop. NOT because the string survives to the wire: verified in
 * @google-cloud/storage 7.21.0 (file.js:612-621), the `File` constructor
 * does `Number(options.generation)`, so the one call that consumes it
 * coerces anyway. An earlier revision of this comment claimed the string
 * form guarded precision through to the request; it does not, and the
 * correction matters because the false version would have made a future
 * reader trust a guarantee nothing provides. No live risk today —
 * generations are microsecond timestamps, ~1.7e15 against a safe-integer
 * ceiling of ~9.0e15 — and a rounding error would 404 rather than silently
 * select other bytes, which is the failure direction to prefer.
 *
 * Values are stored and replayed VERBATIM, never normalized. S3 returns ETags
 * wrapped in quotes (`"abc123"`) and expects the same quoted form back in
 * `If-Match`; stripping them on capture and sending them bare is a silent
 * always-mismatch, which fails closed but for the wrong reason and would be
 * read as "the bytes changed".
 */
export type ObjectVersion = {
	etag?: string;
	versionId?: string;
	generation?: string;
};

/** A version plus what it measures — the shape `headObject` returns. */
export type ObjectIdentity = ObjectVersion & {
	size: number;
	lastModified?: string;
};

/**
 * The bytes are not the bytes that were named.
 *
 * Its own class so a caller can tell "this object changed under us" from a
 * transport failure or a 404. Conflating them is how a re-encode gets retried
 * against the new bytes: a generic error looks retryable, and this one never is
 * — the answer is to re-capture the identity deliberately, not to try again.
 */
export class ObjectVersionMismatchError extends Error {
	readonly bucket: string;
	readonly key: string;
	readonly expected: ObjectVersion;

	constructor(
		bucket: string,
		key: string,
		expected: ObjectVersion,
		cause?: unknown,
	) {
		const named = Object.entries(expected)
			.filter(([, v]) => v !== undefined)
			.map(([k, v]) => `${k} ${v}`)
			.join(", ");
		super(
			`the object at ${bucket}/${key} is no longer the version that was recorded (${named || "no version recorded"}) — its bytes were replaced, so any measurement against them would describe a different object`,
		);
		this.name = "ObjectVersionMismatchError";
		this.bucket = bucket;
		this.key = key;
		this.expected = expected;
		if (cause !== undefined) {
			this.cause = cause;
		}
	}
}

/**
 * The expectation cannot be ENFORCED by this driver — a different thing from
 * the bytes having changed.
 *
 * GCS enforces an exact version by selecting a generation, and
 * `createReadStream` takes no `If-Match`, so an etag-only expectation is
 * inexpressible there. Silently ignoring it would be the worst option (the
 * caller believes it got a verified read); reporting it as a MISMATCH would be
 * the second worst, because the bytes may be perfectly intact and the operator
 * would go looking for an overwrite that never happened.
 */
export class VersionExpectationUnsupportedError extends Error {
	readonly bucket: string;
	readonly key: string;
	readonly expected: ObjectVersion;

	constructor(
		bucket: string,
		key: string,
		expected: ObjectVersion,
		detail: string,
	) {
		super(
			`cannot verify the recorded version of ${bucket}/${key}: ${detail}. The bytes may be unchanged — this is a limitation of the driver, not evidence of an overwrite.`,
		);
		this.name = "VersionExpectationUnsupportedError";
		this.bucket = bucket;
		this.key = key;
		this.expected = expected;
	}
}

export type GetObjectInput = {
	bucket: string;
	key: string;
	/**
	 * Read THIS version or fail — audit CRITICAL-2.
	 *
	 * Translated per provider to an exact-version selector and/or a
	 * precondition: S3 `VersionId` + `If-Match`, GCS a generation-pinned file
	 * handle, Azure `ifMatch`. A provider-reported precondition failure becomes
	 * `ObjectVersionMismatchError`.
	 *
	 * Absent means "whatever is there now", which is the right default for
	 * browsing and previews. It is the WRONG default for anything that will be
	 * measured, compared or attested, and those callers pass it.
	 */
	expect?: ObjectVersion;
	/**
	 * Optional byte range (inclusive `end`, HTTP Range semantics). The storage
	 * INSPECT preview reads a bounded head — and, for a non-faststart MP4 whose
	 * moov sits at the end, a bounded tail — instead of pulling a multi-GB
	 * object just to read its headers. Absent = the whole object (the feeder's
	 * spool case, which genuinely needs every byte).
	 */
	range?: { start: number; end?: number };
};

/**
 * One bucket CORS rule, in the shape every provider's API agrees on. Header
 * names are as configured — case-insensitive per the HTTP spec, so consumers
 * must fold case rather than compare raw.
 */
export type PutObjectInput = {
	bucket: string;
	key: string;
	/** Local file to upload; the driver streams it and sets Content-Length from its size. */
	filePath: string;
	contentType?: string;
};

export type BucketCorsRule = {
	allowedOrigins: string[];
	allowedMethods: string[];
	allowedHeaders: string[];
	/** Response headers the browser may hand to JS (the usual omission). */
	exposeHeaders: string[];
};

export interface ObjectStorageBrowser {
	/** May throw UnsupportedBrowseError when the provider cannot enumerate. */
	listBuckets(): Promise<string[]>;
	listObjects(input: ListObjectsInput): Promise<ListObjectsResult>;
	/**
	 * Optional capability: stream object bytes (the P3 feeder spools source
	 * MP4s to local disk with this; P4 VMAF downloads reuse it). Deliberately
	 * a download stream and NOT a presigned URL: a presigned URL would expire
	 * mid-run on 24h pseudo-live loops, embed credential-derived material in
	 * the ffmpeg argv (visible in `ps`), and -stream_loop over HTTP needs
	 * seekable input — the local spool avoids all three.
	 */
	getObject?(input: GetObjectInput): Promise<NodeJS.ReadableStream>;
	/**
	 * Write one object from a local file (: the normalized slate goes
	 * back next to its source). Optional like `getObject`: only the S3 family
	 * implements it; a provider without it cannot receive a normalized slate,
	 * and the caller says so instead of guessing an upload path.
	 */
	putObject?(input: PutObjectInput): Promise<void>;
	/**
	 * Optional capability: the object's current version identity, without
	 * transferring it (audit CRITICAL-2).
	 *
	 * Separate from `listObjects` deliberately. A listing returns size and
	 * lastModified — both of which survive a same-size overwrite — and pages
	 * over a prefix; this asks about ONE object and returns the version
	 * selectors a later `getObject({ expect })` can demand. Throws whatever the
	 * provider throws for a missing object; callers that mean "is it there"
	 * should keep using the listing.
	 */
	headObject?(input: { bucket: string; key: string }): Promise<ObjectIdentity>;
	/**
	 * Optional capability: read the bucket's CORS configuration.
	 *
	 * Public-read does not imply CORS, and a player fetching manifests and
	 * segments via XHR needs both — so "why does playback fail on a bucket that
	 * curl reads fine" is answerable without a browser. Returns `null` when the
	 * bucket simply has no CORS configuration at all (a distinct answer from an
	 * empty rule list, which a provider could also return).
	 *
	 * Absent on a driver means "not knowable here", NOT "no CORS": callers must
	 * report unknown rather than missing.
	 */
	getBucketCors?(bucket: string): Promise<BucketCorsRule[] | null>;
	/** Releases pooled sockets; call from a finally in request handlers. */
	dispose?(): void;
}

/** Provider/credential cannot support an operation (vs transient failure). */
export class UnsupportedBrowseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedBrowseError";
	}
}

/**
 * Node system errnos (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, EAI_AGAIN, E2BIG, …).
 * The second character may be a DIGIT — `/^E[A-Z]…/` missed E2BIG (review
 * catch). Erring toward matching is right here: a false match costs diagnostic
 * granularity in a field the operator reads, while a miss costs a reachability
 * signal to an unauthenticated caller. The full message is logged server-side
 * either way.
 */
const NODE_ERRNO = /^E[A-Z0-9][A-Z0-9_]+$/;
/** undici's transport codes (UND_ERR_CONNECT_TIMEOUT, UND_ERR_SOCKET, …). */
const UNDICI_ERR = /^UND_ERR/;

/**
 * A transport failure, i.e. one whose classification would describe the NETWORK
 * rather than the service. Excluding the errno from `code` was not enough: it
 * only moved the oracle to `name`, because Node wraps some connect failures in
 * `AggregateError` (happy-eyeballs) while a DNS miss stays a plain `Error` — so
 * AggregateError-vs-Error still separates "host up, port closed" from "did not
 * resolve" (review catch; measured on Node v24.19.0 — I could not reproduce the
 * AggregateError split on this machine, which is exactly why `name` is not a
 * safe fallback to reason about).
 *
 * `errno`/`syscall` are the environment-independent markers: both cases carry
 * them here. Anything that has them gets the fixed label and nothing else.
 */
function isTransportError(e: {
	name?: string;
	code?: unknown;
	errno?: unknown;
	syscall?: unknown;
}): boolean {
	if (typeof e.errno === "number" || typeof e.syscall === "string") {
		return true;
	}
	if (typeof e.code !== "string") {
		return false;
	}
	return NODE_ERRNO.test(e.code) || UNDICI_ERR.test(e.code);
}

/**
 * CLASSIFIED description of an upstream storage failure — error class + status
 * ONLY, never the driver's own `message` (C20).
 *
 * Storage SDK messages routinely embed the endpoint they dialed: an AWS SDK
 * connection failure reads `connect ECONNREFUSED 10.0.7.22:9000`, a DNS miss
 * `getaddrinfo ENOTFOUND minio.internal.corp`, a hang `ETIMEDOUT`. GenericS3
 * points at arbitrary vendor/self-hosted endpoints (C10), so those strings
 * describe the SERVER's network zone. Persisting or returning one turns any
 * surface that echoes it into a discriminating network-probe oracle.
 *
 * `redactSecrets` is NOT a mitigation here: on a bare string it applies only
 * the URL-userinfo rule, so hostnames, IPs, ports and query strings pass
 * through untouched. This is the storage-side equivalent of the Bitmovin
 * SDK's `BitmovinCallError` — same constraint (C20), same shape of fix.
 *
 * The result is deliberately coarse: a caller learns "the upstream read
 * failed, class X" and nothing about the topology behind it. The full error
 * stays server-side, for logs only.
 */
export function describeStorageError(err: unknown): {
	code: string;
	status?: number;
} {
	const e = err as
		| {
				name?: string;
				Code?: string;
				code?: unknown;
				statusCode?: unknown;
				$metadata?: { httpStatusCode?: number };
		  }
		| null
		| undefined;
	// Three SDKs, three shapes:
	//   AWS      — `Code` (S3 error code) + `$metadata.httpStatusCode`
	//   Azure    — `RestError` names itself "RestError" and puts the useful
	//              service code ("AuthenticationFailed", "ContainerNotFound") on
	//              `code` as a STRING, with the status on `statusCode`. So a
	//              string `code` outranks the class name, or every Azure failure
	//              reads as "RestError".
	//   GCS      — numeric `code`
	//
	// EXCEPT Node system errnos. A refused connection carries
	// `code: "ECONNREFUSED"`, and surfacing that would undo the reason this
	// function exists: ECONNREFUSED vs ENOTFOUND vs ETIMEDOUT distinguishes
	// open from closed from filtered, and a resolvable host from an unresolvable
	// one — the network-probe oracle C20 removes, even without the IP that only
	// the message carries. Those fall through to the class name and the full text
	// stays in the server log. Service codes are PascalCase, so the errno shape
	// does not collide with them. (Caught by merging two changes that were each
	// correct alone.)
	const status =
		e?.$metadata?.httpStatusCode ??
		(typeof e?.statusCode === "number" ? e.statusCode : undefined) ??
		(typeof e?.code === "number" ? e.code : undefined);
	// A transport failure gets ONE fixed label — not its code, and not its class
	// name. Falling through to `name` is what kept the reachability oracle open
	// one field over.
	if (e && !e.Code && isTransportError(e)) {
		return {
			code: "StorageError",
			...(status === undefined ? {} : { status }),
		};
	}
	const stringCode = typeof e?.code === "string" ? e.code : undefined;
	return {
		code: e?.Code ?? stringCode ?? e?.name ?? "StorageError",
		...(status === undefined ? {} : { status }),
	};
}

/** One-line classified text for an upstream storage failure (see above). */
export function storageErrorText(err: unknown): string {
	const { code, status } = describeStorageError(err);
	return status
		? `Storage request failed: ${code} (upstream ${status})`
		: `Storage request failed: ${code}`;
}

export const MAX_PAGE_SIZE = 100;

export function clampLimit(limit: number | undefined): number {
	if (!limit || limit < 1) {
		return MAX_PAGE_SIZE;
	}
	return Math.min(limit, MAX_PAGE_SIZE);
}
