import { PassThrough } from "node:stream";
import { Storage } from "@google-cloud/storage";
import {
	clampLimit,
	type GetObjectInput,
	type ListObjectsInput,
	type ListObjectsResult,
	type ObjectIdentity,
	type ObjectStorageBrowser,
	type ObjectVersion,
	ObjectVersionMismatchError,
	UnsupportedBrowseError,
	VersionExpectationUnsupportedError,
} from "./types";

type ServiceAccountKey = {
	project_id?: string;
	client_email: string;
	private_key: string;
};

/** GCS via service-account key JSON (the HMAC path uses the S3 driver). */
/**
 * "The pinned generation is not retrievable" — GCS answers 404 for a deleted or
 * never-existent generation. Deliberately narrow: only the status is trusted,
 * and the caller only consults this when a generation was actually pinned.
 */
function isNotFound(err: unknown): boolean {
	const e = err as {
		code?: unknown;
		status?: unknown;
		response?: { status?: unknown };
	};
	return e?.code === 404 || e?.status === 404 || e?.response?.status === 404;
}

export function createGcsBrowser(
	serviceAccountJson: string,
	readTimeoutMs?: number,
): ObjectStorageBrowser {
	let key: ServiceAccountKey;
	try {
		key = JSON.parse(serviceAccountJson) as ServiceAccountKey;
	} catch {
		throw new UnsupportedBrowseError(
			"Stored service-account key is not valid JSON",
		);
	}
	// NO apiEndpoint: this client can only ever reach storage.googleapis.com.
	// That is load-bearing for the ranged-read rail — see getObject below — so a
	// future customer-configurable endpoint here must revisit it (gcs.test.ts
	// fails if one is added).
	const storage = new Storage({
		// SDK data and OAuth transports have separate timeout options. These
		// limit requests, not a hard wall-clock cancellation guarantee; callers
		// must await in-flight reads and reject results after their deadline.
		...(readTimeoutMs === undefined
			? {}
			: {
					timeout: readTimeoutMs,
					retryOptions: { autoRetry: false },
					clientOptions: {
						transporterOptions: { timeout: readTimeoutMs, retry: false },
					},
				}),
		projectId: key.project_id,
		credentials: {
			client_email: key.client_email,
			private_key: key.private_key,
		},
	});

	return {
		async listBuckets(): Promise<string[]> {
			if (!key.project_id) {
				throw new UnsupportedBrowseError(
					"Service-account key has no project_id — enter the bucket name manually",
				);
			}
			const [buckets] = await storage.getBuckets();
			return buckets.map((bucket) => bucket.name);
		},

		async listObjects(input: ListObjectsInput): Promise<ListObjectsResult> {
			const [files, nextQuery, apiResponse] = await storage
				.bucket(input.bucket)
				.getFiles({
					prefix: input.prefix,
					// Recursive ⇒ no delimiter, so deeply-nested objects are returned
					// instead of collapsing into prefixes.
					...(input.recursive ? {} : { delimiter: "/" }),
					maxResults: clampLimit(input.limit),
					pageToken: input.cursor,
					autoPaginate: false,
				});
			const response = apiResponse as { prefixes?: string[] } | undefined;
			return {
				prefixes: response?.prefixes ?? [],
				objects: files
					// Exact file-prefix matches are real objects, not directory markers.
					.filter(
						(file) => !(file.name === input.prefix && file.name.endsWith("/")),
					)
					.map((file) => ({
						key: file.name,
						size: Number(file.metadata.size ?? 0),
						lastModified:
							typeof file.metadata.updated === "string"
								? file.metadata.updated
								: undefined,
					})),
				nextCursor: (nextQuery as { pageToken?: string } | null)?.pageToken,
			};
		},

		async headObject(input: {
			bucket: string;
			key: string;
		}): Promise<ObjectIdentity> {
			const [md] = await storage
				.bucket(input.bucket)
				.file(input.key)
				.getMetadata();
			return {
				...(md.etag ? { etag: md.etag } : {}),
				// GCS's generation IS the exact-version selector; `etag` is also
				// returned but is not a content digest (it is not md5Hash/crc32c)
				// and is recorded only so a cross-provider reader sees one field.
				...(md.generation ? { generation: String(md.generation) } : {}),
				// `size` arrives as a string on this API; a bare Number of an
				// undefined would be NaN, which would then be stored as a size.
				size: md.size === undefined ? 0 : Number(md.size),
				...(md.updated ? { lastModified: String(md.updated) } : {}),
			};
		},

		async getObject(input: GetObjectInput): Promise<NodeJS.ReadableStream> {
			// Range IS implemented here — the storage-inspection preview calls it —
			// but do NOT read that as "the SDK enforces it". Verified against
			// @google-cloud/storage 7.21.0: `createReadStream({start,end})` consumes
			// start/end in exactly ONE place, building the Range header
			// (file.js:1136-1138). The body is a single
			// `pipeline(rawResponseStream, …)` with no byte counter, no 206 check and
			// no Content-Range check (file.js:1119) — and a ranged read DISABLES
			// crc32c/md5 (file.js:1037,1044), so it carries LESS protection than an
			// unranged one. GCS is no safer client-side than Azure or S3.
			//
			// What makes the Content-Range rail unnecessary here is the ENDPOINT, not
			// the SDK: the client is built without `apiEndpoint`, so the only host it
			// can reach is storage.googleapis.com, which honours Range. The C10
			// threat model behind the rail is customer-configured endpoints
			// (MinIO, Ceph, Linode, OCI) that may ignore it — unreachable from this
			// driver, and `gcs.test.ts` fails if `apiEndpoint` is ever wired in. Add
			// the rail the moment that stops being true.
			//
			// Independently of all that, the inspection worker caps on the bytes that
			// ARRIVE and detects a range-ignoring source, so a non-cooperating
			// endpoint costs the window rather than the object even here.
			/*
			 * Exact-version read (audit CRITICAL-2). GCS does this by SELECTING the
			 * generation on the file handle rather than by a precondition header:
			 * `file(key, { generation })` addresses that generation's bytes, so a
			 * later overwrite cannot be served in its place, and a deleted
			 * generation is a 404 rather than a silent substitution.
			 *
			 * `ifGenerationMatch` is deliberately NOT used instead. It is a
			 * PRECONDITION on the current generation, so it fails once the object
			 * is overwritten — even though the recorded generation may still be
			 * retrievable. Selection is the stronger of the two here, and the one
			 * that matches what the caller means: read the bytes I measured.
			 *
			 * `expect.etag` alone (no generation) cannot be enforced on this path —
			 * `createReadStream` takes no If-Match — so it throws rather than
			 * pretending. It throws the UNSUPPORTED error and not the MISMATCH one:
			 * the bytes may be intact, and telling an operator their source was
			 * overwritten when the real fact is "this driver cannot check" sends
			 * them hunting for an event that never happened.
			 *
			 * In practice an expectation captured by this driver's own
			 * `headObject` always carries a generation; reaching this throw means
			 * an expectation from ANOTHER provider was replayed against GCS, which
			 * is a real bug and deserves to be loud.
			 */
			if (input.expect && !input.expect.generation) {
				throw new VersionExpectationUnsupportedError(
					input.bucket,
					input.key,
					input.expect,
					"GCS pins a version by generation and this expectation carries none (createReadStream cannot send If-Match)",
				);
			}
			const source = storage
				.bucket(input.bucket)
				.file(
					input.key,
					input.expect?.generation
						? { generation: input.expect.generation }
						: undefined,
				)
				// GCS takes start/end directly (end inclusive, same as HTTP Range).
				.createReadStream(
					input.range
						? { start: input.range.start, end: input.range.end }
						: undefined,
				);
			if (!input.expect?.generation) {
				return source;
			}
			/*
			 * ASYMMETRY THIS DRIVER MUST ABSORB, not pass on (review of this PR).
			 *
			 * S3 and Azure reject the awaited `getObject` promise on a failed
			 * precondition, so their `try/catch` above classifies it. GCS does
			 * not: `createReadStream` returns a `PassThroughShim`
			 * SYNCHRONOUSLY and any request failure — including "this
			 * generation is gone" after an overwrite — arrives later as an
			 * async `error` event (`throughStream.destroy(err)`, file.js:1054).
			 *
			 * Left alone, `getObject({ expect })` would RESOLVE for a stale
			 * generation and fail later as a raw, untyped stream error. A
			 * caller writing the obvious `try { await getObject(...) } catch (e)
			 * { e instanceof ObjectVersionMismatchError }` would never catch a
			 * GCS overwrite — the one thing this whole change exists to make
			 * catchable. The contract has to be the same for all three drivers,
			 * so the typed error is re-emitted on the stream, which is the only
			 * place GCS can deliver it.
			 *
			 * A 404 is mapped ONLY when a generation was pinned. Unpinned, a
			 * 404 is an ordinary missing object and stays itself — the same
			 * narrowness the S3 classifier had to be corrected to (a generic
			 * code must not become "your bytes were replaced").
			 */
			const wrapped = new PassThrough();
			source.on("error", (err: unknown) => {
				wrapped.destroy(
					isNotFound(err)
						? new ObjectVersionMismatchError(
								input.bucket,
								input.key,
								input.expect as ObjectVersion,
								err,
							)
						: (err as Error),
				);
			});
			// Destroying the consumer must tear the request down too, or an
			// abandoned read leaks the underlying HTTPS socket.
			wrapped.on("close", () => {
				source.destroy();
			});
			source.pipe(wrapped);
			return wrapped;
		},
	};
}
