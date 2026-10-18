import { beforeEach, describe, expect, it, vi } from "vitest";

const listContainers = vi.fn();
const listBlobsFlat = vi.fn();
const listBlobsByHierarchy = vi.fn();
const download = vi.fn();
const getProperties = vi.fn();
/**
 * Every `withVersion(id)` the driver called. Azure
 * selects a blob VERSION on the client, not in `download`'s options, so the
 * only way to see that a recorded versionId was honoured is to record the call.
 */
const withVersionCalls: string[] = [];
/**
 * The version-selected client's OWN download spy, separate from `download`.
 *
 * This separation is the assertion, not bookkeeping. Verified against the
 * installed @azure/storage-blob 12.33.0: `withVersion(versionId): BlobClient`
 * returns a NEW client. A mock that returned `this` would resolve `download` to
 * the same spy either way, so a driver that called `withVersion(...)` and then
 * downloaded from the UNVERSIONED client — reading current bytes while
 * believing it pinned a version — would satisfy every assertion. Recording the
 * call and recording the download are two facts; which client was downloaded
 * from is the join between them.
 */
const versionedDownload = vi.fn();
/**
 * Shape set in `beforeEach` (which calls `mockReturnValue` on it), so the
 * declaration only needs to exist. Kept as a bare `vi.fn` rather than
 * carrying a second copy of the client shape that would drift from the one
 * actually used.
 */
const getBlobClient = vi.fn();
const getContainerClient = vi.fn(() => ({
	listBlobsFlat,
	listBlobsByHierarchy,
	getBlobClient,
}));
/**
 * EVERY constructor argument, not just the URL: the real signature is
 * `BlobServiceClient(url, credentialOrPipeline?, options?)` with the credential
 * OPTIONAL (SAS/anonymous URLs exist), so a driver that built the credential
 * and forgot to pass it typechecks cleanly and fails only against real Azure.
 * Capturing arg 2 is the only way a test can see the wiring.
 */
const serviceArgs: unknown[][] = [];
/** Every `.byPage` settings object the driver sent, in call order. */
const pageSettings: unknown[] = [];

vi.mock("@azure/storage-blob", () => ({
	BlobServiceClient: class {
		constructor(...args: unknown[]) {
			serviceArgs.push(args);
		}
		listContainers = listContainers;
		getContainerClient = getContainerClient;
	},
	StorageSharedKeyCredential: class {
		constructor(
			readonly accountName: string,
			readonly accountKey: string,
		) {}
	},
}));

import { StorageSharedKeyCredential } from "@azure/storage-blob";
import { createAzureBrowser } from "./azure";
import { ObjectVersionMismatchError, UnsupportedBrowseError } from "./types";

it("opts readiness clients into one bounded request attempt", () => {
	createAzureBrowser({
		accountName: "account",
		accountKey: "key",
		readTimeoutMs: 5000,
	});
	expect(serviceArgs.at(-1)?.[2]).toEqual({
		retryOptions: { maxTries: 1, tryTimeoutInMs: 5000 },
	});
});

/** One SDK page iterator: byPage records its settings, next replays pages. */
function pager(pages: unknown[]) {
	return {
		byPage: (settings: unknown) => {
			pageSettings.push(settings);
			let index = 0;
			return {
				next: async () =>
					index < pages.length
						? { done: false, value: pages[index++] }
						: { done: true, value: undefined },
			};
		},
	};
}

function blob(name: string, size = 0, lastModified?: Date) {
	return { name, properties: { contentLength: size, lastModified } };
}

async function* iterate<T>(items: T[]) {
	for (const item of items) {
		yield item;
	}
}

/**
 * Verbatim port of @azure/storage-blob 12.33.0 `dist/commonjs/Range.js` — the
 * one place the SDK turns (offset, count) into a header value.
 */
function rangeToString(iRange: { offset: number; count?: number }): string {
	if (iRange.offset < 0) {
		throw new RangeError("Range.offset cannot be smaller than 0.");
	}
	if (iRange.count && iRange.count <= 0) {
		throw new RangeError("Range.count must be larger than 0.");
	}
	return iRange.count
		? `bytes=${iRange.offset}-${iRange.offset + iRange.count - 1}`
		: `bytes=${iRange.offset}-`;
}

