import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	assertCompleteTransfer,
	digestStream,
	pipeWithDigest,
	ShortReadError,
} from "./digest";

/**
 * Streaming SHA-256.
 *
 * Every expected digest below was produced by `shasum -a 256`, NOT by this
 * module. A test that hashes the input with `createHash` and compares against
 * `pipeWithDigest` proves the two calls agree, which they would even if the
 * pass-through dropped every chunk in the same way — the whole failure mode is
 * hashing something other than what was transferred.
 */

function collecting(): { sink: Writable; written(): Buffer } {
	const chunks: Buffer[] = [];
	return {
		sink: new Writable({
			write(chunk, _enc, done) {
				chunks.push(Buffer.from(chunk));
				done();
			},
		}),
		written: () => Buffer.concat(chunks),
	};
}

describe("pipeWithDigest", () => {
	it("hashes exactly the bytes that reach the sink", async () => {
		const { sink, written } = collecting();
		const result = await pipeWithDigest(
			Readable.from([Buffer.from("hello "), Buffer.from("world")]),
			sink,
		);
		// shasum -a 256 of "hello world"
		expect(result.sha256).toBe(
			"b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
		);
		expect(result.bytes).toBe(11);
		// The sink got the bytes too — a tap that hashed correctly while
		// swallowing the payload would satisfy the digest assertion alone.
		expect(written().toString()).toBe("hello world");
	});

	it("is chunk-boundary independent", async () => {
		// Same bytes, split every which way: one chunk, per-character, and an
		// uneven split. A hash that reset per chunk, or that missed a chunk,
		// diverges here while the single-chunk case looks perfect.
		const splits: Buffer[][] = [
			[Buffer.from("hello world")],
			[..."hello world"].map((c) => Buffer.from(c)),
			[Buffer.from("h"), Buffer.from("ello wor"), Buffer.from("ld")],
		];
		for (const chunks of splits) {
			const { sink } = collecting();
			const result = await pipeWithDigest(Readable.from(chunks), sink);
			expect(result.sha256).toBe(
				"b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
			);
			expect(result.bytes).toBe(11);
		}
	});

	it("an empty stream is the empty digest, not an error and not a null", async () => {
		// A zero-byte object is a real thing to encounter (a truncated upload),
		// and it must produce the digest that PROVES it was zero bytes rather
		// than an absent measurement.
		const { sink } = collecting();
		const result = await pipeWithDigest(Readable.from([]), sink);
		expect(result.sha256).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
		expect(result.bytes).toBe(0);
	});

	it("survives more bytes than one chunk (100k across many writes)", async () => {
		const { sink, written } = collecting();
		async function* many() {
			for (let i = 0; i < 1000; i += 1) {
				yield Buffer.from("x".repeat(100));
			}
		}
		const result = await pipeWithDigest(Readable.from(many()), sink);
		// shasum -a 256 of 100000 'x'
		expect(result.sha256).toBe(
			"d69e68988157833272305aaf21f453c800346e8a3640db6578e260215542e5d4",
		);
		expect(result.bytes).toBe(100_000);
		expect(written().length).toBe(100_000);
	});

	it("rejects when the source fails, and does not report a partial digest", async () => {
		// The dangerous outcome is a RESOLVED promise carrying the hash of a
		// prefix: it would be recorded as the object's digest and every later
		// verification would fail against intact bytes.
		const { sink } = collecting();
		const boom = new Error("connection reset");
		const source = new Readable({
			read() {
				this.push(Buffer.from("partial"));
				this.destroy(boom);
			},
		});
		await expect(pipeWithDigest(source, sink)).rejects.toThrow(
			"connection reset",
		);
	});

	it("rejects when the SINK fails", async () => {
		const failing = new Writable({
			write(_chunk, _enc, done) {
				done(new Error("disk full"));
			},
		});
		await expect(
			pipeWithDigest(Readable.from([Buffer.from("aaa")]), failing),
		).rejects.toThrow("disk full");
	});
});

describe("digestStream", () => {
	it("agrees with the reference tool on a stream it does not write", async () => {
		// shasum -a 256 of "aaa"
		const result = await digestStream(Readable.from([Buffer.from("aaa")]));
		expect(result.sha256).toBe(
			"9834876dcfb05cb167a5c24953eba58c4ac89b1adf57f28f2f9d09af107ee8f0",
		);
		expect(result.bytes).toBe(3);
	});

	it("agrees with pipeWithDigest over the same bytes", async () => {
		// The verification path and the capture path must produce the same
		// value or a re-read always looks like an overwrite. Two implementations
		// exist, so this is the arm that keeps them one contract.
		const chunks = [Buffer.from("hello "), Buffer.from("world")];
		const { sink } = collecting();
		const piped = await pipeWithDigest(Readable.from(chunks), sink);
		const digested = await digestStream(Readable.from(chunks));
		expect(digested).toEqual(piped);
	});

	it("propagates a source failure instead of returning a prefix digest", async () => {
		const source = new Readable({
			read() {
				this.push(Buffer.from("partial"));
				this.destroy(new Error("stream died"));
			},
		});
		await expect(digestStream(source)).rejects.toThrow("stream died");
	});
});

describe("assertCompleteTransfer", () => {
	/**
	 * Reviewer's suggestion, and I took it for their reason rather than the
	 * idea itself: this package demonstrated TWICE in one change that a correct
	 * rule stated once and load-bearing nowhere does not hold. A reviewer can
	 * grep for a call to this; nobody can grep for whether an inline comparison
	 * was remembered.
	 */
	it("passes when the transfer matches the recorded size", () => {
		expect(() =>
			assertCompleteTransfer(
				{ sha256: "a".repeat(64), bytes: 8_038_353 },
				8_038_353,
			),
		).not.toThrow();
	});

	it("throws ShortReadError when the source ended early", () => {
		let thrown: unknown;
		try {
			assertCompleteTransfer(
				{ sha256: "a".repeat(64), bytes: 12_000_000 },
				40_000_000,
			);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(ShortReadError);
		expect((thrown as ShortReadError).expectedBytes).toBe(40_000_000);
		expect((thrown as ShortReadError).actualBytes).toBe(12_000_000);
		// The message must name the trap, not just the numbers: a clean early
		// EOF raises no stream error, so a reader who sees only "12000000 !=
		// 40000000" has no reason to suspect the digest is of a prefix.
		expect((thrown as Error).message).toContain("SHORT READ");
		expect((thrown as Error).message).toContain("must not be recorded");
	});

	it("a LONGER-than-expected transfer is also a mismatch, not silently fine", () => {
		// Inequality, not `<`. More bytes than the identity recorded means the
		// object changed under the read — refusing is the same answer.
		expect(() =>
			assertCompleteTransfer({ sha256: "a".repeat(64), bytes: 101 }, 100),
		).toThrow(ShortReadError);
	});

	it("zero bytes against a real size is caught, not treated as an empty object", () => {
		// The failure that looks most like success: a connection that closes
		// immediately yields the well-known empty digest, which is a perfectly
		// valid hash of nothing.
		expect(() =>
			assertCompleteTransfer(
				{ sha256: "e3b0c442".padEnd(64, "0"), bytes: 0 },
				4096,
			),
		).toThrow(ShortReadError);
	});
});
