import { normalizeSceneAnalysis } from "@bitovp/core";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
	LoaderCallbacks,
	LoaderConfiguration,
	LoaderContext,
} from "hls.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/messages/en";
import { ja } from "@/lib/i18n/messages/ja";
import { renderLocalized as renderL } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

/**
 * hls.js needs MSE, which jsdom does not have — so the library is mocked and
 * its fatal-error callback is driven directly. What is under test is the
 * DIAGNOSIS: a player error alone says "networkError" and nothing about why,
 * and the measured gap on the real bucket  was a CORS header a player
 * can never name.
 */
let fatal: ((data?: Record<string, unknown>) => void) | null = null;
let fragmentLoaded: (() => void) | null = null;
let realHls: object | null = null;
const stopHls = vi.fn();
const destroyHls = vi.fn();
const attached: string[] = [];
/** Flipped by the native-fallback cases; MSE is the default everywhere else. */
let mseSupported = true;
vi.mock("hls.js", () => {
	class Hls {
		static Events = { ERROR: "hlsError", FRAG_LOADED: "hlsFragLoaded" };
		static isSupported() {
			return mseSupported;
		}
		/**
		 * Bind ONLY the error event. The first version captured whichever callback
		 * registered last, so adding a `FRAG_LOADED` listener to the component
		 * silently redirected `fatal` at it andseven CORS tests failed for a reason
		 * that had nothing to do with the component.
		 */
		on(event: string, cb: (e: unknown, data: unknown) => void) {
			if (event === "hlsError") {
				fatal = (data) =>
					cb("hlsError", {
						fatal: true,
						type: "networkError",
						details: "manifestLoadError",
						response: { code: 404 },
						...data,
					});
			} else if (event === "hlsFragLoaded") {
				fragmentLoaded = () => cb(event, {});
			}
		}
		loadSource(url: string) {
			attached.push(`load:${url}`);
		}
		attachMedia(el: HTMLVideoElement) {
			attached.push(`attach:${el.tagName}`);
		}
		// Like the real library, this cannot reload an initial master manifest.
		startLoad() {}
		stopLoad() {
			stopHls();
		}
		destroy() {
			destroyHls();
		}
	}
	return {
		default: new Proxy(Hls, {
			construct: (target) =>
				typeof realHls === "function" ? realHls() : (realHls ?? new target()),
		}),
	};
});

const shakaCalls: {
	attached: string[];
	configured: unknown[];
	destroyed: number;
	installed: number;
	loaded: unknown[][];
} = {
	attached: [],
	configured: [],
	destroyed: 0,
	installed: 0,
	loaded: [],
};
let shakaLoadGate: Promise<void> | null = null;
let shakaSupported = true;
type ShakaTestEvent = {
	detail?: unknown;
	contentType?: string;
	isMuxed?: boolean;
};
let shakaErrorListener: ((event: ShakaTestEvent) => void) | null = null;
let shakaSegmentAppendedListener: ((event: ShakaTestEvent) => void) | null =
	null;
const shakaLoadOutcomes: unknown[] = [];
const shakaVariantTracks: Array<{
	active: boolean;
	audioId: number | null;
	videoId: number | null;
}> = [];
vi.mock("shaka-player", () => ({
	default: {
		polyfill: {
			installAll() {
				shakaCalls.installed += 1;
			},
		},
		Player: class {
			static isBrowserSupported() {
				return shakaSupported;
			}
			async attach(element: HTMLMediaElement) {
				shakaCalls.attached.push(element.tagName);
			}
			configure(config: unknown) {
				shakaCalls.configured.push(config);
			}
			getVariantTracks() {
				return shakaVariantTracks;
			}
			addEventListener(
				type: string,
				listener: (event: ShakaTestEvent) => void,
			) {
				if (type === "error") {
					shakaErrorListener = listener;
				} else if (type === "segmentappended") {
					shakaSegmentAppendedListener = listener;
				}
			}
			removeEventListener(
				type: string,
				listener: (event: ShakaTestEvent) => void,
			) {
				if (type === "error" && shakaErrorListener === listener) {
					shakaErrorListener = null;
				} else if (
					type === "segmentappended" &&
					shakaSegmentAppendedListener === listener
				) {
					shakaSegmentAppendedListener = null;
				}
			}
			async load(...args: unknown[]) {
				shakaCalls.loaded.push(args);
				if (shakaLoadGate) {
					await shakaLoadGate;
				}
				const outcome = shakaLoadOutcomes.shift();
				if (outcome !== undefined) {
					throw outcome;
				}
			}
			async destroy() {
				shakaCalls.destroyed += 1;
			}
		},
	},
}));

import {
	FIRST_SEGMENT_ATTEMPTS,
	PlaybackSurface,
	SHAKA_RECOVERY_STALL_MS,
} from "./playback-surface";
import { PlayerDialog } from "./player-dialog";
import { PreviewRail } from "./preview-rail";

const JOB = "00000000-0000-4000-8000-0000000000aa";
const URL_HLS = "https://out.s3.eu-west-1.amazonaws.com/o/stream.m3u8";

beforeEach(() => {
	vi.clearAllMocks();
	apiFetch.mockResolvedValue(null);
	fatal = null;
	fragmentLoaded = null;
	realHls = null;
	attached.length = 0;
	mseSupported = true;
	shakaCalls.attached.length = 0;
	shakaCalls.configured.length = 0;
	shakaCalls.destroyed = 0;
	shakaCalls.installed = 0;
	shakaCalls.loaded.length = 0;
	shakaLoadGate = null;
	shakaSupported = true;
	shakaErrorListener = null;
	shakaSegmentAppendedListener = null;
	shakaLoadOutcomes.length = 0;
	shakaVariantTracks.length = 0;
	shakaVariantTracks.push({ active: true, audioId: 1, videoId: 2 });
	bitmovinLoadError = undefined;
	bitmovinError = null;
	// jsdom's canPlayType returns "" so the native-HLS branch is skipped and the
	// hls.js path (the one every non-Safari browser takes) is exercised.
});

afterEach(() => vi.useRealTimers());

function open(
	diagnose = { scope: "vod" as const, id: JOB, manifestKey: "hls" },
) {
	renderL(
		<PlayerDialog
			url={URL_HLS}
			kind="HLS"
			diagnose={diagnose}
			onClose={vi.fn()}
		/>,
	);
}

const analysis = normalizeSceneAnalysis({
	metadata: { version: "1" },
	duration: 20,
	scenes: [
		{
			id: "00000000-0000-4000-8000-000000000001",
			startInSeconds: 2,
			endInSeconds: 5,
			title: "Opening scene",
			summary: "Opening summary",
		},
		{
			id: "00000000-0000-4000-8000-000000000002",
			startInSeconds: 7,
			endInSeconds: 10,
			title: "Closing scene",
		},
	],
});

describe("PlaybackSurface — scene overlay", () => {
	it("emits the media clock to fresh callback props without reloading and clears it on failure", async () => {
		const first = vi.fn();
		const second = vi.fn();
		const view = renderL(
			<PlaybackSurface url={URL_HLS} kind="HLS" onTimeChange={first} />,
		);
		await waitFor(() => expect(attached).toHaveLength(2));
		const video = view.container.querySelector("video");
		if (!video) throw new Error("Missing video");
		Object.defineProperty(video, "readyState", { value: 1 });
		fireEvent.timeUpdate(video, { target: { currentTime: 2 } });
		expect(first).toHaveBeenLastCalledWith(2);
		view.rerender(
			<PlaybackSurface url={URL_HLS} kind="HLS" onTimeChange={second} />,
		);
		fireEvent.timeUpdate(video, { target: { currentTime: 3 } });
		expect(second).toHaveBeenLastCalledWith(3);
		expect(attached).toHaveLength(2);
		act(() => fatal?.());
		expect(second).toHaveBeenLastCalledWith(null);
	});
	it("toggles current-shot subject observations independently from summaries", async () => {
		const sceneAnalysis = normalizeSceneAnalysis({
			metadata: { version: "1" },
			duration: 10,
			scenes: [
				{
					id: JOB,
					title: "Shot scene",
					startInSeconds: 0,
					endInSeconds: 10,
					shots: [
						{
							startInSeconds: 2,
							endInSeconds: 5,
							mainSubjects: [
								{
									classification: "Observed person",
									description: "At this shot",
									appearanceTimeInSeconds: 1,
									centerX: 20,
									centerY: 30,
								},
							],
						},
					],
				},
			],
		});
		const view = renderL(
			<PlaybackSurface
				url={URL_HLS}
				kind="HLS"
				sceneAnalysis={sceneAnalysis}
			/>,
		);
		await waitFor(() => expect(attached).toHaveLength(2));
		const video = view.container.querySelector("video");
		if (!video) throw new Error("Missing video");
		Object.defineProperties(video, {
			readyState: { value: 1 },
			clientWidth: { value: 400 },
			clientHeight: { value: 225 },
			videoWidth: { value: 1920 },
			videoHeight: { value: 1080 },
		});
		fireEvent.timeUpdate(video, { target: { currentTime: 2 } });
		expect(screen.queryByText("Observed person")).not.toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Show subject observations" }),
		);
		expect(await screen.findByText("Observed person")).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Show scene overlay" }),
		);
		expect(screen.queryByText("Shot scene")).not.toBeInTheDocument();
		expect(screen.getByText("Observed person")).toBeInTheDocument();
		fireEvent.timeUpdate(video, { target: { currentTime: 5 } });
		expect(screen.queryByText("Observed person")).not.toBeInTheDocument();
		fireEvent.timeUpdate(video, { target: { currentTime: 2 } });
		act(() => fatal?.());
		expect(screen.queryByText("Observed person")).not.toBeInTheDocument();
		expect(attached).toHaveLength(2);
	});
	it.each([
		"rail",
		"dialog",
	])("passes scene data and seek requests to the existing %s player", async (surface) => {
		const props = {
			sceneAnalysis: analysis,
			seekRequest: { seconds: 2.5, requestId: 1 },
		};
		const links = [
			{
				key: "hls",
				url: URL_HLS,
				kind: "HLS" as const,
				label: "HLS",
				path: "stream.m3u8",
				via: "derived" as const,
			},
		];
		renderL(
			surface === "dialog" ? (
				<PlayerDialog {...props} url={URL_HLS} kind="HLS" onClose={vi.fn()} />
			) : (
				<PreviewRail
					{...props}
					jobId={JOB}
					links={links}
					playable={links}
					playableKeys={new Set(["hls"])}
					live={false}
					showPlayer
				/>
			),
		);
		await waitFor(() => expect(attached).toHaveLength(2));
		const video = document.querySelector("video");
		if (!video) throw new Error("Missing video");
		Object.defineProperty(video, "readyState", {
			configurable: true,
			value: 1,
		});
		fireEvent.loadedMetadata(video);
		expect(video.currentTime).toBe(2.5);
		fireEvent.seeked(video);
		expect(screen.getByText("Opening scene")).toBeInTheDocument();
		expect(document.querySelectorAll("video")).toHaveLength(1);
	});
	it.each([
		"hls",
		"native",
		"shaka",
	])("uses the %s media clock, clears gaps and keeps the loaded player", async (engine) => {
		mseSupported = engine !== "native";
		const native = vi
			.spyOn(HTMLMediaElement.prototype, "canPlayType")
			.mockReturnValue("probably");
		const props = {
			url: URL_HLS,
			kind: engine === "shaka" ? ("DASH" as const) : ("HLS" as const),
			sceneAnalysis: analysis,
		};
		try {
			const view = renderL(<PlaybackSurface {...props} />);
			const video = view.container.querySelector("video");
			if (!video) throw new Error("Missing video");
			await waitFor(() =>
				expect(
					engine === "native"
						? video.src
						: engine === "shaka"
							? shakaCalls.loaded.length
							: attached.length,
				).toBeTruthy(),
			);
			expect(screen.queryByText("Opening scene")).not.toBeInTheDocument();
			Object.defineProperty(video, "readyState", {
				configurable: true,
				value: 1,
			});
			fireEvent.timeUpdate(video, { target: { currentTime: 2 } });
			expect(screen.getByText("Opening scene")).toBeInTheDocument();
			fireEvent.timeUpdate(video, { target: { currentTime: 5 } });
			expect(screen.queryByText("Opening scene")).not.toBeInTheDocument();
			fireEvent.timeUpdate(video, { target: { currentTime: 7 } });
			expect(screen.getByText("Closing scene")).toBeInTheDocument();
			view.rerender(
				<PlaybackSurface
					{...props}
					sceneAnalysis={{
						...analysis,
						scenes: analysis.scenes.map((scene) => ({
							...scene,
							title: "Updated scene",
						})),
					}}
				/>,
			);
			expect(screen.getByText("Updated scene")).toBeInTheDocument();
			fireEvent.click(screen.getByRole("checkbox"));
			expect(screen.queryByText("Updated scene")).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole("checkbox"));
			fireEvent.emptied(video);
			expect(screen.queryByText("Updated scene")).not.toBeInTheDocument();
			if (engine === "hls") expect(attached).toHaveLength(2);
			if (engine === "shaka") expect(shakaCalls.loaded).toHaveLength(1);
			view.unmount();
		} finally {
			native.mockRestore();
		}
	});
	it("uses Bitmovin time events and removes its listener on unmount", async () => {
		bitmovinCalls.length = 0;
		const onTimeChange = vi.fn();
		const props = {
			url: URL_HLS,
			kind: "HLS" as const,
			player: { provider: "bitmovin" as const, playerLicenseKey: "test" },
			sceneAnalysis: analysis,
			onTimeChange,
		};
		const view = renderL(<PlaybackSurface {...props} />);
		await waitFor(() => expect(bitmovinTime).not.toBeNull());
		act(() => bitmovinTime?.({ time: 2 }));
		expect(onTimeChange).toHaveBeenLastCalledWith(2);
		expect(screen.getByText("Opening scene")).toBeInTheDocument();
		act(() => bitmovinTime?.({ time: 5 }));
		expect(screen.queryByText("Opening scene")).not.toBeInTheDocument();
		act(() => bitmovinTime?.({ time: 7 }));
		view.rerender(
			<PlaybackSurface {...props} sceneAnalysis={{ ...analysis }} />,
		);
		expect(screen.getByText("Closing scene")).toBeInTheDocument();
		act(() => bitmovinError?.({ name: "LICENSE_ERROR" }));
		expect(onTimeChange).toHaveBeenLastCalledWith(null);
		expect(screen.queryByText("Closing scene")).not.toBeInTheDocument();
		expect(bitmovinCalls).toHaveLength(1);
		view.unmount();
		expect(bitmovinTime).toBeNull();
	});
});

