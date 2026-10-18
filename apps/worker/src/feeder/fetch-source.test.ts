import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCredential } from "../orchestrator/executor";

const mocks = vi.hoisted(() => ({
	getObject: vi.fn<(input: unknown) => Promise<NodeJS.ReadableStream>>(),
	/** : the seal's capture and its pre-transfer re-read. */
	headObject: vi.fn<(input: unknown) => Promise<Record<string, unknown>>>(),
	dispose: vi.fn(),
}));

/**
 * : spread the REAL module, override only the factory.
 *
 * The previous whole-module replacement returned `{ getObject, dispose }` and
 * nothing else, so `pipeWithDigest`, `assertCompleteTransfer` and the two
 * error classes the seal enforcement depends on would all have been
 * `undefined` — the suite would have failed for the wrong reason, and an
 * `instanceof ObjectVersionMismatchError` against a mocked class is never a
 * check of the real one.
 */
vi.mock("@bitovp/storage", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	createBrowserForCredential: () => ({
		getObject: mocks.getObject,
		headObject: mocks.headObject,
		dispose: mocks.dispose,
	}),
}));

import {
	ObjectVersionMismatchError,
	ShortReadError,
	VersionExpectationUnsupportedError,
} from "@bitovp/storage";
import { createDefaultFetchSource } from "./fetch-source";

const credential: ResolvedCredential = {
	provider: "AWS_S3",
	config: { region: "us-east-1" },
	secret: { accessKeyId: "a", secretAccessKey: "s" },
};

let spoolDir: string;

beforeEach(async () => {
	vi.clearAllMocks();
	spoolDir = await mkdtemp(join(tmpdir(), "feeder-spool-test-"));
});

afterEach(async () => {
	await rm(spoolDir, { recursive: true, force: true });
});

function args(signal = new AbortController().signal) {
	return {
		sessionId: "session-1",
		credential,
		bucket: "media",
		key: "loops/source.mp4",
		signal,
	};
}

/** The bytes every arm below spools, and their true digest. */
const BYTES = "mp4-bytes";
const BYTES_SHA256 =
	"225e2e71f6963695684cf5c2aef7d582fff76acb8c028ed8b79c9c52bc93495d";

/** The seal an arm captured at ARM time. */
const SEAL = {
	etag: '"abc123"',
	versionId: "v-1",
	size: BYTES.length,
};

describe("createDefaultFetchSource", () => {
	it("spools the object to <sessionId><ext> and cleanup() removes it", async () => {
		mocks.getObject.mockResolvedValueOnce(
			Readable.from([Buffer.from("mp4-bytes")]),
		);
		const fetchSource = createDefaultFetchSource(spoolDir);
		const fetched = await fetchSource(args());
		expect(fetched.path).toBe(join(spoolDir, "session-1.mp4"));
		expect((await readFile(fetched.path)).toString()).toBe("mp4-bytes");
		expect(mocks.dispose).toHaveBeenCalled();
		await fetched.cleanup();
		expect(existsSync(fetched.path)).toBe(false);
	});

	it("a failed download rejects AND leaves no partial spool file behind", async () => {
		const source = new Readable({ read() {} });
		mocks.getObject.mockResolvedValueOnce(source);
		const fetchSource = createDefaultFetchSource(spoolDir);
		const pending = fetchSource(args());
		source.push(Buffer.from("partial-bytes"));
		source.destroy(new Error("connection reset mid-transfer"));
		await expect(pending).rejects.toThrow(/connection reset mid-transfer/);
		// The partial file was removed — failed downloads never leak disk.
		expect(await readdir(spoolDir)).toEqual([]);
		expect(mocks.dispose).toHaveBeenCalled();
	});

	it("aborting the signal cancels the in-flight transfer, destroys both ends and removes the partial file", async () => {
		const source = new Readable({ read() {} });
		mocks.getObject.mockResolvedValueOnce(source);
		const aborter = new AbortController();
		const fetchSource = createDefaultFetchSource(spoolDir);
		const pending = fetchSource(args(aborter.signal));
		source.push(Buffer.from("chunk-1"));
		// Let the pipeline attach before aborting mid-stream.
		await new Promise((resolve) => setTimeout(resolve, 0));
		aborter.abort();
		await expect(pending).rejects.toThrow();
		expect(source.destroyed).toBe(true);
		expect(await readdir(spoolDir)).toEqual([]);
	});

	it("a getObject failure before any bytes flow leaves no spool file either", async () => {
		mocks.getObject.mockRejectedValueOnce(new Error("bucket not reachable"));
		const fetchSource = createDefaultFetchSource(spoolDir);
		await expect(fetchSource(args())).rejects.toThrow(/bucket not reachable/);
		expect(await readdir(spoolDir)).toEqual([]);
		expect(mocks.dispose).toHaveBeenCalled();
	});
});

/**
 *  (audit 2026-08-29 HIGH-4). `{credentialId, bucket, key}` names a
 * LOCATION, and a location is not a version: an object replaced under the same
 * key between arm and air used to be pushed with no trace, and the aired bytes
 * could not be told from the operator's chosen ones afterwards.
 */
