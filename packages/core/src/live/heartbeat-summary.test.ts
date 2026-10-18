import { describe, expect, it } from "vitest";
import {
	parseRunHeartbeatSummary,
	RUN_HEARTBEAT_SUMMARY_VERSION,
	runHeartbeatSummarySchema,
	summarizeRunHeartbeats,
} from "./heartbeat-summary";
import { RUN_HEALTH_SPAN_GAP_MS } from "./run-health";

const T0 = Date.parse("2026-09-02T07:44:30.000Z");
const at = (offsetS: number) => new Date(T0 + offsetS * 1000);
const KEYFRAME =
	"At least one input video stream key-frame interval is larger than the threshold: 2167 ms >= 2000 ms!";
const connect = {
	time: "2026-09-02T07:49:49.000Z",
	details: { eventType: "FIRST_CONNECT", message: null },
};
const keyframe = {
	time: "2026-09-02T07:49:51.000Z",
	details: { eventType: "WARNING", message: KEYFRAME },
};

function row(over: {
	offsetS: number;
	status: string;
	events?: unknown[];
	deltas?: Record<string, number>;
	manifestAtOffsetS?: number;
}) {
	return {
		at: at(over.offsetS),
		raw: {
			ingest: {
				status: over.status,
				healthy: over.status === "CONNECTED",
			},
			...(over.manifestAtOffsetS !== undefined
				? {
						output: {
							manifests: {
								hls: [
									{
										manifestUpdates: [
											{
												manifestUpdateWallClockTime: at(
													over.manifestAtOffsetS,
												).toISOString(),
											},
										],
									},
								],
							},
						},
					}
				: {}),
			events: over.events ?? [],
		},
		deltas: over.deltas ?? {},
	};
}

