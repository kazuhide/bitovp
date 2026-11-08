import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";

vi.mock("./live-composition-preview", () => ({
	LiveCompositionPreview: ({
		onFrameChange,
		frame,
		seekSignal = 0,
	}: {
		onFrameChange: (frame: number) => void;
		frame: number;
		seekSignal?: number;
	}) => (
		<button
			type="button"
			data-testid="live-preview-bridge"
			data-frame={frame}
			data-seek-signal={seekSignal}
			onClick={() => onFrameChange(30)}
		>
			Report live playback frame
		</button>
	),
}));

import { EditorWorkbench } from "./editor-workbench";

afterEach(() => vi.restoreAllMocks());

it("gives a same-frame seek its own identity when playback notification and seek are batched", () => {
	const project = editingProjectFixture();
	renderLocalized(
		<EditorWorkbench
			project={project}
			document={project.draft}
			disabled={false}
			rangePending={false}
			onChange={() => {}}
			onRangePending={() => {}}
			onCandidates={async () => []}
			onAddCandidate={() => {}}
			onGenerate={() => {}}
			onCancel={() => {}}
			generationDisabled
		/>,
	);
	act(() => {
		fireEvent.click(
			screen.getByRole("button", { name: "Report live playback frame" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Select range 1" }), {
			clientX: 0,
		});
	});
	expect(screen.getByTestId("live-preview-bridge")).toHaveAttribute(
		"data-frame",
		"0",
	);
	expect(screen.getByTestId("live-preview-bridge")).toHaveAttribute(
		"data-seek-signal",
		"1",
	);
});

it("stops source playback even after its details panel is closed without seeking the hidden source", () => {
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
		this: HTMLMediaElement,
	) {
		Object.defineProperty(this, "paused", { configurable: true, value: true });
	});
	const project = editingProjectFixture();
	renderLocalized(
		<EditorWorkbench
			project={project}
			document={project.draft}
			disabled={false}
			rangePending={false}
			onChange={() => {}}
			onRangePending={() => {}}
			onCandidates={async () => []}
			onAddCandidate={() => {}}
			onGenerate={() => {}}
			onCancel={() => {}}
			generationDisabled
		/>,
	);
	const source = screen.getByLabelText("Source material") as HTMLVideoElement;
	const details = source.closest("details");
	if (!details) throw new Error("Missing source details");
	details.open = true;
	source.currentTime = 12;
	Object.defineProperty(source, "paused", { configurable: true, value: false });
	details.open = false;
	fireEvent.click(
		screen.getByRole("button", { name: "Report live playback frame" }),
	);
	expect(source.paused).toBe(true);
	expect(source.currentTime).toBe(12);
	expect(
		screen.getByRole("slider", { name: "Timeline position (frames)" }),
	).toHaveValue("30");
});
