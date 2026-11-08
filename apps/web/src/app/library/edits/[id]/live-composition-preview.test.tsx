import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import { LiveCompositionPreview } from "./live-composition-preview";

const drawImage = vi.fn();
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
	drawImage.mockReset();
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		clearRect: vi.fn(),
		fillRect: vi.fn(),
		drawImage,
	} as unknown as CanvasRenderingContext2D);
});

it("seeks the controlled output frame and paints its source crop", () => {
	const p = editingProjectFixture();
	const notify = vi.fn();
	renderLocalized(
		<LiveCompositionPreview
			document={p.draft}
			media={p.media}
			frame={30}
			onFrameChange={notify}
			blocked={false}
		/>,
	);
	const video = document.querySelector("video");
	if (!video) throw new Error("video");
	Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
	fireEvent.loadedMetadata(video);
	expect(video.currentTime).toBe(1);
	fireEvent.seeked(video);
	expect(drawImage).toHaveBeenCalledWith(
		video,
		0,
		0,
		1920,
		1080,
		0,
		656,
		1080,
		608,
	);
	expect(notify).not.toHaveBeenCalled();
});

it("shows unavailable media without attempting transport", () => {
	const p = editingProjectFixture();
	renderLocalized(
		<LiveCompositionPreview
			document={p.draft}
			media={{ ...p.media, state: "PENDING", url: null }}
			frame={0}
			onFrameChange={() => {}}
			blocked={false}
		/>,
	);
	expect(
		screen.getByText("Prepare editing material to preview the edit.", {
			selector: "p",
		}),
	).toHaveTextContent("Prepare editing material to preview the edit.");
	expect(drawImage).not.toHaveBeenCalled();
});

it("steps and seeks without changing the document, and confines shortcuts to the player", () => {
	const p = editingProjectFixture();
	const original = JSON.stringify(p.draft);
	const notify = vi.fn();
	const view = renderLocalized(
		<>
			<label>
				Outside field
				<input />
			</label>
			<LiveCompositionPreview
				document={p.draft}
				media={p.media}
				frame={0}
				onFrameChange={notify}
				blocked={false}
			/>
		</>,
	);
	const video = screen.getByTestId("live-preview-video") as HTMLVideoElement;
	Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
	fireEvent.loadedMetadata(video);
	fireEvent.keyDown(screen.getByLabelText("Outside field"), {
		key: "ArrowRight",
	});
	expect(notify).not.toHaveBeenCalled();
	const player = screen.getByRole("button", { name: "Live edit preview" });
	fireEvent.keyDown(player, { key: "ArrowRight" });
	expect(notify).toHaveBeenLastCalledWith(1);
	fireEvent.click(screen.getByRole("button", { name: "Go to first frame" }));
	expect(notify).toHaveBeenLastCalledWith(0);
	expect(JSON.stringify(p.draft)).toBe(original);
	notify.mockClear();
	view.rerender(
		<LiveCompositionPreview
			document={p.draft}
			media={p.media}
			frame={30}
			onFrameChange={notify}
			blocked
		/>,
	);
	fireEvent.loadedMetadata(screen.getByTestId("live-preview-video"));
	expect(screen.getByRole("button", { name: "Next frame" })).toBeDisabled();
	expect(notify).not.toHaveBeenCalled();
});

it("applies an explicit same-frame seek command before a controlled playback update commits", () => {
	const p = editingProjectFixture();
	const notify = vi.fn();
	const props = {
		document: p.draft,
		media: p.media,
		frame: 0,
		onFrameChange: notify,
		blocked: false,
	};
	const view = renderLocalized(
		<LiveCompositionPreview {...props} seekSignal={0} />,
	);
	const video = screen.getByTestId("live-preview-video") as HTMLVideoElement;
	Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
	fireEvent.loadedMetadata(video);
	fireEvent.click(screen.getByRole("button", { name: "Next frame" }));
	expect(video.currentTime).toBe(1 / 30);
	expect(notify).toHaveBeenLastCalledWith(1);
	const notified = notify.mock.calls.length;
	view.rerender(<LiveCompositionPreview {...props} seekSignal={1} />);
	expect(video.currentTime).toBe(0);
	expect(notify).toHaveBeenCalledTimes(notified);
});
