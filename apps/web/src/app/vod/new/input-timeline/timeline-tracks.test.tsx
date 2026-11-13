import type { VodInputTimelineDocument } from "@bitovp/core/vod-input-timeline";
import {
	act,
	cleanup,
	fireEvent,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { clipA, facts, splitId, timeline } from "./test-fixtures";
import { changeRange, moveClip, splitAt } from "./timeline-state";
import { TimelineTracks } from "./timeline-tracks";

let viewportWidth = 800;
const observers = new Set<ResizeObserverCallback>();
const changed = vi.fn();
const sought = vi.fn();

function widthOf(element: HTMLElement | null): number {
	if (!element) throw new Error("Timeline geometry element is missing");
	const width = element.style.width;
	if (width.endsWith("px")) return Number.parseFloat(width);
	if (width.endsWith("%"))
		return (Number.parseFloat(width) / 100) * widthOf(element.parentElement);
	return viewportWidth;
}

function clipWidth(name: string) {
	return widthOf(screen.getByRole("button", { name }).parentElement);
}

function viewportOf() {
	const viewport = screen.getByTestId("input-timeline-track").parentElement;
	if (!viewport) throw new Error("Timeline viewport is missing");
	return viewport;
}

function nativeScrollCanvas() {
	const canvas = screen.getByTestId("input-timeline-track");
	const viewport = viewportOf();
	let scrollLeft = 0;
	// A real browser clamps scrolling during layout when the scroll extent shrinks.
	Object.defineProperty(viewport, "scrollLeft", {
		configurable: true,
		get: () =>
			Math.min(scrollLeft, Math.max(0, widthOf(canvas) - viewportWidth)),
		set: (value: number) => {
			scrollLeft = Math.max(0, value);
		},
	});
	return { canvas, viewport };
}

function tracks(document: VodInputTimelineDocument, disabled = false) {
	return (
		<TimelineTracks
			document={document}
			facts={facts.map((source) => ({
				...source,
				video: source.video
					? { ...source.video, frameRate: { num: 30, den: 1 } }
					: null,
			}))}
			names={{ a: "A.mp4", b: "B.mp4" }}
			selectedId={clipA}
			positionMs={0}
			disabled={disabled}
			onSelect={() => {}}
			onSeek={sought}
			onChange={changed}
			onDelete={() => {}}
			onError={() => {}}
			onDragging={() => {}}
		/>
	);
}

beforeEach(() => {
	viewportWidth = 800;
	changed.mockReset();
	sought.mockReset();
	observers.clear();
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: ResizeObserverCallback) {
				observers.add(callback);
			}
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"PointerEvent",
		class extends MouseEvent {
			pointerId: number;
			constructor(type: string, init: PointerEventInit = {}) {
				super(type, init);
				this.pointerId = init.pointerId ?? 1;
			}
		},
	);
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
		function (this: HTMLElement) {
			return widthOf(this);
		},
	);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		function (this: HTMLElement) {
			const width = widthOf(this);
			const canvas = this.closest('[data-testid="input-timeline-track"]');
			const left = -(canvas?.parentElement?.scrollLeft ?? 0);
			return {
				x: left,
				y: 0,
				left,
				right: left + width,
				top: 0,
				bottom: 100,
				width,
				height: 100,
				toJSON: () => ({}),
			};
		},
	);
	HTMLElement.prototype.setPointerCapture = vi.fn();
	HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
	HTMLElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function pointerCaptures() {
	const owners = new Map<number, HTMLElement>();
	vi.mocked(HTMLElement.prototype.setPointerCapture).mockImplementation(
		function (this: HTMLElement, pointerId: number) {
			owners.set(pointerId, this);
		},
	);
	vi.mocked(HTMLElement.prototype.hasPointerCapture).mockImplementation(
		function (this: HTMLElement, pointerId: number) {
			return owners.get(pointerId) === this;
		},
	);
	vi.mocked(HTMLElement.prototype.releasePointerCapture).mockImplementation(
		function (this: HTMLElement, pointerId: number) {
			if (owners.get(pointerId) === this) owners.delete(pointerId);
		},
	);
	return owners;
}

