import { act, fireEvent, screen } from "@testing-library/react";
import { createRef, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import type { CropOverlayRect } from "./crop-overlay-geometry";
import {
	SourceCropEditor,
	type SourceCropEditorProps,
} from "./source-crop-editor";

const initial = { x: 0.25, y: 0.2, w: 0.25, h: 0.5 };
const started = vi.fn(() => true),
	previewed = vi.fn(),
	committed = vi.fn(),
	canceled = vi.fn();
const scheduled = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let imageBox = { left: 100, top: 50, width: 400, height: 200 };

function Harness(props: Partial<SourceCropEditorProps> = {}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [rect, setRect] = useState<CropOverlayRect>(initial);
	return (
		<SourceCropEditor
			canvasRef={canvasRef}
			sourceSize={{ width: 2000, height: 1000 }}
			rect={rect}
			ready
			playing={false}
			disabled={false}
			contextKey="clip1:frame0"
			onStart={started}
			onPreview={(next) => {
				previewed(next);
				setRect(next);
			}}
			onCommit={committed}
			onCancel={canceled}
			{...props}
		/>
	);
}
function flushFrames() {
	const callbacks = [...scheduled.values()];
	scheduled.clear();
	act(() => {
		for (const callback of callbacks) callback(0);
	});
}
const moveHandle = () =>
	screen.getByRole("button", { name: "切り抜き枠を移動" });
function down() {
	fireEvent.pointerDown(moveHandle(), {
		pointerId: 7,
		button: 0,
		clientX: 250,
		clientY: 140,
	});
}

beforeEach(() => {
	started.mockReset().mockReturnValue(true);
	previewed.mockReset();
	committed.mockReset();
	canceled.mockReset();
	scheduled.clear();
	nextFrame = 0;
	imageBox = { left: 100, top: 50, width: 400, height: 200 };
	class TestPointerEvent extends MouseEvent {
		pointerId: number;
		isPrimary: boolean;
		constructor(type: string, init: PointerEventInit = {}) {
			super(type, init);
			this.pointerId = init.pointerId ?? 1;
			this.isPrimary = init.isPrimary ?? true;
		}
	}
	vi.stubGlobal("PointerEvent", TestPointerEvent);
	vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
		const id = ++nextFrame;
		scheduled.set(id, callback);
		return id;
	});
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
		scheduled.delete(id);
	});
	vi.spyOn(
		HTMLCanvasElement.prototype,
		"getBoundingClientRect",
	).mockImplementation(() => ({
		...imageBox,
		right: imageBox.left + imageBox.width,
		bottom: imageBox.top + imageBox.height,
		x: imageBox.left,
		y: imageBox.top,
		toJSON() {},
	}));
	HTMLElement.prototype.setPointerCapture = vi.fn();
	HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
	HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("exposes one parent-owned source canvas and an accessible body plus four corners", () => {
	const canvasRef = createRef<HTMLCanvasElement>();
	const view = renderLocalized(<Harness canvasRef={canvasRef} />, "ja");
	expect(canvasRef.current).toBe(view.container.querySelector("canvas"));
	expect(view.container.querySelectorAll("canvas")).toHaveLength(1);
	expect(view.container.querySelectorAll("video")).toHaveLength(0);
	expect(view.container.querySelectorAll("[data-crop-handle]")).toHaveLength(5);
	expect(moveHandle()).toBeEnabled();
	expect(
		screen.getByRole("button", { name: "右下から切り抜き枠を拡縮" }),
	).toBeEnabled();
});

it("coalesces pointer previews, flushes the final position on release, and commits once", () => {
	renderLocalized(<Harness />, "ja");
	down();
	fireEvent.pointerMove(moveHandle(), {
		pointerId: 7,
		clientX: 270,
		clientY: 150,
	});
	fireEvent.pointerMove(moveHandle(), {
		pointerId: 7,
		clientX: 290,
		clientY: 160,
	});
	expect(previewed).not.toHaveBeenCalled();
	expect(scheduled.size).toBe(1);
	flushFrames();
	expect(previewed).toHaveBeenCalledOnce();
	expect(previewed.mock.calls[0]?.[0]).toEqual({
		...initial,
		x: 0.35,
		y: 0.30000000000000004,
	});
	fireEvent.pointerMove(moveHandle(), {
		pointerId: 7,
		clientX: 310,
		clientY: 180,
	});
	const stale = [...scheduled.values()][0];
	fireEvent.pointerUp(moveHandle(), {
		pointerId: 7,
		clientX: 310,
		clientY: 180,
	});
	expect(started).toHaveBeenCalledOnce();
	expect(committed).toHaveBeenCalledOnce();
	expect(committed.mock.calls[0]?.[0]).toEqual({ ...initial, x: 0.4, y: 0.4 });
	expect(previewed.mock.calls.at(-1)?.[0]).toEqual(
		committed.mock.calls[0]?.[0],
	);
	act(() => stale?.(0));
	expect(committed).toHaveBeenCalledOnce();
	expect(previewed).toHaveBeenCalledTimes(2);
});

