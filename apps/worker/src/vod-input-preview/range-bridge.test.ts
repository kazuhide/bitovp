import { Readable } from "node:stream";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { ObjectVersionMismatchError } from "@bitovp/storage";
import { describe, expect, it, vi } from "vitest";
import { createVodRangeBridge } from "./range-bridge";

const source = {
	key: "source-a",
	credentialId: "00000000-0000-4000-8000-000000000001",
	bucket: "media",
	objectKey: "private/source.mp4",
};
const identity = { size: 10, etag: '"pinned"' };
const fixture = (get: ObjectStorageBrowser["getObject"]) => ({
	listBuckets: async () => [],
	listObjects: async () => ({ objects: [], prefixes: [] }),
	getObject: get,
});

describe("private pinned storage Range bridge", () => {
	it("requires its random path token and serves only capped conditional ranges", async () => {
		const get = vi.fn(async ({ range }) =>
			Readable.from([
				Buffer.from("0123456789").subarray(range.start, range.end + 1),
			]),
		);
		const bridge = await createVodRangeBridge({
			sources: [{ source, identity }],
			browserFor: async () => fixture(get),
			maxRequestBytes: 4,
		});
		try {
			const url = bridge.urlFor(source.key);
			expect(new URL(url).hostname).toBe("127.0.0.1");
			expect((await fetch(new URL("/wrong/0", url))).status).toBe(404);
			expect((await fetch(url, { method: "POST" })).status).toBe(405);
			expect((await fetch(url)).status).toBe(416);
			const head = await fetch(url, { method: "HEAD" });
			expect(head.headers.get("content-length")).toBe("10");
			const response = await fetch(url, { headers: { Range: "bytes=3-" } });
			expect(response.status).toBe(206);
			expect(response.headers.get("content-range")).toBe("bytes 3-6/10");
			expect(await response.text()).toBe("3456");
			expect(get).toHaveBeenCalledWith({
				bucket: "media",
				key: "private/source.mp4",
				range: { start: 3, end: 6 },
				expect: identity,
			});
			expect(bridge.bytesRead).toBe(4);
		} finally {
			await bridge.close();
		}
	});
	it("refuses identity-less sources before creating a listener", async () => {
		await expect(
			createVodRangeBridge({
				sources: [{ source, identity: { size: 10 } }],
				browserFor: async () => fixture(vi.fn()),
			}),
		).rejects.toMatchObject({ code: "SOURCE_UNVERIFIED" });
	});
	it("keeps source changes distinct and never falls back to an unconditional read", async () => {
		const get = vi.fn(async () => {
			throw new ObjectVersionMismatchError(
				"media",
				"private/source.mp4",
				identity,
			);
		});
		const bridge = await createVodRangeBridge({
			sources: [{ source, identity }],
			browserFor: async () => fixture(get),
		});
		try {
			expect(
				(
					await fetch(bridge.urlFor(source.key), {
						headers: { Range: "bytes=0-2" },
					})
				).status,
			).toBe(409);
			expect(() => bridge.throwIfFailed()).toThrow(
				expect.objectContaining({ code: "SOURCE_CHANGED" }),
			);
			expect(get).toHaveBeenCalledOnce();
		} finally {
			await bridge.close();
		}
	});
	it("bounds aggregate reads and destroys a stream that ignores its range", async () => {
		const stream = Readable.from([Buffer.from("0123456789")]);
		const bridge = await createVodRangeBridge({
			sources: [{ source, identity }],
			browserFor: async () => fixture(async () => stream),
			maxRequestBytes: 4,
			maxBytes: 4,
		});
		try {
			await fetch(bridge.urlFor(source.key), {
				headers: { Range: "bytes=0-3" },
			})
				.then((r) => r.arrayBuffer())
				.catch(() => undefined);
			expect(() => bridge.throwIfFailed()).toThrow(
				expect.objectContaining({ code: "SOURCE_RANGE_INVALID" }),
			);
			expect(stream.destroyed).toBe(true);
		} finally {
			await bridge.close();
		}
	});
	it("can close while a storage promise never resolves", async () => {
		const bridge = await createVodRangeBridge({
			sources: [{ source, identity }],
			browserFor: async () => fixture(() => new Promise(() => {})),
		});
		const request = fetch(bridge.urlFor(source.key), {
			headers: { Range: "bytes=0-3" },
		}).catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await bridge.close();
		await request;
	});
});
