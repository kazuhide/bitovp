import { describe, expect, it, vi } from "vitest";
import { moqHeartbeatHistorySchema } from "@/lib/moq-player/heartbeat";
import { readMoqHeartbeatHistory } from "./moq-heartbeat";

const runId = "11111111-1111-4111-8111-111111111111";
const encodingId = "22222222-2222-4222-8222-222222222222";
const born = new Date("2026-11-18T00:00:00.000Z");
const now = new Date("2026-11-18T01:00:00.000Z");
const at = new Date("2026-11-18T00:00:30.000Z");

function store(
	rows: { at: Date; raw: unknown }[] = [],
	extra = {},
	push: { receivedAt: Date; raw: unknown }[] = [],
) {
	const run = {
		id: runId,
		bitmovinEncodingId: encodingId,
		createdAt: born,
		lastHeartbeat: null,
		lastHeartbeatAt: null,
		...extra,
	};
	const prisma = {
		liveChannelRun: { findFirst: vi.fn(async () => run) },
		liveHeartbeat: { findMany: vi.fn(async () => rows) },
		webhookEvent: { findMany: vi.fn(async () => push) },
	};
	return {
		prisma: prisma as unknown as Parameters<typeof readMoqHeartbeatHistory>[0],
		queries: prisma,
	};
}