it("draws only the parent's accepted rectangle even when a model clamps the request sooner", () => {
	renderLocalized(<Harness onPreview={previewed} />, "ja");
	down();
	fireEvent.pointerMove(moveHandle(), {
		pointerId: 7,
		clientX: 290,
		clientY: 160,
	});
	flushFrames();
	expect(previewed).toHaveBeenCalledOnce();
	expect(moveHandle()).toHaveStyle({
		left: "25%",
		top: "20%",
		width: "25%",
		height: "50%",
	});
});

it.each([
	"nw",
	"ne",
	"sw",
	"se",
])("keeps the aspect and source bounds when resizing %s", (corner) => {
	const view = renderLocalized(<Harness />, "ja");
	const handle = view.container.querySelector(`[data-crop-handle="${corner}"]`);
	if (!handle) throw Error("Missing corner");
	fireEvent.pointerDown(handle, {
		pointerId: 3,
		button: 0,
		clientX: 300,
		clientY: 190,
	});
	fireEvent.pointerMove(handle, { pointerId: 3, clientX: 340, clientY: 210 });
	fireEvent.pointerUp(handle, { pointerId: 3, clientX: 340, clientY: 210 });
	const rect = committed.mock.calls[0]?.[0] as CropOverlayRect;
	expect(rect.w / rect.h).toBeCloseTo(0.5, 12);
	expect(rect.x).toBeGreaterThanOrEqual(0);
	expect(rect.y).toBeGreaterThanOrEqual(0);
	expect(rect.x + rect.w).toBeLessThanOrEqual(1);
	expect(rect.y + rect.h).toBeLessThanOrEqual(1);
	expect(committed).toHaveBeenCalledOnce();
});

it.each([
	"Escape",
	"pointercancel",
	"lostpointercapture",
])("cancels pending pointer work on %s and rejects a late animation callback", (event) => {
	renderLocalized(<Harness />, "ja");
	down();
	fireEvent.pointerMove(moveHandle(), {
		pointerId: 7,
		clientX: 290,
		clientY: 160,
	});
	const stale = [...scheduled.values()][0];
	if (event === "Escape") fireEvent.keyDown(window, { key: "Escape" });
	else
		fireEvent(
			moveHandle(),
			new PointerEvent(event, { pointerId: 7, bubbles: true }),
		);
	act(() => stale?.(0));
	fireEvent.pointerUp(moveHandle(), {
		pointerId: 7,
		clientX: 290,
		clientY: 160,
	});
	expect(previewed).not.toHaveBeenCalled();
	expect(committed).not.toHaveBeenCalled();
	expect(canceled).toHaveBeenCalledOnce();
});

it.each([
	{ contextKey: "clip2:frame0" },
	{ disabled: true },
	{ playing: true },
	{ ready: false },
])("cancels a captured gesture when the editing context changes to %j", (props) => {
	const view = renderLocalized(<Harness />, "ja");
	down();
	fireEvent.pointerMove(moveHandle(), {
		pointerId: 7,
		clientX: 290,
		clientY: 160,
	});
	view.rerender(<Harness {...props} />);
	flushFrames();
	expect(committed).not.toHaveBeenCalled();
	expect(previewed).not.toHaveBeenCalled();
	expect(canceled).toHaveBeenCalledOnce();
});

it("does not cancel its own controlled rectangle updates and cancels only once on unmount", () => {
	const view = renderLocalized(<Harness />, "ja");
	down();
	fireEvent.pointerMove(moveHandle(), {
		pointerId: 7,
		clientX: 290,
		clientY: 160,
	});
	flushFrames();
	expect(canceled).not.toHaveBeenCalled();
	expect(moveHandle()).toHaveStyle({ left: "35%" });
	view.unmount();
	flushFrames();
	expect(canceled).toHaveBeenCalledOnce();
	expect(committed).not.toHaveBeenCalled();
});

