import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const send = vi.fn();
const clientConfigs: unknown[] = [];

vi.mock("@aws-sdk/client-s3", () => ({
	S3Client: class {
		constructor(config: unknown) {
			clientConfigs.push(config);
		}
		send = send;
		// Present because the real client has one and `createS3Browser`
		// registers the x-id strip on it. What that middleware actually does to
		// a request is pinned in `s3-x-id.test.ts`, against a signature-checking
		// server — a mocked stack can only record that `add` was called, and
		// mocking is precisely how the x-id defect stayed invisible.
		middlewareStack = { add: vi.fn() };
	},
	ListBucketsCommand: class {
		readonly kind = "ListBuckets";
		constructor(readonly input: unknown) {}
	},
	ListObjectsV2Command: class {
		readonly kind = "ListObjectsV2";
		constructor(readonly input: Record<string, unknown>) {}
	},
	GetObjectCommand: class {
		readonly kind = "GetObject";
		constructor(readonly input: Record<string, unknown>) {}
	},
	HeadObjectCommand: class {
		readonly kind = "HeadObject";
		constructor(readonly input: Record<string, unknown>) {}
	},
	PutObjectCommand: class {
		readonly kind = "PutObject";
		constructor(readonly input: Record<string, unknown>) {}
	},
}));

import { createS3Browser } from "./s3";
import { describeStorageError, ObjectVersionMismatchError } from "./types";

beforeEach(() => {
	vi.clearAllMocks();
	clientConfigs.length = 0;
});

const credentials = { accessKeyId: "a", secretAccessKey: "s" };

