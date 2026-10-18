import { beforeEach, describe, expect, it, vi } from "vitest";

const heartbeatFindMany = vi.fn();
const webhookFindMany = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			liveHeartbeat: { findMany: heartbeatFindMany },
			webhookEvent: { findMany: webhookFindMany },
		},
	}),
}));

import { GET } from "./route";

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000bb";

function getHistory(query = "") {
	return GET(
		new Request(
			`http://test/api/live-channels/${CHANNEL_ID}/heartbeats${query}`,
		),
		{ params: Promise.resolve({ id: CHANNEL_ID }) },
	);
}

/** A persisted-row shape ({ at: Date, raw, deltas }) as Prisma would return. */
function row(
	at: string,
	deltas: Record<string, number>,
	extra: { status?: string; streams?: unknown[] } = {},
) {
	return {
		at: new Date(at),
		raw: {
			ingest: {
				status: extra.status ?? "CONNECTED",
				...(extra.streams ? { streams: extra.streams } : {}),
			},
		},
		deltas,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	heartbeatFindMany.mockResolvedValue([]);
	webhookFindMany.mockResolvedValue([]);
});

describe("GET /api/live-channels/[id]/heartbeats", () => {
	it("runId scopes to the RUN, un-windowed, still channel-scoped (ledger #167)", async () => {
		heartbeatFindMany.mockResolvedValue([]);
		const RUN_ID = "00000000-0000-4000-8000-0000000000cd";
		const res = await GET(new Request(`http://test?runId=${RUN_ID}`), {
			params: Promise.resolve({ id: CHANNEL_ID }),
		});
		expect(res.status).toBe(200);
		const args = heartbeatFindMany.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
		};
		// The whole run — no `at` window (a finished run's samples are all
		// older than any recent window) — and BOTH ids, so a foreign run id
		// reads as zero rows rather than another channel's data.
		expect(args.where).toEqual({
			liveChannelId: CHANNEL_ID,
			liveChannelRunId: RUN_ID,
		});
	});

	it("a malformed runId is a 400, not an unscoped query", async () => {
		const res = await GET(new Request("http://test?runId=nope"), {
			params: Promise.resolve({ id: CHANNEL_ID }),
		});
		expect(res.status).toBe(400);
		expect(heartbeatFindMany).not.toHaveBeenCalled();
	});

	it("400s on a non-UUID id", async () => {
		const res = await GET(
			new Request("http://test/api/live-channels/x/heartbeats"),
			{
				params: Promise.resolve({ id: "not-a-uuid" }),
			},
		);
		expect(res.status).toBe(400);
		expect(heartbeatFindMany).not.toHaveBeenCalled();
	});

	it("returns an ordered, projected series with the default window", async () => {
		heartbeatFindMany.mockResolvedValueOnce([
			row(
				"2026-06-12T00:00:00.000Z",
				{ droppedPacketsVideo: 1 },
				{
					streams: [{ bitrate: 4_500_000, rate: 30 }],
				},
			),
			row("2026-06-12T00:00:30.000Z", {
				droppedPacketsVideo: 0,
				corruptPacketsAudio: 2,
			}),
		]);
		const res = await getHistory();
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.windowMinutes).toBe(120);
		expect(body.points).toHaveLength(2);
		// Projected: at + the four delta keys + status + representative bitrate/fps.
		expect(body.points[0]).toMatchObject({
			at: "2026-06-12T00:00:00.000Z",
			droppedPacketsVideo: 1,
			droppedPacketsAudio: 0,
			corruptPacketsVideo: 0,
			corruptPacketsAudio: 0,
			ingestStatus: "CONNECTED",
			bitrate: 4_500_000,
			fps: 30,
		});
		expect(body.points[1]).toMatchObject({ corruptPacketsAudio: 2 });
		// Queried within the lookback window, ordered ascending by `at`.
		expect(heartbeatFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					liveChannelId: CHANNEL_ID,
					at: expect.objectContaining({ gte: expect.any(Date) }),
				}),
				orderBy: { at: "asc" },
			}),
		);
	});

	it("returns [] for a window with no history", async () => {
		const res = await getHistory();
		const body = await res.json();
		expect(body.points).toEqual([]);
	});

	it("downsamples a >500-row window and keeps the spike", async () => {
		// 600 quiet polls with one packet-loss spike buried in the middle.
		const SPIKE_AT = "2026-06-12T05:00:00.000Z";
		const rows = Array.from({ length: 600 }, (_, i) =>
			row(
				new Date(
					Date.parse("2026-06-12T00:00:00.000Z") + i * 30_000,
				).toISOString(),
				{ droppedPacketsVideo: 0 },
			),
		);
		rows[300] = row(SPIKE_AT, { droppedPacketsVideo: 999 });
		heartbeatFindMany.mockResolvedValueOnce(rows);
		const res = await getHistory();
		const body = await res.json();
		// Capped at HEARTBEAT_POINT_CAP (500)…
		expect(body.points.length).toBeLessThanOrEqual(500);
		expect(body.points.length).toBeLessThan(600);
		// …but the spike survived the reduction (the whole point of the chart).
		const spike = body.points.find(
			(p: { droppedPacketsVideo: number }) => p.droppedPacketsVideo === 999,
		);
		expect(spike).toBeTruthy();
	});

	it("caps the window at 360 minutes", async () => {
		await getHistory("?windowMinutes=10000");
		const body = await (await getHistory("?windowMinutes=10000")).json();
		expect(body.windowMinutes).toBe(360);
	});

	it("falls back to the default window on a bad value", async () => {
		const body = await (await getHistory("?windowMinutes=-5")).json();
		expect(body.windowMinutes).toBe(120);
	});

	it("supersedes poll with push when verified receipts exist (finer cadence, computed deltas + incoming bitrate)", async () => {
		const RUN = "00000000-0000-4000-8000-0000000000ce";
		// Poll rows only supply the run id here; push (2s) replaces them.
		heartbeatFindMany.mockResolvedValueOnce([
			{
				at: new Date("2026-06-12T00:00:00.000Z"),
				raw: { ingest: { status: "CONNECTED" } },
				deltas: { droppedPacketsVideo: 0 },
				liveChannelRunId: RUN,
			},
		]);
		webhookFindMany.mockResolvedValueOnce([
			{
				receivedAt: new Date("2026-06-12T00:00:00.000Z"),
				raw: {
					value: {
						timestamp: "2026-06-12T00:00:00.000Z",
						ingest: {
							status: "CONNECTED",
							droppedPacketsVideo: 10,
							streams: [
								{ mediaType: "VIDEO", incomingBitrate: 5_000_000, rate: 30 },
							],
						},
					},
				},
			},
			{
				receivedAt: new Date("2026-06-12T00:00:02.000Z"),
				raw: {
					value: {
						timestamp: "2026-06-12T00:00:02.000Z",
						ingest: {
							status: "CONNECTED",
							droppedPacketsVideo: 15,
							streams: [{ mediaType: "VIDEO", incomingBitrate: 4_800_000 }],
						},
					},
				},
			},
		]);
		const body = await (await getHistory()).json();
		expect(body.source).toBe("push");
		expect(body.points).toHaveLength(2);
		// First push sample has no predecessor → deltas 0; incoming bitrate lifted.
		expect(body.points[0]).toMatchObject({
			at: "2026-06-12T00:00:00.000Z",
			droppedPacketsVideo: 0,
			incomingBitrate: 5_000_000,
		});
		// Second: cumulative 15 − 10 = 5 dropped since the previous sample.
		expect(body.points[1]).toMatchObject({
			droppedPacketsVideo: 5,
			incomingBitrate: 4_800_000,
		});
		// Push query is scoped to the run and the window, signature-verified only.
		expect(webhookFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					eventType: "LIVE_ENCODING_HEARTBEAT",
					signatureValid: true,
					liveChannelRunId: { in: [RUN] },
				}),
				orderBy: { receivedAt: "asc" },
			}),
		);
	});

	it("stays on poll when no verified push receipt exists", async () => {
		heartbeatFindMany.mockResolvedValueOnce([
			row("2026-06-12T00:00:00.000Z", { droppedPacketsVideo: 1 }),
		]);
		// webhookFindMany defaults to [] → poll path.
		const body = await (await getHistory()).json();
		expect(body.source).toBe("poll");
		expect(body.points).toHaveLength(1);
	});

	it("falls back to the complete poll series when the push read is truncated", async () => {
		const RUN = "00000000-0000-4000-8000-0000000000cf";
		heartbeatFindMany.mockResolvedValueOnce([
			{
				at: new Date("2026-06-12T00:00:00.000Z"),
				raw: { ingest: { status: "CONNECTED" } },
				deltas: { droppedPacketsVideo: 7 },
				liveChannelRunId: RUN,
			},
		]);
		// One more than the cap (route takes MAX_PUSH_ROWS + 1) → truncated, so
		// push must NOT supersede the un-windowed, complete poll series.
		webhookFindMany.mockResolvedValueOnce(
			Array.from({ length: 11_001 }, (_, i) => ({
				receivedAt: new Date(
					Date.parse("2026-06-12T00:00:00.000Z") + i * 2_000,
				),
				raw: {
					value: {
						timestamp: new Date(
							Date.parse("2026-06-12T00:00:00.000Z") + i * 2_000,
						).toISOString(),
						ingest: { status: "CONNECTED", droppedPacketsVideo: i },
					},
				},
			})),
		);
		const body = await (await getHistory()).json();
		expect(body.source).toBe("poll");
		expect(body.points).toHaveLength(1);
		expect(body.points[0]).toMatchObject({ droppedPacketsVideo: 7 });
	});
});
