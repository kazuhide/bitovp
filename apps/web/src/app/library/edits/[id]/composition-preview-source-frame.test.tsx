import { compileComposition, toCompositionDocument } from "@bitovp/core";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import { CompositionPreview } from "./composition-preview";
import type { CompositionSourceFrameReader } from "./composition-source-frame";

const callbacks = new Map<number, FrameRequestCallback>();
const videoCallbacks = new Map<
	number,
	{ video: HTMLVideoElement; callback: VideoFrameRequestCallback }
>();
const paused = new WeakMap<HTMLMediaElement, boolean>();
const drawImage = vi.fn();
let handle = 0;
beforeEach(() => {
	handle = 0;
	callbacks.clear();
	videoCallbacks.clear();
	drawImage.mockReset();
	vi.stubGlobal("FontFace", undefined);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		callbacks.set(++handle, callback);
		return handle;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		drawImage,
		fillRect() {},
		clearRect() {},
	} as unknown as CanvasRenderingContext2D);
	vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(2);
	vi.spyOn(HTMLMediaElement.prototype, "seeking", "get").mockReturnValue(false);
	vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(
		1920,
	);
	vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(
		1080,
	);
	vi.spyOn(HTMLMediaElement.prototype, "currentSrc", "get").mockImplementation(
		function (this: HTMLMediaElement) {
			return this.src;
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
	vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
		async function (this: HTMLMediaElement) {
			paused.set(this, false);
		},
	);
	Object.defineProperty(
		HTMLVideoElement.prototype,
		"requestVideoFrameCallback",
		{
			configurable: true,
			value: function (
				this: HTMLVideoElement,
				callback: VideoFrameRequestCallback,
			) {
				videoCallbacks.set(++handle, { video: this, callback });
				return handle;
			},
		},
	);
	Object.defineProperty(
		HTMLVideoElement.prototype,
		"cancelVideoFrameCallback",
		{ configurable: true, value: (id: number) => videoCallbacks.delete(id) },
	);
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
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	Reflect.deleteProperty(
		HTMLVideoElement.prototype,
		"requestVideoFrameCallback",
	);
	Reflect.deleteProperty(
		HTMLVideoElement.prototype,
		"cancelVideoFrameCallback",
	);
});
function fixture() {
	const project = editingProjectFixture(),
		document = toCompositionDocument(project.draft);
	if (!project.media.timeMap) throw new Error("Missing time map");
	const plan = compileComposition(document, [
		{
			mediaVersionId: project.media.id,
			timeMap: project.media.timeMap,
			width: 1920,
			height: 1080,
			hasAudio: true,
		},
	]);
	const registration = vi.fn(),
		changed = vi.fn();
	const props = {
		plan,
		media: [project.media],
		imageAssets: [],
		frame: 0,
		onFrame: vi.fn(),
		onSourceFrameReader: registration,
		onSourceFrameAvailabilityChange: changed,
	};
	const view = renderLocalized(<CompositionPreview {...props} />);
	const reader = () =>
		registration.mock.calls.at(-1)?.[0] as CompositionSourceFrameReader | null;
	const clipId = plan.clips[0]?.clip.id;
	if (!clipId) throw new Error("Missing clip");
	return { view, props, reader, registration, changed, clipId };
}
function tick(time: number) {
	const pending = [...callbacks.values()];
	callbacks.clear();
	act(() => {
		for (const callback of pending) callback(time);
	});
}
function presented() {
	const pending = [...videoCallbacks.values()];
	videoCallbacks.clear();
	act(() => {
		for (const { video, callback } of pending)
			callback(0, {
				mediaTime: Math.round(video.currentTime * 30) / 30,
			} as VideoFrameCallbackMetadata);
	});
}

it("registers one stable reader and captures the existing source only on demand", () => {
	const f = fixture();
	expect(f.reader()).toEqual(expect.any(Function));
	expect(f.reader()?.(f.clipId)).toBeNull();
	tick(1000);
	expect(f.changed).toHaveBeenCalledOnce();
	presented();
	tick(1017);
	expect(f.view.container.querySelectorAll("video")).toHaveLength(
		f.props.plan.clips.length,
	);
	const snapshot = f.reader()?.(f.clipId);
	expect(snapshot?.clipId).toBe(f.clipId);
	expect(snapshot?.mediaVersionId).toBe(f.props.plan.clips[0]?.mediaVersionId);
	expect(snapshot?.sourceFrame).toBe(f.props.plan.clips[0]?.sourceFromFrame);
	expect(snapshot?.width).toBe(1920);
	const captures = () =>
		drawImage.mock.calls.filter(
			(args) => args.length === 5 && args[0] instanceof HTMLVideoElement,
		);
	expect(captures()).toHaveLength(1);
	expect(f.reader()?.(f.clipId)).toBe(snapshot);
	tick(1034);
	tick(1067);
	expect(captures()).toHaveLength(1);
	expect(f.changed).toHaveBeenCalledTimes(2);
	expect(f.registration).toHaveBeenCalledOnce();
});

it("invalidates the reader immediately when the requested frame changes and reports the newly ready frame", () => {
	const f = fixture();
	tick(1000);
	presented();
	tick(1017);
	const read = f.reader();
	expect(read?.(f.clipId)).not.toBeNull();
	f.view.rerender(<CompositionPreview {...f.props} frame={1} />);
	expect(read?.(f.clipId)).toBeNull();
	tick(1034);
	expect(read?.(f.clipId)).toBeNull();
	const video = f.view.container.querySelector("video");
	if (!video) throw new Error("Missing video");
	fireEvent.seeked(video);
	presented();
	tick(1067);
	expect(read?.(f.clipId)?.sourceFrame).toBe(
		(f.props.plan.clips[0]?.sourceFromFrame ?? 0) + 1,
	);
	expect(f.reader()).toBe(read);
});

it("does not capture during playback, avoids per-frame notifications, and unregisters on unmount", async () => {
	const f = fixture();
	tick(1000);
	const read = f.reader();
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Play" }));
	});
	expect(read?.(f.clipId)).toBeNull();
	tick(2000);
	const notifications = f.changed.mock.calls.length;
	for (let time = 2034; time <= 2306; time += 34) tick(time);
	expect(f.changed).toHaveBeenCalledTimes(notifications);
	expect(
		drawImage.mock.calls.filter(
			(args) => args.length === 5 && args[0] instanceof HTMLVideoElement,
		),
	).toHaveLength(0);
	f.view.unmount();
	expect(f.registration).toHaveBeenLastCalledWith(null);
	expect(read?.(f.clipId)).toBeNull();
});

it("keeps the original source seek target when the capture reader props are absent", () => {
	const f = fixture(),
		{
			onSourceFrameReader: _reader,
			onSourceFrameAvailabilityChange: _changed,
			...legacy
		} = f.props;
	f.view.rerender(<CompositionPreview {...legacy} />);
	tick(1000);
	const video = f.view.container.querySelector("video");
	expect(video?.currentTime).toBe(
		(f.props.plan.clips[0]?.sourceFromFrame ?? 0) / 30,
	);
	expect(videoCallbacks.size).toBe(0);
});
