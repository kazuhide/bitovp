import { describe, expect, it } from "vitest";
import {
	describeHeartbeatStateChange,
	heartbeatStateChanges,
	isProviderFault,
	newProviderEvents,
	outputStateOf,
	providerHeartbeatEvents,
} from "./heartbeat-events";
import { RUN_HEALTH_OUTPUT_FRESH_MS } from "./run-health";

/**
 * The shapes here are the PERSISTED ones — read off LiveHeartbeat rows on
 * 2026-09-02 (run 185123f7…, 214 samples), not modelled from the SDK docs:
 * `events[]` is cumulative, entries can be byte-identical duplicates, the
 * connect family carries `message: null`.
 */

const KEYFRAME =
	"At least one input video stream key-frame interval is larger than the threshold: 2167 ms >= 2000 ms! Output video stream may have playback issues.";
const connect = {
	time: "2026-09-02T07:49:49.000Z",
	details: { eventType: "FIRST_CONNECT", message: null },
};
const keyframe = {
	time: "2026-09-02T07:49:51.000Z",
	details: { eventType: "WARNING", message: KEYFRAME },
};

describe("providerHeartbeatEvents", () => {
	it("parses the wire shape and dedupes the provider's identical duplicate entries", () => {
		const avsync = {
			time: "2026-08-30T11:15:50.000Z",
			details: {
				eventType: "WARNING",
				message:
					"AV-Sync issue detected on audio stream 1, desync: -0.281000 seconds.",
			},
		};
		const events = providerHeartbeatEvents({
			events: [connect, avsync, avsync, keyframe],
		});
		expect(events.map((event) => event.eventType)).toEqual([
			"FIRST_CONNECT",
			"WARNING",
			"WARNING",
		]);
		expect(events[0]).toEqual({
			time: "2026-09-02T07:49:49.000Z",
			eventType: "FIRST_CONNECT",
			message: null,
			key: "2026-09-02T07:49:49.000Z|FIRST_CONNECT|",
		});
		expect(events[2]?.message).toBe(KEYFRAME);
	});

	it("keeps a non-object entry as an UNKNOWN event rather than dropping it", () => {
		const events = providerHeartbeatEvents({ events: ["odd", 7] });
		expect(events).toEqual([
			{ time: null, eventType: "UNKNOWN", message: '"odd"', key: '"odd"' },
			{ time: null, eventType: "UNKNOWN", message: "7", key: "7" },
		]);
	});

	it("answers an empty list for no block, a non-array, or a non-object sample", () => {
		expect(providerHeartbeatEvents({})).toEqual([]);
		expect(providerHeartbeatEvents({ events: "none" })).toEqual([]);
		expect(providerHeartbeatEvents(null)).toEqual([]);
		expect(providerHeartbeatEvents(undefined)).toEqual([]);
	});

	it("an unparseable time is null but the entry is kept, and an unknown type word is kept verbatim", () => {
		const [event] = providerHeartbeatEvents({
			events: [{ time: "yesterday", details: { eventType: "NEW_KIND" } }],
		});
		expect(event).toEqual({
			time: null,
			eventType: "NEW_KIND",
			message: null,
			key: "|NEW_KIND|",
		});
	});

	it("isProviderFault: WARNING and ERROR only", () => {
		expect(isProviderFault({ eventType: "WARNING" })).toBe(true);
		expect(isProviderFault({ eventType: "ERROR" })).toBe(true);
		expect(isProviderFault({ eventType: "DISCONNECT" })).toBe(false);
		expect(isProviderFault({ eventType: "UNKNOWN" })).toBe(false);
	});
});

