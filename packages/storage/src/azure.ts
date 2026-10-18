import type { BlobItem } from "@azure/storage-blob";
import {
	BlobServiceClient,
	StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { bucketAddressing } from "@bitovp/core";
import {
	clampLimit,
	type GetObjectInput,
	type ListObjectsInput,
	type ListObjectsResult,
	type ObjectIdentity,
	type ObjectStorageBrowser,
	ObjectVersionMismatchError,
	type StorageObject,
	UnsupportedBrowseError,
} from "./types";

/**
 * Azure answers a failed `ifMatch` with 412 ConditionNotMet. The SDK exposes
 * the status on `statusCode`; the error code string is checked too because the
 * shape differs between the REST error and a wrapped RestError.
 *
 * `BlobNotFound` (404) is the OTHER half, and it is the Azure twin of S3's
 * `NoSuchVersion` (review of this PR). Addressing a blob by `?versionid=` for a
 * version that has been deleted or purged resolves to "does not exist" — 404,
 * not 412, because there is no resource left to evaluate an `If-Match` against.
 * From the caller's side that is the same condition as a failed precondition:
 * the recorded bytes are not retrievable, and the recovery is to re-record,
 * never to retry.
 *
 * It is admitted ONLY when a versionId was actually sent, which is the same
 * narrowness the S3 classifier had to be corrected to and the same scope the
 * GCS wrapper uses. Without a version selector a `BlobNotFound` means the blob
 * is simply gone — a missing object, not a replaced one — and calling that an
 * overwrite would invent an event.
 *
 * Scoped to `BlobNotFound` specifically and NOT to any 404: `ContainerNotFound`
 * is a different code for a different failure class (a bucket/config problem,
 * not object identity) and must not be swept in.
 */
function isAzurePreconditionFailure(
	err: unknown,
	versionPinned: boolean,
): boolean {
	const e = err as {
		statusCode?: unknown;
		code?: unknown;
		details?: { errorCode?: unknown };
	};
	if (e?.statusCode === 412) {
		return true;
	}
	const code = String(e?.code ?? e?.details?.errorCode ?? "");
	if (code === "ConditionNotMet") {
		return true;
	}
	return versionPinned && code === "BlobNotFound";
}

export type AzureBrowserOptions = {
	/** Storage account name (credential config); the host is derived from it. */
	accountName: string;
	/** Shared key (credential secret) — base64 as Azure issues it. */
	accountKey: string;
	/** Opt-in readiness reads; existing browsing defaults stay unchanged. */
	readTimeoutMs?: number;
};

/** Reads one page without letting the SDK iterator auto-page (C6 mindset). */
async function firstPage<T>(
	pages: AsyncIterableIterator<T>,
): Promise<T | undefined> {
	const first = await pages.next();
	return first.done ? undefined : first.value;
}

function mapBlobs(
	items: BlobItem[] | undefined,
	prefix: string | undefined,
): StorageObject[] {
	return (
		(items ?? [])
			// Only a directory-prefix match is a marker; retain exact file-prefix
			// matches for bounded metadata lookups, including zero-byte files.
			.filter((item) => !(item.name === prefix && item.name.endsWith("/")))
			.map((item) => ({
				key: item.name,
				size: item.properties.contentLength ?? 0,
				lastModified: item.properties.lastModified?.toISOString(),
			}))
	);
}

/**
 * Azure Blob Storage via shared-key auth. Container = bucket, and Azure uses
 * the same prefix + delimiter virtual-hierarchy convention as S3, so the
 * browsing contract maps 1:1.
 */
export function createAzureBrowser(
	options: AzureBrowserOptions,
): ObjectStorageBrowser {
	if (!options.accountName || !options.accountKey) {
		throw new UnsupportedBrowseError(
			"Azure credential is missing the account name or key — re-enter it in Settings → Credentials",
		);
	}
	// Global cloud only: the credential carries just an account name, and
	// Bitmovin's AzureInput/AzureOutput models are host-less too, so sovereign
	// clouds (core.chinacloudapi.cn / core.usgovcloudapi.net) are out of reach
	// for browsing AND encoding I/O alike .
	const service = new BlobServiceClient(
		// Shared with the public playback-URL builder, so a blob this driver
		// lists and a blob the player fetches are the same host.
		bucketAddressing("AZURE_BLOB", { accountName: options.accountName })
			?.origin ?? "",
		new StorageSharedKeyCredential(options.accountName, options.accountKey),
		...(options.readTimeoutMs === undefined
			? []
			: [
					{
						retryOptions: {
							maxTries: 1,
							tryTimeoutInMs: options.readTimeoutMs,
						},
					},
				]),
	);

	return {
		async listBuckets(): Promise<string[]> {
			// Auto-paged by the SDK iterator (5000 containers/page): a media
			// account has tens of containers, matching the S3 driver's take on
			// ListBuckets.
			const names: string[] = [];
			for await (const container of service.listContainers()) {
				names.push(container.name);
			}
			return names;
		},

		async listObjects(input: ListObjectsInput): Promise<ListObjectsResult> {
			const container = service.getContainerClient(input.bucket);
			const listOptions = { prefix: input.prefix };
			const pageSettings = {
				// An EMPTY-STRING continuation token makes the SDK's paging
				// generator yield nothing at all (it only starts when the marker is
				// truthy or undefined), so a blank cursor must become undefined.
				continuationToken: input.cursor || undefined,
				maxPageSize: clampLimit(input.limit),
			};
			if (input.recursive) {
				const page = await firstPage(
					container.listBlobsFlat(listOptions).byPage(pageSettings),
				);
				return {
					prefixes: [],
					objects: mapBlobs(page?.segment.blobItems, input.prefix),
					// Azure signals end-of-listing with an EMPTY continuation token,
					// not an absent one (C23).
					nextCursor: page?.continuationToken || undefined,
				};
			}
			// Non-recursive ⇒ the "/" delimiter collapses deeper keys into
			// blobPrefixes, exactly like S3's CommonPrefixes.
			const page = await firstPage(
				container.listBlobsByHierarchy("/", listOptions).byPage(pageSettings),
			);
			return {
				prefixes: (page?.segment.blobPrefixes ?? []).map((p) => p.name),
				objects: mapBlobs(page?.segment.blobItems, input.prefix),
				// Same empty-token terminator as the recursive branch above — this is
				// the branch folder-by-folder browsing uses, and a "" reaching the UI
				// makes hasNextPage true while "Load more" re-sends no cursor.
				nextCursor: page?.continuationToken || undefined,
			};
		},

		async headObject(input: {
			bucket: string;
			key: string;
		}): Promise<ObjectIdentity> {
			const props = await service
				.getContainerClient(input.bucket)
				.getBlobClient(input.key)
				.getProperties();
			return {
				// Verbatim, quotes included — the same string goes back in ifMatch.
				...(props.etag ? { etag: props.etag } : {}),
				// Present only on a version-enabled account; absent is normal.
				...(props.versionId ? { versionId: props.versionId } : {}),
				size: props.contentLength ?? 0,
				...(props.lastModified
					? { lastModified: props.lastModified.toISOString() }
					: {}),
			};
		},

		async getObject(input: GetObjectInput): Promise<NodeJS.ReadableStream> {
			const blob = service
				.getContainerClient(input.bucket)
				.getBlobClient(input.key);
			// download takes (offset, count) where count is a LENGTH, while
			// range.end is the INCLUSIVE last byte: count = end - start + 1.
			// A count that is not >= 1 must never reach the SDK — rangeToString
			// treats a falsy count as "no count" and sends an open-ended
			// `bytes=offset-`, i.e. the whole rest of the blob (and a negative one
			// throws RangeError).
			//
			// `!(count >= 1)` rather than `count < 1`, so NaN is caught: `NaN < 1`
			// is false, so a NaN `end` slipped through to become exactly the
			// open-ended read this guard exists to prevent — and at start 0 it also
			// desynchronised the driver from the SDK (the SDK's `!count` is true, so
			// no header goes out, while `count === undefined` is false, so the guard
			// below demands a Content-Range that can never arrive). Degenerate input
			// only — `end` is typed `number` — but the comment above was false
			// without it (review catch).
			let count: number | undefined;
			if (input.range?.end !== undefined) {
				count = input.range.end - input.range.start + 1;
				if (!(count >= 1)) {
					throw new Error(
						`invalid byte range for ${input.key}: end ${input.range.end} is before start ${input.range.start}`,
					);
				}
			}
			const start = input.range?.start ?? 0;
			/*
			 * Exact-version read (audit CRITICAL-2). `ifMatch` refuses a
			 * substitute; `versionId` selects one when the account has versioning
			 * on. The version is selected on the CLIENT (`withVersion`) because
			 * `download` has no versionId option.
			 */
			const versioned = input.expect?.versionId
				? blob.withVersion(input.expect.versionId)
				: blob;
			let res: Awaited<ReturnType<typeof blob.download>>;
			try {
				// TWO arguments when there is no condition, deliberately. Passing an
				// explicit `undefined` third argument is identical to Azure, but it
				// changes the observable call, and five existing range tests assert
				// the exact argument list. The unconditional path is not what this
				// change is about, so it stays byte-for-byte the call it was.
				res = input.expect?.etag
					? await versioned.download(start, count, {
							conditions: { ifMatch: input.expect.etag },
						})
					: await versioned.download(start, count);
			} catch (err) {
				if (
					input.expect &&
					isAzurePreconditionFailure(err, Boolean(input.expect.versionId))
				) {
					throw new ObjectVersionMismatchError(
						input.bucket,
						input.key,
						input.expect,
						err,
					);
				}
				throw err;
			}
			const body = res.readableStreamBody;
			// Node yields a Readable; undefined would mean a browser runtime, which
			// no caller of this package runs in.
			if (!body) {
				throw new Error("Azure blob download returned no readable body stream");
			}
			// The SDK does NOT clamp the stream to the requested count: download
			// hands RetriableReadableStream the SERVER-reported contentLength
			// (verified in @azure/storage-blob 12.33.0's Clients.js), so a reply
			// that ignored the Range header streams the WHOLE blob and ends
			// cleanly. Callers ask for a range to bound what they read, so require
			// the proof that it was applied.
			//
			// But only when a Range header actually went out. Clients.js:285 reads
			//   range: offset === 0 && !count ? void 0 : rangeToString({offset,count})
			// so an open-ended read from byte 0 — `range: {start: 0}`, legal because
			// `end` is optional — is transmitted as a plain unranged GET, and a
			// FULLY COMPLIANT Azure answers 200 with no Content-Range. Testing
			// `input.range` for truthiness would reject that legal input, so mirror
			// the SDK's own condition instead. (`count` here is undefined or ≥ 1 —
			// the check above rejects the rest — so `count === undefined` is exactly
			// the SDK's `!count`.)
			const sentRangeHeader = !(start === 0 && count === undefined);
			if (sentRangeHeader && !res.contentRange) {
				(body as unknown as { destroy?: () => void }).destroy?.();
				throw new Error(
					`storage endpoint ignored the byte-range request for ${input.key} ` +
						"(no Content-Range in the response), so the reply is the whole " +
						"object rather than the requested slice",
				);
			}
			return body;
		},

		dispose(): void {
			// @azure/storage-blob has no client teardown: its core-rest-pipeline
			// HTTP client owns the keep-alive agents and exposes no close. The
			// method exists so callers keep one uniform finally block per driver.
		},
	};
}