it("rejects another pointer, refused start, and a no-op without publishing a commit", () => {
	renderLocalized(<Harness />, "ja");
	started.mockReturnValueOnce(false);
	down();
	expect(moveHandle().setPointerCapture).not.toHaveBeenCalled();
	down();
	fireEvent.pointerMove(moveHandle(), {
		pointerId: 99,
		clientX: 390,
		clientY: 190,
	});
	flushFrames();
	expect(previewed).not.toHaveBeenCalled();
	fireEvent.pointerUp(moveHandle(), {
		pointerId: 7,
		clientX: 250,
		clientY: 140,
	});
	expect(committed).not.toHaveBeenCalled();
	expect(canceled).toHaveBeenCalledOnce();
});

it("cancels when the rendered source box changes during a drag", () => {
	renderLocalized(<Harness />, "ja");
	down();
	imageBox = { ...imageBox, width: 200 };
	fireEvent.pointerMove(moveHandle(), {
		pointerId: 7,
		clientX: 290,
		clientY: 160,
	});
	expect(canceled).toHaveBeenCalledOnce();
	expect(committed).not.toHaveBeenCalled();
});

it("groups repeated keyboard moves and Shift steps into a single release commit", () => {
	renderLocalized(<Harness />, "ja");
	fireEvent.keyDown(moveHandle(), { key: "ArrowRight" });
	fireEvent.keyDown(moveHandle(), { key: "ArrowRight", repeat: true });
	fireEvent.keyDown(moveHandle(), { key: "ArrowDown", shiftKey: true });
	expect(committed).not.toHaveBeenCalled();
	fireEvent.keyUp(moveHandle(), { key: "ArrowDown" });
	expect(committed).toHaveBeenCalledOnce();
	expect(committed.mock.calls[0]?.[0].x).toBeCloseTo(0.251, 12);
	expect(committed.mock.calls[0]?.[0].y).toBeCloseTo(0.21, 12);
});

it("resizes with a keyboard corner and cancels a second keyboard gesture with Escape", () => {
	renderLocalized(<Harness />, "ja");
	const corner = screen.getByRole("button", {
		name: "右下から切り抜き枠を拡縮",
	});
	fireEvent.keyDown(corner, { key: "ArrowRight" });
	fireEvent.keyUp(corner, { key: "ArrowRight" });
	expect(committed).toHaveBeenCalledOnce();
	expect(committed.mock.calls[0]?.[0].w).toBeCloseTo(0.2505, 12);
	fireEvent.keyDown(corner, { key: "ArrowLeft" });
	fireEvent.keyDown(window, { key: "Escape" });
	fireEvent.keyUp(corner, { key: "ArrowLeft" });
	flushFrames();
	expect(committed).toHaveBeenCalledOnce();
	expect(canceled).toHaveBeenCalledOnce();
});

it.each([
	{ disabled: true },
	{ playing: true },
	{ ready: false },
])("retains the visible rectangle but prevents edits for %j", (props) => {
	const view = renderLocalized(<Harness {...props} />, "ja");
	const handle = view.container.querySelector('[data-crop-handle="move"]');
	if (handle) {
		expect(handle).toBeDisabled();
		fireEvent.pointerDown(handle, { pointerId: 7, button: 0 });
		fireEvent.keyDown(handle, { key: "ArrowRight" });
	}
	expect(started).not.toHaveBeenCalled();
	expect(committed).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "「元映像」の説明" }));
	expect(screen.getByRole("note")).toBeVisible();
	expect(started).not.toHaveBeenCalled();
});

it("shows a choose-clip state without a source and keeps help read-only", () => {
	renderLocalized(
		<Harness sourceSize={null} rect={null} ready={false} />,
		"ja",
	);
	expect(screen.getByText(/タイムラインで場面を選択/)).toBeVisible();
	expect(screen.queryByRole("button", { name: "切り抜き枠を移動" })).toBeNull();
	expect(started).not.toHaveBeenCalled();
});

it("keeps the parent canvas visible during playback without a paused-ready frame", () => {
	const view = renderLocalized(<Harness playing ready={false} />, "ja");
	expect(view.container.querySelector("canvas")).not.toHaveClass("invisible");
	expect(moveHandle()).toBeDisabled();
	expect(screen.queryByText("元映像のフレームを準備しています。")).toBeNull();
	expect(
		screen.getByText("一時停止すると切り抜きを調整できます。"),
	).toBeVisible();
});

it("shows the actual view without a loading message when this display is read-only", () => {
	const view = renderLocalized(<Harness disabled ready={false} />, "ja");
	expect(view.container.querySelector("canvas")).not.toHaveClass("invisible");
	expect(moveHandle()).toBeDisabled();
	expect(
		screen.getByText("この表示では切り抜き枠を変更できません。"),
	).toBeVisible();
	expect(screen.queryByText("元映像のフレームを準備しています。")).toBeNull();
});

