import { describe, expect, it } from "vitest";
import type { RunHealthPoint } from "./run-health";
import { deriveRunTimeline } from "./run-timeline";

/**
 * The derivation rules of 's absolute-time run timeline —
 * lifecycle from records, transitions from spans, and above all the
 * no-manufactured-disconnect rule: a span that runs to the last poll ends
 * because OBSERVATION ended, and must not claim the input dropped.
 */

const T0 = Date.parse("2026-08-24T00:00:00Z");
const at = (s: number) => T0 + s * 1000;

function pt(s: number, over: Partial<RunHealthPoint> = {}): RunHealthPoint {
	return { atMs: at(s), ingest: true, encoder: true, output: true, ...over };
}

describe("deriveRunTimeline", () => {
	it("full lifecycle: requested→queued→running→connected→output→disconnected→stopped, ascending", () => {
		const timeline = deriveRunTimeline({
			lifecycle: {
				createdAtMs: at(-60),
				requestedAtMs: at(0),
				queuedAtMs: at(2),
				runningAtMs: at(180),
				endedAtMs: at(900),
			},
			lanes: {
				ingest: [{ fromMs: at(210), toMs: at(270) }],
				encoder: [{ fromMs: at(210), toMs: at(300) }],
				output: [{ fromMs: at(240), toMs: at(270) }],
			},
			points: [
				pt(210),
				pt(240),
				pt(270),
				pt(300, { ingest: false, output: false }),
			],
			actions: [{ atMs: at(330), kind: "CONTENT_INSERTED" }],
			spanGapMs: 90_000,
		});
		expect(timeline.window).toEqual({ startMs: at(0), endMs: at(900) });
		expect(timeline.events).toEqual([
			{ kind: "START_REQUESTED", atMs: at(0), source: "steplog" },
			{ kind: "ENCODER_QUEUED", atMs: at(2), source: "steplog" },
			{ kind: "ENCODER_RUNNING", atMs: at(180), source: "run" },
			{ kind: "INPUT_CONNECTED", atMs: at(210), source: "heartbeat" },
			{ kind: "OUTPUT_ACTIVE", atMs: at(240), source: "heartbeat" },
			// The span ends at 270 and the NEXT poll (300, on cadence) said
			// not-connected — an OBSERVED disconnect, so the event is real
			// (review-294 C1: a later poll merely existing is not enough).
			{ kind: "INPUT_DISCONNECTED", atMs: at(270), source: "heartbeat" },
			{ kind: "CONTENT_INSERTED", atMs: at(330), source: "action" },
			{ kind: "ENCODER_STOPPED", atMs: at(900), source: "run" },
		]);
	});

	it("a span reaching the LAST poll claims no disconnect — live or stopped", () => {
		// Still-live run: the open span's end is merely the newest sample.
		const live = deriveRunTimeline({
			lifecycle: { createdAtMs: at(0), runningAtMs: at(60) },
			lanes: {
				ingest: [{ fromMs: at(90), toMs: at(300) }],
				encoder: [{ fromMs: at(90), toMs: at(300) }],
				output: [],
			},
			points: [pt(90, { output: false }), pt(300, { output: false })],
			actions: [],
			spanGapMs: 90_000,
		});
		expect(live.window.endMs).toBeUndefined();
		expect(live.events.map((e) => e.kind)).not.toContain("INPUT_DISCONNECTED");
		// Stopped run whose final span runs to the final poll: the encoder
		// left, taking observation with it — the input's fate is unknown.
		const stopped = deriveRunTimeline({
			lifecycle: {
				createdAtMs: at(0),
				runningAtMs: at(60),
				endedAtMs: at(360),
			},
			lanes: {
				ingest: [{ fromMs: at(90), toMs: at(300) }],
				encoder: [{ fromMs: at(90), toMs: at(300) }],
				output: [],
			},
			points: [pt(90, { output: false }), pt(300, { output: false })],
			actions: [],
			spanGapMs: 90_000,
		});
		expect(stopped.events.map((e) => e.kind)).not.toContain(
			"INPUT_DISCONNECTED",
		);
		expect(stopped.events.at(-1)).toEqual({
			kind: "ENCODER_STOPPED",
			atMs: at(360),
			source: "run",
		});
	});

	it("no step log (backfilled run): axis starts at createdAt WITHOUT a START_REQUESTED claim", () => {
		const timeline = deriveRunTimeline({
			lifecycle: {
				createdAtMs: at(0),
				runningAtMs: at(120),
				endedAtMs: at(600),
			},
			lanes: { ingest: [], encoder: [], output: [] },
			points: [],
			actions: [],
			spanGapMs: 90_000,
		});
		expect(timeline.window.startMs).toBe(at(0));
		expect(timeline.events.map((e) => e.kind)).toEqual([
			"ENCODER_RUNNING",
			"ENCODER_STOPPED",
		]);
	});

	it("an observation GAP never manufactures a disconnect — every poll on record said CONNECTED (review-294 C1)", () => {
		// polls @0/30/60 connected · 3-minute hole (worker restart, poll-failure
		// streak) · polls @240/270/300 connected. spansOf breaks the span at 60
		// because observation LAPSED, not because anyone saw the input gone —
		// the old later-poll-exists rule painted INPUT_DISCONNECTED@60 here.
		const timeline = deriveRunTimeline({
			lifecycle: { createdAtMs: at(0), runningAtMs: at(-30) },
			lanes: {
				ingest: [
					{ fromMs: at(0), toMs: at(60) },
					{ fromMs: at(240), toMs: at(300) },
				],
				encoder: [
					{ fromMs: at(0), toMs: at(60) },
					{ fromMs: at(240), toMs: at(300) },
				],
				output: [],
			},
			points: [0, 30, 60, 240, 270, 300].map((s) => pt(s, { output: false })),
			actions: [],
			spanGapMs: 90_000,
		});
		const kinds = timeline.events.map((e) => e.kind);
		expect(kinds).not.toContain("INPUT_DISCONNECTED");
		// Both reconnects still register.
		expect(kinds.filter((k) => k === "INPUT_CONNECTED")).toHaveLength(2);
	});

	it("flapping input: every reconnect is an event, every observed drop too", () => {
		const timeline = deriveRunTimeline({
			lifecycle: { createdAtMs: at(0), runningAtMs: at(30) },
			lanes: {
				ingest: [
					{ fromMs: at(60), toMs: at(120) },
					{ fromMs: at(240), toMs: at(300) },
				],
				encoder: [{ fromMs: at(60), toMs: at(300) }],
				output: [],
			},
			points: [
				pt(60, { output: false }),
				pt(120, { output: false }),
				pt(180, { ingest: false, output: false }),
				pt(240, { output: false }),
				pt(300, { output: false }),
			],
			actions: [],
			spanGapMs: 90_000,
		});
		const kinds = timeline.events.map(
			(e) => `${e.kind}@${(e.atMs - T0) / 1000}`,
		);
		expect(kinds).toEqual([
			"ENCODER_RUNNING@30",
			"INPUT_CONNECTED@60",
			// First span's end at 120 has later polls — observed drop.
			"INPUT_DISCONNECTED@120",
			"INPUT_CONNECTED@240",
			// Second span reaches the last poll — no manufactured drop.
		]);
	});

	it("ties sort lifecycle before transitions at the same instant", () => {
		const timeline = deriveRunTimeline({
			lifecycle: { createdAtMs: at(0), runningAtMs: at(60), endedAtMs: at(60) },
			lanes: {
				ingest: [{ fromMs: at(60), toMs: at(60) }],
				encoder: [{ fromMs: at(60), toMs: at(60) }],
				output: [],
			},
			points: [pt(60, { output: false })],
			actions: [{ atMs: at(60), kind: "CONTENT_STOPPED" }],
			spanGapMs: 90_000,
		});
		expect(timeline.events.map((e) => e.kind)).toEqual([
			"ENCODER_RUNNING",
			"INPUT_CONNECTED",
			"CONTENT_STOPPED",
			"ENCODER_STOPPED",
		]);
	});
});
