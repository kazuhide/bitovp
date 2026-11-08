import type { EditDocument } from "@bitovp/core";
import { act, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditingProjectView } from "@/lib/library-editing";
import { renderLocalized } from "@/test/render";
import { moveClip, removeClip } from "../edit-model";
import { editingProjectFixture } from "../editing-fixtures";
import { trimTimelineClip } from "../timeline-model";
import { EditorWorkbench } from "./editor-workbench";

const pause = vi.fn();
beforeEach(() => {
	pause.mockReset();
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause);
});
afterEach(() => vi.restoreAllMocks());

function editor(
	document: EditDocument,
	project = editingProjectFixture(),
	onChange = (_next: EditDocument) => {},
) {
	return (
		<EditorWorkbench
			project={project}
			document={document}
			disabled={false}
			rangePending={false}
			onChange={onChange}
			onRangePending={() => {}}
			onCandidates={async () => []}
			onAddCandidate={() => {}}
			onGenerate={() => {}}
			onCancel={() => {}}
			generationDisabled
		/>
	);
}
function source() {
	return screen.getByLabelText("Source material") as HTMLVideoElement;
}
function seek(frame: number) {
	fireEvent.change(
		screen.getByRole("slider", { name: "Timeline position (frames)" }),
		{ target: { value: String(frame) } },
	);
}

it("re-resolves the fixed output cursor after a visual IN trim", () => {
	function Harness() {
		const project = editingProjectFixture();
		const [document, setDocument] = useState(project.draft);
		return editor(document, project, setDocument);
	}
	renderLocalized(<Harness />);
	seek(150);
	expect(source().currentTime).toBe(5);
	const handle = screen.getByRole("slider", { name: "Trim start of range 1" });
	for (let index = 0; index < 3; index++)
		fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
	expect(handle).toHaveAttribute("aria-valuenow", "30");
	expect(screen.getByText("Output 00:05:00 · frame 150")).toBeInTheDocument();
	expect(source().currentTime).toBe(6);
});

function twoClips(): EditingProjectView {
	const project = editingProjectFixture();
	const first = project.draft.clips[0];
	if (!first) throw new Error("Missing clip");
	project.draft.clips = [
		{
			...first,
			durationFrames: 150,
			framing: [{ fromFrame: 0, toFrame: 150, mode: "FIT", origin: "MANUAL" }],
		},
		{
			...first,
			id: "77777777-7777-4777-8777-777777777777",
			sourceInUs: 10_000_000,
			timelineStartFrame: 150,
			framing: [
				{
					fromFrame: 0,
					toFrame: 300,
					mode: "CROP",
					origin: "MANUAL",
					manualOverride: true,
					rect: { x: 0.6, y: 0, w: 0.3, h: 1 },
				},
			],
		},
	];
	return project;
}

it("keeps the edited handle focused when repeated keyboard trims cross the output cursor", () => {
	const project = twoClips();
	const first = project.draft.clips[0];
	const second = project.draft.clips[1];
	if (!first || !second) throw new Error("Missing clips");
	first.durationFrames = 300;
	first.framing = [
		{ fromFrame: 0, toFrame: 300, mode: "FIT", origin: "MANUAL" },
	];
	second.timelineStartFrame = 300;
	function Harness() {
		const [document, setDocument] = useState(project.draft);
		return editor(document, project, setDocument);
	}
	renderLocalized(<Harness />);
	seek(299);
	const handle = screen.getByRole("slider", { name: "Trim end of range 1" });
	act(() => handle.focus());
	for (let index = 0; index < 3; index++) {
		fireEvent.keyDown(document.activeElement ?? document.body, {
			key: "ArrowLeft",
		});
		expect(handle).toHaveFocus();
		expect(screen.getByRole("slider", { name: "Trim end of range 1" })).toBe(
			handle,
		);
	}
	expect(handle).toHaveAttribute("aria-valuenow", "297");
	expect(
		screen.getByRole("button", { name: "Select range 1" }),
	).toHaveAttribute("aria-pressed", "true");
	expect(
		screen.getByRole("slider", { name: "Timeline position (frames)" }),
	).toHaveValue("299");
	expect(source().currentTime).toBe(302 / 30);
	fireEvent.change(screen.getByLabelText("Timeline zoom"), {
		target: { value: "4" },
	});
	expect(screen.getByRole("slider", { name: "Trim end of range 1" })).toBe(
		handle,
	);
	seek(400);
	expect(
		screen.getByRole("slider", { name: "Trim end of range 2" }),
	).toBeInTheDocument();
	fireEvent.change(screen.getByLabelText("Range to edit"), {
		target: { value: first.id },
	});
	fireEvent.click(screen.getByRole("button", { name: "Range 1" }));
	expect(
		screen.getByRole("slider", { name: "Trim end of range 1" }),
	).toBeInTheDocument();
});

