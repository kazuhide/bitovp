import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Streaming SHA-256 over bytes that are being moved anyway —
 * CRITICAL-2, slice 1.
 *
 * The audit's requirement is a digest recorded at ingest/feed/capture and
 * re-derived at read time. Hashing has to be free of a second pass: the objects
 * are mezzanine sources and encode outputs, so "download it, then hash the
 * file" doubles the disk read on every measurement and cannot work at all for a
 * stream that is being consumed rather than saved.
 *
 * So the hash rides the existing pipeline as a pass-through. The digest is only
 * available AFTER the pipeline resolves, which is why this returns the value
 * rather than exposing the transform — a caller holding the transform can read
 * `.digest` early and get the hash of a prefix, which is indistinguishable
 * from the real thing until the day it isn't.
 *
 * WHAT THIS CANNOT TELL YOU, and the caller must: a source that ends EARLY but
 * CLEANLY produces no error, so both functions below resolve with the honest
 * digest of a short read. Nothing at the stream layer distinguishes "the object
 * is 40 MB" from "the connection closed politely after 12 MB" — an error path
 * would be a lie in the other direction. That is why `bytes` is returned beside
 * the hash and is not decoration: a caller recording an object's digest MUST
 * compare it against the `size` from `headObject`, and treat a mismatch as a
 * failed transfer rather than as a new digest for that object. Storing a
 * prefix's hash as the object's identity would make every later verification
 * fail against bytes that never changed — the same wrong-direction alarm the
 * two error classes in `./types` exist to avoid.
 */

export type DigestedTransfer = {
	/** Lowercase hex, 64 chars. */
	sha256: string;
	/** Bytes that actually passed through — not what any header claimed. */
	bytes: number;
};

/**
 * Pipe `source` into `sink`, returning the digest and byte count of what
 * passed. Rejects if either end fails (an aborted signal included); the caller
 * owns cleanup of a partial destination, exactly as it did before this existed.
 */
export async function pipeWithDigest(
	source: NodeJS.ReadableStream,
	sink: NodeJS.WritableStream,
	/**
	 * : an optional AbortSignal, forwarded to `pipeline` verbatim.
	 *
	 * The feeder spools multi-GB sources and must cancel promptly when a stop
	 * lands mid-DOWNLOADING; it used to call `pipeline` directly for exactly
	 * that and therefore could not hash what it moved. Optional and inert when
	 * absent, so the VMAF callers — bounded oneshots with no mid-run stop —
	 * are unchanged.
	 */
	opts?: { signal?: AbortSignal },
): Promise<DigestedTransfer> {
	const hash = createHash("sha256");
	let bytes = 0;
	const tap = new Transform({
		transform(chunk, _enc, done) {
			// Buffer.from without a copy: chunk is already a Buffer for a byte
			// stream, and `hash.update` does not retain it.
			hash.update(chunk);
			bytes += chunk.length;
			done(null, chunk);
		},
	});
	await pipeline(
		source,
		tap,
		sink,
		opts?.signal ? { signal: opts.signal } : {},
	);
	return { sha256: hash.digest("hex"), bytes };
}

/**
 * Digest a stream that is NOT being written anywhere — a verification re-read.
 *
 * Deliberately not `pipeWithDigest(source, devNull)`: a caller that wants only
 * the hash should not have to name a sink, and a `/dev/null` write stream is a
 * real file handle that can fail for reasons unrelated to the read.
 */
export async function digestStream(
	source: NodeJS.ReadableStream,
): Promise<DigestedTransfer> {
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const chunk of source) {
		const buf = chunk as Buffer;
		hash.update(buf);
		bytes += buf.length;
	}
	return { sha256: hash.digest("hex"), bytes };
}

/**
 * The digest is of a SHORT READ — the transfer ended before the object did.
 *
 * Its own class for the same reason the two in `./types` are separate: the
 * operator's next action differs. This is not "the bytes changed" and not "the
 * driver cannot check" — it is "this measurement is of less than the object",
 * and recording it as the object's identity would make every later
 * verification fail against bytes that never changed.
 */
export class ShortReadError extends Error {
	readonly expectedBytes: number;
	readonly actualBytes: number;

	constructor(expectedBytes: number, actualBytes: number) {
		super(
			`transferred ${actualBytes} bytes but the recorded size is ${expectedBytes} — the source ended early and cleanly, which raises no stream error; this digest is of a SHORT READ and must not be recorded as the object's identity`,
		);
		this.name = "ShortReadError";
		this.expectedBytes = expectedBytes;
		this.actualBytes = actualBytes;
	}
}

/**
 * Compare a completed transfer against the size the identity recorded.
 *
 * Deliberately NOT a parameter on `pipeWithDigest`/`digestStream`: both also
 * run at CAPTURE time, when there is no expected size yet — the call is what
 * produces it. Forcing one would make the capture path lie about what it knows.
 *
 * It exists as a named primitive rather than as advice in a comment because
 * this package has already demonstrated, twice in one change, that a correct
 * rule stated once and load-bearing nowhere does not hold: the `InvalidArgument`
 * split was a distinction its own author violated two functions away, and the
 * Azure mock's "behaves like the real SDK" was true only in prose until a
 * mutation proved otherwise. A reviewer can grep for a call to this. Nobody can
 * grep for whether an inline comparison was remembered.
 */
export function assertCompleteTransfer(
	transfer: DigestedTransfer,
	expectedBytes: number,
): void {
	if (transfer.bytes !== expectedBytes) {
		throw new ShortReadError(expectedBytes, transfer.bytes);
	}
}
