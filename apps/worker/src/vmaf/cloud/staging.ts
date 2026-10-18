import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	DeleteObjectsCommand,
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DefaultAzureCredential } from "@azure/identity";
import {
	BlobSASPermissions,
	BlobServiceClient,
	generateBlobSASQueryParameters,
	SASProtocol,
} from "@azure/storage-blob";
import type {
	SignedTransfer,
	VmafCloudProfile,
	VmafStagingStore,
} from "@bitovp/core";
import { Storage } from "@google-cloud/storage";
import { httpsEndpoint } from "./provider-common.js";

export class StagingNotFoundError extends Error {
	constructor() {
		super("VMAF staging object not found");
		this.name = "StagingNotFoundError";
	}
}

type Config = VmafCloudProfile["staging"];
export type StagingDependencies = {
	s3?: S3Client;
	gcs?: Storage;
	azure?: BlobServiceClient;
	signS3?: typeof getSignedUrl;
};

function validateKey(key: string): void {
	if (
		!/^[a-zA-Z0-9][a-zA-Z0-9/._-]{0,1023}$/.test(key) ||
		key.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw new Error("Invalid VMAF staging key");
}
function expiry(seconds: number): Date {
	if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 604800)
		throw new Error("Invalid staging URL lifetime");
	return new Date(Date.now() + seconds * 1000);
}
function isMissing(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const e = error as {
		code?: unknown;
		statusCode?: unknown;
		name?: unknown;
		$metadata?: { httpStatusCode?: unknown };
	};
	return (
		e.statusCode === 404 ||
		e.code === 404 ||
		e.$metadata?.httpStatusCode === 404 ||
		e.name === "NoSuchKey" ||
		e.code === "BlobNotFound"
	);
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof StagingNotFoundError || isMissing(error))
			throw new StagingNotFoundError();
		// SDK errors may embed request URLs, signatures, or response bodies. Do not retain causes.
		throw new Error("VMAF staging operation failed");
	}
}
async function downloadFile(
	path: string,
	getStream: () => Promise<NodeJS.ReadableStream>,
): Promise<void> {
	const partial = `${path}.${randomUUID()}.part`;
	try {
		await pipeline(
			await getStream(),
			createWriteStream(partial, { flags: "wx", mode: 0o600 }),
		);
		await rename(partial, path);
	} finally {
		await rm(partial, { force: true });
	}
}

function s3Store(
	config: Extract<Config, { provider: "S3" }>,
	deps: StagingDependencies,
): VmafStagingStore {
	if (config.endpoint) {
		const endpoint = new URL(config.endpoint);
		if (
			endpoint.protocol !== "https:" ||
			endpoint.username ||
			endpoint.password ||
			endpoint.search ||
			endpoint.hash
		)
			throw new Error("Invalid S3 endpoint");
	}
	const client =
		deps.s3 ??
		new S3Client({
			region: config.region,
			endpoint: config.endpoint,
			forcePathStyle: Boolean(config.endpoint),
			maxAttempts: 1,
			requestChecksumCalculation: "WHEN_REQUIRED",
			responseChecksumValidation: "WHEN_REQUIRED",
		});
	const sign = async (
		key: string,
		seconds: number,
		write: boolean,
	): Promise<string> => {
		expiry(seconds);
		const credentials = await client.config.credentials();
		if (
			credentials.expiration &&
			credentials.expiration.getTime() < Date.now() + seconds * 1000 + 60_000
		)
			throw new Error(
				"AWS credential lifetime is shorter than the signed transfer lifetime",
			);
		const args = { Bucket: config.bucket, Key: key };
		return (deps.signS3 ?? getSignedUrl)(
			client,
			write ? new PutObjectCommand(args) : new GetObjectCommand(args),
			{ expiresIn: seconds },
		);
	};
	return {
		async upload(key, path, signal) {
			const bytes = (await stat(path)).size;
			signal?.throwIfAborted();
			const body = createReadStream(path);
			const upload = new Upload({
				client,
				params: {
					Bucket: config.bucket,
					Key: key,
					Body: body,
					ContentLength: bytes,
				},
				queueSize: 2,
				partSize: Math.max(64 * 1024 * 1024, Math.ceil(bytes / 9999)),
				leavePartsOnError: false,
			});
			const abort = () => {
				body.destroy();
				void upload.abort().catch(() => undefined);
			};
			signal?.addEventListener("abort", abort, { once: true });
			try {
				await upload.done();
				signal?.throwIfAborted();
			} finally {
				signal?.removeEventListener("abort", abort);
				body.destroy();
			}
		},
		async download(key, path) {
			await downloadFile(path, async () => {
				const result = await client.send(
					new GetObjectCommand({ Bucket: config.bucket, Key: key }),
				);
				if (!result.Body) throw new Error("Missing S3 response body");
				return result.Body as Readable;
			});
		},
		signedRead: (key, seconds) => sign(key, seconds, false),
		async signedWrite(key, seconds) {
			return { url: await sign(key, seconds, true) };
		},
		async remove(keys) {
			for (let i = 0; i < keys.length; i += 1000) {
				const result = await client.send(
					new DeleteObjectsCommand({
						Bucket: config.bucket,
						Delete: {
							Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })),
							Quiet: true,
						},
					}),
				);
				if (result.Errors?.length)
					throw new Error("S3 staging deletion was incomplete");
			}
		},
	};
}

