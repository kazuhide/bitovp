import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMoqPreviewArchive } from "./preview-archive";
import type { MoqPlaybackDescriptor } from "./types";

const mocks = vi.hoisted(() => ({
	api: vi.fn(),
	recording: vi.fn(),
	bridge: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
vi.mock("./recording", () => ({ createMoqRecording: mocks.recording }));
vi.mock("./analytics", () => ({ createMoqAnalyticsBridge: mocks.bridge }));
const CHANNEL = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const descriptor: MoqPlaybackDescriptor = {
	runId: RUN,
	encodingId: "00000000-0000-4000-8000-000000000004",
	playerLicenseKey: "private-key",
	resource: {
		type: "moq",
		url: "https://relay.example.test/private-token",
		metadata: {
			namespace: "owned-run",
			catalogTrackName: "catalog",
			draftVersion: 18,
			mediaTypes: ["audio", "video"],
		},
	},
};
beforeEach(() => {
	vi.useFakeTimers();
	vi.resetAllMocks();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});
const options = () => ({
	channelId: CHANNEL,
	runId: RUN,
	descriptor,
	startedAt: "2026-11-18T00:00:00.000Z",
	startedMonotonicMs: performance.now(),
	onRecordingState: vi.fn(),
	onHistoryState: vi.fn(),
	onAnalyticsState: vi.fn(),
	onPersisted: vi.fn(),
});
const receipt = (path: string) => ({
	runId: RUN,
	session: { id: path.split("/").at(-1) },
});
describe("owned preview finalization", () => {
	it("forwards the same immutable descriptor key digest as the collector created before a settings change", async () => {
		const digest = "a".repeat(64);
		const bound: MoqPlaybackDescriptor = {
			...descriptor,
			analytics: {
				licenseKey: "original-key",
				licenseKeySha256: digest,
				videoId: `bitovp-moq:${descriptor.encodingId}:${RUN}`,
				collectorVersion: "2.62.0",
				latencyField: "customData1",
			},
		};
		const bridge = {
			attach: vi.fn(),
			getImpressionId: () => CHANNEL,
			dispose: vi.fn().mockResolvedValue(undefined),
		};
		mocks.bridge.mockResolvedValue(bridge);
		mocks.recording.mockReturnValue({ finish: () => Promise.resolve() });
		mocks.api.mockImplementation(async (path: string) => receipt(path));
		const archive = createMoqPreviewArchive({
			...options(),
			descriptor: bound,
		});
		if (bound.analytics) {
			bound.analytics.licenseKey = "replacement-key";
			bound.analytics.licenseKeySha256 = "b".repeat(64);
		}
		await archive.ready;
		expect(mocks.bridge).toHaveBeenCalledWith(
			expect.objectContaining({ licenseKey: "original-key" }),
		);
		archive.video(document.createElement("video"));
		await archive.finish("stopped");
		const saved = JSON.parse(mocks.api.mock.calls.at(-1)?.[1].body);
		expect(saved).toMatchObject({
			analyticsImpressionId: CHANNEL,
			analyticsLicenseKeySha256: digest,
		});
		expect(JSON.stringify(saved)).not.toContain("original-key");
		expect(JSON.stringify(saved)).not.toContain("replacement-key");
		expect(bridge.dispose).toHaveBeenCalledOnce();
	});
	it("ends a session acknowledged after Stop and leaves no observation timers running", async () => {
		let acknowledge!: (value: unknown) => void;
		mocks.api.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					acknowledge = resolve;
				}),
		);
		mocks.api.mockImplementation(async (path: string) => receipt(path));
		const archive = createMoqPreviewArchive(options());
		vi.advanceTimersByTime(2000);
		const ended = archive.finish("stopped");
		acknowledge(receipt(mocks.api.mock.calls[0]?.[0]));
		await archive.ready;
		await ended;
		expect(mocks.api).toHaveBeenCalledTimes(2);
		const final = JSON.parse(mocks.api.mock.calls.at(-1)?.[1].body);
		expect(final.endedAt).toBe("2026-11-18T00:00:02.000Z");
		expect(final.events.at(-1)).toEqual({ type: "stopped", elapsedMs: 2000 });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(mocks.api).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
		expect(mocks.recording).not.toHaveBeenCalled();
	});
	it("keeps playback preparation available at the session cap without capturing unowned video", async () => {
		mocks.api.mockRejectedValue({
			details: { code: "MOQ_HISTORY_SESSION_LIMIT" },
			message: descriptor.resource.url,
		});
		const callbacks = options();
		const archive = createMoqPreviewArchive(callbacks);
		await expect(archive.ready).resolves.toBeUndefined();
		expect(callbacks.onHistoryState).toHaveBeenLastCalledWith("limit");
		expect(callbacks.onRecordingState).toHaveBeenLastCalledWith("unavailable");
		archive.video(document.createElement("video"));
		await archive.finish("stopped");
		expect(mocks.recording).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
