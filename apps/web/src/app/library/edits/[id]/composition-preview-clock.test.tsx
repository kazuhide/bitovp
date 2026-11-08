import { compileComposition, toCompositionDocument } from "@bitovp/core";
import { act, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import { CompositionPreview } from "./composition-preview";

const frames = vi.fn();
let ready = 3;
let nextHandle = 0;
const callbacks = new Map<number, FrameRequestCallback>();
const paused = new WeakMap<HTMLMediaElement, boolean>();
const closeAudio = vi.fn();
let sourceFrame = 0;
let requestedFrame = 0;
beforeEach(() => {
	ready = 3;
	nextHandle = 0;
	callbacks.clear();
	frames.mockReset();
	closeAudio.mockReset();
	sourceFrame = 0;
	requestedFrame = 0;
	vi.spyOn(performance, "now").mockReturnValue(2000);
	vi.stubGlobal("FontFace", undefined);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		const handle = ++nextHandle;
		callbacks.set(handle, callback);
		return handle;
	});
	vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
		callbacks.delete(handle),
	);
	vi.stubGlobal(
		"AudioContext",
		class {
			destination = {};
			resume = async () => {};
			close = closeAudio;
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
		() => ready,
	);
	vi.spyOn(HTMLMediaElement.prototype, "seeking", "get").mockReturnValue(false);
	// Isolate RAF arithmetic with media already at its requested source frame.
	// Native seek, buffering and pending-play races live in the playback suite.
	vi.spyOn(HTMLMediaElement.prototype, "currentTime", "get").mockImplementation(
		() => (sourceFrame + requestedFrame) / 30,
	);
	vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(
		function (this: HTMLMediaElement) {
			return paused.get(this) ?? true;
		},
	);
	vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
		async function (this: HTMLMediaElement) {
			paused.set(this, false);
		},
	);
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
		this: HTMLMediaElement,
	) {
		paused.set(this, true);
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function preview(durationFrames = 30) {
	const project = editingProjectFixture(),
		document = toCompositionDocument(project.draft);
	const clip = document.clips[0];
	if (!clip || !project.media.timeMap) throw new Error("Missing clock fixture");
	clip.durationFrames = durationFrames;
	clip.framing = [
		{ fromFrame: 0, toFrame: durationFrames, mode: "FIT", origin: "MANUAL" },
	];
	const plan = compileComposition(document, [
		{
			mediaVersionId: project.media.id,
			timeMap: project.media.timeMap,
			width: 1920,
			height: 1080,
			hasAudio: true,
		},
	]);
	sourceFrame = plan.clips[0]?.sourceFromFrame ?? 0;
	function Controlled() {
		const [frame, setFrame] = useState(0);
		return (
			<CompositionPreview
				plan={plan}
				media={[project.media]}
				imageAssets={[]}
				frame={frame}
				onFrame={(next) => {
					requestedFrame = next;
					frames(next);
					setFrame(next);
				}}
			/>
		);
	}
	return renderLocalized(<Controlled />);
}
async function play() {
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
const cursor = () =>
	Number(
		screen.getByRole("slider", { name: "Playhead" }).getAttribute("value"),
	);

it("uses its first RAF timestamp as the baseline even when it predates effect setup", async () => {
	preview();
	await play();
	await tick(1000);
	await tick(1000);
	expect(frames).not.toHaveBeenCalled();
	expect(cursor()).toBe(0);
	await tick(1100);
	expect(cursor()).toBe(3);
	expect(
		frames.mock.calls.every(
			([frame]) => Number.isSafeInteger(frame) && frame >= 0 && frame < 30,
		),
	).toBe(true);
	expect(callbacks.size).toBe(1);
});
it("never moves backwards or double-counts elapsed time when a timestamp regresses", async () => {
	preview();
	await play();
	await tick(2000);
	await tick(2000);
	await tick(2100);
	expect(cursor()).toBe(3);
	await tick(2080);
	expect(cursor()).toBe(3);
	await tick(2120);
	expect(cursor()).toBe(3);
	await tick(2140);
	expect(cursor()).toBe(4);
	expect(frames.mock.calls.map(([frame]) => frame)).toEqual([3, 4]);
});
it("keeps buffering and paused time out of progression and stops all callbacks on unmount", async () => {
	const view = preview();
	ready = 0;
	await play();
	await tick(2000);
	await tick(9000);
	expect(frames).not.toHaveBeenCalled();
	ready = 3;
	await tick(9100);
	await tick(9100);
	expect(cursor()).toBe(0);
	await tick(9200);
	expect(cursor()).toBe(3);
	fireEvent.click(screen.getByRole("button", { name: "Pause" }));
	await tick(20000);
	expect(cursor()).toBe(3);
	await play();
	await tick(30000);
	await tick(30000);
	expect(cursor()).toBe(3);
	await tick(30050);
	expect(cursor()).toBe(4);
	view.unmount();
	expect(callbacks.size).toBe(0);
	expect(closeAudio).toHaveBeenCalledOnce();
	expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
});
it("clamps the end and resumes a user seek without a negative or out-of-range frame", async () => {
	preview(6);
	await play();
	await tick(2000);
	await tick(2000);
	await tick(2100);
	await tick(2200);
	expect(cursor()).toBe(5);
	expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
	await tick(3000);
	expect(cursor()).toBe(5);
	fireEvent.change(screen.getByRole("slider", { name: "Playhead" }), {
		target: { value: "1" },
	});
	expect(cursor()).toBe(1);
	await play();
	await tick(1500);
	await tick(1500);
	expect(cursor()).toBe(1);
	await tick(1600);
	expect(cursor()).toBe(4);
	expect(frames.mock.calls.every(([frame]) => frame >= 0 && frame < 6)).toBe(
		true,
	);
});