describe("MoQ run heartbeat history", () => {
	it("retains only fixed metrics from the exact run and keeps their original units", async () => {
		const raw = {
			timestamp: "2026-11-18T00:00:29Z",
			ingest: {
				status: "CONNECTED",
				healthy: true,
				droppedPacketsVideo: 0,
				corruptPacketsAudio: 2,
				rtmpUserIngestInfo: { streamKey: "private-token" },
				streams: [
					{ mediaType: "audio", rate: 48000, incomingBitrate: 128000 },
					{ mediaType: "VIDEO", rate: 25, incomingBitrate: 800000 },
				],
			},
			output: {
				segments: {
					totalProcessingStatsMs: { min: 0, max: 18, mean: 12 },
				},
			},
			message: "private-token",
		};
		const { prisma, queries } = store([{ at, raw }]);
		const result = await readMoqHeartbeatHistory(prisma, runId, encodingId, {
			now,
		});
		expect(result).toMatchObject({
			source: "live-encoder-heartbeat",
			truncated: false,
			points: [
				{
					observedAt: at.toISOString(),
					sampledAt: "2026-11-18T00:00:29.000Z",
					source: "poll",
					ingestStatus: "CONNECTED",
					ingestHealthy: true,
					videoIncomingBitrateBps: 800000,
					audioIncomingBitrateBps: 128000,
					videoFps: 25,
					droppedPacketsVideo: 0,
					droppedPacketsAudio: null,
					corruptPacketsVideo: null,
					corruptPacketsAudio: 2,
					segmentProcessingMeanMs: 12,
					segmentProcessingMinMs: 0,
					segmentProcessingMaxMs: 18,
				},
			],
		});
		expect(JSON.stringify(result)).not.toContain("private-token");
		expect(queries.liveChannelRun.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: runId, bitmovinEncodingId: encodingId },
			}),
		);
		expect(queries.liveHeartbeat.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { liveChannelRunId: runId },
				take: 601,
			}),
		);
		expect(queries.webhookEvent.findMany).not.toHaveBeenCalled();
		expect(result).not.toHaveProperty("pushOutput");
		expect(moqHeartbeatHistorySchema.safeParse(result).success).toBe(true);
	});

	it("recovers output measurements from bound signed Push receipts and deduplicates replays", async () => {
		const sampledAt = "2026-11-18T00:00:29.000Z";
		const payload = (id: string, timestamp: string) => ({
			eventType: "LIVE_ENCODING_HEARTBEAT",
			webhookId: "33333333-3333-4333-8333-333333333333",
			encoding: { id },
			value: {
				timestamp,
				ingest: { status: "CONNECTED", healthy: true },
				output: {
					segments: {
						totalProcessingStatsMs: { mean: 12, min: 0, max: 18 },
						privateUrl: "private-token",
					},
				},
			},
		});
		const raw = payload(encodingId, sampledAt);
		const { prisma, queries } = store([], {}, [
			{ receivedAt: new Date("2026-11-18T00:00:42Z"), raw },
			{ receivedAt: at, raw },
			{ receivedAt: at, raw: payload(runId, sampledAt) },
			{ receivedAt: at, raw: payload(encodingId, "2026-11-17T23:59:59Z") },
			{ receivedAt: at, raw: payload(encodingId, "no-provider-time") },
			{ receivedAt: new Date(now.getTime() + 1), raw },
		]);
		const result = await readMoqHeartbeatHistory(prisma, runId, encodingId, {
			now,
			includePushOutput: true,
		});
		expect(queries.webhookEvent.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					source: "bitmovin",
					eventType: "LIVE_ENCODING_HEARTBEAT",
					signatureValid: true,
					liveChannelRunId: runId,
					raw: { path: ["encoding", "id"], equals: encodingId },
					receivedAt: { gte: born, lte: now },
				},
				take: 601,
			}),
		);
		expect(result).toEqual({
			source: "live-encoder-heartbeat",
			points: [],
			truncated: false,
			pushOutput: [
				{
					sampledAt,
					segmentProcessingMeanMs: 12,
					segmentProcessingMinMs: 0,
					segmentProcessingMaxMs: 18,
				},
			],
		});
		expect(moqHeartbeatHistorySchema.safeParse(result).success).toBe(true);
	});

	it("does not turn unavailable, invalid, or audio-only values into video measurements", async () => {
		const { prisma } = store([
			{
				at,
				raw: {
					timestamp: "private-token",
					ingest: {
						status: "DISCONNECTED",
						healthy: "true",
						droppedPacketsAudio: -1,
						corruptPacketsVideo: Number.NaN,
						streams: [{ mediaType: "AUDIO", rate: 48000, incomingBitrate: 0 }],
					},
					output: { segments: { totalProcessingStatsMs: { mean: Infinity } } },
				},
			},
		]);
		const result = await readMoqHeartbeatHistory(prisma, runId, encodingId, {
			now,
		});
		expect(result.points[0]).toMatchObject({
			sampledAt: null,
			ingestStatus: "DISCONNECTED",
			ingestHealthy: null,
			videoIncomingBitrateBps: null,
			audioIncomingBitrateBps: 0,
			videoFps: null,
			droppedPacketsAudio: null,
			corruptPacketsVideo: null,
			segmentProcessingMeanMs: null,
		});
	});

	it("discards unbound samples and never reads history for a different provider encoding", async () => {
		const { prisma, queries } = store([], { bitmovinEncodingId: "other" });
		expect(
			await readMoqHeartbeatHistory(prisma, runId, encodingId, {
				now,
				includePushOutput: true,
			}),
		).toEqual({
			source: "live-encoder-heartbeat",
			points: [],
			truncated: false,
		});
		expect(queries.liveHeartbeat.findMany).not.toHaveBeenCalled();
		expect(queries.webhookEvent.findMany).not.toHaveBeenCalled();
	});

	it("retains a newer run snapshot only with its dedicated heartbeat timestamp", async () => {
		const later = new Date("2026-11-18T00:01:00.000Z");
		const { prisma } = store(
			[{ at, raw: { ingest: { status: "CONNECTED" } } }],
			{
				lastHeartbeatAt: later,
				lastHeartbeat: {
					at: later.toISOString(),
					raw: { ingest: { status: "DISCONNECTED" } },
				},
			},
		);
		const result = await readMoqHeartbeatHistory(prisma, runId, encodingId, {
			now,
		});
		expect(
			result.points.map((point) => [point.observedAt, point.source]),
		).toEqual([
			[at.toISOString(), "poll"],
			[later.toISOString(), "run-last"],
		]);
	});

	it("does not duplicate polls, accept a mismatched snapshot anchor, or fabricate empty evidence", async () => {
		for (const lastHeartbeat of [
			{ at: at.toISOString(), raw: { ingest: { status: "CONNECTED" } } },
			{ at: "2026-11-18T00:00:29Z", raw: { ingest: { status: "ERROR" } } },
			{ at: at.toISOString(), raw: { secret: "private-token" } },
		]) {
			const { prisma } = store(
				[{ at, raw: { ingest: { status: "CONNECTED" } } }],
				{
					lastHeartbeatAt: at,
					lastHeartbeat,
				},
			);
			expect(
				(await readMoqHeartbeatHistory(prisma, runId, encodingId, { now }))
					.points,
			).toHaveLength(1);
		}
	});

	it("bounds history to the newest 600 observations and declares truncation", async () => {
		const rows = Array.from({ length: 601 }, (_, index) => ({
			at: new Date(born.getTime() + (601 - index) * 1000),
			raw: { ingest: { status: "CONNECTED", droppedPacketsVideo: index } },
		}));
		const { prisma } = store(rows);
		const result = await readMoqHeartbeatHistory(prisma, runId, encodingId, {
			now,
		});
		expect(result.points).toHaveLength(600);
		expect(result.truncated).toBe(true);
		expect(result.points[0]?.observedAt).toBe(rows[599]?.at.toISOString());
		expect(result.points[599]?.observedAt).toBe(rows[0]?.at.toISOString());
	});

	it("excludes observations outside this run or the read's clock and strips invalid sample clocks", async () => {
		const raw = {
			ingest: { status: "CONNECTED" },
			timestamp: "2027-01-01T00:00:00Z",
		};
		const { prisma } = store([
			{ at: new Date(now.getTime() + 1), raw },
			{ at, raw },
			{ at: new Date(born.getTime() - 1), raw },
			{ at: new Date("invalid"), raw },
		]);
		const result = await readMoqHeartbeatHistory(prisma, runId, encodingId, {
			now,
		});
		expect(result.points).toHaveLength(1);
		expect(result.points[0]?.sampledAt).toBeNull();
	});
});
