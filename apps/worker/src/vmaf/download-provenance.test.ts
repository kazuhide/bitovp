import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
	ObjectVersionMismatchError,
	ShortReadError,
	VersionExpectationUnsupportedError,
} from "@bitovp/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 *  slice 2 (audit ce4a935 CRITICAL-2): the VMAF downloader reads
 * the object's version identity FIRST, demands it during the read, digests
 * what arrives, and refuses a transfer that is not that object. The browser
 * is faked at the storage boundary — the drivers' own exact-version behaviour
 * is pinned in packages/storage; this pins that the downloader USES it.
 */
const calls: { head: number; get: { expect?: unknown }[] } = {
	head: 0,
	get: [],
};
let behaviour: {
	head?: () => Promise<unknown>;
	get?: (input: { expect?: unknown }) => Promise<Readable>;
} = {};

vi.mock("@bitovp/storage", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bitovp/storage")>();
	return {
		...actual,
		createBrowserForCredential: () => ({
			listBuckets: async () => [],
			listObjects: async () => ({ prefixes: [], objects: [] }),
			headObject: behaviour.head
				? async () => {
						calls.head += 1;
						return behaviour.head?.();
					}
				: undefined,
			getObject: async (input: { expect?: unknown }) => {
				calls.get.push({ expect: input.expect });
				if (behaviour.get) {
					return behaviour.get(input);
				}
				return Readable.from([Buffer.from("hello")]);
			},
		}),
	};
});

import { defaultVmafDownload } from "./download";

const credential = { provider: "S3", config: {}, secret: {} } as never;
const HELLO_SHA256 =
	"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

describe("defaultVmafDownload — provenance", () => {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "vmaf-dl-"));
		calls.head = 0;
		calls.get = [];
		behaviour = {};
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("heads first, demands that version on the read, and returns the digest of what arrived", async () => {
		behaviour.head = async () => ({ etag: '"abc"', versionId: "v1", size: 5 });
		const result = await defaultVmafDownload({
			credential,
			bucket: "b",
			key: "k/source.mp4",
			destPath: join(dir, "out.mp4"),
		});
		expect(calls.head).toBe(1);
		expect(calls.get[0]?.expect).toEqual({
			etag: '"abc"',
			versionId: "v1",
			size: 5,
		});
		expect(result).toEqual({
			bucket: "b",
			key: "k/source.mp4",
			identity: { etag: '"abc"', versionId: "v1", size: 5 },
			pinned: true,
			sha256: HELLO_SHA256,
			bytes: 5,
		});
		expect(readFileSync(join(dir, "out.mp4"), "utf8")).toBe("hello");
	});

	it("a driver that cannot express the expectation reads unconditionally and SAYS pinned=false", async () => {
		behaviour.head = async () => ({ etag: '"abc"', size: 5 });
		let first = true;
		behaviour.get = async (input) => {
			if (first && input.expect) {
				first = false;
				throw new VersionExpectationUnsupportedError(
					"b",
					"k",
					{ etag: '"abc"' },
					"etag-only",
				);
			}
			return Readable.from([Buffer.from("hello")]);
		};
		const result = await defaultVmafDownload({
			credential,
			bucket: "b",
			key: "k",
			destPath: join(dir, "out.mp4"),
		});
		expect(result.pinned).toBe(false);
		expect(result.sha256).toBe(HELLO_SHA256);
		expect(calls.get).toHaveLength(2);
	});

	it("a version MISMATCH is refused, never read around", async () => {
		behaviour.head = async () => ({ etag: '"abc"', size: 5 });
		behaviour.get = async () => {
			throw new ObjectVersionMismatchError("b", "k", { etag: '"abc"' });
		};
		const err: unknown = await defaultVmafDownload({
			credential,
			bucket: "b",
			key: "k",
			destPath: join(dir, "out.mp4"),
		}).catch((e: unknown) => e);
		// Typed on the way out (review-332): the caller can still tell "the
		// object changed under us" from a transport failure by `instanceof`,
		// the fields survive, and the location is prefixed — not replaced.
		expect(err).toBeInstanceOf(ObjectVersionMismatchError);
		expect((err as Error).message).toMatch(
			/^object \(s3:\/\/b\/k\): the object at b\/k is no longer the version that was recorded/,
		);
		expect((err as ObjectVersionMismatchError).expected).toEqual({
			etag: '"abc"',
		});
		expect(calls.get).toHaveLength(1);
	});

	it("a transport failure is a located generic error carrying the original as `cause`, never a typed one", async () => {
		behaviour.head = async () => ({ etag: '"abc"', size: 5 });
		behaviour.get = async () => {
			throw new Error("NoSuchKey");
		};
		const err: unknown = await defaultVmafDownload({
			credential,
			bucket: "b",
			key: "k",
			destPath: join(dir, "out.mp4"),
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(ObjectVersionMismatchError);
		expect((err as Error).message).toBe("object (s3://b/k): NoSuchKey");
		expect(((err as Error).cause as Error).message).toBe("NoSuchKey");
	});

	it("a transfer shorter than the object's recorded size is refused and the partial file removed", async () => {
		behaviour.head = async () => ({ etag: '"abc"', size: 999 });
		const err: unknown = await defaultVmafDownload({
			credential,
			bucket: "b",
			key: "k",
			destPath: join(dir, "out.mp4"),
		}).catch((e: unknown) => e);
		// Typed too (review-332): a short read is not retryable either.
		expect(err).toBeInstanceOf(ShortReadError);
		expect((err as Error).message).toMatch(
			/^object \(s3:\/\/b\/k\): transferred \d+ bytes but the recorded size is 999/,
		);
		expect(() => readFileSync(join(dir, "out.mp4"))).toThrow();
	});

	it("without headObject the read is unconditional and pinned=false, but the digest is still recorded", async () => {
		const result = await defaultVmafDownload({
			credential,
			bucket: "b",
			key: "k",
			destPath: join(dir, "out.mp4"),
		});
		expect(calls.head).toBe(0);
		expect(result.pinned).toBe(false);
		expect(result.identity).toBeUndefined();
		expect(result.sha256).toBe(HELLO_SHA256);
	});
});
