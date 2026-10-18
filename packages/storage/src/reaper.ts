import {
	DeleteObjectCommand,
	DeleteObjectsCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import {
	BlobServiceClient,
	StorageSharedKeyCredential,
} from "@azure/storage-blob";
import {
	assertStorageEndpointAllowed,
	bucketAddressing,
	type CredentialProviderId,
} from "@bitovp/core";
import { Storage } from "@google-cloud/storage";
import type { BrowserCredential } from "./factory";
import { storageErrorText, UnsupportedBrowseError } from "./types";

/**
 * Startup-probe cleanup .
 *
 * THE APP'S FIRST DESTRUCTIVE STORAGE CAPABILITY — deliberately a separate
 * interface from `ObjectStorageBrowser` (the browse contract stays
 * list/get-only, the product's standing posture), with three hard controls:
 *
 *  1. This module is the ONLY deletion surface, and it has exactly two
 *     legitimate importers: the worker's probe reaper (cleanup) and the
 *     designation route (control 2's verification). A repo test pins the
 *     importer set — a third import site is a review conversation, not a
 *     convenience.
 *  2. `verifyDeletePermission` runs at DESIGNATION time: a list-only
 *     credential (the product norm) fails loudly when the operator picks it,
 *     not after ten probes have already leaked output.
 *  3. `assertSafeProbePrefix` hard-refuses empty/short/underscoped prefixes.
 *     The #155 precedent is an output-prefix derivation bug that persisted
 *     "" — harmless in a WRITE (bucket-root objects), catastrophic in a
 *     DELETE (the whole bucket). Mutation-pinned.
 */

export interface ObjectStorageReaper {
	/** Recursively delete everything under `prefix`. Returns the count. */
	deleteObjectsUnderPrefix(input: {
		bucket: string;
		prefix: string;
	}): Promise<{ deleted: number }>;
	/**
	 * Control 2: prove the credential may DELETE without deleting anything
	 * real — a delete of a nonexistent sentinel key distinguishes
	 * permission-denied (403/AccessDenied) from not-found-with-permission
	 * (success/404), on every driver.
	 */
	verifyDeletePermission(input: {
		bucket: string;
		prefix: string;
	}): Promise<{ ok: boolean; detail: string }>;
}

export class UnsafeProbePrefixError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsafeProbePrefixError";
	}
}

/** Below this many characters a configured probe prefix is refused outright —
 * short prefixes are one derivation bug away from sweeping a bucket. */
export const MIN_PROBE_PREFIX_LENGTH = 8;

/**
 * Control 3. `configuredPrefix` is the operator's designated probe area;
 * `prefix` is what a caller is about to delete. The deletion target must be
 * AT or BELOW the designated area, and the designated area itself must be
 * long enough to be an area rather than an accident.
 */
