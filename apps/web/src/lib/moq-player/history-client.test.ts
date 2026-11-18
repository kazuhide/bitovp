import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMoqObservationWriter } from "./history-client";
import { MoqArchiveSaveUnconfirmed } from "./recording";
import { EMPTY_MOQ_VIDEO_STATISTICS } from "./video-statistics";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
const CHANNEL = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const SESSION = "00000000-0000-4000-8000-000000000003";
beforeEach(() => {
	vi.useFakeTimers();
	mocks.api.mockReset();
	mocks.api.mockImplementation(async (_path: string, init: RequestInit) => ({
		runId: RUN,
		session: {
			...JSON.parse(String(init.body)),
			id: SESSION,
			createdAt: "2026-11-18T00:00:00.000Z",
			updatedAt: "2026-11-18T00:00:00.000Z",
			archive: null,
		},
	}));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
describe("owned MoQ observation writer", () => {
	it("recording the observation deadline never reports the player ended", async () => {
		const origin = performance.now();
		await vi.advanceTimersByTimeAsync(12_000);
		const writer = createMoqObservationWriter({
			channelId: CHANNEL,
			runId: RUN,
			sessionId: SESSION,
			startedAt: "2026-11-18T00:00:00.000Z",
			startedMonotonicMs: origin,
			onState: vi.fn(),
		});
		await writer.ready;
		writer.event("first-frame");
		await vi.advanceTimersByTimeAsync(588_000);
		expect(JSON.parse(mocks.api.mock.calls.at(-1)?.[1].body)).toMatchObject({
			endedAt: "2026-11-18T00:10:00.000Z",
			events: [
				{ elapsedMs: 0, type: "started" },
				{ elapsedMs: 12_000, type: "first-frame" },
				{ elapsedMs: 600_000, type: "observation-limit" },
			],
		});
		const saved = mocks.api.mock.calls.length;
		writer.event("frame-gap");
		await writer.finish("stopped");
		expect(mocks.api).toHaveBeenCalledTimes(saved);
	});
	it("closes at the observation boundary when a user stops before a throttled timer fires", async () => {
		let now = 0;
		const writer = createMoqObservationWriter({
			channelId: CHANNEL,
			runId: RUN,
			sessionId: SESSION,
			now: () => now,
			onState: vi.fn(),
		});
		await writer.ready;
		now = 605_000;
		writer.sample(EMPTY_MOQ_VIDEO_STATISTICS);
		writer.event("first-frame");
		await writer.finish("stopped");
		expect(JSON.parse(mocks.api.mock.calls.at(-1)?.[1].body)).toMatchObject({
			events: [
				{ elapsedMs: 0, type: "started" },
				{ elapsedMs: 600_000, type: "observation-limit" },
			],
			samples: [],
		});
	});
	it("retains stages observed while the initial save is still pending", async () => {
		const ordinary = mocks.api.getMockImplementation();
		let acknowledge!: () => void;
		mocks.api.mockImplementationOnce(
			(path: string, init: RequestInit) =>
				new Promise((resolve) => {
					acknowledge = () => resolve(ordinary?.(path, init));
				}),
		);
		const writer = createMoqObservationWriter({
			channelId: CHANNEL,
			runId: RUN,
			sessionId: SESSION,
			now: () => 0,
			onState: vi.fn(),
		});
		writer.event("subscribe-requested", 12);
		writer.event("first-frame", 915);
		const final = writer.finish("stopped");
		acknowledge();
		await final;
		expect(JSON.parse(mocks.api.mock.calls.at(-1)?.[1].body).events).toEqual([
			{ elapsedMs: 0, type: "started" },
			{ elapsedMs: 12, type: "subscribe-requested" },
			{ elapsedMs: 915, type: "first-frame" },
			{ elapsedMs: 915, type: "stopped" },
		]);
	});
	it("persists canvas provenance with visual update rate and unavailable original decoder counters", async () => {
		let now = 0;
		const writer = createMoqObservationWriter({
			channelId: CHANNEL,
			runId: RUN,
			sessionId: SESSION,
			now: () => now,
			onState: vi.fn(),
		});
		await writer.ready;
		now = 1000;
		writer.sample({
			...EMPTY_MOQ_VIDEO_STATISTICS,
			renderingSource: "canvas",
			fps: 2,
		});
		await writer.finish("stopped");
		expect(
			JSON.parse(mocks.api.mock.calls.at(-1)?.[1].body).samples[0],
		).toMatchObject({
			renderingSource: "canvas",
			fps: 2,
			decodedFrames: null,
			droppedFrames: null,
			totalFrames: null,
			presentedFrames: null,
		});
	});
	it("keeps the descriptor digest paired with the first collector impression across later flushes", async () => {
		const digest = "a".repeat(64);
		const initial = {
			channelId: CHANNEL,
			runId: RUN,
			sessionId: SESSION,
			analyticsLicenseKeySha256: digest,
			onState: vi.fn(),
		};
		const writer = createMoqObservationWriter(initial);
		await writer.ready;
		writer.setAnalyticsImpressionId(CHANNEL);
		initial.analyticsLicenseKeySha256 = "b".repeat(64);
		writer.setAnalyticsImpressionId(RUN);
		await writer.flush();
		await writer.finish("ended");
		for (const call of mocks.api.mock.calls.slice(1)) {
			expect(JSON.parse(call[1].body)).toMatchObject({
				analyticsImpressionId: CHANNEL,
				analyticsLicenseKeySha256: digest,
			});
		}
	});
	it("does not submit an impression without its original descriptor digest", async () => {
		const writer = createMoqObservationWriter({
			channelId: CHANNEL,
			runId: RUN,
			sessionId: SESSION,
			onState: vi.fn(),
		});
		await writer.ready;
		writer.setAnalyticsImpressionId(CHANNEL);
		await writer.finish("ended");
		const value = JSON.parse(mocks.api.mock.calls.at(-1)?.[1].body);
		expect(value).not.toHaveProperty("analyticsImpressionId");
		expect(value).not.toHaveProperty("analyticsLicenseKeySha256");
	});
	it.each([
		"MOQ_HISTORY_ANALYTICS_LICENSE_CHANGED",
		"MOQ_HISTORY_ANALYTICS_IMPRESSION_CONFLICT",
	])("saves observations and the archive when the first Analytics binding fails with %s", async (code) => {
		let now = 0;
		const unavailable = vi.fn();
		const writer = createMoqObservationWriter({
			channelId: CHANNEL,
			runId: RUN,
			sessionId: SESSION,
			analyticsLicenseKeySha256: "a".repeat(64),
			startedAt: "2026-11-18T00:00:00.000Z",
			now: () => now,
			onState: vi.fn(),
			onAnalyticsUnavailable: unavailable,
		});
		await writer.ready;
		now = 1000;
		writer.recordingStarted();
		writer.sample({ ...EMPTY_MOQ_VIDEO_STATISTICS, latencySeconds: 2 });
		writer.setAnalyticsImpressionId(CHANNEL);
		mocks.api.mockRejectedValueOnce({ status: 409, details: { code } });
		const upload = vi.fn(async () =>
			Response.json({
				runId: RUN,
				sessionId: SESSION,
				archive: {
					contentType: "video/webm",
					bytes: 5,
					sha256: "b".repeat(64),
					durationMs: 1000,
					recordedAt: "2026-11-18T00:00:01.000Z",
					captureStartedAt: "2026-11-18T00:00:01.000Z",
				},
			}),
		);
		vi.stubGlobal("fetch", upload);
		const final = writer.finish("stopped");
		await writer.archive(
			new Blob(["webm!"]),
			1000,
			new AbortController().signal,
		);
		await final;
		const first = JSON.parse(mocks.api.mock.calls[1]?.[1].body);
		const retry = JSON.parse(mocks.api.mock.calls[2]?.[1].body);
		expect(first.analyticsImpressionId).toBe(CHANNEL);
		expect(retry.analyticsImpressionId).toBeUndefined();
		expect(retry.analyticsLicenseKeySha256).toBeUndefined();
		expect(retry.samples).toEqual(first.samples);
		expect(retry.events).toEqual(first.events);
		expect(upload).toHaveBeenCalledOnce();
		expect(unavailable).toHaveBeenCalledOnce();
	});
	it("rejects a saved-session receipt for another run", async () => {
		mocks.api.mockResolvedValue({ runId: CHANNEL, session: { id: SESSION } });
		const writer = createMoqObservationWriter({
			channelId: CHANNEL,
			runId: RUN,
			sessionId: SESSION,
			onState: vi.fn(),
		});
		await expect(writer.ready).rejects.toThrow(
			/^MoQ observations could not be saved$/,
		);
		await writer.finish("failed").catch(() => {});
	});
	it("creates its actor-bound session before recording and flushes cumulative nullable samples", async () => {
		let now = 0;
		const writer = createMoqObservationWriter({
			channelId: CHANNEL,
			runId: RUN,
			sessionId: SESSION,
			startedAt: "2026-11-18T00:00:00.000Z",
			now: () => now,
			onState: vi.fn(),
		});
		await writer.ready;
		expect(mocks.api.mock.calls[0]?.[0]).toBe(
			`/api/live-channels/${CHANNEL}/runs/${RUN}/moq-observations/${SESSION}`,
		);
		now = 1000;
		writer.sample({
			...EMPTY_MOQ_VIDEO_STATISTICS,
			fps: 30,
			resolution: "640×360",
		});
		now = 1500;
		writer.sample(EMPTY_MOQ_VIDEO_STATISTICS);
		now = 2000;
		writer.sample(EMPTY_MOQ_VIDEO_STATISTICS);
		writer.event("first-frame");
		now = 5000;
		vi.advanceTimersByTime(5000);
		await writer.flush();
		const last = mocks.api.mock.calls.at(-1);
		const payload = JSON.parse(last?.[1].body);
		expect(payload.samples).toHaveLength(2);
		expect(payload.samples[0]).toMatchObject({
			elapsedMs: 1000,
			fps: 30,
			resolution: { width: 640, height: 360 },
			latencyMs: null,
		});
		expect(payload.samples[1].fps).toBeNull();
		now = 6000;
		await writer.finish("stopped");
		const final = JSON.parse(mocks.api.mock.calls.at(-1)?.[1].body);
		expect(final.endedAt).toBe("2026-11-18T00:00:06.000Z");
		expect(final.events.at(-1)).toEqual({ elapsedMs: 6000, type: "stopped" });
	});
	it("never accepts raw SDK errors, URLs or nonfinite metrics in its persisted DTO", async () => {
		let now = 0;
		const writer = createMoqObservationWriter({
			channelId: CHANNEL,
			runId: RUN,
			sessionId: SESSION,
			now: () => now,
			onState: vi.fn(),
		});
		await writer.ready;
		now = 1000;
		writer.sample({
			...EMPTY_MOQ_VIDEO_STATISTICS,
			fps: Number.POSITIVE_INFINITY,
			bufferSeconds: -1,
			resolution: "https://private-token",
		});
		await writer.finish("failed");
		const saved = JSON.parse(mocks.api.mock.calls.at(-1)?.[1].body);
		expect(saved.samples[0]).toMatchObject({
			fps: null,
			bufferSeconds: null,
			resolution: null,
		});
		expect(JSON.stringify(saved)).not.toContain("private-token");
	});
	it("uploads captured time to the owned session while an observation flush is pending", async () => {
		let now = 0;
		const writer = createMoqObservationWriter({
			channelId: CHANNEL,
			runId: RUN,
			sessionId: SESSION,
			startedAt: "2026-11-18T00:00:00.000Z",
			now: () => now,
			onState: vi.fn(),
		});
		await writer.ready;
		now = 4200;
		writer.recordingStarted();
		const captureStartedAt = "2026-11-18T00:00:04.200Z";
		let fail!: () => void;
		mocks.api.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					fail = () => reject(new Error("Test observation save failure"));
				}),
		);
		const observation = writer.flush();
		const blob = new Blob(["webm!"]);
		const upload = vi.fn(async () =>
			Response.json({
				runId: RUN,
				sessionId: SESSION,
				archive: {
					contentType: "video/webm",
					bytes: blob.size,
					sha256: "a".repeat(64),
					durationMs: 1000,
					recordedAt: "2026-11-18T00:00:05.200Z",
					captureStartedAt,
				},
			}),
		);
		vi.stubGlobal("fetch", upload);
		const signal = new AbortController().signal;
		await writer.archive(blob, 1000, signal);
		expect(upload).toHaveBeenCalledExactlyOnceWith(
			`/api/live-channels/${CHANNEL}/runs/${RUN}/moq-observations/${SESSION}/archive`,
			expect.objectContaining({
				method: "PUT",
				signal,
				headers: {
					"Content-Type": "video/webm",
					"X-BitOVP-Moq-Duration-Ms": "1000",
					"X-BitOVP-Moq-Capture-Started-At": captureStartedAt,
				},
			}),
		);
		fail();
		await expect(observation).rejects.toThrow();
		await writer.finish("ended");
		expect(
			JSON.parse(mocks.api.mock.calls.at(-1)?.[1].body).events,
		).toContainEqual({ type: "recording-started", elapsedMs: 4200 });
	});
	it("requires the expected capture time in the clip upload receipt", async () => {
		const writer = createMoqObservationWriter({
			channelId: CHANNEL,
			runId: RUN,
			sessionId: SESSION,
			startedAt: "2026-11-18T00:00:00.000Z",
			now: () => 0,
			onState: vi.fn(),
		});
		await writer.ready;
		writer.recordingStarted();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					runId: RUN,
					sessionId: SESSION,
					archive: {
						contentType: "video/webm",
						bytes: 5,
						sha256: "a".repeat(64),
						durationMs: 1000,
						recordedAt: "2026-11-18T00:00:05.100Z",
						captureStartedAt: "2026-11-18T00:00:04.100Z",
					},
				}),
			),
		);
		await expect(
			writer.archive(new Blob(["webm!"]), 1000, new AbortController().signal),
		).rejects.toBeInstanceOf(MoqArchiveSaveUnconfirmed);
		await writer.finish("stopped");
	});
});
