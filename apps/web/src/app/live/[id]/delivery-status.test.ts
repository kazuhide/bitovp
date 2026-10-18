import { ALERT_METRICS, type RunHealthPoint } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	ALERT_LANE,
	DELIVERY_LANES,
	laneLamps,
	lastSeen,
	latestWarning,
	openAlertsByLane,
	originReadLimitReached,
	summarizeOrigin,
	videoStream,
} from "./delivery-status";
import { parseHeartbeat } from "./heartbeat";

const AT = "2026-09-07T00:00:00.000Z";
const NOW = Date.parse(AT);
it.each([
	null,
	undefined,
	[],
	"PLAYLIST_TRUNCATED_AT_256KIB",
	{},
	{ playlistReadLimitReached: "true" },
	{ unavailableReason: {} },
	{ unavailableReason: "read failed" },
])("does not invent a read-limit reason from malformed or unrelated state: %j", (value) => {
	expect(originReadLimitReached(value)).toBe(false);
});
it("recognizes the explicit read-limit flag even when the bounded reason list omits it", () => {
	expect(
		originReadLimitReached({
			playlistReadLimitReached: true,
			unavailableReason: "failure 1; failure 2; failure 3; +1 more",
		}),
	).toBe(true);
});
const POINT: RunHealthPoint = {
	atMs: NOW,
	ingest: true,
	encoder: true,
	output: false,
};
const ADVANCING = { stale: false, endlist: false, edgeDelaySeconds: null };

describe("delivery lane alerts", () => {
	it("assigns every current metric to the operator's affected card", () => {
		const expected = {
			ingest: [
				"INPUT_DISCONNECTED",
				"BITRATE_BELOW",
				"FPS_BELOW",
				"PROGRAM_START_NO_INGEST",
			],
			encoder: ["HEARTBEAT_STALE", "PROVIDER_WARNING"],
			output: [
				"ORIGIN_MANIFEST_STALE",
				"ORIGIN_ENDLIST_PRESENT",
				"ORIGIN_EDGE_DELAY_ABOVE",
			],
		};
		expect(DELIVERY_LANES).toEqual(["ingest", "encoder", "output"]);
		expect(Object.values(expected).flat().sort()).toEqual(
			[...ALERT_METRICS].sort(),
		);
		for (const metric of ALERT_METRICS) {
			expect(expected[ALERT_LANE[metric]]).toContain(metric);
		}
	});

	it("counts events per lane, including multiple rules for the same metric", () => {
		expect(
			openAlertsByLane(
				[...ALERT_METRICS, "PROVIDER_WARNING"].map((metric) => ({
					rule: { metric },
				})),
			),
		).toEqual({ ingest: 4, encoder: 3, output: 3 });
	});

	it("ignores unknown metrics, including names inherited from Object.prototype", () => {
		const events = ["FUTURE_METRIC", "toString", "constructor", "__proto__"];
		expect(
			openAlertsByLane(events.map((metric) => ({ rule: { metric } }))),
		).toEqual({ ingest: 0, encoder: 0, output: 0 });
		expect(openAlertsByLane([])).toEqual({ ingest: 0, encoder: 0, output: 0 });
	});
});

describe("delivery lane lamps", () => {
	it("uses each health lane's boolean independently", () => {
		expect(
			laneLamps({ mode: "live", latest: POINT, outputObservable: true }),
		).toEqual({ ingest: "on", encoder: "on", output: "off" });
		expect(
			laneLamps({
				mode: "live",
				latest: { ...POINT, ingest: false, encoder: false, output: true },
				outputObservable: true,
			}),
		).toEqual({ ingest: "off", encoder: "off", output: "on" });
	});

	it.each([
		true,
		false,
	])("keeps unobserved live lanes unknown (HLS: %s)", (observable) => {
		expect(
			laneLamps({
				mode: "live",
				latest: undefined,
				outputObservable: observable,
			}),
		).toEqual({
			ingest: "unknown",
			encoder: "unknown",
			output: observable ? "unknown" : "unobservable",
		});
	});

	it.each([
		true,
		false,
	])("never interprets DASH-only output as a boolean (%s)", (output) => {
		expect(
			laneLamps({
				mode: "live",
				latest: { ...POINT, output },
				outputObservable: false,
			}),
		).toEqual({ ingest: "on", encoder: "on", output: "unobservable" });
	});

	it.each([
		POINT,
		undefined,
	])("marks a finished run ended regardless of its final sample", (latest) => {
		expect(
			laneLamps({ mode: "finished", latest, outputObservable: false }),
		).toEqual({
			ingest: "ended",
			encoder: "ended",
			output: "ended",
		});
	});
});

