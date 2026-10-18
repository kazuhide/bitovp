import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import type { SourceIdentity } from "@bitovp/core";
import {
	assertCompleteTransfer,
	type BrowserCredential,
	createBrowserForCredential,
	type ObjectIdentity,
	type ObjectVersion,
	ObjectVersionMismatchError,
	pipeWithDigest,
	VersionExpectationUnsupportedError,
} from "@bitovp/storage";
import type { ResolvedCredential } from "../orchestrator/executor";

/**
 * Source spool download for the feeder (P3-PR3): streams
 * browser.getObject → local spool file. Extracted from the processor so
 * the failure/abort cleanup contract is testable against real fs with a
 * faked storage browser:
 * - the transfer runs under the caller's AbortSignal — a stop during
 *   DOWNLOADING aborts the in-flight stream promptly instead of letting a
 *   multi-GB download finish first;
 * - ANY failure (network error, abort, disk full) destroys both stream
 *   ends and removes the partial spool file — failed downloads never leak
 *   disk in FEEDER_SPOOL_DIR.
 *
 *  (audit 2026-08-29 HIGH-4) added the third contract: the download
 * DEMANDS the version the operator armed against. bucket/key name a location
 * and a location is not a version — an object replaced under the same key
 * between arm and air used to be pushed silently, and the aired bytes could
 * not be told from the chosen ones afterwards. The seal is captured by
 * `headObject` when the session is created (see `sealSourceIdentity` below)
 * and enforced here in three layers, because no single one covers every
 * driver:
 *
 *  1. a HEAD before the transfer, compared field-by-field against the seal —
 *     works on every driver that has `headObject`, and refuses BEFORE moving
 *     gigabytes;
 *  2. `getObject({ expect })`, which the driver turns into an exact-version
 *     selector and/or precondition (S3 VersionId + If-Match, GCS a
 *     generation-pinned handle, Azure ifMatch) — the only layer that closes
 *     the window between the HEAD and the read;
 *  3. `assertCompleteTransfer` against the sealed size, so a truncated or
 *     swapped object fails instead of reaching ffmpeg.
 *
 * A seal is optional throughout. Sessions created before this existed, and
 * drivers with no `headObject`, carry none — and "nothing to demand" is the
 * pre-seal behaviour, named rather than pretended away.
 */

export type FetchedSource = {
	path: string;
	/**
	 * : SHA-256 of the bytes that actually arrived, computed while
	 * streaming to the spool — never a second read of the file. The seal
	 * proves the right version was requested; this proves what was received.
	 */
	sha256: string;
	bytes: number;
	/**
	 * Whether the driver could EXPRESS the version expectation on the read
	 * (layer 2). False means only layers 1 and 3 ran: a limitation named, not
	 * a mismatch hidden.
	 */
	pinned: boolean;
	cleanup(): Promise<void>;
};

export type FetchSourceArgs = {
	sessionId: string;
	credential: ResolvedCredential;
	bucket: string;
	key: string;
	/** Aborted when a stop lands during DOWNLOADING — cancels the transfer. */
	signal: AbortSignal;
	/** : the version sealed at arm. Absent = nothing to demand. */
	expect?: SourceIdentity;
};

export type FetchSource = (args: FetchSourceArgs) => Promise<FetchedSource>;

/** The version SELECTORS of a seal — everything a driver can act on. */
function versionOf(identity: SourceIdentity): ObjectVersion {
	return {
		...(identity.etag !== undefined ? { etag: identity.etag } : {}),
		...(identity.versionId !== undefined
			? { versionId: identity.versionId }
			: {}),
		...(identity.generation !== undefined
			? { generation: identity.generation }
			: {}),
	};
}

/** `etag "abc", size 12` — operator-facing, and stable across both sides. */
function describeIdentity(identity: SourceIdentity | ObjectIdentity): string {
	const named = [
		identity.etag !== undefined ? `etag ${identity.etag}` : null,
		identity.versionId !== undefined ? `versionId ${identity.versionId}` : null,
		identity.generation !== undefined
			? `generation ${identity.generation}`
			: null,
		`size ${identity.size}`,
	].filter((part) => part !== null);
	return named.join(", ");
}

/**
 * Layer 1. Compare only the fields the SEAL carries: a provider that stopped
 * reporting `versionId` (an unversioned bucket) must not read as an overwrite,
 * and a field the seal never had proves nothing either way. Size is always
 * compared — every driver reports it.
 */
function identityDiffers(
	sealed: SourceIdentity,
	observed: ObjectIdentity,
): boolean {
	if (sealed.etag !== undefined && observed.etag !== sealed.etag) {
		return true;
	}
	if (
		sealed.versionId !== undefined &&
		observed.versionId !== sealed.versionId
	) {
		return true;
	}
	if (
		sealed.generation !== undefined &&
		observed.generation !== sealed.generation
	) {
		return true;
	}
	return observed.size !== sealed.size;
}

