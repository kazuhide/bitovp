import { compileComposition, toCompositionDocument } from "@bitovp/core";
import { act, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import { CompositionPreview } from "./composition-preview";

const callbacks = new Map<number, FrameRequestCallback>();
const paused = new WeakMap<HTMLMediaElement, boolean>();
let handle = 0;
let videoReady = 3;
let audioReady = 3;
let audioSeeking = false;
let tag: "AUDIO" | "VIDEO" | undefined = "AUDIO";
let pendingUsed = false;
let resolvePlay: () => void;
let rejectPlay: (failure: unknown) => void;
const played: HTMLMediaElement[] = [];
const errorText =
	"This media could not be previewed. Reload it before continuing.";
beforeEach(() => {
	handle = 0;
	videoReady = 3;
	audioReady = 3;
	audioSeeking = false;
	tag = "AUDIO";
	pendingUsed = false;
	played.length = 0;
	callbacks.clear();
	vi.stubGlobal("FontFace", undefined);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		callbacks.set(++handle, callback);
		return handle;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
	vi.stubGlobal(
		"AudioContext",
		class {
			destination = {};
			resume = async () => {};
			close = async () => {};
			createGain = () => ({
				gain: { value: 1 },
				connect() {},
				disconnect() {},
			});
			createMediaElementSource = () => ({ connect() {} });
		},
	);
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
	vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockImplementation(
		function (this: HTMLMediaElement) {
			return this.tagName === "VIDEO" ? videoReady : audioReady;
		},
	);
	vi.spyOn(HTMLMediaElement.prototype, "seeking", "get").mockImplementation(
		function (this: HTMLMediaElement) {
			return this.tagName === "AUDIO" && audioSeeking;
		},
	);
	vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(
		function (this: HTMLMediaElement) {
			return paused.get(this) ?? true;
		},
	);
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
		this: HTMLMediaElement,
	) {
		paused.set(this, true);
	});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
		this: HTMLMediaElement,
	) {
		played.push(this);
		paused.set(this, false);
		if (this.tagName === tag && !pendingUsed) {
			pendingUsed = true;
			return new Promise<void>((resolve, reject) => {
				resolvePlay = resolve;
				rejectPlay = reject;
			});
		}
		return Promise.resolve();
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function preview(
	configure?: (document: ReturnType<typeof toCompositionDocument>) => void,
	hasAudio = true,
) {
	const project = editingProjectFixture(),
		document = toCompositionDocument(project.draft);
	configure?.(document);
	if (!project.media.timeMap) throw new Error("Missing source fixture");
	const plan = compileComposition(document, [
		{
			mediaVersionId: project.media.id,
			timeMap: project.media.timeMap,
			width: 1920,
			height: 1080,
			hasAudio,
		},
	]);
	if (!configure && hasAudio) expect(plan.audio.length).toBeGreaterThan(0);
	function Controlled() {
		const [frame, setFrame] = useState(0);
		return (
			<CompositionPreview
				plan={plan}
				media={[project.media]}
				imageAssets={[]}
				frame={frame}
				onFrame={setFrame}
			/>
		);
	}
	return renderLocalized(<Controlled />);
}
async function start() {
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Play" }));
	});
}
async function tick(time: number) {
	const pending = [...callbacks.values()];
	callbacks.clear();
	await act(async () => {
		for (const callback of pending) callback(time);
	});
}
async function reject(name: string) {
	expect(pendingUsed).toBe(true);
	await act(async () => {
		rejectPlay(new DOMException("Native playback rejection fixture", name));
	});
}

it.each([
	"buffering",
	"seeking",
	"pending play",
] as const)("holds the caption clock while only audio is %s, then resumes without counting the wait", async (reason) => {
	tag = reason === "pending play" ? "AUDIO" : undefined;
	audioReady = reason === "buffering" ? 0 : 3;
	audioSeeking = reason === "seeking";
	preview();
	await start();
	await tick(1000);
	await tick(1100);
	await tick(2000);
	expect(screen.getByRole("slider", { name: "Playhead" })).toHaveValue("0");
	expect(screen.queryByText(errorText)).not.toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
	audioReady = 3;
	audioSeeking = false;
	if (reason === "pending play") await act(async () => resolvePlay());
	await tick(5000);
	await tick(5000);
	expect(screen.getByRole("slider", { name: "Playhead" })).toHaveValue("0");
	await tick(5100);
	expect(screen.getByRole("slider", { name: "Playhead" })).toHaveValue("3");
});

it.each([
	"no audio",
	"muted",
] as const)("advances %s clips without waiting for an inactive audio element", async (kind) => {
	tag = undefined;
	audioReady = 0;
	const view = preview((document) => {
		const clip = document.clips[0];
		if (!clip) throw new Error("Missing fixture clip");
		if (kind === "muted") clip.audio.mode = "MUTE";
	}, kind !== "no audio");
	expect(view.container.querySelectorAll("audio")).toHaveLength(0);
	await start();
	await tick(1000);
	await tick(1000);
	await tick(1100);
	expect(screen.getByRole("slider", { name: "Playhead" })).toHaveValue("3");
	expect(screen.queryByText(errorText)).not.toBeInTheDocument();
});

