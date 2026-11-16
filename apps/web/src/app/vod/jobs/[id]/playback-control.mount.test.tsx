import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import type { PlaybackControl } from "./playback-control";
import { PlaybackSurface } from "./playback-surface";

let hlsLevel = -1;
const shakaConfigure = vi.fn();
const shakaSelect = vi.fn();
const bitmovinQuality = vi.fn();
let bitmovinError: (() => void) | undefined;
const qualities = [
	{ id: "hd", height: 1080, bitrate: 2_000_000 },
	{ id: "4k", height: 2160, bitrate: 8_000_000 },
];
vi.mock("hls.js", () => ({
	default: class {
		static Events = {
			ERROR: "error",
			FRAG_LOADED: "fragment",
			MANIFEST_PARSED: "manifest",
		};
		static isSupported() {
			return true;
		}
		levels = qualities;
		set currentLevel(value: number) {
			hlsLevel = value;
		}
		on() {}
		loadSource() {}
		attachMedia() {}
		destroy() {}
	},
}));
vi.mock("shaka-player", () => ({
	default: {
		polyfill: { installAll() {} },
		Player: class {
			static isBrowserSupported() {
				return true;
			}
			async attach() {}
			async load() {}
			async destroy() {}
			configure = shakaConfigure;
			selectVariantTrack = shakaSelect;
			getVariantTracks() {
				return qualities.map((quality, index) => ({
					...quality,
					id: index + 1,
					bandwidth: quality.bitrate,
					active: index === 0,
					audioId: 1,
					videoId: index + 2,
				}));
			}
			addEventListener() {}
			removeEventListener() {}
		},
	},
}));
vi.mock("bitmovin-player-ui", () => ({
	UIFactory: { buildUI: () => ({ release() {} }) },
}));
vi.mock("bitmovin-player", () => ({
	PlayerEvent: { Error: "error", TimeChanged: "time" },
	Player: class {
		video = document.createElement("video");
		constructor(host: HTMLElement) {
			host.append(this.video);
		}
		async load() {}
		async destroy() {
			this.video.remove();
		}
		on(event: string, callback: () => void) {
			if (event === "error") bitmovinError = callback;
		}
		off() {}
		play() {
			return this.video.play();
		}
		pause() {
			this.video.pause();
		}
		seek(seconds: number) {
			this.video.currentTime = seconds;
			return true;
		}
		mute() {
			this.video.muted = true;
		}
		unmute() {
			this.video.muted = false;
		}
		getVideoElement() {
			return this.video;
		}
		getAvailableVideoQualities() {
			return qualities;
		}
		setVideoQuality = bitmovinQuality;
	},
}));

beforeEach(() => {
	vi.clearAllMocks();
	bitmovinError = undefined;
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

it("exposes the actual playback element's controls and releases them on source removal", async () => {
	const changed = vi.fn<(control: PlaybackControl | null) => void>();
	const view = renderLocalized(
		<PlaybackSurface
			url="https://media.example.test/encoded.mp4"
			kind="MP4"
			controls={false}
			onControl={changed}
		/>,
	);
	await waitFor(() =>
		expect(changed.mock.calls.some(([value]) => value !== null)).toBe(true),
	);
	const control = changed.mock.calls.find(([value]) => value !== null)?.[0];
	if (!control) throw new Error("Missing media control");
	const video = view.container.querySelector("video");
	if (!video) throw new Error("Missing video");
	Object.defineProperties(video, {
		readyState: { configurable: true, value: 4 },
		duration: { configurable: true, value: 100 },
	});
	fireEvent.canPlay(video);
	expect(control.read()).toMatchObject({
		ready: true,
		duration: 100,
		failed: false,
	});
	expect(video.controls).toBe(false);
	control.seek(31.5);
	expect(video.currentTime).toBe(31.5);
	control.mute(false);
	expect(video.muted).toBe(false);
	await act(async () => {
		await control.play();
	});
	expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
	control.pause();
	expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
	const listener = vi.fn();
	const remove = control.subscribe(listener);
	fireEvent.waiting(video);
	expect(control.read().ready).toBe(false);
	fireEvent.canPlay(video);
	expect(control.read().ready).toBe(true);
	expect(listener).toHaveBeenCalled();
	remove();
	view.unmount();
	expect(changed).toHaveBeenLastCalledWith(null);
});

it.each([
	"HLS",
	"DASH",
	"BITMOVIN",
] as const)("connects %s engine quality, audio and failure controls to its real element", async (engine) => {
	const changed = vi.fn<(control: PlaybackControl | null) => void>();
	const view = renderLocalized(
		<PlaybackSurface
			url="https://media.example.test/output"
			kind={engine === "DASH" ? "DASH" : "HLS"}
			controls={false}
			onControl={changed}
			player={
				engine === "BITMOVIN"
					? { provider: "bitmovin", playerLicenseKey: "fixture" }
					: undefined
			}
		/>,
	);
	let control: PlaybackControl | undefined;
	await waitFor(() => {
		control =
			changed.mock.calls.find(([value]) => value !== null)?.[0] ?? undefined;
		expect(control?.qualities()).toHaveLength(2);
	});
	if (!control) throw new Error("Missing engine control");
	const target = engine === "HLS" ? "1" : engine === "DASH" ? "2" : "4k";
	expect(control.selectQuality(target)).toBe(true);
	expect(control.read().qualityId).toBe(target);
	if (engine === "HLS") expect(hlsLevel).toBe(1);
	if (engine === "DASH") {
		expect(shakaConfigure).toHaveBeenLastCalledWith({
			abr: { enabled: false },
		});
		expect(shakaSelect).toHaveBeenCalledWith(
			expect.objectContaining({ height: 2160 }),
			true,
		);
	}
	if (engine === "BITMOVIN") expect(bitmovinQuality).toHaveBeenCalledWith("4k");
	const video = view.container.querySelector("video");
	if (!video) throw new Error("Missing engine element");
	control.mute(false);
	expect(video.muted).toBe(false);
	control.seek(8.5);
	expect(video.currentTime).toBe(8.5);
	if (engine === "BITMOVIN") {
		act(() => bitmovinError?.());
		await waitFor(() => expect(control?.read().failed).toBe(true));
	}
	view.unmount();
	expect(changed).toHaveBeenLastCalledWith(null);
});