describe("summarizeRunHeartbeats", () => {
	const computedAt = "2026-09-02T09:32:00.000Z";

	it("counts, spans, packet totals and provider events of a measured-shape run", () => {
		const rows = [
			row({ offsetS: 0, status: "WAITING_FOR_FIRST_CONNECT" }),
			row({ offsetS: 30, status: "WAITING_FOR_FIRST_CONNECT" }),
			row({
				offsetS: 60,
				status: "CONNECTED",
				events: [connect, keyframe],
				manifestAtOffsetS: 55,
			}),
			row({
				offsetS: 90,
				status: "CONNECTED",
				// The provider's duplicate entry — one event, not two.
				events: [connect, keyframe, keyframe],
				deltas: { droppedPacketsAudio: 2, corruptPacketsVideo: 1 },
				manifestAtOffsetS: 85,
			}),
			row({
				offsetS: 120,
				status: "CONNECTED",
				events: [connect, keyframe],
				deltas: { droppedPacketsAudio: 3 },
				// Older than the freshness window → this poll's output is stalled.
				manifestAtOffsetS: 0,
			}),
		];
		const summary = summarizeRunHeartbeats(rows, { computedAt });
		expect(summary).toEqual({
			version: RUN_HEARTBEAT_SUMMARY_VERSION,
			computedAt,
			sampleCount: 5,
			firstAt: at(0).toISOString(),
			lastAt: at(120).toISOString(),
			rowsPruned: false,
			ingest: {
				connectedPolls: 3,
				connectedSpans: 1,
				connectedSpanMs: 60_000,
				firstConnectedAt: at(60).toISOString(),
				lastConnectedAt: at(120).toISOString(),
				statusCounts: { WAITING_FOR_FIRST_CONNECT: 2, CONNECTED: 3 },
			},
			// #546: the output lane carries the newest manifest update forward
			// across time-ordered samples, so the fixture's third poll — after
			// the update, before any newer one — is flowing too.
			output: { flowingPolls: 3, flowingSpanMs: 60_000 },
			packets: {
				droppedVideo: 0,
				droppedAudio: 5,
				corruptVideo: 1,
				corruptAudio: 0,
			},
			events: {
				total: 2,
				warning: 1,
				error: 0,
				firstConnect: 1,
				disconnect: 0,
				reconnect: 0,
				lastFault: {
					time: "2026-09-02T07:49:51.000Z",
					eventType: "WARNING",
					message: KEYFRAME,
				},
			},
		});
		// The written value round-trips through the reader's schema.
		expect(runHeartbeatSummarySchema.safeParse(summary).success).toBe(true);
	});

	it("a gap longer than the span rule breaks the connected span, so uptime is not bridged over silence", () => {
		const rows = [
			row({ offsetS: 0, status: "CONNECTED" }),
			row({ offsetS: 30, status: "CONNECTED" }),
			row({
				offsetS: 30 + (RUN_HEALTH_SPAN_GAP_MS + 30_000) / 1000,
				status: "CONNECTED",
			}),
		];
		const summary = summarizeRunHeartbeats(rows, { computedAt });
		expect(summary.ingest.connectedSpans).toBe(2);
		expect(summary.ingest.connectedSpanMs).toBe(30_000);
		expect(summary.ingest.connectedPolls).toBe(3);
	});

	it("events are the UNION across rows, so a provider list that reset after a restart loses nothing", () => {
		const later = {
			time: "2026-09-02T09:00:00.000Z",
			details: { eventType: "FIRST_CONNECT", message: null },
		};
		const errorEntry = {
			time: "2026-09-02T09:00:05.000Z",
			details: { eventType: "ERROR", message: "boom" },
		};
		const rows = [
			row({ offsetS: 0, status: "CONNECTED", events: [connect, keyframe] }),
			row({ offsetS: 30, status: "CONNECTED", events: [later, errorEntry] }),
		];
		const summary = summarizeRunHeartbeats(rows, { computedAt });
		expect(summary.events).toEqual({
			total: 4,
			warning: 1,
			error: 1,
			firstConnect: 2,
			disconnect: 0,
			reconnect: 0,
			lastFault: {
				time: "2026-09-02T09:00:05.000Z",
				eventType: "ERROR",
				message: "boom",
			},
		});
	});

	it("lastFault is the newest by the provider's stamp even when rows arrive NEWEST-FIRST and the list reset (rev405 R3)", () => {
		// The worker reads `orderBy: { at: "desc" }`: the newest row (the new
		// encoder's list, holding the 09:00:05 ERROR) is iterated FIRST and the
		// old encoder's key-frame WARNING lands LAST in the union — a
		// position-based pick reported the WARNING.
		const later = {
			time: "2026-09-02T09:00:00.000Z",
			details: { eventType: "FIRST_CONNECT", message: null },
		};
		const errorEntry = {
			time: "2026-09-02T09:00:05.000Z",
			details: { eventType: "ERROR", message: "boom" },
		};
		const newestFirst = [
			row({ offsetS: 30, status: "CONNECTED", events: [later, errorEntry] }),
			row({ offsetS: 0, status: "CONNECTED", events: [connect, keyframe] }),
		];
		expect(
			summarizeRunHeartbeats(newestFirst, { computedAt }).events.lastFault,
		).toEqual({
			time: "2026-09-02T09:00:05.000Z",
			eventType: "ERROR",
			message: "boom",
		});
		// And the same rows oldest-first agree — order is not the instrument.
		expect(
			summarizeRunHeartbeats([...newestFirst].reverse(), { computedAt }).events
				.lastFault,
		).toEqual({
			time: "2026-09-02T09:00:05.000Z",
			eventType: "ERROR",
			message: "boom",
		});
	});

	it("a fault with no parseable stamp wins only when nothing stamped exists", () => {
		const unstamped = {
			details: { eventType: "WARNING", message: "no stamp" },
		};
		const stamped = {
			time: "2026-09-02T08:00:00.000Z",
			details: { eventType: "WARNING", message: "stamped" },
		};
		expect(
			summarizeRunHeartbeats(
				[
					row({
						offsetS: 0,
						status: "CONNECTED",
						events: [stamped, unstamped],
					}),
				],
				{ computedAt },
			).events.lastFault,
		).toMatchObject({ message: "stamped" });
		expect(
			summarizeRunHeartbeats(
				[row({ offsetS: 0, status: "CONNECTED", events: [unstamped] })],
				{ computedAt },
			).events.lastFault,
		).toMatchObject({ message: "no stamp", time: null });
	});

	it("negative or non-numeric deltas never count, and an unparseable poll time is dropped from the population", () => {
		const rows = [
			row({
				offsetS: 0,
				status: "CONNECTED",
				deltas: { droppedPacketsVideo: -4 },
			}),
			{
				at: "not-a-date",
				raw: { ingest: { status: "CONNECTED" } },
				deltas: { droppedPacketsVideo: "9" },
			},
		];
		const summary = summarizeRunHeartbeats(rows, { computedAt });
		expect(summary.sampleCount).toBe(1);
		expect(summary.packets.droppedVideo).toBe(0);
	});

	it("no rows: every figure is zero/null and rowsPruned carries the caller's verdict", () => {
		const summary = summarizeRunHeartbeats([], {
			computedAt,
			rowsPruned: true,
		});
		expect(summary).toMatchObject({
			sampleCount: 0,
			firstAt: null,
			lastAt: null,
			rowsPruned: true,
			ingest: { connectedPolls: 0, connectedSpanMs: 0, statusCounts: {} },
			events: { total: 0, lastFault: null },
		});
		expect(summarizeRunHeartbeats([], { computedAt }).rowsPruned).toBe(false);
	});
});

describe("parseRunHeartbeatSummary", () => {
	it("returns the summary for a well-formed column and null for legacy/malformed/future values", () => {
		const summary = summarizeRunHeartbeats([], {
			computedAt: "2026-09-02T09:32:00.000Z",
		});
		expect(parseRunHeartbeatSummary(summary)).toEqual(summary);
		expect(parseRunHeartbeatSummary(null)).toBeNull();
		expect(parseRunHeartbeatSummary({ version: 1 })).toBeNull();
		expect(parseRunHeartbeatSummary({ ...summary, version: 2 })).toBeNull();
	});
});
