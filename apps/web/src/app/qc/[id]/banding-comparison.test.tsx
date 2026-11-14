import {
	act,
	cleanup,
	fireEvent,
	screen,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import type { BandingResultDetail } from "../vmaf-shared";
import { BandingPanels } from "./banding-panel";

const results: BandingResultDetail[] = [
	{
		id: "a",
		renditionRef: { label: "CAMBI A" },
		pooled: {
			banding: { mean: 6, min: 2, max: 10, frameCount: 3, durationSeconds: 3 },
		},
		bandingPreview: { url: "/a.mp4?metric=banding" },
		bandingFrames: [
			{ frameNum: 0, timestampSeconds: 0, durationSeconds: 0.04, cambi: 2 },
			{
				frameNum: 31,
				timestampSeconds: 1.25,
				durationSeconds: 0.08,
				cambi: 10,
			},
			{ frameNum: 58, timestampSeconds: 2.5, durationSeconds: 0.5, cambi: 6 },
		],
	},
	{
		id: "b",
		renditionRef: { label: "CAMBI B" },
		pooled: {
			banding: { mean: 4, min: 1, max: 8, frameCount: 3, durationSeconds: 3 },
		},
		bandingPreview: { url: "/b.mp4?metric=banding" },
		bandingFrames: [
			{ frameNum: 0, timestampSeconds: 0, durationSeconds: 0.02, cambi: 1 },
			{ frameNum: 62, timestampSeconds: 1.24, durationSeconds: 0.02, cambi: 8 },
			{ frameNum: 100, timestampSeconds: 2.5, durationSeconds: 0.5, cambi: 3 },
		],
	},
];

function ready(videos: NodeListOf<HTMLVideoElement>) {
	for (const video of videos) {
		Object.defineProperty(video, "readyState", {
			configurable: true,
			value: 4,
		});
		fireEvent.loadedMetadata(video);
		fireEvent.canPlay(video);
	}
}
async function open() {
	await userEvent.click(
		screen.getByRole("button", { name: "Open comparison preview" }),
	);
	const videos = document.querySelectorAll("video");
	ready(videos);
	return videos;
}
function seek(seconds: string) {
	const input = screen.getByRole("spinbutton", {
		name: "Presentation time (s)",
	});
	fireEvent.change(input, { target: { value: seconds } });
	fireEvent.blur(input);
}

beforeEach(() => {
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("CAMBI comparison preview", () => {
	it("loads two pinned videos on demand without reference FPS and releases them on close", async () => {
		renderWithQuery(<BandingPanels results={results} />, "en");
		expect(document.querySelectorAll("video")).toHaveLength(0);
		const videos = await open();
		expect([...videos].map((video) => video.getAttribute("src"))).toEqual([
			"/a.mp4?metric=banding",
			"/b.mp4?metric=banding",
		]);
		expect(screen.queryByText(/fps/)).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: "Close comparison preview" }),
		);
		expect(document.querySelectorAll("video")).toHaveLength(0);
		for (const video of videos) expect(video).not.toHaveAttribute("src");
	});

	it("seeks in presentation seconds, showing only the score whose measured interval contains that time", async () => {
		renderWithQuery(<BandingPanels results={results} />, "en");
		const videos = await open();
		seek("1.29");
		for (const video of videos) expect(video.currentTime).toBeCloseTo(1.29);
		const preview = screen.getByRole("region", {
			name: "Open comparison preview",
		});
		expect(preview.querySelectorAll("figcaption")[0]).toHaveTextContent(
			"CAMBI A · CAMBI 10.0",
		);
		expect(preview.querySelectorAll("figcaption")[1]).toHaveTextContent(
			"CAMBI B · CAMBI Not in the displayed score sample",
		);
		expect(within(preview).queryByText(/VMAF/)).not.toBeInTheDocument();
		seek("1.33");
		expect(preview.querySelectorAll("figcaption")[0]).toHaveTextContent(
			"Not in the displayed score sample",
		);
	});

	it("steps through recorded presentation points rather than inventing a constant frame rate", async () => {
		renderWithQuery(<BandingPanels results={results} />, "en");
		const videos = await open();
		await userEvent.click(
			screen.getByRole("button", { name: "Next measured point" }),
		);
		for (const video of videos) expect(video.currentTime).toBeCloseTo(1.24);
		await userEvent.click(
			screen.getByRole("button", { name: "Next measured point" }),
		);
		for (const video of videos) expect(video.currentTime).toBeCloseTo(1.25);
		await userEvent.click(
			screen.getByRole("button", { name: "Previous measured point" }),
		);
		for (const video of videos) expect(video.currentTime).toBeCloseTo(1.24);
	});

	it("retains both decoders during synchronized playback and pauses both on errors", async () => {
		renderWithQuery(<BandingPanels results={results} />, "en");
		const videos = await open();
		const loads = vi.mocked(HTMLMediaElement.prototype.load).mock.calls.length;
		await userEvent.click(screen.getByRole("button", { name: "Play both" }));
		await screen.findByRole("button", { name: "Pause both" });
		const first = videos[0] as HTMLVideoElement;
		first.currentTime = 1.29;
		fireEvent.timeUpdate(first);
		expect(videos[1]?.currentTime).toBeCloseTo(1.29);
		expect(
			screen.getByRole("spinbutton", { name: "Presentation time (s)" }),
		).toHaveValue(1.29);
		expect(document.querySelectorAll("video")[0]).toBe(first);
		expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(loads);
		fireEvent.error(videos[1] as HTMLVideoElement);
		expect(screen.getByRole("alert")).toHaveTextContent("Playback failed");
		expect(screen.getByRole("button", { name: "Play both" })).toBeDisabled();
	});

	it("supports one retained video and preserves score-only reports with unavailable media", async () => {
		const { unmount } = renderWithQuery(
			<BandingPanels results={[results[0] as BandingResultDetail]} />,
			"en",
		);
		expect(await open()).toHaveLength(1);
		expect(screen.getByRole("combobox", { name: "Rendition B" })).toHaveValue(
			"",
		);
		unmount();
		renderWithQuery(
			<BandingPanels
				results={results.map((result) => ({
					...result,
					bandingPreview: { unavailableReason: "MISSING_PROVENANCE" },
				}))}
			/>,
			"en",
		);
		expect(
			screen.getByRole("button", { name: "Open comparison preview" }),
		).toBeDisabled();
		expect(screen.getAllByText("Mean CAMBI")).toHaveLength(2);
	});

	it("reattaches sources under Strict Mode and releases a replaced rendition", async () => {
		renderWithQuery(
			<StrictMode>
				<BandingPanels results={results} />
			</StrictMode>,
			"en",
		);
		const videos = await open();
		await userEvent.selectOptions(
			screen.getByRole("combobox", { name: "Rendition B" }),
			"",
		);
		expect(videos[1]).not.toHaveAttribute("src");
		expect(document.querySelectorAll("video")).toHaveLength(1);
		expect(document.querySelector("video")).toHaveAttribute(
			"src",
			"/a.mp4?metric=banding",
		);
	});

	it("does not revive a closed preview when an earlier play request finishes late", async () => {
		let finish = () => {};
		const pendingPlay = new Promise<void>((resolve) => {
			finish = resolve;
		});
		vi.mocked(HTMLMediaElement.prototype.play).mockReturnValue(pendingPlay);
		renderWithQuery(<BandingPanels results={results} />, "en");
		const oldVideos = await open();
		await userEvent.click(screen.getByRole("button", { name: "Play both" }));
		await userEvent.click(
			screen.getByRole("button", { name: "Close comparison preview" }),
		);
		const currentVideos = await open();
		await act(async () => {
			finish();
			await pendingPlay;
		});
		expect(currentVideos[0]).not.toBe(oldVideos[0]);
		for (const video of oldVideos) expect(video).not.toHaveAttribute("src");
		expect(screen.getByRole("button", { name: "Play both" })).toBeEnabled();
		expect(
			screen.queryByRole("button", { name: "Pause both" }),
		).not.toBeInTheDocument();
	});
});