describe("PlaybackSurface — scene seeks", () => {
	it.each([
		"hls",
		"native",
		"shaka",
	])("waits for metadata, seeks repeatedly and keeps the %s instance", async (engine) => {
		mseSupported = engine !== "native";
		const native = vi
			.spyOn(HTMLMediaElement.prototype, "canPlayType")
			.mockReturnValue("probably");
		const kind = engine === "shaka" ? ("DASH" as const) : ("HLS" as const);
		const props = { url: URL_HLS, kind };
		try {
			const view = renderL(
				<PlaybackSurface
					{...props}
					seekRequest={{ seconds: 4.25, requestId: 1 }}
				/>,
			);
			const video = view.container.querySelector("video");
			if (!video) throw new Error("Missing video");
			await waitFor(() =>
				expect(
					engine === "native"
						? video.src
						: engine === "shaka"
							? shakaCalls.loaded.length
							: attached.length,
				).toBeTruthy(),
			);
			expect(video.currentTime).toBe(0);
			Object.defineProperty(video, "readyState", {
				configurable: true,
				value: 1,
			});
			fireEvent.loadedMetadata(video);
			expect(video.currentTime).toBe(4.25);
			video.currentTime = 8;
			view.rerender(
				<PlaybackSurface
					{...props}
					seekRequest={{ seconds: 4.25, requestId: 2 }}
				/>,
			);
			expect(video.currentTime).toBe(4.25);
			view.rerender(
				<PlaybackSurface
					{...props}
					seekRequest={{ seconds: Number.NaN, requestId: 3 }}
				/>,
			);
			expect(video.currentTime).toBe(4.25);
			if (engine === "hls") expect(attached).toHaveLength(2);
			if (engine === "shaka") expect(shakaCalls.loaded).toHaveLength(1);
			view.unmount();
			video.currentTime = 9;
			fireEvent.loadedMetadata(video);
			expect(video.currentTime).toBe(9);
		} finally {
			native.mockRestore();
		}
	});
	it("queues Bitmovin seeks until load resolves without rebuilding on clicks", async () => {
		bitmovinCalls.length = 0;
		let release = () => {};
		loadGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const props = {
			url: URL_HLS,
			kind: "HLS" as const,
			player: { provider: "bitmovin" as const, playerLicenseKey: "test" },
		};
		try {
			const view = renderL(
				<PlaybackSurface
					{...props}
					seekRequest={{ seconds: 6, requestId: 1 }}
				/>,
			);
			await waitFor(() => expect(bitmovinCalls).toHaveLength(1));
			expect(bitmovinSeek).not.toHaveBeenCalled();
			view.rerender(
				<PlaybackSurface
					{...props}
					seekRequest={{ seconds: 7, requestId: 2 }}
				/>,
			);
			await act(async () => release());
			expect(bitmovinSeek).toHaveBeenLastCalledWith(7);
			view.rerender(
				<PlaybackSurface
					{...props}
					seekRequest={{ seconds: 7, requestId: 3 }}
				/>,
			);
			expect(bitmovinSeek).toHaveBeenCalledTimes(2);
			expect(bitmovinCalls).toHaveLength(1);
			view.unmount();
		} finally {
			loadGate = null;
		}
	});
	it("never seeks a Bitmovin instance whose pending load outlives unmount", async () => {
		bitmovinCalls.length = 0;
		let release = () => {};
		loadGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const view = renderL(
				<PlaybackSurface
					url={URL_HLS}
					kind="HLS"
					player={{ provider: "bitmovin", playerLicenseKey: "test" }}
					seekRequest={{ seconds: 6, requestId: 1 }}
				/>,
			);
			await waitFor(() => expect(bitmovinCalls).toHaveLength(1));
			view.unmount();
			await act(async () => release());
			expect(bitmovinSeek).not.toHaveBeenCalled();
		} finally {
			loadGate = null;
		}
	});
});

describe("PlaybackSurface — the player actually starts", () => {
	it("loads the source and attaches the media element", async () => {
		/**
		 * Regression, and the reason this file exists at all.
		 *
		 * Radix's `Dialog.Portal` mounts its children one commit AFTER this
		 * component's effects run, so the `useRef` this used to read was still
		 * null — and a ref mutation does not re-render, so the effect never ran
		 * again. The dialog showed an empty black `<video>` with controls and
		 * nothing ever played. With a `useRef` in place of the state-held callback
		 * ref, `attached` stays empty and every case below fails for the same
		 * reason: hls.js is never even imported.
		 */
		open();
		await waitFor(() =>
			expect(attached).toEqual([`load:${URL_HLS}`, "attach:VIDEO"]),
		);
	});
});