it.each([
	{ name: "forward", clip: "Clip 1, A.mp4", from: 100, to: 700 },
	{ name: "backward", clip: "Clip 2, B.mp4", from: 700, to: 100 },
])("keeps $name reorder capture on the stable canvas while clip nodes move", ({
	clip,
	from,
	to,
}) => {
	const owners = pointerCaptures();
	renderLocalized(tracks(timeline()));
	const canvas = screen.getByTestId("input-timeline-track");
	const button = screen.getByRole("button", { name: clip });
	fireEvent.pointerDown(button, { pointerId: 1, button: 0, clientX: from });
	expect(owners.get(1)).toBe(canvas);
	fireEvent.pointerMove(canvas, { pointerId: 1, clientX: to });
	expect(screen.getByRole("button", { name: "Clip 1, B.mp4" })).toBeVisible();
	fireEvent.pointerUp(canvas, { pointerId: 1, clientX: to });
	expect(changed).toHaveBeenCalledTimes(1);
	expect(changed.mock.lastCall?.[0].videoClips[0].sourceKey).toBe("b");
	expect(changed.mock.lastCall?.[0].audioClips[0].sourceKey).toBe("b");
	expect(button).toHaveFocus();
	expect(owners.size).toBe(0);
});

it("restores clip focus when committing the reorder clears focus after pointer-up", () => {
	pointerCaptures();
	renderLocalized(tracks(timeline()));
	const canvas = screen.getByTestId("input-timeline-track");
	const button = screen.getByRole("button", { name: "Clip 1, A.mp4" });
	fireEvent.pointerDown(button, { pointerId: 1, button: 0, clientX: 100 });
	fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 700 });
	button.focus();
	expect(button).toHaveFocus();
	changed.mockImplementationOnce(() => button.blur());
	fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 700 });
	expect(changed).toHaveBeenCalledTimes(1);
	expect(button).toHaveFocus();
});

it("seeks once for a captured pointer tap and keeps keyboard clip activation", () => {
	pointerCaptures();
	renderLocalized(tracks(timeline()));
	const canvas = screen.getByTestId("input-timeline-track");
	const button = screen.getByRole("button", { name: "Clip 1, A.mp4" });
	fireEvent.pointerDown(button, { pointerId: 1, button: 0, clientX: 200 });
	fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 200 });
	fireEvent.click(canvas, { detail: 1, clientX: 200 });
	expect(sought).toHaveBeenCalledExactlyOnceWith(5000);
	expect(changed).not.toHaveBeenCalled();
	fireEvent.click(button, { detail: 0 });
	expect(sought).toHaveBeenLastCalledWith(0);
	expect(sought).toHaveBeenCalledTimes(2);
});

it.each([
	"pointercancel",
	"lostpointercapture",
	"Escape",
])("cancels stable capture for %s and never commits on later pointer-up", (reason) => {
	const owners = pointerCaptures();
	renderLocalized(tracks(timeline()));
	const canvas = screen.getByTestId("input-timeline-track");
	fireEvent.pointerDown(screen.getByRole("button", { name: "Clip 1, A.mp4" }), {
		pointerId: 1,
		button: 0,
		clientX: 100,
	});
	fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 700 });
	expect(screen.getByRole("button", { name: "Clip 1, B.mp4" })).toBeVisible();
	if (reason === "Escape") fireEvent.keyDown(canvas, { key: "Escape" });
	else if (reason === "pointercancel")
		fireEvent.pointerCancel(canvas, { pointerId: 1 });
	else fireEvent.lostPointerCapture(canvas, { pointerId: 1 });
	fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 700 });
	expect(screen.getByRole("button", { name: "Clip 1, A.mp4" })).toBeVisible();
	expect(changed).not.toHaveBeenCalled();
	expect(sought).not.toHaveBeenCalled();
	expect(owners.size).toBe(0);
});

