import { compileComposition, toCompositionDocument } from "@bitovp/core";
import { act, fireEvent, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import { CompositionPreview } from "./composition-preview";

vi.mock("./source-crop-editor", () => ({
	SourceCropEditor: ({
		canvasRef,
		ready,
		playing,
		disabled,
		onStart,
	}: {
		canvasRef: RefObject<HTMLCanvasElement | null>;
		ready: boolean;
		playing: boolean;
		disabled: boolean;
		onStart: () => boolean;
	}) => (
		<>
			<canvas ref={canvasRef} aria-label="Original source" />
			<button
				type="button"
				disabled={!ready || playing || disabled}
				onClick={onStart}
			>
				Start crop
			</button>
		</>
	),
}));

const callbacks = new Map<number, FrameRequestCallback>();
const videoCallbacks = new Map<
	number,
	{ video: HTMLVideoElement; callback: VideoFrameRequestCallback }
>();
const paused = new WeakMap<HTMLMediaElement, boolean>();
const draws = new Map<HTMLCanvasElement, ReturnType<typeof vi.fn>>();
let handle = 0;
beforeEach(() => {
	handle = 0;
	callbacks.clear();
	videoCallbacks.clear();
	draws.clear();
	vi.stubGlobal("FontFace", undefined);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		callbacks.set(++handle, callback);
		return handle;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
		function (this: HTMLCanvasElement) {
			let drawImage = draws.get(this);
			if (!drawImage) {
				drawImage = vi.fn();
				draws.set(this, drawImage);
			}
			return {
				drawImage,
				fillRect() {},
				clearRect() {},
			} as unknown as CanvasRenderingContext2D;
		},
	);
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
	if (!project.media.timeMap) throw Error("Missing source clock");
	document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "FILL",
		captionPlacement: "OVERLAY",
	};
	const sources = [
		{
			mediaVersionId: project.media.id,
			width: 1920,
			height: 1080,
			hasAudio: true,
			timeMap: project.media.timeMap,
		},
	];
	const plan = compileComposition(document, sources);
	const controls = {
		clipId: document.clips[0]?.id ?? "",
		contextKey: "scene:frame:base",
		disabled: false,
		active: false,
		onStart: vi.fn(() => true),
		onPreview: vi.fn(),
		onCommit: vi.fn(),
		onCancel: vi.fn(),
	};
	const props = {
		plan,
		media: [project.media],
		imageAssets: [],
		frame: 0,
		onFrame: vi.fn(),
		sourceCrop: controls,
	};
	const view = renderLocalized(<CompositionPreview {...props} />);
	return { view, props, document, sources, controls };
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
function ready() {
	tick(1000);
	presented();
	tick(1017);
}

it("paints the full source and the cropped output from the same decoder", () => {
	const f = fixture();
	ready();
	const video = f.view.container.querySelector("video");
	const source = screen.getByLabelText<HTMLCanvasElement>("Original source");
	expect(f.view.container.querySelectorAll("video")).toHaveLength(
		f.props.plan.clips.length,
	);
	expect(draws.get(source)).toHaveBeenLastCalledWith(video, 0, 0, 640, 360);
	const croppedDraws = [...draws.values()]
		.flatMap((fn) => fn.mock.calls)
		.filter((args) => args.length === 9 && args[0] instanceof HTMLVideoElement);
	expect(croppedDraws.length).toBeGreaterThan(0);
	expect(croppedDraws.every((args) => args[0] === video)).toBe(true);
	expect(croppedDraws[0]?.[3]).toBeLessThan(1920);
});

it("waits for a decoded frame and keeps its attestation across its own geometry preview", () => {
	const f = fixture();
	expect(screen.getByRole("button", { name: "Start crop" })).toBeDisabled();
	ready();
	fireEvent.click(screen.getByRole("button", { name: "Start crop" }));
	expect(f.controls.onStart).toHaveBeenCalledOnce();
	const changed = structuredClone(f.document);
	if (!changed.clips[0]) throw Error("Missing clip");
	changed.clips[0].fallbackCrop = { x: 0.1, y: 0, w: 0.31640625, h: 1 };
	f.view.rerender(
		<CompositionPreview
			{...f.props}
			plan={compileComposition(changed, f.sources)}
			sourceCrop={{ ...f.controls, active: true }}
		/>,
	);
	tick(1034);
	expect(screen.getByRole("button", { name: "Start crop" })).toBeEnabled();
	expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
	expect(screen.getByRole("slider", { name: "Playhead" })).toBeDisabled();
});

it("invalidates source editing immediately after a seek or an external context change", () => {
	const f = fixture();
	ready();
	f.view.rerender(
		<CompositionPreview
			{...f.props}
			frame={1}
			sourceCrop={{ ...f.controls, contextKey: "scene:frame1:base" }}
		/>,
	);
	expect(screen.getByRole("button", { name: "Start crop" })).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Start crop" }));
	expect(f.controls.onStart).not.toHaveBeenCalled();
});

it("keeps drawing the source during playback while crop editing is disabled", async () => {
	fixture();
	ready();
	const source = screen.getByLabelText<HTMLCanvasElement>("Original source");
	const before = draws.get(source)?.mock.calls.length ?? 0;
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Play" }));
	});
	tick(2000);
	tick(2034);
	expect(draws.get(source)?.mock.calls.length).toBeGreaterThan(before);
	expect(screen.getByRole("button", { name: "Start crop" })).toBeDisabled();
});

