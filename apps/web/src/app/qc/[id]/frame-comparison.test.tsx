import { computePooled } from "@bitovp/core";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import type { VmafResultDetail } from "../vmaf-shared";
import { FrameComparison } from "./frame-comparison";

vi.mock("./frame-chart", () => ({
	FrameChart: ({
		onFrameSelect,
	}: {
		onFrameSelect: (frame: number) => void;
	}) => (
		<button type="button" onClick={() => onFrameSelect(48)}>
			Chart frame 48
		</button>
	),
}));
const frames = [
	{ frameNum: 0, vmaf: 90 },
	{ frameNum: 240, vmaf: 85 },
];
const results: VmafResultDetail[] = [3, 1, 2].map((n) => ({
	id: `r${n}`,
	renditionRef: { bitrate: n * 1000, label: `Rung ${n}` },
	pooled: computePooled(frames),
	frames,
	frameCount: 241,
	preview: { url: `/api/media/r${n}` },
}));
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("FrameComparison", () => {
	it("reattaches media sources after Strict Mode cleanup", async () => {
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
		const user = userEvent.setup();
		const { container } = renderWithQuery(
			<StrictMode>
				<FrameComparison results={results} fps={24} mode="VOD" />
			</StrictMode>,
			"en",
		);
		await user.click(
			screen.getByRole("button", { name: "Open comparison preview" }),
		);
		expect(
			[...container.querySelectorAll("video")].map((video) =>
				video.getAttribute("src"),
			),
		).toEqual(["/api/media/r1", "/api/media/r2"]);
	});
	it("loads media only on open, caps selection at two and releases on close", async () => {
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
		const user = userEvent.setup();
		const { container } = renderWithQuery(
			<FrameComparison results={results} fps={24} mode="VOD" />,
			"en",
		);
		expect(container.querySelectorAll("video")).toHaveLength(0);
		await user.click(
			screen.getByRole("button", { name: "Open comparison preview" }),
		);
		expect(container.querySelectorAll("video")).toHaveLength(2);
		expect(screen.getByRole("combobox", { name: "Rendition A" })).toHaveValue(
			"r1",
		);
		expect(screen.getByRole("combobox", { name: "Rendition B" })).toHaveValue(
			"r2",
		);
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Rendition B" }),
			"r3",
		);
		expect(container.querySelectorAll("video")).toHaveLength(2);
		for (const video of container.querySelectorAll("video"))
			fireEvent.canPlay(video);
		expect(screen.getByRole("button", { name: "Play both" })).toBeEnabled();
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Rendition B" }),
			"r2",
		);
		fireEvent.canPlay(
			container.querySelectorAll("video")[1] as HTMLVideoElement,
		);
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Rendition B" }),
			"r3",
		);
		expect(screen.getByRole("button", { name: "Play both" })).toBeDisabled();
		await user.click(
			screen.getByRole("button", { name: "Close comparison preview" }),
		);
		expect(container.querySelectorAll("video")).toHaveLength(0);
	});
	it("chart selection pauses and seeks both renditions; stepping uses the measured FPS", async () => {
		const pause = vi
			.spyOn(HTMLMediaElement.prototype, "pause")
			.mockImplementation(() => {});
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
		const user = userEvent.setup();
		const { container } = renderWithQuery(
			<FrameComparison results={results} fps={24} mode="VOD" />,
			"en",
		);
		await user.click(
			screen.getByRole("button", { name: "Open comparison preview" }),
		);
		const videos = [...container.querySelectorAll("video")];
		for (const video of videos) {
			Object.defineProperty(video, "readyState", {
				configurable: true,
				value: 4,
			});
			fireEvent.loadedMetadata(video);
		}
		await user.click(screen.getByRole("button", { name: "Chart frame 48" }));
		for (const video of videos)
			expect(video.currentTime).toBeCloseTo(48.5 / 24);
		expect(pause).toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Next frame" }));
		for (const video of videos)
			expect(video.currentTime).toBeCloseTo(49.5 / 24);
		expect(
			screen.getByRole("spinbutton", { name: "Selected frame" }),
		).toHaveValue(49);
	});
	it.each([
		["LIVE", 24],
		["VOD", undefined],
	] as const)("does not guess a preview for %s / missing clock", (mode, fps) => {
		const { container } = renderWithQuery(
			<FrameComparison results={results} fps={fps} mode={mode} />,
			"en",
		);
		expect(
			screen.getByRole("button", { name: "Open comparison preview" }),
		).toBeDisabled();
		expect(container.querySelectorAll("video")).toHaveLength(0);
	});
	it("retains decoders as playback updates the chart and pauses both on error", async () => {
		const pause = vi
			.spyOn(HTMLMediaElement.prototype, "pause")
			.mockImplementation(() => {});
		const load = vi
			.spyOn(HTMLMediaElement.prototype, "load")
			.mockImplementation(() => {});
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
		const user = userEvent.setup();
		const { container } = renderWithQuery(
			<FrameComparison results={results} fps={24} mode="VOD" />,
			"en",
		);
		await user.click(
			screen.getByRole("button", { name: "Open comparison preview" }),
		);
		const videos = [...container.querySelectorAll("video")];
		for (const video of videos) {
			Object.defineProperty(video, "readyState", {
				configurable: true,
				value: 4,
			});
			fireEvent.loadedMetadata(video);
			fireEvent.canPlay(video);
		}
		await user.click(screen.getByRole("button", { name: "Play both" }));
		await screen.findByRole("button", { name: "Pause both" });
		const first = videos[0];
		if (!first) throw new Error("missing video");
		first.currentTime = 3;
		fireEvent.timeUpdate(first);
		expect(
			screen.getByRole("spinbutton", { name: "Selected frame" }),
		).toHaveValue(72);
		expect(load).not.toHaveBeenCalled();
		expect(videos[1]?.currentTime).toBe(3);
		fireEvent.error(first);
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("Playback failed"),
		);
		expect(pause).toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Play both" })).toBeDisabled();
	});
});
it("lets the frame number be cleared and replaced before committing on blur", async () => {
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
	renderWithQuery(<FrameComparison results={results} fps={24} mode="VOD" />);
	const user = userEvent.setup();
	await user.click(
		screen.getByRole("button", { name: "Open comparison preview" }),
	);
	await user.click(screen.getByRole("button", { name: "Chart frame 48" }));
	const input = screen.getByRole("spinbutton", { name: "Selected frame" });
	await user.clear(input);
	expect(input).toHaveValue(null);
	await user.type(input, "120");
	await user.tab();
	expect(input).toHaveValue(120);
	await user.clear(input);
	await user.type(input, "999");
	await user.tab();
	expect(input).toHaveValue(120);
});
