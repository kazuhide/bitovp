import type {
	VodInputTimelineTrack,
	VodInputTimelineV2Document,
} from "@bitovp/core/vod-input-timeline";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { clipA, clipB, facts, sequenceId } from "./test-fixtures";
import { TimelineTracks } from "./timeline-tracks";

const third = "10000000-0000-4000-8000-000000000011";
const audio = "10000000-0000-4000-8000-000000000012";
const wave = "10000000-0000-4000-8000-000000000013";
const changed = vi.fn(),
	sought = vi.fn(),
	failed = vi.fn();
function example(): VodInputTimelineV2Document {
	const first = { id: clipA, sourceKey: "a", startMs: 0, inMs: 0, outMs: 7689 };
	return {
		schemaVersion: 2,
		id: sequenceId,
		audioEnabled: true,
		durationMs: 34000,
		videoClips: [
			first,
			{ id: clipB, sourceKey: "b", startMs: 11347, inMs: 0, outMs: 8000 },
			{ id: third, sourceKey: "a", startMs: 19347, inMs: 11347, outMs: 18000 },
		],
		audioClips: [
			first,
			{ id: audio, sourceKey: "a", startMs: 11347, inMs: 11347, outMs: 18000 },
			{ id: wave, sourceKey: "b", startMs: 26000, inMs: 0, outMs: 8000 },
		],
	};
}
function clip(
	document: VodInputTimelineV2Document,
	track: VodInputTimelineTrack,
	id: string,
) {
	const found = document[track === "video" ? "videoClips" : "audioClips"].find(
		(c) => c.id === id,
	);
	if (!found) throw new Error("Fixture clip missing");
	return found;
}
function Editor({
	initial = example(),
	track = "video",
	id = clipB,
}: {
	initial?: VodInputTimelineV2Document;
	track?: VodInputTimelineTrack;
	id?: string;
}) {
	const [document, setDocument] = useState(initial);
	const [selection, select] = useState({ track, id });
	return (
		<TimelineTracks
			document={document}
			facts={facts}
			names={{ a: "A.mp4", b: "B.mp4" }}
			selectedId={selection.id}
			selectedTrack={selection.track}
			linked={false}
			positionMs={0}
			disabled={false}
			onSelect={(id, track) => select({ id, track })}
			onSeek={sought}
			onChange={(next) => {
				changed(next);
				setDocument(next);
			}}
			onDelete={() => {}}
			onError={failed}
			onDragging={() => {}}
		/>
	);
}
function body(id = clipB) {
	const element = screen
		.getByTestId("input-timeline-track")
		.querySelector<HTMLButtonElement>(
			`[data-clip-id="${id}"][data-clip-track="video"]`,
		);
	if (!element) throw new Error("Clip body missing");
	return element;
}
function startBody(track: VodInputTimelineTrack, id: string, from = 600) {
	const element = screen
		.getByTestId("input-timeline-track")
		.querySelector<HTMLButtonElement>(
			`[data-clip-id="${id}"][data-clip-track="${track}"]`,
		);
	if (!element) throw new Error("Clip body missing");
	fireEvent.pointerDown(element, { button: 0, pointerId: 1, clientX: from });
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
	failed.mockReset();
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
			const left = -(
				this.closest('[data-testid="input-timeline-track"]')?.parentElement
					?.scrollLeft ?? 0
			);
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
	{ track: "video" as const, id: clipB },
	{ track: "audio" as const, id: audio },
])("moves $track into a gap without crossing another clip's center", ({
	track,
	id,
}) => {
	const before = example();
	renderLocalized(<Editor initial={before} track={track} id={id} />);
	startBody(track, id);
	move(560);
	expect(changed).not.toHaveBeenCalled();
	up(560);
	const after = changed.mock.lastCall?.[0];
	expect(after).toBeDefined();
	expect(clip(after, track, id)).toEqual({
		...clip(before, track, id),
		startMs: 10347,
	});
	expect(after[track === "video" ? "audioClips" : "videoClips"]).toEqual(
		before[track === "video" ? "audioClips" : "videoClips"],
	);
	expect(after.durationMs).toBe(34000);
	expect(changed).toHaveBeenCalledTimes(1);
	expect(failed).not.toHaveBeenCalled();
});