export function assertSafeProbePrefix(
	prefix: string,
	configuredPrefix: string,
): void {
	const configured = configuredPrefix.trim();
	const target = prefix.trim();
	if (configured.length < MIN_PROBE_PREFIX_LENGTH) {
		throw new UnsafeProbePrefixError(
			`configured probe prefix "${configured}" is shorter than ${MIN_PROBE_PREFIX_LENGTH} characters — refusing every deletion under it`,
		);
	}
	if (target.length < configured.length || !target.startsWith(configured)) {
		throw new UnsafeProbePrefixError(
			`deletion target "${target}" is not inside the designated probe prefix "${configured}"`,
		);
	}
	// review-161-162 M9: STRICTLY below — deleting the area itself is refused
	// too. Every legitimate reap targets `${area}${probeId}/`, and the
	// equality case is exactly where a slash-less area's ListObjectsV2
	// prefix ("probes/startup") would match sibling areas
	// ("probes/startup-customer-masters/*") through the door the boundary
	// check below cannot guard.
	if (target.length === configured.length) {
		throw new UnsafeProbePrefixError(
			`deletion target "${target}" IS the designated area — reaps target one probe's subtree, never the whole area`,
		);
	}
	// review-pr34 M1: raw startsWith admits SIBLINGS of a slash-less area —
	// configured "probes/startup" would bless "probes/startup-customer-masters/…".
	// The designation route normalizes a trailing slash, but this guard is the
	// last line at the deletion site and must not trust its callers: past the
	// configured area's end, the next character must be a path separator.
	if (!configured.endsWith("/") && target[configured.length] !== "/") {
		throw new UnsafeProbePrefixError(
			`deletion target "${target}" extends the designated prefix "${configured}" past a segment boundary — a sibling area, not a child`,
		);
	}
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

/** review-161-162 NIT 2: exported so the designation route builds its
 * control-3 guard target from the SAME literal the canary writes — the
 * two-copies-drift class the marker predicate already collapsed. */
export const SENTINEL = ".bitovp-permission-probe";

function isDenied(err: unknown): boolean {
	const name = (err as { name?: string })?.name ?? "";
	const code =
		(err as { Code?: string; code?: string | number })?.Code ??
		(err as { code?: string | number })?.code ??
		"";
	const status =
		(err as { $metadata?: { httpStatusCode?: number } })?.$metadata
			?.httpStatusCode ??
		(err as { statusCode?: number })?.statusCode ??
		0;
	return (
		status === 403 ||
		String(name).includes("AccessDenied") ||
		String(code).includes("AccessDenied") ||
		String(code) === "403"
	);
}

function s3Reaper(options: {
	region: string;
	credentials: { accessKeyId: string; secretAccessKey: string };
	endpoint?: string;
	forcePathStyle?: boolean;
}): ObjectStorageReaper {
	const client = new S3Client({
		region: options.region,
		credentials: options.credentials,
		...(options.endpoint
			? {
					endpoint: options.endpoint,
					forcePathStyle: options.forcePathStyle ?? true,
				}
			: {}),
	});
	if (options.endpoint) {
		// The same `?x-id` strip the browser carries (measured 2026-08-19):
		// S3-compatible stores refuse requests carrying the SDK's marker.
		client.middlewareStack.add(
			(next) => async (args) => {
				const request = args.request as { query?: Record<string, unknown> };
				if (request.query && "x-id" in request.query) {
					delete request.query["x-id"];
				}
				return next(args);
			},
			{ step: "build", name: "stripXIdForS3CompatibleReaper" },
		);
	}
	return {
		async deleteObjectsUnderPrefix({ bucket, prefix }) {
			let deleted = 0;
			let token: string | undefined;
			do {
				const page = await client.send(
					new ListObjectsV2Command({
						Bucket: bucket,
						Prefix: prefix,
						ContinuationToken: token,
						MaxKeys: 1000,
					}),
				);
				const keys = (page.Contents ?? [])
					.map((o) => o.Key)
					.filter((k): k is string => typeof k === "string");
				if (keys.length > 0) {
					// review-pr34 B4: S3 batch delete reports per-key failures in
					// a 200 BODY — Quiet:true suppressed the Deleted list and the
					// old code counted keys ASKED as keys DELETED, so a
					// half-failed reap read as clean. Quiet off, count the
					// server's own Deleted list, and refuse to continue past
					// Errors (the caller records cleanupError on the sample row).
					const out = await client.send(
						new DeleteObjectsCommand({
							Bucket: bucket,
							Delete: { Objects: keys.map((Key) => ({ Key })) },
						}),
					);
					const failures = out.Errors ?? [];
					// review-161-162 m11: on a VERSIONED bucket a "deletion"
					// creates a delete MARKER — the versions keep billing. Count
					// real removals only, so the log's number matches the bill.
					deleted += (out.Deleted ?? []).filter(
						(entry) => entry.DeleteMarker !== true,
					).length;
					if (failures.length > 0) {
						const first = failures[0];
						// review-161-162 M8: the message carries what actually
						// happened — deletions BEFORE the failure survive in the
						// count, and the throw precedes the IsTruncated check, so
						// unlisted pages are named rather than implied clean.
						throw new Error(
							`batch delete stopped: ${failures.length}/${keys.length} keys failed on this page (first: ${first?.Code ?? "?"} on ${first?.Key ?? "?"}); ${deleted} deleted before the failure; later pages were not listed`,
						);
					}
				}
				token = page.IsTruncated ? page.NextContinuationToken : undefined;
			} while (token);
			return { deleted };
		},
		async verifyDeletePermission({ bucket, prefix }) {
			const key = `${prefix}${SENTINEL}`;
			// Canary shape (review-161-162 B3): PUT proves the bucket exists
			// and the credential writes (it must — Bitmovin writes probe
			// output with it); LIST proves the reap's pager will work (M10);
			// DELETE of the JUST-written key can never 404, so every failure
			// is a real answer instead of an ambiguous absence. The earlier
			// absent-sentinel DELETE could not fail on a mistyped bucket and
			// rode a 404=permitted arm on four of five providers.
			try {
				await client.send(
					new PutObjectCommand({ Bucket: bucket, Key: key, Body: "" }),
				);
			} catch (err) {
				const status =
					(err as { $metadata?: { httpStatusCode?: number } })?.$metadata
						?.httpStatusCode ?? 0;
				const name = String((err as { name?: string })?.name ?? "");
				if (status === 404 || name === "NoSuchBucket") {
					return { ok: false, detail: "bucket does not exist" };
				}
				return isDenied(err)
					? { ok: false, detail: "access denied (write)" }
					: { ok: false, detail: storageErrorText(err) };
			}
			// review-161-162 n-1: from here the canary EXISTS — a failure on
			// the LIST or DELETE leg must still remove it, or the routine
			// whose whole job is proving cleanup leaves a write behind that no
			// future reap can collect (M9 refuses the area itself). Best-effort
			// on both paths.
			const sweepCanary = async () => {
				await client
					.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
					.catch(() => {});
			};
			try {
				await client.send(
					new ListObjectsV2Command({
						Bucket: bucket,
						Prefix: prefix,
						MaxKeys: 1,
					}),
				);
			} catch (err) {
				await sweepCanary();
				return isDenied(err)
					? {
							ok: false,
							detail: "access denied (list — reaps page with List)",
						}
					: { ok: false, detail: storageErrorText(err) };
			}
			try {
				await client.send(
					new DeleteObjectCommand({ Bucket: bucket, Key: key }),
				);
				return { ok: true, detail: "write+list+delete verified" };
			} catch (err) {
				return isDenied(err)
					? { ok: false, detail: "access denied (delete)" }
					: { ok: false, detail: storageErrorText(err) };
			}
		},
	};
}

function gcsReaper(serviceAccountJson: string): ObjectStorageReaper {
	const parsed = JSON.parse(serviceAccountJson) as {
		project_id?: string;
		client_email?: string;
		private_key?: string;
	};
	const storage = new Storage({
		projectId: parsed.project_id,
		credentials: {
			client_email: parsed.client_email,
			private_key: parsed.private_key,
		},
	});
	return {
		async deleteObjectsUnderPrefix({ bucket, prefix }) {
			const [files] = await storage
				.bucket(bucket)
				.getFiles({ prefix, autoPaginate: true });
			let deleted = 0;
			for (const file of files) {
				await file.delete();
				deleted += 1;
			}
			return { deleted };
		},
		async verifyDeletePermission({ bucket, prefix }) {
			const file = storage.bucket(bucket).file(`${prefix}${SENTINEL}`);
			// Canary shape (review-161-162 B3): GCS delete is NOT idempotent
			// (404 on a missing object), so the absent-sentinel check rode the
			// ambiguous arm on EVERY legitimate verify. Write-then-delete makes
			// success unambiguous and a mistyped bucket fail at the save.
			try {
				await file.save("");
			} catch (err) {
				const code = (err as { code?: number })?.code ?? 0;
				if (code === 404) {
					return { ok: false, detail: "bucket does not exist" };
				}
				return code === 403 || isDenied(err)
					? { ok: false, detail: "access denied (write)" }
					: { ok: false, detail: storageErrorText(err) };
			}
			// n-1: the canary exists past the save — remove it on any later
			// failure.
			const sweepCanary = async () => {
				await file.delete().catch(() => {});
			};
			try {
				await storage.bucket(bucket).getFiles({
					prefix,
					maxResults: 1,
					autoPaginate: false,
				});
			} catch (err) {
				await sweepCanary();
				const code = (err as { code?: number })?.code ?? 0;
				return code === 403 || isDenied(err)
					? {
							ok: false,
							detail: "access denied (list — reaps page with List)",
						}
					: { ok: false, detail: storageErrorText(err) };
			}
			try {
				await file.delete();
				return { ok: true, detail: "write+list+delete verified" };
			} catch (err) {
				const code = (err as { code?: number })?.code ?? 0;
				return code === 403 || isDenied(err)
					? { ok: false, detail: "access denied (delete)" }
					: { ok: false, detail: storageErrorText(err) };
			}
		},
	};
}

function azureReaper(options: {
	accountName: string;
	accountKey: string;
}): ObjectStorageReaper {
	const service = new BlobServiceClient(
		`https://${options.accountName}.blob.core.windows.net`,
		new StorageSharedKeyCredential(options.accountName, options.accountKey),
	);
	return {
		async deleteObjectsUnderPrefix({ bucket, prefix }) {
			const container = service.getContainerClient(bucket);
			let deleted = 0;
			for await (const blob of container.listBlobsFlat({ prefix })) {
				await container.deleteBlob(blob.name);
				deleted += 1;
			}
			return { deleted };
		},
		async verifyDeletePermission({ bucket, prefix }) {
			const container = service.getContainerClient(bucket);
			const name = `${prefix}${SENTINEL}`;
			// Canary shape (review-161-162 B3): write-then-delete — a missing
			// container fails at the upload instead of riding a 404=permitted
			// arm, and the delete of a just-written blob cannot 404.
			try {
				await container.uploadBlockBlob(name, "", 0);
			} catch (err) {
				const status = (err as { statusCode?: number })?.statusCode ?? 0;
				if (status === 404) {
					return { ok: false, detail: "container does not exist" };
				}
				return status === 403
					? { ok: false, detail: "access denied (write)" }
					: { ok: false, detail: storageErrorText(err) };
			}
			// n-1: sweep the canary on a later-leg failure.
			const sweepCanary = async () => {
				await container.deleteBlob(name).catch(() => {});
			};
			try {
				const page = container
					.listBlobsFlat({ prefix })
					.byPage({ maxPageSize: 1 });
				await page.next();
			} catch (err) {
				await sweepCanary();
				const status = (err as { statusCode?: number })?.statusCode ?? 0;
				return status === 403
					? {
							ok: false,
							detail: "access denied (list — reaps page with List)",
						}
					: { ok: false, detail: storageErrorText(err) };
			}
			try {
				await container.deleteBlob(name);
				return { ok: true, detail: "write+list+delete verified" };
			} catch (err) {
				const status = (err as { statusCode?: number })?.statusCode ?? 0;
				return status === 403
					? { ok: false, detail: "access denied (delete)" }
					: { ok: false, detail: storageErrorText(err) };
			}
		},
	};
}

function s3ReaperOptions(
	provider: CredentialProviderId,
	config: Record<string, unknown>,
	credentials: { accessKeyId: string; secretAccessKey: string },
) {
	const addressing = bucketAddressing(provider, config);
	if (!addressing) {
		throw new UnsupportedBrowseError(
			`${provider} holds no probe-cleanable buckets`,
		);
	}
	return {
		credentials,
		region: addressing.region,
		...(addressing.awsManaged
			? {}
			: { endpoint: addressing.origin, forcePathStyle: addressing.pathStyle }),
	};
}

/**
 * The deletion factory — same provider table as browsing, but producing the
 * REAPER interface. SLATE/probe-supported providers only; anything else is a
 * loud refusal (control 2 turns it into a designation-time error).
 */
export function probeReaperForCredential(
	credential: BrowserCredential,
	options: {
		endpointAllowlist?: readonly string[] | undefined;
		onWarning?: (message: string) => void;
	} = {},
): ObjectStorageReaper {
	const { provider, config, secret } = credential;
	// review-161-162 M11: the DESTRUCTIVE path honors the same ledger-#28
	// endpoint allowlist as browsing (factory.ts's GENERIC_S3 arm) —
	// removing a host from STORAGE_ENDPOINT_ALLOWED_HOSTS must refuse
	// deletion too, not keep dialing it for DELETE while refusing LIST.
	if (provider === "GENERIC_S3") {
		assertStorageEndpointAllowed(
			str(config.host),
			options.endpointAllowlist,
			options.onWarning ?? (() => {}),
		);
	}
	switch (provider) {
		case "AWS_S3":
		case "AKAMAI_OBJECT_STORAGE":
		case "OCI_OBJECT_STORAGE":
		case "GENERIC_S3":
			return s3Reaper(
				s3ReaperOptions(provider, config, {
					accessKeyId: secret.accessKeyId ?? "",
					secretAccessKey: secret.secretAccessKey ?? "",
				}),
			);
		case "GCS_HMAC":
			return s3Reaper(
				s3ReaperOptions(provider, config, {
					accessKeyId: secret.accessKey ?? "",
					secretAccessKey: secret.secret ?? "",
				}),
			);
		case "GCS_SERVICE_ACCOUNT":
			return gcsReaper(secret.serviceAccountJson ?? "");
		case "AZURE_BLOB":
			return azureReaper({
				accountName: str(config.accountName),
				accountKey: secret.accountKey ?? "",
			});
		default:
			throw new UnsupportedBrowseError(
				`${provider} cannot host probe output (no deletion driver)`,
			);
	}
}
