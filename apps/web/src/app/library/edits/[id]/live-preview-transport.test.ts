import { afterEach, expect, it, vi } from "vitest";
import { editingProjectFixture } from "../editing-fixtures";
import { buildPreviewPlan } from "../preview-model";
import {
	LivePreviewTransport,
	type PreviewSnapshot,
} from "./live-preview-transport";

class Media extends EventTarget {
	readyState = 2;
	paused = true;
	seeking = false;
	ended = false;
	muted = true;
	playbackRate = 1;
	time = 0;
	callbacks = new Map<number, VideoFrameRequestCallback>();
	next = 0;
	get currentTime() {
		return this.time;
	}
	set currentTime(value: number) {
		if (this.time !== value) this.seeking = true;
		this.time = value;
		this.ended = false;
	}
	pause = vi.fn(() => {
		this.paused = true;
	});
	play = vi.fn(() => {
		this.paused = false;
		return Promise.resolve();
	});
	load = vi.fn();
	requestVideoFrameCallback = (callback: VideoFrameRequestCallback) => {
		const id = ++this.next;
		this.callbacks.set(id, callback);
		return id;
	};
	cancelVideoFrameCallback = (id: number) => {
		this.callbacks.delete(id);
	};
	present(frame: number) {
		this.time = frame / 30;
		const callbacks = [...this.callbacks.values()];
		this.callbacks.clear();
		for (const callback of callbacks)
			callback(0, { mediaTime: this.time } as VideoFrameCallbackMetadata);
	}
	seeked(frame: number) {
		this.time = frame / 30;
		this.ended = false;
		this.seeking = false;
		this.dispatchEvent(new Event("seeked"));
	}
}

function setup() {
	const p = editingProjectFixture();
	const first = p.draft.clips[0];
	if (!first) throw new Error("fixture");
	p.draft.clips = [
		{
			...first,
			durationFrames: 3,
			framing: [{ fromFrame: 0, toFrame: 3, mode: "FIT", origin: "MANUAL" }],
		},
		{
			...first,
			id: "77777777-7777-4777-8777-777777777777",
			sourceInUs: 1_000_000,
			durationFrames: 2,
			timelineStartFrame: 3,
			audio: { mode: "MUTE" },
			framing: [{ fromFrame: 0, toFrame: 2, mode: "FIT", origin: "MANUAL" }],
		},
	];
	const plan = buildPreviewPlan(p.draft, p.media);
	const video = new Media();
	const frames: number[] = [];
	const drawn: number[] = [];
	let snapshot: PreviewSnapshot | null = null;
	const transport = new LivePreviewTransport(
		video as unknown as HTMLVideoElement,
		{
			onFrameChange: (f) => frames.push(f),
			onDraw: (f) => drawn.push(f),
			onSnapshot: (s) => {
				snapshot = s;
			},
		},
	);
	transport.update(plan, 0, false, 0);
	return { transport, video, frames, drawn, plan, state: () => snapshot };
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it("uses presented frames and does not pause or seek on its controlled-frame echo", async () => {
	const s = setup();
	s.transport.play();
	await Promise.resolve();
	s.video.present(1);
	s.transport.update(s.plan, 1, false, 0);
	expect(s.state()).toMatchObject({ phase: "playing", frame: 1 });
	expect(s.video.pause).not.toHaveBeenCalled();
	expect(s.video.play).toHaveBeenCalledTimes(1);
	s.transport.destroy();
});

it("holds the last valid image at a discontinuous cut and waits for seeked before resuming", async () => {
	const s = setup();
	s.transport.setMuted(false);
	s.transport.play();
	await Promise.resolve();
	s.video.present(2);
	s.video.present(3);
	expect(s.state()).toMatchObject({ phase: "buffering", frame: 3 });
	expect(s.video.currentTime).toBe(1);
	expect(s.video.play).toHaveBeenCalledTimes(1);
	expect(s.drawn).not.toContain(3);
	s.video.seeked(30);
	await Promise.resolve();
	expect(s.video.play).toHaveBeenCalledTimes(2);
	expect(s.video.muted).toBe(true);
	expect(s.drawn.at(-1)).toBe(3);
	s.video.present(31);
	s.video.present(32);
	s.video.seeked(31);
	expect(s.state()).toMatchObject({ phase: "ended", frame: 4, playing: false });
	s.transport.destroy();
});

it("cancels rapid seeks, late play promises, callbacks and deadlines on destruction", async () => {
	vi.useFakeTimers();
	const s = setup();
	let resolvePlay = () => {};
	s.video.play.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				resolvePlay = resolve;
			}),
	);
	s.transport.play();
	const staleCallback = [...s.video.callbacks.values()][0];
	s.transport.update(s.plan, 3, false, 0);
	s.transport.update(s.plan, 1, false, 0);
	staleCallback?.(0, { mediaTime: 0 } as VideoFrameCallbackMetadata);
	s.video.seeked(30);
	expect(s.drawn.at(-1)).toBe(0);
	s.video.seeked(1);
	expect(s.drawn.at(-1)).toBe(1);
	resolvePlay();
	await Promise.resolve();
	expect(s.state()).toMatchObject({ phase: "paused", frame: 1 });
	s.transport.destroy();
	expect(s.video.callbacks.size).toBe(0);
	expect(vi.getTimerCount()).toBe(0);
});

