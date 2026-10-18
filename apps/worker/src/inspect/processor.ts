import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { redactSecrets, storageInspectJobSchema } from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import {
	type BrowserCredential,
	createBrowserForCredential,
	describeStorageError,
	storageErrorText,
} from "@bitovp/storage";
import { type ProbeResult, parseProbeJson, probeArgs } from "../feeder/command";
import type { ProcessRunner } from "../feeder/supervisor";
import type { ResolvedCredential } from "../orchestrator/executor";

/**
 * Storage object INSPECTION (P5): ffprobe over one object in a customer
 * bucket, so the storage browser can answer "what actually is this file?"
 * before it becomes an encoding input.
 *
 * Why a worker job and not a route: ffprobe lives in the WORKER image (the
 * web app has no binary), and the read touches customer storage with vault
 * credentials.
 *
 * BOUNDED BY DESIGN. A preview must never pull a multi-GB object:
 *  - read a capped HEAD (INSPECT_HEAD_BYTES) and probe that;
 *  - if the head does not parse — the classic non-faststart MP4, whose moov
 *    sits at the END — read a capped TAIL and probe head+tail concatenated.
 *    That is not a valid container in general, but ffprobe recovers the moov
 *    often enough to be worth the second attempt, and the cost stays capped.
 *  - if both fail, record the honest error rather than escalating to a full
 *    download.
 *
 * Ranged reads are a storage-driver capability (GetObjectInput.range) added
 * for exactly this: S3 sends an HTTP Range, GCS passes start/end.
 *
 * A range is a REQUEST, not a guarantee. `Range` is optional in HTTP, and the
 * GenericS3 provider points at arbitrary vendor endpoints (C10: Akamai/Linode,
 * OCI, MinIO, Ceph, …) — a server that ignores it answers 200 with the whole
 * object, and a pipe that trusts the request would then write a multi-GB
 * mezzanine to the worker's disk. So the bound is enforced HERE, on the bytes
 * that actually arrive, in addition to the driver rejecting a response that
 * came back without Content-Range. Two independent layers, because "bounded"
 * has to hold even when the remote end does not cooperate.
 */

/** Head slice size — enough for MP4/MKV/TS headers and a faststart moov. */
export const INSPECT_HEAD_BYTES = 8 * 1024 * 1024;
/** Tail slice for the moov-at-the-end retry. */
export const INSPECT_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * An OPERATOR-facing inspection failure written by US, describing what this
 * pipeline could not do — never a repackaged driver message.
 *
 * The distinction matters because `error` is served verbatim by
 * `GET /api/storage-inspections/[id]`: our own text names the object and the
 * bound we hit and carries no endpoint detail, while a storage-driver message
 * embeds the host/IP/port the worker dialed (C20 — see `describeStorageError`).
 * Anything that is NOT an InspectError is therefore classified before it is
 * persisted.
 */
class InspectError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InspectError";
	}
}

/**
 * ffprobe's `-show_format` always reports `format.filename` — which for us is
 * the WORKER'S SCRATCH PATH (`/tmp/bitovp-vmaf/inspect-<id>.mp4`), not
 * anything about the customer's object. It matches no rule in `redactSecrets`,
 * and the whole probe blob is served to callers, so strip it before persisting:
 * it discloses the worker's filesystem layout and tells an attacker exactly
 * which id maps to which on-disk file.
 */
export function stripProbeScratchPath(probe: ProbeResult): ProbeResult {
	if (!probe.format || !("filename" in probe.format)) {
		return probe;
	}
	const { filename: _filename, ...format } = probe.format as Record<
		string,
		unknown
	>;
	return { ...probe, format: format as ProbeResult["format"] };
}

export type StorageInspectDeps = {
	prisma: AppPrismaClient;
	resolveCredential(credentialId: string): Promise<ResolvedCredential>;
	runner: ProcessRunner;
	ffprobePath: string;
	workDir: string;
	now(): string;
};

type InspectResult = {
	acknowledged: true;
	storageInspectionId: string;
	status: string;
};

type RangeRead = {
	/** Bytes actually written locally — never more than the requested window. */
	bytes: number;
	/**
	 * The source tried to send MORE than the window, i.e. it ignored the range.
	 * The head slice is still exactly the bytes we wanted (a range-ignoring
	 * server starts at 0), but an offset read cannot be trusted: what arrived
	 * begins at byte 0, not at `start`.
	 */
	ignoredRange: boolean;
};

/** Awaits one chunk through the sink, so a slow disk applies backpressure. */
function writeChunk(sink: NodeJS.WritableStream, buf: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		sink.write(buf, (err) => (err ? reject(err) : resolve()));
	});
}

