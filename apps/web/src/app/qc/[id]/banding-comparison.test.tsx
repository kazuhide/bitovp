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
import { MeasuredMediaComparison } from "./measured-media-comparison";

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

let firstFrames: Map<HTMLVideoElement, VideoFrameRequestCallback>;
function ready(
	videos: Iterable<HTMLVideoElement>,
	origins: number[] = [],
	duration = 3,
) {
	for (const [index, video] of [...videos].entries()) {
		const origin = origins[index] ?? 0;
		Object.defineProperty(video, "readyState", {
			configurable: true,
			value: 4,
		});
		Object.defineProperty(video, "duration", {
			configurable: true,
			value: duration + origin,
		});
		fireEvent.loadedMetadata(video);
		act(() =>
			firstFrames.get(video)?.(0, {
				mediaTime: origin,
				presentedFrames: 1,
			} as VideoFrameCallbackMetadata),
		);
		fireEvent.canPlay(video);
	}
}
async function open(origins: number[] = [], duration = 3) {
	await userEvent.click(
		screen.getByRole("button", { name: "Open comparison preview" }),
	);
	const videos = document.querySelectorAll("video");
	ready(videos, origins, duration);
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
	firstFrames = new Map();
	Object.defineProperty(
		HTMLVideoElement.prototype,
		"requestVideoFrameCallback",
		{
			configurable: true,
			value: vi.fn(function (
				this: HTMLVideoElement,
				callback: VideoFrameRequestCallback,
			) {
				firstFrames.set(this, callback);
				return firstFrames.size;
			}),
		},
	);
	Object.defineProperty(
		HTMLVideoElement.prototype,
		"cancelVideoFrameCallback",
		{ configurable: true, value: vi.fn() },
	);
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("CAMBI comparison preview", () => {
	it("flushes the normalized leader clock and score when pausing before the next timeupdate", async () => {
		renderWithQuery(<BandingPanels results={results} />, "en");
		const videos = await open([0.5, 1]);
		seek("1");
		await userEvent.click(screen.getByRole("button", { name: "Play both" }));
		await screen.findByRole("button", { name: "Pause both" });
		const leader = videos[0] as HTMLVideoElement;
		leader.currentTime = 1.79;
		(videos[1] as HTMLVideoElement).currentTime = 2.29;
		// Native playback advances between the last timeupdate and a user pause.
		await userEvent.click(screen.getByRole("button", { name: "Pause both" }));
		expect(
			screen.getByRole("spinbutton", { name: "Presentation time (s)" }),
		).toHaveValue(1.29);
		const captions = screen
			.getByRole("region", { name: "Open comparison preview" })
			.querySelectorAll("figcaption");
		expect(captions[0]).toHaveTextContent("CAMBI A · CAMBI 10.0");
		expect(captions[1]).toHaveTextContent("Not in the displayed score sample");
		fireEvent.timeUpdate(leader);
		expect(
			screen.getByRole("spinbutton", { name: "Presentation time (s)" }),
		).toHaveValue(1.29);
		await userEvent.click(
			screen.getByRole("button", { name: "Close comparison preview" }),
		);
		const reopened = await open([0.5, 1]);
		expect(reopened[0]?.currentTime).toBeCloseTo(1.79);
		expect(reopened[1]?.currentTime).toBeCloseTo(2.29);
	});

	it("keeps an explicit seek while playing after capturing the paused clock", async () => {
		renderWithQuery(<BandingPanels results={results} />, "en");
		const videos = await open([0.5, 1]);
		await userEvent.click(screen.getByRole("button", { name: "Play both" }));
		await screen.findByRole("button", { name: "Pause both" });
		(videos[0] as HTMLVideoElement).currentTime = 1.79;
		seek("2.5");
		expect(
			screen.getByRole("spinbutton", { name: "Presentation time (s)" }),
		).toHaveValue(2.5);
		expect(videos[0]?.currentTime).toBe(3);
		expect(videos[1]?.currentTime).toBe(3.5);
		expect(screen.getByRole("button", { name: "Play both" })).toBeEnabled();
	});

	it("preserves integral VMAF frames and half-frame seek positions when pausing", async () => {
		renderWithQuery(
			<MeasuredMediaComparison
				candidates={[
					{ id: "frame-a", label: "Frame A", url: "/frame-a.mp4" },
					{ id: "frame-b", label: "Frame B", url: "/frame-b.mp4" },
				]}
				clock={{ kind: "frame", fps: 24, max: 240 }}
				metric="VMAF"
				unavailableReason="Unavailable"
				scoreAt={() => 90}
				renderChart={() => null}
			/>,
			"en",
		);
		const videos = await open([], 10);
		await userEvent.click(screen.getByRole("button", { name: "Play both" }));
		await screen.findByRole("button", { name: "Pause both" });
		(videos[0] as HTMLVideoElement).currentTime = 1.234;
		await userEvent.click(screen.getByRole("button", { name: "Pause both" }));
		const frame = screen.getByRole("spinbutton", { name: "Selected frame" });
		expect(frame).toHaveValue(29);
		fireEvent.change(frame, { target: { value: "48" } });
		fireEvent.blur(frame);
		expect(frame).toHaveValue(48);
		for (const video of videos)
			expect(video.currentTime).toBeCloseTo(48.5 / 24);
	});

	it.each([
		"floor",
		"ceil",
	] as const)("accepts a completed seek with native 2ms %s readback without retrying or timing out", async (rounding) => {
		renderWithQuery(<BandingPanels results={results} />, "en");
		const videos = await open([0.5, 1]);
		const setters = [...videos].map((video) => {
			let current = video.currentTime;
			const set = vi.fn((value: number) => {
				current = Math[rounding](value / 0.002) * 0.002;
			});
			Object.defineProperty(video, "currentTime", {
				configurable: true,
				get: () => current,
				set,
			});
			return set;
		});
		vi.useFakeTimers();
		try {
			seek("1.125");
			for (const video of videos) fireEvent.seeked(video);
			expect(screen.getByRole("button", { name: "Play both" })).toBeEnabled();
			for (const set of setters) expect(set).toHaveBeenCalledTimes(1);
			act(() => vi.advanceTimersByTime(10_001));
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("accepts a covered endpoint when native duration and seek position round down by 1ms", async () => {
		renderWithQuery(
			<MeasuredMediaComparison
				candidates={[
					{ id: "a", label: "Endpoint A", url: "/a.mp4", endSeconds: 1.125 },
					{ id: "b", label: "Endpoint B", url: "/b.mp4", endSeconds: 1.125 },
				]}
				clock={{ kind: "time", timestamps: [0, 1.125] }}
				metric="CAMBI"
				unavailableReason="Unavailable"
				scoreAt={() => undefined}
				renderChart={() => null}
			/>,
			"en",
		);
		const videos = await open([0.5, 1], 1.125);
		for (const video of videos) {
			const end = Math.floor(video.duration / 0.002) * 0.002;
			let current = video.currentTime;
			Object.defineProperty(video, "duration", {
				configurable: true,
				value: end,
			});
			Object.defineProperty(video, "currentTime", {
				configurable: true,
				get: () => current,
				set: (value: number) => {
					current = Math.min(value, end);
				},
			});
		}
		seek("1.125");
		for (const video of videos) fireEvent.seeked(video);
		expect(screen.getByRole("button", { name: "Play both" })).toBeEnabled();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("keeps a genuinely clamped seek unavailable and fails it at the existing deadline", async () => {
		renderWithQuery(<BandingPanels results={results} />, "en");
		const videos = await open([0.5, 1]);
		for (const video of videos) {
			let current = video.currentTime;
			Object.defineProperty(video, "currentTime", {
				configurable: true,
				get: () => current,
				set: (value: number) => {
					current = value - 0.02;
				},
			});
		}
		vi.useFakeTimers();
		try {
			seek("1.125");
			for (const video of videos) fireEvent.seeked(video);
			expect(screen.getByRole("button", { name: "Play both" })).toBeDisabled();
			act(() => vi.advanceTimersByTime(9_999));
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			act(() => vi.advanceTimersByTime(1));
			expect(screen.getByRole("alert")).toHaveTextContent(
				"does not cover the complete selected interval",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("resets both videos to a valid shared time when swapping to a shorter rendition", async () => {
		const shorter: BandingResultDetail = {
			...(results[0] as BandingResultDetail),
			id: "short",
			renditionRef: { label: "Short" },
			bandingPreview: { url: "/short.mp4?metric=banding" },
		};
		renderWithQuery(<BandingPanels results={[...results, shorter]} />, "en");
		const initial = await open([0.5, 1], 10);
		seek("8");
		expect(initial[0]?.currentTime).toBe(8.5);
		await userEvent.selectOptions(
			screen.getByRole("combobox", { name: "Rendition B" }),
			"short",
		);
		const current = document.querySelectorAll("video");
		const replacement = current[1] as HTMLVideoElement;
		ready([replacement], [1.5], 2);
		expect(
			screen.getByRole("spinbutton", { name: "Presentation time (s)" }),
		).toHaveValue(0);
		expect(current[0]?.currentTime).toBe(0.5);
		expect(replacement.currentTime).toBe(1.5);
		expect(initial[1]).not.toHaveAttribute("src");
		expect(screen.getByRole("button", { name: "Play both" })).toBeEnabled();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("retries a clamped tail seek when native duration grows to the full recorded endpoint", async () => {
		const full = results.map((result) => ({
			...result,
			bandingExecution: {
				version: 1 as const,
				metric: "CAMBI_NR" as const,
				backend: "cpu" as const,
				implementation: "libvmaf" as const,
				decisionSource: "CPU_REFERENCE" as const,
				coverage: {
					complete: true as const,
					frameCount: 3,
					durationSeconds: 4,
					endTimeSeconds: 4,
				},
			},
		}));
		renderWithQuery(<BandingPanels results={full} />, "en");
		const videos = await open([0.5, 1], 2);
		const grow: (() => void)[] = [];
		for (const [index, video] of [...videos].entries()) {
			let end = 2 + (index === 0 ? 0.5 : 1);
			let current = video.currentTime;
			Object.defineProperty(video, "duration", {
				configurable: true,
				get: () => end,
			});
			Object.defineProperty(video, "currentTime", {
				configurable: true,
				get: () => current,
				set: (value: number) => {
					current = Math.min(value, end);
				},
			});
			grow.push(() => {
				end += 2;
				fireEvent.durationChange(video);
				fireEvent.canPlay(video);
			});
		}
		seek("3.75");
		expect(videos[0]?.currentTime).toBe(2.5);
		expect(screen.getByRole("button", { name: "Play both" })).toBeDisabled();
		for (const update of grow) update();
		expect(videos[0]?.currentTime).toBeCloseTo(4.25);
		expect(videos[1]?.currentTime).toBeCloseTo(4.75);
		expect(screen.getByRole("button", { name: "Play both" })).toBeEnabled();
	});

	it("does not guess an origin in a browser without first-presentation callbacks", async () => {
		Object.defineProperty(
			HTMLVideoElement.prototype,
			"requestVideoFrameCallback",
			{ configurable: true, value: undefined },
		);
		renderWithQuery(<BandingPanels results={results} />, "en");
		await userEvent.click(
			screen.getByRole("button", { name: "Open comparison preview" }),
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"could not establish the video presentation time",
		);
		expect(screen.getByRole("button", { name: "Play both" })).toBeDisabled();
		for (const video of document.querySelectorAll("video"))
			expect(video).not.toHaveAttribute("src");
	});

	it("maps each first presentation origin for seeks, score captions and synchronized playback", async () => {
		renderWithQuery(<BandingPanels results={results} />, "en");
		const videos = await open([0.5, 1]);
		seek("1.29");
		expect(videos[0]?.currentTime).toBeCloseTo(1.79);
		expect(videos[1]?.currentTime).toBeCloseTo(2.29);
		await userEvent.click(screen.getByRole("button", { name: "Play both" }));
		await screen.findByRole("button", { name: "Pause both" });
		const leader = videos[0] as HTMLVideoElement;
		leader.currentTime = 1.76;
		(videos[1] as HTMLVideoElement).currentTime = 1;
		fireEvent.timeUpdate(leader);
		expect(videos[1]?.currentTime).toBeCloseTo(2.26);
		expect(
			screen.getByRole("spinbutton", { name: "Presentation time (s)" }),
		).toHaveValue(1.26);
	});

	it("allows the full historical media tail beyond the last displayed score point", async () => {
		renderWithQuery(<BandingPanels results={results} />, "en");
		const videos = await open([0.5, 1], 4);
		seek("3.75");
		expect(videos[0]?.currentTime).toBeCloseTo(4.25);
		expect(videos[1]?.currentTime).toBeCloseTo(4.75);
		expect(
			screen.getByRole("spinbutton", { name: "Presentation time (s)" }),
		).toHaveValue(3.75);
		const captions = screen
			.getByRole("region", { name: "Open comparison preview" })
			.querySelectorAll("figcaption");
		for (const caption of captions)
			expect(caption).toHaveTextContent("Not in the displayed score sample");
	});

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