it("loops sequential ranges with speed and the active clip's audio policy", async () => {
	const s = setup();
	s.transport.setMuted(false);
	s.transport.setLoop(true);
	s.transport.setRate(2);
	s.transport.play();
	await Promise.resolve();
	expect(s.video.muted).toBe(false);
	expect(s.video.playbackRate).toBe(2);
	s.video.present(3);
	s.video.seeked(30);
	await Promise.resolve();
	expect(s.video.muted).toBe(true);
	s.transport.setMuted(false);
	expect(s.video.muted).toBe(true);
	s.video.present(32);
	s.video.seeked(0);
	await Promise.resolve();
	expect(s.state()).toMatchObject({
		phase: "playing",
		frame: 0,
		loop: true,
		rate: 2,
	});
	expect(s.video.muted).toBe(false);
	s.transport.destroy();
});

it("recovers from rejected playback without leaving an unhandled promise", async () => {
	const s = setup();
	s.video.play.mockRejectedValueOnce(new Error("NotAllowedError"));
	s.transport.play();
	await Promise.resolve();
	expect(s.state()).toMatchObject({ phase: "error", playing: false });
	s.transport.retry();
	expect(s.video.load).toHaveBeenCalledTimes(1);
	s.transport.play();
	await Promise.resolve();
	expect(s.state()).toMatchObject({ phase: "playing" });
	s.transport.destroy();
});

it("pauses on a source-player signal without sending a cursor change, and blocks transport", async () => {
	const s = setup();
	s.transport.play();
	await Promise.resolve();
	s.video.present(1);
	const notified = s.frames.length;
	s.transport.update(s.plan, 1, false, 1);
	expect(s.state()).toMatchObject({ phase: "paused", frame: 1 });
	expect(s.frames).toHaveLength(notified);
	s.transport.update(s.plan, 1, true, 1);
	s.transport.seek(4);
	s.transport.play();
	expect(s.video.currentTime).toBe(1 / 30);
	expect(s.video.play).toHaveBeenCalledTimes(1);
	s.transport.destroy();
});

it("cancels all work while hidden and gives stalled loading a recoverable deadline", () => {
	vi.useFakeTimers();
	const s = setup();
	s.video.readyState = 0;
	s.transport.seek(3);
	s.transport.setVisible(false);
	expect(vi.getTimerCount()).toBe(0);
	expect(s.video.callbacks.size).toBe(0);
	vi.advanceTimersByTime(16_000);
	expect(s.state()).toMatchObject({ phase: "paused" });
	s.transport.setVisible(true);
	vi.advanceTimersByTime(15_000);
	expect(s.state()).toMatchObject({ phase: "error" });
	s.transport.destroy();
	expect(vi.getTimerCount()).toBe(0);
});

it("treats an explicit seek nonce as a seek even if the requested frame is an old echo", async () => {
	const s = setup();
	s.transport.play();
	await Promise.resolve();
	s.video.present(1);
	s.video.present(2);
	s.transport.update(s.plan, 1, false, 0, 1);
	s.video.seeked(1);
	expect(s.state()).toMatchObject({ phase: "paused", frame: 1 });
	expect(s.drawn.at(-1)).toBe(1);
	s.transport.destroy();
});

it("keeps a paused seek drawable across blocked and pause-signal changes", async () => {
	const s = setup();
	s.transport.update(s.plan, 3, false, 0);
	s.transport.update(s.plan, 3, true, 1);
	s.video.seeked(30);
	expect(s.drawn.at(-1)).toBe(3);
	expect(s.state()).toMatchObject({ phase: "paused", frame: 3 });
	s.transport.update(s.plan, 3, false, 1);
	s.transport.play();
	await Promise.resolve();
	expect(s.state()).toMatchObject({ phase: "playing", frame: 3 });
	s.transport.destroy();
});

