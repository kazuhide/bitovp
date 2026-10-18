import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import {
	assertCompleteTransfer,
	type BrowserCredential,
	createBrowserForCredential,
	type ObjectIdentity,
	ObjectVersionMismatchError,
	pipeWithDigest,
	ShortReadError,
	VersionExpectationUnsupportedError,
} from "@bitovp/storage";
import type { ResolvedCredential } from "../orchestrator/executor";
import { cachedVmafInput } from "./input-cache";

/**
 * Object-storage download for the VMAF runner (P4-PR3). Generalizes the
 * feeder's fetch-source: streams browser.getObject(bucket,key) → a caller-
 * chosen local path. Used for BOTH sides of the comparison — the reference
 * (the encoding's source mezzanine, via the input credential) and the
 * distorted (`qc/<key>.mp4`, or `.webm` for VP9 — , via the output
 * credential).
 *
 * ANY failure destroys both stream ends and removes the partial file so a
 * failed download never leaks disk in VMAF_WORKDIR. Reset aborts the transfer when its owning job is deleted.
 */

export type VmafDownloadArgs = {
	signal?: AbortSignal;
	credential: ResolvedCredential;
	bucket: string;
	key: string;
	/** Absolute destination path (the runner picks it under the work dir). */
	destPath: string;
	/**
	 * Human label for the side being fetched ("reference source for rendition
	 * v360", "distorted qc mirror …"). Prepended — with the bucket/key — to any
	 * download failure so a storage 404 ("The specified key does not exist.")
	 * names WHICH object is missing and WHERE, instead of a bare message the
	 * operator can't act on. bucket/key are storage locations, not secrets.
	 */
	label?: string;
};

/**
 * What a download actually fetched
: the provider's version identity read BEFORE the transfer and
 * demanded during it, and a streaming SHA-256 of the bytes that arrived. A
 * same-size overwrite between encode and scoring used to hand VMAF the wrong
 * bytes with a plausible score; a result row now says which object it
 * compared, and a re-read can demand the same version.
 *
 * `pinned: false` means the driver could not express the version expectation
 * (`VersionExpectationUnsupportedError`) or offers no `headObject` — the bytes
 * were read unconditionally and the digest is the only identity. That is a
 * limitation named, not a mismatch hidden.
 */
export type DownloadProvenance = {
	bucket: string;
	key: string;
	identity?: ObjectIdentity;
	pinned: boolean;
	sha256: string;
	bytes: number;
};

export type VmafDownload = (
	args: VmafDownloadArgs,
) => Promise<DownloadProvenance>;

export function defaultVmafDownload(
	args: VmafDownloadArgs,
): Promise<DownloadProvenance> {
	return downloadObject(args);
}

/**
 * `${label} (s3://bucket/key): <original message>` — locates a 404/transfer
 * failure.
 *
 * The two TYPED failures keep their class (review-332): `ObjectVersionMismatchError`
 * ("the object changed under us") and `ShortReadError` exist so a caller can
 * tell them from a transport failure by `instanceof` — a generic error looks
 * retryable, and neither of these ever is. Re-wrapping them in `new Error`
 * erased exactly that distinction at the one boundary the processor reads.
 * They are located in place (message prefixed, fields and class intact);
 * everything else is wrapped with the original as `cause`.
 */
export function locate(args: VmafDownloadArgs, err: unknown): Error {
	const where = `${args.label ?? "object"} (s3://${args.bucket}/${args.key})`;
	if (
		err instanceof ObjectVersionMismatchError ||
		err instanceof ShortReadError
	) {
		err.message = `${where}: ${err.message}`;
		return err;
	}
	const reason = err instanceof Error ? err.message : String(err);
	return new Error(`${where}: ${reason}`, { cause: err });
}

async function downloadObject(
	args: VmafDownloadArgs,
): Promise<DownloadProvenance> {
	args.signal?.throwIfAborted();
	const browser = createBrowserForCredential({
		provider: args.credential.provider as BrowserCredential["provider"],
		config: args.credential.config,
		secret: args.credential.secret,
	});
	try {
		if (!browser.getObject) {
			throw new Error(
				`storage provider ${args.credential.provider} cannot stream objects — VMAF needs a download-capable credential (S3 family or GCS) for both the source input and the qc output`,
			);
		}
		// The version identity FIRST, then a read that demands it: the two
		// calls are what turn "whatever is at the key now" into "this object".
		let identity: ObjectIdentity | undefined;
		if (browser.headObject) {
			try {
				identity = await browser.headObject({
					bucket: args.bucket,
					key: args.key,
				});
			} catch (err) {
				throw locate(args, err);
			}
		}
		const cached = await cachedVmafInput(args, identity);
		if (cached) return cached;
		let pinned = identity !== undefined;
		let stream: NodeJS.ReadableStream;
		try {
			stream = await browser.getObject({
				bucket: args.bucket,
				key: args.key,
				...(identity ? { expect: identity } : {}),
			});
		} catch (err) {
			if (err instanceof VersionExpectationUnsupportedError) {
				// The driver cannot express the expectation (GCS with an etag-only
				// identity, for one): read unconditionally and SAY the version was
				// not pinned. A mismatch is a different error and is not swallowed.
				pinned = false;
				try {
					stream = await browser.getObject({
						bucket: args.bucket,
						key: args.key,
					});
				} catch (inner) {
					throw locate(args, inner);
				}
			} else {
				throw locate(args, err);
			}
		}
		const sink = createWriteStream(args.destPath);
		const abort = () => {
			const error = new Error("VMAF download canceled");
			(stream as { destroy?(error?: Error): void }).destroy?.(error);
			sink.destroy(error);
		};
		args.signal?.addEventListener("abort", abort, { once: true });
		try {
			const transferPromise = pipeWithDigest(stream, sink);
			if (args.signal?.aborted) abort();
			const transfer = await transferPromise;
			if (identity) {
				// A short (or long) read is not this object either.
				assertCompleteTransfer(transfer, identity.size);
			}
			return {
				bucket: args.bucket,
				key: args.key,
				...(identity ? { identity } : {}),
				pinned,
				sha256: transfer.sha256,
				bytes: transfer.bytes,
			};
		} catch (err) {
			// pipeline destroys its streams on failure, but a wrapped source may
			// not propagate — destroy both ends, then remove the partial file.
			(stream as { destroy?(error?: Error): void }).destroy?.();
			sink.destroy();
			await rm(args.destPath, { force: true }).catch(() => {});
			throw locate(args, err);
		} finally {
			args.signal?.removeEventListener("abort", abort);
		}
	} finally {
		browser.dispose?.();
	}
}
