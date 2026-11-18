import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	moqArchiveClientOrigin,
	moqArchiveClientTime,
} from "./client-playback-time";
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
	vi.unstubAllGlobals();
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
	it("carries the clip start past the retained observation deadline into archive playback", async () => {
		const captureStartedAt = "2026-11-18T00:10:05.123Z";
		mocks.api.mockImplementation(async (path: string) => receipt(path));
		const blob = new Blob(["received WebM"]);
		mocks.recording.mockImplementation((_video, { onState, upload }) => {
			onState("recording");
			return { finish: () => upload(blob, 1000, new AbortController().signal) };
		});
		const savedArchive = {
			contentType: "video/webm",
			bytes: blob.size,
			sha256: "a".repeat(64),
			durationMs: 1000,
			recordedAt: "2026-11-18T00:10:10.000Z",
			captureStartedAt,
		} as const;
		const clip = vi.fn(async () =>
			Response.json({
				runId: RUN,
				sessionId: archive.id,
				archive: savedArchive,
			}),
		);
		vi.stubGlobal("fetch", clip);
		const archive = createMoqPreviewArchive(options());
		await vi.advanceTimersByTimeAsync(605_123);
		archive.video(document.createElement("video"));
		await archive.finish("stopped");
		expect(clip).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining(`/${archive.id}/archive`),
			expect.objectContaining({
				headers: expect.objectContaining({
					"X-BitOVP-Moq-Capture-Started-At": captureStartedAt,
				}),
			}),
		);
		const observation = JSON.parse(mocks.api.mock.calls.at(-1)?.[1].body);
		expect(observation.endedAt).toBe("2026-11-18T00:10:00.000Z");
		expect(observation.events.at(-1)).toEqual({
			type: "observation-limit",
			elapsedMs: 600_000,
		});
		expect(observation.events).not.toContainEqual(
			expect.objectContaining({ type: "recording-started" }),
		);
		expect(
			moqArchiveClientTime(
				moqArchiveClientOrigin({ ...observation, archive: savedArchive }),
				0.5,
				savedArchive.durationMs,
			),
		).toBe(Date.parse("2026-11-18T00:10:05.623Z"));
	});
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
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.bridge).toHaveBeenCalledWith(
			expect.objectContaining({ licenseKey: "original-key" }),
			expect.any(AbortSignal),
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
	it("attaches delayed Analytics to the existing receiving video and preserves a single owned recorder", async () => {
		let deliver!: (bridge: unknown) => void;
		mocks.bridge.mockReturnValueOnce(
			new Promise((resolve) => {
				deliver = resolve;
			}),
		);
		const bridge = {
			attach: vi.fn(),
			getImpressionId: () => CHANNEL,
			dispose: vi.fn().mockResolvedValue(undefined),
		};
		mocks.recording.mockReturnValue({ finish: () => Promise.resolve() });
		mocks.api.mockImplementation(async (path: string) => receipt(path));
		const archive = createMoqPreviewArchive({
			...options(),
			descriptor: {
				...descriptor,
				analytics: {
					licenseKey: "original-key",
					licenseKeySha256: "a".repeat(64),
					videoId: `bitovp-moq:${descriptor.encodingId}:${RUN}`,
					collectorVersion: "2.62.0",
					latencyField: "customData1",
				},
			},
		});
		const video = document.createElement("video");
		archive.video(video);
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.recording).toHaveBeenCalledExactlyOnceWith(
			video,
			expect.any(Object),
		);

		deliver(bridge);
		await vi.advanceTimersByTimeAsync(0);
		expect(bridge.attach).toHaveBeenCalledExactlyOnceWith(video);
		await archive.finish("stopped");
		const saved = JSON.parse(mocks.api.mock.calls.at(-1)?.[1].body);
		expect(saved.analyticsImpressionId).toBe(CHANNEL);
	});
	it("records the actual capture start after a late observation receipt", async () => {
		let acknowledge!: (value: unknown) => void;
		mocks.api.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					acknowledge = resolve;
				}),
		);
		mocks.api.mockImplementation(async (path: string) => receipt(path));
		mocks.recording.mockImplementation((_video, { onState }) => {
			onState("recording");
			return { finish: () => Promise.resolve() };
		});
		const archive = createMoqPreviewArchive(options());
		await vi.advanceTimersByTimeAsync(300);
		archive.event("first-frame", 300);
		archive.video(document.createElement("video"));
		await vi.advanceTimersByTimeAsync(3900);
		acknowledge(receipt(mocks.api.mock.calls[0]?.[0]));
		await vi.advanceTimersByTimeAsync(0);
		await archive.finish("stopped");

		const saved = JSON.parse(mocks.api.mock.calls.at(-1)?.[1].body);
		expect(saved.events).toEqual([
			{ type: "started", elapsedMs: 0 },
			{ type: "first-frame", elapsedMs: 300 },
			{ type: "recording-started", elapsedMs: 4200 },
			{ type: "stopped", elapsedMs: 4200 },
		]);
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
		archive.video(document.createElement("video"));
		vi.advanceTimersByTime(2000);
		const ended = archive.finish("stopped");
		acknowledge(receipt(mocks.api.mock.calls[0]?.[0]));
		await vi.advanceTimersByTimeAsync(0);
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
		await vi.advanceTimersByTimeAsync(0);
		expect(callbacks.onHistoryState).toHaveBeenLastCalledWith("limit");
		expect(callbacks.onRecordingState).toHaveBeenLastCalledWith("unavailable");
		archive.video(document.createElement("video"));
		await archive.finish("stopped");
		expect(mocks.recording).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