describe("createS3Browser", () => {
	it("opts readiness clients into a request timeout and one attempt only", () => {
		createS3Browser({ credentials, region: "us-east-1", readTimeoutMs: 5000 });
		expect(clientConfigs[0]).toMatchObject({
			maxAttempts: 1,
			requestHandler: {
				requestTimeout: 5000,
				connectionTimeout: 5000,
				socketTimeout: 5000,
				throwOnRequestTimeout: true,
			},
		});
	});
	it("omits endpoint config for plain AWS", () => {
		createS3Browser({ credentials, region: "ap-northeast-1" });
		expect(clientConfigs[0]).toEqual({
			region: "ap-northeast-1",
			credentials,
		});
	});

	it("uses path-style by default for custom endpoints", () => {
		createS3Browser({
			credentials,
			region: "jp-osa-1",
			endpoint: "https://jp-osa-1.linodeobjects.com",
		});
		expect(clientConfigs[0]).toMatchObject({
			endpoint: "https://jp-osa-1.linodeobjects.com",
			forcePathStyle: true,
		});
	});

	it("maps ListObjectsV2 output and caps page size at 100", async () => {
		send.mockResolvedValueOnce({
			CommonPrefixes: [{ Prefix: "videos/raw/" }],
			Contents: [
				{ Key: "videos/", Size: 0, LastModified: new Date("2026-01-01") },
				{
					Key: "videos/a.mp4",
					Size: 1024,
					LastModified: new Date("2026-02-02T00:00:00Z"),
				},
			],
			IsTruncated: true,
			NextContinuationToken: "token-2",
		});
		const browser = createS3Browser({ credentials, region: "us-east-1" });
		const result = await browser.listObjects({
			bucket: "b",
			prefix: "videos/",
			limit: 500,
		});

		const command = send.mock.calls[0]?.[0] as {
			input: Record<string, unknown>;
		};
		expect(command.input).toMatchObject({
			Bucket: "b",
			Prefix: "videos/",
			Delimiter: "/",
			MaxKeys: 100,
		});
		expect(result.prefixes).toEqual(["videos/raw/"]);
		// The zero-byte prefix marker is filtered out.
		expect(result.objects).toEqual([
			{
				key: "videos/a.mp4",
				size: 1024,
				lastModified: "2026-02-02T00:00:00.000Z",
			},
		]);
		expect(result.nextCursor).toBe("token-2");
	});

	it("omits the delimiter when recursive, returning deeply-nested keys", async () => {
		// The per-title qc-mirror case: objects live 2+ segments below the prefix.
		// A delimited list would only return the rung folders as CommonPrefixes;
		// recursive must return the deep .mp4 objects in Contents.
		send.mockResolvedValueOnce({
			Contents: [
				{ Key: "out/job/360_500000_uuid/qc/v1.mp4", Size: 10 },
				{ Key: "out/job/720_1500000_uuid/qc/v1.mp4", Size: 20 },
			],
			IsTruncated: false,
		});
		const browser = createS3Browser({ credentials, region: "us-east-1" });
		const result = await browser.listObjects({
			bucket: "b",
			prefix: "out/job/",
			recursive: true,
		});
		const command = send.mock.calls[0]?.[0] as {
			input: Record<string, unknown>;
		};
		expect(command.input.Delimiter).toBeUndefined();
		expect(result.objects.map((o) => o.key)).toEqual([
			"out/job/360_500000_uuid/qc/v1.mp4",
			"out/job/720_1500000_uuid/qc/v1.mp4",
		]);
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
		send.mockResolvedValueOnce({
			Contents: [{ Key: key, Size: size }],
			IsTruncated: false,
		});
		const browser = createS3Browser({ credentials, region: "us-east-1" });
		const result = await browser.listObjects({
			bucket: "b",
			prefix: key,
			limit: 100,
			recursive,
		});
		expect(result.objects).toEqual([{ key, size, lastModified: undefined }]);
	});

	it("returns no cursor when the listing is complete", async () => {
		send.mockResolvedValueOnce({ IsTruncated: false, Contents: [] });
		const browser = createS3Browser({ credentials, region: "us-east-1" });
		const result = await browser.listObjects({ bucket: "b" });
		expect(result.nextCursor).toBeUndefined();
		expect(result.objects).toEqual([]);
	});

	it("lists bucket names", async () => {
		send.mockResolvedValueOnce({
			Buckets: [{ Name: "alpha" }, { Name: "beta" }, {}],
		});
		const browser = createS3Browser({ credentials, region: "us-east-1" });
		await expect(browser.listBuckets()).resolves.toEqual(["alpha", "beta"]);
	});

	it("getObject streams the body (feeder spool download path)", async () => {
		const body = { pipe: () => body, on: () => body };
		send.mockResolvedValueOnce({ Body: body });
		const browser = createS3Browser({ credentials, region: "us-east-1" });
		const stream = await browser.getObject?.({ bucket: "b", key: "loop.mp4" });
		expect(stream).toBe(body);
		const command = send.mock.calls[0]?.[0] as {
			kind: string;
			input: Record<string, unknown>;
		};
		expect(command.kind).toBe("GetObject");
		expect(command.input).toEqual({ Bucket: "b", Key: "loop.mp4" });
	});

	it("getObject rejects non-stream bodies loudly (non-Node runtime guard)", async () => {
		send.mockResolvedValueOnce({ Body: undefined });
		const browser = createS3Browser({ credentials, region: "us-east-1" });
		await expect(
			browser.getObject?.({ bucket: "b", key: "k" }),
		).rejects.toThrow(/no readable body/);
	});

	describe("ranged reads", () => {
		it("sends an inclusive HTTP Range and accepts a 206 (Content-Range present)", async () => {
			const body = { pipe: () => body, on: () => body };
			send.mockResolvedValueOnce({
				Body: body,
				ContentRange: "bytes 0-8388607/104857600",
			});
			const browser = createS3Browser({ credentials, region: "us-east-1" });
			const stream = await browser.getObject?.({
				bucket: "b",
				key: "k",
				range: { start: 0, end: 8388607 },
			});
			expect(stream).toBe(body);
			const command = send.mock.calls[0]?.[0] as {
				input: Record<string, unknown>;
			};
			expect(command.input.Range).toBe("bytes=0-8388607");
		});

		it("REJECTS a response with no Content-Range — the endpoint ignored the range", async () => {
			// A non-range-capable S3-compatible endpoint answers 200 with the whole
			// object. Returning that stream would silently turn a bounded read into
			// a full download of a possibly multi-GB object.
			const destroy = vi.fn();
			send.mockResolvedValueOnce({
				Body: { pipe: () => undefined, on: () => undefined, destroy },
			});
			const browser = createS3Browser({ credentials, region: "us-east-1" });
			await expect(
				browser.getObject?.({
					bucket: "b",
					key: "big.mp4",
					range: { start: 0, end: 1023 },
				}),
			).rejects.toThrow(/ignored the byte-range request/);
			// The body must be torn down, or the connection leaks while the server
			// keeps pushing the object nobody will read.
			expect(destroy).toHaveBeenCalledTimes(1);
		});

		it("does NOT require Content-Range when no range was asked for", async () => {
			const body = { pipe: () => body, on: () => body };
			send.mockResolvedValueOnce({ Body: body });
			const browser = createS3Browser({ credentials, region: "us-east-1" });
			await expect(
				browser.getObject?.({ bucket: "b", key: "k" }),
			).resolves.toBe(body);
		});

		it("sends an open-ended Range when end is omitted", async () => {
			const body = { pipe: () => body, on: () => body };
			send.mockResolvedValueOnce({
				Body: body,
				ContentRange: "bytes 100-999/1000",
			});
			const browser = createS3Browser({ credentials, region: "us-east-1" });
			await browser.getObject?.({
				bucket: "b",
				key: "k",
				range: { start: 100 },
			});
			const command = send.mock.calls[0]?.[0] as {
				input: Record<string, unknown>;
			};
			expect(command.input.Range).toBe("bytes=100-");
		});
	});
});

