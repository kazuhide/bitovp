import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { BlobServiceClient } from "@azure/storage-blob";
import type { Storage } from "@google-cloud/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStagingStore, StagingNotFoundError } from "./staging.js";

const temp: string[] = [];
async function directory() {
	const path = await mkdtemp(join(tmpdir(), "vmaf-staging-test-"));
	temp.push(path);
	return path;
}
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		temp.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("cloud staging", () => {
	it("aborts an active S3 upload and releases its listener", async () => {
		const controller = new AbortController();
		let rejectUpload: (reason: Error) => void = () => {};
		const done = vi.spyOn(Upload.prototype, "done").mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					rejectUpload = reject;
					queueMicrotask(() => controller.abort());
				}),
		);
		const abort = vi
			.spyOn(Upload.prototype, "abort")
			.mockImplementation(async () => {
				rejectUpload(new Error("secret SDK abort detail"));
			});
		const dir = await directory();
		await writeFile(join(dir, "in"), "source");
		const s3 = new S3Client({
			region: "us-east-1",
			credentials: { accessKeyId: "test", secretAccessKey: "test" },
		});
		const store = createStagingStore(
			{ provider: "S3", bucket: "stage", region: "us-east-1" },
			{ s3 },
		);
		await expect(
			store.upload("task/reference", join(dir, "in"), controller.signal),
		).rejects.toThrow(/^VMAF staging operation failed$/);
		expect(done).toHaveBeenCalledTimes(1);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
	it("destroys an active GCS stream on abort and rejects before I/O if already aborted", async () => {
		const controller = new AbortController();
		const sink = new Writable({
			write() {
				controller.abort();
			},
		});
		const createWriteStream = vi.fn(() => sink);
		const store = createStagingStore(
			{ provider: "GCS", bucket: "stage" },
			{
				gcs: {
					bucket: () => ({ file: () => ({ createWriteStream }) }),
				} as unknown as Storage,
			},
		);
		const dir = await directory();
		await writeFile(join(dir, "in"), "source");
		await expect(
			store.upload("task/reference", join(dir, "in"), controller.signal),
		).rejects.toThrow(/^VMAF staging operation failed$/);
		expect(sink.destroyed).toBe(true);
		await expect(
			store.upload("task/reference", join(dir, "in"), controller.signal),
		).rejects.toThrow(/^VMAF staging operation failed$/);
		expect(createWriteStream).toHaveBeenCalledTimes(1);
	});
	it("passes cancellation to the Azure file upload SDK", async () => {
		const controller = new AbortController();
		const uploadFile = vi.fn(async (_path, options) => {
			expect(options.abortSignal).toBe(controller.signal);
			controller.abort();
			options.abortSignal.throwIfAborted();
		});
		const store = createStagingStore(
			{
				provider: "AZURE",
				accountUrl: "https://account.blob.core.windows.net",
				container: "stage",
			},
			{
				azure: {
					getContainerClient: () => ({
						getBlockBlobClient: () => ({ uploadFile }),
					}),
				} as unknown as BlobServiceClient,
			},
		);
		await expect(
			store.upload("task/reference", "/unused", controller.signal),
		).rejects.toThrow(/^VMAF staging operation failed$/);
		expect(uploadFile).toHaveBeenCalledOnce();
	});
	it("streams GCS uploads/downloads and issues independent read/write URLs", async () => {
		const chunks: Buffer[] = [];
		const requests: unknown[] = [];
		const file = {
			createWriteStream: vi.fn(
				() =>
					new Writable({
						write(chunk, _encoding, callback) {
							chunks.push(Buffer.from(chunk));
							callback();
						},
					}),
			),
			createReadStream: vi.fn(() => Readable.from(["result", "-bytes"])),
			getSignedUrl: vi.fn(async (options: unknown) => {
				requests.push(options);
				return ["https://storage.example/signed"];
			}),
			delete: vi.fn(async () => {}),
		};
		const gcs = {
			bucket: vi.fn(() => ({ file: vi.fn(() => file) })),
		} as unknown as Storage;
		const store = createStagingStore(
			{ provider: "GCS", bucket: "stage" },
			{ gcs },
		);
		const dir = await directory();
		await writeFile(join(dir, "in"), "source-bytes");
		await store.upload("task/reference", join(dir, "in"));
		expect(Buffer.concat(chunks).toString()).toBe("source-bytes");
		await store.download("task/result", join(dir, "out"));
		expect(await readFile(join(dir, "out"), "utf8")).toBe("result-bytes");
		expect(await store.signedRead("task/reference", 60)).toBe(
			"https://storage.example/signed",
		);
		expect(await store.signedWrite("task/result", 60)).toEqual({
			url: "https://storage.example/signed",
		});
		expect(requests).toMatchObject([
			{ version: "v4", action: "read" },
			{ version: "v4", action: "write" },
		]);
		await store.remove(["task/reference"]);
		expect(file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
	});
	it("reports missing receipts distinctly and removes interrupted partial downloads", async () => {
		const stream = () =>
			new Readable({
				read() {
					this.destroy(
						Object.assign(new Error("https://secret.example/?token=hidden"), {
							code: 404,
						}),
					);
				},
			});
		const gcs = {
			bucket: () => ({ file: () => ({ createReadStream: stream }) }),
		} as unknown as Storage;
		const store = createStagingStore(
			{ provider: "GCS", bucket: "stage" },
			{ gcs },
		);
		const dir = await directory();
		await expect(
			store.download("task/receipt", join(dir, "receipt")),
		).rejects.toBeInstanceOf(StagingNotFoundError);
		expect(await readdir(dir)).toEqual([]);
	});
	it("rejects invalid keys before calling storage and redacts non-404 SDK failures", async () => {
		const file = vi.fn(() => ({
			getSignedUrl: async () => {
				throw new Error("https://secret.example/?signature=hidden");
			},
		}));
		const store = createStagingStore(
			{ provider: "GCS", bucket: "stage" },
			{ gcs: { bucket: () => ({ file }) } as unknown as Storage },
		);
		await expect(store.signedRead("task/../other", 60)).rejects.toThrow(
			/^VMAF staging operation failed$/,
		);
		expect(file).not.toHaveBeenCalled();
		await expect(store.signedRead("task/reference", 60)).rejects.toThrow(
			/^VMAF staging operation failed$/,
		);
	});
	it("refuses signed S3 URLs that outlive temporary credentials", async () => {
		const s3 = new S3Client({
			region: "us-east-1",
			credentials: {
				accessKeyId: "test",
				secretAccessKey: "test",
				sessionToken: "test",
				expiration: new Date(Date.now() + 60_000),
			},
		});
		const signS3 = vi.fn(async () => "https://s3.example/signed");
		const store = createStagingStore(
			{ provider: "S3", bucket: "stage", region: "us-east-1" },
			{ s3, signS3 },
		);
		await expect(store.signedRead("task/reference", 120)).rejects.toThrow(
			/^VMAF staging operation failed$/,
		);
		expect(signS3).not.toHaveBeenCalled();
	});
	it("uses AWS read/write presigning and rejects an invalid URL lifetime", async () => {
		const s3 = new S3Client({
			region: "us-east-1",
			credentials: { accessKeyId: "test", secretAccessKey: "test" },
		});
		const signS3 = vi.fn(async () => "https://s3.example/signed");
		const store = createStagingStore(
			{ provider: "S3", bucket: "stage", region: "us-east-1" },
			{ s3, signS3 },
		);
		await store.signedRead("task/reference", 120);
		await store.signedWrite("task/result", 120);
		expect(signS3).toHaveBeenCalledTimes(2);
		await expect(store.signedRead("task/reference", 604801)).rejects.toThrow(
			"VMAF staging operation failed",
		);
		expect(signS3).toHaveBeenCalledTimes(2);
	});
	it("creates HTTPS Azure user-delegation SAS with minimal read or create/write permission", async () => {
		const delegation = {
			signedObjectId: "00000000-0000-0000-0000-000000000001",
			signedTenantId: "00000000-0000-0000-0000-000000000002",
			signedStartsOn: new Date(Date.now() - 60_000),
			signedExpiresOn: new Date(Date.now() + 3600_000),
			signedService: "b",
			signedVersion: "2025-05-05",
			value: Buffer.from("test-key").toString("base64"),
		};
		const getUserDelegationKey = vi.fn(async () => delegation);
		const azure = {
			getUserDelegationKey,
			getContainerClient: () => ({
				getBlockBlobClient: () => ({
					url: "https://account.blob.core.windows.net/stage/result",
				}),
			}),
		} as unknown as BlobServiceClient;
		const store = createStagingStore(
			{
				provider: "AZURE",
				accountUrl: "https://account.blob.core.windows.net",
				container: "stage",
			},
			{ azure },
		);
		const read = new URL(await store.signedRead("task/reference", 60));
		expect(read.searchParams.get("sp")).toBe("r");
		expect(read.searchParams.get("spr")).toBe("https");
		const write = await store.signedWrite("task/result", 60);
		expect(new URL(write.url).searchParams.get("sp")).toBe("cw");
		expect(write.headers).toEqual({ "x-ms-blob-type": "BlockBlob" });
		expect(getUserDelegationKey).toHaveBeenCalledTimes(2);
	});
});

import { getEventListeners } from "node:events";