it("does not treat a child's capture-loss event as losing the canvas's owned capture", () => {
	const owners = pointerCaptures();
	renderLocalized(tracks(timeline()));
	const canvas = screen.getByTestId("input-timeline-track");
	const button = screen.getByRole("button", { name: "Clip 1, A.mp4" });
	fireEvent.pointerDown(button, { pointerId: 1, button: 0, clientX: 100 });
	fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 700 });
	fireEvent.lostPointerCapture(button, { pointerId: 1 });
	expect(owners.get(1)).toBe(canvas);
	fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 700 });
	expect(changed).toHaveBeenCalledTimes(1);
});

it.each([
	"disabled",
	"document",
	"unmount",
])("releases stable capture on %s and discards its staged edit", (reason) => {
	const owners = pointerCaptures();
	const original = timeline();
	const view = renderLocalized(tracks(original));
	const canvas = screen.getByTestId("input-timeline-track");
	fireEvent.pointerDown(screen.getByRole("button", { name: "Clip 1, A.mp4" }), {
		pointerId: 1,
		button: 0,
		clientX: 100,
	});
	fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 700 });
	expect(screen.getByRole("button", { name: "Clip 1, B.mp4" })).toBeVisible();
	if (reason === "disabled") view.rerender(tracks(original, true));
	else if (reason === "document")
		view.rerender(tracks({ ...original, audioEnabled: false }));
	else view.unmount();
	fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 700 });
	expect(changed).not.toHaveBeenCalled();
	expect(owners.size).toBe(0);
});

it("does not steal focus from another control when a captured drag is canceled", () => {
	pointerCaptures();
	renderLocalized(
		<>
			{tracks(timeline())}
			<button type="button">Other control</button>
		</>,
	);
	const canvas = screen.getByTestId("input-timeline-track");
	fireEvent.pointerDown(screen.getByRole("button", { name: "Clip 1, A.mp4" }), {
		pointerId: 1,
		button: 0,
		clientX: 100,
	});
	fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 700 });
	const other = screen.getByRole("button", { name: "Other control" });
	other.focus();
	fireEvent.pointerCancel(canvas, { pointerId: 1 });
	expect(other).toHaveFocus();
	expect(changed).not.toHaveBeenCalled();
});

it("keeps pointer click seeking available when edits are disabled", () => {
	const owners = pointerCaptures();
	renderLocalized(tracks(timeline(), true));
	const button = screen.getByRole("button", { name: "Clip 1, A.mp4" });
	fireEvent.pointerDown(button, { pointerId: 1, button: 0, clientX: 200 });
	fireEvent.pointerUp(button, { pointerId: 1, clientX: 200 });
	fireEvent.click(button, { detail: 1, clientX: 200 });
	expect(sought).toHaveBeenCalledTimes(1);
	expect(changed).not.toHaveBeenCalled();
	expect(owners.size).toBe(0);
});

it("uses a fixed scale with an empty tail and keeps untrimmed clips steady through edits and history", () => {
	const original = timeline();
	const view = renderLocalized(tracks(original));
	expect(clipWidth("Clip 1, A.mp4")).toBeCloseTo(400);
	expect(clipWidth("Clip 2, B.mp4")).toBeCloseTo(600);
	expect(widthOf(screen.getByTestId("input-timeline-track"))).toBeCloseTo(1120);

	const trimmed = changeRange(original, clipA, 12_000, 20_000, facts);
	view.rerender(tracks(trimmed));
	expect(clipWidth("Clip 1, A.mp4")).toBeCloseTo(320);
	expect(clipWidth("Clip 2, B.mp4")).toBeCloseTo(600);

	const split = splitAt(trimmed, 4000, splitId);
	view.rerender(tracks(split));
	expect(clipWidth("Clip 1, A.mp4")).toBeCloseTo(160);
	expect(clipWidth("Clip 2, A.mp4")).toBeCloseTo(160);
	expect(clipWidth("Clip 3, B.mp4")).toBeCloseTo(600);
	view.rerender(tracks(moveClip(split, splitId, 2)));
	expect(clipWidth("Clip 2, B.mp4")).toBeCloseTo(600);
	view.rerender(tracks(original));
	expect(clipWidth("Clip 1, A.mp4")).toBeCloseTo(400);
	expect(clipWidth("Clip 2, B.mp4")).toBeCloseTo(600);
});