/**
 * Streams AT MOST `end - start + 1` bytes of one range to a local file.
 *
 * The cap is enforced on arrival rather than assumed from the request: leaving
 * the `for await` early destroys the source stream, so a server that ignores
 * the range stops costing us bandwidth and disk at the window size instead of
 * the object size.
 */
async function downloadRange(args: {
	credential: ResolvedCredential;
	bucket: string;
	key: string;
	path: string;
	start: number;
	end: number;
}): Promise<RangeRead> {
	const limit = args.end - args.start + 1;
	const browser = createBrowserForCredential({
		provider: args.credential.provider as BrowserCredential["provider"],
		config: args.credential.config,
		secret: args.credential.secret,
	});
	try {
		if (!browser.getObject) {
			throw new InspectError(
				`storage provider ${args.credential.provider} cannot stream objects — inspection needs a download-capable credential (S3 family or GCS)`,
			);
		}
		const stream = await browser.getObject({
			bucket: args.bucket,
			key: args.key,
			range: { start: args.start, end: args.end },
		});
		// mode 0600: the slice holds CUSTOMER media bytes and lands in a shared
		// workdir (os.tmpdir), where the default 0644 would let any other local
		// account read it for the lifetime of the probe. Applies on creation, and
		// the caller rms the path first, so every slice is created here.
		const sink = createWriteStream(args.path, { flags: "a", mode: 0o600 });
		let bytes = 0;
		let ignoredRange = false;
		// A chunk that writes nothing is not progress, and `for await` DOES deliver
		// zero-length buffers (verified against Readable.from). Without this the
		// loop can run forever on a source that emits only empties: `bytes` never
		// advances, so the window never fills and the "at most N bytes" contract —
		// the entire point of this function — is false. No current driver does it
		// (S3's Body and GCS's createReadStream are network Readables, which do not
		// push empty buffers), so this is the bound holding for a reason rather
		// than by luck.
		let stalledChunks = 0;
		const MAX_STALLED_CHUNKS = 64;
		try {
			for await (const chunk of stream as AsyncIterable<Buffer | string>) {
				const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
				if (buf.length === 0) {
					stalledChunks += 1;
					if (stalledChunks > MAX_STALLED_CHUNKS) {
						throw new InspectError(
							`storage endpoint sent ${MAX_STALLED_CHUNKS} empty chunks in a row for ${args.key} — treating the stream as stalled`,
						);
					}
					continue;
				}
				stalledChunks = 0;
				if (bytes >= limit) {
					// The window is already full and the source is STILL sending: it
					// ignored the range. Detecting this needs the extra chunk —
					// breaking the moment the window fills cannot distinguish "sent
					// exactly what we asked for" from "sent the whole object in
					// chunks that happen to align with our boundary", which is the
					// common case when both sizes are powers of two.
					ignoredRange = true;
					break;
				}
				const room = limit - bytes;
				if (buf.length > room) {
					// Crossed the boundary mid-chunk: also more than we asked for.
					ignoredRange = true;
					await writeChunk(sink, buf.subarray(0, room));
					bytes = limit;
					break;
				}
				await writeChunk(sink, buf);
				bytes += buf.length;
			}
		} catch (err) {
			// Same discipline as the feeder spool: never leave a partial file.
			sink.destroy();
			throw err;
		}
		await new Promise<void>((resolve, reject) => {
			sink.end((err?: Error | null) => (err ? reject(err) : resolve()));
		});
		return { bytes, ignoredRange };
	} finally {
		browser.dispose?.();
	}
}