describe("describeStorageError", () => {
	/**
	 * Two requirements that pull in opposite directions, and combining two
	 * independently-correct changes broke the second one:
	 *  - Azure's RestError names itself "RestError" and puts the useful service
	 *    code on `code`, so a string `code` has to outrank the class name.
	 *  - Node system errnos also live on `code`, and surfacing those rebuilds the
	 *    network-probe oracle C20 exists to remove — ECONNREFUSED vs ENOTFOUND vs
	 *    ETIMEDOUT distinguishes open from closed from filtered, and a resolvable
	 *    host from an unresolvable one, with no IP required.
	 */
	it("surfaces an AWS `Code` with its http status", () => {
		expect(
			describeStorageError({
				Code: "NoSuchBucket",
				$metadata: { httpStatusCode: 404 },
			}),
		).toEqual({ code: "NoSuchBucket", status: 404 });
	});

	it("surfaces an Azure service code over the class name", () => {
		expect(
			describeStorageError({
				name: "RestError",
				code: "ContainerNotFound",
				statusCode: 404,
			}),
		).toEqual({ code: "ContainerNotFound", status: 404 });
	});

	it("surfaces a GCS numeric code as the status", () => {
		expect(describeStorageError({ name: "ApiError", code: 403 })).toEqual({
			code: "ApiError",
			status: 403,
		});
	});

	it("does NOT surface a Node errno — that is the reachability oracle", () => {
		for (const errno of [
			"ECONNREFUSED",
			"ENOTFOUND",
			"ETIMEDOUT",
			"EAI_AGAIN",
			"ECONNRESET",
			"E2BIG",
			"UND_ERR_CONNECT_TIMEOUT",
		]) {
			expect(
				describeStorageError({ name: "Error", code: errno }),
				errno,
			).toEqual({ code: "StorageError" });
		}
	});

	it("does not surface the error CLASS for a transport failure either", () => {
		// Excluding the errno from `code` only moved the oracle to `name`: Node
		// wraps some connect failures in AggregateError (happy-eyeballs) while a
		// DNS miss stays a plain Error, so the class name alone still separates
		// "host up, port closed" from "did not resolve" (review catch). Both real
		// cases carry errno/syscall, which is what this keys on.
		expect(
			describeStorageError({
				name: "AggregateError",
				code: "ECONNREFUSED",
				errno: -61,
				syscall: "connect",
			}),
		).toEqual({ code: "StorageError" });
		expect(
			describeStorageError({
				name: "Error",
				code: "ENOTFOUND",
				errno: -3008,
				syscall: "getaddrinfo",
			}),
		).toEqual({ code: "StorageError" });
		// errno/syscall alone is enough, even with an unfamiliar code.
		expect(
			describeStorageError({ name: "AggregateError", syscall: "connect" }),
		).toEqual({ code: "StorageError" });
	});

	it("still surfaces a SERVICE code that happens to travel with a status", () => {
		// The fix must not swallow real service classifications.
		expect(
			describeStorageError({
				name: "RestError",
				code: "AuthenticationFailed",
				statusCode: 403,
			}),
		).toEqual({ code: "AuthenticationFailed", status: 403 });
		expect(
			describeStorageError({
				Code: "NoSuchKey",
				$metadata: { httpStatusCode: 404 },
			}),
		).toEqual({ code: "NoSuchKey", status: 404 });
	});

	it("falls back to a stable label for a non-error", () => {
		expect(describeStorageError(undefined)).toEqual({ code: "StorageError" });
		expect(describeStorageError(null)).toEqual({ code: "StorageError" });
		expect(describeStorageError("boom")).toEqual({ code: "StorageError" });
	});
});