it("revokes a held crop frame when media seeks at the same output position", () => {
	const f = fixture(),
		registration = vi.fn();
	f.view.rerender(
		<CompositionPreview
			{...f.props}
			frame={1}
			onSourceFrameReader={registration}
			sourceCrop={{ ...f.controls, contextKey: "scene:frame1:base" }}
		/>,
	);
	ready();
	expect(screen.getByRole("button", { name: "Start crop" })).toBeEnabled();
	fireEvent.click(screen.getByRole("button", { name: "Start crop" }));
	f.view.rerender(
		<CompositionPreview
			{...f.props}
			frame={1}
			onSourceFrameReader={registration}
			sourceCrop={{
				...f.controls,
				contextKey: "scene:frame1:base",
				active: true,
			}}
		/>,
	);
	const video = f.view.container.querySelector("video");
	if (!video) throw Error("Missing decoded media");
	video.currentTime = 1 / 30 - 0.01;
	fireEvent.seeking(video);
	fireEvent.seeked(video);
	tick(1034);
	const reader = registration.mock.calls.at(-1)?.[0];
	expect(reader?.(f.controls.clipId)).toBeNull();
	expect(screen.getByRole("button", { name: "Start crop" })).toBeDisabled();
	expect(f.controls.onCancel).toHaveBeenCalledOnce();
});

it("ignores an off-cue preload error until that clip enters the output", () => {
	const f = fixture(),
		first = f.document.clips[0];
	if (!first) throw Error("Missing first source");
	const second = {
		...first,
		id: "77777777-7777-4777-8777-777777777777",
		timelineStartFrame: 300,
		sourceInUs: 10_000_000,
	};
	const document = { ...f.document, clips: [...f.document.clips, second] };
	const plan = compileComposition(document, f.sources);
	f.view.rerender(<CompositionPreview {...f.props} plan={plan} />);
	ready();
	fireEvent.click(screen.getByRole("button", { name: "Start crop" }));
	f.view.rerender(
		<CompositionPreview
			{...f.props}
			plan={plan}
			sourceCrop={{ ...f.controls, active: true }}
		/>,
	);
	const video = f.view.container.querySelectorAll("video")[1];
	if (!video) throw Error("Missing off-cue source");
	Object.defineProperty(video, "error", {
		configurable: true,
		value: { code: 4, message: "preload failed" },
	});
	fireEvent.error(video);
	tick(1034);
	expect(screen.getByRole("button", { name: "Start crop" })).toBeEnabled();
	expect(f.controls.onCancel).not.toHaveBeenCalled();
	expect(
		screen.queryByText(
			"This media could not be previewed. Reload it before continuing.",
		),
	).not.toBeInTheDocument();
	f.view.rerender(
		<CompositionPreview
			{...f.props}
			plan={plan}
			frame={300}
			sourceCrop={{
				...f.controls,
				clipId: second.id,
				contextKey: "second-scene",
				active: false,
			}}
		/>,
	);
	tick(1067);
	expect(screen.getByRole("button", { name: "Start crop" })).toBeDisabled();
	expect(
		screen.getByText(
			"This media could not be previewed. Reload it before continuing.",
		),
	).toBeVisible();
});
