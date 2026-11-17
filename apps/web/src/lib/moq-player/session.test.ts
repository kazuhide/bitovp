import { describe, expect, it, vi } from "vitest";
import {
	MOQ_ARCHIVE_SAVE_TIMEOUT_MS,
	MOQ_PLAYER_DISPOSE_TIMEOUT_MS,
} from "../../../config/moq-policy";
import { createMoqPlayback } from "./session";
import type { MoqPlaybackDescriptor, MoqPlayer } from "./types";

const descriptor: MoqPlaybackDescriptor = {
	runId: "00000000-0000-4000-8000-000000000001",
	encodingId: "00000000-0000-4000-8000-000000000002",
	resource: {
		type: "moq",
		url: "https://relay.example.test/SYNTHETIC_SUBSCRIBE_SECRET",
		metadata: {
			namespace: "owned-run",
			catalogTrackName: "catalog",
			draftVersion: 18,
			mediaTypes: ["audio", "video"],
		},
	},
	playerLicenseKey: "synthetic-player-key",
};
function fixture() {
	const source = {
		setTargetBufferLevel: vi.fn(),
		setVolume: vi.fn(),
		play: vi.fn().mockResolvedValue(undefined),
		logLevel: 1,
	};
	const player = {
		sources: { add: vi.fn(() => source), remove: vi.fn() },
		dispose: vi.fn().mockResolvedValue(undefined),
	};
	const host = document.createElement("div");
	document.body.append(host);
	return { source, player, host };
}
describe("owned MoQ source lifecycle", () => {
	it("still tears down the source when recording finalization exceeds its budget", async () => {
		vi.useFakeTimers();
		const { player, host } = fixture();
		try {
			const session = createMoqPlayback(
				() => player,
				descriptor,
				host,
				vi.fn(),
				vi.fn(),
				{
					startedAt: performance.now(),
					onStatistics: vi.fn(),
					beforeDispose: () => new Promise<void>(() => {}),
				},
			);
			await session.ready;
			const done = session.dispose();
			const rejected = expect(done).rejects.toThrow(
				/^MoQ playback cleanup failed$/,
			);
			await vi.advanceTimersByTimeAsync(MOQ_ARCHIVE_SAVE_TIMEOUT_MS + 2001);
			await rejected;
			expect(player.sources.remove).toHaveBeenCalledOnce();
			expect(player.dispose).toHaveBeenCalledOnce();
		} finally {
			host.remove();
			vi.useRealTimers();
		}
	});
	it("settles Stop while keeping ownership until a delayed SDK disposal succeeds", async () => {
		vi.useFakeTimers();
		const { player, host } = fixture();
		let release = () => {};
		player.dispose.mockReturnValue(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		try {
			const session = createMoqPlayback(
				() => player,
				descriptor,
				host,
				vi.fn(),
				vi.fn(),
			);
			await session.ready;
			const outcome = vi.fn();
			void session.dispose().then(
				() => outcome("stopped"),
				(error: Error) => outcome(error.message),
			);
			await vi.advanceTimersByTimeAsync(MOQ_PLAYER_DISPOSE_TIMEOUT_MS + 1);
			expect(outcome).toHaveBeenCalledExactlyOnceWith(
				"MoQ playback cleanup failed",
			);
			expect(host.children).toHaveLength(0);
			const confirmed = vi.fn();
			void session.released.then(confirmed);
			await Promise.resolve();
			expect(confirmed).not.toHaveBeenCalled();
			release();
			await session.released;
			expect(confirmed).toHaveBeenCalledOnce();
			expect(player.dispose).toHaveBeenCalledOnce();
		} finally {
			release();
			host.remove();
			vi.useRealTimers();
		}
	});
	it("waits for recording finalization and still disposes its source when finalization rejects", async () => {
		const { player, host } = fixture();
		let reject!: (error: Error) => void;
		const beforeDispose = vi.fn(
			() =>
				new Promise<void>((_resolve, fail) => {
					reject = fail;
				}),
		);
		const session = createMoqPlayback(
			() => player,
			descriptor,
			host,
			vi.fn(),
			vi.fn(),
			{ startedAt: performance.now(), onStatistics: vi.fn(), beforeDispose },
		);
		await session.ready;
		const done = session.dispose();
		await Promise.resolve();
		expect(beforeDispose).toHaveBeenCalledOnce();
		expect(player.sources.remove).not.toHaveBeenCalled();
		reject(new Error("private-recording-error"));
		await expect(done).rejects.toThrow(/^MoQ playback cleanup failed$/);
		expect(player.sources.remove).toHaveBeenCalledOnce();
		expect(player.dispose).toHaveBeenCalledOnce();
		host.remove();
	});
	it("starts one muted source with the exact descriptor, then removes and disposes it once", async () => {
		const { source, player, host } = fixture();
		const factory = vi.fn(() => player);
		const session = createMoqPlayback(
			factory,
			descriptor,
			host,
			vi.fn(),
			vi.fn(),
		);
		await session.ready;
		expect(factory).toHaveBeenCalledWith(
			expect.objectContaining({
				key: descriptor.playerLicenseKey,
				volume: 0,
				defaultLogLevel: 0,
			}),
		);
		expect(player.sources.add).toHaveBeenCalledWith(
			{ resources: [descriptor.resource] },
			{ attach: false },
		);
		expect(source.setTargetBufferLevel).toHaveBeenCalledWith(2);
		expect(source.setVolume).toHaveBeenCalledWith(0);
		expect(source.play).toHaveBeenCalledOnce();
		await session.dispose();
		await session.dispose();
		expect(player.sources.remove).toHaveBeenCalledExactlyOnceWith(source);
		expect(player.dispose).toHaveBeenCalledOnce();
		expect(host.children).toHaveLength(0);
		host.remove();
	});
	it("disposes a constructor that resolves after cancellation without adding a source", async () => {
		const { player, host } = fixture();
		let resolve!: (player: MoqPlayer) => void;
		const constructing = new Promise<MoqPlayer>((done) => {
			resolve = done;
		});
		const session = createMoqPlayback(
			() => constructing,
			descriptor,
			host,
			vi.fn(),
			vi.fn(),
		);
		await session.dispose();
		resolve(player);
		await session.ready;
		expect(player.sources.add).not.toHaveBeenCalled();
		expect(player.dispose).toHaveBeenCalledOnce();
		host.remove();
	});
	it("removes a source immediately while its play promise is pending", async () => {
		const { source, player, host } = fixture();
		let resolve!: () => void;
		source.play.mockReturnValue(
			new Promise<void>((done) => {
				resolve = done;
			}),
		);
		const session = createMoqPlayback(
			() => player,
			descriptor,
			host,
			vi.fn(),
			vi.fn(),
		);
		await vi.waitFor(() => expect(source.play).toHaveBeenCalledOnce());
		await session.dispose();
		expect(player.sources.remove).toHaveBeenCalledOnce();
		expect(player.dispose).toHaveBeenCalledOnce();
		resolve();
		await session.ready;
		expect(player.dispose).toHaveBeenCalledOnce();
		host.remove();
	});
	it("cleans up on source failure and withholds the SDK error text", async () => {
		const { source, player, host } = fixture();
		source.play.mockRejectedValue(new Error(descriptor.resource.url));
		const session = createMoqPlayback(
			() => player,
			descriptor,
			host,
			vi.fn(),
			vi.fn(),
		);
		await expect(session.ready).rejects.toThrow(/^MoQ playback failed$/);
		expect(player.sources.remove).toHaveBeenCalledOnce();
		expect(player.dispose).toHaveBeenCalledOnce();
		host.remove();
	});
	it("requires advancing video time and decoded frames before reporting video progress", async () => {
		const { player, host } = fixture();
		const frame = vi.fn();
		const session = createMoqPlayback(
			() => player,
			descriptor,
			host,
			frame,
			vi.fn(),
		);
		await session.ready;
		const video = document.createElement("video");
		Object.defineProperties(video, {
			videoWidth: { value: 640 },
			videoHeight: { value: 360 },
		});
		const quality = vi.fn(() => ({
			totalVideoFrames: 0,
			droppedVideoFrames: 0,
		}));
		Object.assign(video, { getVideoPlaybackQuality: quality });
		host.firstElementChild?.append(video);
		await vi.waitFor(() => expect(video.muted).toBe(true));
		video.currentTime = 1;
		video.dispatchEvent(new Event("timeupdate"));
		expect(frame).not.toHaveBeenCalled();
		quality.mockReturnValue({ totalVideoFrames: 2, droppedVideoFrames: 0 });
		video.currentTime = 2;
		video.dispatchEvent(new Event("timeupdate"));
		expect(frame).toHaveBeenCalledOnce();
		await session.dispose();
		video.currentTime = 3;
		video.dispatchEvent(new Event("timeupdate"));
		expect(frame).toHaveBeenCalledOnce();
		host.remove();
	});
});