/**
 * Exact-version reads.
 *
 * The thing being pinned is not "the code has an `expect` field": it is that
 * the field REACHES THE SDK. A previous PR in this repo shipped an optional
 * spread that compiled, typechecked, passed biome and passed 7208 tests while
 * dropping the field it was spreading, because excess-property checking does
 * not reach into a spread. So every arm below reads the recorded command input.
 */
describe("createS3Browser exact-version reads", () => {
	const readableBody = () => {
		const { Readable } = require("node:stream") as typeof import("node:stream");
		return Readable.from([Buffer.from("bytes")]);
	};

	function lastInput(kind: string): Record<string, unknown> {
		const calls = send.mock.calls.map(
			(c) => c[0] as { kind: string; input: Record<string, unknown> },
		);
		const match = calls.filter((c) => c.kind === kind).at(-1);
		if (!match) {
			throw new Error(
				`no ${kind} command was sent (sent: ${calls.map((c) => c.kind).join(", ") || "nothing"})`,
			);
		}
		return match.input;
	}

	it("headObject reports etag, versionId, size and lastModified", async () => {
		send.mockResolvedValue({
			ETag: '"abc123"',
			VersionId: "v-9",
			ContentLength: 4096,
			LastModified: new Date("2026-08-28T00:00:00.000Z"),
		});
		const browser = createS3Browser({ credentials, region: "us-east-1" });
		const id = await browser.headObject?.({ bucket: "b", key: "k" });
		expect(id).toEqual({
			// QUOTES KEPT. S3 wants the same string back in If-Match, and a
			// driver that stripped them here would make every later exact-version
			// read fail as a "mismatch" while the bytes were untouched.
			etag: '"abc123"',
			versionId: "v-9",
			size: 4096,
			lastModified: "2026-08-28T00:00:00.000Z",
		});
	});

	it('drops the unversioned bucket\'s literal "null" versionId', async () => {
		// An unversioned bucket reports versionId "null". Recording that and
		// sending it back selects nothing at all, so it must never become an
		// expectation.
		send.mockResolvedValue({
			ETag: '"e"',
			VersionId: "null",
			ContentLength: 1,
		});
		const browser = createS3Browser({ credentials, region: "us-east-1" });
		const id = await browser.headObject?.({ bucket: "b", key: "k" });
		expect(id).toEqual({ etag: '"e"', size: 1 });
		expect(id).not.toHaveProperty("versionId");
	});

	it("sends BOTH VersionId and If-Match when both were recorded", async () => {
		send.mockResolvedValue({ Body: readableBody() });
		const browser = createS3Browser({ credentials, region: "us-east-1" });
		await browser.getObject?.({
			bucket: "b",
			key: "k",
			expect: { etag: '"abc123"', versionId: "v-9" },
		});
		const input = lastInput("GetObject");
		expect(input.VersionId).toBe("v-9");
		expect(input.IfMatch).toBe('"abc123"');
	});

	it("sends NEITHER when no expectation is given (browsing stays unconditional)", async () => {
		send.mockResolvedValue({ Body: readableBody() });
		const browser = createS3Browser({ credentials, region: "us-east-1" });
		await browser.getObject?.({ bucket: "b", key: "k" });
		const input = lastInput("GetObject");
		expect(input).not.toHaveProperty("VersionId");
		expect(input).not.toHaveProperty("IfMatch");
	});

	it("an etag-only expectation still sends If-Match (unversioned buckets)", async () => {
		send.mockResolvedValue({ Body: readableBody() });
		const browser = createS3Browser({ credentials, region: "us-east-1" });
		await browser.getObject?.({
			bucket: "b",
			key: "k",
			expect: { etag: '"e"' },
		});
		const input = lastInput("GetObject");
		expect(input.IfMatch).toBe('"e"');
		expect(input).not.toHaveProperty("VersionId");
	});

	it("AKAMAI/GenericS3: the conditional read flows through a custom endpoint too", async () => {
		/*
		 * Akamai Object Storage is GenericS3 under constraint C10, so THIS
		 * driver is the Akamai path — and review pointed out that every
		 * exact-version arm above builds a plain `{credentials, region}` client.
		 * The one test in this file that models Akamai only checks client
		 * config, so "Akamai never exercises getObject" was literally true.
		 *
		 * There is no separate code path (the x-id middleware touches only
		 * `request.query["x-id"]` and never VersionId/IfMatch), which is why
		 * this is coverage rather than a fix. But "the Akamai endpoint never
		 * runs the feature" is a sentence worth not being able to say.
		 */
		send.mockResolvedValue({ Body: readableBody() });
		const browser = createS3Browser({
			credentials,
			region: "jp-osa-1",
			endpoint: "https://jp-osa-1.linodeobjects.com",
		});
		await browser.getObject?.({
			bucket: "b",
			key: "k",
			expect: { etag: '"abc123"', versionId: "v-9" },
		});
		const input = lastInput("GetObject");
		expect(input.IfMatch).toBe('"abc123"');
		expect(input.VersionId).toBe("v-9");
	});

	it("AKAMAI unversioned: If-Match rides ALONE and that is the safety property", async () => {
		/*
		 * The load-bearing fact for the Akamai threat model, pinned so a future
		 * refactor cannot quietly make VersionId a PRECONDITION of sending
		 * IfMatch.
		 *
		 * Akamai supports versioning but ships it OFF, and its own first-party
		 * tooling cannot enable it — so the realistic Akamai credential is an
		 * unversioned bucket, where `headObject` returns no versionId and the
		 * expectation carries an etag only. That is not a degraded mode: S3's
		 * ETag is content-derived (MD5 for a single PUT; a composite hash plus
		 * "-N" for multipart), so If-Match alone already refuses the audit's
		 * literal scenario — a same-size overwrite. VersionId is ADDITIVE to
		 * that check, never a substitute for it.
		 *
		 * The residual, which no test can settle and which is recorded in
		 * whether Akamai's ETag is content-derived the way AWS's
		 * is. That needs two same-size different-content PUTs against a real
		 * bucket.
		 */
		send.mockResolvedValue({ Body: readableBody() });
		const browser = createS3Browser({
			credentials,
			region: "jp-osa-1",
			endpoint: "https://jp-osa-1.linodeobjects.com",
		});
		await browser.getObject?.({
			bucket: "b",
			key: "k",
			expect: { etag: '"content-hash"' },
		});
		const input = lastInput("GetObject");
		expect(input.IfMatch).toBe('"content-hash"');
		expect(input).not.toHaveProperty("VersionId");
	});

	it("a 412 becomes ObjectVersionMismatchError, naming what was expected", async () => {
		send.mockRejectedValue(
			Object.assign(new Error("At least one of the pre-conditions failed"), {
				name: "PreconditionFailed",
				$metadata: { httpStatusCode: 412 },
			}),
		);
		const browser = createS3Browser({ credentials, region: "us-east-1" });
		const err = await browser
			.getObject?.({ bucket: "b", key: "k", expect: { etag: '"old"' } })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ObjectVersionMismatchError);
		expect((err as ObjectVersionMismatchError).bucket).toBe("b");
		expect((err as ObjectVersionMismatchError).key).toBe("k");
		expect((err as Error).message).toContain('etag "old"');
		// The message has to say the bytes were REPLACED, because the operator's
		// next action differs from a transport failure's: re-record, not retry.
		expect((err as Error).message).toContain("replaced");
	});

	it("NoSuchVersion is the same condition, not a generic failure", async () => {
		// A recorded versionId that has since been permanently deleted. From the
		// caller's side this is identical to a mismatch — the named bytes are not
		// retrievable — and it must not surface as something retryable.
		send.mockRejectedValue(
			Object.assign(new Error("The specified version does not exist."), {
				name: "NoSuchVersion",
				$metadata: { httpStatusCode: 404 },
			}),
		);
		const browser = createS3Browser({ credentials, region: "us-east-1" });
		const err = await browser
			.getObject?.({ bucket: "b", key: "k", expect: { versionId: "gone" } })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ObjectVersionMismatchError);
	});

	it("a 412 with NO expectation is left alone — it is not ours to relabel", async () => {
		// Nothing asked for a version, so a precondition failure came from
		// somewhere else and relabelling it would invent an overwrite.
		const original = Object.assign(new Error("precondition"), {
			name: "PreconditionFailed",
			$metadata: { httpStatusCode: 412 },
		});
		send.mockRejectedValue(original);
		const browser = createS3Browser({ credentials, region: "us-east-1" });
		const err = await browser
			.getObject?.({ bucket: "b", key: "k" })
			.catch((e: unknown) => e);
		expect(err).toBe(original);
		expect(err).not.toBeInstanceOf(ObjectVersionMismatchError);
	});

	it("InvalidArgument is NOT a mismatch — it is S3's generic malformed-parameter 400", async () => {
		/*
		 * Self-found during review of this PR. The first cut mapped
		 * `InvalidArgument` to a version mismatch, on the theory that a
		 * malformed VersionId lands there. But `InvalidArgument` is what S3
		 * answers for a bad Range, an unsupported argument and much else — so
		 * any unrelated request defect occurring under an expectation would
		 * have told the operator "the object's bytes were replaced", sending
		 * them to hunt an overwrite that never happened.
		 *
		 * That is the exact failure `VersionExpectationUnsupportedError` was
		 * added to this PR to prevent, committed two functions away in the same
		 * file. `NoSuchVersion` stays a mismatch: the named bytes really are
		 * not retrievable, which is the caller's same condition as a 412.
		 */
		const original = Object.assign(new Error("Invalid argument"), {
			name: "InvalidArgument",
			$metadata: { httpStatusCode: 400 },
		});
		send.mockRejectedValue(original);
		const browser = createS3Browser({ credentials, region: "us-east-1" });
		const err = await browser
			.getObject?.({
				bucket: "b",
				key: "k",
				expect: { etag: '"e"', versionId: "v-1" },
			})
			.catch((e: unknown) => e);
		expect(err).toBe(original);
		expect(err).not.toBeInstanceOf(ObjectVersionMismatchError);
	});

	it("an UNRELATED failure under an expectation stays itself", async () => {
		// The classifier must not swallow everything that happens to fail during
		// a conditional read — a 403 is a credential problem, not an overwrite.
		const original = Object.assign(new Error("Access Denied"), {
			name: "AccessDenied",
			$metadata: { httpStatusCode: 403 },
		});
		send.mockRejectedValue(original);
		const browser = createS3Browser({ credentials, region: "us-east-1" });
		const err = await browser
			.getObject?.({ bucket: "b", key: "k", expect: { etag: '"e"' } })
			.catch((e: unknown) => e);
		expect(err).toBe(original);
	});
});

