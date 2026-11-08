import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import { VisualTimeline } from "./visual-timeline";

const changed = vi.fn();
const pending = vi.fn();
const seek = vi.fn();

function Harness({ disabled = false, rangePending = false }) {
	const project = editingProjectFixture();
	const [document, setDocument] = useState(project.draft);
	const [selectedClipId, setSelectedClipId] = useState<string | null>(
		project.draft.clips[0]?.id ?? null,
	);
	return (
		<VisualTimeline
			document={document}
			map={project.media.timeMap}
			positionFrame={0}
			selectedClipId={selectedClipId}
			disabled={disabled}
			rangePending={rangePending}
			onSeek={seek}
			onSelectClip={setSelectedClipId}
			onPending={pending}
			onChange={(next) => {
				changed(next);
				setDocument(next);
			}}
		/>
	);
}

beforeEach(() => {
	changed.mockReset();
	pending.mockReset();
	seek.mockReset();
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
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		left: 0,
		right: 600,
		top: 0,
		bottom: 60,
		width: 600,
		height: 60,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	});
	HTMLElement.prototype.setPointerCapture = vi.fn();
	HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
	HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("keeps a moving playhead visible at high zoom and preserves a paused manual scroll", () => {
	const project = editingProjectFixture();
	function timeline(frame: number) {
		return (
			<VisualTimeline
				document={project.draft}
				map={project.media.timeMap}
				positionFrame={frame}
				selectedClipId={project.draft.clips[0]?.id ?? null}
				disabled={false}
				rangePending={false}
				onSeek={seek}
				onSelectClip={() => {}}
				onPending={pending}
				onChange={changed}
			/>
		);
	}
	const view = renderLocalized(timeline(0));
	const viewport = screen.getByRole("region", { name: "Output timeline" });
	const track = screen.getByTestId("timeline-track");
	Object.defineProperty(viewport, "clientWidth", { value: 200 });
	Object.defineProperty(track, "clientWidth", { value: 800 });
	fireEvent.change(screen.getByLabelText("Timeline zoom"), {
		target: { value: "4" },
	});
	view.rerender(timeline(240));
	const playhead = (240 / 300) * 800;
	expect(playhead).toBeGreaterThanOrEqual(viewport.scrollLeft);
	expect(playhead).toBeLessThanOrEqual(
		viewport.scrollLeft + viewport.clientWidth,
	);
	viewport.scrollLeft = 100;
	view.rerender(timeline(240));
	expect(viewport.scrollLeft).toBe(100);
});

it("seeks a clicked output frame in read-only mode without changing the edit", () => {
	renderLocalized(<Harness disabled />);
	fireEvent.click(screen.getByRole("button", { name: "Select range 1" }), {
		clientX: 300,
	});
	expect(seek).toHaveBeenCalledWith(150);
	expect(changed).not.toHaveBeenCalled();
	expect(
		screen.getByRole("slider", { name: "Trim end of range 1" }),
	).toHaveAttribute("aria-disabled", "true");
});

it("previews a frame-quantized drag and commits only once at pointerup", () => {
	renderLocalized(<Harness />);
	const handle = screen.getByRole("slider", { name: "Trim end of range 1" });
	fireEvent.pointerDown(handle, { pointerId: 7, clientX: 600, button: 0 });
	fireEvent.pointerMove(handle, { pointerId: 7, clientX: 580 });
	expect(changed).not.toHaveBeenCalled();
	expect(pending).toHaveBeenLastCalledWith(
		`timeline:${editingProjectFixture().draft.clips[0]?.id}`,
		true,
	);
	expect(handle).toHaveAttribute("aria-valuenow", "290");
	fireEvent.pointerUp(handle, { pointerId: 7, clientX: 580 });
	expect(changed).toHaveBeenCalledTimes(1);
	expect(changed.mock.calls[0]?.[0].clips[0].durationFrames).toBe(290);
	expect(pending).toHaveBeenLastCalledWith(
		`timeline:${editingProjectFixture().draft.clips[0]?.id}`,
		false,
	);
});

it.each([
	"Escape",
	"pointercancel",
	"lostpointercapture",
])("discards a drag on %s", (event) => {
	renderLocalized(<Harness />);
	const handle = screen.getByRole("slider", { name: "Trim end of range 1" });
	fireEvent.pointerDown(handle, { pointerId: 7, clientX: 600, button: 0 });
	fireEvent.pointerMove(handle, { pointerId: 7, clientX: 580 });
	if (event === "Escape") fireEvent.keyDown(window, { key: "Escape" });
	else
		fireEvent(handle, new PointerEvent(event, { pointerId: 7, bubbles: true }));
	expect(changed).not.toHaveBeenCalled();
	expect(handle).toHaveAttribute("aria-valuenow", "300");
	expect(pending).toHaveBeenLastCalledWith(
		`timeline:${editingProjectFixture().draft.clips[0]?.id}`,
		false,
	);
});

it.each([
	{ disabled: true },
	{ rangePending: true },
])("blocks trim for %j while retaining source seek", (props) => {
	renderLocalized(<Harness {...props} />);
	const handle = screen.getByRole("slider", { name: "Trim end of range 1" });
	fireEvent.pointerDown(handle, { pointerId: 7, clientX: 600, button: 0 });
	fireEvent.pointerMove(handle, { pointerId: 7, clientX: 580 });
	fireEvent.pointerUp(handle, { pointerId: 7, clientX: 580 });
	fireEvent.keyDown(handle, { key: "ArrowLeft" });
	expect(changed).not.toHaveBeenCalled();
	fireEvent.change(
		screen.getByRole("slider", { name: "Timeline position (frames)" }),
		{ target: { value: "29" } },
	);
	expect(seek).toHaveBeenCalledWith(29);
});

it("supports single-frame and larger keyboard trims, bounded Home/End, and zoom", () => {
	renderLocalized(<Harness />);
	const handle = screen.getByRole("slider", { name: "Trim end of range 1" });
	fireEvent.keyDown(handle, { key: "ArrowLeft" });
	expect(changed.mock.calls.at(-1)?.[0].clips[0].durationFrames).toBe(299);
	fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
	expect(changed.mock.calls.at(-1)?.[0].clips[0].durationFrames).toBe(289);
	fireEvent.keyDown(handle, { key: "Home" });
	expect(changed.mock.calls.at(-1)?.[0].clips[0].durationFrames).toBe(1);
	fireEvent.keyDown(handle, { key: "End" });
	expect(changed.mock.calls.at(-1)?.[0].clips[0].durationFrames).toBe(1800);
	fireEvent.change(screen.getByLabelText("Timeline zoom"), {
		target: { value: "4" },
	});
	expect(screen.getByTestId("timeline-track")).toHaveStyle({ width: "400%" });
});

it.each([
	{ disabled: true },
	{ rangePending: true },
])("drops a captured gesture if access or unapplied text changes: %j", (props) => {
	const view = renderLocalized(<Harness />);
	const handle = screen.getByRole("slider", { name: "Trim end of range 1" });
	fireEvent.pointerDown(handle, { pointerId: 7, clientX: 600, button: 0 });
	fireEvent.pointerMove(handle, { pointerId: 7, clientX: 580 });
	view.rerender(<Harness {...props} />);
	fireEvent.pointerUp(handle, { pointerId: 7, clientX: 580 });
	expect(changed).not.toHaveBeenCalled();
	expect(pending).toHaveBeenLastCalledWith(
		`timeline:${editingProjectFixture().draft.clips[0]?.id}`,
		false,
	);
});
