import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMomentPlaybackRange } from "./playback";
import {
	parseAisaRecordingMediaPlaylist,
	readAisaRecordingTimeline,
} from "./recording-timeline";

const account = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const analysis = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const encoding = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const organization = "00000000-0000-4000-8000-000000000001";
const source = `/api/live/analyses/${analysis}/recording?bitmovinAccountId=${account}&encodingId=${encoding}&expectedOrganizationId=${organization}`;
const media = (token = "synthetic-token") =>
	`/api/live/analyses/${analysis}/recording/media?bitmovinAccountId=${account}&encodingId=${encoding}&expectedOrganizationId=${organization}&token=${token}`;
const origin = Date.parse("2026-11-08T00:00:00Z");
const playlist = (body: string) => `#EXTM3U\n${body}\n`;
const segment = "#EXTINF:5.000000,\nsegment.m4s\n";
const valid = playlist(
	`#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n${segment}#EXT-X-ENDLIST`,
);
const master = (uri: string) =>
	playlist(`#EXT-X-STREAM-INF:BANDWIDTH=1000000\n${uri}`);
const response = (text: string) =>
	new Response(text, {
		headers: { "content-type": "application/vnd.apple.mpegurl" },
	});
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("recording media timeline parsing", () => {
	it("retains PDT, fractional EXTINF, end state and media-relative starts without retaining URIs", () => {
		const result = parseAisaRecordingMediaPlaylist(
			playlist(
				"#EXT-X-PROGRAM-DATE-TIME:2026-11-08T09:00:00+09:00\n" +
					"#EXTINF:4.500000,\nhttps://upstream.invalid/private?token=do-not-retain\n" +
					"#EXTINF:5.25,\nother.m4s\n#EXT-X-ENDLIST",
			),
		);
		expect(result).toEqual({
			endList: true,
			fragments: [
				{
					start: 0,
					duration: 4.5,
					programDateTime: origin,
					tagList: [["INF", "4.500000"]],
					gap: false,
				},
				{
					start: 4.5,
					duration: 5.25,
					programDateTime: origin + 4500,
					tagList: [["INF", "5.25"]],
					gap: false,
				},
			],
		});
		expect(JSON.stringify(result)).not.toMatch(/upstream|private|token|m4s/);
	});

	it("keeps live windows distinct from ENDLIST and preserves gaps for whole-interval availability", () => {
		const result = parseAisaRecordingMediaPlaylist(
			playlist(
				`#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:10Z\n${segment}#EXT-X-GAP\n${segment}${segment}`,
			),
		);
		expect(result.endList).toBe(false);
		expect(result.fragments.map((item) => item.gap)).toEqual([
			false,
			true,
			false,
		]);
		expect(
			resolveMomentPlaybackRange(
				{ startInSeconds: 12, endInSeconds: 22, anchorInSeconds: 14 },
				origin,
				result.fragments,
			),
		).toBeNull();
		expect(
			resolveMomentPlaybackRange(
				{ startInSeconds: 21, endInSeconds: 24, anchorInSeconds: 22 },
				origin,
				result.fragments,
			),
		).toEqual({ start: 11, end: 14, anchor: 12 });
	});

	it("requires a new explicit PDT after discontinuity instead of inventing wall-clock continuity", () => {
		expect(() =>
			parseAisaRecordingMediaPlaylist(
				playlist(
					`#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n${segment}#EXT-X-DISCONTINUITY\n${segment}`,
				),
			),
		).toThrow();
		const result = parseAisaRecordingMediaPlaylist(
			playlist(
				`#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n${segment}#EXT-X-DISCONTINUITY\n#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:01:00Z\n${segment}`,
			),
		);
		expect(result.fragments[1]).toMatchObject({
			start: 5,
			programDateTime: origin + 60_000,
		});
	});

	it.each([
		"2026-11-07T23:59:59Z",
		"2026-11-08T00:00:03Z",
	])("rejects backward or overlapping explicit PDT without discontinuity: %s", (pdt) => {
		expect(() =>
			parseAisaRecordingMediaPlaylist(
				playlist(
					`#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n${segment}#EXT-X-PROGRAM-DATE-TIME:${pdt}\n${segment}#EXT-X-ENDLIST`,
				),
			),
		).toThrow("Recording timeline unavailable");
	});

	it("preserves monotonic explicit PDT and fractional durations at millisecond clock precision", () => {
		const fractionalSegment = "#EXTINF:4.5005,\nsegment.m4s\n";
		const result = parseAisaRecordingMediaPlaylist(
			playlist(
				`#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n${fractionalSegment}#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:04.500Z\n${fractionalSegment}#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:09.001Z\n${fractionalSegment}#EXT-X-ENDLIST`,
			),
		);
		expect(result.fragments).toMatchObject([
			{ start: 0, duration: 4.5005, programDateTime: origin },
			{ start: 4.5005, duration: 4.5005, programDateTime: origin + 4500 },
			{ start: 9.001, duration: 4.5005, programDateTime: origin + 9001 },
		]);
		const range = resolveMomentPlaybackRange(
			{ startInSeconds: 2, endInSeconds: 7, anchorInSeconds: 4 },
			origin,
			result.fragments,
		);
		expect(range).toMatchObject({ start: 2, anchor: 4 });
		expect(range?.end).toBeCloseTo(7.0005, 6);
	});

	it.each([
		"not HLS",
		playlist(""),
		playlist(segment),
		playlist(
			`segment.m4s\n#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n${segment}`,
		),
		playlist(`#EXT-X-PROGRAM-DATE-TIME:not-a-date\n${segment}`),
		playlist(`#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00\n${segment}`),
		playlist(`#EXT-X-PROGRAM-DATE-TIME:2026-02-30T00:00:00Z\n${segment}`),
		playlist(`#EXT-X-PROGRAM-DATE-TIME:2026-11-08T24:00:00Z\n${segment}`),
		playlist(
			`#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:01Z\n${segment}`,
		),
		playlist(
			`#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n${segment}#EXT-X-GAP`,
		),
		playlist(
			"#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n#EXTINF:0,\na.m4s",
		),
		playlist(
			"#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n#EXTINF:-5,\na.m4s",
		),
		playlist(
			"#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n#EXTINF:NaN,\na.m4s",
		),
		playlist(
			"#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n#EXTINF:5,\n#EXTINF:5,\na.m4s",
		),
		playlist("#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n#EXTINF:5,"),
		valid + segment,
		`${valid}#EXT-X-ENDLIST\n`,
		`${valid}#EXT-X-ENDLIST:invalid\n`,
		playlist(
			`#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n${segment}#EXT-X-GAP:invalid\n${segment}`,
		),
		playlist(
			`#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n${segment}#EXT-X-DISCONTINUITY:invalid\n${segment}`,
		),
		playlist(
			`#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n${segment}#EXT-X-PROGRAM-DATE-TIME\n${segment}`,
		),
		master(media()),
	])("rejects malformed or unanchored media data %#", (text) => {
		expect(() => parseAisaRecordingMediaPlaylist(text)).toThrow();
	});

	it("bounds fragment count and actual UTF-8 bytes", () => {
		const prefix = "#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n";
		expect(
			parseAisaRecordingMediaPlaylist(playlist(prefix + segment.repeat(4096)))
				.fragments,
		).toHaveLength(4096);
		expect(() =>
			parseAisaRecordingMediaPlaylist(playlist(prefix + segment.repeat(4097))),
		).toThrow();
		expect(() =>
			parseAisaRecordingMediaPlaylist(
				playlist(`#${"界".repeat(Math.floor((4 * 1024 * 1024) / 3) + 1)}`),
			),
		).toThrow();
	});
});