export function createStorageInspectProcessor(deps: StorageInspectDeps) {
	return async function process(raw: unknown): Promise<InspectResult> {
		const job = storageInspectJobSchema.parse(raw);
		const id = job.storageInspectionId;
		const row = await deps.prisma.storageInspection.findUnique({
			where: { id },
		});
		if (!row) {
			console.warn(`[storage-inspect] inspection ${id} not found — skipping`);
			return { acknowledged: true, storageInspectionId: id, status: "MISSING" };
		}
		// Transition-is-the-lock: only a PENDING row may start, so a redelivered
		// job cannot re-probe (and cannot re-download) an already-finished one.
		const claimed = await deps.prisma.storageInspection.updateMany({
			where: { id, status: "PENDING" },
			data: { status: "RUNNING" },
		});
		if (claimed.count === 0) {
			return {
				acknowledged: true,
				storageInspectionId: id,
				status: row.status,
			};
		}

		const path = join(
			deps.workDir,
			`inspect-${id}${extname(row.objectKey) || ".bin"}`,
		);
		/** Persists an error string WE authored (see `InspectError`). */
		const fail = async (message: string) => {
			await deps.prisma.storageInspection.update({
				where: { id },
				data: { status: "ERROR", error: redactSecrets(message) },
			});
			return {
				acknowledged: true as const,
				storageInspectionId: id,
				status: "ERROR",
			};
		};
		/**
		 * Persists a CLASSIFIED error for anything thrown by the storage driver
		 * (C20): the row's `error` is served verbatim by
		 * `GET /api/storage-inspections/[id]`, and a driver message embeds the
		 * endpoint the worker dialed — `ECONNREFUSED 10.0.7.22:9000` vs
		 * `ENOTFOUND minio.internal.corp` vs `ETIMEDOUT` is a network-probe
		 * oracle for the worker's zone. The full message is logged here instead,
		 * where only an operator can read it.
		 */
		const failFromError = async (err: unknown) => {
			if (err instanceof InspectError) {
				return await fail(err.message);
			}
			const { code, status } = describeStorageError(err);
			console.error(
				`[storage-inspect] inspection ${id} failed:`,
				code,
				status ?? "",
				err instanceof Error ? err.message : err,
			);
			return await fail(storageErrorText(err));
		};
		try {
			await mkdir(deps.workDir, { recursive: true });
			await rm(path, { force: true });
			const credential = await deps.resolveCredential(row.credentialId);
			const head = await downloadRange({
				credential,
				bucket: row.bucket,
				key: row.objectKey,
				path,
				start: 0,
				end: INSPECT_HEAD_BYTES - 1,
			});
			let bytesRead = head.bytes;

			let probe: ProbeResult | undefined;
			const runProbe = async (): Promise<ProbeResult | undefined> => {
				const result = await deps.runner.run(deps.ffprobePath, probeArgs(path));
				if (result.code !== 0) {
					return undefined;
				}
				try {
					return parseProbeJson(result.stdout);
				} catch {
					return undefined;
				}
			};
			probe = await runProbe();
			let tailRead = false;
			if (!probe?.streams?.length) {
				// The moov-at-the-end retry: append a capped tail and probe again.
				// Range start is negative-from-end via an open-ended read on the
				// last INSPECT_TAIL_BYTES; drivers take absolute offsets, so this
				// needs the object size, which we do not have — an open-ended read
				// from a large offset would 416 on a small object. Instead read the
				// NEXT slice: for most non-faststart files the moov lands within
				// head+tail of the front. Honest about the limit in the error.
				// Skipped when the head read proved the source ignores ranges: an
				// offset read from such a server returns byte 0 again, so
				// appending it would hand ffprobe a spliced duplicate of the head
				// and any streams it then reported would be a lie about the file.
				// : when the LISTING's size rode in on the row, aim the
				// retry at the TRUE tail — where a non-faststart moov actually
				// lives — instead of the next-slice approximation. Clamped so a
				// small object degenerates to exactly the old next-slice window,
				// and still Content-Range-guarded: a stale size cannot UNBOUND the
				// read (a wrong-but-in-range size can still land mid-file bytes —
				// review of PR #175, S1 — the guard is the bound, not the aim).
				const size =
					row.objectSize === null ? undefined : Number(row.objectSize);
				// size <= head: the WHOLE object already arrived in the head slice —
				// no tail exists, and an offset read is a guaranteed 416 (review of
				// PR #175, I3: a doomed round-trip under a message claiming an
				// unread middle that does not exist).
				const wholeObjectInHead =
					size !== undefined && size <= INSPECT_HEAD_BYTES;
				if (!head.ignoredRange && !wholeObjectInHead) {
					const tailStart =
						size !== undefined && size > INSPECT_HEAD_BYTES + INSPECT_TAIL_BYTES
							? size - INSPECT_TAIL_BYTES
							: INSPECT_HEAD_BYTES;
					const tail = await downloadRange({
						credential,
						bucket: row.bucket,
						key: row.objectKey,
						path,
						start: tailStart,
						end: tailStart + INSPECT_TAIL_BYTES - 1,
					}).catch(() => ({ bytes: 0, ignoredRange: false }) as RangeRead);
					bytesRead += tail.bytes;
					tailRead = tail.bytes > 0 && !tail.ignoredRange;
					if (tailRead) {
						probe = await runProbe();
					}
				}
			}
			if (!probe?.streams?.length) {
				return await fail(
					`ffprobe found no streams in the ${Math.round(
						bytesRead / (1024 * 1024),
					)} MB probed from ${row.objectKey}${
						tailRead && row.objectSize !== null ? " (head + true tail)" : ""
					} — ${
						row.objectSize !== null &&
						Number(row.objectSize) <= INSPECT_HEAD_BYTES
							? "the WHOLE object was read, so this is not an index-placement problem: ffprobe does not recognise it as media"
							: tailRead && row.objectSize !== null
								? "the container's index may sit in the unread middle of the file"
								: "the container's index may sit at the end of the file (a non-faststart MP4), which a bounded preview cannot reach"
					}` +
						(head.ignoredRange
							? ". The storage endpoint also ignored the byte-range request, so the tail retry was skipped: it would have re-read the start of the file"
							: ""),
				);
			}
			await deps.prisma.storageInspection.update({
				where: { id },
				data: {
					status: "FINISHED",
					probe: redactSecrets(
						stripProbeScratchPath(probe),
					) as unknown as Prisma.InputJsonValue,
					bytesRead,
					error: null,
				},
			});
			return {
				acknowledged: true,
				storageInspectionId: id,
				status: "FINISHED",
			};
		} catch (err) {
			return await failFromError(err);
		} finally {
			// The slice is scratch — never keep customer bytes on the worker.
			await rm(path, { force: true }).catch(() => {});
		}
	};
}

