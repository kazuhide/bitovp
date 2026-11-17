import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMoqObservationWriter } from "./history-client";
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
	it("uploads an archive only to its owned session and accepts validated metadata after server success", async () => {
		const writer = createMoqObservationWriter({
			channelId: CHANNEL,
			runId: RUN,
			sessionId: SESSION,
			onState: vi.fn(),
		});
		await writer.ready;
		const fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					runId: RUN,
					sessionId: SESSION,
					archive: {
						contentType: "video/webm",
						bytes: 5,
						sha256: "a".repeat(64),
						durationMs: 1000,
						recordedAt: "2026-11-18T00:00:00.000Z",
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetch);
		const abort = new AbortController();
		await writer.archive(new Blob(["webm!"]), 1000, abort.signal);
		expect(fetch).toHaveBeenCalledWith(
			`/api/live-channels/${CHANNEL}/runs/${RUN}/moq-observations/${SESSION}/archive`,
			expect.objectContaining({
				method: "PUT",
				signal: abort.signal,
				headers: {
					"Content-Type": "video/webm",
					"X-BitOVP-Moq-Duration-Ms": "1000",
				},
			}),
		);
		await writer.finish("ended");
	});
});