it.each([
	"reorder",
	"remove",
])("updates the source and framing guide after %s and restoration", (operation) => {
	const project = twoClips();
	const original = project.draft;
	const view = renderLocalized(editor(original, project));
	seek(200);
	expect(source().currentTime).toBe(10 + 50 / 30);
	const changed =
		operation === "reorder"
			? moveClip(original, 1, -1)
			: removeClip(original, 0);
	view.rerender(editor(changed, project));
	expect(source().currentTime).toBe(10 + 200 / 30);
	expect(
		source().parentElement?.querySelector("[aria-hidden=true]"),
	).toHaveStyle({ left: "60%" });
	view.rerender(editor(original, project));
	expect(source().currentTime).toBe(10 + 50 / 30);
});

it("clamps the cursor and source when the output becomes shorter", () => {
	const project = editingProjectFixture();
	const map = project.media.timeMap;
	if (!map) throw new Error("Missing map");
	const view = renderLocalized(editor(project.draft, project));
	seek(299);
	view.rerender(
		editor(trimTimelineClip(project.draft, 0, "OUT", -150, map), project),
	);
	expect(
		screen.getByRole("slider", { name: "Timeline position (frames)" }),
	).toHaveValue("149");
	expect(source().currentTime).toBe(149 / 30);
	view.rerender(editor(project.draft, project));
	expect(
		screen.getByRole("slider", { name: "Timeline position (frames)" }),
	).toHaveValue("149");
});

it("retains framing-segment inspection and seeks the exact source frame", () => {
	const project = twoClips();
	const first = project.draft.clips[0];
	if (!first) throw new Error("Missing clip");
	first.framing = [
		{ fromFrame: 0, toFrame: 31, mode: "FIT", origin: "MANUAL" },
		{
			fromFrame: 31,
			toFrame: 150,
			mode: "CROP",
			origin: "MANUAL",
			rect: { x: 0.2, y: 0, w: 0.3, h: 1 },
		},
	];
	renderLocalized(editor(project.draft, project));
	fireEvent.change(screen.getByLabelText("Framing segment"), {
		target: { value: "1" },
	});
	expect(source().currentTime).toBe(31 / 30);
	expect(
		source().parentElement?.querySelector("[aria-hidden=true]"),
	).toHaveStyle({ left: "20%" });
});

it("does not reset normal source playback on unrelated project refreshes", () => {
	const project = editingProjectFixture();
	const view = renderLocalized(editor(project.draft, project));
	seek(150);
	source().currentTime = 12;
	pause.mockClear();
	view.rerender(editor(project.draft, structuredClone(project)));
	expect(source().currentTime).toBe(12);
	expect(pause).not.toHaveBeenCalled();
});

it("distinguishes a generated preview from newer unsaved edits and clears the warning after undo", () => {
	const project = editingProjectFixture();
	const map = project.media.timeMap;
	if (!map) throw new Error("Missing map");
	project.currentRevisionId = "55555555-5555-4555-8555-555555555555";
	project.currentRevisionMatchesDraft = true;
	project.renders = [
		{
			id: "render",
			revisionId: project.currentRevisionId,
			kind: "PREVIEW",
			state: "SUCCEEDED",
			generation: 1,
			error: null,
			artifact: {
				id: "artifact",
				url: "/preview.mp4",
				downloadUrl: "/download.mp4",
				derivedContentId: null,
			},
		},
	];
	const warning =
		"This generated preview belongs to an earlier edit. Save a confirmed revision and generate again to update it.";
	const view = renderLocalized(editor(project.draft, project));
	expect(screen.queryByText(warning)).not.toBeInTheDocument();
	view.rerender(
		editor(trimTimelineClip(project.draft, 0, "OUT", -30, map), project),
	);
	expect(screen.getByText(warning)).toBeInTheDocument();
	view.rerender(editor(project.draft, project));
	expect(screen.queryByText(warning)).not.toBeInTheDocument();
});
