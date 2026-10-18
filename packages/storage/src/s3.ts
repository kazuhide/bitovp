import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { GetObjectCommandOutput } from "@aws-sdk/client-s3";
import {
	GetBucketCorsCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListBucketsCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import {
	type BucketCorsRule,
	clampLimit,
	type GetObjectInput,
	type ListObjectsInput,
	type ListObjectsResult,
	type ObjectIdentity,
	type ObjectStorageBrowser,
	ObjectVersionMismatchError,
	type PutObjectInput,
} from "./types";

/**
 * S3 signals a failed `If-Match` as 412. The SDK surfaces it as
 * `PreconditionFailed`; some S3-compatible endpoints (C10: Linode, OCI, MinIO,
 * Ceph) return the status without that name, so the status is checked too.
 *
 * `NoSuchVersion` / `InvalidArgument` on a `VersionId` read is the SAME
 * condition from the caller's side — the named version is not retrievable — so
 * it maps here rather than escaping as a generic failure that reads as
 * retryable.
 */
function isPreconditionFailure(err: unknown): boolean {
	const e = err as {
		name?: unknown;
		Code?: unknown;
		$metadata?: { httpStatusCode?: unknown };
	};
	const name = String(e?.name ?? e?.Code ?? "");
	// `NoSuchVersion` belongs here and `InvalidArgument` does NOT, and the
	// difference is what the operator is told. A recorded version that has been
	// permanently deleted is the same condition as a failed If-Match from the
	// caller's side — the named bytes are not retrievable — so it is a mismatch.
	// `InvalidArgument` is S3's GENERIC 400 for a malformed parameter (a bad
	// Range, an unsupported argument, a dozen other things); mapping it here
	// would tell an operator "the object's bytes were replaced" whenever an
	// unrelated request defect happened to occur under an expectation. That is
	// the same misleading-error failure `VersionExpectationUnsupportedError`
	// exists to prevent, and it was committed two functions away in this file.
	if (name === "PreconditionFailed" || name === "NoSuchVersion") {
		return true;
	}
	return e?.$metadata?.httpStatusCode === 412;
}

export type S3BrowserOptions = {
	credentials: { accessKeyId: string; secretAccessKey: string };
	region: string;
	/** Full https endpoint for S3-compatible services; omit for AWS. */
	endpoint?: string;
	/** Path-style is required by OCI compat and safest for custom endpoints. */
	forcePathStyle?: boolean;
	/** Opt-in readiness reads: one attempt with SDK request timeouts. */
	readTimeoutMs?: number;
	/** GCS XML returns whole-object checksums even for a partial GET. */
	rangeChecksumsAreWholeObject?: boolean;
};

export function createS3Browser(
	options: S3BrowserOptions,
): ObjectStorageBrowser {
	const client = new S3Client({
		region: options.region,
		credentials: options.credentials,
		...(options.readTimeoutMs === undefined
			? {}
			: {
					maxAttempts: 1,
					requestHandler: {
						requestTimeout: options.readTimeoutMs,
						connectionTimeout: options.readTimeoutMs,
						socketTimeout: options.readTimeoutMs,
						throwOnRequestTimeout: true,
					},
				}),
		...(options.endpoint
			? {
					endpoint: options.endpoint,
					forcePathStyle: options.forcePathStyle ?? true,
				}
			: {}),
	});

	if (options.endpoint) {
		/**
		 * Drop the SDK's own `?x-id=<Operation>` marker on S3-COMPATIBLE
		 * endpoints. aws-sdk-js adds it so a request is identifiable; it means
		 * nothing to the service, but it IS part of the canonical query string,
		 * and these stores reject the SERVICE-LEVEL request that carries it.
		 *
		 * Measured 2026-08-19 against the real credentials, one variable
		 * isolated: same client, same keys, same endpoint, same region, with
		 * and without this middleware —
		 *
		 *   Akamai (Linode) ListBuckets: SignatureDoesNotMatch → OK, 3 buckets
		 *   GCS HMAC        ListBuckets: InvalidArgument       → OK, 69 buckets
		 *
		 * and the AWS CLI plus s3cmd list the same buckets with the same keys,
		 * which is what proved the defect ours rather than the vendors'. Both
		 * providers had a hard-coded "this store cannot enumerate buckets"
		 * refusal built on the misreading; both are gone.
		 *
		 * WHAT IS NOT ESTABLISHED, deliberately spelled out because writing an
		 * unmeasured mechanism as fact is the exact error this fix retracts:
		 * the SDK sends `x-id` on `GetObject` and `PutObject` too (verified),
		 * and both stores accept those — GetObject returned 276 MB from Akamai
		 * and 614 bytes from GCS WITH the parameter present. So it is not a
		 * blanket "these stores mis-canonicalise x-id"; only the bare-endpoint
		 * request is refused. Why the two differ is unknown.
		 *
		 * The strip is applied to every operation anyway, because the parameter
		 * is meaningless and a per-operation rule would be a guess about a
		 * mechanism we have not established. Removing it from GetObject is
		 * measured safe on both stores (same bytes returned either way).
		 *
		 * It must run at `build`, BEFORE signing: stripping later would leave a
		 * signature covering a parameter no longer on the wire — the same
		 * mismatch by the opposite route.
		 *
		 * AWS itself is left alone (no `endpoint` ⇒ no middleware): `x-id` is
		 * AWS's own marker and S3 handles it correctly.
		 */
		client.middlewareStack.add(
			(next) => async (args) => {
				const request = args.request as {
					query?: Record<string, unknown>;
				};
				if (request.query && "x-id" in request.query) {
					delete request.query["x-id"];
				}
				return next(args);
			},
			{ step: "build", name: "stripXIdForS3Compatible" },
		);
	}

	return {
		async listBuckets(): Promise<string[]> {
			// Unpaginated: AWS pages ListBuckets past 10k buckets — far beyond
			// media-account scale; revisit if anyone hits it.
			const res = await client.send(new ListBucketsCommand({}));
			return (res.Buckets ?? [])
				.map((bucket) => bucket.Name ?? "")
				.filter((name) => name.length > 0);
		},

		async listObjects(input: ListObjectsInput): Promise<ListObjectsResult> {
			const res = await client.send(
				new ListObjectsV2Command({
					Bucket: input.bucket,
					Prefix: input.prefix,
					// Recursive ⇒ no delimiter, so deeply-nested keys land in Contents
					// instead of collapsing into CommonPrefixes.
					Delimiter: input.recursive ? undefined : "/",
					MaxKeys: clampLimit(input.limit),
					ContinuationToken: input.cursor,
				}),
			);
			return {
				prefixes: (res.CommonPrefixes ?? [])
					.map((p) => p.Prefix ?? "")
					.filter((p) => p.length > 0),
				objects: (res.Contents ?? [])
					// Only a directory prefix is a marker; an exact file-prefix
					// match is a real object needed by bounded metadata lookups.
					.filter(
						(obj) =>
							obj.Key && !(obj.Key === input.prefix && obj.Key.endsWith("/")),
					)
					.map((obj) => ({
						key: obj.Key ?? "",
						size: obj.Size ?? 0,
						lastModified: obj.LastModified?.toISOString(),
					})),
				nextCursor: res.IsTruncated ? res.NextContinuationToken : undefined,
			};
		},

		async headObject(input: {
			bucket: string;
			key: string;
		}): Promise<ObjectIdentity> {
			const res = await client.send(
				new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }),
			);
			return {
				// VERBATIM, quotes included — S3 expects the same string back in
				// If-Match, and normalizing here would make every later read
				// mismatch for the wrong reason.
				...(res.ETag ? { etag: res.ETag } : {}),
				// "null" is what an unversioned bucket reports; it is not a version
				// and sending it back selects nothing.
				...(res.VersionId && res.VersionId !== "null"
					? { versionId: res.VersionId }
					: {}),
				size: res.ContentLength ?? 0,
				...(res.LastModified
					? { lastModified: res.LastModified.toISOString() }
					: {}),
			};
		},

		async getObject(input: GetObjectInput): Promise<NodeJS.ReadableStream> {
			let res: GetObjectCommandOutput;
			try {
				const command = new GetObjectCommand({
					Bucket: input.bucket,
					Key: input.key,
					// Exact-version read (audit CRITICAL-2). VersionId selects the
					// version; If-Match refuses a substitute. Both are sent when both
					// were recorded — on a versioned bucket VersionId alone is
					// sufficient, but If-Match also covers the unversioned case, and
					// an object that has both must satisfy both.
					...(input.expect?.versionId
						? { VersionId: input.expect.versionId }
						: {}),
					...(input.expect?.etag ? { IfMatch: input.expect.etag } : {}),
					// HTTP Range: "bytes=start-end" (inclusive), "bytes=start-"
					// for an open-ended tail read.
					...(input.range
						? {
								Range: `bytes=${input.range.start}-${input.range.end ?? ""}`,
							}
						: {}),
				});
				if (input.range && options.rangeChecksumsAreWholeObject) {
					// GCS range checksums describe the complete object, so validating
					// the returned slice against them always fails. The SDK enables
					// ChecksumMode by default; omit it after that input middleware and
					// before serialization. Full reads retain checksum validation.
					// https://docs.cloud.google.com/storage/docs/xml-api/get-object-download
					command.middlewareStack.addRelativeTo(
						(next: ReturnType<typeof command.resolveMiddleware>) =>
							async (args: Parameters<typeof next>[0]) => {
								delete args.input.ChecksumMode;
								return next(args);
							},
						{
							name: "omitWholeObjectChecksumForGcsRange",
							relation: "after",
							toMiddleware: "flexibleChecksumsInputMiddleware",
						},
					);
				}
				res = await client.send(command);
			} catch (err) {
				if (input.expect && isPreconditionFailure(err)) {
					throw new ObjectVersionMismatchError(
						input.bucket,
						input.key,
						input.expect,
						err,
					);
				}
				throw err;
			}
			const body = res.Body as { pipe?: unknown } | undefined;
			// In Node the SDK yields a Readable; web/Blob bodies would mean a
			// non-Node runtime, which the feeder never runs in.
			if (!body || typeof body.pipe !== "function") {
				throw new Error("S3 GetObject returned no readable body stream");
			}
			// Range support is OPTIONAL in HTTP, and GENERIC_S3 points at whatever
			// endpoint the customer configured (C10: Akamai/Linode, OCI, MinIO,
			// Ceph, …). A server that does not implement it answers 200 with the
			// WHOLE object instead of 206 with a slice, and `Content-Range` is the
			// only thing in the response that tells them apart. Callers ask for a
			// range to bound what they read; handing them the whole object would
			// turn a bounded preview into an unbounded download.
			if (input.range && !res.ContentRange) {
				(body as unknown as { destroy?: () => void }).destroy?.();
				throw new Error(
					`storage endpoint ignored the byte-range request for ${input.key} ` +
						"(no Content-Range in the response), so the reply is the whole " +
						"object rather than the requested slice",
				);
			}
			return body as unknown as NodeJS.ReadableStream;
		},

		async putObject(input: PutObjectInput): Promise<void> {
			// Content-Length from the file, so the SDK sends a single signed PUT
			// (a bodyless-length stream would make it buffer or refuse); the
			// object lands next to its source with the same credential that read
			// the source, which is exactly the permission the operator vaulted.
			const { size } = await stat(input.filePath);
			const body = createReadStream(input.filePath);
			try {
				await client.send(
					new PutObjectCommand({
						Bucket: input.bucket,
						Key: input.key,
						Body: body,
						ContentLength: size,
						...(input.contentType ? { ContentType: input.contentType } : {}),
					}),
				);
			} catch (err) {
				// A rejection before the body was consumed (signing, credentials)
				// would otherwise hold the descriptor until GC.
				body.destroy();
				throw err;
			}
		},
		async getBucketCors(bucket: string): Promise<BucketCorsRule[] | null> {
			try {
				const res = await client.send(
					new GetBucketCorsCommand({ Bucket: bucket }),
				);
				return (res.CORSRules ?? []).map((rule) => ({
					allowedOrigins: rule.AllowedOrigins ?? [],
					allowedMethods: rule.AllowedMethods ?? [],
					allowedHeaders: rule.AllowedHeaders ?? [],
					exposeHeaders: rule.ExposeHeaders ?? [],
				}));
			} catch (err) {
				// A bucket with no CORS configuration is not an error condition —
				// it is the single most common cause of "public but unplayable",
				// and the caller needs to tell it apart from a permission failure
				// (which stays an exception).
				if (
					(err as { name?: string }).name === "NoSuchCORSConfiguration" ||
					(err as { Code?: string }).Code === "NoSuchCORSConfiguration"
				) {
					return null;
				}
				throw err;
			}
		},

		dispose(): void {
			client.destroy();
		},
	};
}
