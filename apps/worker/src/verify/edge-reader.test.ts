import { describe, expect, it, vi } from "vitest";
import { edgeReaderFor } from "./edge-reader";

/**
 * rev411 M-A: the real HTTP reader is the last hop of the WP-C6b freshness
 * verdict. These arms exercise it with a stubbed fetch, so the header
 * forwarding is judged by behaviour — a reader that reads the header and
 * drops it goes red here, where no source-text pin on `runLive` could see it.
 */
const SEGMENT = new Uint8Array([0x47, 0x40, 0x11, 0x10, 0xff, 0xfe]);
const LAST_MODIFIED = "Wed, 02 Sep 2026 14:03:55 GMT";

function stub(headers: Record<string, string>, status = 200) {
	const fetchImpl = vi.fn(
		async (_url: string, _init: { redirect: "manual" }) =>
			new Response(SEGMENT, { status, headers }),
	);
	return { fetchImpl, read: edgeReaderFor(fetchImpl) };
}

describe("edgeReaderFor — the delivery-edge GET as a player would issue it", () => {
	it("forwards the object's Last-Modified verbatim and the RAW bytes, without following redirects", async () => {
		const { fetchImpl, read } = stub({ "last-modified": LAST_MODIFIED });
		const got = await read("https://edge.example/hls/live/1/seg-1.ts");
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://edge.example/hls/live/1/seg-1.ts",
			{ redirect: "manual" },
		);
		expect(got.status).toBe(200);
		expect(got.lastModified).toBe(LAST_MODIFIED);
		// Byte-for-byte (EV-02): the hash of `body` is the hash of the segment.
		expect(Array.from(got.body)).toEqual(Array.from(SEGMENT));
		expect(got.bytes).toBe(SEGMENT.byteLength);
		expect(got.text).toBe(Buffer.from(SEGMENT).toString("utf8"));
		expect(got.redirected).toBe(false);
	});

	it("leaves lastModified ABSENT (not null, not '') when the edge sends no header — the freshness rule then says UNVERIFIED", async () => {
		const { read } = stub({});
		const got = await read("https://edge.example/hls/live/1/seg-2.ts");
		expect("lastModified" in got).toBe(false);
		expect(got.status).toBe(200);
	});

	it("reports a non-200 with its status and whatever bytes came back, header included", async () => {
		const { read } = stub({ "last-modified": LAST_MODIFIED }, 404);
		const got = await read("https://edge.example/hls/live/1/seg-3.ts");
		expect(got.status).toBe(404);
		expect(got.lastModified).toBe(LAST_MODIFIED);
		expect(got.bytes).toBe(SEGMENT.byteLength);
	});
});