describe("compact source crop tools", () => {
	const small = {
		x: 0.40375,
		y: 0.2966666666666667,
		w: 0.164375,
		h: 0.33444444444444443,
	};
	let resize: () => void;
	beforeEach(() => {
		imageBox = { left: 100, top: 50, width: 188, height: 105.75 };
		const callbacks = new Set<() => void>();
		class TestResizeObserver {
			private readonly emit: () => void;
			constructor(callback: ResizeObserverCallback) {
				this.emit = () => callback([], this);
				callbacks.add(this.emit);
			}
			observe() {}
			unobserve() {}
			disconnect() {
				callbacks.delete(this.emit);
			}
		}
		vi.stubGlobal("ResizeObserver", TestResizeObserver);
		resize = () =>
			act(() => {
				callbacks.forEach((callback) => {
					callback();
				});
			});
	});
	const renderSmall = (props: Partial<SourceCropEditorProps> = {}) =>
		renderLocalized(
			<Harness
				sourceSize={{ width: 1600, height: 900 }}
				rect={small}
				{...props}
			/>,
			"ja",
		);
	const tool = (name: string) => screen.getByRole("button", { name });

	it("gives the small real BBB body the whole move target and switches only local tools", () => {
		const view = renderSmall();
		expect(tool("移動")).toHaveAttribute("aria-pressed", "true");
		expect(tool("サイズ")).toHaveAttribute("aria-pressed", "false");
		expect(view.container.querySelectorAll("[data-crop-handle]")).toHaveLength(
			1,
		);
		expect(moveHandle()).toBeEnabled();
		const before = moveHandle().getAttribute("style");
		expect(
			screen.getByText("枠内をドラッグして移動。", { exact: true }),
		).toBeVisible();
		fireEvent.click(tool("サイズ"));
		expect(tool("サイズ")).toHaveAttribute("aria-pressed", "true");
		expect(moveHandle()).toBeDisabled();
		expect(moveHandle()).toHaveStyle({ pointerEvents: "none" });
		expect(view.container.querySelectorAll("[data-crop-handle]")).toHaveLength(
			5,
		);
		for (const corner of ["左上", "右上", "左下", "右下"]) {
			expect(tool(`${corner}から切り抜き枠を拡縮`)).toBeEnabled();
		}
		expect(
			screen.getByText("四隅をドラッグして拡縮。", { exact: true }),
		).toBeVisible();
		fireEvent.click(tool("移動"));
		expect(moveHandle().getAttribute("style")).toBe(before);
		expect(view.container.querySelectorAll("[data-crop-handle]")).toHaveLength(
			1,
		);
		expect(started).not.toHaveBeenCalled();
		expect(previewed).not.toHaveBeenCalled();
		expect(committed).not.toHaveBeenCalled();
		expect(canceled).not.toHaveBeenCalled();
	});

	it("keeps a compact body pointer gesture controlled and commits once", () => {
		renderSmall();
		down();
		fireEvent.pointerMove(moveHandle(), {
			pointerId: 7,
			clientX: 260,
			clientY: 140,
		});
		flushFrames();
		expect(moveHandle()).toHaveStyle({ left: "40.375%", width: "16.4375%" });
		expect(tool("サイズ")).toBeDisabled();
		fireEvent.click(tool("サイズ"));
		expect(tool("移動")).toHaveAttribute("aria-pressed", "true");
		fireEvent.pointerUp(moveHandle(), {
			pointerId: 7,
			clientX: 260,
			clientY: 140,
		});
		expect(committed).toHaveBeenCalledOnce();
		expect(committed.mock.calls[0]?.[0].x).toBeCloseTo(small.x + 10 / 188, 12);
		expect(canceled).not.toHaveBeenCalled();
	});

	it.each([
		"左上",
		"右上",
		"左下",
		"右下",
	])("resizes compact %s with one pointer commit while body input is blocked", (corner) => {
		renderSmall();
		fireEvent.click(tool("サイズ"));
		fireEvent.pointerDown(moveHandle(), { pointerId: 7, button: 0 });
		fireEvent.keyDown(moveHandle(), { key: "ArrowRight" });
		expect(started).not.toHaveBeenCalled();
		const handle = tool(`${corner}から切り抜き枠を拡縮`);
		fireEvent.pointerDown(handle, {
			pointerId: 8,
			button: 0,
			clientX: 200,
			clientY: 100,
		});
		fireEvent.pointerMove(handle, { pointerId: 8, clientX: 203, clientY: 102 });
		fireEvent.pointerUp(handle, { pointerId: 8, clientX: 203, clientY: 102 });
		expect(started).toHaveBeenCalledOnce();
		expect(committed).toHaveBeenCalledOnce();
		const next = committed.mock.calls[0]?.[0] as CropOverlayRect;
		expect(next.w / next.h).toBeCloseTo(small.w / small.h, 12);
	});

	it("keeps compact corner keyboard edits and Escape cancellation", () => {
		renderSmall();
		fireEvent.click(tool("サイズ"));
		const handle = tool("右下から切り抜き枠を拡縮");
		fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
		fireEvent.keyUp(handle, { key: "ArrowRight" });
		expect(committed).toHaveBeenCalledOnce();
		fireEvent.keyDown(handle, { key: "ArrowLeft" });
		const late = [...scheduled.values()][0];
		fireEvent.keyDown(window, { key: "Escape" });
		act(() => late?.(0));
		fireEvent.keyUp(handle, { key: "ArrowLeft" });
		expect(committed).toHaveBeenCalledOnce();
		expect(canceled).toHaveBeenCalledOnce();
	});

	it.each([
		{ disabled: true },
		{ playing: true },
		{ ready: false },
	])("prevents compact tool changes while unavailable: %j", (props) => {
		renderSmall(props);
		expect(tool("移動")).toBeDisabled();
		expect(tool("サイズ")).toBeDisabled();
		fireEvent.click(tool("サイズ"));
		expect(tool("移動")).toHaveAttribute("aria-pressed", "true");
		expect(started).not.toHaveBeenCalled();
		expect(committed).not.toHaveBeenCalled();
	});

	it("observes the source viewport and restores all five handles for a large ROI", () => {
		imageBox = { ...imageBox, width: 400, height: 200 };
		const view = renderLocalized(<Harness />, "ja");
		expect(screen.queryByRole("button", { name: "サイズ" })).toBeNull();
		expect(view.container.querySelectorAll("[data-crop-handle]")).toHaveLength(
			5,
		);
		imageBox = { ...imageBox, width: 200, height: 100 };
		resize();
		expect(tool("移動")).toHaveAttribute("aria-pressed", "true");
		expect(view.container.querySelectorAll("[data-crop-handle]")).toHaveLength(
			1,
		);
		imageBox = { ...imageBox, width: 400, height: 200 };
		resize();
		expect(screen.queryByRole("button", { name: "サイズ" })).toBeNull();
		expect(view.container.querySelectorAll("[data-crop-handle]")).toHaveLength(
			5,
		);
		expect(started).not.toHaveBeenCalled();
	});

	it("holds the tool layout during accepted resize previews and measures again after release", () => {
		imageBox = { ...imageBox, width: 300, height: 150 };
		const view = renderLocalized(<Harness />, "ja");
		fireEvent.click(tool("サイズ"));
		const handle = tool("右下から切り抜き枠を拡縮");
		fireEvent.pointerDown(handle, {
			pointerId: 8,
			button: 0,
			clientX: 200,
			clientY: 100,
		});
		fireEvent.pointerMove(handle, { pointerId: 8, clientX: 240, clientY: 140 });
		flushFrames();
		resize();
		expect(tool("サイズ")).toBeDisabled();
		expect(tool("サイズ")).toHaveAttribute("aria-pressed", "true");
		expect(view.container.querySelectorAll("[data-crop-handle]")).toHaveLength(
			5,
		);
		expect(canceled).not.toHaveBeenCalled();
		fireEvent.pointerUp(handle, { pointerId: 8, clientX: 240, clientY: 140 });
		expect(committed).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: "サイズ" })).toBeNull();
		expect(view.container.querySelectorAll("[data-crop-handle]")).toHaveLength(
			5,
		);
	});

	it("cancels compact pending work when the selected context changes", () => {
		const view = renderSmall();
		down();
		fireEvent.pointerMove(moveHandle(), {
			pointerId: 7,
			clientX: 260,
			clientY: 140,
		});
		const late = [...scheduled.values()][0];
		view.rerender(
			<Harness
				rect={small}
				sourceSize={{ width: 1600, height: 900 }}
				contextKey="clip2:frame0"
			/>,
		);
		act(() => late?.(0));
		expect(canceled).toHaveBeenCalledOnce();
		expect(committed).not.toHaveBeenCalled();
		expect(previewed).not.toHaveBeenCalled();
	});
});