/** Range header values the modelled SDK put on the wire, in call order. */
const rangeHeaders: (string | undefined)[] = [];

/**
 * A `download` that REPLAYS the SDK's own request shaping instead of handing
 * back a canned reply, because the request and the reply are not independent:
 * for `offset === 0 && !count`, Clients.js:285 sends NO Range header at all, so
 * no compliant response to that call can carry a Content-Range. A test that
 * sets `{contentRange}` freely alongside any (offset, count) invents a reply
 * Azure cannot produce — which is exactly how a guard that rejects a legal
 * range can stay green.
 *
 * `rogue` models the endpoint the guard exists for: one that receives the Range
 * header, ignores it, and answers 200 with the whole blob.
 */
function modelledDownload(
	body: unknown,
	blobSize: number,
	{ rogue = false }: { rogue?: boolean } = {},
) {
	return async (offset = 0, count?: number) => {
		// Clients.js:285, verbatim.
		const range =
			offset === 0 && !count ? undefined : rangeToString({ offset, count });
		rangeHeaders.push(range);
		if (!range || rogue) {
			// No Range header — or one the endpoint ignored — means the whole blob,
			// 200, no Content-Range, and a stream that ends cleanly.
			return { readableStreamBody: body, contentLength: blobSize };
		}
		const last = count ? offset + count - 1 : blobSize - 1;
		return {
			readableStreamBody: body,
			contentLength: last - offset + 1,
			contentRange: `bytes ${offset}-${last}/${blobSize}`,
		};
	};
}

/** A readable body carrying a destroy spy, so an aborted read is observable. */
function streamBody() {
	const body: { pipe: () => unknown; destroy: ReturnType<typeof vi.fn> } = {
		pipe: () => body,
		destroy: vi.fn(),
	};
	return body;
}

beforeEach(() => {
	vi.clearAllMocks();
	// clearAllMocks keeps implementations, so a modelled download would leak
	// into the next test.
	download.mockReset();
	getProperties.mockReset();
	versionedDownload.mockReset();
	serviceArgs.length = 0;
	pageSettings.length = 0;
	withVersionCalls.length = 0;
	rangeHeaders.length = 0;
	// The blob client the driver gets, and — as the real SDK does — a DISTINCT
	// client from `withVersion`, carrying its own download spy.
	const versionedClient = { download: versionedDownload, getProperties };
	const blobClient: Record<string, unknown> = { download, getProperties };
	blobClient.withVersion = (id: string) => {
		withVersionCalls.push(id);
		return versionedClient;
	};
	getBlobClient.mockReturnValue(blobClient);
	getContainerClient.mockReturnValue({
		listBlobsFlat,
		listBlobsByHierarchy,
		getBlobClient,
	});
});

const options = { accountName: "acct", accountKey: "a2V5" };

