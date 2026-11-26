/** Local preview fixtures are immutable once stored, even if re-encoding varies. */
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import {
	GetObjectCommand,
	type GetObjectCommandOutput,
	HeadObjectCommand,
	type HeadObjectCommandOutput,
	PutObjectCommand,
	type S3Client,
} from "@aws-sdk/client-s3";
import { abortableVodOperation } from "./range-bridge";

export const VOD_PREVIEW_FIXTURE_MAX_BYTES = 8 * 1024 ** 2;
const reasons = [
	"PREVIEW_ENVIRONMENT_REQUIRED",
	"PREVIEW_RESTRICTED_ROLE_REQUIRED",
	"PREVIEW_FIXTURE_METADATA_INVALID",
	"PREVIEW_FIXTURE_SIZE_INVALID",
	"PREVIEW_FIXTURE_SHA_MISMATCH",
	"PREVIEW_FIXTURE_CHANGED",
	"PREVIEW_FIXTURE_TIMED_OUT",
	"PREVIEW_FIXTURE_CANCELED",
	"PREVIEW_FIXTURE_READ_FAILED",
	"PREVIEW_FIXTURE_WRITE_FAILED",
	"PREVIEW_FIXTURE_GENERATION_FAILED",
	"PREVIEW_BUCKET_FAILED",
	"PREVIEW_DATABASE_FAILED",
	"PREVIEW_SEED_UNEXPECTED_ERROR",
] as const;
type SeedReason = (typeof reasons)[number];
export class PreviewFixtureSeedError extends Error {
	constructor(public readonly code: SeedReason) {
		super(code);
		this.name = "PreviewFixtureSeedError";
	}
}

/** Never serialize SDK messages, diagnostics, URLs, credentials or arbitrary codes. */
export function previewSeedFailureReason(error: unknown): SeedReason {
	const value =
		error instanceof PreviewFixtureSeedError
			? error.code
			: error instanceof Error
				? error.message
				: null;
	return (
		reasons.find((reason) => reason === value) ??
		"PREVIEW_SEED_UNEXPECTED_ERROR"
	);
}

export type PreviewFixtureSeedInput = {
	client: Pick<S3Client, "send">;
	bucket: string;
	key: string;
	contentType: string;
	fixtureTag: string;
	generate: (signal: AbortSignal) => Promise<Uint8Array>;
	timeoutMs?: number;
	signal?: AbortSignal;
};
type FixtureResult = {
	key: string;
	status: "PRESERVED" | "CREATED";
	sha256: string;
};
const sha = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const status = (error: unknown) =>
	(error as { $metadata?: { httpStatusCode?: number } })?.$metadata
		?.httpStatusCode;
const missing = (error: unknown) =>
	status(error) === 404 ||
	(status(error) === undefined &&
		["NotFound", "NoSuchKey"].includes(
			error instanceof Error ? error.name : "",
		));
const closeBody = (response: GetObjectCommandOutput) =>
	(response.Body as Readable | undefined)?.destroy?.();