describe("putObject (row #330: the normalized slate goes back next to its source)", () => {
	it("streams the local file with its byte length and content type", async () => {
		const { mkdtemp, writeFile } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = await mkdtemp(join(tmpdir(), "s3-put-"));
		const filePath = join(dir, "brb.ts");
		await writeFile(filePath, Buffer.alloc(1234, 1));
		send.mockResolvedValueOnce({});
		const browser = createS3Browser({ region: "ap-northeast-1", credentials });
		await browser.putObject?.({
			bucket: "b",
			key: "slates/brb.normalized-1280x720-30-48000-2ch.ts",
			filePath,
			contentType: "video/mp2t",
		});
		expect(send).toHaveBeenCalledTimes(1);
		const command = send.mock.calls[0]?.[0] as {
			kind: string;
			input: Record<string, unknown>;
		};
		expect(command.kind).toBe("PutObject");
		expect(command.input).toMatchObject({
			Bucket: "b",
			Key: "slates/brb.normalized-1280x720-30-48000-2ch.ts",
			ContentLength: 1234,
			ContentType: "video/mp2t",
		});
		expect(typeof (command.input.Body as { pipe?: unknown }).pipe).toBe(
			"function",
		);
	});
});

describe("GCS ranged responses with the real SDK checksum middleware", () => {
	// Standard CRC32C vector: CRC32C("123456789") = 0xe3069283.
	const original = Buffer.from("123456789");
	const requests: {
		range?: string;
		ifMatch?: string;
		checksumMode?: string;
		url: string;
	}[] = [];
	let server: Server;
	let endpoint: string;
	let createRealBrowser: typeof createS3Browser;

	beforeAll(async () => {
		// The unit-test SDK stub cannot reproduce middleware validation. Reload
		// this driver with the real SDK and use only a local HTTP fixture.
		vi.doUnmock("@aws-sdk/client-s3");
		vi.resetModules();
		createRealBrowser = (await import("./s3")).createS3Browser;
		server = createServer((req, res) => {
			requests.push({
				range: req.headers.range,
				ifMatch: req.headers["if-match"] as string | undefined,
				checksumMode: req.headers["x-amz-checksum-mode"] as string | undefined,
				url: req.url ?? "",
			});
			if (req.headers["if-match"] === '"old"') {
				res.writeHead(412, { "content-type": "application/xml" });
				res.end("<Error><Code>PreconditionFailed</Code></Error>");
				return;
			}
			const ignored = req.url?.includes("ignored-range");
			const range = req.headers.range && !ignored;
			const body = range ? original.subarray(0, 4) : original;
			const headers: Record<string, string | number> = {
				"content-length": body.length,
				// GCS XML describes the whole object even when returning a slice.
				"x-amz-checksum-crc32c": req.url?.includes("bad-full")
					? "AAAAAA=="
					: "4waSgw==",
			};
			if (range) {
				headers["content-range"] = `bytes 0-3/${original.length}`;
			}
			res.writeHead(range ? 206 : 200, headers);
			res.end(body);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	async function bytes(
		stream: NodeJS.ReadableStream | Promise<NodeJS.ReadableStream> | undefined,
	) {
		const chunks: Buffer[] = [];
		for await (const chunk of (await stream) as Readable)
			chunks.push(Buffer.from(chunk));
		return Buffer.concat(chunks);
	}

	function browser(gcs = true) {
		return createRealBrowser({
			credentials,
			region: "us-east-1",
			endpoint,
			rangeChecksumsAreWholeObject: gcs,
		});
	}

	it("reads a GCS slice without comparing it with the whole-object CRC32C and retains identity pins", async () => {
		const storage = browser();
		try {
			expect(
				await bytes(
					await storage.getObject?.({
						bucket: "b",
						key: "range.mp4",
						range: { start: 0, end: 3 },
						expect: { etag: '"current"', versionId: "v-1" },
					}),
				),
			).toEqual(original.subarray(0, 4));
			expect(requests.at(-1)).toMatchObject({
				range: "bytes=0-3",
				ifMatch: '"current"',
				checksumMode: undefined,
			});
			expect(requests.at(-1)?.url).toContain("versionId=v-1");
		} finally {
			storage.dispose?.();
		}
	});

	it("keeps checksum validation for ranged reads from other S3 providers", async () => {
		const storage = browser(false);
		try {
			await expect(
				bytes(
					storage.getObject?.({
						bucket: "b",
						key: "range.mp4",
						range: { start: 0, end: 3 },
					}),
				),
			).rejects.toThrow(/Checksum mismatch.*x-amz-checksum-crc32c/);
		} finally {
			storage.dispose?.();
		}
	});

	it("still rejects a bad full-download CRC32C for GCS", async () => {
		const storage = browser();
		try {
			await expect(
				bytes(storage.getObject?.({ bucket: "b", key: "bad-full.mp4" })),
			).rejects.toThrow(/Checksum mismatch.*x-amz-checksum-crc32c/);
		} finally {
			storage.dispose?.();
		}
	});

	it("accepts a full GCS download with the correct CRC32C", async () => {
		const storage = browser();
		try {
			expect(
				await bytes(
					await storage.getObject?.({ bucket: "b", key: "full.mp4" }),
				),
			).toEqual(original);
			expect(requests.at(-1)?.checksumMode).toBe("ENABLED");
		} finally {
			storage.dispose?.();
		}
	});

	it("still rejects a GCS response that ignores the requested range", async () => {
		const storage = browser();
		try {
			await expect(
				storage.getObject?.({
					bucket: "b",
					key: "ignored-range.mp4",
					range: { start: 0, end: 3 },
				}),
			).rejects.toThrow(/ignored the byte-range request/);
		} finally {
			storage.dispose?.();
		}
	});

	it("still reports failed GCS range identity expectations as replacement", async () => {
		const storage = browser();
		try {
			await expect(
				storage.getObject?.({
					bucket: "b",
					key: "range.mp4",
					range: { start: 0, end: 3 },
					expect: { etag: '"old"' },
				}),
			).rejects.toThrow(/replaced/);
		} finally {
			storage.dispose?.();
		}
	});
});
