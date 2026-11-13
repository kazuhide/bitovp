import type {
	VodInputTimelineSourceFacts,
	VodInputTimelineTrack,
	VodInputTimelineV2Document,
} from "@bitovp/core/vod-input-timeline";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { clipA, clipB, facts, sequenceId } from "./test-fixtures";
import { TimelineTracks } from "./timeline-tracks";

const changed = vi.fn();
const sought = vi.fn();
const boundary = 4015;
function documentFor(track: VodInputTimelineTrack): VodInputTimelineV2Document {
	const full = { id: clipA, sourceKey: "a", startMs: 0, inMs: 0, outMs: 8000 };
	const split = [
		{ ...full, outMs: boundary },
		{
			id: clipB,
			sourceKey: "b",
			startMs: boundary,
			inMs: 0,
			outMs: 8000 - boundary,
		},
	];
	return {
		schemaVersion: 2,
		id: sequenceId,
		audioEnabled: true,
		durationMs: 8000,
		videoClips: track === "video" ? [full] : split,
		audioClips: track === "audio" ? [full] : split,
	};
}
function editor(
	track: VodInputTimelineTrack = "audio",
	document = documentFor(track),
	sources: VodInputTimelineSourceFacts[] = facts,
	disabled = false,
	linked = false,
) {
	return (
		<TimelineTracks
			document={document}
			facts={sources}
			names={{ a: "A.mp4", b: "B.mp4" }}
			selectedId={clipA}
			selectedTrack={track}
			linked={linked}
			positionMs={0}
			disabled={disabled}
			onChange={changed}
			onSeek={sought}
			onSelect={() => {}}
			onDelete={() => {}}
			onError={() => {}}
			onDragging={() => {}}
		/>
	);
}
function handle(track: VodInputTimelineTrack, edge = "end") {
	return screen.getByRole("slider", {
		name: `Trim ${edge}, A.mp4, ${track === "audio" ? "audio clip" : "clip"} 1`,
	});
}
function down(target: HTMLElement, x: number) {
	fireEvent.pointerDown(target, { pointerId: 1, button: 0, clientX: x });
}
function move(x: number, altKey = false) {
	fireEvent.pointerMove(screen.getByTestId("input-timeline-track"), {
		pointerId: 1,
		clientX: x,
		altKey,
	});
}
function up(x: number, altKey = false) {
	fireEvent.pointerUp(screen.getByTestId("input-timeline-track"), {
		pointerId: 1,
		clientX: x,
		altKey,
	});
}
beforeEach(() => {
	changed.mockReset();
	sought.mockReset();
	vi.stubGlobal(
		"ResizeObserver",
		class {
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
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		function (this: HTMLElement) {
			const canvas = this.closest('[data-testid="input-timeline-track"]');
			const left = -(canvas?.parentElement?.scrollLeft ?? 0);
			return {
				x: left,
				y: 0,
				left,
				right: left + 800,
				top: 0,
				bottom: 100,
				width: 800,
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

it.each([
	"audio",
	"video",
] as const)("snaps %s end exactly to the opposite cut and commits only the edited track", (track) => {
	const original = documentFor(track);
	renderLocalized(editor(track, original));
	expect(
		screen.getByRole("button", { name: "Snap to boundaries" }),
	).toHaveAttribute("aria-pressed", "true");
	down(handle(track), 320);
	move(156);
	expect(handle(track)).toHaveAttribute("aria-valuenow", String(boundary));
	expect(screen.getByTestId("input-timeline-snap-guide")).toHaveAttribute(
		"data-snap-ms",
		String(boundary),
	);
	expect(screen.getByTestId("input-timeline-snap-guide")).toHaveTextContent(
		"0:04.015",
	);
	expect(changed).not.toHaveBeenCalled();
	up(156);
	expect(changed).toHaveBeenCalledTimes(1);
	const result = changed.mock.lastCall?.[0];
	expect(result[track === "audio" ? "audioClips" : "videoClips"][0].outMs).toBe(
		boundary,
	);
	const untouched = track === "audio" ? "videoClips" : "audioClips";
	expect(result[untouched]).toEqual(original[untouched]);
	expect(result.durationMs).toBe(8000);
	expect(
		screen.queryByTestId("input-timeline-snap-guide"),
	).not.toBeInTheDocument();
});

it.each([
	"audio",
	"video",
] as const)("snaps %s start without moving its opposite track", (track) => {
	renderLocalized(editor(track));
	down(handle(track, "start"), 0);
	move(164);
	up(164);
	const clip =
		changed.mock.lastCall?.[0][
			track === "audio" ? "audioClips" : "videoClips"
		][0];
	expect(clip).toMatchObject({
		startMs: boundary,
		inMs: boundary,
		outMs: 8000,
	});
});

it("temporarily releases and restores a snap when Alt changes without pointer motion", () => {
	renderLocalized(editor());
	down(handle("audio"), 320);
	move(156);
	expect(handle("audio")).toHaveAttribute("aria-valuenow", String(boundary));
	fireEvent.keyDown(window, { key: "Alt", altKey: true });
	expect(handle("audio")).toHaveAttribute("aria-valuenow", "3900");
	expect(
		screen.queryByTestId("input-timeline-snap-guide"),
	).not.toBeInTheDocument();
	fireEvent.keyUp(window, { key: "Alt", altKey: false });
	expect(handle("audio")).toHaveAttribute("aria-valuenow", String(boundary));
	up(156, true);
	expect(changed.mock.lastCall?.[0].audioClips[0].outMs).toBe(3900);
});

it("lets pointer Alt and the explicit toggle bypass snapping", () => {
	renderLocalized(editor());
	down(handle("audio"), 320);
	move(156, true);
	up(156, true);
	expect(changed.mock.lastCall?.[0].audioClips[0].outMs).toBe(3900);
	fireEvent.click(screen.getByRole("button", { name: "Snap to boundaries" }));
	expect(
		screen.getByRole("button", { name: "Snap to boundaries" }),
	).toHaveAttribute("aria-pressed", "false");
	down(handle("audio"), 320);
	move(156);
	up(156);
	expect(changed.mock.lastCall?.[0].audioClips[0].outMs).toBe(3900);
	expect(
		screen.queryByTestId("input-timeline-snap-guide"),
	).not.toBeInTheDocument();
});

it("holds the acquired boundary for twelve pixels then releases it", () => {
	renderLocalized(editor());
	down(handle("audio"), 320);
	move(156);
	move(170);
	expect(handle("audio")).toHaveAttribute("aria-valuenow", String(boundary));
	move(174);
	expect(handle("audio")).toHaveAttribute("aria-valuenow", "4350");
	expect(
		screen.queryByTestId("input-timeline-snap-guide"),
	).not.toBeInTheDocument();
});

it("does not draw an unreachable boundary beyond the actual source duration", () => {
	const document = documentFor("audio");
	document.audioClips = document.audioClips.map((clip) => ({
		...clip,
		outMs: 3000,
	}));
	const sources = facts.map((source) => ({
		...source,
		audio: { streamIndex: 1, sampleRate: 48000, channels: 2, durationMs: 3900 },
	}));
	renderLocalized(editor("audio", document, sources));
	down(handle("audio"), 120);
	move(159.2);
	expect(handle("audio")).toHaveAttribute("aria-valuenow", "3900");
	expect(
		screen.queryByTestId("input-timeline-snap-guide"),
	).not.toBeInTheDocument();
});

it.each([
	"Escape",
	"pointercancel",
	"disabled",
	"document",
])("clears the guide and staged edit on %s", (reason) => {
	const document = documentFor("audio");
	const view = renderLocalized(editor("audio", document));
	down(handle("audio"), 320);
	move(156);
	expect(screen.getByTestId("input-timeline-snap-guide")).toBeVisible();
	if (reason === "Escape") fireEvent.keyDown(window, { key: "Escape" });
	else if (reason === "pointercancel")
		fireEvent.pointerCancel(screen.getByTestId("input-timeline-track"), {
			pointerId: 1,
		});
	else
		view.rerender(
			editor(
				"audio",
				reason === "document" ? { ...document, durationMs: 9000 } : document,
				facts,
				reason === "disabled",
			),
		);
	expect(
		screen.queryByTestId("input-timeline-snap-guide"),
	).not.toBeInTheDocument();
	expect(changed).not.toHaveBeenCalled();
});

it("snaps ruler clicks but preserves Alt, keyboard and slider precision", () => {
	renderLocalized(editor());
	const ruler = screen.getByRole("slider", { name: "Time ruler" });
	fireEvent.click(ruler, { clientX: 156, detail: 1 });
	expect(sought).toHaveBeenLastCalledWith(boundary);
	fireEvent.click(ruler, { clientX: 156, detail: 1, altKey: true });
	expect(sought).toHaveBeenLastCalledWith(3900);
	fireEvent.keyDown(ruler, { key: "ArrowRight" });
	expect(sought).toHaveBeenLastCalledWith(1000);
	fireEvent.change(screen.getByRole("slider", { name: "Sequence position" }), {
		target: { value: "3910" },
	});
	expect(sought).toHaveBeenLastCalledWith(3910);
	fireEvent.keyDown(handle("audio"), { key: "ArrowLeft" });
	expect(changed.mock.lastCall?.[0].audioClips[0].outMs).toBe(7999);
});

it("measures ruler snap distance from the pointer before clamping the empty tail", () => {
	const document = documentFor("audio");
	document.videoClips = document.videoClips.map((clip, index) =>
		index === 0
			? { ...clip, outMs: 7900 }
			: { ...clip, startMs: 7900, outMs: 100 },
	);
	renderLocalized(editor("audio", document));
	fireEvent.click(screen.getByRole("slider", { name: "Time ruler" }), {
		clientX: 400,
		detail: 1,
	});
	expect(sought).toHaveBeenLastCalledWith(7999);
});