it.each([
	"AUDIO",
	"VIDEO",
] as const)("holds its ready peer while %s play is pending without repeatedly interrupting either start", async (kind) => {
	tag = kind;
	const view = preview(),
		video = view.container.querySelector("video"),
		audio = view.container.querySelector("audio");
	if (!video || !audio) throw new Error("Missing native media fixture");
	const peer = kind === "AUDIO" ? video : audio;
	await start();
	await tick(1000);
	for (let time = 1034; time <= 2018; time += 34) {
		if (!peer.paused) peer.currentTime += 0.034;
		await tick(time);
	}
	expect(screen.getByRole("slider", { name: "Playhead" })).toHaveValue("0");
	expect(peer.paused).toBe(true);
	expect(played.filter((element) => element === peer)).toHaveLength(1);
	expect(screen.queryByText(errorText)).not.toBeInTheDocument();
	await act(async () => resolvePlay());
	await tick(3000);
	await tick(3000);
	for (let time = 3034; time <= 3102; time += 34) {
		video.currentTime += 0.034;
		audio.currentTime += 0.034;
		await tick(time);
	}
	expect(screen.getByRole("slider", { name: "Playhead" })).toHaveValue("3");
	expect(played.filter((element) => element === peer)).toHaveLength(2);
	expect(played.filter((element) => element.tagName === kind)).toHaveLength(1);
	expect(screen.queryByText(errorText)).not.toBeInTheDocument();
});

it.each([
	"AUDIO",
	"VIDEO",
] as const)("holds the clock when %s has only the current frame even without a pending play", async (kind) => {
	tag = undefined;
	audioReady = kind === "AUDIO" ? 2 : 4;
	videoReady = kind === "VIDEO" ? 2 : 4;
	const view = preview(),
		video = view.container.querySelector("video"),
		audio = view.container.querySelector("audio");
	if (!video || !audio) throw new Error("Missing media fixture");
	await start();
	paused.set(video, false);
	paused.set(audio, false);
	await tick(1000);
	await tick(1034);
	await tick(1068);
	expect(screen.getByRole("slider", { name: "Playhead" })).toHaveValue("0");
	expect(played).toHaveLength(0);
	expect(screen.queryByText(errorText)).not.toBeInTheDocument();
	audioReady = 3;
	videoReady = 3;
	await tick(5000);
	await tick(5000);
	await tick(5100);
	expect(screen.getByRole("slider", { name: "Playhead" })).toHaveValue("3");
});

it("waits for every active audio track before starting its caption clock", async () => {
	tag = undefined;
	const view = preview((document) => {
		document.audioTracks = [
			{
				id: "77777777-7777-4777-8777-777777777777",
				mediaVersionId: document.mediaVersionId,
				sourceInUs: 0,
				timelineStartFrame: 0,
				durationFrames: 300,
				gainDb: -6,
				fadeInFrames: 0,
				fadeOutFrames: 0,
			},
		];
	});
	const tracks = view.container.querySelectorAll("audio");
	expect(tracks).toHaveLength(2);
	const music = tracks[1];
	if (!music) throw new Error("Missing music fixture");
	let musicReady = 0;
	Object.defineProperty(music, "readyState", { get: () => musicReady });
	await start();
	await tick(1000);
	await tick(2000);
	expect(screen.getByRole("slider", { name: "Playhead" })).toHaveValue("0");
	expect(tracks[0]?.paused).toBe(true);
	musicReady = 3;
	await tick(5000);
	await tick(5000);
	await tick(5100);
	expect(screen.getByRole("slider", { name: "Playhead" })).toHaveValue("3");
	expect(screen.queryByText(errorText)).not.toBeInTheDocument();
});