describe("newProviderEvents — a cumulative list read as a difference", () => {
	it("returns only the entries the previous sample did not carry", () => {
		const fresh = newProviderEvents(
			{ events: [connect] },
			{ events: [connect, keyframe] },
		);
		expect(fresh.map((event) => event.key)).toEqual([
			`2026-09-02T07:49:51.000Z|WARNING|${KEYFRAME}`,
		]);
	});

	it("the same list on the next poll yields nothing new", () => {
		expect(
			newProviderEvents(
				{ events: [connect, keyframe] },
				{ events: [connect, keyframe] },
			),
		).toEqual([]);
	});

	it("no previous sample means every entry is new (the run's first sample)", () => {
		expect(
			newProviderEvents(undefined, { events: [connect, keyframe] }),
		).toHaveLength(2);
		expect(newProviderEvents(null, { events: [connect] })).toHaveLength(1);
	});

	it("a provider list that RESET (new encoder after a restart) reports the new encoder's entries as new", () => {
		const later = {
			time: "2026-09-02T09:00:00.000Z",
			details: { eventType: "FIRST_CONNECT", message: null },
		};
		expect(
			newProviderEvents({ events: [connect, keyframe] }, { events: [later] }),
		).toEqual([
			{
				time: "2026-09-02T09:00:00.000Z",
				eventType: "FIRST_CONNECT",
				message: null,
				key: "2026-09-02T09:00:00.000Z|FIRST_CONNECT|",
			},
		]);
	});
});

describe("outputStateOf — the run-health output lane, three-way", () => {
	const at = "2026-09-02T09:31:01.000Z";
	const withUpdate = (wallClock: string) => ({
		at,
		raw: {
			output: {
				manifests: {
					hls: [
						{ manifestUpdates: [{ manifestUpdateWallClockTime: wallClock }] },
					],
				},
			},
		},
	});

	it("FLOWING when the newest manifest update is within the freshness window", () => {
		expect(outputStateOf(withUpdate("2026-09-02T09:30:29.938Z"))).toBe(
			"FLOWING",
		);
	});

	it("STALLED once the newest update is older than the window", () => {
		const stale = new Date(
			Date.parse(at) - RUN_HEALTH_OUTPUT_FRESH_MS - 1,
		).toISOString();
		expect(outputStateOf(withUpdate(stale))).toBe("STALLED");
	});

	it("UNOBSERVABLE with no manifest update at all (DASH-only, or nothing produced yet) and for an unparseable poll time", () => {
		expect(outputStateOf({ at, raw: { ingest: {} } })).toBe("UNOBSERVABLE");
		expect(outputStateOf({ at, raw: null })).toBe("UNOBSERVABLE");
		expect(outputStateOf({ at: "n/a", raw: withUpdate(at).raw })).toBe(
			"UNOBSERVABLE",
		);
	});
});