describe("PlaybackSurface — CORS diagnosis", () => {
	it("asks nothing while playback has not failed", async () => {
		open();
		await waitFor(() => expect(fatal).not.toBeNull());
		// A working playback must not pay for an outbound storage call.
		expect(apiFetch).not.toHaveBeenCalled();
	});

	it("keeps missing ExposeHeaders advisory for the measured hls.js path", async () => {
		apiFetch.mockResolvedValue({
			supported: true,
			origin: "http://localhost:3100",
			bucket: "out",
			verdict: {
				code: "MISSING_EXPOSE_HEADERS",
				headers: ["content-range", "accept-ranges"],
			},
		});
		open();
		await waitFor(() => expect(fatal).not.toBeNull());
		act(() => fatal?.());

		expect(
			await screen.findByText(/do not expose content-range, accept-ranges/),
		).toBeInTheDocument();
		expect(
			await screen.findByText(
				/hls\.js path plays without those exposed headers/,
			),
		).toBeInTheDocument();
		expect(apiFetch).toHaveBeenCalledWith(
			`/api/encoding-jobs/${JOB}/playback-cors?manifestKey=hls`,
		);
	});

	it("rules CORS out rather than staying silent when the rules are fine", async () => {
		apiFetch.mockResolvedValue({
			supported: true,
			origin: "http://localhost:3100",
			bucket: "out",
			verdict: { code: "OK" },
		});
		open();
		await waitFor(() => expect(fatal).not.toBeNull());
		fatal?.();

		// "Not the cause" is a finding too: it stops the operator rewriting a
		// bucket policy that was never the problem.
		expect(
			await screen.findByText(/CORS is not the cause/),
		).toBeInTheDocument();
	});

	it("says it could not check, rather than implying the bucket is fine", async () => {
		apiFetch.mockResolvedValue({
			supported: false,
			origin: "http://localhost:3100",
			reason: "FORBIDDEN",
		});
		open();
		await waitFor(() => expect(fatal).not.toBeNull());
		fatal?.();

		expect(
			await screen.findByText(/not allowed to read the bucket's CORS/),
		).toBeInTheDocument();
	});

	it("asks once, however many times the player reports the failure", async () => {
		apiFetch.mockResolvedValue({
			supported: true,
			origin: "o",
			bucket: "b",
			verdict: { code: "NO_RULES" },
		});
		open();
		await waitFor(() => expect(fatal).not.toBeNull());
		// hls.js re-fires fatal errors as it retries; each would otherwise be an
		// outbound GetBucketCors.
		fatal?.();
		fatal?.();
		fatal?.();
		await screen.findByText(/no CORS configuration/);
		expect(apiFetch).toHaveBeenCalledTimes(1);
	});

	it("reports the check itself failing without inventing a verdict", async () => {
		apiFetch.mockRejectedValue(new Error("502"));
		open();
		await waitFor(() => expect(fatal).not.toBeNull());
		fatal?.();

		expect(
			await screen.findByText(/Could not check the bucket's CORS/),
		).toBeInTheDocument();
	});

	it("stays quiet when the caller cannot name the manifest", async () => {
		renderL(<PlayerDialog url={URL_HLS} kind="HLS" onClose={vi.fn()} />);
		await waitFor(() => expect(fatal).not.toBeNull());
		fatal?.();
		await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
		expect(apiFetch).not.toHaveBeenCalled();
	});

	it("renders the diagnosis in Japanese", async () => {
		apiFetch.mockResolvedValue({
			supported: true,
			origin: "o",
			bucket: "b",
			verdict: { code: "NO_RULES" },
		});
		renderL(
			<PlayerDialog
				url={URL_HLS}
				kind="HLS"
				diagnose={{ scope: "vod", id: JOB, manifestKey: "hls" }}
				onClose={vi.fn()}
			/>,
			"ja",
		);
		await waitFor(() => expect(fatal).not.toBeNull());
		fatal?.();

		expect(
			await screen.findByText(/CORS 設定がありません/),
		).toBeInTheDocument();
	});
});

describe("PlaybackSurface — mounted inline, outside any portal", () => {
	/**
	 * The inline preview mounts this directly, with no dialog around it. The
	 * portal-timing fix must not have traded one mount path for the other.
	 */
	it("initialises when there is no portal at all", async () => {
		renderL(
			<PlaybackSurface
				url={URL_HLS}
				kind="HLS"
				autoPlay
				diagnose={{ scope: "vod", id: JOB, manifestKey: "hls" }}
			/>,
		);
		await waitFor(() =>
			expect(attached).toEqual([`load:${URL_HLS}`, "attach:VIDEO"]),
		);
	});

	it("autoplays only when asked", () => {
		const { unmount } = renderL(
			<PlaybackSurface url={URL_HLS} kind="HLS" autoPlay />,
		);
		expect(document.querySelector("video")).toHaveAttribute("autoplay");
		unmount();
		renderL(<PlaybackSurface url={URL_HLS} kind="HLS" />);
		expect(document.querySelector("video")).not.toHaveAttribute("autoplay");
	});

	it("is muted whenever it plays unprompted", () => {
		// An inline panel that starts audible on page load would be indefensible;
		// muting is what makes autoplay acceptable (and what browsers require).
		renderL(<PlaybackSurface url={URL_HLS} kind="HLS" autoPlay />);
		expect(document.querySelector("video")).toHaveProperty("muted", true);
	});
});

describe("PlaybackSurface — MSE is preferred over native HLS", () => {
	/**
	 * Measured, not assumed : Chrome on macOS answers
	 * `canPlayType("application/vnd.apple.mpegurl")` with "maybe", then FAILS a
	 * live fMP4 HLS playlist outright (MEDIA_ERR_SRC_NOT_SUPPORTED, 0s buffered)
	 * while hls.js plays it. Native-first therefore meant live playback in Chrome
	 * was a dead element with no message — jsdom's canPlayType returns "" so no
	 * existing test could have seen it.
	 */
	it("uses hls.js even when the browser claims it can play HLS natively", async () => {
		const canPlay = vi
			.spyOn(HTMLMediaElement.prototype, "canPlayType")
			.mockReturnValue("maybe");
		open();
		await waitFor(() =>
			expect(attached).toEqual([`load:${URL_HLS}`, "attach:VIDEO"]),
		);
		// And the element is NOT sourced directly — that is the native path, the
		// one Chrome/macOS took and then failed on live.
		expect(document.querySelector("video")).not.toHaveAttribute("src");
		canPlay.mockRestore();
	});

	it("replaces a failed native video on explicit retry", async () => {
		mseSupported = false;
		const canPlay = vi
			.spyOn(HTMLMediaElement.prototype, "canPlayType")
			.mockReturnValue("probably");
		const load = vi
			.spyOn(HTMLMediaElement.prototype, "load")
			.mockImplementation(() => {});
		try {
			open();
			await waitFor(() =>
				expect(document.querySelector("video")).toHaveAttribute("src", URL_HLS),
			);
			const old = document.querySelector("video") as HTMLVideoElement;
			fireEvent.error(old);
			screen.getByRole("button", { name: "Retry playback" }).focus();
			await userEvent.keyboard("{Enter}");
			await waitFor(() =>
				expect(document.querySelector("video")).toHaveAttribute("src", URL_HLS),
			);
			expect(document.querySelector("video")).not.toBe(old);
			expect(old).not.toHaveAttribute("src");
			expect(load).toHaveBeenCalledTimes(1);
			expect(screen.queryByRole("alert")).toBeNull();
		} finally {
			canPlay.mockRestore();
			load.mockRestore();
		}
	});

	it("falls back to the native element only when MSE is absent", async () => {
		mseSupported = false;
		const canPlay = vi
			.spyOn(HTMLMediaElement.prototype, "canPlayType")
			.mockReturnValue("probably");
		try {
			open();
			await waitFor(() =>
				expect(document.querySelector("video")).toHaveAttribute("src", URL_HLS),
			);
			expect(attached).toEqual([]);
		} finally {
			canPlay.mockRestore();
		}
	});

	it("surfaces a native failure instead of leaving a dead element", async () => {
		// The half that made the live failure invisible: only hls.js errors were
		// reported, so a native `error` event produced nothing on screen.
		mseSupported = false;
		const canPlay = vi
			.spyOn(HTMLMediaElement.prototype, "canPlayType")
			.mockReturnValue("probably");
		try {
			open();
			const el = await waitFor(() => {
				const v = document.querySelector("video");
				if (!v?.getAttribute("src")) {
					throw new Error("not sourced yet");
				}
				return v;
			});
			el.dispatchEvent(new Event("error"));
			expect(await screen.findByRole("alert")).toBeInTheDocument();
			// And it asks the CORS question, because a native failure is exactly as
			// unexplained as an hls.js one.
			await waitFor(() => expect(apiFetch).toHaveBeenCalled());
		} finally {
			canPlay.mockRestore();
		}
	});

	it("reports an explicit unsupported-browser error when neither path works", async () => {
		mseSupported = false;
		const canPlay = vi
			.spyOn(HTMLMediaElement.prototype, "canPlayType")
			.mockReturnValue("");
		try {
			open();
			expect(await screen.findByRole("alert")).toHaveTextContent(
				/HLS.*not supported/i,
			);
			expect(document.querySelector("video")).not.toHaveAttribute("src");
			expect(attached).toEqual([]);
			expect(apiFetch).not.toHaveBeenCalled();
		} finally {
			canPlay.mockRestore();
		}
	});
});

describe("PlaybackSurface — waiting for a live channel's first segment", () => {
	/**
	 * Measured on a real RTMP channel: the manifest 404s for 31.8s after the
	 * channel reaches RUNNING, and another channel took 131.3s. That is a normal
	 * state , so reporting it as a playback failure —
	 * and asking the CORS question about a bucket that is fine — is wrong twice.
	 */
	function openLive() {
		return renderL(
			<PlaybackSurface
				url={URL_HLS}
				kind="HLS"
				autoPlay
				waitForFirstSegment
				diagnose={{ scope: "live", id: JOB, manifestKey: "hls" }}
			/>,
		);
	}

	it("reissues an initial 404 through the real hls.js manifest loader", async () => {
		const { default: Hls } =
			await vi.importActual<typeof import("hls.js")>("hls.js");
		const requests: Array<() => void> = [];
		class OfflineLoader extends Hls.DefaultConfig.loader {
			load(
				context: LoaderContext,
				_config: LoaderConfiguration,
				callbacks: LoaderCallbacks<LoaderContext>,
			) {
				requests.push(() =>
					callbacks.onError(
						{ code: 404, text: "not published" },
						context,
						null,
						this.stats,
					),
				);
			}
		}
		const instance = new Hls({ loader: OfflineLoader, autoStartLoad: false });
		// Only MSE attachment is replaced: the real manifest/error/request path runs.
		vi.spyOn(instance, "attachMedia").mockImplementation(() => {});
		realHls = instance;
		const view = openLive();
		await waitFor(() => expect(requests).toHaveLength(1));
		vi.useFakeTimers();
		act(() => requests[0]?.());
		await act(() => vi.advanceTimersByTimeAsync(5_000));
		expect(requests).toHaveLength(2);
		view.unmount();
	});

	it.each([
		"en",
		"ja",
	] as const)("retries a terminal source only on the operator's action in %s", async (locale) => {
		const props = {
			url: URL_HLS,
			kind: "HLS" as const,
			waitForFirstSegment: true,
			diagnose: { scope: "live" as const, id: JOB, manifestKey: "hls" },
		};
		const view = renderL(<PlaybackSurface {...props} />, locale);
		await waitFor(() => expect(fatal).not.toBeNull());
		const oldError = fatal;
		vi.useFakeTimers();
		act(() => fatal?.());
		await act(() => vi.advanceTimersByTimeAsync(60_000));
		expect(screen.getByRole("alert")).toBeInTheDocument();
		const before = attached.length;
		view.rerender(<PlaybackSurface {...props} />);
		await act(() => vi.advanceTimersByTimeAsync(60_000));
		expect(attached).toHaveLength(before);
		const video = document.querySelector("video");
		await act(async () =>
			fireEvent.click(
				screen.getByRole("button", {
					name: locale === "ja" ? "再生を再試行" : "Retry playback",
				}),
			),
		);
		expect(document.querySelector("video")).not.toBe(video);
		expect(destroyHls).toHaveBeenCalledTimes(1);
		expect(attached).toHaveLength(before + 2);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(apiFetch).toHaveBeenCalledTimes(1);
		act(() => oldError?.({ response: { code: 403 } }));
		expect(screen.queryByRole("alert")).toBeNull();
		act(() => fatal?.());
		await act(() => vi.advanceTimersByTimeAsync(60_000));
		expect(screen.getByRole("alert")).toBeInTheDocument();
		expect(apiFetch).toHaveBeenCalledTimes(2);
	});

	it("reloads the same published manifest after expiry through a fresh real hls.js loader", async () => {
		const { default: Hls } =
			await vi.importActual<typeof import("hls.js")>("hls.js");
		let published = false;
		let requests = 0;
		const responses: Array<() => void> = [];
		const parsed = vi.fn();
		const instances: InstanceType<typeof Hls>[] = [];
		class OfflineLoader extends Hls.DefaultConfig.loader {
			load(
				context: LoaderContext,
				_config: LoaderConfiguration,
				callbacks: LoaderCallbacks<LoaderContext>,
			) {
				requests++;
				responses.push(() => {
					if (published)
						callbacks.onSuccess(
							{
								url: context.url,
								data: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nvideo.m3u8\n",
							},
							this.stats,
							context,
							null,
						);
					else
						callbacks.onError(
							{ code: 404, text: "not published" },
							context,
							null,
							this.stats,
						);
				});
			}
		}
		realHls = () => {
			const hls = new Hls({ loader: OfflineLoader, autoStartLoad: false });
			vi.spyOn(hls, "attachMedia").mockImplementation(() => {});
			vi.spyOn(hls, "destroy");
			hls.on(Hls.Events.MANIFEST_PARSED, parsed);
			instances.push(hls);
			return hls;
		};
		openLive();
		await waitFor(() => expect(requests).toBe(1));
		vi.useFakeTimers();
		act(() => responses[0]?.());
		await act(() => vi.advanceTimersByTimeAsync(60_000));
		expect(screen.getByRole("alert")).toBeInTheDocument();
		published = true;
		const stoppedAt = requests;
		await act(() => vi.advanceTimersByTimeAsync(60_000));
		expect(requests).toBe(stoppedAt);
		await act(async () =>
			fireEvent.click(screen.getByRole("button", { name: "Retry playback" })),
		);
		expect(instances).toHaveLength(2);
		expect(instances[0]?.destroy).toHaveBeenCalledTimes(1);
		expect(requests).toBe(stoppedAt + 1);
		act(() => responses.at(-1)?.());
		expect(parsed).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it.each([
		"ja",
		"en",
	] as const)("reports readiness timeout after a confirmed manifest but no media (%s)", async (locale) => {
		const { default: Hls } =
			await vi.importActual<typeof import("hls.js")>("hls.js");
		const responses: Array<() => void> = [];
		const parsed = vi.fn();
		const media = vi.fn();
		class OfflineLoader extends Hls.DefaultConfig.loader {
			load(
				context: LoaderContext,
				_config: LoaderConfiguration,
				callbacks: LoaderCallbacks<LoaderContext>,
			) {
				const first = responses.length === 0;
				responses.push(() => {
					if (first)
						callbacks.onError(
							{ code: 404, text: "not published" },
							context,
							null,
							this.stats,
						);
					else
						callbacks.onSuccess(
							{
								url: context.url,
								data: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nvideo.m3u8\n",
							},
							this.stats,
							context,
							null,
						);
				});
			}
		}
		const hls = new Hls({ loader: OfflineLoader, autoStartLoad: false });
		vi.spyOn(hls, "attachMedia").mockImplementation(() => {});
		hls.on(Hls.Events.MANIFEST_PARSED, parsed);
		hls.on(Hls.Events.FRAG_LOADED, media);
		realHls = hls;
		renderL(
			<PlaybackSurface url={URL_HLS} kind="HLS" waitForFirstSegment />,
			locale,
		);
		await waitFor(() => expect(responses).toHaveLength(1));
		vi.useFakeTimers();
		act(() => responses[0]?.());
		await act(() => vi.advanceTimersByTimeAsync(5_000));
		act(() => responses[1]?.());
		expect(parsed).toHaveBeenCalledTimes(1);
		expect(media).not.toHaveBeenCalled();
		expect(screen.queryByRole("alert")).toBeNull();
		await act(() => vi.advanceTimersByTimeAsync(55_000));
		expect(screen.getByRole("alert")).toHaveTextContent(
			locale === "ja"
				? "初回の再生準備を時間内に確認できませんでした"
				: "Initial playback readiness could not be confirmed within the wait period",
		);
		expect(media).not.toHaveBeenCalled();
	});

	it("ends the grace on a wall-clock deadline even if the retry is silent", async () => {
		openLive();
		await waitFor(() => expect(fatal).not.toBeNull());
		vi.useFakeTimers();
		act(() => fatal?.());
		await act(() =>
			vi.advanceTimersByTimeAsync(FIRST_SEGMENT_ATTEMPTS * 5_000),
		);
		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.getByRole("alert")).toHaveTextContent(
			/Initial playback readiness could not be confirmed within the wait period/,
		);
		expect(stopHls).toHaveBeenCalled();
		expect(apiFetch).toHaveBeenCalledTimes(1);
	});

	it("coalesces repeated errors and cancels retries when the first media arrives", async () => {
		openLive();
		await waitFor(() => expect(fatal).not.toBeNull());
		vi.useFakeTimers();
		act(() => {
			fatal?.();
			fatal?.();
			fatal?.();
		});
		await act(() => vi.advanceTimersByTimeAsync(5_000));
		expect(attached.filter((entry) => entry.startsWith("load:"))).toHaveLength(
			2,
		);
		act(() => {
			fatal?.();
			fragmentLoaded?.();
		});
		await act(() => vi.advanceTimersByTimeAsync(65_000));
		expect(attached.filter((entry) => entry.startsWith("load:"))).toHaveLength(
			2,
		);
		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(apiFetch).not.toHaveBeenCalled();
	});

	it.each([
		"fragLoadError",
		"manifestLoadError",
	])("does not call a later %s failure the first segment wait", async (details) => {
		openLive();
		await waitFor(() => expect(fatal).not.toBeNull());
		act(() => {
			fragmentLoaded?.();
			fatal?.({ details });
		});
		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.getByRole("alert")).toHaveTextContent(/HLS playback failed/);
	});

	it.each([
		403,
		0,
		undefined,
	])("does not call HTTP %s proof of an unpublished manifest", async (code) => {
		openLive();
		await waitFor(() => expect(fatal).not.toBeNull());
		act(() => fatal?.({ response: { code } }));
		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.getByRole("alert")).toHaveTextContent(
			code === 403 ? en.playback.accessDenied : "HLS playback failed",
		);
	});

	it.each([
		["ja", "deadline"],
		["en", "deadline"],
		["ja", "attempts"],
		["en", "attempts"],
	] as const)("initial 404 exhaustion explains unconfirmed readiness, not a proven network fault (%s/%s)", async (locale, bound) => {
		renderL(
			<PlaybackSurface url={URL_HLS} kind="HLS" waitForFirstSegment />,
			locale,
		);
		await waitFor(() => expect(fatal).not.toBeNull());
		vi.useFakeTimers();
		if (bound === "attempts") {
			// Make the deadline callback silent to independently exercise the count guard.
			const schedule = globalThis.setTimeout;
			vi.spyOn(globalThis, "setTimeout").mockImplementation(
				(callback, delay, ...args) =>
					schedule(
						delay === FIRST_SEGMENT_ATTEMPTS * 5_000 ? () => {} : callback,
						delay,
						...args,
					),
			);
		}
		act(() => fatal?.());
		if (bound === "deadline")
			await act(() => vi.advanceTimersByTimeAsync(60_000));
		else
			for (let i = 0; i < FIRST_SEGMENT_ATTEMPTS; i++) {
				await act(() => vi.advanceTimersByTimeAsync(5_000));
				act(() => fatal?.());
			}
		expect(screen.getByRole("alert")).toHaveTextContent(
			locale === "ja"
				? /初回の再生準備を時間内に確認できませんでした/
				: /Initial playback readiness could not be confirmed within the wait period/,
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			locale === "ja"
				? /入力の送出と公開バッファーを確認/
				: /Check the input feed and publication buffer/,
		);
		expect(
			screen.getByRole("button", {
				name: locale === "ja" ? "再生を再試行" : "Retry playback",
			}),
		).toBeEnabled();
		const loads = attached.length;
		await act(() => vi.advanceTimersByTimeAsync(120_000));
		expect(attached).toHaveLength(loads);
	});

	it("cancels pending retry and deadline on unmount", async () => {
		const view = openLive();
		await waitFor(() => expect(fatal).not.toBeNull());
		vi.useFakeTimers();
		act(() => fatal?.());
		view.unmount();
		await act(() => vi.advanceTimersByTimeAsync(65_000));
		expect(attached.filter((entry) => entry.startsWith("load:"))).toHaveLength(
			1,
		);
		expect(apiFetch).not.toHaveBeenCalled();
	});

	it("does not let an old source retry, fail, or clear the new source's wait", async () => {
		const view = openLive();
		await waitFor(() => expect(fatal).not.toBeNull());
		const oldError = fatal;
		const oldFragment = fragmentLoaded;
		vi.useFakeTimers();
		act(() => oldError?.());
		view.rerender(
			<PlaybackSurface
				url={`${URL_HLS}?next`}
				kind="HLS"
				waitForFirstSegment
			/>,
		);
		await act(async () => {});
		act(() => {
			fatal?.();
			oldFragment?.();
			oldError?.({ response: { code: 403 } });
		});
		expect(screen.getByRole("status")).toBeInTheDocument();
		await act(() => vi.advanceTimersByTimeAsync(5_000));
		expect(
			attached.filter((entry) => entry === `load:${URL_HLS}`),
		).toHaveLength(1);
		expect(
			attached.filter((entry) => entry === `load:${URL_HLS}?next`),
		).toHaveLength(2);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps a terminal timeout terminal despite late media and ignores nonfatal retries", async () => {
		openLive();
		await waitFor(() => expect(fatal).not.toBeNull());
		vi.useFakeTimers();
		act(() => fatal?.({ fatal: false }));
		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
		act(() => fatal?.());
		await act(() =>
			vi.advanceTimersByTimeAsync(FIRST_SEGMENT_ATTEMPTS * 5_000),
		);
		act(() => {
			fragmentLoaded?.();
			fatal?.();
		});
		await act(() => vi.advanceTimersByTimeAsync(5_000));
		expect(screen.getByRole("alert")).toBeInTheDocument();
		expect(screen.queryByRole("status")).toBeNull();
		expect(apiFetch).toHaveBeenCalledTimes(1);
		expect(attached.filter((entry) => entry.startsWith("load:"))).toHaveLength(
			2,
		);
	});

	it("says it is waiting instead of reporting an error", async () => {
		openLive();
		await waitFor(() => expect(fatal).not.toBeNull());
		fatal?.();

		expect(await screen.findByRole("status")).toHaveTextContent(
			/Waiting for the channel's first segment/,
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("does not ask the CORS question while it is only waiting", async () => {
		// The bucket is fine; the encoder has simply not written a segment. A
		// diagnosis here would blame storage for a timing state.
		openLive();
		await waitFor(() => expect(fatal).not.toBeNull());
		fatal?.();
		await screen.findByRole("status");
		expect(apiFetch).not.toHaveBeenCalled();
	});

	it("gives up after a bounded number of attempts and reports the failure", async () => {
		openLive();
		await waitFor(() => expect(fatal).not.toBeNull());
		vi.useFakeTimers();
		for (let i = 0; i < FIRST_SEGMENT_ATTEMPTS; i += 1) {
			act(() => fatal?.());
			await act(() => vi.advanceTimersByTimeAsync(5_000));
		}
		expect(screen.getByRole("alert")).toBeInTheDocument();
		expect(apiFetch).toHaveBeenCalledTimes(1);
	});

	it("still reports a VOD failure immediately — the grace is live-only", async () => {
		open();
		await waitFor(() => expect(fatal).not.toBeNull());
		fatal?.();
		expect(await screen.findByRole("alert")).toBeInTheDocument();
		expect(screen.queryByRole("status")).toBeNull();
	});
});

describe("PlaybackSurface — survives a parent re-render", () => {
	/**
	 * The job page polls every 5s while RUNNING and the channel page every 15s
	 * while active — the only two states in which this panel shows a *moving*
	 * source. Both callers pass `diagnose` as a JSX object literal, so every poll
	 * re-rendered the parent with a new object; when that object was in the
	 * effect's dependency chain the player was destroyed and rebuilt each time,
	 * restarting VOD from zero and re-joining the live edge, and resetting the
	 * one-diagnosis guard so `GetBucketCors` re-fired per poll.
	 *
	 * No test in this suite re-rendered a mounted player before, which is exactly
	 * why it shipped.
	 */
	it("does not rebuild hls.js when the parent re-renders with equal props", async () => {
		const props = {
			url: URL_HLS,
			kind: "HLS" as const,
			autoPlay: true,
			diagnose: { scope: "vod" as const, id: JOB, manifestKey: "hls" },
		};
		const { rerender } = renderL(<PlaybackSurface {...props} />);
		await waitFor(() =>
			expect(attached).toEqual([`load:${URL_HLS}`, "attach:VIDEO"]),
		);

		// A NEW object literal each time, exactly as the callers write it.
		for (let i = 0; i < 3; i += 1) {
			rerender(
				<PlaybackSurface
					{...props}
					diagnose={{ scope: "vod", id: JOB, manifestKey: "hls" }}
				/>,
			);
		}
		// Still one load + one attach: no destroy/reconstruct cycle.
		expect(attached).toEqual([`load:${URL_HLS}`, "attach:VIDEO"]);
	});

	it("keeps the one-diagnosis guard across re-renders", async () => {
		apiFetch.mockResolvedValue({
			supported: true,
			origin: "o",
			bucket: "b",
			verdict: { code: "NO_RULES" },
		});
		const { rerender } = renderL(
			<PlaybackSurface
				url={URL_HLS}
				kind="HLS"
				autoPlay
				diagnose={{ scope: "vod", id: JOB, manifestKey: "hls" }}
			/>,
		);
		await waitFor(() => expect(fatal).not.toBeNull());
		fatal?.();
		await screen.findByText(/no CORS configuration/);
		rerender(
			<PlaybackSurface
				url={URL_HLS}
				kind="HLS"
				autoPlay
				diagnose={{ scope: "vod", id: JOB, manifestKey: "hls" }}
			/>,
		);
		fatal?.();
		// One outbound GetBucketCors — each one is a credential decrypt plus an S3
		// call, and the job page would otherwise issue one per 5s poll.
		expect(apiFetch).toHaveBeenCalledTimes(1);
	});

	it("DOES rebuild when the source actually changes", async () => {
		// The control: stability must not become staleness.
		const { rerender } = renderL(
			<PlaybackSurface url={URL_HLS} kind="HLS" autoPlay />,
		);
		await waitFor(() =>
			expect(attached).toEqual([`load:${URL_HLS}`, "attach:VIDEO"]),
		);
		const other = "https://out.s3.eu-west-1.amazonaws.com/o/other.m3u8";
		rerender(<PlaybackSurface url={other} kind="HLS" autoPlay />);
		await waitFor(() =>
			expect(attached).toEqual([
				`load:${URL_HLS}`,
				"attach:VIDEO",
				`load:${other}`,
				"attach:VIDEO",
			]),
		);
	});
});

describe("PlaybackSurface — implicating vs merely informative", () => {
	/**
	 * `implicated` decides whether a CORS note reads as THE CAUSE (amber) or as
	 * context (grey). Nothing asserted it, so flipping any value shipped green —
	 * "CORS is not the cause" could have rendered as an alarm, and
	 * `DECLARED_BASE` ("we cannot see the host that matters") could have been
	 * presented as the fault. Both directions are pinned here, and by their
	 * DIFFERENCE rather than by a literal colour, so a palette change does not
	 * break the test while a flattened flag does.
	 */
	async function classOfDiagnosis(result: unknown): Promise<string> {
		apiFetch.mockResolvedValue(result);
		const { unmount } = renderL(
			<PlaybackSurface
				url={URL_HLS}
				kind="HLS"
				autoPlay
				diagnose={{ scope: "vod", id: JOB, manifestKey: "hls" }}
			/>,
		);
		await waitFor(() => expect(fatal).not.toBeNull());
		fatal?.();
		const heading = await screen.findByText("Playback prerequisites");
		const note = heading.parentElement?.querySelector("p:last-of-type");
		const className = note?.className ?? "";
		unmount();
		return className;
	}

	it("marks a real fault differently from a withheld answer", async () => {
		const fault = await classOfDiagnosis({
			supported: true,
			origin: "o",
			bucket: "b",
			verdict: { code: "NO_RULES" },
		});
		const withheld = await classOfDiagnosis({
			supported: false,
			origin: "o",
			reason: "DECLARED_BASE",
		});
		expect(fault).not.toBe(withheld);
		// And specifically: the withheld answer must not be styled as the cause.
		expect(fault).toContain("amber");
		expect(withheld).not.toContain("amber");
	});

	it("does not style 'CORS is ruled out' as an alarm either", async () => {
		const ok = await classOfDiagnosis({
			supported: true,
			origin: "o",
			bucket: "b",
			verdict: { code: "OK" },
		});
		expect(ok).not.toContain("amber");
	});

	it("does not style missing exposed headers as causal for open-source HLS", async () => {
		const missing = await classOfDiagnosis({
			supported: true,
			origin: "o",
			bucket: "b",
			verdict: {
				code: "MISSING_EXPOSE_HEADERS",
				headers: ["content-range"],
			},
		});
		expect(missing).not.toContain("amber");
	});
});

/**
 * : the Bitmovin Player branch. jsdom has no MSE and no real
 * player — the module is mocked; what is under test is the BRANCH DECISION
 * (which element renders, which library initializes, with which key) and
 * the licence-refusal surface (§4.4: the failure is opaque by default and
 * must be said in words).
 */
const bitmovinCalls: { key?: string; loaded?: unknown; ui?: boolean }[] = [];
const bitmovinSeek = vi.fn((_seconds: number) => true);
let bitmovinError:
	| ((event: { code?: number; name?: string; data?: unknown }) => void)
	| null = null;
let bitmovinTime: ((event: { time: number }) => void) | null = null;
let uiBuilt = 0;
let uiReleased = 0;
let playerDestroyed = 0;
/** When set, the fake player's load waits on it — an unmount mid-load. */
let loadGate: Promise<void> | null = null;
let bitmovinLoadError: unknown;
vi.mock("bitmovin-player-ui", () => ({
	UIFactory: {
		buildUI: () => {
			uiBuilt += 1;
			return {
				release: () => {
					uiReleased += 1;
				},
			};
		},
	},
}));
vi.mock("bitmovin-player", () => {
	class Player {
		config: { key?: string; ui?: boolean };
		constructor(_el: HTMLElement, config: { key?: string; ui?: boolean }) {
			this.config = config;
			bitmovinCalls.push({ key: config.key, ui: config.ui });
		}
		on(
			event: string,
			cb: (event: { code?: number; name?: string; time: number }) => void,
		) {
			if (event === "error") bitmovinError = cb as typeof bitmovinError;
			if (event === "timechanged") bitmovinTime = cb;
		}
		off(event: string) {
			if (event === "timechanged") bitmovinTime = null;
		}
		seek(seconds: number) {
			return bitmovinSeek(seconds);
		}
		async load(source: unknown) {
			const last = bitmovinCalls[bitmovinCalls.length - 1];
			if (last) {
				last.loaded = source;
			}
			if (loadGate) {
				await loadGate;
			}
			if (bitmovinLoadError !== undefined) throw bitmovinLoadError;
		}
		async destroy() {
			playerDestroyed += 1;
		}
	}
	return {
		Player,
		PlayerEvent: { Error: "error", TimeChanged: "timechanged" },
	};
});

describe("PlaybackSurface — open-source mode has no Analytics adapter", () => {
	it("does not initialize Analytics in open-source mode even with a stale client key", async () => {
		renderL(
			<PlaybackSurface
				url="https://cdn/master.m3u8"
				kind="HLS"
				player={{ provider: "native", analyticsLicenseKey: "ak-1" } as never}
				analyticsMeta={{ videoId: "enc-9", title: "job", customData5: "job-1" }}
			/>,
		);
		await waitFor(() =>
			expect(attached.some((entry) => entry.startsWith("load:"))).toBe(true),
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("collects NOTHING without a key — QA impressions need explicit opt-in", async () => {
		renderL(
			<PlaybackSurface
				url="https://cdn/master.m3u8"
				kind="HLS"
				analyticsMeta={{ videoId: "enc-9" }}
			/>,
		);
		await waitFor(() =>
			expect(attached.some((a) => a.startsWith("load:"))).toBe(true),
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

describe("PlaybackSurface — Shaka Player for DASH", () => {
	const DASH_URL = "https://cdn.example.com/live.mpd";
	const manifest404 = () => ({
		code: 1001,
		data: [DASH_URL, 404, "", {}, 0, DASH_URL],
	});
	const segment404 = () => ({
		code: 1001,
		data: ["https://cdn.example.com/segment.m4s", 404, "", {}, 1],
	});

	it("destroys a failed DASH player and reloads on explicit retry", async () => {
		shakaLoadOutcomes.push({ code: 1001 });
		renderL(<PlaybackSurface url={DASH_URL} kind="DASH" />);
		await screen.findByRole("alert");
		fireEvent.click(screen.getByRole("button", { name: "Retry playback" }));
		await waitFor(() => expect(shakaCalls.loaded).toHaveLength(2));
		expect(shakaCalls.destroyed).toBe(1);
		expect(shakaCalls.loaded[1]?.[0]).toBe(DASH_URL);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("routes DASH by manifest kind and disables CMCD/CMSD", async () => {
		renderL(
			<PlaybackSurface
				url="https://cdn.example.com/extensionless?id=dash"
				kind="DASH"
				player={{ provider: "native" }}
			/>,
		);

		await waitFor(() => expect(shakaCalls.loaded).toHaveLength(1));
		expect(shakaCalls.installed).toBe(1);
		expect(shakaCalls.attached).toEqual(["VIDEO"]);
		expect(shakaCalls.configured).toEqual([
			{
				cmcd: { enabled: false, eventTargets: [] },
				cmsd: { enabled: false },
			},
		]);
		expect(shakaCalls.loaded[0]).toEqual([
			"https://cdn.example.com/extensionless?id=dash",
			null,
			"application/dash+xml",
		]);
	});

	it("reports an explicit error when Shaka says the browser is unsupported", async () => {
		shakaSupported = false;
		renderL(
			<PlaybackSurface url="https://cdn.example.com/video.mpd" kind="DASH" />,
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/DASH playback is not supported/,
		);
		expect(shakaCalls.installed).toBe(1);
		expect(shakaCalls.loaded).toHaveLength(0);
	});

	it("surfaces Shaka error events and runs the bounded diagnosis once", async () => {
		apiFetch.mockResolvedValue({
			supported: false,
			origin: "http://localhost:3100",
			reason: "DRIVER",
		});
		renderL(
			<PlaybackSurface
				url="https://cdn.example.com/video.mpd"
				kind="DASH"
				diagnose={{ scope: "vod", id: JOB, manifestKey: "dash" }}
			/>,
		);
		await waitFor(() => expect(shakaErrorListener).not.toBeNull());

		act(() => {
			shakaErrorListener?.({ detail: { code: 4001, data: [] } });
		});
		expect(await screen.findByRole("alert")).toBeInTheDocument();
		await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
		act(() => {
			shakaErrorListener?.({ detail: { code: 4001, data: [] } });
		});
		expect(apiFetch).toHaveBeenCalledTimes(1);
	});

	it("shows a recoverable live DASH error until a segment append proves recovery", async () => {
		apiFetch.mockResolvedValue({
			supported: false,
			origin: "http://localhost:3100",
			reason: "DRIVER",
		});
		let releaseLoad = () => {};
		shakaLoadGate = new Promise<void>((resolve) => {
			releaseLoad = resolve;
		});
		renderL(
			<PlaybackSurface
				url={DASH_URL}
				kind="DASH"
				waitForFirstSegment
				diagnose={{ scope: "live", id: JOB, manifestKey: "dash" }}
			/>,
		);
		await waitFor(() => expect(shakaCalls.loaded).toHaveLength(1));
		await act(async () => {
			releaseLoad();
			await shakaLoadGate;
			await Promise.resolve();
		});

		vi.useFakeTimers();
		try {
			act(() => {
				shakaErrorListener?.({
					detail: { ...manifest404(), severity: 1 },
				});
			});

			expect(screen.queryByRole("alert")).toBeNull();
			expect(screen.getByRole("status")).toHaveTextContent(
				/Shaka Player is retrying automatically/,
			);
			expect(apiFetch).not.toHaveBeenCalled();

			act(() => {
				shakaSegmentAppendedListener?.({ contentType: "text" });
			});
			expect(screen.getByRole("status")).toBeInTheDocument();
			act(() => {
				shakaSegmentAppendedListener?.({ contentType: "audio" });
			});
			expect(screen.getByRole("status")).toBeInTheDocument();
			act(() => {
				shakaErrorListener?.({
					detail: { ...segment404(), severity: 1 },
				});
			});
			act(() => {
				shakaSegmentAppendedListener?.({ contentType: "video" });
			});
			expect(screen.getByRole("status")).toBeInTheDocument();
			act(() => {
				shakaSegmentAppendedListener?.({ contentType: "audio" });
			});
			expect(screen.queryByRole("status")).toBeNull();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(SHAKA_RECOVERY_STALL_MS);
			});
			expect(apiFetch).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		{
			name: "audio-only",
			track: { active: true, audioId: 1, videoId: null },
			appended: { contentType: "audio" },
		},
		{
			name: "muxed audio/video",
			track: { active: true, audioId: 1, videoId: 2 },
			appended: { contentType: "video", isMuxed: true },
		},
	])("accepts one append as recovery for $name output", async ({
		track,
		appended,
	}) => {
		shakaVariantTracks.splice(0, shakaVariantTracks.length, track);
		renderL(<PlaybackSurface url={DASH_URL} kind="DASH" />);
		await waitFor(() => expect(shakaCalls.loaded).toHaveLength(1));

		act(() => {
			shakaErrorListener?.({
				detail: { ...segment404(), severity: 1 },
			});
		});
		expect(screen.getByRole("status")).toBeInTheDocument();
		act(() => {
			shakaSegmentAppendedListener?.(appended);
		});
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("does not slide the recovery deadline and discards a stale diagnosis after recovery", async () => {
		let resolveDiagnosis: (value: unknown) => void = () => {};
		apiFetch.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveDiagnosis = resolve;
				}),
		);
		renderL(
			<PlaybackSurface
				url={DASH_URL}
				kind="DASH"
				diagnose={{ scope: "live", id: JOB, manifestKey: "dash" }}
			/>,
		);
		await waitFor(() => expect(shakaCalls.loaded).toHaveLength(1));

		vi.useFakeTimers();
		try {
			act(() => {
				shakaErrorListener?.({
					detail: { ...segment404(), severity: 1 },
				});
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(SHAKA_RECOVERY_STALL_MS / 2);
			});
			act(() => {
				shakaErrorListener?.({
					detail: { ...segment404(), severity: 1 },
				});
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(SHAKA_RECOVERY_STALL_MS / 2);
			});

			expect(screen.getByRole("status")).toHaveTextContent(
				/has not recovered after 60 seconds/,
			);
			expect(apiFetch).toHaveBeenCalledTimes(1);

			act(() => {
				shakaSegmentAppendedListener?.({ contentType: "audio" });
			});
			expect(screen.getByRole("status")).toBeInTheDocument();
			act(() => {
				shakaSegmentAppendedListener?.({ contentType: "video" });
			});
			expect(screen.queryByRole("status")).toBeNull();
			await act(async () => {
				resolveDiagnosis({
					supported: true,
					origin: "http://localhost:3100",
					bucket: "out",
					verdict: { code: "NO_RULES" },
				});
				await Promise.resolve();
			});
			expect(screen.queryByText("Playback prerequisites")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("preserves one stall diagnosis when the same recovery becomes critical", async () => {
		let resolveDiagnosis: (value: unknown) => void = () => {};
		apiFetch.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveDiagnosis = resolve;
				}),
		);
		renderL(
			<PlaybackSurface
				url={DASH_URL}
				kind="DASH"
				diagnose={{ scope: "live", id: JOB, manifestKey: "dash" }}
			/>,
		);
		await waitFor(() => expect(shakaCalls.loaded).toHaveLength(1));

		vi.useFakeTimers();
		try {
			act(() => {
				shakaErrorListener?.({
					detail: { ...segment404(), severity: 1 },
				});
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(SHAKA_RECOVERY_STALL_MS);
			});
			expect(apiFetch).toHaveBeenCalledTimes(1);

			act(() => {
				shakaErrorListener?.({
					detail: { ...segment404(), severity: 2 },
				});
			});
			expect(screen.getByRole("alert")).toBeInTheDocument();
			expect(screen.queryByRole("status")).toBeNull();
			expect(apiFetch).toHaveBeenCalledTimes(1);

			await act(async () => {
				resolveDiagnosis({
					supported: true,
					origin: "http://localhost:3100",
					bucket: "out",
					verdict: { code: "NO_RULES" },
				});
				await Promise.resolve();
			});
			expect(screen.getByText("Playback prerequisites")).toBeInTheDocument();
			expect(apiFetch).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears retry status when a recoverable error becomes critical", async () => {
		apiFetch.mockResolvedValue({
			supported: false,
			origin: "http://localhost:3100",
			reason: "DRIVER",
		});
		renderL(
			<PlaybackSurface
				url={DASH_URL}
				kind="DASH"
				diagnose={{ scope: "live", id: JOB, manifestKey: "dash" }}
			/>,
		);
		await waitFor(() => expect(shakaCalls.loaded).toHaveLength(1));

		act(() => {
			shakaErrorListener?.({
				detail: { ...segment404(), severity: 1 },
			});
		});
		expect(screen.getByRole("status")).toBeInTheDocument();

		act(() => {
			shakaErrorListener?.({
				detail: { ...segment404(), severity: 2 },
			});
		});
		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.getByRole("alert")).toBeInTheDocument();
		await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
	});

	it("surfaces a critical manifest 404 after the initial live DASH load", async () => {
		apiFetch.mockResolvedValue({
			supported: false,
			origin: "http://localhost:3100",
			reason: "DRIVER",
		});
		let releaseLoad = () => {};
		shakaLoadGate = new Promise<void>((resolve) => {
			releaseLoad = resolve;
		});
		renderL(
			<PlaybackSurface
				url={DASH_URL}
				kind="DASH"
				waitForFirstSegment
				diagnose={{ scope: "live", id: JOB, manifestKey: "dash" }}
			/>,
		);
		await waitFor(() => expect(shakaCalls.loaded).toHaveLength(1));
		await act(async () => {
			releaseLoad();
			await shakaLoadGate;
			await Promise.resolve();
		});

		act(() => {
			shakaErrorListener?.({
				detail: { ...manifest404(), severity: 2 },
			});
		});

		expect(await screen.findByRole("alert")).toBeInTheDocument();
		expect(screen.queryByRole("status")).toBeNull();
		await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
	});

	it("does not hide a segment 404 while the initial manifest is loading", async () => {
		apiFetch.mockResolvedValue({
			supported: false,
			origin: "http://localhost:3100",
			reason: "DRIVER",
		});
		let releaseLoad = () => {};
		shakaLoadGate = new Promise<void>((resolve) => {
			releaseLoad = resolve;
		});
		const view = renderL(
			<PlaybackSurface
				url={DASH_URL}
				kind="DASH"
				waitForFirstSegment
				diagnose={{ scope: "live", id: JOB, manifestKey: "dash" }}
			/>,
		);
		await waitFor(() => expect(shakaCalls.loaded).toHaveLength(1));

		act(() => {
			shakaErrorListener?.({ detail: segment404() });
		});

		expect(await screen.findByRole("alert")).toBeInTheDocument();
		await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
		releaseLoad();
		view.unmount();
	});

	it("destroys a Shaka instance when unmounted during load", async () => {
		let releaseLoad = () => {};
		shakaLoadGate = new Promise<void>((resolve) => {
			releaseLoad = resolve;
		});
		const view = renderL(
			<PlaybackSurface
				url="https://cdn.example.com/live.mpd"
				kind="DASH"
				player={{ provider: "native" }}
			/>,
		);
		await waitFor(() => expect(shakaCalls.loaded).toHaveLength(1));
		view.unmount();
		releaseLoad();
		await waitFor(() => expect(shakaCalls.destroyed).toBe(1));
	});

	it("retries a live DASH manifest 404 and clears waiting after it appears", async () => {
		shakaLoadOutcomes.push(manifest404());
		let releaseLoad = () => {};
		shakaLoadGate = new Promise<void>((resolve) => {
			releaseLoad = resolve;
		});
		const view = renderL(
			<PlaybackSurface
				url={DASH_URL}
				kind="DASH"
				waitForFirstSegment
				diagnose={{ scope: "live", id: JOB, manifestKey: "dash" }}
			/>,
		);
		await waitFor(() => expect(shakaCalls.loaded).toHaveLength(1));
		vi.useFakeTimers();
		try {
			await act(async () => {
				releaseLoad();
				await Promise.resolve();
				await Promise.resolve();
			});
			expect(screen.getByRole("status")).toHaveTextContent(
				/Waiting for the channel's first segment/,
			);
			expect(apiFetch).not.toHaveBeenCalled();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(5_000);
			});
			expect(shakaCalls.loaded).toHaveLength(2);
			expect(screen.queryByRole("status")).toBeNull();
			expect(screen.queryByRole("alert")).toBeNull();
			expect(apiFetch).not.toHaveBeenCalled();
		} finally {
			view.unmount();
			vi.useRealTimers();
		}
	});

	it("ends live DASH grace at the bound and diagnoses the final 404", async () => {
		apiFetch.mockResolvedValue({
			supported: false,
			origin: "http://localhost:3100",
			reason: "DRIVER",
		});
		shakaLoadOutcomes.push(
			...Array.from({ length: FIRST_SEGMENT_ATTEMPTS + 1 }, manifest404),
		);
		let releaseLoad = () => {};
		shakaLoadGate = new Promise<void>((resolve) => {
			releaseLoad = resolve;
		});
		const view = renderL(
			<PlaybackSurface
				url={DASH_URL}
				kind="DASH"
				waitForFirstSegment
				diagnose={{ scope: "live", id: JOB, manifestKey: "dash" }}
			/>,
		);
		await waitFor(() => expect(shakaCalls.loaded).toHaveLength(1));
		vi.useFakeTimers();
		try {
			await act(async () => {
				releaseLoad();
				await Promise.resolve();
				await Promise.resolve();
			});
			for (let retry = 0; retry < FIRST_SEGMENT_ATTEMPTS; retry += 1) {
				await act(async () => {
					await vi.advanceTimersByTimeAsync(5_000);
				});
			}

			expect(shakaCalls.loaded).toHaveLength(FIRST_SEGMENT_ATTEMPTS + 1);
			expect(screen.getByRole("alert")).toBeInTheDocument();
			expect(screen.queryByRole("status")).toBeNull();
			expect(apiFetch).toHaveBeenCalledWith(
				`/api/live-channels/${JOB}/playback-cors?manifestKey=dash`,
			);
		} finally {
			view.unmount();
			vi.useRealTimers();
		}
	});
});

describe("PlaybackSurface — the Bitmovin Player branch (ledger #59)", () => {
	beforeEach(() => {
		bitmovinCalls.length = 0;
		bitmovinError = null;
	});

	it("without a player config the open-source video surface renders", () => {
		renderL(<PlaybackSurface url="https://cdn/master.m3u8" kind="HLS" />);
		expect(document.querySelector("video")).not.toBeNull();
		expect(
			screen.queryByTestId("bitmovin-player-container"),
		).not.toBeInTheDocument();
		expect(bitmovinCalls).toHaveLength(0);
	});

	it("a bitmovin config renders the container, keys the player, loads the source", async () => {
		renderL(
			<PlaybackSurface
				url="https://cdn/master.m3u8"
				kind="HLS"
				player={{ provider: "bitmovin", playerLicenseKey: "pk-live" }}
			/>,
		);
		expect(screen.getByTestId("bitmovin-player-container")).toBeInTheDocument();
		// The native element must NOT also mount — two players, one stream.
		expect(document.querySelector("video")).toBeNull();
		await waitFor(() => expect(bitmovinCalls).toHaveLength(1));
		expect(bitmovinCalls[0]?.key).toBe("pk-live");
		await waitFor(() =>
			expect(bitmovinCalls[0]?.loaded).toEqual({
				hls: "https://cdn/master.m3u8",
			}),
		);
	});

	it("a licence refusal is SAID — domain not authorised, not a broken stream", async () => {
		renderL(
			<PlaybackSurface
				url="https://cdn/master.m3u8"
				kind="HLS"
				player={{ provider: "bitmovin", playerLicenseKey: "pk-live" }}
			/>,
		);
		await waitFor(() => expect(bitmovinError).not.toBeNull());
		bitmovinError?.({ code: 1016, name: "LICENSE_ERROR" });
		expect(
			await screen.findByText(/this domain is not authorised/),
		).toBeInTheDocument();
	});

	it("a stale analytics-only open-source config initializes no Bitmovin services", () => {
		renderL(
			<PlaybackSurface
				url="https://cdn/master.m3u8"
				kind="HLS"
				player={{ provider: "native", analyticsLicenseKey: "ak" } as never}
			/>,
		);
		expect(document.querySelector("video")).not.toBeNull();
		expect(bitmovinCalls).toHaveLength(0);
	});

	it("tells the player NOT to load its own skin and builds it from the UI package instead (ledger #212)", async () => {
		// left to itself the player fetched
		// `bitmovinplayer-ui.js` / `.css` from beside its script — a 404 under
		// Next's chunk path on every deployment, i.e. a player with no controls.
		uiBuilt = 0;
		uiReleased = 0;
		const view = renderL(
			<PlaybackSurface
				url="https://cdn/master.m3u8"
				kind="HLS"
				player={{ provider: "bitmovin", playerLicenseKey: "pk-live" }}
			/>,
		);
		await waitFor(() => expect(bitmovinCalls).toHaveLength(1));
		expect(bitmovinCalls[0]?.ui).toBe(false);
		await waitFor(() => expect(uiBuilt).toBe(1));
		view.unmount();
		await waitFor(() => expect(uiReleased).toBe(1));
	});

	it("an unmount DURING load() still releases the skin and destroys the player (review-330)", async () => {
		// Player and skin are built before load; the effect's cleanup is
		// reassigned to the real teardown only after load resolves. An
		// unmount in between ran the no-op — both leaked, and the mid-load
		// window is exactly what the arm above cannot see (its load resolves
		// at once).
		uiBuilt = 0;
		uiReleased = 0;
		playerDestroyed = 0;
		let releaseLoad = () => {};
		loadGate = new Promise<void>((resolve) => {
			releaseLoad = resolve;
		});
		try {
			const view = renderL(
				<PlaybackSurface
					url="https://cdn/master.m3u8"
					kind="HLS"
					player={{ provider: "bitmovin", playerLicenseKey: "pk-live" }}
				/>,
			);
			await waitFor(() => expect(uiBuilt).toBe(1));
			view.unmount();
			// Nothing to release yet — load is still in flight.
			expect(uiReleased).toBe(0);
			expect(playerDestroyed).toBe(0);
			releaseLoad();
			await waitFor(() => expect(uiReleased).toBe(1));
			await waitFor(() => expect(playerDestroyed).toBe(1));
		} finally {
			loadGate = null;
		}
	});
});

describe("PlaybackSurface progressive MP4", () => {
	it("loads a native MP4, applies scene seeking and releases the source", async () => {
		const load = vi
			.spyOn(HTMLMediaElement.prototype, "load")
			.mockImplementation(() => {});
		const url = "https://media.test/video.mp4";
		const view = renderL(
			<PlaybackSurface
				url={url}
				kind="MP4"
				seekRequest={{ seconds: 4, requestId: 1 }}
			/>,
		);
		await waitFor(() =>
			expect(document.querySelector("video")).toHaveAttribute("src", url),
		);
		const video = document.querySelector("video") as HTMLVideoElement;
		Object.defineProperties(video, {
			readyState: { value: 1 },
			duration: { value: 10 },
		});
		fireEvent.loadedMetadata(video);
		expect(video.currentTime).toBe(4);
		expect(attached).toEqual([]);
		expect(shakaCalls.loaded).toEqual([]);
		view.unmount();
		expect(video).not.toHaveAttribute("src");
		expect(load).toHaveBeenCalled();
		load.mockRestore();
	});
	it("reports MP4 media failure without calling it HLS and allows retry", async () => {
		const load = vi
			.spyOn(HTMLMediaElement.prototype, "load")
			.mockImplementation(() => {});
		renderL(<PlaybackSurface url="https://media.test/broken.mp4" kind="MP4" />);
		const old = document.querySelector("video") as HTMLVideoElement;
		await waitFor(() => expect(old).toHaveAttribute("src"));
		fireEvent.error(old);
		expect(screen.getByRole("alert")).not.toHaveTextContent("HLS");
		fireEvent.click(screen.getByRole("button", { name: "Retry playback" }));
		await waitFor(() => expect(document.querySelector("video")).not.toBe(old));
		expect(old).not.toHaveAttribute("src");
		expect(apiFetch).not.toHaveBeenCalled();
		load.mockRestore();
	});
	it("uses a progressive MP4 source with Bitmovin Player", async () => {
		bitmovinCalls.length = 0;
		renderL(
			<PlaybackSurface
				url="https://media.test/video.mp4"
				kind="MP4"
				player={{ provider: "bitmovin", playerLicenseKey: "pk" }}
			/>,
		);
		await waitFor(() =>
			expect(bitmovinCalls[0]?.loaded).toEqual({
				progressive: [
					{ url: "https://media.test/video.mp4", type: "video/mp4" },
				],
			}),
		);
	});
	it.each([
		"error callback",
		"load rejection",
	])("ignores a canceled Bitmovin MP4 %s after switching sources during load", async (failure) => {
		bitmovinCalls.length = 0;
		bitmovinError = null;
		playerDestroyed = 0;
		uiReleased = 0;
		let rejectOldLoad: (error: Error) => void = () => {};
		loadGate = new Promise<void>((_resolve, reject) => {
			rejectOldLoad = reject;
		});
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				Response.json(
					{ details: { code: "MEDIA_FILE_NOT_FOUND" } },
					{ status: 404 },
				),
			);
		try {
			const oldUrl = `/api/library/sources/${JOB}/media?key=mp4%3Aold`;
			const newUrl = `/api/library/sources/${JOB}/media?key=mp4%3Anew`;
			const player = { provider: "bitmovin" as const, playerLicenseKey: "pk" };
			const view = renderL(
				<PlaybackSurface url={oldUrl} kind="MP4" player={player} />,
			);
			await waitFor(() =>
				expect(bitmovinCalls[0]?.loaded).toEqual({
					progressive: [{ url: oldUrl, type: "video/mp4" }],
				}),
			);
			const oldError = bitmovinError as
				| ((event: { code?: number; name?: string }) => void)
				| null;
			loadGate = null;
			view.rerender(
				<PlaybackSurface url={newUrl} kind="MP4" player={player} />,
			);
			await waitFor(() =>
				expect(bitmovinCalls[1]?.loaded).toEqual({
					progressive: [{ url: newUrl, type: "video/mp4" }],
				}),
			);
			await act(async () => {
				if (failure === "error callback")
					oldError?.({ code: 2001, name: "SOURCE_ERROR" });
				rejectOldLoad(new Error("old source load failed"));
			});
			await waitFor(() => expect(playerDestroyed).toBe(1));
			expect(uiReleased).toBe(1);
			expect(fetch).not.toHaveBeenCalled();
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		} finally {
			loadGate = null;
			fetch.mockRestore();
		}
	});
	it("identifies a missing Library MP4 without blaming the codec", async () => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				Response.json(
					{ details: { code: "MEDIA_FILE_NOT_FOUND" } },
					{ status: 404 },
				),
			);
		const url = `/api/library/sources/${JOB}/media?key=mp4%3Avideo`;
		renderL(<PlaybackSurface url={url} kind="MP4" />);
		const video = document.querySelector("video") as HTMLVideoElement;
		await waitFor(() => expect(video).toHaveAttribute("src", url));
		fireEvent.error(video);
		await screen.findByText("MP4 file is missing from storage.");
		expect(fetch).toHaveBeenCalledWith(
			url,
			expect.objectContaining({ headers: { Range: "bytes=0-0" } }),
		);
		fetch.mockRestore();
	});
	it.each([
		[404, "MEDIA_FILE_NOT_FOUND", en.playback.mp4FileMissing],
		[502, "MEDIA_STORAGE_ACCESS_DENIED", en.playback.storageAccessDenied],
	] as const)("does not apply an old %i/%s probe to a new MP4 source", async (status, code, message) => {
		let resolve: (response: Response) => void = () => {};
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
			() =>
				new Promise<Response>((done) => {
					resolve = done;
				}),
		);
		const url = `/api/library/sources/${JOB}/media?key=mp4%3Aold`;
		const view = renderL(<PlaybackSurface url={url} kind="MP4" />);
		const video = document.querySelector("video") as HTMLVideoElement;
		await waitFor(() => expect(video).toHaveAttribute("src", url));
		fireEvent.error(video);
		fireEvent.error(video);
		expect(fetch).toHaveBeenCalledTimes(1);
		view.rerender(
			<PlaybackSurface url="https://media.test/new.mp4" kind="MP4" />,
		);
		await act(async () => {
			resolve(Response.json({ details: { code } }, { status }));
		});
		expect(screen.queryByText(message)).not.toBeInTheDocument();
		expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		fetch.mockRestore();
	});
});

describe("PlaybackSurface — explicit media access denied", () => {
	it("diagnoses a Library MP4 load rejection without a Bitmovin Error event", async () => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				Response.json(
					{ details: { code: "MEDIA_STORAGE_ACCESS_DENIED" } },
					{ status: 502 },
				),
			);
		bitmovinLoadError = new Error("source load failed");
		try {
			renderL(
				<PlaybackSurface
					url={`/api/library/sources/${JOB}/media?key=mp4%3Avideo`}
					kind="MP4"
					player={{ provider: "bitmovin", playerLicenseKey: "pk" }}
				/>,
			);
			await waitFor(() =>
				expect(screen.getByRole("alert")).toHaveTextContent(
					en.playback.storageAccessDenied,
				),
			);
			expect(fetch).toHaveBeenCalledTimes(1);
		} finally {
			fetch.mockRestore();
		}
	});

	it("keeps a Bitmovin licensing load rejection ahead of Library storage diagnosis", async () => {
		const fetch = vi.spyOn(globalThis, "fetch");
		bitmovinLoadError = new Error("licensing refused");
		try {
			renderL(
				<PlaybackSurface
					url={`/api/library/sources/${JOB}/media?key=mp4%3Avideo`}
					kind="MP4"
					player={{ provider: "bitmovin", playerLicenseKey: "pk" }}
				/>,
			);
			expect(await screen.findByRole("alert")).toHaveTextContent(
				en.playback.licenseDomainRefused,
			);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});

	it.each([
		{ code: 1017, name: "DOMAIN_ERROR" },
		{ code: 9999, name: "LICENSING_ERROR" },
	])("preserves an earlier Bitmovin licensing event through a generic load rejection %#", async (event) => {
		const fetch = vi.spyOn(globalThis, "fetch");
		let releaseLoad = () => {};
		loadGate = new Promise<void>((resolve) => {
			releaseLoad = resolve;
		});
		bitmovinLoadError = new Error("source load failed");
		try {
			renderL(
				<PlaybackSurface
					url={`/api/library/sources/${JOB}/media?key=mp4%3Avideo`}
					kind="MP4"
					player={{ provider: "bitmovin", playerLicenseKey: "pk" }}
				/>,
			);
			await waitFor(() => expect(bitmovinError).not.toBeNull());
			await act(async () => {
				bitmovinError?.(event);
				releaseLoad();
			});
			expect(screen.getByRole("alert")).toHaveTextContent(
				en.playback.licenseDomainRefused,
			);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			loadGate = null;
			fetch.mockRestore();
		}
	});

	it.each([
		"native",
		"bitmovin",
	] as const)("explains a confirmed Library storage read denial with %s playback", async (provider) => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				Response.json(
					{ details: { code: "MEDIA_STORAGE_ACCESS_DENIED" } },
					{ status: 502 },
				),
			);
		const url = `/api/library/sources/${JOB}/media?key=mp4%3Avideo`;
		try {
			renderL(
				<PlaybackSurface
					url={url}
					kind="MP4"
					player={
						provider === "bitmovin"
							? { provider, playerLicenseKey: "pk" }
							: { provider }
					}
				/>,
			);
			if (provider === "bitmovin") {
				await waitFor(() => expect(bitmovinError).not.toBeNull());
				act(() =>
					bitmovinError?.({
						code: 1209,
						name: "SOURCE_PROGRESSIVE_STREAM_ERROR",
					}),
				);
			} else {
				const video = document.querySelector("video") as HTMLVideoElement;
				await waitFor(() => expect(video).toHaveAttribute("src", url));
				fireEvent.error(video);
			}
			await waitFor(() =>
				expect(screen.getByRole("alert")).toHaveTextContent(
					en.playback.storageAccessDenied,
				),
			);
			expect(fetch).toHaveBeenCalledTimes(1);
		} finally {
			fetch.mockRestore();
		}
	});

	it.each([
		[401, "en"],
		[403, "ja"],
	] as const)("explains HLS HTTP %i in %s without waiting for first publication", async (status, locale) => {
		renderL(
			<PlaybackSurface url={URL_HLS} kind="HLS" waitForFirstSegment />,
			locale,
		);
		await waitFor(() => expect(fatal).not.toBeNull());
		act(() => fatal?.({ response: { code: status } }));
		expect(screen.getByRole("alert")).toHaveTextContent(
			(locale === "ja" ? ja : en).playback.accessDenied,
		);
		expect(screen.queryByRole("status")).toBeNull();
	});

	it.each([
		{ type: "networkError", response: { code: 0 } },
		{ type: "mediaError", response: { code: 403 } },
	])("does not infer access denial from an opaque network or decoder error %#", async (error) => {
		renderL(<PlaybackSurface url={URL_HLS} kind="HLS" />);
		await waitFor(() => expect(fatal).not.toBeNull());
		act(() => fatal?.(error));
		expect(screen.getByRole("alert")).not.toHaveTextContent(
			en.playback.accessDenied,
		);
	});

	it.each([
		["event", 401, 0],
		["event", 403, 1],
		["load rejection", 401, 1],
		["load rejection", 403, 0],
	] as const)("explains DASH %s HTTP %i for media request type %i", async (failure, status, requestType) => {
		const error = {
			code: 1001,
			data: ["https://cdn/media", status, "", {}, requestType],
		};
		if (failure === "load rejection") shakaLoadOutcomes.push(error);
		renderL(
			<PlaybackSurface
				url="https://cdn/stream.mpd"
				kind="DASH"
				waitForFirstSegment
			/>,
		);
		if (failure === "event") {
			await waitFor(() => expect(shakaErrorListener).not.toBeNull());
			act(() => shakaErrorListener?.({ detail: error }));
		}
		expect(await screen.findByRole("alert")).toHaveTextContent(
			en.playback.accessDenied,
		);
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("keeps recoverable DASH access denial visible until both tracks recover", async () => {
		renderL(<PlaybackSurface url="https://cdn/stream.mpd" kind="DASH" />);
		await waitFor(() => expect(shakaCalls.loaded).toHaveLength(1));
		act(() =>
			shakaErrorListener?.({
				detail: {
					severity: 1,
					code: 1001,
					data: ["https://cdn/segment", 403, "", {}, 1],
				},
			}),
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			en.playback.accessDenied,
		);
		expect(screen.queryByRole("alert")).toBeNull();
		act(() => shakaSegmentAppendedListener?.({ contentType: "audio" }));
		expect(screen.getByRole("status")).toHaveTextContent(
			en.playback.accessDenied,
		);
		act(() => shakaSegmentAppendedListener?.({ contentType: "video" }));
		expect(screen.queryByRole("status")).toBeNull();
		expect(shakaCalls.loaded).toHaveLength(1);
	});

	it("ignores an old DASH access-denied callback after switching sources", async () => {
		const view = renderL(
			<PlaybackSurface url="https://cdn/old.mpd" kind="DASH" />,
		);
		await waitFor(() => expect(shakaCalls.loaded).toHaveLength(1));
		const oldError = shakaErrorListener;
		view.rerender(<PlaybackSurface url="https://cdn/new.mpd" kind="DASH" />);
		await waitFor(() => expect(shakaCalls.loaded).toHaveLength(2));
		act(() =>
			shakaErrorListener?.({ detail: { severity: 1, code: 1002, data: [] } }),
		);
		act(() =>
			oldError?.({
				detail: {
					severity: 1,
					code: 1001,
					data: ["https://cdn/old-segment", 403, "", {}, 1],
				},
			}),
		);
		expect(screen.getByRole("status")).not.toHaveTextContent(
			en.playback.accessDenied,
		);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(shakaCalls.loaded).toHaveLength(2);
	});

	it("does not describe a DASH license response as media access denied", async () => {
		shakaLoadOutcomes.push({
			code: 1001,
			data: ["https://license", 403, "", {}, 2],
		});
		renderL(<PlaybackSurface url="https://cdn/stream.mpd" kind="DASH" />);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			en.ui.playerFailedToLoad,
		);
		expect(screen.getByRole("alert")).not.toHaveTextContent(
			en.playback.accessDenied,
		);
	});

	it.each([
		["event", 401, 1208],
		["event", 403, 1400],
		["load rejection", 401, 1400],
		["load rejection", 403, 1208],
	] as const)("explains Bitmovin %s HTTP %i for source error %i", async (failure, status, code) => {
		const error = {
			code,
			name: "SOURCE_COULD_NOT_LOAD_MANIFEST",
			data: { statusCode: status },
		};
		if (failure === "load rejection") bitmovinLoadError = error;
		try {
			renderL(
				<PlaybackSurface
					url={URL_HLS}
					kind="HLS"
					player={{ provider: "bitmovin", playerLicenseKey: "pk" }}
				/>,
			);
			if (failure === "event") {
				await waitFor(() => expect(bitmovinError).not.toBeNull());
				act(() => bitmovinError?.(error));
			}
			expect(await screen.findByRole("alert")).toHaveTextContent(
				en.playback.accessDenied,
			);
		} finally {
			loadGate = null;
		}
	});

	it("preserves Bitmovin licensing precedence over an HTTP status", async () => {
		renderL(
			<PlaybackSurface
				url={URL_HLS}
				kind="HLS"
				player={{ provider: "bitmovin", playerLicenseKey: "pk" }}
			/>,
		);
		await waitFor(() => expect(bitmovinError).not.toBeNull());
		act(() =>
			bitmovinError?.({
				code: 1016,
				name: "LICENSE_ERROR",
				data: { statusCode: 403 },
			}),
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			en.playback.licenseDomainRefused,
		);
		expect(screen.getByRole("alert")).not.toHaveTextContent(
			en.playback.accessDenied,
		);
	});

	it("does not treat an unrelated Bitmovin error code as media HTTP status", async () => {
		renderL(
			<PlaybackSurface
				url={URL_HLS}
				kind="HLS"
				player={{ provider: "bitmovin", playerLicenseKey: "pk" }}
			/>,
		);
		await waitFor(() => expect(bitmovinError).not.toBeNull());
		act(() => bitmovinError?.({ code: 403, name: "SOURCE_ERROR" }));
		expect(screen.getByRole("alert")).not.toHaveTextContent(
			en.playback.accessDenied,
		);
	});
});