it("keeps contiguous source cuts running without a seek and switches audio at the boundary", async () => {
	const s = setup();
	const document = structuredClone(s.plan.document);
	const second = document.clips[1];
	if (!second) throw new Error("fixture");
	second.sourceInUs = 100_000;
	const plan = buildPreviewPlan(document, editingProjectFixture().media);
	s.transport.update(plan, 0, false, 0);
	s.transport.setMuted(false);
	s.transport.play();
	await Promise.resolve();
	s.video.present(3);
	expect(s.state()).toMatchObject({
		phase: "playing",
		frame: 3,
		clipMuted: true,
	});
	expect(s.video.play).toHaveBeenCalledTimes(1);
	expect(s.video.pause).not.toHaveBeenCalled();
	expect(s.video.muted).toBe(true);
	s.transport.destroy();
});

it("cancels playback and re-resolves the same cursor when the edit is replaced", async () => {
	const s = setup();
	s.transport.play();
	await Promise.resolve();
	s.video.present(1);
	const document = structuredClone(s.plan.document);
	const first = document.clips[0];
	if (!first) throw new Error("fixture");
	first.sourceInUs = 2_000_000;
	s.transport.update(
		buildPreviewPlan(document, editingProjectFixture().media),
		1,
		false,
		0,
	);
	s.video.seeked(61);
	expect(s.state()).toMatchObject({ phase: "paused", frame: 1 });
	expect(s.video.currentTime).toBe(61 / 30);
	s.transport.destroy();
});

it("notifies explicit same-frame navigation and pause without treating the echo as a new seek", async () => {
	const s = setup();
	s.transport.seek(0);
	s.transport.pause();
	expect(s.frames).toEqual([0, 0]);
	s.transport.play();
	await Promise.resolve();
	s.transport.update(s.plan, 0, false, 0);
	expect(s.state()).toMatchObject({ phase: "playing", frame: 0 });
	s.transport.destroy();
});

it("uses and cancels an animation-frame fallback when native video callbacks are unavailable", async () => {
	const s = setup();
	Object.defineProperty(s.video, "requestVideoFrameCallback", {
		value: undefined,
	});
	const callbacks = new Map<number, FrameRequestCallback>();
	let id = 0;
	vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
		callbacks.set(++id, fn);
		return id;
	});
	vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
		callbacks.delete(handle),
	);
	s.transport.play();
	await Promise.resolve();
	s.video.time = 2 / 30;
	const callback = callbacks.get(id);
	callbacks.delete(id);
	callback?.(16);
	expect(s.drawn.at(-1)).toBe(2);
	s.transport.destroy();
	expect(callbacks.size).toBe(0);
});

it("stops an old play promise that resumes the decoder while a new cut is still seeking", async () => {
	const s = setup();
	let resolve = () => {};
	s.video.play.mockImplementationOnce(
		() =>
			new Promise<void>((done) => {
				resolve = done;
			}),
	);
	s.transport.setMuted(false);
	s.transport.play();
	s.video.present(3);
	s.video.paused = false;
	resolve();
	await Promise.resolve();
	expect(s.video.paused).toBe(true);
	expect(s.video.muted).toBe(true);
	expect(s.state()).toMatchObject({
		phase: "buffering",
		frame: 3,
		playing: true,
	});
	s.video.seeked(30);
	await Promise.resolve();
	expect(s.state()).toMatchObject({ phase: "playing", frame: 3 });
	s.transport.destroy();
});

it("does not let a canceled same-generation seek callback replace the active playback callback", async () => {
	const s = setup();
	s.transport.seek(3);
	const canceled = [...s.video.callbacks.values()][0];
	s.video.seeked(30);
	s.transport.play();
	await Promise.resolve();
	canceled?.(0, { mediaTime: 1 } as VideoFrameCallbackMetadata);
	expect(s.video.callbacks.size).toBe(1);
	s.transport.destroy();
	expect(s.video.callbacks.size).toBe(0);
});

it("steps from the displayed transport frame and pauses across a source cut", async () => {
	const s = setup();
	s.transport.play();
	await Promise.resolve();
	s.video.present(1);
	s.transport.step(1);
	s.video.seeked(2);
	expect(s.state()).toMatchObject({ phase: "paused", frame: 2 });
	s.transport.step(1);
	s.video.seeked(30);
	expect(s.state()).toMatchObject({
		phase: "paused",
		frame: 3,
		clipMuted: true,
	});
	s.transport.destroy();
});

it("ignores an old ended event while a new seek and restart are pending", async () => {
	const s = setup();
	s.transport.play();
	await Promise.resolve();
	s.transport.seek(3);
	s.transport.play();
	s.video.dispatchEvent(new Event("ended"));
	expect(s.state()).toMatchObject({
		phase: "buffering",
		frame: 3,
		playing: true,
	});
	expect(s.video.ended).toBe(false);
	s.video.seeked(30);
	await Promise.resolve();
	expect(s.state()).toMatchObject({ phase: "playing", frame: 3 });
	expect(s.drawn.at(-1)).toBe(3);
	s.transport.destroy();
});