describe("scoped, read-only recording reads", () => {
	it.each([
		["without discontinuity", ""],
		["across discontinuity", "#EXT-X-DISCONTINUITY\n"],
	])("keeps a [2,7] moment unknown for overlapping PDT %s", async (_label, discontinuity) => {
		fetchMock.mockResolvedValue(
			response(
				playlist(
					`#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:00Z\n${segment}${discontinuity}#EXT-X-PROGRAM-DATE-TIME:2026-11-08T00:00:03Z\n${segment}#EXT-X-ENDLIST`,
				),
			),
		);
		await expect(
			readAisaRecordingTimeline(source, new AbortController().signal).then(
				(timeline) =>
					resolveMomentPlaybackRange(
						{ startInSeconds: 2, endInSeconds: 7, anchorInSeconds: 4 },
						origin,
						timeline.fragments,
					),
			),
		).rejects.toThrow("Recording timeline unavailable");
	});

	it("uses GET with cancellation, same-origin credentials, no cache and no redirects", async () => {
		fetchMock.mockResolvedValue(response(valid));
		const result = await readAisaRecordingTimeline(
			source,
			new AbortController().signal,
		);
		expect(result.endList).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(
			source,
			expect.objectContaining({
				method: "GET",
				credentials: "same-origin",
				redirect: "error",
				cache: "no-store",
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("follows only the first same-scope master variant and never reads segment URIs", async () => {
		fetchMock
			.mockResolvedValueOnce(
				response(
					`${master(media())}#EXT-X-STREAM-INF:BANDWIDTH=2\nhttps://external.invalid/not-selected.m3u8\n`,
				),
			)
			.mockResolvedValueOnce(response(valid));
		await readAisaRecordingTimeline(source, new AbortController().signal);
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([source, media()]);
	});

	it("accepts an absolute same-origin app variant but still fetches its relative scoped URL", async () => {
		fetchMock
			.mockResolvedValueOnce(response(master(location.origin + media())))
			.mockResolvedValueOnce(response(valid));
		await readAisaRecordingTimeline(source, new AbortController().signal);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(media());
	});

	it("accepts a media playlist after exactly three same-scope master hops", async () => {
		fetchMock
			.mockResolvedValueOnce(response(master(media("hop-1"))))
			.mockResolvedValueOnce(response(master(media("hop-2"))))
			.mockResolvedValueOnce(response(master(media("hop-3"))))
			.mockResolvedValueOnce(response(valid));
		expect(
			await readAisaRecordingTimeline(source, new AbortController().signal),
		).toMatchObject({ endList: true });
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			source,
			media("hop-1"),
			media("hop-2"),
			media("hop-3"),
		]);
	});

	it.each([
		"https://external.invalid/master.m3u8",
		"//external.invalid/master.m3u8",
		() => location.origin + source,
		source.replace("/recording?", "/other?"),
		source.replace(`&expectedOrganizationId=${organization}`, ""),
		`${source}&encodingId=${encoding}`,
		`${source}&url=https://external.invalid`,
		source.replace(account, "invalid"),
		`${source}#fragment`,
		media(),
	])("rejects an off-contract source before fetching %#", async (value) => {
		await expect(
			readAisaRecordingTimeline(
				typeof value === "function" ? value() : value,
				new AbortController().signal,
			),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		"https://external.invalid/master.m3u8",
		"//external.invalid/master.m3u8",
		media().replace(analysis, encoding),
		media().replace(account, encoding),
		media().replace(`encodingId=${encoding}`, `encodingId=${account}`),
		media().replace(organization, encoding),
		`${media()}&expectedOrganizationId=${organization}`,
		media().replace("&token=synthetic-token", ""),
		media(""),
		media("invalid%2Ftoken"),
		media("x".repeat(12001)),
		`${media()}&extra=1`,
		`${media()}#fragment`,
		source,
	])("does not fetch an off-scope or malformed variant %#", async (uri) => {
		fetchMock.mockResolvedValue(response(master(uri)));
		await expect(
			readAisaRecordingTimeline(source, new AbortController().signal),
		).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("caps master traversal at root plus three hops and rejects cycles", async () => {
		let counter = 0;
		fetchMock.mockImplementation(async () =>
			response(master(media(`hop-${++counter}`))),
		);
		await expect(
			readAisaRecordingTimeline(source, new AbortController().signal),
		).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(4);
		fetchMock.mockReset().mockResolvedValue(response(master(media("cycle"))));
		await expect(
			readAisaRecordingTimeline(source, new AbortController().signal),
		).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rejects HTTP, redirected, malformed, and invalid UTF-8 responses", async () => {
		for (const value of [
			new Response("private", { status: 403 }),
			Object.defineProperty(response(valid), "redirected", { value: true }),
			response("not a playlist"),
			new Response(new Uint8Array([255])),
		]) {
			fetchMock.mockResolvedValueOnce(value);
			await expect(
				readAisaRecordingTimeline(source, new AbortController().signal),
			).rejects.toThrow();
		}
	});

	it.each([
		`${master(media())}#EXT-X-STREAM-INF:BANDWIDTH=2\n`,
		master(media()) + segment,
		playlist(
			`#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXT-X-STREAM-INF:BANDWIDTH=2\n${media()}`,
		),
	])("rejects malformed or mixed master playlists before following %#", async (text) => {
		fetchMock.mockResolvedValue(response(text));
		await expect(
			readAisaRecordingTimeline(source, new AbortController().signal),
		).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("cancels an overflowing body without reading more or waiting for cancellation", async () => {
		let reads = 0;
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		const chunks = [
			new Uint8Array(4 * 1024 * 1024),
			new Uint8Array(1),
			new Uint8Array(1),
		];
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					const chunk = chunks[reads++];
					if (chunk) controller.enqueue(chunk);
					else controller.close();
				},
				cancel,
			},
			{ highWaterMark: 0 },
		);
		fetchMock.mockResolvedValue(new Response(body));
		await expect(
			readAisaRecordingTimeline(source, new AbortController().signal),
		).rejects.toThrow();
		expect(reads).toBe(2);
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});

	it("does not fetch when already aborted and cancels a pending body on later abort", async () => {
		const before = new AbortController();
		before.abort();
		await expect(
			readAisaRecordingTimeline(source, before.signal),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchMock).not.toHaveBeenCalled();
		const cancel = vi.fn();
		const pendingRead = vi.fn(() => new Promise<void>(() => {}));
		fetchMock.mockResolvedValue(
			new Response(
				new ReadableStream({ pull: pendingRead, cancel }, { highWaterMark: 0 }),
			),
		);
		const controller = new AbortController();
		const check = expect(
			readAisaRecordingTimeline(source, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });
		await vi.waitFor(() => expect(pendingRead).toHaveBeenCalledOnce());
		controller.abort();
		await check;
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("shares one 20-second deadline across master hops", async () => {
		vi.useFakeTimers();
		fetchMock
			.mockImplementationOnce(
				() =>
					new Promise((resolve) =>
						setTimeout(() => resolve(response(master(media()))), 19000),
					),
			)
			.mockImplementationOnce(
				(_url, init) =>
					new Promise((_resolve, reject) =>
						init?.signal?.addEventListener(
							"abort",
							() => reject(init.signal?.reason),
							{ once: true },
						),
					),
			);
		const check = expect(
			readAisaRecordingTimeline(source, new AbortController().signal),
		).rejects.toMatchObject({ name: "TimeoutError" });
		await vi.advanceTimersByTimeAsync(19000);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1000);
		await check;
	});

	it("does not expose upstream fetch error text or tokens", async () => {
		fetchMock.mockRejectedValue(
			new Error("https://upstream.invalid/?token=secret"),
		);
		await expect(
			readAisaRecordingTimeline(source, new AbortController().signal),
		).rejects.toThrow("Recording timeline unavailable");
	});
});