it("extends the scroll canvas for appended or lengthened clips without changing the time scale", () => {
	const original = timeline();
	const view = renderLocalized(tracks(original));
	view.rerender(
		tracks({
			...original,
			clips: [
				...original.clips,
				{ id: splitId, sourceKey: "a", inMs: 0, outMs: 60_000 },
			],
		}),
	);
	expect(clipWidth("Clip 1, A.mp4")).toBeCloseTo(400);
	expect(clipWidth("Clip 3, A.mp4")).toBeCloseTo(2400);
	expect(widthOf(screen.getByTestId("input-timeline-track"))).toBeCloseTo(3520);
	view.rerender(tracks(changeRange(original, clipA, 10_000, 40_000, facts)));
	expect(clipWidth("Clip 1, A.mp4")).toBeCloseTo(1200);
	expect(clipWidth("Clip 2, B.mp4")).toBeCloseTo(600);
	expect(widthOf(screen.getByTestId("input-timeline-track"))).toBeCloseTo(1920);
});

it("makes Fit an explicit snapshot while manual zoom remains fixed after trimming", () => {
	const original = timeline();
	const view = renderLocalized(tracks(original));
	fireEvent.click(screen.getByRole("button", { name: "Fit" }));
	expect(clipWidth("Clip 2, B.mp4")).toBeCloseTo(400);
	view.rerender(tracks(changeRange(original, clipA, 12_000, 20_000, facts)));
	expect(clipWidth("Clip 2, B.mp4")).toBeCloseTo(400);
	fireEvent.change(screen.getByRole("combobox", { name: "Timeline zoom" }), {
		target: { value: "4" },
	});
	expect(clipWidth("Clip 2, B.mp4")).toBeCloseTo(2400);
	view.rerender(tracks(original));
	expect(clipWidth("Clip 2, B.mp4")).toBeCloseTo(2400);
});

it("fits a short sequence together with its empty tail into the viewport", () => {
	const original = timeline();
	renderLocalized(
		tracks({
			...original,
			clips: [{ id: clipA, sourceKey: "a", inMs: 0, outMs: 9000 }],
		}),
	);
	fireEvent.click(screen.getByRole("button", { name: "Fit" }));
	expect(widthOf(screen.getByTestId("input-timeline-track"))).toBeCloseTo(800);
});

it("keeps the scale through an empty start, restored content and narrow viewport changes", () => {
	const original = timeline();
	const view = renderLocalized(tracks({ ...original, clips: [] }));
	expect(widthOf(screen.getByTestId("input-timeline-track"))).toBe(800);
	view.rerender(tracks(original));
	expect(clipWidth("Clip 1, A.mp4")).toBeCloseTo(400);
	act(() => {
		viewportWidth = 200;
		for (const callback of observers) callback([], {} as ResizeObserver);
	});
	expect(clipWidth("Clip 1, A.mp4")).toBeCloseTo(400);
	expect(widthOf(screen.getByTestId("input-timeline-track"))).toBeCloseTo(1120);
});

it("bounds ruler labels for a 24 hour sequence at maximum zoom and when scrolled", () => {
	const original = timeline();
	renderLocalized(
		tracks({
			...original,
			clips: [{ id: clipA, sourceKey: "a", inMs: 0, outMs: 86_400_000 }],
		}),
	);
	fireEvent.change(screen.getByRole("combobox", { name: "Timeline zoom" }), {
		target: { value: "8" },
	});
	const ruler = screen.getByRole("slider", { name: "Time ruler" });
	expect(ruler.querySelectorAll("span").length).toBeLessThan(20);
	expect(clipWidth("Clip 1, A.mp4")).toBeCloseTo(27_648_000);
	const viewport = viewportOf();
	fireEvent.scroll(viewport, { target: { scrollLeft: 27_647_200 } });
	expect(ruler.querySelectorAll("span").length).toBeGreaterThan(0);
	expect(ruler.querySelectorAll("span").length).toBeLessThan(20);
	expect(ruler.textContent).toContain("1440:");
});