describe("source identity seal", () => {
	it("demands the sealed version on the read, records the digest, and reports it PINNED", async () => {
		mocks.headObject.mockResolvedValueOnce({ ...SEAL });
		mocks.getObject.mockResolvedValueOnce(Readable.from([Buffer.from(BYTES)]));
		const fetchSource = createDefaultFetchSource(spoolDir);
		const fetched = await fetchSource({ ...args(), expect: SEAL });
		// Layer 2: the version rides the READ, not just the pre-check.
		expect(mocks.getObject).toHaveBeenCalledWith(
			expect.objectContaining({
				expect: { etag: '"abc123"', versionId: "v-1" },
			}),
		);
		expect(fetched.pinned).toBe(true);
		// The audit trail: what actually arrived.
		expect(fetched.sha256).toBe(BYTES_SHA256);
		expect(fetched.bytes).toBe(BYTES.length);
		expect((await readFile(fetched.path)).toString()).toBe(BYTES);
	});

	it("an ETag change REFUSES before any bytes move, naming sealed AND observed", async () => {
		mocks.headObject.mockResolvedValueOnce({
			...SEAL,
			etag: '"replaced"',
		});
		const fetchSource = createDefaultFetchSource(spoolDir);
		const pending = fetchSource({ ...args(), expect: SEAL });
		await expect(pending).rejects.toBeInstanceOf(ObjectVersionMismatchError);
		await expect(pending).rejects.toThrow(/sealed at arm.*abc123/s);
		await expect(pending).rejects.toThrow(/found now.*replaced/s);
		// Refused BEFORE the transfer: no download, no spool file.
		expect(mocks.getObject).not.toHaveBeenCalled();
		expect(await readdir(spoolDir)).toEqual([]);
		expect(mocks.dispose).toHaveBeenCalled();
	});

	it("a SIZE change refuses too — a provider with no etag still cannot swap the object", async () => {
		mocks.headObject.mockResolvedValueOnce({ size: 999 });
		const fetchSource = createDefaultFetchSource(spoolDir);
		await expect(
			fetchSource({ ...args(), expect: { size: BYTES.length } }),
		).rejects.toBeInstanceOf(ObjectVersionMismatchError);
		expect(mocks.getObject).not.toHaveBeenCalled();
	});

	it("a versionId the seal never carried is NOT a mismatch — an absent selector proves nothing", async () => {
		// The seal has no versionId (unversioned bucket at arm time); the HEAD
		// now reports one. Treating that as an overwrite would refuse a feed
		// over bytes that never changed.
		mocks.headObject.mockResolvedValueOnce({
			etag: '"abc123"',
			versionId: "v-9",
			size: BYTES.length,
		});
		mocks.getObject.mockResolvedValueOnce(Readable.from([Buffer.from(BYTES)]));
		const fetchSource = createDefaultFetchSource(spoolDir);
		const fetched = await fetchSource({
			...args(),
			expect: { etag: '"abc123"', size: BYTES.length },
		});
		expect(fetched.sha256).toBe(BYTES_SHA256);
	});

	it("a SHORT READ of the right version still fails — the digest of a prefix is not this object", async () => {
		mocks.headObject.mockResolvedValueOnce({ ...SEAL });
		mocks.getObject.mockResolvedValueOnce(Readable.from([Buffer.from("mp4")]));
		const fetchSource = createDefaultFetchSource(spoolDir);
		await expect(
			fetchSource({ ...args(), expect: SEAL }),
		).rejects.toBeInstanceOf(ShortReadError);
		expect(await readdir(spoolDir)).toEqual([]);
	});

	it("a driver that cannot express the expectation reads unconditionally and says pinned: false", async () => {
		mocks.headObject.mockResolvedValueOnce({ ...SEAL });
		mocks.getObject.mockRejectedValueOnce(
			new VersionExpectationUnsupportedError(
				"media",
				"loops/source.mp4",
				{ etag: '"abc123"' },
				"createReadStream takes no If-Match",
			),
		);
		mocks.getObject.mockResolvedValueOnce(Readable.from([Buffer.from(BYTES)]));
		const fetchSource = createDefaultFetchSource(spoolDir);
		const fetched = await fetchSource({ ...args(), expect: SEAL });
		// Named, not hidden: layers 1 and 3 still ran.
		expect(fetched.pinned).toBe(false);
		expect(fetched.sha256).toBe(BYTES_SHA256);
		expect(mocks.getObject).toHaveBeenCalledTimes(2);
	});

	it("NO seal keeps the pre-seal behaviour: no HEAD, no expectation on the read", async () => {
		mocks.getObject.mockResolvedValueOnce(Readable.from([Buffer.from(BYTES)]));
		const fetchSource = createDefaultFetchSource(spoolDir);
		const fetched = await fetchSource(args());
		expect(mocks.headObject).not.toHaveBeenCalled();
		expect(mocks.getObject).toHaveBeenCalledWith({
			bucket: "media",
			key: "loops/source.mp4",
		});
		expect(fetched.pinned).toBe(false);
		// The digest is recorded regardless — it is the only identity an
		// unsealed feed has.
		expect(fetched.sha256).toBe(BYTES_SHA256);
	});
});
