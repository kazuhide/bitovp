import { beforeEach, describe, expect, it, vi } from "vitest";

const runFindFirst = vi.fn();
const channelFindUnique = vi.fn();
const heartbeatFindMany = vi.fn();
const auditFindMany = vi.fn();
const scheduleFindMany = vi.fn();
const webhookEventFindMany = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			liveChannelRun: { findFirst: runFindFirst },
			liveChannel: { findUnique: channelFindUnique },
			liveHeartbeat: { findMany: heartbeatFindMany },
			auditLog: { findMany: auditFindMany },
			liveSchedule: { findMany: scheduleFindMany },
			webhookEvent: { findMany: webhookEventFindMany },
		},
	}),
}));

import type { RunHealthResponse } from "./route";
import { GET } from "./route";

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000c1";
const RUN_ID = "00000000-0000-4000-8000-0000000000c2";
const ENC_ID = "00000000-0000-4000-8000-0000000000c3";
const ctx = () => ({
	params: Promise.resolve({ id: CHANNEL_ID, runId: RUN_ID }),
});

const T0 = Date.parse("2026-08-24T00:00:00Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

/** A heartbeat row the ingest predicate and output freshness both accept. */
function hbRow(s: number) {
	return {
		at: new Date(T0 + s * 1000),
		raw: {
			// The #95 predicate accepts status CONNECTED or healthy:true —
			// explicit signals only (review-224 C1's wrapper shape).
			ingest: { status: "CONNECTED" },
			output: {
				manifests: {
					hls: [{ manifestUpdates: [{ manifestUpdateWallClockTime: iso(s) }] }],
				},
			},
		},
	};
}

function baseRun(over: Record<string, unknown> = {}) {
	return {
		id: RUN_ID,
		seq: 3,
		status: "STOPPED",
		createdAt: new Date(T0 - 120_000),
		stepLog: [
			{
				step: "start",
				kind: "START_LIVE_ENCODING",
				startedAt: iso(0),
				finishedAt: iso(2),
			},
		],
		runningSince: new Date(T0 + 180_000),
		endedAt: new Date(T0 + 900_000),
		bitmovinEncodingId: ENC_ID,
		queueSeconds: 572,
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	runFindFirst.mockResolvedValue(baseRun());
	channelFindUnique.mockResolvedValue({
		plan: { liveManifests: [{ kind: "HLS" }] },
	});
	heartbeatFindMany.mockResolvedValue([hbRow(210), hbRow(240)]);
	auditFindMany.mockResolvedValue([]);
	scheduleFindMany.mockResolvedValue([]);
	webhookEventFindMany.mockResolvedValue([]);
});

describe("GET …/runs/[runId]/health — the ledger #166 timeline", () => {
	it("window and lifecycle events come from the step log and the run row", async () => {
		const res = await GET(new Request("http://test"), ctx());
		expect(res.status).toBe(200);
		const body = (await res.json()) as RunHealthResponse;
		// Axis origin = START_LIVE_ENCODING.startedAt, NOT createdAt (which
		// sits 120s earlier, covering provisioning the owner did not ask for).
		expect(body.timeline.window).toEqual({
			startMs: T0,
			endMs: T0 + 900_000,
		});
		const kinds = body.timeline.events.map((e) => e.kind);
		expect(kinds).toEqual([
			"START_REQUESTED",
			"ENCODER_QUEUED",
			"ENCODER_RUNNING",
			"INPUT_CONNECTED",
			"OUTPUT_ACTIVE",
			"ENCODER_STOPPED",
		]);
		// #160's measured queue seconds ride the run object — the startup
		// FIGURE the chart no longer draws (owner follow-up).
		expect(body.run.queueSeconds).toBe(572);
	});

	it("falls back to createdAt with NO start/queued claim when the step log lacks the step (backfilled run #1)", async () => {
		runFindFirst.mockResolvedValue(baseRun({ stepLog: [] }));
		const res = await GET(new Request("http://test"), ctx());
		const body = (await res.json()) as RunHealthResponse;
		expect(body.timeline.window.startMs).toBe(T0 - 120_000);
		const kinds = body.timeline.events.map((e) => e.kind);
		expect(kinds).not.toContain("START_REQUESTED");
		expect(kinds).not.toContain("ENCODER_QUEUED");
	});

	it("a RUNNING run has no window end and no stop event", async () => {
		runFindFirst.mockResolvedValue(baseRun({ endedAt: null }));
		const res = await GET(new Request("http://test"), ctx());
		const body = (await res.json()) as RunHealthResponse;
		expect(body.timeline.window.endMs).toBeUndefined();
		expect(body.timeline.events.map((e) => e.kind)).not.toContain(
			"ENCODER_STOPPED",
		);
	});

	it("inserted content: audit rows keyed by the run's OWN encoding id; runAt wins over call time; /stop maps to CONTENT_STOPPED; fired SLATE_IN rows join", async () => {
		auditFindMany.mockResolvedValue([
			{
				at: new Date(T0 + 300_000),
				method: "POST",
				statusCode: 201,
				path: `/encoding/encodings/${ENC_ID}/live/insertable-content/abc/schedule`,
				// The redacted request carries the future runAt — the EVENT is
				// when the content airs, not when the operator clicked.
				request: { contentId: "abc", runAt: iso(360) },
				response: { id: "sched-live" },
			},
			{
				at: new Date(T0 + 420_000),
				method: "POST",
				statusCode: 201,
				path: `/encoding/encodings/${ENC_ID}/live/insertable-content/stop`,
				request: null,
				response: null,
			},
		]);

		const res = await GET(new Request("http://test"), ctx());
		const body = (await res.json()) as RunHealthResponse;
		const actionEvents = body.timeline.events.filter(
			(e) => e.source === "action",
		);
		expect(actionEvents).toEqual([
			{ kind: "CONTENT_INSERTED", atMs: T0 + 360_000, source: "action" },
			{ kind: "CONTENT_STOPPED", atMs: T0 + 420_000, source: "action" },
		]);
		// The audit query is scoped to THIS run's encoding id, classified in
		// the WHERE (review-296 I6: ignored rows must not eat the cap), and
		// bounded.
		const auditArgs = auditFindMany.mock.calls[0]?.[0] as {
			where: { OR: { path: Record<string, string> }[] };
			take: number;
		};
		const arms = auditArgs.where.OR.map((o) => {
			const [op, value] = Object.entries(o.path)[0] as [string, string];
			return `${op}:${value}`;
		});
		// The EXACT five arms (review-296 S3: classification spans two layers
		// and the mocks bypass the DB one — a dropped arm means those rows
		// never load in production while every mocked test stays green).
		const prefix = `/encodings/${ENC_ID}/live/`;
		expect(arms.sort()).toEqual(
			[
				`endsWith:${prefix}stop`,
				`endsWith:${prefix}restart`,
				`endsWith:${prefix}reset-live-manifest-timeshift`,
				`endsWith:${prefix}esam/media-points`,
				`contains:${prefix}insertable-content/`,
			].sort(),
		);
		// take = cap + 1: the overflow row is the truncation SIGNAL (S1),
		// sliced off before use.
		expect(auditArgs.take).toBe(101);
	});

	it("detail events: every audit kind lands once — SCTE audit twin deduped, ESAM steplog twin deduped, failed stop still a REQUEST (owner 2026-08-24 + review-296 I8)", async () => {
		auditFindMany.mockResolvedValue([
			{
				// A scheduler slate's own audit row (the worker audits into
				// the same table) — the ONLY source now; LiveSchedule.firedAt
				// was removed because reading both painted every scheduler
				// action twice.
				at: new Date(T0 + 400_000),
				method: "POST",
				statusCode: 201,
				path: `/encoding/encodings/${ENC_ID}/live/insertable-content/abc/schedule`,
				request: { contentId: "abc" },
				response: { id: "sched-w" },
			},
			{
				// The worker's SCTE audit row — the step log records the SAME
				// cue below; exactly ONE event may come out.
				at: new Date(T0 + 500_500),
				method: "POST",
				statusCode: 201,
				path: `/encoding/encodings/${ENC_ID}/live/scte-35-cue`,
				request: null,
				response: null,
			},
			{
				// A web-initiated ESAM media point (audit-only — no step log
				// twin for the web path).
				at: new Date(T0 + 560_000),
				method: "POST",
				statusCode: 201,
				path: `/encoding/encodings/${ENC_ID}/live/esam/media-points`,
				request: null,
				response: null,
			},
			{
				at: new Date(T0 + 700_000),
				method: "POST",
				statusCode: 201,
				path: `/encoding/encodings/${ENC_ID}/live/restart`,
				request: null,
				response: null,
			},
			{
				// A DVR shrink (review-296 S2).
				at: new Date(T0 + 750_000),
				method: "POST",
				statusCode: 201,
				path: `/encoding/encodings/${ENC_ID}/live/reset-live-manifest-timeshift`,
				request: null,
				response: null,
			},
			{
				// A FAILED stop request — the REQUEST is the event; without it
				// the run renders ENCODER_STOPPED with no explanation
				// (review-296's Q3 finding).
				at: new Date(T0 + 800_000),
				method: "POST",
				statusCode: 500,
				path: `/encoding/encodings/${ENC_ID}/live/stop`,
				request: null,
				response: null,
			},
			{
				// The operator's stop — the event that explains the
				// last-sample→ENCODER_STOPPED gap.
				at: new Date(T0 + 850_000),
				method: "POST",
				statusCode: 201,
				path: `/encoding/encodings/${ENC_ID}/live/stop`,
				request: null,
				response: null,
			},
		]);
		runFindFirst.mockResolvedValue(
			baseRun({
				stepLog: [
					{
						step: "start",
						kind: "START_LIVE_ENCODING",
						startedAt: iso(0),
						finishedAt: iso(2),
					},
					{
						step: "scte:1",
						kind: "SCTE35_CUE",
						status: "DONE",
						startedAt: iso(500),
					},
					{
						// The web writer records TWICE (audit + step entry) —
						// this steplog ESAM is the audit row's TWIN and must
						// NOT double-dot (review-296 I8, demonstrated).
						step: "esam:1",
						kind: "ESAM_MEDIA_POINT",
						status: "DONE",
						startedAt: iso(560),
					},
					{
						// DONE but timestamp missing — a record nobody can place
						// on an axis is not an event (review-296 N1).
						step: "scte:3",
						kind: "SCTE35_CUE",
						status: "DONE",
					},
					{
						// A FAILED runtime record is not an event that happened.
						step: "scte:2",
						kind: "SCTE35_CUE",
						status: "FAILED",
						startedAt: iso(540),
					},
				],
			}),
		);
		const res = await GET(new Request("http://test"), ctx());
		const body = (await res.json()) as RunHealthResponse;
		const acts = body.timeline.events
			.filter((e) => e.source === "action")
			.map((e) => `${e.kind}@${(e.atMs - T0) / 1000}`);
		expect(acts).toEqual([
			"CONTENT_INSERTED@400",
			"SCTE35_CUE@500",
			"ESAM_SIGNAL@560",
			"RESTART_REQUESTED@700",
			"TIMESHIFT_RESET@750",
			"STOP_REQUESTED@800",
			"STOP_REQUESTED@850",
		]);
		// The scheduler-rows table is no longer a source at all.
		expect(scheduleFindMany).not.toHaveBeenCalled();
	});

	it("a content REGISTRATION is not an insert — zero action events (review-294 C2)", async () => {
		// The register call audits at the bare …/insertable-content path
		// (same prefix, 201, inside the window — the exact row C2 proved
		// painted a phantom insert). Only …/schedule may claim one.
		auditFindMany.mockResolvedValue([
			{
				at: new Date(T0 + 300_000),
				method: "POST",
				statusCode: 201,
				path: `/encoding/encodings/${ENC_ID}/live/insertable-content`,
				request: { contentId: "abc" },
				response: { id: "abc" },
			},
		]);
		const res = await GET(new Request("http://test"), ctx());
		const body = (await res.json()) as RunHealthResponse;
		expect(body.timeline.events.filter((e) => e.source === "action")).toEqual(
			[],
		);
	});

	it("a REFUSED cancel does not erase the aired slate — only an ACCEPTED cancel cancels (review-296 I9)", async () => {
		auditFindMany.mockResolvedValue([
			{
				at: new Date(T0 + 300_000),
				method: "POST",
				statusCode: 201,
				path: `/encoding/encodings/${ENC_ID}/live/insertable-content/abc/schedule`,
				request: { contentId: "abc", runAt: iso(360) },
				response: { id: "sched-1" },
			},
			{
				// Bitmovin REFUSED (content already started) — the slate aired.
				at: new Date(T0 + 355_000),
				method: "DELETE",
				statusCode: 500,
				path: `/encoding/encodings/${ENC_ID}/live/insertable-content/abc/schedule/sched-1`,
				request: null,
				response: null,
			},
		]);
		const res = await GET(new Request("http://test"), ctx());
		const body = (await res.json()) as RunHealthResponse;
		expect(body.timeline.events.filter((e) => e.source === "action")).toEqual([
			{ kind: "CONTENT_INSERTED", atMs: T0 + 360_000, source: "action" },
		]);
	});

	it("a CANCELLED schedule and a beyond-window runAt never happened (review-294 I2)", async () => {
		auditFindMany.mockResolvedValue([
			{
				// Scheduled, then cancelled below — matched via response.id.
				at: new Date(T0 + 300_000),
				method: "POST",
				statusCode: 201,
				path: `/encoding/encodings/${ENC_ID}/live/insertable-content/abc/schedule`,
				request: { contentId: "abc", runAt: iso(360) },
				response: { id: "sched-1" },
			},
			{
				at: new Date(T0 + 320_000),
				method: "DELETE",
				statusCode: 200,
				path: `/encoding/encodings/${ENC_ID}/live/insertable-content/abc/schedule/sched-1`,
				request: null,
				response: null,
			},
			{
				// Scheduled for AFTER the run stopped (endedAt = +900s) —
				// content that never aired must not be drawn as an event.
				at: new Date(T0 + 400_000),
				method: "POST",
				statusCode: 201,
				path: `/encoding/encodings/${ENC_ID}/live/insertable-content/def/schedule`,
				request: { contentId: "def", runAt: iso(1200) },
				response: { id: "sched-2" },
			},
		]);
		const res = await GET(new Request("http://test"), ctx());
		const body = (await res.json()) as RunHealthResponse;
		expect(body.timeline.events.filter((e) => e.source === "action")).toEqual(
			[],
		);
	});

	it("no encoding id yet (provisioning): the audit query is SKIPPED, not issued with a broken key", async () => {
		runFindFirst.mockResolvedValue(
			baseRun({ bitmovinEncodingId: null, endedAt: null, stepLog: [] }),
		);
		const res = await GET(new Request("http://test"), ctx());
		expect(res.status).toBe(200);
		expect(auditFindMany).not.toHaveBeenCalled();
	});

	it("404s a run id belonging to another channel (scoped findFirst)", async () => {
		runFindFirst.mockResolvedValue(null);
		const res = await GET(new Request("http://test"), ctx());
		expect(res.status).toBe(404);
		const args = runFindFirst.mock.calls[0]?.[0] as {
			where: { id: string; liveChannelId: string };
		};
		expect(args.where).toEqual({ id: RUN_ID, liveChannelId: CHANNEL_ID });
	});

	it("reads NEWEST-first with the cap+1 signal and keeps the newest rows on overflow — 7-day retention means a run can exceed the cap (review-292 N5's flip)", async () => {
		// The store answers what a desc query returns: newest first, cap + 1
		// rows. The oldest of those is the overflow row the route must drop.
		const newestFirst = Array.from({ length: 2_881 }, (_, i) =>
			hbRow(300 + (2_880 - i) * 30),
		);
		heartbeatFindMany.mockResolvedValue(newestFirst);
		const res = await GET(new Request("http://test"), ctx());
		const body = (await res.json()) as RunHealthResponse;
		expect(heartbeatFindMany).toHaveBeenCalledWith(
			expect.objectContaining({ orderBy: { at: "desc" }, take: 2_881 }),
		);
		expect(body.truncated).toBe(true);
		expect(body.points).toHaveLength(2_880);
		// Ascending for the derivation, and the OLDEST fetched row (the
		// overflow) is the one dropped — the newest survives as the last point.
		expect(body.points[0]?.atMs).toBe(T0 + (300 + 30) * 1000);
		expect(body.points.at(-1)?.atMs).toBe(T0 + (300 + 2_880 * 30) * 1000);
	});
});

describe("state lines follow Push where received, Poll elsewhere (row #328)", () => {
	/** A verified Push receipt of THIS encoding, sampled at T0 + s. */
	function pushRow(s: number, status: "CONNECTED" | "DISCONNECTED") {
		return {
			raw: {
				eventType: "LIVE_ENCODING_HEARTBEAT",
				webhookId: "00000000-0000-4000-8000-0000000000d1",
				encoding: { id: ENC_ID },
				value: {
					timestamp: iso(s),
					ingest: { status },
					output: {
						manifests: {
							hls: [
								{ manifestUpdates: [{ manifestUpdateWallClockTime: iso(s) }] },
							],
						},
					},
				},
			},
		};
	}

	it("ends the ingest span at the 2 s Push sample that saw the disconnect, not at the next 30 s poll", async () => {
		// Poll saw CONNECTED at 0 s and 60 s; Push saw the disconnect at 12 s.
		heartbeatFindMany.mockResolvedValue([hbRow(60), hbRow(0)]);
		const pushes = [];
		for (let s = 30; s >= 0; s -= 2) {
			pushes.push(pushRow(s, s >= 12 ? "DISCONNECTED" : "CONNECTED"));
		}
		webhookEventFindMany.mockResolvedValue(pushes);
		const res = await GET(new Request("http://test"), ctx());
		const body = (await res.json()) as RunHealthResponse;
		expect(webhookEventFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					eventType: "LIVE_ENCODING_HEARTBEAT",
					signatureValid: true,
					liveChannelRunId: RUN_ID,
				}),
				orderBy: { receivedAt: "desc" },
				take: 2_881,
			}),
		);
		expect(body.laneSources).toEqual({
			push: true,
			pushSamples: 16,
			pushOldestAtMs: T0,
			pushTruncated: false,
		});
		const ingest = body.lanes.ingest;
		expect(ingest).toHaveLength(2);
		expect(ingest[0]?.toMs).toBe(T0 + 10 * 1000);
		expect(ingest[1]?.fromMs).toBe(T0 + 60 * 1000);
	});

	it("keeps a lane continuous through a Push outage — Poll fills the gap (review-543 O4)", async () => {
		heartbeatFindMany.mockResolvedValue([hbRow(60), hbRow(30), hbRow(0)]);
		// Push stopped after 10 s (webhook muted); Poll kept going.
		webhookEventFindMany.mockResolvedValue(
			[10, 8, 6, 4, 2, 0].map((s) => pushRow(s, "CONNECTED")),
		);
		const res = await GET(new Request("http://test"), ctx());
		const body = (await res.json()) as RunHealthResponse;
		expect(body.lanes.ingest).toEqual([{ fromMs: T0, toMs: T0 + 60 * 1000 }]);
		expect(body.lanes.encoder).toEqual([{ fromMs: T0, toMs: T0 + 60 * 1000 }]);
	});

	it("bounds the receipt query to the run's lifetime and keeps one row per sample time (review-543 R1/O1)", async () => {
		heartbeatFindMany.mockResolvedValue([hbRow(0)]);
		// The same 4 s sample delivered twice (provider redelivery).
		webhookEventFindMany.mockResolvedValue([
			pushRow(4, "CONNECTED"),
			pushRow(4, "CONNECTED"),
			pushRow(2, "CONNECTED"),
		]);
		const res = await GET(new Request("http://test"), ctx());
		const body = (await res.json()) as RunHealthResponse;
		const call = webhookEventFindMany.mock.calls[0]?.[0] as {
			where: { receivedAt?: { gte?: Date; lte?: Date } };
		};
		expect(call.where.receivedAt?.gte).toEqual(baseRun().createdAt);
		expect(call.where.receivedAt?.lte).toBeInstanceOf(Date);
		expect(body.laneSources.pushSamples).toBe(2);
	});

	it("draws from Poll alone when the run has no Push receipt, exactly as before", async () => {
		heartbeatFindMany.mockResolvedValue([hbRow(60), hbRow(0)]);
		const res = await GET(new Request("http://test"), ctx());
		const body = (await res.json()) as RunHealthResponse;
		expect(body.laneSources).toEqual({
			push: false,
			pushSamples: 0,
			pushOldestAtMs: null,
			pushTruncated: false,
		});
		expect(body.lanes.ingest).toHaveLength(1);
		expect(body.lanes.ingest[0]?.toMs).toBe(T0 + 60 * 1000);
	});

	it("ignores receipts of another encoding and reports the Push budget", async () => {
		heartbeatFindMany.mockResolvedValue([hbRow(0)]);
		const foreign = pushRow(4, "CONNECTED");
		foreign.raw.encoding = { id: "00000000-0000-4000-8000-0000000000ee" };
		webhookEventFindMany.mockResolvedValue([
			foreign,
			...Array.from({ length: 2_881 }, (_, i) => pushRow(2 + i, "CONNECTED")),
		]);
		const res = await GET(new Request("http://test"), ctx());
		const body = (await res.json()) as RunHealthResponse;
		expect(body.laneSources.pushTruncated).toBe(true);
		// The budget keeps the NEWEST-first slice: 2,880 rows minus the foreign one.
		expect(body.laneSources.pushSamples).toBe(2_879);
	});
});
