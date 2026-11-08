import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureThumbnail } from "./catalog-thumbnail-loader";
import {
	captureClipThumbnail,
	createClipThumbnailQueue,
} from "./clip-thumbnail-loader";

const api = vi.hoisted(() => vi.fn());
const paint = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: api }));
vi.mock("./edits/[id]/composition-preview", () => ({
	paintCompositionFrame: paint,
}));
const org = "00000000-0000-4000-8000-000000000001";
const media = "00000000-0000-4000-8000-000000000002";
const ref = {
	url: `/thumb?expectedOrganizationId=${org}`,
	cacheKey: "key",
	draftRevision: 1,
	width: 1080,
	height: 1920,
};
let videos: HTMLVideoElement[];
function descriptor() {
	return {
		cacheKey: "key",
		draftRevision: 1,
		frame: {
			canvas: { width: 108, height: 192 },
			layers: [{ clipId: "c", mediaVersionId: media, sourceSeconds: 2.2 }],
			overlays: [],
			captions: [],
			audio: [],
		},
		video: {
			clipId: "c",
			mediaVersionId: media,
			url: `/api/library/media-versions/${media}/media?expectedOrganizationId=${org}`,
		},
		images: [],
	};
}
beforeEach(() => {
	videos = [];
	api.mockReset();
	paint.mockReset();
	api.mockImplementation(async () => descriptor());
	vi.stubGlobal("FontFace", undefined);
	const create = document.createElement.bind(document);
	vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
		const element = create(tag, options);
		if (tag === "video") {
			const video = element as HTMLVideoElement;
			Object.defineProperties(video, {
				readyState: { value: 2 },
				duration: { value: 100 },
			});
			video.load = vi.fn();
			video.pause = vi.fn();
			videos.push(video);
		}
		return element;
	});
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
		{} as CanvasRenderingContext2D,
	);
	vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
		"data:image/jpeg;base64,still",
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
async function flush() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}
it("never opens more than two decoders, and releases them before starting the queued capture", async () => {
	const queue = createClipThumbnailQueue(captureClipThumbnail);
	const a = new AbortController(),
		b = new AbortController(),
		c = new AbortController();
	const p1 = queue(ref, "en", a.signal),
		p2 = queue(ref, "ja", b.signal),
		p3 = queue({ ...ref, url: `${ref.url}&different=1` }, "en", c.signal);
	await flush();
	expect(videos).toHaveLength(2);
	a.abort();
	await p1;
	await flush();
	expect(videos).toHaveLength(3);
	expect(videos[0]?.getAttribute("src")).toBeNull();
	expect(videos[0]?.isConnected).toBe(false);
	b.abort();
	c.abort();
	await Promise.all([p2, p3]);
	expect(
		videos.every((video) => !video.isConnected && !video.hasAttribute("src")),
	).toBe(true);
});
it("seeks the measured normalized source clock, paints the descriptor and caches only the small still", async () => {
	const queue = createClipThumbnailQueue(captureClipThumbnail);
	const signal = new AbortController().signal;
	const pending = queue(ref, "en", signal);
	await flush();
	videos[0]?.dispatchEvent(new Event("loadedmetadata"));
	expect(await pending).toBe("data:image/jpeg;base64,still");
	expect(videos[0]?.currentTime).toBe(2.2);
	expect(paint.mock.calls[0]?.[1]).toMatchObject(descriptor().frame);
	expect(videos[0]?.getAttribute("src")).toBeNull();
	expect(await queue(ref, "en", signal)).toBe("data:image/jpeg;base64,still");
	expect(videos).toHaveLength(1);
});
it("does not decode a stale version, unsupported composition or foreign-org media URL", async () => {
	for (const value of [
		{ ...descriptor(), cacheKey: "old" },
		{ ...descriptor(), frame: null, video: null },
		{
			...descriptor(),
			video: {
				...descriptor().video,
				url: `/api/library/media-versions/${media}/media?expectedOrganizationId=other`,
			},
		},
	]) {
		api.mockResolvedValueOnce(value);
		expect(
			await captureClipThumbnail(ref, "en", new AbortController().signal),
		).toBeNull();
	}
	expect(videos).toHaveLength(0);
});
it("bounds the entire fetch/decode attempt to fifteen seconds and does not cache failures", async () => {
	vi.useFakeTimers();
	api.mockImplementation(() => new Promise(() => {}));
	const queue = createClipThumbnailQueue(captureClipThumbnail);
	const pending = queue(ref, "en", new AbortController().signal);
	await vi.advanceTimersByTimeAsync(15_000);
	expect(await pending).toBeNull();
	api.mockResolvedValueOnce({ ...descriptor(), frame: null, video: null });
	expect(await queue(ref, "en", new AbortController().signal)).toBeNull();
	expect(api).toHaveBeenCalledTimes(2);
});
it("shares the exact two-decoder budget with the original catalog thumbnails", async () => {
	const a = new AbortController(),
		b = new AbortController(),
		c = new AbortController();
	const original = captureThumbnail(
		{ kind: "MP4", url: "/source", time: 0 },
		a.signal,
	);
	const clip = captureClipThumbnail(ref, "en", b.signal);
	const waiting = captureClipThumbnail(ref, "ja", c.signal);
	await flush();
	expect(videos).toHaveLength(2);
	a.abort();
	await original;
	await flush();
	expect(videos).toHaveLength(3);
	expect(videos[0]?.hasAttribute("src")).toBe(false);
	b.abort();
	c.abort();
	await Promise.all([clip, waiting]);
	expect(
		videos.every((video) => !video.isConnected && !video.hasAttribute("src")),
	).toBe(true);
});
it("keeps at most sixty-four successful stills and retries an evicted entry", async () => {
	const load = vi.fn(async () => "data:image/jpeg;base64,small");
	const queue = createClipThumbnailQueue(load),
		signal = new AbortController().signal;
	for (let i = 0; i < 65; i++)
		await queue({ ...ref, cacheKey: String(i) }, "en", signal);
	await queue({ ...ref, cacheKey: "64" }, "en", signal);
	expect(load).toHaveBeenCalledTimes(65);
	await queue({ ...ref, cacheKey: "0" }, "en", signal);
	expect(load).toHaveBeenCalledTimes(66);
});
