import { beforeEach, describe, expect, it, vi } from "vitest";

const playbackCorsForManifest = vi.fn();
vi.mock("@/lib/server/playback-cors", async () => {
	const actual = await vi.importActual<
		typeof import("@/lib/server/playback-cors")
	>("@/lib/server/playback-cors");
	return {
		// `pageOrigin` stays real: it decides what the verdict is compared
		// against, and it is unit-tested alongside the helper.
		pageOrigin: actual.pageOrigin,
		playbackCorsForManifest: (...args: unknown[]) =>
			playbackCorsForManifest(...args),
	};
});
vi.mock("@/lib/server/context", () => ({ getServerContext: () => ({}) }));

import { GET } from "./route";

const JOB = "00000000-0000-4000-8000-0000000000aa";

function req(query = "?manifestKey=hls", headers: Record<string, string> = {}) {
	return new Request(
		`http://test/api/encoding-jobs/${JOB}/playback-cors${query}`,
		{ headers },
	);
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
	vi.clearAllMocks();
	playbackCorsForManifest.mockResolvedValue({
		supported: true,
		origin: "http://test",
		bucket: "b",
		verdict: { code: "OK" },
	});
});

describe("GET /api/encoding-jobs/[id]/playback-cors", () => {
	it("400s a non-uuid id before touching storage", async () => {
		const res = await GET(req(), ctx("nope"));
		expect(res.status).toBe(400);
		expect(playbackCorsForManifest).not.toHaveBeenCalled();
	});

	it("400s a request with no manifestKey", async () => {
		const res = await GET(req(""), ctx(JOB));
		expect(res.status).toBe(400);
		expect(playbackCorsForManifest).not.toHaveBeenCalled();
	});

	it("passes the job, manifest key and the BROWSER's origin through", async () => {
		const res = await GET(
			req("?manifestKey=my%20manifest", {
				referer: "https://ovp.example.com/vod/jobs/1",
			}),
			ctx(JOB),
		);
		expect(res.status).toBe(200);
		expect(playbackCorsForManifest).toHaveBeenCalledWith(
			{},
			{
				scope: "vod",
				id: JOB,
				// Decoded once — a key with a space must not arrive percent-encoded.
				manifestKey: "my manifest",
				origin: "https://ovp.example.com",
			},
		);
		expect(await res.json()).toMatchObject({ verdict: { code: "OK" } });
	});

	it("502s an upstream storage failure but 500s one of ours", async () => {
		playbackCorsForManifest.mockRejectedValueOnce(
			Object.assign(new Error("boom"), { $metadata: { httpStatusCode: 500 } }),
		);
		expect((await GET(req(), ctx(JOB))).status).toBe(502);

		playbackCorsForManifest.mockRejectedValueOnce(
			new TypeError("x is not a function"),
		);
		const ours = await GET(req(), ctx(JOB));
		expect(ours.status).toBe(500);
		// Our own message must not reach the client.
		expect(JSON.stringify(await ours.json())).not.toContain("not a function");
	});
});
