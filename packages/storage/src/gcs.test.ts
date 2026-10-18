import { PassThrough, Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storageConfigs: Record<string, unknown>[] = [];
const getBuckets = vi.fn();
const getFiles = vi.fn();
const getMetadata = vi.fn();
const createReadStream = vi.fn();
/**
 * Every `bucket(name).file(key, options)` call, in order — audit ce4a935
 * CRITICAL-2. GCS pins an exact version by SELECTING a generation on the file
 * handle rather than by sending a precondition header, so the options argument
 * IS the enforcement and recording it is the only way to prove the enforcement
 * happened. `getObject` had no coverage at all before this (the mock's
 * `bucket` returned only `getFiles`), so the pinning would have shipped
 * unexercised.
 */
const fileCalls: { key: string; options: unknown }[] = [];

vi.mock("@google-cloud/storage", () => ({
	Storage: class {
		constructor(config: Record<string, unknown>) {
			storageConfigs.push(config);
		}
		getBuckets = getBuckets;
		bucket = () => ({
			getFiles,
			file: (key: string, options?: unknown) => {
				fileCalls.push({ key, options });
				return { createReadStream, getMetadata };
			},
		});
	},
}));

import { createGcsBrowser } from "./gcs";
import {
	ObjectVersionMismatchError,
	UnsupportedBrowseError,
	VersionExpectationUnsupportedError,
} from "./types";

const KEY = JSON.stringify({
	project_id: "proj",
	client_email: "svc@proj.iam.gserviceaccount.com",
	private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
});

beforeEach(() => {
	vi.clearAllMocks();
	storageConfigs.length = 0;
	fileCalls.length = 0;
});

describe("createGcsBrowser", () => {
	it("bounds readiness data and OAuth requests without changing the default client", () => {
		createGcsBrowser(KEY, 5000);
		expect(storageConfigs[0]).toMatchObject({
			timeout: 5000,
			retryOptions: { autoRetry: false },
			clientOptions: { transporterOptions: { timeout: 5000, retry: false } },
		});
		createGcsBrowser(KEY);
		expect(storageConfigs[1]).not.toHaveProperty("timeout");
		expect(storageConfigs[1]).not.toHaveProperty("clientOptions");
	});
	it.each([
		{ key: "archive.mp4", size: 1024, recursive: false },
		{ key: "out/run/archive.mp4", size: 2048, recursive: false },
		{ key: "out/run/archive.mp4", size: 0, recursive: true },
	])("retains an exact non-directory prefix object: $key, recursive=$recursive", async ({
		key,
		size,
		recursive,
	}) => {
		getFiles.mockResolvedValueOnce([
			[{ name: key, metadata: { size: String(size) } }],
			null,
			{},
		]);
		const browser = createGcsBrowser(KEY);
		const result = await browser.listObjects({
			bucket: "b",
			prefix: key,
			limit: 100,
			recursive,
		});
		expect(result.objects).toEqual([{ key, size, lastModified: undefined }]);
	});
	it.each([
		false,
		true,
	])("still excludes only the queried directory marker, recursive=%j", async (recursive) => {
		getFiles.mockResolvedValueOnce([
			[
				{ name: "out/", metadata: { size: "0" } },
				{ name: "out/archive.mp4", metadata: { size: "1024" } },
			],
			null,
			{},
		]);
		const result = await createGcsBrowser(KEY).listObjects({
			bucket: "b",
			prefix: "out/",
			recursive,
		});
		expect(result.objects.map((object) => object.key)).toEqual([
			"out/archive.mp4",
		]);
	});
	it("rejects a service-account key that is not JSON", () => {
		expect(() => createGcsBrowser("not json")).toThrow(UnsupportedBrowseError);
	});

	it("builds the client from the key without an endpoint override", () => {
		createGcsBrowser(KEY);
		expect(storageConfigs[0]).toEqual({
			projectId: "proj",
			credentials: {
				client_email: "svc@proj.iam.gserviceaccount.com",
				private_key:
					"-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
			},
		});
	});

	it("CANNOT be pointed at a customer-supplied host — the ranged-read rail depends on it", () => {
		// Why this is a rail and not a triviality: @google-cloud/storage does NOT
		// enforce createReadStream({start,end}) client-side (start/end only build
		// the Range header, file.js:1136-1138; the body pipeline has no 206 or
		// Content-Range check, and a ranged read even disables crc32c/md5 —
		// file.js:1037,1044). What keeps this driver safe without the
		// Content-Range rail that azure.ts carries is that it can only ever reach
		// storage.googleapis.com, so the C10 threat model — customer-configured
		// GENERIC_S3 endpoints (MinIO, Ceph, Linode, OCI) that may ignore Range —
		// cannot reach it. Wiring an endpoint here without adding the rail would
		// open exactly the hole the (false) "GCS is client-enforced" claim would
		// have licensed.
		createGcsBrowser(KEY);
		const config = storageConfigs[0] ?? {};
		expect(Object.keys(config).sort()).toEqual(["credentials", "projectId"]);
		expect(config.apiEndpoint).toBeUndefined();
	});

	it("needs a project_id before it can list buckets", async () => {
		const browser = createGcsBrowser(
			JSON.stringify({ client_email: "a@b.c", private_key: "k" }),
		);
		await expect(browser.listBuckets()).rejects.toThrow(UnsupportedBrowseError);
	});
});

describe("createGcsBrowser exact-version reads", () => {
	it("headObject reports the generation as a string, and size as a number", async () => {
		// The API returns both as strings. A generation coerced to a number
		// loses precision on large values, and a size left as a string would be
		// stored as one and compared against a number later.
		getMetadata.mockResolvedValue([
			{
				etag: "CJDD",
				generation: "1724800000000000",
				size: "8038353",
				updated: "2026-08-28T00:00:00.000Z",
			},
		]);
		const browser = createGcsBrowser(KEY);
		expect(await browser.headObject?.({ bucket: "b", key: "k" })).toEqual({
			etag: "CJDD",
			generation: "1724800000000000",
			size: 8_038_353,
			lastModified: "2026-08-28T00:00:00.000Z",
		});
	});

	it("an absent size is 0, never NaN", async () => {
		// `Number(undefined)` is NaN, which would be persisted as the object's
		// size and then compared against a real byte count forever.
		getMetadata.mockResolvedValue([{ etag: "e", generation: "5" }]);
		const browser = createGcsBrowser(KEY);
		const id = await browser.headObject?.({ bucket: "b", key: "k" });
		expect(id?.size).toBe(0);
		expect(Number.isNaN(id?.size)).toBe(false);
	});

	it("pins the generation ON THE FILE HANDLE, which is the enforcement", async () => {
		createReadStream.mockReturnValue(Readable.from([]));
		const browser = createGcsBrowser(KEY);
		await browser.getObject?.({
			bucket: "b",
			key: "k",
			expect: { generation: "1724800000000000" },
		});
		expect(fileCalls).toEqual([
			{ key: "k", options: { generation: "1724800000000000" } },
		]);
	});

	it("without an expectation the handle is unpinned (browsing is unconditional)", async () => {
		createReadStream.mockReturnValue(Readable.from([]));
		const browser = createGcsBrowser(KEY);
		await browser.getObject?.({ bucket: "b", key: "k" });
		expect(fileCalls).toEqual([{ key: "k", options: undefined }]);
	});

	it("an etag-only expectation is UNSUPPORTED, not a mismatch", async () => {
		/*
		 * The distinction is the finding, not pedantry. `createReadStream` sends
		 * no If-Match, so GCS cannot enforce an etag-only expectation — which is
		 * what an S3-captured identity replayed against GCS looks like. Reporting
		 * it as a MISMATCH would tell an operator their source was overwritten
		 * when the bytes may be perfectly intact, and send them hunting for an
		 * event that never happened.
		 */
		createReadStream.mockReturnValue(Readable.from([]));
		const browser = createGcsBrowser(KEY);
		const err = await browser
			.getObject?.({ bucket: "b", key: "k", expect: { etag: '"s3-style"' } })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(VersionExpectationUnsupportedError);
		expect(err).not.toBeInstanceOf(ObjectVersionMismatchError);
		expect((err as Error).message).toContain("may be unchanged");
		// And it must not have read anything: a driver that threw AFTER opening
		// the stream would leak a connection per refusal.
		expect(createReadStream).not.toHaveBeenCalled();
	});

	it("a STALE generation surfaces as ObjectVersionMismatchError on the stream", async () => {
		/*
		 * Review of this PR, and it was structural rather than a classifier
		 * slip. `createReadStream` returns a PassThroughShim SYNCHRONOUSLY;
		 * a request failure arrives later as an async `error` event
		 * (`throughStream.destroy(err)`, @google-cloud/storage 7.21.0
		 * file.js:1054), never as a promise rejection. S3 and Azure reject the
		 * awaited call, so their try/catch classifies it — GCS resolved
		 * successfully and failed later as a raw untyped stream error.
		 *
		 * A slice-2 author writing the obvious
		 *   try { await getObject({expect}) } catch (e) { e instanceof ... }
		 * would never have caught a GCS overwrite: the exact thing this whole
		 * change exists to make catchable. The driver absorbs the asymmetry so
		 * the contract is one contract.
		 */
		const source = new PassThrough();
		createReadStream.mockReturnValue(source);
		const browser = createGcsBrowser(KEY);
		const stream = await browser.getObject?.({
			bucket: "b",
			key: "k",
			expect: { generation: "1724800000000000" },
		});
		const failed = new Promise<unknown>((resolve) => {
			stream?.on("error", resolve);
		});
		// What GCS delivers for a generation that no longer exists.
		source.destroy(
			Object.assign(new Error("No such object: b/k"), { code: 404 }),
		);
		const err = await failed;
		expect(err).toBeInstanceOf(ObjectVersionMismatchError);
		expect((err as ObjectVersionMismatchError).key).toBe("k");
		expect((err as Error).message).toContain("replaced");
	});

	it("a NON-404 stream failure keeps its own identity", async () => {
		// The same narrowness the S3 classifier had to be corrected to: a
		// generic transport failure must not become "your bytes were replaced".
		const source = new PassThrough();
		createReadStream.mockReturnValue(source);
		const browser = createGcsBrowser(KEY);
		const stream = await browser.getObject?.({
			bucket: "b",
			key: "k",
			expect: { generation: "5" },
		});
		const failed = new Promise<unknown>((resolve) => {
			stream?.on("error", resolve);
		});
		const original = Object.assign(new Error("connection reset"), {
			code: 500,
		});
		source.destroy(original);
		expect(await failed).toBe(original);
	});

	it("an UNPINNED read leaves a 404 alone — it is a missing object, not an overwrite", async () => {
		// Nothing was pinned, so nothing can have been replaced. Reporting a
		// mismatch here would invent an event.
		const source = new PassThrough();
		createReadStream.mockReturnValue(source);
		const browser = createGcsBrowser(KEY);
		const stream = await browser.getObject?.({ bucket: "b", key: "k" });
		const failed = new Promise<unknown>((resolve) => {
			stream?.on("error", resolve);
		});
		const original = Object.assign(new Error("No such object"), { code: 404 });
		source.destroy(original);
		expect(await failed).toBe(original);
	});

	it("bytes still flow through the wrapper on the happy path", async () => {
		// The wrapper is in the data path now; a version-pinned read that
		// delivered a typed error but no BYTES would be a fine test result and
		// a useless driver.
		createReadStream.mockReturnValue(
			Readable.from([Buffer.from("hello "), Buffer.from("world")]),
		);
		const browser = createGcsBrowser(KEY);
		const stream = await browser.getObject?.({
			bucket: "b",
			key: "k",
			expect: { generation: "7" },
		});
		const chunks: Buffer[] = [];
		for await (const c of stream as NodeJS.ReadableStream) {
			chunks.push(Buffer.from(c as Buffer));
		}
		expect(Buffer.concat(chunks).toString()).toBe("hello world");
	});
});
