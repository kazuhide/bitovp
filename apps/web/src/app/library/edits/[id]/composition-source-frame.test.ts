import {
	compileComposition,
	evaluateCompositionFrame,
	toCompositionDocument,
} from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { editingProjectFixture } from "../editing-fixtures";
import { CompositionSourceFrameBridge } from "./composition-source-frame";

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
	const current = { plan, frame: 0, playing: false };
	const state = () => evaluateCompositionFrame(current.plan, current.frame);
	const layer = state().layers[0];
	if (!layer) throw new Error("Missing clip");
	const callbacks = new Map<number, VideoFrameRequestCallback>();
	let handle = 0;
	const video = documentVideo();
	Object.defineProperties(video, {
		currentSrc: { configurable: true, get: () => video.src },
		currentTime: {
			configurable: true,
			value: layer.sourceSeconds,
			writable: true,
		},
		videoWidth: { configurable: true, value: 1920 },
		videoHeight: { configurable: true, value: 1080 },
		readyState: { configurable: true, value: 2, writable: true },
		seeking: { configurable: true, value: false, writable: true },
		paused: { configurable: true, value: true, writable: true },
	});
	video.src = "/same-prepared-source.mp4";
	video.requestVideoFrameCallback = (callback) => {
		callbacks.set(++handle, callback);
		return handle;
	};
	video.cancelVideoFrameCallback = (id) => {
		callbacks.delete(id);
	};
	const drawImage = vi.fn();
	const makeCanvas = vi.fn(
		() =>
			({
				width: 0,
				height: 0,
				getContext: () => ({ drawImage }),
			}) as unknown as HTMLCanvasElement,
	);
	const bridge = new CompositionSourceFrameBridge(() => current, makeCanvas);
	const videos = new Map([[layer.clipId, video]]),
		media = [{ id: project.media.id, url: "/same-prepared-source.mp4" }];
	const seek = vi.fn((element: HTMLVideoElement, time: number) => {
		element.dispatchEvent(new Event("seeking"));
		element.currentTime = time;
	});
	const sync = () =>
		bridge.update({
			plan: current.plan,
			state: state(),
			videos,
			media,
			playing: current.playing,
			baseUrl: window.location.href,
			seek,
		});
	const presented = (mediaTime: number) => {
		const pending = [...callbacks.values()];
		callbacks.clear();
		for (const callback of pending)
			callback(0, { mediaTime } as VideoFrameCallbackMetadata);
	};
	return {
		current,
		state,
		layer,
		video,
		videos,
		media,
		bridge,
		sync,
		presented,
		callbacks,
		drawImage,
		makeCanvas,
		seek,
	};
}
const documentVideo = () => document.createElement("video");

beforeEach(() => vi.restoreAllMocks());