export type StorageInspectProcessor = ReturnType<
	typeof createStorageInspectProcessor
>;

/**
 * The bounded probe as a REUSABLE capability .
 *
 * `createStorageInspectProcessor` above is the operator-facing product: it
 * owns a row, an error vocabulary and a bytes-read receipt. The slate
 * compatibility gate needs the same two ranged reads and the same ffprobe,
 * and nothing else — no row, no persistence — so it gets the machinery
 * rather than a second copy of `downloadRange`.
 *
 * Deliberately BEST-EFFORT: every failure answers `null`, because the caller
 * is a preflight. A slate that cannot be probed (a provider without ranged
 * reads, an endpoint that ignores `Range`, a non-faststart file whose moov
 * sits past the bounded window) must register exactly as it did before this
 * existed — refusing what we could not measure would turn an unprobeable
 * clip into a scheduled failure, which is the opposite of the point.
 *
 * Bounded the same way and for the same reason: at most
 * INSPECT_HEAD_BYTES + INSPECT_TAIL_BYTES ever reach the worker's disk, and
 * the slice is removed in a `finally`.
 */
export type BoundedObjectProbeDeps = {
	resolveCredential(credentialId: string): Promise<ResolvedCredential>;
	runner: ProcessRunner;
	ffprobePath: string;
	workDir: string;
};

export type BoundedObjectProbe = (args: {
	/** Names the scratch file; never customer-derived. */
	label: string;
	credentialId: string;
	bucket: string;
	key: string;
}) => Promise<ProbeResult | null>;

export function createBoundedObjectProbe(
	deps: BoundedObjectProbeDeps,
): BoundedObjectProbe {
	return async function probeObject(args) {
		const path = join(
			deps.workDir,
			`probe-${args.label}${extname(args.key) || ".bin"}`,
		);
		const runProbe = async (): Promise<ProbeResult | undefined> => {
			const result = await deps.runner.run(deps.ffprobePath, probeArgs(path));
			if (result.code !== 0) {
				return undefined;
			}
			try {
				return parseProbeJson(result.stdout);
			} catch {
				return undefined;
			}
		};
		try {
			await mkdir(deps.workDir, { recursive: true });
			await rm(path, { force: true });
			const credential = await deps.resolveCredential(args.credentialId);
			const head = await downloadRange({
				credential,
				bucket: args.bucket,
				key: args.key,
				path,
				start: 0,
				end: INSPECT_HEAD_BYTES - 1,
			});
			let probe = await runProbe();
			if (!probe?.streams?.length && !head.ignoredRange) {
				// The moov-at-the-end retry, in its next-slice form: no listing
				// size rides along here, so the true tail cannot be aimed at.
				const tail = await downloadRange({
					credential,
					bucket: args.bucket,
					key: args.key,
					path,
					start: INSPECT_HEAD_BYTES,
					end: INSPECT_HEAD_BYTES + INSPECT_TAIL_BYTES - 1,
				}).catch(() => ({ bytes: 0, ignoredRange: false }) as RangeRead);
				if (tail.bytes > 0 && !tail.ignoredRange) {
					probe = await runProbe();
				}
			}
			return probe?.streams?.length ? probe : null;
		} catch (err) {
			// Logged, never surfaced: the caller's contract is "no measurement"
			// and a storage-driver message names the endpoint we dialed (C20).
			console.warn(
				`[probe-object] could not probe ${args.label}:`,
				err instanceof Error ? err.message : err,
			);
			return null;
		} finally {
			await rm(path, { force: true }).catch(() => {});
		}
	};
}