it("ignores an old ended event after a new seek has resumed playback", async () => {
	const s = setup();
	s.transport.seek(3);
	s.video.seeked(30);
	s.transport.play();
	await Promise.resolve();
	s.video.dispatchEvent(new Event("ended"));
	expect(s.state()).toMatchObject({
		phase: "playing",
		frame: 3,
		playing: true,
	});
	expect(s.video.ended).toBe(false);
	expect(s.video.play).toHaveBeenCalledTimes(1);
	s.transport.destroy();
});

it("continues to the next range when native EOF dispatches pause before ended", async () => {
	const s = setup();
	const document = structuredClone(s.plan.document);
	const first = document.clips[0];
	const second = document.clips[1];
	if (!first || !second) throw new Error("fixture");
	first.sourceInUs = 59_900_000;
	second.sourceInUs = 0;
	const plan = buildPreviewPlan(document, editingProjectFixture().media);
	s.transport.update(plan, 0, false, 0);
	s.video.seeked(1797);
	s.transport.play();
	await Promise.resolve();
	s.video.time = 60;
	s.video.paused = true;
	s.video.ended = true;
	s.video.dispatchEvent(new Event("pause"));
	s.video.dispatchEvent(new Event("ended"));
	expect(s.state()).toMatchObject({
		phase: "buffering",
		frame: 3,
		playing: true,
	});
	s.video.seeked(0);
	await Promise.resolve();
	expect(s.state()).toMatchObject({
		phase: "playing",
		frame: 3,
		clipMuted: true,
	});
	expect(s.drawn.at(-1)).toBe(3);
	s.transport.destroy();
});

it("settles on the last output frame when native EOF dispatches pause before ended", async () => {
	const s = setup();
	const document = structuredClone(s.plan.document);
	const last = document.clips[1];
	if (!last) throw new Error("fixture");
	last.sourceInUs = 59_933_334;
	const plan = buildPreviewPlan(document, editingProjectFixture().media);
	s.transport.update(plan, 3, false, 0);
	s.video.seeked(1798);
	s.transport.play();
	await Promise.resolve();
	s.video.time = 60;
	s.video.paused = true;
	s.video.ended = true;
	s.video.dispatchEvent(new Event("pause"));
	s.video.dispatchEvent(new Event("ended"));
	s.video.seeked(1799);
	expect(s.state()).toMatchObject({ phase: "ended", frame: 4, playing: false });
	expect(s.drawn.at(-1)).toBe(4);
	s.transport.destroy();
});

it("loops from native source EOF despite pause arriving before ended", async () => {
	const s = setup();
	const document = structuredClone(s.plan.document);
	const last = document.clips[1];
	if (!last) throw new Error("fixture");
	last.sourceInUs = 59_933_334;
	const plan = buildPreviewPlan(document, editingProjectFixture().media);
	s.transport.update(plan, 3, false, 0);
	s.video.seeked(1798);
	s.transport.setLoop(true);
	s.transport.play();
	await Promise.resolve();
	s.video.time = 60;
	s.video.paused = true;
	s.video.ended = true;
	s.video.dispatchEvent(new Event("pause"));
	s.video.dispatchEvent(new Event("ended"));
	expect(s.state()).toMatchObject({
		phase: "buffering",
		frame: 0,
		playing: true,
	});
	s.video.seeked(0);
	await Promise.resolve();
	expect(s.state()).toMatchObject({ phase: "playing", frame: 0, loop: true });
	expect(s.drawn.at(-1)).toBe(0);
	s.transport.destroy();
});

it("re-seeks an unchanged controlled frame before its latest playback echo is committed", async () => {
	const s = setup();
	s.transport.play();
	await Promise.resolve();
	s.video.present(1);
	expect(s.frames.at(-1)).toBe(1);
	s.transport.update(s.plan, 0, false, 0, 1);
	expect(s.video.currentTime).toBe(0);
	s.video.seeked(0);
	expect(s.state()).toMatchObject({
		phase: "paused",
		frame: 0,
		playing: false,
	});
	expect(s.drawn.at(-1)).toBe(0);
	expect(s.frames.at(-1)).toBe(1);
	s.transport.destroy();
});

it("keeps the displayed frame when only a source-player pause signal changes before an echo commits", async () => {
	const s = setup();
	s.transport.play();
	await Promise.resolve();
	s.video.present(1);
	const notified = s.frames.length;
	s.transport.update(s.plan, 0, false, 1, 0);
	expect(s.state()).toMatchObject({
		phase: "paused",
		frame: 1,
		playing: false,
	});
	expect(s.video.currentTime).toBe(1 / 30);
	expect(s.drawn.at(-1)).toBe(1);
	expect(s.frames).toHaveLength(notified);
	s.transport.destroy();
});