it("crosses a short silent gap and seeks a new clip once before resuming", async () => {
	tag = undefined;
	const view = preview((document) => {
		const first = document.clips[0];
		if (!first) throw new Error("Missing fixture clip");
		first.durationFrames = 3;
		first.framing = [
			{ fromFrame: 0, toFrame: 3, mode: "FIT", origin: "MANUAL" },
		];
		document.clips.push({
			...structuredClone(first),
			id: "77777777-7777-4777-8777-777777777777",
			sourceInUs: 5_000_000,
			timelineStartFrame: 5,
			durationFrames: 6,
			framing: [{ fromFrame: 0, toFrame: 6, mode: "FIT", origin: "MANUAL" }],
		});
	});
	const nextVideo = view.container.querySelectorAll("video")[1],
		nextAudio = view.container.querySelectorAll("audio")[1];
	if (!nextVideo || !nextAudio) throw new Error("Missing next clip fixture");
	const media = [nextVideo, nextAudio].map((element) => {
		const native = { time: 0, seeking: false, seeks: 0 };
		Object.defineProperty(element, "currentTime", {
			get: () => native.time,
			set: (time: number) => {
				native.time = time;
				native.seeking = true;
				native.seeks++;
			},
		});
		Object.defineProperty(element, "seeking", { get: () => native.seeking });
		return native;
	});
	await start();
	await tick(1000);
	await tick(1000);
	await tick(1100);
	expect(screen.getByRole("slider", { name: "Playhead" })).toHaveValue("3");
	await tick(1134);
	await tick(1168);
	expect(screen.getByRole("slider", { name: "Playhead" })).toHaveValue("5");
	await tick(1202);
	await tick(1236);
	await tick(2000);
	expect(media.map((item) => item.seeks)).toEqual([1, 1]);
	expect(screen.getByRole("slider", { name: "Playhead" })).toHaveValue("5");
	for (const item of media) item.seeking = false;
	await tick(3000);
	await tick(3000);
	for (let time = 3034; time <= 3204; time += 34) {
		for (const item of media) item.time += 0.034;
		await tick(time);
	}
	expect(media.map((item) => item.seeks)).toEqual([1, 1]);
	expect(screen.getByRole("slider", { name: "Playhead" })).toHaveValue("10");
	expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
	expect(screen.queryByText(errorText)).not.toBeInTheDocument();
	// Stopping may snap the video to its exact final frame once; it must not
	// restart audio or keep seeking the held frame on every later callback.
	await tick(3238);
	expect(media.map((item) => item.seeks)).toEqual([2, 1]);
	const video = media[0];
	if (!video) throw new Error("Missing native video fixture");
	video.seeking = false;
	await tick(3272);
	await tick(3306);
	expect(media.map((item) => item.seeks)).toEqual([2, 1]);
});

it("keeps playing after its readiness pause interrupts pending audio and retries that audio", async () => {
	preview();
	await start();
	await tick(1000);
	videoReady = 0;
	await tick(1034);
	await reject("AbortError");
	expect(screen.queryByText(errorText)).not.toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
	videoReady = 3;
	await tick(1067);
	await tick(1101);
	await tick(1135);
	expect(played.filter((element) => element.tagName === "AUDIO")).toHaveLength(
		2,
	);
	expect(
		Number(
			screen.getByRole("slider", { name: "Playhead" }).getAttribute("value"),
		),
	).toBeGreaterThan(0);
});
it("ignores an old video play rejection after the user pauses and starts a fresh playback", async () => {
	tag = "VIDEO";
	preview();
	await start();
	await tick(1000);
	fireEvent.click(screen.getByRole("button", { name: "Pause" }));
	await start();
	await tick(2000);
	await reject("AbortError");
	expect(screen.queryByText(errorText)).not.toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
	await tick(2000);
	await tick(2100);
	expect(screen.getByRole("slider", { name: "Playhead" })).toHaveValue("3");
});
it("ignores an expected abort after a pending video is intentionally sought", async () => {
	tag = "VIDEO";
	const view = preview();
	await start();
	await tick(1000);
	const video = view.container.querySelector("video");
	if (!video) throw new Error("Missing fixture video");
	video.currentTime = 0.2;
	// A native currentTime change enters seeking before its play abort settles.
	Object.defineProperty(video, "seeking", { get: () => true });
	await tick(1100);
	await tick(1134);
	await reject("AbortError");
	expect(screen.queryByText(errorText)).not.toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
});
it.each([
	"AUDIO",
	"VIDEO",
] as const)("does not ignore an unexpected active AbortError from %s", async (kind) => {
	tag = kind;
	preview();
	await start();
	await tick(1000);
	await tick(1100);
	expect(screen.getByRole("slider", { name: "Playhead" })).toHaveValue("0");
	await reject("AbortError");
	expect(screen.getByText(errorText)).toBeVisible();
	expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
	await tick(9999);
	expect(screen.getByRole("slider", { name: "Playhead" })).toHaveValue("0");
});
it.each([
	["AUDIO", "NotAllowedError"],
	["AUDIO", "NotSupportedError"],
	["VIDEO", "NotAllowedError"],
	["VIDEO", "NotSupportedError"],
] as const)("preserves a genuine %s %s failure", async (kind, name) => {
	tag = kind;
	preview();
	await start();
	await tick(1000);
	// An intentional readiness pause must only excuse AbortError, not policy/codec failures.
	if (kind === "AUDIO") {
		videoReady = 0;
		await tick(1034);
	}
	await reject(name);
	expect(screen.getByText(errorText)).toBeVisible();
	expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
});
it("keeps native video error events fatal even when a play abort was expected", async () => {
	const view = preview();
	await start();
	await tick(1000);
	videoReady = 0;
	await tick(1034);
	const video = view.container.querySelector("video");
	if (!video) throw new Error("Missing fixture video");
	fireEvent.error(video);
	await reject("AbortError");
	expect(screen.getByText(errorText)).toBeVisible();
	expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
});
it("does not excuse an expected audio abort when the media itself reports a decode error", async () => {
	const view = preview();
	await start();
	await tick(1000);
	videoReady = 0;
	await tick(1034);
	const audio = view.container.querySelector("audio");
	if (!audio) throw new Error("Missing fixture audio");
	Object.defineProperty(audio, "error", {
		configurable: true,
		value: { code: 3, message: "Measured media decode error fixture" },
	});
	await reject("AbortError");
	expect(screen.getByText(errorText)).toBeVisible();
	expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
});
