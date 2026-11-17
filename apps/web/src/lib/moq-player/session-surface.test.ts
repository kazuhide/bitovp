import { describe, expect, it, vi } from "vitest";
import { createMoqPlayback } from "./session";
import type { MoqPlaybackDescriptor } from "./types";

const calls = vi.hoisted(() => ({ stop: vi.fn(), disposeSurface: vi.fn() }));
vi.mock("./video-progress", () => ({
	observeMoqVideo: () => ({
		stop: calls.stop,
		disposeSurface: calls.disposeSurface,
	}),
}));
const descriptor: MoqPlaybackDescriptor = {
	runId: "00000000-0000-4000-8000-000000000001",
	encodingId: "00000000-0000-4000-8000-000000000002",
	playerLicenseKey: "synthetic",
	resource: {
		type: "moq",
		url: "https://relay.example.test/synthetic",
		metadata: {
			namespace: "owned",
			catalogTrackName: "catalog",
			draftVersion: 16,
			mediaTypes: ["audio", "video"],
		},
	},
};
describe("received canvas surface lifetime", () => {
	it("keeps capture tracks alive until recording and Analytics finish, then releases even on finalization failure", async () => {
		vi.resetAllMocks();
		const host = document.createElement("div");
		const source = {
			setTargetBufferLevel: vi.fn(),
			setVolume: vi.fn(),
			play: vi.fn(),
		};
		const player = {
			sources: { add: () => source, remove: vi.fn() },
			dispose: vi.fn().mockResolvedValue(undefined),
		};
		let reject!: (error: Error) => void;
		const finalization = new Promise<void>((_resolve, fail) => {
			reject = fail;
		});
		const session = createMoqPlayback(
			() => player,
			descriptor,
			host,
			vi.fn(),
			vi.fn(),
			{
				startedAt: 0,
				onStatistics: vi.fn(),
				beforeDispose: () => finalization,
			},
		);
		await session.ready;
		const done = session.dispose();
		const failed = expect(done).rejects.toThrow(
			/^MoQ playback cleanup failed$/,
		);
		await Promise.resolve();
		expect(calls.stop).toHaveBeenCalled();
		expect(calls.disposeSurface).not.toHaveBeenCalled();
		expect(player.dispose).not.toHaveBeenCalled();
		reject(new Error("private-token"));
		await failed;
		expect(calls.disposeSurface).toHaveBeenCalledOnce();
		expect(player.sources.remove).toHaveBeenCalledOnce();
		expect(player.dispose).toHaveBeenCalledOnce();
	});
});