describe("heartbeatStateChanges — one entry per CHANGE, none per poll", () => {
	const at = (s: number) =>
		new Date(Date.UTC(2026, 8, 2, 7, 49, s)).toISOString();
	const waiting = (s: number) => ({
		at: at(s),
		raw: { ingest: { status: "WAITING_FOR_FIRST_CONNECT" }, events: [] },
	});
	const flowingRaw = (pollAt: string, events: unknown[]) => ({
		ingest: { status: "CONNECTED", healthy: true },
		output: {
			manifests: {
				hls: [{ manifestUpdates: [{ manifestUpdateWallClockTime: pollAt }] }],
			},
		},
		events,
	});

	it("the run's first sample reports its initial ingest word and its events, nothing about output", () => {
		expect(heartbeatStateChanges(null, waiting(0))).toEqual([
			{ kind: "INGEST_STATUS", from: null, to: "WAITING_FOR_FIRST_CONNECT" },
		]);
	});

	it("an identical consecutive sample reports NOTHING", () => {
		expect(heartbeatStateChanges(waiting(0), waiting(30))).toEqual([]);
		const same = { at: at(60), raw: flowingRaw(at(60), [connect, keyframe]) };
		const next = { at: at(90), raw: flowingRaw(at(90), [connect, keyframe]) };
		expect(heartbeatStateChanges(same, next)).toEqual([]);
	});

	it("the connect poll reports the status transition, each new event once, and output flowing", () => {
		const current = {
			at: at(60),
			raw: flowingRaw(at(60), [connect, keyframe]),
		};
		const changes = heartbeatStateChanges(waiting(30), current);
		expect(changes).toEqual([
			{
				kind: "INGEST_STATUS",
				from: "WAITING_FOR_FIRST_CONNECT",
				to: "CONNECTED",
			},
			{
				kind: "PROVIDER_EVENT",
				event: expect.objectContaining({ eventType: "FIRST_CONNECT" }),
			},
			{
				kind: "PROVIDER_EVENT",
				event: expect.objectContaining({
					eventType: "WARNING",
					message: KEYFRAME,
				}),
			},
			// The waiting sample carried no delivery block: UNOBSERVABLE → FLOWING
			// is the "output started" line.
			{ kind: "OUTPUT", from: "UNOBSERVABLE", to: "FLOWING" },
		]);
	});

	it("output stalled → unstalled are two transitions; an initial STALLED and UNOBSERVABLE are none", () => {
		const flowing = { at: at(60), raw: flowingRaw(at(60), [connect]) };
		const stalled = { at: at(300), raw: flowingRaw(at(60), [connect]) };
		const back = { at: at(330), raw: flowingRaw(at(330), [connect]) };
		expect(heartbeatStateChanges(flowing, stalled)).toEqual([
			{ kind: "OUTPUT", from: "FLOWING", to: "STALLED" },
		]);
		expect(heartbeatStateChanges(stalled, back)).toEqual([
			{ kind: "OUTPUT", from: "STALLED", to: "FLOWING" },
		]);
		// First sample of a run whose manifest update is already old: not a stop.
		expect(heartbeatStateChanges(null, stalled)).toEqual([
			{ kind: "INGEST_STATUS", from: null, to: "CONNECTED" },
			{
				kind: "PROVIDER_EVENT",
				event: expect.objectContaining({ eventType: "FIRST_CONNECT" }),
			},
		]);
		// DASH-only: never an output line.
		const dashOnly = (s: number) => ({
			at: at(s),
			raw: { ingest: { status: "CONNECTED" }, events: [connect] },
		});
		expect(heartbeatStateChanges(dashOnly(60), dashOnly(90))).toEqual([]);
	});

	it("describeHeartbeatStateChange renders grep-able lines with the provider's words verbatim", () => {
		expect(
			describeHeartbeatStateChange({
				kind: "INGEST_STATUS",
				from: "WAITING_FOR_FIRST_CONNECT",
				to: "CONNECTED",
			}),
		).toBe("ingest WAITING_FOR_FIRST_CONNECT → CONNECTED");
		expect(
			describeHeartbeatStateChange({
				kind: "INGEST_STATUS",
				from: null,
				to: "CONNECTED",
			}),
		).toBe("ingest (none) → CONNECTED");
		const [warning] = providerHeartbeatEvents({ events: [keyframe] });
		const [first] = providerHeartbeatEvents({ events: [connect] });
		expect(
			describeHeartbeatStateChange({
				kind: "PROVIDER_EVENT",
				event: warning as never,
			}),
		).toBe(`event WARNING @2026-09-02T07:49:51.000Z: ${KEYFRAME}`);
		expect(
			describeHeartbeatStateChange({
				kind: "PROVIDER_EVENT",
				event: first as never,
			}),
		).toBe("event FIRST_CONNECT @2026-09-02T07:49:49.000Z");
		expect(
			describeHeartbeatStateChange({
				kind: "OUTPUT",
				from: "FLOWING",
				to: "STALLED",
			}),
		).toBe("output stalled");
		expect(
			describeHeartbeatStateChange({
				kind: "OUTPUT",
				from: "STALLED",
				to: "FLOWING",
			}),
		).toBe("output unstalled");
		expect(
			describeHeartbeatStateChange({
				kind: "OUTPUT",
				from: null,
				to: "FLOWING",
			}),
		).toBe("output flowing");
	});
});