it("moves A1 to the preceding cut while retaining the 11.658-second interior gap", () => {
	renderLocalized(<Editor track="audio" id={audio} />);
	startBody("audio", audio);
	move(600 - 3658 * 0.04);
	expect(screen.getByTestId("input-timeline-snap-guide")).toHaveAttribute(
		"data-snap-ms",
		"7689",
	);
	up(600 - 3658 * 0.04);
	const after = changed.mock.lastCall?.[0];
	expect(clip(after, "audio", audio)).toMatchObject({
		startMs: 7689,
		inMs: 11347,
		outMs: 18000,
	});
	expect(failed).not.toHaveBeenCalled();
});

it.each([
	{ raw: 7839, expected: 7689, guide: 7689 },
	{ raw: 9850, expected: 10000, guide: 18000 },
])("snaps either body edge at raw start $raw", ({ raw, expected, guide }) => {
	renderLocalized(<Editor />);
	startBody("video", clipB);
	const x = 600 + (raw - 11347) * 0.04;
	move(x);
	expect(screen.getByTestId("input-timeline-snap-guide")).toHaveAttribute(
		"data-snap-ms",
		String(guide),
	);
	up(x);
	expect(clip(changed.mock.lastCall?.[0], "video", clipB).startMs).toBe(
		expected,
	);
});

it("temporarily bypasses body snapping when Alt changes without pointer motion", () => {
	renderLocalized(<Editor />);
	startBody("video", clipB);
	const x = 600 + (9850 - 11347) * 0.04;
	move(x);
	expect(screen.getByTestId("input-timeline-snap-guide")).toHaveAttribute(
		"data-snap-ms",
		"18000",
	);
	fireEvent.keyDown(window, { key: "Alt", altKey: true });
	expect(
		screen.queryByTestId("input-timeline-snap-guide"),
	).not.toBeInTheDocument();
	fireEvent.keyUp(window, { key: "Alt", altKey: false });
	expect(screen.getByTestId("input-timeline-snap-guide")).toHaveAttribute(
		"data-snap-ms",
		"18000",
	);
	up(x, true);
	expect(clip(changed.mock.lastCall?.[0], "video", clipB).startMs).toBe(9850);
});

it("keeps a small pointer jitter a click, but does not seek after an activated drag returns", () => {
	renderLocalized(<Editor />);
	startBody("video", clipB);
	move(602);
	up(602);
	expect(changed).not.toHaveBeenCalled();
	expect(sought).toHaveBeenCalledTimes(1);
	sought.mockClear();
	startBody("video", clipB);
	move(640);
	move(600);
	up(600);
	expect(changed).not.toHaveBeenCalled();
	expect(sought).not.toHaveBeenCalled();
});

it("stages same-track overwrite and cancels it with Escape", () => {
	renderLocalized(<Editor />);
	startBody("video", clipB);
	move(600 + (7000 - 11347) * 0.04);
	expect(
		Number.parseFloat(body().parentElement?.style.left ?? "NaN") / 0.04,
	).toBeCloseTo(7000);
	fireEvent.keyDown(window, { key: "Escape" });
	up(600 + (7000 - 11347) * 0.04);
	expect(changed).not.toHaveBeenCalled();
	expect(
		Number.parseFloat(body().parentElement?.style.left ?? "NaN") / 0.04,
	).toBeCloseTo(11347);
});

it("lets an unselected wide clip's edge be grabbed directly", () => {
	renderLocalized(<Editor track="audio" id={wave} />);
	const handle = body(third).parentElement?.querySelector<HTMLElement>(
		'[role="slider"][aria-label^="Trim start,"]',
	);
	if (!handle) throw new Error("Unselected clip has no edge handle");
	expect(handle).toHaveAttribute("tabindex", "-1");
	fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 600 });
	move(600 - 1347 * 0.04);
	up(600 - 1347 * 0.04);
	const after = changed.mock.lastCall?.[0];
	expect(clip(after, "video", third)).toMatchObject({
		startMs: 18000,
		inMs: 10000,
		outMs: 18000,
	});
	expect(after.audioClips).toEqual(example().audioClips);
	expect(failed).not.toHaveBeenCalled();
});

it("explains source-zero and stops a left edge without inventing source frames", () => {
	renderLocalized(<Editor />);
	const handle = screen.getByRole("slider", {
		name: "Trim start, B.mp4, clip 2",
	});
	expect(handle).toHaveAttribute(
		"title",
		expect.stringMatching(/source start/i),
	);
	fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 600 });
	move(560);
	up(560);
	expect(failed).not.toHaveBeenCalled();
	if (changed.mock.lastCall)
		expect(clip(changed.mock.lastCall[0], "video", clipB)).toEqual(
			clip(example(), "video", clipB),
		);
});
