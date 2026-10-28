import type { ContentView } from "@bitovp/core";
import { act, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { CatalogThumbnail } from "./catalog-thumbnail";
import * as thumbnailLoader from "./catalog-thumbnail-loader";
import {
	captureThumbnail,
	createThumbnailQueue,
} from "./catalog-thumbnail-loader";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const source = (url: string): NonNullable<ContentView["catalogPreview"]> => ({
	kind: "HLS",
	url,
	time: 5,
});
it("runs at most two decoders, skips canceled queued cards, and caches finished stills", async () => {
	const resolves: ((value: string | null) => void)[] = [];
	const load = vi.fn(
		() => new Promise<string | null>((resolve) => resolves.push(resolve)),
	);
	const queue = createThumbnailQueue(load);
	const signal = new AbortController().signal;
	const canceled = new AbortController();
	const first = queue(source("one"), signal),
		second = queue(source("two"), signal),
		third = queue(source("three"), canceled.signal);
	expect(load).toHaveBeenCalledTimes(2);
	canceled.abort();
	resolves[0]?.("data:image/jpeg;base64,one");
	resolves[1]?.(null);
	await expect(first).resolves.toContain("data:image");
	await expect(second).resolves.toBeNull();
	await expect(third).resolves.toBeNull();
	await expect(queue(source("one"), signal)).resolves.toContain("data:image");
	expect(load).toHaveBeenCalledTimes(2);
});
it("an aborted cache consumer cannot revive an offscreen request", async () => {
	const load = vi.fn(async () => "frame");
	const queue = createThumbnailQueue(load);
	const canceled = new AbortController();
	canceled.abort();
	await expect(queue(source("one"), canceled.signal)).resolves.toBeNull();
	expect(load).not.toHaveBeenCalled();
});

it.each([
	"unavailable",
	"rejected",
])("retries %s thumbnail loads after recovery and caches the recovered still", async (failure) => {
	const frame = "data:image/jpeg;base64,recovered";
	const load = vi.fn(async (): Promise<string | null> => frame);
	if (failure === "rejected")
		load.mockRejectedValueOnce(new Error("Storage temporarily unavailable"));
	else load.mockResolvedValueOnce(null);
	const queue = createThumbnailQueue(load);
	const signal = new AbortController().signal;
	const media = {
		...source("https://media.test/recovered.mp4"),
		kind: "MP4" as const,
	};

	await expect(queue(media, signal)).resolves.toBeNull();
	await expect(queue(media, signal)).resolves.toBe(frame);
	await expect(queue(media, signal)).resolves.toBe(frame);
	expect(load).toHaveBeenCalledTimes(2);
});

function nativeVideo() {
	vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue(
		"probably",
	);
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
}
it("releases an offscreen decoder immediately when its card leaves view", async () => {
	nativeVideo();
	const abort = new AbortController();
	const pending = captureThumbnail(
		source("https://media.test/a.m3u8"),
		abort.signal,
	);
	expect(document.querySelectorAll("video")).toHaveLength(1);
	abort.abort();
	await expect(pending).resolves.toBeNull();
	expect(document.querySelectorAll("video")).toHaveLength(0);
});
it("settles stalled media by its deadline and never starts audible playback", async () => {
	nativeVideo();
	vi.useFakeTimers();
	const play = vi.spyOn(HTMLMediaElement.prototype, "play");
	const pending = captureThumbnail(
		source("https://media.test/a.m3u8"),
		new AbortController().signal,
	);
	await vi.advanceTimersByTimeAsync(15000);
	await expect(pending).resolves.toBeNull();
	expect(play).not.toHaveBeenCalled();
	expect(document.querySelector("video")).toBeNull();
});
it.each([
	false,
	true,
])("captures a still or provides the CORS fallback (%s) with cleanup", async (tainted) => {
	nativeVideo();
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		drawImage: vi.fn(),
		fillRect: vi.fn(),
	} as unknown as CanvasRenderingContext2D);
	vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => {
		if (tainted) throw new DOMException("tainted", "SecurityError");
		return "data:image/jpeg;base64,frame";
	});
	const pending = captureThumbnail(
		source("https://media.test/a.m3u8"),
		new AbortController().signal,
	);
	const video = document.querySelector("video");
	if (!video) throw new Error("decoder missing");
	Object.defineProperties(video, {
		videoWidth: { value: 1920 },
		videoHeight: { value: 1080 },
		readyState: { value: 2 },
		duration: { value: 100 },
	});
	video.dispatchEvent(new Event("loadedmetadata"));
	await expect(pending).resolves.toBe(
		tainted ? null : "data:image/jpeg;base64,frame",
	);
	expect(document.querySelector("video")).toBeNull();
});

it.each([
	"MP4",
	"WEBM",
] as const)("uses direct %s for thumbnails and releases it on cancellation", async (kind) => {
	nativeVideo();
	const abort = new AbortController();
	const url = `https://media.test/video.${kind.toLowerCase()}`;
	const pending = captureThumbnail({ kind, url, time: 2 }, abort.signal);
	try {
		expect(document.querySelector("video")).toHaveAttribute("src", url);
	} finally {
		abort.abort();
		await expect(pending).resolves.toBeNull();
	}
	expect(document.querySelector("video")).toBeNull();
});

const libraryMp4 = {
	kind: "MP4" as const,
	url: "/api/library/sources/00000000-0000-4000-8000-000000000001/media?key=mp4%3Avideo",
	time: 2,
};