it("seeks on a horizontally scrolled ruler, clamps the empty tail and retains keyboard seeking", () => {
	renderLocalized(tracks(timeline()));
	const ruler = screen.getByRole("slider", { name: "Time ruler" });
	const viewport = viewportOf();
	fireEvent.scroll(viewport, { target: { scrollLeft: 400 } });
	fireEvent.click(ruler, { clientX: 200, detail: 1 });
	expect(sought).toHaveBeenLastCalledWith(15_000);
	fireEvent.click(ruler, { clientX: 700, detail: 1 });
	expect(sought).toHaveBeenLastCalledWith(24_999);
	fireEvent.keyDown(ruler, { key: "End" });
	expect(sought).toHaveBeenLastCalledWith(24_999);
	fireEvent.keyDown(ruler, { key: "ArrowRight" });
	expect(sought).toHaveBeenLastCalledWith(1000);
});

it("trims by the fixed scale while scrolling and changing the preview canvas", () => {
	renderLocalized(tracks(timeline()));
	const viewport = viewportOf();
	const handle = screen.getByRole("slider", {
		name: "Trim end, A.mp4, clip 1",
	});
	fireEvent.scroll(viewport, { target: { scrollLeft: 300 } });
	fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 100 });
	fireEvent.pointerMove(handle, { pointerId: 1, clientX: 180 });
	expect(clipWidth("Clip 1, A.mp4")).toBeCloseTo(480);
	expect(clipWidth("Clip 2, B.mp4")).toBeCloseTo(600);
	fireEvent.scroll(viewport, { target: { scrollLeft: 340 } });
	fireEvent.pointerMove(handle, { pointerId: 1, clientX: 180 });
	expect(handle).toHaveAttribute("aria-valuenow", "23000");
	fireEvent.pointerUp(handle, { pointerId: 1, clientX: 180 });
	expect(changed).toHaveBeenCalledTimes(1);
	expect(changed.mock.lastCall?.[0].videoClips[0].outMs).toBe(23_000);
	expect(viewport.scrollLeft).toBe(340);
});

it("does not count native scroll clamping as more pointer motion when trimming the last out edge", () => {
	const original = timeline();
	const document = {
		...original,
		clips: [{ id: clipA, sourceKey: "a", inMs: 0, outMs: 8000 }],
	};
	const view = renderLocalized(tracks(document));
	fireEvent.change(screen.getByRole("combobox", { name: "Timeline zoom" }), {
		target: { value: "4" },
	});
	const { canvas, viewport } = nativeScrollCanvas();
	const before = widthOf(canvas);
	viewport.scrollLeft = before - viewportWidth;
	const handle = screen.getByRole("slider", {
		name: "Trim end, A.mp4, clip 1",
	});
	fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 320 });
	fireEvent.pointerMove(handle, { pointerId: 1, clientX: 256 });
	expect(handle).toHaveAttribute("aria-valuenow", "7600");
	fireEvent.pointerUp(handle, { pointerId: 1, clientX: 256 });
	expect(changed).toHaveBeenCalledTimes(1);
	const committed = changed.mock.lastCall?.[0];
	expect(committed.videoClips[0].outMs).toBe(7600);
	view.rerender(tracks(committed));
	expect(widthOf(canvas)).toBe(before - 64);
	expect(viewport.scrollLeft).toBe(before - 64 - viewportWidth);
});