describe("createAzureBrowser", () => {
	it.each([
		{ key: "archive.mp4", size: 1024, recursive: false },
		{ key: "out/run/archive.mp4", size: 2048, recursive: false },
		{ key: "out/run/archive.mp4", size: 0, recursive: true },
	])("retains an exact non-directory prefix object: $key, recursive=$recursive", async ({
		key,
		size,
		recursive,
	}) => {
		const list = recursive ? listBlobsFlat : listBlobsByHierarchy;
		list.mockReturnValueOnce(
			pager([
				{ segment: { blobItems: [blob(key, size)] }, continuationToken: "" },
			]),
		);
		const result = await createAzureBrowser(options).listObjects({
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
		const list = recursive ? listBlobsFlat : listBlobsByHierarchy;
		list.mockReturnValueOnce(
			pager([
				{
					segment: {
						blobItems: [blob("out/", 0), blob("out/archive.mp4", 1024)],
					},
					continuationToken: "",
				},
			]),
		);
		const result = await createAzureBrowser(options).listObjects({
			bucket: "b",
			prefix: "out/",
			recursive,
		});
		expect(result.objects.map((object) => object.key)).toEqual([
			"out/archive.mp4",
		]);
	});
	it("derives the blob endpoint from the account name and signs with the key", () => {
		createAzureBrowser(options);
		expect(serviceArgs[0]?.[0]).toBe("https://acct.blob.core.windows.net");
		// The credential must reach the CLIENT, not merely be constructed: the
		// second argument is optional in the real signature, so "built it and
		// dropped it" is a typechecking bug that only real Azure would catch.
		expect(serviceArgs[0]?.[1]).toBeInstanceOf(StorageSharedKeyCredential);
		expect(serviceArgs[0]?.[1]).toMatchObject({
			accountName: "acct",
			accountKey: "a2V5",
		});
	});

	it("refuses an incomplete credential instead of 403ing later", () => {
		expect(() =>
			createAzureBrowser({ accountName: "", accountKey: "k" }),
		).toThrow(UnsupportedBrowseError);
		expect(() =>
			createAzureBrowser({ accountName: "acct", accountKey: "" }),
		).toThrow(/account name or key/);
	});

	it("lists containers as buckets", async () => {
		listContainers.mockReturnValueOnce(
			iterate([{ name: "alpha" }, { name: "beta" }]),
		);
		const browser = createAzureBrowser(options);
		await expect(browser.listBuckets()).resolves.toEqual(["alpha", "beta"]);
	});

	it("browses folder-by-folder with the / delimiter and caps page size at 100", async () => {
		listBlobsByHierarchy.mockReturnValueOnce(
			pager([
				{
					segment: {
						blobPrefixes: [{ name: "videos/raw/" }],
						blobItems: [
							blob("videos/", 0),
							blob("videos/a.mp4", 1024, new Date("2026-02-02T00:00:00Z")),
						],
					},
					continuationToken: "token-2",
				},
			]),
		);
		const browser = createAzureBrowser(options);
		const result = await browser.listObjects({
			bucket: "media",
			prefix: "videos/",
			limit: 500,
		});

		expect(getContainerClient).toHaveBeenCalledWith("media");
		expect(listBlobsByHierarchy).toHaveBeenCalledWith("/", {
			prefix: "videos/",
		});
		expect(pageSettings[0]).toEqual({
			continuationToken: undefined,
			maxPageSize: 100,
		});
		expect(result.prefixes).toEqual(["videos/raw/"]);
		// The zero-byte directory blob for the prefix itself is filtered out.
		expect(result.objects).toEqual([
			{
				key: "videos/a.mp4",
				size: 1024,
				lastModified: "2026-02-02T00:00:00.000Z",
			},
		]);
		expect(result.nextCursor).toBe("token-2");
	});

	it("ends a FOLDER listing on the empty token too, not just a recursive one", async () => {
		// The branch normal folder-by-folder browsing uses. An "" surviving here
		// reaches TanStack's getNextPageParam, where `?? null` lets it through:
		// hasNextPage goes true and "Load more" re-sends no cursor, so page 1 is
		// refetched forever with duplicate React keys.
		listBlobsByHierarchy.mockReturnValueOnce(
			pager([
				{
					segment: { blobPrefixes: [], blobItems: [blob("videos/a.mp4", 1)] },
					continuationToken: "",
				},
			]),
		);
		const browser = createAzureBrowser(options);
		const result = await browser.listObjects({
			bucket: "media",
			prefix: "videos/",
		});
		expect(result.objects.map((o) => o.key)).toEqual(["videos/a.mp4"]);
		expect(result.nextCursor).toBeUndefined();
	});

	it("lists flat when recursive, returning deeply-nested keys and no prefixes", async () => {
		listBlobsFlat.mockReturnValueOnce(
			pager([
				{
					segment: {
						blobItems: [
							blob("out/job/360_500000_uuid/qc/v1.mp4", 10),
							blob("out/job/720_1500000_uuid/qc/v1.mp4", 20),
						],
					},
					continuationToken: "",
				},
			]),
		);
		const browser = createAzureBrowser(options);
		const result = await browser.listObjects({
			bucket: "media",
			prefix: "out/job/",
			recursive: true,
		});

		expect(listBlobsByHierarchy).not.toHaveBeenCalled();
		expect(listBlobsFlat).toHaveBeenCalledWith({ prefix: "out/job/" });
		expect(result.prefixes).toEqual([]);
		expect(result.objects.map((o) => o.key)).toEqual([
			"out/job/360_500000_uuid/qc/v1.mp4",
			"out/job/720_1500000_uuid/qc/v1.mp4",
		]);
		// Azure ends a listing with an EMPTY token, which must not surface as a
		// cursor — the caller would page forever.
		expect(result.nextCursor).toBeUndefined();
	});

	it("passes a cursor through as the continuation token", async () => {
		listBlobsByHierarchy.mockReturnValueOnce(
			pager([{ segment: { blobItems: [] }, continuationToken: "t3" }]),
		);
		const browser = createAzureBrowser(options);
		const result = await browser.listObjects({ bucket: "b", cursor: "t2" });
		expect(pageSettings[0]).toEqual({
			continuationToken: "t2",
			maxPageSize: 100,
		});
		// An empty page WITH a token is normal on Azure: keep paging.
		expect(result.objects).toEqual([]);
		expect(result.nextCursor).toBe("t3");
	});

	it("handles an empty container (no page yielded at all)", async () => {
		listBlobsByHierarchy.mockReturnValueOnce(pager([]));
		const browser = createAzureBrowser(options);
		const result = await browser.listObjects({ bucket: "empty" });
		expect(result).toEqual({
			prefixes: [],
			objects: [],
			nextCursor: undefined,
		});
	});

	it("surfaces listing failures to the caller (error mapping happens upstream)", async () => {
		listBlobsByHierarchy.mockImplementationOnce(() => {
			throw Object.assign(new Error("nope"), {
				name: "AuthenticationFailed",
				statusCode: 403,
			});
		});
		const browser = createAzureBrowser(options);
		await expect(browser.listObjects({ bucket: "b" })).rejects.toMatchObject({
			name: "AuthenticationFailed",
		});
	});

	it("getObject streams the whole blob when no range is asked for", async () => {
		const body = { pipe: () => body };
		download.mockResolvedValueOnce({ readableStreamBody: body });
		const browser = createAzureBrowser(options);
		const stream = await browser.getObject?.({ bucket: "b", key: "loop.mp4" });
		expect(stream).toBe(body);
		expect(getBlobClient).toHaveBeenCalledWith("loop.mp4");
		// offset 0 + no count ⇒ the SDK sends no Range header at all.
		expect(download).toHaveBeenCalledWith(0, undefined);
	});

	it("getObject rejects a missing body loudly (non-Node runtime guard)", async () => {
		download.mockResolvedValueOnce({ readableStreamBody: undefined });
		const browser = createAzureBrowser(options);
		await expect(
			browser.getObject?.({ bucket: "b", key: "k" }),
		).rejects.toThrow(/no readable body/);
	});

	describe("ranged reads", () => {
		it("converts an inclusive end into Azure's count (end - start + 1)", async () => {
			const body = streamBody();
			download.mockImplementation(modelledDownload(body, 104857600));
			const browser = createAzureBrowser(options);
			const stream = await browser.getObject?.({
				bucket: "b",
				key: "k",
				range: { start: 0, end: 8388607 },
			});
			expect(stream).toBe(body);
			expect(download).toHaveBeenCalledWith(0, 8388608);
			expect(rangeHeaders).toEqual(["bytes=0-8388607"]);
		});

		it("converts a single-byte range to count 1, not 0", async () => {
			const body = streamBody();
			download.mockImplementation(modelledDownload(body, 100));
			const browser = createAzureBrowser(options);
			await browser.getObject?.({
				bucket: "b",
				key: "k",
				range: { start: 41, end: 41 },
			});
			expect(download).toHaveBeenCalledWith(41, 1);
			expect(rangeHeaders).toEqual(["bytes=41-41"]);
		});

		it("sends an open-ended read (no count) when end is omitted", async () => {
			const body = streamBody();
			download.mockImplementation(modelledDownload(body, 1000));
			const browser = createAzureBrowser(options);
			await browser.getObject?.({
				bucket: "b",
				key: "k",
				range: { start: 100 },
			});
			expect(download).toHaveBeenCalledWith(100, undefined);
			expect(rangeHeaders).toEqual(["bytes=100-"]);
		});

		it("ACCEPTS an open-ended read from byte 0, for which the SDK sends NO Range header", async () => {
			// `end` is optional, so {start: 0} is legal and means "byte 0 to the
			// end". Clients.js:285 transmits that as a plain unranged GET, so a
			// FULLY COMPLIANT Azure answers 200 with no Content-Range — there is
			// nothing for the guard to verify, and rejecting it would fail a
			// well-typed caller against a correct server.
			const body = streamBody();
			download.mockImplementation(modelledDownload(body, 1000));
			const browser = createAzureBrowser(options);
			await expect(
				browser.getObject?.({ bucket: "b", key: "k", range: { start: 0 } }),
			).resolves.toBe(body);
			expect(download).toHaveBeenCalledWith(0, undefined);
			expect(rangeHeaders).toEqual([undefined]);
			expect(body.destroy).not.toHaveBeenCalled();
		});

		it("REFUSES a backwards range instead of letting it become an open read", async () => {
			// count would be ≤ 0, which rangeToString turns into `bytes=start-`:
			// the whole rest of the blob.
			const browser = createAzureBrowser(options);
			await expect(
				browser.getObject?.({
					bucket: "b",
					key: "big.mp4",
					range: { start: 10, end: 9 },
				}),
			).rejects.toThrow(/invalid byte range/);
			expect(download).not.toHaveBeenCalled();
		});

		it("REFUSES a NaN end, which `count < 1` let through", async () => {
			// `NaN < 1` is false, so the old guard passed it and rangeToString then
			// treated NaN as "no count" — an open-ended read of the rest of the
			// blob, exactly what the guard exists to prevent. At start 0 it also
			// desynchronised driver and SDK (no header sent, proof demanded).
			// Degenerate input, but the guard's own comment claimed it was covered.
			const browser = createAzureBrowser(options);
			for (const start of [0, 100]) {
				await expect(
					browser.getObject?.({
						bucket: "b",
						key: "big.mp4",
						range: { start, end: Number.NaN },
					}),
				).rejects.toThrow(/invalid byte range/);
			}
			expect(download).not.toHaveBeenCalled();
		});

		it("REJECTS a response with no Content-Range — the range was ignored", async () => {
			// The SDK sizes its stream from the SERVER's contentLength, so an
			// ignored Range streams the whole blob and ends cleanly. Only
			// Content-Range proves the slice was honored.
			const body = streamBody();
			download.mockImplementation(
				modelledDownload(body, 104857600, { rogue: true }),
			);
			const browser = createAzureBrowser(options);
			await expect(
				browser.getObject?.({
					bucket: "b",
					key: "big.mp4",
					range: { start: 0, end: 1023 },
				}),
			).rejects.toThrow(/ignored the byte-range request/);
			// The request DID carry a range, so the missing proof is the endpoint's
			// fault — the body must not be handed to the caller.
			expect(rangeHeaders).toEqual(["bytes=0-1023"]);
			expect(body.destroy).toHaveBeenCalledTimes(1);
		});

		it("REJECTS an ignored open-ended range from a non-zero offset", async () => {
			// `bytes=100-` goes on the wire, so a reply without Content-Range is
			// still the whole blob rather than the tail that was asked for.
			const body = streamBody();
			download.mockImplementation(
				modelledDownload(body, 1000, { rogue: true }),
			);
			const browser = createAzureBrowser(options);
			await expect(
				browser.getObject?.({ bucket: "b", key: "k", range: { start: 100 } }),
			).rejects.toThrow(/ignored the byte-range request/);
			expect(rangeHeaders).toEqual(["bytes=100-"]);
			expect(body.destroy).toHaveBeenCalledTimes(1);
		});

		it("does NOT require Content-Range when no range was asked for", async () => {
			const body = streamBody();
			download.mockImplementation(modelledDownload(body, 1000));
			const browser = createAzureBrowser(options);
			await expect(
				browser.getObject?.({ bucket: "b", key: "k" }),
			).resolves.toBe(body);
			expect(rangeHeaders).toEqual([undefined]);
		});
	});
});

describe("createAzureBrowser exact-version reads", () => {
	const stream = () => ({ readableStreamBody: { pipe() {} } });

	it("headObject reports etag, versionId, size and lastModified", async () => {
		getProperties.mockResolvedValue({
			etag: '"0x8DA"',
			versionId: "2026-08-28T00:00:00.0000000Z",
			contentLength: 4096,
			lastModified: new Date("2026-08-28T00:00:00.000Z"),
		});
		const browser = createAzureBrowser({
			accountName: "acct",
			accountKey: "a2V5",
		});
		expect(await browser.headObject?.({ bucket: "c", key: "k" })).toEqual({
			// Quotes kept — the same string goes back in ifMatch.
			etag: '"0x8DA"',
			versionId: "2026-08-28T00:00:00.0000000Z",
			size: 4096,
			lastModified: "2026-08-28T00:00:00.000Z",
		});
	});

	it("a versionless account yields no versionId (that is normal, not missing data)", async () => {
		getProperties.mockResolvedValue({ etag: '"e"', contentLength: 1 });
		const browser = createAzureBrowser({
			accountName: "acct",
			accountKey: "a2V5",
		});
		const id = await browser.headObject?.({ bucket: "c", key: "k" });
		expect(id).toEqual({ etag: '"e"', size: 1 });
	});

	it("downloads FROM the version-selected client, not merely alongside it", async () => {
		// The join, not the two facts: `withVersion` was called AND the bytes
		// came from the client it returned. A driver that selected the version
		// and then read the unversioned client would read CURRENT bytes while
		// believing it had pinned one — and would pass any assertion that only
		// checked the two events separately.
		versionedDownload.mockResolvedValue(stream());
		const browser = createAzureBrowser({
			accountName: "acct",
			accountKey: "a2V5",
		});
		await browser.getObject?.({
			bucket: "c",
			key: "k",
			expect: { etag: '"0x8DA"', versionId: "v-1" },
		});
		expect(withVersionCalls).toEqual(["v-1"]);
		expect(versionedDownload).toHaveBeenCalledWith(0, undefined, {
			conditions: { ifMatch: '"0x8DA"' },
		});
		// And the unversioned client was never read.
		expect(download).not.toHaveBeenCalled();
	});

	it("a versionId-ONLY expectation selects the version and sends no conditions", async () => {
		// Review gap: every version arm carried an etag too, so "versionId
		// alone" — the shape an unversioned-etag-less capture produces — was
		// covered only in combination. Both halves matter here: the version is
		// selected, and `download` gets exactly TWO arguments because there is
		// no condition to send.
		versionedDownload.mockResolvedValue(stream());
		const browser = createAzureBrowser({
			accountName: "acct",
			accountKey: "a2V5",
		});
		await browser.getObject?.({
			bucket: "c",
			key: "k",
			expect: { versionId: "v-2" },
		});
		expect(withVersionCalls).toEqual(["v-2"]);
		expect(versionedDownload).toHaveBeenCalledWith(0, undefined);
		expect(download).not.toHaveBeenCalled();
	});

	it("no expectation means no conditions object at all", async () => {
		// `download(start, count, undefined)` and `download(start, count, {})`
		// are not the same request to reason about; the unconditional path must
		// stay visibly unconditional.
		download.mockResolvedValue(stream());
		const browser = createAzureBrowser({
			accountName: "acct",
			accountKey: "a2V5",
		});
		await browser.getObject?.({ bucket: "c", key: "k" });
		expect(withVersionCalls).toEqual([]);
		// TWO arguments — the pre-feature call, unchanged. Asserted rather than
		// assumed: five existing range tests pin this argument list, and a
		// feature that quietly appended `undefined` to every unconditional read
		// would have rewritten all five to accommodate itself.
		expect(download).toHaveBeenCalledWith(0, undefined);
	});

	it("a 412 becomes ObjectVersionMismatchError", async () => {
		download.mockRejectedValue(
			Object.assign(
				new Error(
					"The condition specified using HTTP conditional header(s) is not met.",
				),
				{
					statusCode: 412,
					code: "ConditionNotMet",
				},
			),
		);
		const browser = createAzureBrowser({
			accountName: "acct",
			accountKey: "a2V5",
		});
		const err = await browser
			.getObject?.({ bucket: "c", key: "k", expect: { etag: '"old"' } })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ObjectVersionMismatchError);
		expect((err as Error).message).toContain("replaced");
	});

	it("BlobNotFound on a version-pinned read is a mismatch, not a raw 404", async () => {
		/*
		 * Review of this PR: the Azure twin of S3's `NoSuchVersion`, and the
		 * classifier had no path for it. Addressing a blob by `?versionid=` for
		 * a version that has been deleted or purged answers 404 BlobNotFound —
		 * not 412 — because there is no resource left to evaluate an If-Match
		 * against. Same condition from the caller's side: the recorded bytes
		 * are not retrievable, and the recovery is to re-record, not retry.
		 */
		versionedDownload.mockRejectedValue(
			Object.assign(new Error("The specified blob does not exist."), {
				statusCode: 404,
				code: "BlobNotFound",
			}),
		);
		const browser = createAzureBrowser({
			accountName: "acct",
			accountKey: "a2V5",
		});
		const err = await browser
			.getObject?.({
				bucket: "c",
				key: "k",
				expect: { etag: '"e"', versionId: "v-gone" },
			})
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ObjectVersionMismatchError);
		expect((err as Error).message).toContain("replaced");
	});

	it("BlobNotFound WITHOUT a version selector stays a missing object", async () => {
		// Nothing was version-pinned, so nothing can have been replaced — the
		// blob is simply gone. The same narrowness the S3 classifier had to be
		// corrected to: a generic absence must not become "your bytes changed".
		const original = Object.assign(
			new Error("The specified blob does not exist."),
			{
				statusCode: 404,
				code: "BlobNotFound",
			},
		);
		download.mockRejectedValue(original);
		const browser = createAzureBrowser({
			accountName: "acct",
			accountKey: "a2V5",
		});
		const err = await browser
			.getObject?.({ bucket: "c", key: "k", expect: { etag: '"e"' } })
			.catch((e: unknown) => e);
		expect(err).toBe(original);
		expect(err).not.toBeInstanceOf(ObjectVersionMismatchError);
	});

	it("ContainerNotFound is never a mismatch, even version-pinned", async () => {
		// A different code for a different failure class — a container/config
		// problem, not object identity. Sweeping every 404 in would have taken
		// this with it.
		const original = Object.assign(
			new Error("The specified container does not exist."),
			{
				statusCode: 404,
				code: "ContainerNotFound",
			},
		);
		versionedDownload.mockRejectedValue(original);
		const browser = createAzureBrowser({
			accountName: "acct",
			accountKey: "a2V5",
		});
		const err = await browser
			.getObject?.({ bucket: "c", key: "k", expect: { versionId: "v-1" } })
			.catch((e: unknown) => e);
		expect(err).toBe(original);
	});

	it("an unrelated failure under an expectation stays itself", async () => {
		const original = Object.assign(new Error("AuthenticationFailed"), {
			statusCode: 403,
			code: "AuthenticationFailed",
		});
		download.mockRejectedValue(original);
		const browser = createAzureBrowser({
			accountName: "acct",
			accountKey: "a2V5",
		});
		const err = await browser
			.getObject?.({ bucket: "c", key: "k", expect: { etag: '"e"' } })
			.catch((e: unknown) => e);
		expect(err).toBe(original);
	});

	it("a 412 with NO expectation is not relabelled", async () => {
		const original = Object.assign(new Error("precondition"), {
			statusCode: 412,
			code: "ConditionNotMet",
		});
		download.mockRejectedValue(original);
		const browser = createAzureBrowser({
			accountName: "acct",
			accountKey: "a2V5",
		});
		const err = await browser
			.getObject?.({ bucket: "c", key: "k" })
			.catch((e: unknown) => e);
		expect(err).toBe(original);
	});
});