/**
 * : read the object's version identity WITHOUT transferring it — the
 * capture half of the seal, used by every door that creates a feeder session
 * (the arm route, the create route's derived rows, the scheduler's own session
 * creation) so the capture rule lives in ONE place.
 *
 * Returns null when the driver has no `headObject`. A driver that cannot name
 * a version cannot be made to prove one, and refusing the feed for that would
 * turn a driver limitation into an outage; the download then behaves exactly
 * as it did before the seal existed.
 *
 * Throws whatever the provider throws for a missing object — deliberately: a
 * source that does not exist at ARM time is worth refusing at the door rather
 * than at air.
 */
export async function sealSourceIdentity(
	credential: ResolvedCredential,
	bucket: string,
	key: string,
): Promise<SourceIdentity | null> {
	const browser = createBrowserForCredential({
		provider: credential.provider as BrowserCredential["provider"],
		config: credential.config,
		secret: credential.secret,
	});
	try {
		if (!browser.headObject) {
			return null;
		}
		const identity = await browser.headObject({ bucket, key });
		return {
			...(identity.etag !== undefined ? { etag: identity.etag } : {}),
			...(identity.versionId !== undefined
				? { versionId: identity.versionId }
				: {}),
			...(identity.generation !== undefined
				? { generation: identity.generation }
				: {}),
			size: identity.size,
		};
	} finally {
		browser.dispose?.();
	}
}

export function createDefaultFetchSource(spoolDir: string): FetchSource {
	return async function fetchSource(args) {
		const browser = createBrowserForCredential({
			provider: args.credential.provider as BrowserCredential["provider"],
			config: args.credential.config,
			secret: args.credential.secret,
		});
		try {
			if (!browser.getObject) {
				throw new Error(
					`storage provider ${args.credential.provider} cannot stream objects — the feeder needs a download-capable source credential (S3 family or GCS)`,
				);
			}
			const sealed = args.expect;
			// Layer 1: refuse BEFORE moving the bytes. A replaced object is the
			// common case this catches, and catching it here costs one HEAD
			// instead of a multi-GB transfer.
			if (sealed && browser.headObject) {
				const observed = await browser.headObject({
					bucket: args.bucket,
					key: args.key,
				});
				if (identityDiffers(sealed, observed)) {
					const err = new ObjectVersionMismatchError(
						args.bucket,
						args.key,
						versionOf(sealed),
					);
					// Both sides, verbatim: the operator's question is "which
					// bytes aired", and only naming BOTH answers it.
					err.message = `${err.message} — sealed at arm: ${describeIdentity(sealed)}; found now: ${describeIdentity(observed)}`;
					throw err;
				}
			}
			await mkdir(spoolDir, { recursive: true });
			// Keep the source extension so ffprobe/ffmpeg demuxer hints hold.
			const path = join(
				spoolDir,
				`${args.sessionId}${extname(args.key) || ".mp4"}`,
			);
			const version = sealed ? versionOf(sealed) : {};
			const canPin = Object.keys(version).length > 0;
			let pinned = canPin;
			let stream: NodeJS.ReadableStream;
			try {
				// Layer 2: the only check that closes the HEAD→read window.
				stream = await browser.getObject({
					bucket: args.bucket,
					key: args.key,
					...(canPin ? { expect: version } : {}),
				});
			} catch (err) {
				if (err instanceof VersionExpectationUnsupportedError) {
					// The driver cannot express this expectation (GCS with an
					// etag-only seal). Read unconditionally and SAY so — layers 1
					// and 3 still ran. A real mismatch is a different error and is
					// not swallowed here.
					pinned = false;
					stream = await browser.getObject({
						bucket: args.bucket,
						key: args.key,
					});
				} else {
					throw err;
				}
			}
			const sink = createWriteStream(path);
			try {
				const transfer = await pipeWithDigest(stream, sink, {
					signal: args.signal,
				});
				if (sealed) {
					// Layer 3: a short (or long) read is not this object either.
					assertCompleteTransfer(transfer, sealed.size);
				}
				return {
					path,
					sha256: transfer.sha256,
					bytes: transfer.bytes,
					pinned,
					cleanup: async () => {
						await rm(path, { force: true });
					},
				};
			} catch (err) {
				// pipeline destroys its streams on failure/abort, but a legacy
				// or wrapped source may not propagate — destroy both ends
				// explicitly, then remove the partial spool file.
				(stream as { destroy?(error?: Error): void }).destroy?.();
				sink.destroy();
				await rm(path, { force: true }).catch(() => {});
				throw err;
			}
		} finally {
			browser.dispose?.();
		}
	};
}