it("holds the grown scroll extent when a trim grows, scrolls and reverses before release", () => {
	const original = timeline();
	const document = {
		...original,
		clips: [{ id: clipA, sourceKey: "a", inMs: 0, outMs: 6000 }],
	};
	const view = renderLocalized(tracks(document));
	fireEvent.change(screen.getByRole("combobox", { name: "Timeline zoom" }), {
		target: { value: "4" },
	});
	const { canvas, viewport } = nativeScrollCanvas();
	viewport.scrollLeft = widthOf(canvas) - viewportWidth;
	const handle = screen.getByRole("slider", {
		name: "Trim end, A.mp4, clip 1",
	});
	fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 320 });
	fireEvent.pointerMove(handle, { pointerId: 1, clientX: 480 });
	expect(handle).toHaveAttribute("aria-valuenow", "7000");
	const peakWidth = widthOf(canvas);
	viewport.scrollLeft = peakWidth - viewportWidth;
	fireEvent.pointerMove(handle, { pointerId: 1, clientX: 256 });
	expect(handle).toHaveAttribute("aria-valuenow", "6600");
	const reverseWidth = widthOf(canvas);
	fireEvent.pointerUp(handle, { pointerId: 1, clientX: 256 });
	expect(changed).toHaveBeenCalledTimes(1);
	const committed = changed.mock.lastCall?.[0];
	expect(committed.videoClips[0].outMs).toBe(6600);
	expect(reverseWidth).toBe(peakWidth);
	view.rerender(tracks(committed));
	expect(widthOf(canvas)).toBe(1536);
});

it("resets the retained extent after Escape, commit, and pointer cancellation before the next drag", () => {
	const original = timeline();
	const document = {
		...original,
		clips: [{ id: clipA, sourceKey: "a", inMs: 0, outMs: 6000 }],
	};
	const view = renderLocalized(tracks(document));
	fireEvent.change(screen.getByRole("combobox", { name: "Timeline zoom" }), {
		target: { value: "4" },
	});
	const { canvas } = nativeScrollCanvas();
	const handle = screen.getByRole("slider", {
		name: "Trim end, A.mp4, clip 1",
	});
	fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 100 });
	fireEvent.pointerMove(handle, { pointerId: 1, clientX: 260 });
	expect(widthOf(canvas)).toBe(1600);
	fireEvent.keyDown(handle, { key: "Escape" });
	expect(widthOf(canvas)).toBe(1440);
	expect(changed).not.toHaveBeenCalled();
	fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: 100 });
	fireEvent.pointerMove(handle, { pointerId: 2, clientX: 36 });
	expect(widthOf(canvas)).toBe(1440);
	fireEvent.pointerUp(handle, { pointerId: 2, clientX: 36 });
	expect(changed).toHaveBeenCalledTimes(1);
	view.rerender(tracks(changed.mock.lastCall?.[0]));
	expect(widthOf(canvas)).toBe(1376);
	fireEvent.pointerDown(handle, { pointerId: 3, button: 0, clientX: 100 });
	fireEvent.pointerMove(handle, { pointerId: 3, clientX: 260 });
	expect(widthOf(canvas)).toBe(1536);
	fireEvent.pointerCancel(handle, { pointerId: 3 });
	expect(widthOf(canvas)).toBe(1376);
	fireEvent.pointerDown(handle, { pointerId: 4, button: 0, clientX: 100 });
	fireEvent.pointerMove(handle, { pointerId: 4, clientX: 36 });
	expect(widthOf(canvas)).toBe(1376);
	fireEvent.pointerCancel(handle, { pointerId: 4 });
	expect(changed).toHaveBeenCalledTimes(1);
});

it("exposes named editing controls without an operation-help disclosure", () => {
	renderLocalized(tracks(timeline()));
	const region = screen.getByRole("region", { name: "Input timeline tracks" });
	expect(
		within(region).queryByText("Timeline controls"),
	).not.toBeInTheDocument();
	expect(region.querySelector("details")).toBeNull();
	expect(
		screen.getByRole("slider", { name: "Trim start, A.mp4, clip 1" }),
	).not.toHaveAttribute("aria-describedby");
});