function gcsStore(
	config: Extract<Config, { provider: "GCS" }>,
	deps: StagingDependencies,
): VmafStagingStore {
	const storage =
		deps.gcs ?? new Storage({ retryOptions: { autoRetry: false } });
	const bucket = storage.bucket(config.bucket);
	return {
		async upload(key, path, signal) {
			await pipeline(
				createReadStream(path),
				bucket.file(key).createWriteStream({
					resumable: true,
					chunkSize: 64 * 1024 * 1024,
					validation: "crc32c",
				}),
				{ signal },
			);
		},
		async download(key, path) {
			await downloadFile(path, async () =>
				bucket.file(key).createReadStream({ validation: "crc32c" }),
			);
		},
		async signedRead(key, seconds) {
			return (
				await bucket.file(key).getSignedUrl({
					version: "v4",
					action: "read",
					expires: expiry(seconds),
				})
			)[0];
		},
		async signedWrite(key, seconds) {
			return {
				url: (
					await bucket.file(key).getSignedUrl({
						version: "v4",
						action: "write",
						expires: expiry(seconds),
					})
				)[0],
			};
		},
		async remove(keys) {
			for (const key of keys)
				await bucket.file(key).delete({ ignoreNotFound: true });
		},
	};
}

function azureStore(
	config: Extract<Config, { provider: "AZURE" }>,
	deps: StagingDependencies,
): VmafStagingStore {
	const endpoint = httpsEndpoint(config.accountUrl, ".blob.core.windows.net");
	const account = new URL(endpoint).hostname.split(".")[0];
	if (!account || !/^[a-z0-9]{3,24}$/.test(account))
		throw new Error("Invalid Azure storage account");
	const client =
		deps.azure ??
		new BlobServiceClient(endpoint, new DefaultAzureCredential(), {
			retryOptions: { maxTries: 1 },
		});
	const container = client.getContainerClient(config.container);
	const signed = async (
		key: string,
		seconds: number,
		write: boolean,
	): Promise<SignedTransfer> => {
		// The delegation key may span at most seven days, including clock-skew allowance.
		if (seconds > 604740)
			throw new Error("Azure staging URL lifetime exceeds delegation limit");
		const expiresOn = expiry(seconds),
			startsOn = new Date(Date.now() - 60_000);
		const delegation = await client.getUserDelegationKey(startsOn, expiresOn);
		const query = generateBlobSASQueryParameters(
			{
				containerName: config.container,
				blobName: key,
				permissions: BlobSASPermissions.parse(write ? "cw" : "r"),
				protocol: SASProtocol.Https,
				startsOn,
				expiresOn,
			},
			delegation,
			account,
		).toString();
		return {
			url: `${container.getBlockBlobClient(key).url}?${query}`,
			...(write ? { headers: { "x-ms-blob-type": "BlockBlob" } } : {}),
		};
	};
	return {
		async upload(key, path, signal) {
			await container.getBlockBlobClient(key).uploadFile(path, {
				blockSize: 8 * 1024 * 1024,
				concurrency: 2,
				abortSignal: signal,
			});
		},
		async download(key, path) {
			await downloadFile(path, async () => {
				const result = await container.getBlockBlobClient(key).download();
				if (!result.readableStreamBody)
					throw new Error("Missing Azure response body");
				return result.readableStreamBody;
			});
		},
		async signedRead(key, seconds) {
			return (await signed(key, seconds, false)).url;
		},
		signedWrite: (key, seconds) => signed(key, seconds, true),
		async remove(keys) {
			for (const key of keys)
				await container.getBlockBlobClient(key).deleteIfExists();
		},
	};
}

export function createStagingStore(
	config: Config,
	deps: StagingDependencies = {},
): VmafStagingStore {
	const store =
		config.provider === "S3"
			? s3Store(config, deps)
			: config.provider === "GCS"
				? gcsStore(config, deps)
				: azureStore(config, deps);
	return {
		upload: (key, path, signal) =>
			safe(async () => {
				validateKey(key);
				signal?.throwIfAborted();
				await store.upload(key, path, signal);
			}),
		download: (key, path) =>
			safe(async () => {
				validateKey(key);
				await store.download(key, path);
			}),
		signedRead: (key, seconds) =>
			safe(async () => {
				validateKey(key);
				return store.signedRead(key, seconds);
			}),
		signedWrite: (key, seconds) =>
			safe(async () => {
				validateKey(key);
				return store.signedWrite(key, seconds);
			}),
		remove: (keys) =>
			safe(async () => {
				for (const key of keys) validateKey(key);
				await store.remove(keys);
			}),
	};
}
