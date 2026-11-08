import { randomUUID } from "node:crypto";
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

describe("finalized AISA recording playlist reuse", () => {
	const now = Date.parse("2026-11-08T00:00:00Z");
	const signedAsset = (id: string, expires = 7200) =>
		`https://storage.googleapis.com/aisa-live-recordings-prod/live/${id}/segment_000000.m4s?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Date=20261108T000000Z&X-Goog-Expires=${expires}&X-Goog-Signature=synthetic-secret`;
	const finalPlaylist = (id: string, expires = 7200) =>
		`#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:5\n#EXT-X-MAP:URI="${signedAsset(id, expires).replace("segment_000000.m4s", "init.mp4")}"\n#EXTINF:5,\n#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n${signedAsset(id, expires)}\n#EXT-X-ENDLIST\n`;
	const scopedRequest = (
		id: string,
		options: {
			organization?: string;
			account?: string;
			encoding?: string;
			method?: string;
		} = {},
	) =>
		new Request(
			`http://test/api/live/analyses/${id}/recording?bitmovinAccountId=${options.account ?? accountId}&encodingId=${options.encoding ?? encodingId}&expectedOrganizationId=${options.organization ?? org}`,
			{ method: options.method ?? "GET" },
		);
	function fixture(source?: (id: string) => string) {
		const id = randomUUID();
		mocks.get.mockResolvedValue({
			analysisId: id,
			encodingId,
			status: "FINISHED",
		});
		mocks.fetch.mockImplementation(
			async () => new Response(source?.(id) ?? finalPlaylist(id)),
		);
		return id;
	}
	beforeEach(() => {
		mocks.fetch.mockReset();
		vi.spyOn(Date, "now").mockReturnValue(now);
	});

	it("reuses a final media playlist after fresh identity and account checks on every GET and HEAD", async () => {
		const id = fixture();
		const first = await serveAisaRecording(scopedRequest(id), id);
		const text = await first.text();
		const head = await serveAisaRecording(
			scopedRequest(id, { method: "HEAD" }),
			id,
		);
		vi.mocked(Date.now).mockReturnValue(now + 20_000);
		const next = await serveAisaRecording(scopedRequest(id), id);
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		expect(await next.text()).toBe(text);
		expect(await head.text()).toBe("");
		expect(head.headers.get("Content-Length")).toBe(
			String(Buffer.byteLength(text)),
		);
		expect(next.headers.get("Cache-Control")).toBe("private, no-store");
		expect(mocks.context).toHaveBeenCalledTimes(3);
		expect(mocks.accountClient).toHaveBeenCalledTimes(3);
		expect(mocks.get).toHaveBeenCalledTimes(3);
		expect(mocks.accountGet).toHaveBeenCalledTimes(3);
	});
	it.each([
		"init",
		"media",
	])("honors the earliest expiry when only the %s URI expires sooner", async (kind) => {
		const id = fixture((value) =>
			kind === "init"
				? finalPlaylist(value).replace(
						"X-Goog-Expires=7200",
						"X-Goog-Expires=10",
					)
				: finalPlaylist(value).replace(
						signedAsset(value),
						signedAsset(value, 10),
					),
		);
		await serveAisaRecording(scopedRequest(id), id);
		vi.mocked(Date.now).mockReturnValue(now + 4_999);
		await serveAisaRecording(scopedRequest(id), id);
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		vi.mocked(Date.now).mockReturnValue(now + 5_000);
		await serveAisaRecording(scopedRequest(id), id);
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});

	it("refreshes after 30 seconds and never reuses a playlist beyond its signature safety window", async () => {
		const id = fixture();
		await serveAisaRecording(scopedRequest(id), id);
		vi.mocked(Date.now).mockReturnValue(now + 29_999);
		await serveAisaRecording(scopedRequest(id), id);
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		vi.mocked(Date.now).mockReturnValue(now + 30_000);
		await serveAisaRecording(scopedRequest(id), id);
		expect(mocks.fetch).toHaveBeenCalledTimes(2);

		vi.mocked(Date.now).mockReturnValue(now);
		const short = fixture((value) => finalPlaylist(value, 10));
		await serveAisaRecording(scopedRequest(short), short);
		vi.mocked(Date.now).mockReturnValue(now + 4_999);
		await serveAisaRecording(scopedRequest(short), short);
		expect(mocks.fetch).toHaveBeenCalledTimes(3);
		vi.mocked(Date.now).mockReturnValue(now + 5_000);
		await serveAisaRecording(scopedRequest(short), short);
		expect(mocks.fetch).toHaveBeenCalledTimes(4);
	});

	it.each([
		[
			"unknown",
			(text: string) => text.replaceAll("X-Goog-Date=20261108T000000Z&", ""),
		],
		[
			"invalid date",
			(text: string) => text.replaceAll("20261108T000000Z", "20260230T000000Z"),
		],
		[
			"invalid duration",
			(text: string) =>
				text.replaceAll("X-Goog-Expires=7200", "X-Goog-Expires=invalid"),
		],
		[
			"duplicate date",
			(text: string) =>
				text.replaceAll(
					"X-Goog-Date=",
					"X-Goog-Date=20261108T000000Z&X-Goog-Date=",
				),
		],
		[
			"near expiry",
			(text: string) =>
				text.replaceAll("X-Goog-Expires=7200", "X-Goog-Expires=5"),
		],
	])("does not cache %s signed URL expiry", async (_label, change) => {
		const id = fixture((value) => change(finalPlaylist(value)));
		expect((await serveAisaRecording(scopedRequest(id), id)).status).toBe(200);
		expect((await serveAisaRecording(scopedRequest(id), id)).status).toBe(200);
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});

	it.each([
		["live", (text: string) => text.replace("#EXT-X-ENDLIST\n", "")],
		[
			"master",
			(text: string) =>
				text
					.replace("#EXTINF:5,", "#EXT-X-STREAM-INF:BANDWIDTH=1000")
					.replaceAll("segment_000000.m4s", "child.m3u8"),
		],
		[
			"missing target duration",
			(text: string) => text.replace("#EXT-X-TARGETDURATION:5\n", ""),
		],
		[
			"malformed segment duration",
			(text: string) => text.replace("#EXTINF:5,", "#EXTINF:invalid,"),
		],
		[
			"non-terminal ENDLIST",
			(text: string) =>
				text
					.replace("#EXT-X-ENDLIST\n", "")
					.replace("#EXTINF:5,", "#EXT-X-ENDLIST\n#EXTINF:5,"),
		],
		[
			"ENDLIST-like comment",
			(text: string) =>
				text.replace("#EXT-X-ENDLIST\n", "#EXT-X-ENDLIST-HINT\n"),
		],
		[
			"duplicate VERSION",
			(text: string) =>
				text.replace(
					"#EXT-X-VERSION:7\n",
					"#EXT-X-VERSION:7\n#EXT-X-VERSION:7\n",
				),
		],
		[
			"duplicate MEDIA-SEQUENCE",
			(text: string) =>
				text.replace(
					"#EXT-X-VERSION:7\n",
					"#EXT-X-VERSION:7\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MEDIA-SEQUENCE:0\n",
				),
		],
		[
			"duplicate INDEPENDENT-SEGMENTS",
			(text: string) =>
				text.replace(
					"#EXT-X-VERSION:7\n",
					"#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-INDEPENDENT-SEGMENTS\n",
				),
		],
		[
			"MEDIA-SEQUENCE after segments",
			(text: string) =>
				text.replace(
					"#EXT-X-ENDLIST\n",
					"#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-ENDLIST\n",
				),
		],
	])("leaves %s playlists uncached", async (_label, change) => {
		const id = fixture((value) => change(finalPlaylist(value)));
		expect((await serveAisaRecording(scopedRequest(id), id)).status).toBe(200);
		mocks.fetch.mockResolvedValueOnce(new Response(finalPlaylist(id)));
		const corrected = await serveAisaRecording(scopedRequest(id), id);
		expect(corrected.status).toBe(200);
		expect(await corrected.text()).toContain("#EXTINF:5,");
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});

	it.each([
		"overlapping PDT",
		"backward PDT",
		"duplicate PDT tags",
		"missing PDT",
		"invalid calendar PDT",
	])("serves %s without retaining an untrusted recording timeline", async (kind) => {
		const id = fixture((value) => {
			const text = finalPlaylist(value);
			const pdt = "#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n";
			if (kind === "duplicate PDT tags") return text.replace(pdt, pdt + pdt);
			if (kind === "missing PDT") return text.replace(pdt, "");
			if (kind === "invalid calendar PDT")
				return text.replace("2026-11-08T00:00:00Z", "2026-02-30T00:00:00Z");
			const nextPdt =
				kind === "overlapping PDT"
					? "2026-11-08T00:00:03Z"
					: "2026-11-07T23:59:59Z";
			return text.replace(
				"#EXT-X-ENDLIST",
				`#EXTINF:5,\n#EXT-X-PROGRAM-DATE-TIME:${nextPdt}\n${signedAsset(value).replace("segment_000000", "segment_000001")}\n#EXT-X-ENDLIST`,
			);
		});
		for (let index = 0; index < 2; index++) {
			const response = await serveAisaRecording(scopedRequest(id), id);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("#EXT-X-ENDLIST");
		}
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});

	it("fetches changing live results and discards a final entry when the current provider state is no longer FINISHED", async () => {
		const id = fixture();
		await serveAisaRecording(scopedRequest(id), id);
		mocks.get.mockResolvedValue({
			analysisId: id,
			encodingId,
			status: "RUNNING",
		});
		mocks.fetch.mockImplementation(
			async () =>
				new Response(finalPlaylist(id).replace("#EXTINF:5,", "#EXTINF:4,")),
		);
		for (let index = 0; index < 2; index++) {
			const current = await serveAisaRecording(scopedRequest(id), id);
			expect(await current.text()).toContain("#EXTINF:4,");
		}
		mocks.get.mockResolvedValue({
			analysisId: id,
			encodingId,
			status: "FINISHED",
		});
		await serveAisaRecording(scopedRequest(id), id);
		expect(mocks.fetch).toHaveBeenCalledTimes(4);
	});

	it.each([
		"RUNNING",
		"ERROR",
	])("invalidates a retained playlist when a media request observes %s", async (status) => {
		const id = fixture();
		const initial = await serveAisaRecording(scopedRequest(id), id);
		const mediaPath = (await initial.text())
			.split("\n")
			.find((line) =>
				line.startsWith(`/api/live/analyses/${id}/recording/media?`),
			);
		expect(mediaPath).toBeTruthy();
		mocks.get.mockResolvedValueOnce({ analysisId: id, encodingId, status });
		mocks.fetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
		expect(
			(
				await serveAisaRecordingMedia(
					new Request(`http://test${mediaPath}`),
					id,
				)
			).status,
		).toBe(200);
		mocks.fetch.mockResolvedValueOnce(
			new Response(finalPlaylist(id).replace("#EXTINF:5,", "#EXTINF:4,")),
		);
		const refreshed = await serveAisaRecording(scopedRequest(id), id);
		expect(await refreshed.text()).toContain("#EXTINF:4,");
		await serveAisaRecording(scopedRequest(id), id);
		expect(mocks.fetch).toHaveBeenCalledTimes(3);
	});

	it.each([
		"playlist",
		"media",
	])("does not restore an in-flight FINISHED fill after a %s request observes non-FINISHED", async (kind) => {
		const id = fixture();
		const initial = await serveAisaRecording(scopedRequest(id), id);
		const mediaPath = (await initial.text())
			.split("\n")
			.find((line) =>
				line.startsWith(`/api/live/analyses/${id}/recording/media?`),
			);
		expect(mediaPath).toBeTruthy();
		vi.mocked(Date.now).mockReturnValue(now + 30_000);
		let resolveFetch!: (value: Response) => void;
		let notifyStarted!: () => void;
		const pending = new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		});
		const started = new Promise<void>((resolve) => {
			notifyStarted = resolve;
		});
		mocks.fetch.mockImplementationOnce(() => {
			notifyStarted();
			return pending;
		});
		const inFlight = serveAisaRecording(scopedRequest(id), id);
		await started;
		mocks.get.mockResolvedValueOnce({
			analysisId: id,
			encodingId,
			status: "RUNNING",
		});
		const updated = finalPlaylist(id).replace("#EXTINF:5,", "#EXTINF:4,");
		mocks.fetch.mockImplementation(async (url: string) =>
			String(url).startsWith("https://api.bitmovin.com/")
				? new Response(updated)
				: new Response(new Uint8Array([1, 2, 3])),
		);
		const nonFinished =
			kind === "playlist"
				? await serveAisaRecording(scopedRequest(id), id)
				: await serveAisaRecordingMedia(
						new Request(`http://test${mediaPath}`),
						id,
					);
		expect(nonFinished.status).toBe(200);
		resolveFetch(new Response(finalPlaylist(id)));
		expect(await (await inFlight).text()).toContain("#EXTINF:5,");
		const refreshed = await serveAisaRecording(scopedRequest(id), id);
		expect(await refreshed.text()).toContain("#EXTINF:4,");
		const calls = mocks.fetch.mock.calls.length;
		await serveAisaRecording(scopedRequest(id), id);
		expect(mocks.fetch).toHaveBeenCalledTimes(calls);
	});

	it("does not retain a fill when a non-FINISHED observation occurs during handle encryption", async () => {
		const id = fixture();
		const cipher = new AesGcmCipher(Buffer.alloc(32, 9));
		mocks.context.mockResolvedValue({
			tenant: { organizationId: org },
			bitmovinAccounts: { get: mocks.accountGet, revealApiKey: mocks.reveal },
			cipher,
		});
		const initial = await serveAisaRecording(scopedRequest(id), id);
		const mediaPath = (await initial.text())
			.split("\n")
			.find((line) =>
				line.startsWith(`/api/live/analyses/${id}/recording/media?`),
			);
		expect(mediaPath).toBeTruthy();
		vi.mocked(Date.now).mockReturnValue(now + 30_000);
		let resumeEncryption!: () => void;
		let notifyStarted!: () => void;
		const pending = new Promise<void>((resolve) => {
			resumeEncryption = resolve;
		});
		const started = new Promise<void>((resolve) => {
			notifyStarted = resolve;
		});
		const encrypt = cipher.encrypt.bind(cipher);
		vi.spyOn(cipher, "encrypt").mockImplementationOnce(
			async (value, binding) => {
				notifyStarted();
				await pending;
				return encrypt(value, binding);
			},
		);
		const inFlight = serveAisaRecording(scopedRequest(id), id);
		await started;
		mocks.get.mockResolvedValueOnce({
			analysisId: id,
			encodingId,
			status: "RUNNING",
		});
		mocks.fetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
		expect(
			(
				await serveAisaRecordingMedia(
					new Request(`http://test${mediaPath}`),
					id,
				)
			).status,
		).toBe(200);
		resumeEncryption();
		expect((await inFlight).status).toBe(200);
		mocks.fetch.mockResolvedValueOnce(
			new Response(finalPlaylist(id).replace("#EXTINF:5,", "#EXTINF:4,")),
		);
		const refreshed = await serveAisaRecording(scopedRequest(id), id);
		expect(await refreshed.text()).toContain("#EXTINF:4,");
		await serveAisaRecording(scopedRequest(id), id);
		expect(mocks.fetch).toHaveBeenCalledTimes(4);
	});

	it("keeps organizations, accounts, analyses, and encodings in separate entries", async () => {
		const id = fixture();
		const scopes = [
			{ id, organization: org, account: accountId, encoding: encodingId },
			{ id, organization: otherOrg, account: accountId, encoding: encodingId },
			{ id, organization: org, account: randomUUID(), encoding: encodingId },
			{
				id: randomUUID(),
				organization: org,
				account: accountId,
				encoding: encodingId,
			},
			{ id, organization: org, account: accountId, encoding: randomUUID() },
		];
		for (const scope of scopes) {
			mocks.context.mockResolvedValue({
				tenant: { organizationId: scope.organization },
				bitmovinAccounts: { get: mocks.accountGet, revealApiKey: mocks.reveal },
				cipher: new AesGcmCipher(Buffer.alloc(32, 9)),
			});
			mocks.get.mockResolvedValue({
				analysisId: scope.id,
				encodingId: scope.encoding,
				status: "FINISHED",
			});
			mocks.fetch.mockImplementation(
				async () => new Response(finalPlaylist(scope.id)),
			);
			for (let index = 0; index < 2; index++) {
				expect(
					(await serveAisaRecording(scopedRequest(scope.id, scope), scope.id))
						.status,
				).toBe(200);
			}
		}
		expect(mocks.fetch).toHaveBeenCalledTimes(scopes.length);
	});

	it("does not mask fresh account, identity, and provider failures with a cached playlist", async () => {
		const id = fixture();
		await serveAisaRecording(scopedRequest(id), id);
		mocks.accountGet.mockResolvedValueOnce(null);
		expect((await serveAisaRecording(scopedRequest(id), id)).status).toBe(404);
		mocks.accountClient.mockResolvedValueOnce(null);
		expect((await serveAisaRecording(scopedRequest(id), id)).status).toBe(404);
		mocks.get.mockResolvedValueOnce({
			analysisId: id,
			encodingId: randomUUID(),
			status: "FINISHED",
		});
		expect((await serveAisaRecording(scopedRequest(id), id)).status).toBe(502);
		mocks.get.mockRejectedValueOnce(new Error("upstream unavailable"));
		expect((await serveAisaRecording(scopedRequest(id), id)).status).toBe(502);
		mocks.get.mockResolvedValueOnce({
			analysisId: id,
			encodingId,
			status: "UNKNOWN",
		});
		expect((await serveAisaRecording(scopedRequest(id), id)).status).toBe(502);
		mocks.get.mockResolvedValueOnce({
			analysisId: randomUUID(),
			encodingId,
			status: "FINISHED",
		});
		expect((await serveAisaRecording(scopedRequest(id), id)).status).toBe(502);
		mocks.context.mockRejectedValueOnce(new Error("session refused"));
		expect((await serveAisaRecording(scopedRequest(id), id)).status).toBe(502);
		expect(
			(
				await serveAisaRecording(
					scopedRequest(id, { organization: otherOrg }),
					id,
				)
			).status,
		).toBe(409);
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
	});

	it("does not cache upstream errors or invalid URI references", async () => {
		const id = fixture();
		mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
		expect((await serveAisaRecording(scopedRequest(id), id)).status).toBe(502);
		mocks.fetch.mockResolvedValueOnce(
			new Response(
				finalPlaylist(id).replaceAll(
					"storage.googleapis.com",
					"attacker.invalid",
				),
			),
		);
		expect((await serveAisaRecording(scopedRequest(id), id)).status).toBe(502);
		for (let index = 0; index < 2; index++) {
			expect((await serveAisaRecording(scopedRequest(id), id)).status).toBe(
				200,
			);
		}
		expect(mocks.fetch).toHaveBeenCalledTimes(3);
	});

	it("evicts old entries when more than eight distinct playlists are requested", async () => {
		const first = randomUUID();
		const ids = [first, ...Array.from({ length: 8 }, () => randomUUID())];
		for (const id of [...ids, first]) {
			mocks.get.mockResolvedValue({
				analysisId: id,
				encodingId,
				status: "FINISHED",
			});
			mocks.fetch.mockImplementation(
				async () => new Response(finalPlaylist(id)),
			);
			expect((await serveAisaRecording(scopedRequest(id), id)).status).toBe(
				200,
			);
		}
		expect(mocks.fetch).toHaveBeenCalledTimes(10);
	});

	it("bounds total UTF-8 bytes and accounts for evicted and expired entries", async () => {
		const first = randomUUID(),
			second = randomUUID();
		const ids = [first, second, randomUUID()];
		const padded = (id: string) =>
			finalPlaylist(id).replace(
				"#EXT-X-ENDLIST",
				`#${"é".repeat(1_450_000)}\n#EXT-X-ENDLIST`,
			);
		for (const id of [...ids, first]) {
			mocks.get.mockResolvedValue({
				analysisId: id,
				encodingId,
				status: "FINISHED",
			});
			mocks.fetch.mockImplementation(async () => new Response(padded(id)));
			expect((await serveAisaRecording(scopedRequest(id), id)).status).toBe(
				200,
			);
		}
		expect(mocks.fetch).toHaveBeenCalledTimes(4);
		vi.mocked(Date.now).mockReturnValue(now + 30_000);
		await serveAisaRecording(scopedRequest(first), first);
		mocks.get.mockResolvedValue({
			analysisId: second,
			encodingId,
			status: "FINISHED",
		});
		mocks.fetch.mockImplementation(async () => new Response(padded(second)));
		await serveAisaRecording(scopedRequest(second), second);
		mocks.get.mockResolvedValue({
			analysisId: first,
			encodingId,
			status: "FINISHED",
		});
		await serveAisaRecording(scopedRequest(first), first);
		expect(mocks.fetch).toHaveBeenCalledTimes(6);
	});
});