export async function ensurePreviewFixture(
	input: PreviewFixtureSeedInput,
): Promise<FixtureResult> {
	const timeoutMs = input.timeoutMs ?? 45_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
		throw new PreviewFixtureSeedError("PREVIEW_FIXTURE_METADATA_INVALID");
	const controller = new AbortController();
	const canceled = () =>
		controller.abort(new PreviewFixtureSeedError("PREVIEW_FIXTURE_CANCELED"));
	input.signal?.addEventListener("abort", canceled, { once: true });
	if (input.signal?.aborted) canceled();
	const timer = setTimeout(
		() =>
			controller.abort(
				new PreviewFixtureSeedError("PREVIEW_FIXTURE_TIMED_OUT"),
			),
		timeoutMs,
	);
	const signal = controller.signal;
	const fail = (error: unknown, fallback: SeedReason): never => {
		if (signal.aborted) throw signal.reason;
		if (error instanceof PreviewFixtureSeedError) throw error;
		throw new PreviewFixtureSeedError(fallback);
	};
	const head = async () => {
		try {
			return await abortableVodOperation(
				input.client.send(
					new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }),
					{ abortSignal: signal },
				),
				signal,
			);
		} catch (error) {
			if (!signal.aborted && missing(error)) return null;
			return fail(error, "PREVIEW_FIXTURE_READ_FAILED");
		}
	};
	const verify = async (metadata: HeadObjectCommandOutput) => {
		const size = metadata.ContentLength,
			expected = metadata.Metadata?.sha256;
		if (
			!Number.isSafeInteger(size) ||
			!size ||
			size < 1 ||
			size > VOD_PREVIEW_FIXTURE_MAX_BYTES
		)
			throw new PreviewFixtureSeedError("PREVIEW_FIXTURE_SIZE_INVALID");
		if (
			metadata.Metadata?.["preview-fixture"] !== input.fixtureTag ||
			!expected ||
			!/^[a-f0-9]{64}$/.test(expected) ||
			!metadata.ETag?.trim()
		)
			throw new PreviewFixtureSeedError("PREVIEW_FIXTURE_METADATA_INVALID");
		let response: GetObjectCommandOutput;
		try {
			response = await abortableVodOperation(
				input.client.send(
					new GetObjectCommand({
						Bucket: input.bucket,
						Key: input.key,
						IfMatch: metadata.ETag,
						...(metadata.VersionId ? { VersionId: metadata.VersionId } : {}),
					}),
					{ abortSignal: signal },
				),
				signal,
				closeBody,
			);
		} catch (error) {
			return fail(
				error,
				[404, 412].includes(status(error) ?? 0)
					? "PREVIEW_FIXTURE_CHANGED"
					: "PREVIEW_FIXTURE_READ_FAILED",
			);
		}
		const body = response.Body as Readable | undefined;
		try {
			if (
				response.ETag !== metadata.ETag ||
				(metadata.VersionId && response.VersionId !== metadata.VersionId)
			)
				throw new PreviewFixtureSeedError("PREVIEW_FIXTURE_CHANGED");
			if (
				response.ContentLength !== size ||
				response.ContentRange !== undefined
			)
				throw new PreviewFixtureSeedError("PREVIEW_FIXTURE_SIZE_INVALID");
			if (!body || typeof body[Symbol.asyncIterator] !== "function")
				throw new PreviewFixtureSeedError("PREVIEW_FIXTURE_READ_FAILED");
			const stopped = () => body.destroy();
			signal.addEventListener("abort", stopped, { once: true });
			try {
				return await abortableVodOperation(
					(async () => {
						let received = 0;
						const hash = createHash("sha256");
						for await (const chunk of body) {
							signal.throwIfAborted();
							if (!(chunk instanceof Uint8Array))
								throw new PreviewFixtureSeedError(
									"PREVIEW_FIXTURE_READ_FAILED",
								);
							received += chunk.byteLength;
							if (received > size || received > VOD_PREVIEW_FIXTURE_MAX_BYTES)
								throw new PreviewFixtureSeedError(
									"PREVIEW_FIXTURE_SIZE_INVALID",
								);
							hash.update(chunk);
						}
						if (received !== size)
							throw new PreviewFixtureSeedError("PREVIEW_FIXTURE_SIZE_INVALID");
						if (hash.digest("hex") !== expected)
							throw new PreviewFixtureSeedError("PREVIEW_FIXTURE_SHA_MISMATCH");
						return expected;
					})(),
					signal,
				);
			} finally {
				signal.removeEventListener("abort", stopped);
			}
		} catch (error) {
			return fail(error, "PREVIEW_FIXTURE_READ_FAILED");
		} finally {
			body?.destroy?.();
		}
	};
	try {
		signal.throwIfAborted();
		const existing = await head();
		if (existing)
			return {
				key: input.key,
				status: "PRESERVED",
				sha256: await verify(existing),
			};
		let bytes: Uint8Array;
		try {
			bytes = await abortableVodOperation(input.generate(signal), signal);
		} catch (error) {
			return fail(error, "PREVIEW_FIXTURE_GENERATION_FAILED");
		}
		if (!bytes.byteLength || bytes.byteLength > VOD_PREVIEW_FIXTURE_MAX_BYTES)
			throw new PreviewFixtureSeedError("PREVIEW_FIXTURE_SIZE_INVALID");
		const sha256 = sha(bytes);
		let created = true;
		try {
			await abortableVodOperation(
				input.client.send(
					new PutObjectCommand({
						Bucket: input.bucket,
						Key: input.key,
						Body: bytes,
						ContentType: input.contentType,
						IfNoneMatch: "*",
						Metadata: { sha256, "preview-fixture": input.fixtureTag },
					}),
					{ abortSignal: signal },
				),
				signal,
			);
		} catch (error) {
			if (!signal.aborted && status(error) === 412) created = false;
			else return fail(error, "PREVIEW_FIXTURE_WRITE_FAILED");
		}
		const stored = await head();
		if (!stored) throw new PreviewFixtureSeedError("PREVIEW_FIXTURE_CHANGED");
		const actual = await verify(stored);
		if (created && actual !== sha256)
			throw new PreviewFixtureSeedError("PREVIEW_FIXTURE_SHA_MISMATCH");
		return {
			key: input.key,
			status: created ? "CREATED" : "PRESERVED",
			sha256: actual,
		};
	} finally {
		clearTimeout(timer);
		input.signal?.removeEventListener("abort", canceled);
	}
}