describe("decoded source frame bridge", () => {
	it("copies only the requested source frame once, at native dimensions, and caches the image", () => {
		const f = fixture();
		expect(f.sync()).toBe(true);
		f.presented(f.layer.sourceSeconds);
		f.sync();
		const first = f.bridge.read(f.layer.clipId);
		expect(first).toMatchObject({
			clipId: f.layer.clipId,
			mediaVersionId: f.layer.mediaVersionId,
			sourceFrame: f.layer.sourceFrame,
			width: 1920,
			height: 1080,
		});
		expect(f.drawImage).toHaveBeenCalledExactlyOnceWith(
			f.video,
			0,
			0,
			1920,
			1080,
		);
		expect(f.bridge.read(f.layer.clipId)).toBe(first);
		expect(f.sync()).toBe(false);
		expect(f.makeCanvas).toHaveBeenCalledOnce();
		expect(f.bridge.read("another-clip")).toBeNull();
	});
	it("rejects stale plan/frame, seeking, mismatched source URLs and wrong decoded dimensions", () => {
		const f = fixture();
		f.sync();
		f.current.frame = 1;
		expect(f.bridge.read(f.layer.clipId)).toBeNull();
		f.current.frame = 0;
		Object.defineProperty(f.video, "seeking", { value: true });
		expect(f.bridge.read(f.layer.clipId)).toBeNull();
		Object.defineProperty(f.video, "seeking", { value: false });
		f.video.src = "/another-source.mp4";
		expect(f.bridge.read(f.layer.clipId)).toBeNull();
		f.video.src = "/same-prepared-source.mp4";
		Object.defineProperty(f.video, "videoWidth", { value: 1280 });
		expect(f.bridge.read(f.layer.clipId)).toBeNull();
		expect(f.drawImage).not.toHaveBeenCalled();
	});
	it("requires the presented frame to match after a seek instead of accepting currentTime alone", () => {
		const f = fixture();
		f.sync();
		f.presented(f.layer.sourceSeconds);
		f.sync();
		expect(f.bridge.read(f.layer.clipId)).not.toBeNull();
		f.current.frame = 1;
		f.video.dispatchEvent(new Event("seeking"));
		const next = f.state().layers[0];
		if (!next) throw new Error("Missing next frame");
		f.video.currentTime = next.sourceSeconds;
		f.video.dispatchEvent(new Event("seeked"));
		expect(f.sync()).toBe(true);
		expect(f.bridge.read(f.layer.clipId)).toBeNull();
		f.presented(f.layer.sourceSeconds);
		expect(f.bridge.read(f.layer.clipId)).toBeNull();
		f.presented(next.sourceSeconds);
		expect(f.sync()).toBe(true);
		expect(f.bridge.read(f.layer.clipId)?.sourceFrame).toBe(next.sourceFrame);
		expect(f.drawImage).toHaveBeenCalledTimes(2);
	});
	it("stops capture and availability churn while playing, then notifies once after pause", () => {
		const f = fixture();
		f.sync();
		f.current.playing = true;
		expect(f.bridge.read(f.layer.clipId)).toBeNull();
		expect(f.sync()).toBe(true);
		for (let frame = 1; frame < 20; frame++) {
			f.current.frame = frame;
			f.video.currentTime = f.state().layers[0]?.sourceSeconds ?? 0;
			f.presented(f.video.currentTime);
			expect(f.sync()).toBe(false);
		}
		expect(f.makeCanvas).not.toHaveBeenCalled();
		f.current.playing = false;
		expect(f.sync()).toBe(true);
		expect(f.bridge.read(f.layer.clipId)).not.toBeNull();
		expect(f.sync()).toBe(false);
	});
	it("invalidates a prior snapshot when its clip is removed and releases video callbacks", () => {
		const f = fixture();
		f.sync();
		f.presented(f.layer.sourceSeconds);
		f.sync();
		expect(f.bridge.read(f.layer.clipId)).not.toBeNull();
		f.videos.clear();
		f.sync();
		expect(f.bridge.read(f.layer.clipId)).toBeNull();
		expect(f.callbacks.size).toBe(0);
		f.bridge.clear();
		expect(f.bridge.read(f.layer.clipId)).toBeNull();
	});
	it("returns no image if a source canvas cannot be captured", () => {
		const f = fixture();
		f.sync();
		f.presented(f.layer.sourceSeconds);
		f.sync();
		f.drawImage.mockImplementation(() => {
			throw new DOMException("capture failed", "InvalidStateError");
		});
		expect(f.bridge.read(f.layer.clipId)).toBeNull();
	});
	it("rejects non-finite media times and re-notifies a newly evaluated paused plan", () => {
		const f = fixture();
		f.video.currentTime = Number.NaN;
		f.sync();
		expect(f.bridge.read(f.layer.clipId)).toBeNull();
		f.video.currentTime = f.layer.sourceSeconds;
		f.presented(f.layer.sourceSeconds);
		f.sync();
		f.current.plan = { ...f.current.plan };
		expect(f.bridge.read(f.layer.clipId)).toBeNull();
		expect(f.sync()).toBe(true);
		expect(f.bridge.read(f.layer.clipId)).not.toBeNull();
	});
	it("captures the requested crossfade clip rather than reusing the first active source", () => {
		const f = fixture(),
			document = structuredClone(f.current.plan.document),
			first = document.clips[0];
		if (!first) throw new Error("Missing clip");
		first.durationFrames = 30;
		first.framing = [
			{ fromFrame: 0, toFrame: 30, mode: "FIT", origin: "MANUAL" },
		];
		const nextId = "88888888-8888-4888-8888-888888888888";
		document.clips.push({
			...structuredClone(first),
			id: nextId,
			timelineStartFrame: 20,
			transitionIn: { type: "CROSSFADE", durationFrames: 10 },
		});
		f.current.plan = compileComposition(document, f.current.plan.sources);
		f.current.frame = 24;
		const layers = f.state().layers,
			next = layers.find((item) => item.clipId === nextId);
		if (!next) throw new Error("Missing incoming clip");
		f.video.currentTime =
			layers.find((item) => item.clipId === first.id)?.sourceSeconds ?? 0;
		const second = documentVideo();
		second.src = f.video.src;
		Object.defineProperties(second, {
			currentSrc: { configurable: true, get: () => second.src },
			currentTime: {
				configurable: true,
				value: next.sourceSeconds,
				writable: true,
			},
			videoWidth: { configurable: true, value: 1920 },
			videoHeight: { configurable: true, value: 1080 },
			readyState: { configurable: true, value: 2 },
			seeking: { configurable: true, value: false },
			paused: { configurable: true, value: true },
		});
		f.videos.set(nextId, second);
		f.sync();
		f.presented(f.video.currentTime);
		f.bridge.read(nextId);
		f.sync();
		second.dispatchEvent(new Event("seeked"));
		f.sync();
		expect(f.bridge.read(first.id)?.sourceFrame).toBe(
			layers.find((item) => item.clipId === first.id)?.sourceFrame,
		);
		expect(f.bridge.read(nextId)?.sourceFrame).toBe(next.sourceFrame);
		expect(f.drawImage.mock.calls.map(([source]) => source)).toEqual([
			f.video,
			second,
		]);
		f.current.frame = 30;
		f.sync();
		expect(f.bridge.read(first.id)).toBeNull();
	});
	it("uses decoded seeked readiness when video frame callbacks are unavailable", () => {
		const f = fixture();
		Reflect.deleteProperty(f.video, "requestVideoFrameCallback");
		f.sync();
		f.current.frame = 1;
		f.video.dispatchEvent(new Event("seeking"));
		f.video.currentTime = f.state().layers[0]?.sourceSeconds ?? 0;
		f.sync();
		expect(f.bridge.read(f.layer.clipId)).toBeNull();
		f.video.dispatchEvent(new Event("seeked"));
		f.sync();
		f.video.dispatchEvent(new Event("seeked"));
		expect(f.sync()).toBe(true);
		expect(f.bridge.read(f.layer.clipId)?.sourceFrame).toBe(
			f.layer.sourceFrame + 1,
		);
	});
	it("keeps an early read pending, nudges once inside the requested paused frame, and waits for its real metadata", () => {
		const f = fixture();
		f.current.frame = 5;
		const target = f.state().layers[0];
		if (!target) throw new Error("Missing target frame");
		f.video.currentTime = target.sourceSeconds;
		expect(f.bridge.read(target.clipId)).toBeNull();
		f.sync();
		expect(f.bridge.read(target.clipId)).toBeNull();
		expect(f.seek).toHaveBeenCalledExactlyOnceWith(
			f.video,
			target.sourceSeconds + 0.00001,
		);
		f.presented(target.sourceSeconds - 1 / 30);
		f.sync();
		expect(f.bridge.read(target.clipId)).toBeNull();
		expect(f.seek).toHaveBeenCalledOnce();
		f.presented(target.sourceSeconds);
		expect(f.sync()).toBe(true);
		expect(f.bridge.read(target.clipId)?.sourceFrame).toBe(target.sourceFrame);
		expect(f.drawImage).toHaveBeenCalledOnce();
	});
	it("never seeks without a read, and cancels an old request on frame, playback or source mismatch", () => {
		for (const change of ["none", "frame", "playing", "source"] as const) {
			const f = fixture();
			if (change !== "none") f.bridge.read(f.layer.clipId);
			if (change === "frame") f.current.frame = 1;
			if (change === "playing") f.current.playing = true;
			if (change === "source") f.video.src = "/another-source.mp4";
			f.sync();
			expect(f.seek).not.toHaveBeenCalled();
			expect(f.drawImage).not.toHaveBeenCalled();
			if (change === "source") {
				f.video.src = "/same-prepared-source.mp4";
				f.sync();
				expect(f.seek).not.toHaveBeenCalled();
			}
		}
	});
});