describe("last seen", () => {
	it.each([null, "", "invalid"])("reports no observation for %s", (at) => {
		expect(lastSeen(at, NOW, true)).toEqual({ kind: "never" });
		expect(lastSeen(at, NOW, false)).toEqual({ kind: "never" });
	});

	it("rounds live elapsed seconds, including exactly now", () => {
		expect(lastSeen(AT, NOW, true)).toEqual({ kind: "ago", seconds: 0 });
		expect(lastSeen(AT, NOW + 1499, true)).toEqual({ kind: "ago", seconds: 1 });
		expect(lastSeen(AT, NOW + 1500, true)).toEqual({ kind: "ago", seconds: 2 });
	});

	it.each([
		1, 499, 500, 1000,
	])("reports a future stamp as skew before rounding (%s ms)", (delta) => {
		expect(lastSeen(AT, NOW - delta, true)).toEqual({ kind: "skew" });
	});

	it("keeps finished observations at their absolute time even with clock skew", () => {
		expect(lastSeen(AT, NOW + 86_400_000, false)).toEqual({
			kind: "at",
			at: AT,
		});
		expect(lastSeen(AT, NOW - 1000, false)).toEqual({ kind: "at", at: AT });
	});
});

describe("origin summary", () => {
	it.each([
		null,
		undefined,
		"bad",
		1,
		[],
		{},
	])("does not claim observation for %j", (value) => {
		expect(summarizeOrigin(value)).toEqual({
			state: "none",
			lastFetchAtMs: null,
			playlists: 0,
			stale: 0,
			maxEdgeDelaySeconds: null,
		});
	});

	it("keeps a timestamp without verdicts unobserved", () => {
		expect(summarizeOrigin({ lastFetchAtMs: NOW })).toEqual({
			state: "none",
			lastFetchAtMs: NOW,
			playlists: 0,
			stale: 0,
			maxEdgeDelaySeconds: null,
		});
	});

	it("lets unavailable override retained successful verdicts", () => {
		expect(
			summarizeOrigin({
				lastFetchAtMs: NOW,
				unavailableReason: "read failed",
				lastVerdicts: { video: { ...ADVANCING, edgeDelaySeconds: 4 } },
			}),
		).toEqual({
			state: "unavailable",
			lastFetchAtMs: NOW,
			playlists: 1,
			stale: 0,
			maxEdgeDelaySeconds: 4,
		});
		expect(summarizeOrigin({ unavailableReason: "no playlists" }).state).toBe(
			"unavailable",
		);
	});

	it("counts stalled and ended playlists once each and takes the largest finite edge delay", () => {
		expect(
			summarizeOrigin({
				lastFetchAtMs: NOW,
				lastVerdicts: {
					video: { stale: true, endlist: true, edgeDelaySeconds: 12 },
					audio: { ...ADVANCING, endlist: true, edgeDelaySeconds: 8 },
					alternate: {
						...ADVANCING,
						edgeDelaySeconds: Number.POSITIVE_INFINITY,
					},
				},
			}),
		).toEqual({
			state: "stale",
			lastFetchAtMs: NOW,
			playlists: 3,
			stale: 2,
			maxEdgeDelaySeconds: 12,
		});
	});

	it("reports advancing only with a fetch timestamp and explicit non-stale verdicts", () => {
		expect(
			summarizeOrigin({ lastFetchAtMs: 0, lastVerdicts: { video: ADVANCING } }),
		).toEqual({
			state: "advancing",
			lastFetchAtMs: 0,
			playlists: 1,
			stale: 0,
			maxEdgeDelaySeconds: null,
		});
		expect(summarizeOrigin({ lastVerdicts: { video: ADVANCING } }).state).toBe(
			"none",
		);
	});

	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_VALUE,
		"123",
	])("rejects invalid fetch times %s", (lastFetchAtMs) => {
		expect(
			summarizeOrigin({ lastFetchAtMs, lastVerdicts: { video: ADVANCING } }),
		).toMatchObject({
			state: "none",
			lastFetchAtMs: null,
		});
	});

	it.each([
		null,
		"bad",
		1,
		[],
		{ broken: null },
		{ broken: {} },
		{ broken: { stale: "false", endlist: false } },
	])("ignores malformed verdict containers or entries: %j", (lastVerdicts) => {
		expect(summarizeOrigin({ lastFetchAtMs: NOW, lastVerdicts })).toEqual({
			state: "none",
			lastFetchAtMs: NOW,
			playlists: 0,
			stale: 0,
			maxEdgeDelaySeconds: null,
		});
	});

	it("retains valid rows beside malformed ones and ignores non-string unavailability", () => {
		expect(
			summarizeOrigin({
				lastFetchAtMs: NOW,
				unavailableReason: {},
				lastVerdicts: { broken: null, video: ADVANCING },
			}),
		).toEqual({
			state: "advancing",
			lastFetchAtMs: NOW,
			playlists: 1,
			stale: 0,
			maxEdgeDelaySeconds: null,
		});
	});
});

