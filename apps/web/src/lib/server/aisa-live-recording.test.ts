import { AesGcmCipher } from "@bitovp/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	enabled: vi.fn(),
	context: vi.fn(),
	accountClient: vi.fn(),
	get: vi.fn(),
	fetch: vi.fn(),
	accountGet: vi.fn(),
	reveal: vi.fn(),
}));
vi.mock("./context", () => ({ getServerContext: mocks.context }));
vi.mock("./aisa-live-sdk", () => ({
	aisaLivePreviewEnabled: mocks.enabled,
	aisaLiveClientForAccount: mocks.accountClient,
}));

import {
	serveAisaRecording,
	serveAisaRecordingMedia,
	validateAisaRecordingUrl,
} from "./aisa-live-recording";

const org = "00000000-0000-4000-8000-000000000001";
const otherOrg = "00000000-0000-4000-8000-000000000002";
const accountId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const analysisId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const encodingId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const path = `/api/live/analyses/${analysisId}/recording`;
const asset = `https://storage.googleapis.com/aisa-live-recordings-prod/live/${analysisId}/segment_000000.m4s?X-Goog-Signature=synthetic-secret`;
const playlist = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="${asset.replace("segment_000000.m4s", "init.mp4")}"\n#EXTINF:5,\n#EXT-X-PROGRAM-DATE-TIME:2026-11-07T00:00:00Z\n${asset}\n#EXT-X-ENDLIST\n`;
const request = (suffix = "", query = "", init?: RequestInit) =>
	new Request(
		`http://test${path}${suffix}?bitmovinAccountId=${accountId}&encodingId=${encodingId}&expectedOrganizationId=${org}${query}`,
		init,
	);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.enabled.mockReturnValue(true);
	mocks.accountClient.mockResolvedValue({ get: mocks.get });
	mocks.get.mockResolvedValue({ analysisId, encodingId, status: "FINISHED" });
	mocks.accountGet.mockResolvedValue({
		id: accountId,
		tenantOrgId: "provider-tenant",
	});
	mocks.reveal.mockResolvedValue("test-only-api-key");
	mocks.context.mockResolvedValue({
		tenant: { organizationId: org },
		bitmovinAccounts: { get: mocks.accountGet, revealApiKey: mocks.reveal },
		cipher: new AesGcmCipher(Buffer.alloc(32, 9)),
	});
	mocks.fetch.mockImplementation(async (url: string) =>
		String(url).startsWith("https://api.bitmovin.com/")
			? new Response(playlist)
			: new Response(new Uint8Array([1, 2, 3]), {
					headers: { "Content-Length": "3" },
				}),
	);
	vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("AISA recording proxy", () => {
	it("rewrites signed media URLs into encrypted organization-bound local handles", async () => {
		const response = await serveAisaRecording(request(), analysisId);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain("#EXT-X-PROGRAM-DATE-TIME:");
		expect(text).toContain(`${path}/media?`);
		expect(text).toContain(`expectedOrganizationId=${org}`);
		expect(text).not.toContain("synthetic-secret");
		expect(text).not.toContain("storage.googleapis.com");
		expect(response.headers.get("Cache-Control")).toContain("no-store");
		const call = mocks.fetch.mock.calls[0];
		expect(call?.[0]).toBe(
			`https://api.bitmovin.com/v1/ai-scene-analysis/live-analyses/${analysisId}/recording/index.m3u8`,
		);
		expect(new Headers(call?.[1].headers).get("X-Api-Key")).toBe(
			"test-only-api-key",
		);
	});
	it("fetches only issued assets and never forwards the Bitmovin key to storage", async () => {
		const first = await serveAisaRecording(request(), analysisId);
		const text = await first.text();
		const line = text
			.split("\n")
			.find((value) => value.startsWith(`${path}/media?`));
		expect(line).toBeTruthy();
		const response = await serveAisaRecordingMedia(
			new Request(`http://test${line}`, { headers: { Range: "bytes=0-2" } }),
			analysisId,
		);
		expect(response.status).toBe(200);
		expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
			1, 2, 3,
		]);
		const call = mocks.fetch.mock.calls.at(-1);
		expect(call?.[0]).toBe(asset);
		expect(new Headers(call?.[1].headers).get("X-Api-Key")).toBeNull();
		expect(new Headers(call?.[1].headers).get("Range")).toBe("bytes=0-2");
		expect(call?.[1].redirect).toBe("error");
	});
	it("fails closed on arbitrary hosts, different analyses, and ambiguous URL paths", () => {
		for (const url of [
			asset.replace(
				"storage.googleapis.com",
				"storage.googleapis.com.attacker.invalid",
			),
			asset.replace(analysisId, accountId),
			asset.replace("https:", "http:"),
			asset.replace("segment_000000.m4s", "../outside.m4s"),
			asset.replace("segment_000000.m4s", "%252e%252e/outside.m4s"),
		])
			expect(() => validateAisaRecordingUrl(url, analysisId)).toThrow();
	});
	it("denies token tamper, cross-organization binding and user-provided URLs before storage fetch", async () => {
		const before = mocks.fetch.mock.calls.length;
		expect(
			(
				await serveAisaRecordingMedia(
					request("/media", "&token=bad"),
					analysisId,
				)
			).status,
		).toBe(403);
		expect(
			(
				await serveAisaRecording(
					request("", `&url=${encodeURIComponent(asset)}`),
					analysisId,
				)
			).status,
		).toBe(400);
		mocks.context.mockResolvedValueOnce({
			tenant: { organizationId: otherOrg },
		});
		expect((await serveAisaRecording(request(), analysisId)).status).toBe(409);
		expect(mocks.fetch).toHaveBeenCalledTimes(before);
	});
	it("checks the Preview gate and analysis identity before recording credentials are used", async () => {
		mocks.enabled.mockReturnValueOnce(false);
		expect((await serveAisaRecording(request(), analysisId)).status).toBe(404);
		expect(mocks.context).not.toHaveBeenCalled();
		mocks.get.mockResolvedValueOnce({
			analysisId: accountId,
			encodingId,
			status: "FINISHED",
		});
		expect((await serveAisaRecording(request(), analysisId)).status).toBe(502);
		expect(mocks.reveal).not.toHaveBeenCalled();
	});

	it("rejects expired and cross-account tokens without fetching storage", async () => {
		const first = await serveAisaRecording(request(), analysisId);
		const line = (await first.text())
			.split("\n")
			.find((value) => value.startsWith(`${path}/media?`));
		if (!line) throw new Error("Missing local media URI");
		const before = mocks.fetch.mock.calls.length;
		const differentAccount = line.replace(
			`bitmovinAccountId=${accountId}`,
			`bitmovinAccountId=${encodingId}`,
		);
		expect(
			(
				await serveAisaRecordingMedia(
					new Request(`http://test${differentAccount}`),
					analysisId,
				)
			).status,
		).toBe(403);
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);
		expect(
			(
				await serveAisaRecordingMedia(
					new Request(`http://test${line}`),
					analysisId,
				)
			).status,
		).toBe(410);
		expect(mocks.fetch).toHaveBeenCalledTimes(before);
	});

	it("supports HEAD and valid byte ranges while rejecting invalid ranges", async () => {
		const first = await serveAisaRecording(request(), analysisId);
		const line = (await first.text())
			.split("\n")
			.find((value) => value.startsWith(`${path}/media?`));
		if (!line) throw new Error("Missing local media URI");
		const head = await serveAisaRecordingMedia(
			new Request(`http://test${line}`, { method: "HEAD" }),
			analysisId,
		);
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
		expect(mocks.fetch.mock.calls.at(-1)?.[1].method).toBe("HEAD");
		mocks.fetch.mockResolvedValueOnce(
			new Response(new Uint8Array([1, 2, 3]), {
				status: 206,
				headers: { "Content-Range": "bytes 0-2/8" },
			}),
		);
		const partial = await serveAisaRecordingMedia(
			new Request(`http://test${line}`, { headers: { Range: "bytes=0-2" } }),
			analysisId,
		);
		expect(partial.status).toBe(206);
		expect(partial.headers.get("Content-Range")).toBe("bytes 0-2/8");
		const before = mocks.fetch.mock.calls.length;
		expect(
			(
				await serveAisaRecordingMedia(
					new Request(`http://test${line}`, {
						headers: { Range: "bytes=20-2" },
					}),
					analysisId,
				)
			).status,
		).toBe(416);
		expect(mocks.fetch).toHaveBeenCalledTimes(before);
	});

	it("does not expose or follow redirects or foreign playlist references", async () => {
		mocks.fetch.mockResolvedValueOnce(
			new Response(
				playlist.replace("storage.googleapis.com", "attacker.invalid"),
			),
		);
		expect((await serveAisaRecording(request(), analysisId)).status).toBe(502);
		mocks.fetch.mockResolvedValueOnce(
			new Response(null, {
				status: 302,
				headers: { Location: "https://attacker.invalid/private" },
			}),
		);
		const response = await serveAisaRecording(request(), analysisId);
		expect(response.status).toBe(502);
		expect(await response.text()).not.toContain("attacker.invalid");
		expect(mocks.fetch.mock.calls.at(-1)?.[1].redirect).toBe("error");
	});
});