function observeThumbnail() {
	const observers: IntersectionObserverCallback[] = [];
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(callback: IntersectionObserverCallback) {
				observers.push(callback);
			}
			observe() {}
			disconnect() {}
		},
	);
	return (index = 0, isIntersecting = true) =>
		act(() =>
			observers[index]?.(
				[{ isIntersecting } as IntersectionObserverEntry],
				{} as IntersectionObserver,
			),
		);
}

it.each([
	"MP4",
	"WEBM",
] as const)("marks a failed %s preview as missing only after one authenticated range probe", async (kind) => {
	const file = {
		...libraryMp4,
		kind,
		url: libraryMp4.url.replace("mp4%3A", `${kind.toLowerCase()}%3A`),
	};
	const format = kind === "WEBM" ? "WebM" : "MP4";
	const intersect = observeThumbnail();
	let resolveFrame: (frame: string | null) => void = () => {};
	const load = vi.spyOn(thumbnailLoader, "requestThumbnail").mockImplementation(
		() =>
			new Promise((resolve) => {
				resolveFrame = resolve;
			}),
	);
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(
			Response.json(
				{ details: { code: "MEDIA_FILE_NOT_FOUND" } },
				{ status: 404 },
			),
		);
	const view = renderLocalized(
		createElement(CatalogThumbnail, { source: file, fallback: format }),
	);
	intersect();
	intersect();
	expect(load).toHaveBeenCalledTimes(1);
	expect(fetch).not.toHaveBeenCalled();
	await act(async () => resolveFrame(null));
	expect(screen.getByText(`${format} file missing`)).toBeVisible();
	expect(view.container.firstChild).toHaveAttribute(
		"title",
		`${format} file is missing from storage.`,
	);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(fetch).toHaveBeenCalledWith(file.url, {
		headers: { Range: "bytes=0-0" },
		cache: "no-store",
		signal: load.mock.calls[0]?.[1],
	});
});

it.each([
	"HLS",
	"MP4",
	"WEBM",
] as const)("shows unavailable %s previews without claiming playback is impossible", async (kind) => {
	const intersect = observeThumbnail();
	vi.spyOn(thumbnailLoader, "requestThumbnail").mockResolvedValue(null);
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(new Response("x", { status: 206 }));
	const view = renderLocalized(
		createElement(CatalogThumbnail, {
			source: { ...libraryMp4, kind },
			fallback: kind,
			compact: true,
		}),
	);
	await act(async () => intersect());
	expect(screen.getByText("Preview unavailable")).toHaveClass("sr-only");
	expect(view.container.firstChild).toHaveAttribute(
		"title",
		"Preview unavailable",
	);
	expect(
		screen.getByRole("img", { name: "Preview unavailable" }),
	).toBeInTheDocument();
	expect(view.container.querySelector(".lucide-triangle-alert")).not.toBeNull();
	expect(
		screen.queryByText(`${kind === "WEBM" ? "WebM" : "MP4"} file missing`),
	).not.toBeInTheDocument();
	expect(fetch).toHaveBeenCalledTimes(kind === "HLS" ? 0 : 1);
});

it("does not probe successful frames or metadata-only cards", async () => {
	const intersect = observeThumbnail();
	const load = vi
		.spyOn(thumbnailLoader, "requestThumbnail")
		.mockResolvedValue("data:image/jpeg;base64,frame");
	const fetch = vi.spyOn(globalThis, "fetch");
	const view = renderLocalized(
		createElement(CatalogThumbnail, { source: libraryMp4, fallback: "MP4" }),
	);
	await act(async () => intersect());
	expect(view.container.querySelector("img")).not.toBeNull();
	view.rerender(createElement(CatalogThumbnail, { fallback: "Metadata only" }));
	expect(screen.getByText("Metadata only")).toBeInTheDocument();
	expect(screen.queryByText("Preview unavailable")).not.toBeInTheDocument();
	expect(load).toHaveBeenCalledTimes(1);
	expect(fetch).not.toHaveBeenCalled();
});

it.each([
	["MP4", "source change"],
	["MP4", "unmount"],
	["WEBM", "source change"],
	["WEBM", "unmount"],
] as const)("aborts a pending %s missing-file probe on %s and ignores its stale result", async (kind, change) => {
	const file = {
		...libraryMp4,
		kind,
		url: libraryMp4.url.replace("mp4%3A", `${kind.toLowerCase()}%3A`),
	};
	const format = kind === "WEBM" ? "WebM" : "MP4";
	const intersect = observeThumbnail();
	vi.spyOn(thumbnailLoader, "requestThumbnail").mockResolvedValue(null);
	let resolveProbe: (response: Response) => void = () => {};
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
		() =>
			new Promise((resolve) => {
				resolveProbe = resolve;
			}),
	);
	const view = renderLocalized(
		createElement(CatalogThumbnail, { source: file, fallback: format }),
	);
	await act(async () => intersect());
	expect(fetch).toHaveBeenCalledTimes(1);
	const signal = (fetch.mock.calls[0]?.[1] as RequestInit).signal;
	if (change === "unmount") view.unmount();
	else
		view.rerender(
			createElement(CatalogThumbnail, {
				source: { ...file, time: 8 },
				fallback: format,
			}),
		);
	expect(signal?.aborted).toBe(true);
	await act(async () =>
		resolveProbe(
			Response.json(
				{ details: { code: "MEDIA_FILE_NOT_FOUND" } },
				{ status: 404 },
			),
		),
	);
	expect(
		screen.queryByText(`${kind === "WEBM" ? "WebM" : "MP4"} file missing`),
	).not.toBeInTheDocument();
	if (change === "source change")
		expect(screen.getByText("Loading thumbnail…")).toBeInTheDocument();
});