describe("heartbeat card selections", () => {
	it("selects the first video row after audio, with the first stream as fallback", () => {
		const view = parseHeartbeat({
			raw: {
				ingest: {
					streams: [
						{ streamId: "audio", mediaType: "AUDIO" },
						{ streamId: "video", mediaType: "Video" },
						{ streamId: "video2", mediaType: "VIDEO" },
					],
				},
			},
		});
		expect(videoStream(view)?.id).toBe("video");
		expect(
			videoStream(
				parseHeartbeat({
					raw: { ingest: { streams: [{ streamId: "audio" }] } },
				}),
			)?.id,
		).toBe("audio");
		expect(videoStream(parseHeartbeat({ raw: {} }))).toBeNull();
		expect(videoStream(null)).toBeNull();
	});

	it("chooses the newest fault by timestamp even when the provider lists newest first", () => {
		const view = parseHeartbeat({
			raw: {
				events: [
					{ time: "2026-09-07T00:02:00Z", details: { eventType: "RECONNECT" } },
					{
						time: "2026-09-07T00:01:00Z",
						details: { eventType: "WARNING", message: "new warning" },
					},
					{ time: AT, details: { eventType: "ERROR", message: "old error" } },
				],
			},
		});
		expect(latestWarning(view)?.text).toBe("new warning");
	});

	it("selects errors too and falls back to the last fault if no timestamp is parseable", () => {
		const view = parseHeartbeat({
			raw: {
				events: [
					{ eventType: "WARNING", message: "old warning" },
					{ eventType: "ERROR", message: "latest error" },
					{ eventType: "RECONNECT" },
				],
			},
		});
		expect(latestWarning(view)?.text).toBe("latest error");
		expect(
			latestWarning(
				parseHeartbeat({ raw: { events: [{ eventType: "FIRST_CONNECT" }] } }),
			),
		).toBeNull();
		expect(latestWarning(parseHeartbeat({ raw: {} }))).toBeNull();
		expect(latestWarning(null)).toBeNull();
	});

	it("prefers dated faults to malformed timestamps and keeps the later row for equal times", () => {
		const events = [
			{ time: "invalid", eventType: "WARNING", message: "undated before" },
			{ time: AT, eventType: "WARNING", message: "same instant before" },
			{ time: AT, eventType: "ERROR", message: "dated error" },
			{ time: "invalid", eventType: "ERROR", message: "undated after" },
		];
		expect(latestWarning(parseHeartbeat({ raw: { events } }))?.text).toBe(
			"dated error",
		);
	});
});
