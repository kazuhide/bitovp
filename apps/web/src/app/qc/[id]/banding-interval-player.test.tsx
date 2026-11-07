import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { BandingIntervalPlayer } from "./banding-interval-player";

const range = { startSeconds: 1.125, endSeconds: 1.375 };
let callbacks: VideoFrameRequestCallback[];
let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;

beforeEach(() => {
	callbacks = [];
	play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
	pause = vi
		.spyOn(HTMLMediaElement.prototype, "pause")
		.mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
	vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(10);
	Object.defineProperty(
		HTMLVideoElement.prototype,
		"requestVideoFrameCallback",
		{
			configurable: true,
			value: vi.fn((callback: VideoFrameRequestCallback) => {
				callbacks.push(callback);
				return callbacks.length;
			}),
		},
	);
	Object.defineProperty(
		HTMLVideoElement.prototype,
		"cancelVideoFrameCallback",
		{ configurable: true, value: vi.fn() },
	);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const renderPlayer = () =>
	renderWithQuery(
		<BandingIntervalPlayer
			url="/measured.mp4"
			label="360p"
			range={range}
			onClose={() => {}}
		/>,
	);
function firstFrame(time = 0.5, index = 0) {
	act(() =>
		callbacks[index]?.(0, {
			mediaTime: time,
			presentedFrames: 1,
		} as VideoFrameCallbackMetadata),
	);
}

describe("CAMBI interval playback", () => {
	it("maps noninteger PTS intervals from the first video presentation before any playback", async () => {
		renderPlayer();
		const video = screen.getByLabelText("360p") as HTMLVideoElement;
		expect(play).not.toHaveBeenCalled();
		firstFrame();
		expect(video.currentTime).toBe(1.625);
		await act(async () => fireEvent.canPlay(video));
		expect(play).toHaveBeenCalledOnce();
		expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
		expect(screen.queryByText(/both|comparison/i)).not.toBeInTheDocument();
		video.currentTime = 1.9;
		fireEvent.timeUpdate(video);
		expect(pause).toHaveBeenCalled();
		expect(video.currentTime).toBeLessThan(1.875);
		expect(screen.getByText("Interval finished")).toBeInTheDocument();
	});
	it("ignores a stale first-frame callback after closing", () => {
		const view = renderPlayer();
		const video = screen.getByLabelText("360p") as HTMLVideoElement;
		view.unmount();
		firstFrame();
		expect(video.currentTime).toBe(0);
		expect(play).not.toHaveBeenCalled();
	});
	it("ignores old origin callbacks after switching to a different measured object", () => {
		const view = renderPlayer();
		const oldVideo = screen.getByLabelText("360p") as HTMLVideoElement;
		view.rerender(
			<BandingIntervalPlayer
				key="other"
				url="/other.mp4"
				label="720p"
				range={range}
				onClose={() => {}}
			/>,
		);
		firstFrame(8, 0);
		expect(oldVideo.currentTime).toBe(0);
		expect(
			(screen.getByLabelText("720p") as HTMLVideoElement).currentTime,
		).toBe(0);
		firstFrame(0.25, 1);
		expect(
			(screen.getByLabelText("720p") as HTMLVideoElement).currentTime,
		).toBe(1.375);
	});
	it("pauses a delayed play resolution after closing", async () => {
		let resolvePlay: (() => void) | undefined;
		play.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				resolvePlay = resolve;
			}),
		);
		const view = renderPlayer();
		firstFrame();
		fireEvent.canPlay(screen.getByLabelText("360p"));
		view.unmount();
		pause.mockClear();
		await act(async () => resolvePlay?.());
		expect(pause).toHaveBeenCalledOnce();
	});
	it("replays the same presentation-time interval after reaching the exclusive end", async () => {
		renderPlayer();
		firstFrame();
		const video = screen.getByLabelText("360p") as HTMLVideoElement;
		await act(async () => fireEvent.canPlay(video));
		video.currentTime = 2;
		fireEvent.timeUpdate(video);
		fireEvent.click(screen.getByRole("button", { name: "Replay interval" }));
		expect(video.currentTime).toBe(1.625);
		await act(async () => fireEvent.seeked(video));
		expect(play).toHaveBeenCalledTimes(2);
	});
	it("does not recover a timed-out origin from a late frame callback", () => {
		vi.useFakeTimers();
		renderPlayer();
		act(() => vi.advanceTimersByTime(10_000));
		firstFrame();
		fireEvent.canPlay(screen.getByLabelText("360p"));
		expect(screen.getByRole("alert")).toHaveTextContent("could not establish");
		expect(play).not.toHaveBeenCalled();
	});
	it("fails explicitly when the browser cannot observe video presentation time", () => {
		Object.defineProperty(
			HTMLVideoElement.prototype,
			"requestVideoFrameCallback",
			{ configurable: true, value: undefined },
		);
		renderPlayer();
		expect(screen.getByRole("alert")).toHaveTextContent("could not establish");
		expect(play).not.toHaveBeenCalled();
	});
	it("rejects a skipped first frame instead of guessing the missing origin", () => {
		renderPlayer();
		act(() =>
			callbacks[0]?.(0, {
				mediaTime: 0.6,
				presentedFrames: 2,
			} as VideoFrameCallbackMetadata),
		);
		expect(screen.getByRole("alert")).toHaveTextContent("could not establish");
	});
	it("fails if real EOF arrives before the selected interval end", async () => {
		vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(
			1.8,
		);
		renderPlayer();
		firstFrame();
		const video = screen.getByLabelText("360p") as HTMLVideoElement;
		await act(async () => fireEvent.canPlay(video));
		video.currentTime = 1.8;
		fireEvent.ended(video);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"complete selected interval",
		);
		expect(screen.queryByText("Interval finished")).not.toBeInTheDocument();
	});
	it("accepts provisional duration that grows while the browser reads the media tail", async () => {
		const duration = vi
			.spyOn(HTMLMediaElement.prototype, "duration", "get")
			.mockReturnValue(1.7);
		renderPlayer();
		firstFrame();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		const video = screen.getByLabelText("360p") as HTMLVideoElement;
		duration.mockReturnValue(2);
		await act(async () => fireEvent.seeked(video));
		expect(play).toHaveBeenCalledOnce();
		video.currentTime = 1.9;
		fireEvent.timeUpdate(video);
		expect(screen.getByText("Interval finished")).toBeInTheDocument();
	});
	it("does not play a seek that lands later in the requested interval", () => {
		renderPlayer();
		firstFrame();
		const video = screen.getByLabelText("360p") as HTMLVideoElement;
		video.currentTime = 1.7;
		fireEvent.seeked(video);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"complete selected interval",
		);
		expect(play).not.toHaveBeenCalled();
	});
	it("retries a seek clamped by provisional metadata after duration grows", async () => {
		const duration = vi
			.spyOn(HTMLMediaElement.prototype, "duration", "get")
			.mockReturnValue(1.6);
		renderPlayer();
		firstFrame();
		const video = screen.getByLabelText("360p") as HTMLVideoElement;
		video.currentTime = 1.6;
		fireEvent.seeked(video);
		expect(play).not.toHaveBeenCalled();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		duration.mockReturnValue(2);
		fireEvent.durationChange(video);
		expect(video.currentTime).toBe(1.625);
		await act(async () => fireEvent.seeked(video));
		expect(play).toHaveBeenCalledOnce();
	});
	it("times out a stuck seek and ignores a late canplay event", () => {
		vi.useFakeTimers();
		renderPlayer();
		firstFrame();
		act(() => vi.advanceTimersByTime(10_000));
		fireEvent.canPlay(screen.getByLabelText("360p"));
		expect(screen.getByRole("alert")).toHaveTextContent(
			"complete selected interval",
		);
		expect(play).not.toHaveBeenCalled();
	});
});
