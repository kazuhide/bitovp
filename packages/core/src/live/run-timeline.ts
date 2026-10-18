import type { RunHealthLanes, RunHealthPoint } from "./run-health";

/**
 * Run timeline derivation (2026-08-24, owner redesign of the run-health
 * graph): one absolute-time axis from the start request to the observed
 * stop, carrying the discrete events the owner enumerated — queued, running,
 * input connected/disconnected, output active, inserted content, stopped.
 *
 * Every event is derived from a RECORD, never inferred :
 *
 *   START_REQUESTED    step log START_LIVE_ENCODING.startedAt — when WE
 *                      called start. Absent for runs whose step log lacks
 *                      the step (backfilled run #1): the axis then starts at
 *                      the run row's createdAt WITHOUT claiming the event.
 *   ENCODER_QUEUED     the same step's finishedAt — Bitmovin accepted the
 *                      start and the encoder entered the queue.
 *   ENCODER_RUNNING    LiveChannelRun.runningSince (the AWAIT_LIVE_RUNNING
 *                      observation, mirrored to the row).
 *   INPUT_CONNECTED    each ingest span's start (deriveRunHealth's spans —
 *                      30s poll resolution, stated in the UI).
 *   INPUT_DISCONNECTED an ingest span's end, ONLY when the NEXT poll landed
 *                      on cadence (within the span-gap bound) — by spansOf's
 *                      own construction that poll observed the input gone.
 *                      Two ends that must NOT claim a disconnect: a span
 *                      reaching the very last poll (observation ended —
 *                      encoder stopped, or the run is still live), and a
 *                      span broken by an observation GAP (worker restart,
 *                      poll-failure streak: every poll on record said
 *                      CONNECTED, review-294 C1 — the same reason
 *                      HEARTBEAT_STALE is an alert, not a disconnect).
 *   OUTPUT_ACTIVE      each output span's start (first fresh manifest
 *                      update after silence).
 *   CONTENT_INSERTED / CONTENT_STOPPED
 *                      operator/scheduler actions THROUGH US: the
 *                      insertable-content schedule/stop calls and scheduler
 *                      SLATE_IN rows that actually fired. Actions taken
 *                      outside this app are invisible and not claimed.
 *   SCTE35_CUE / ESAM_SIGNAL
 *                      the step log's runtime records (the worker appends
 *                      SCTE35_CUE / ESAM_MEDIA_POINT entries as they fire).
 *   STOP_REQUESTED / RESTART_REQUESTED
 *                      the stop/restart calls' audit rows (POST …/live/stop
 *                      and …/live/restart). The worker's own Bitmovin calls
 *                      are audited into the SAME table — so scheduler-fired
 *                      and maxRunMinutes-cap stops get their dot too, at
 *                      the true execution time (an earlier revision claimed
 *                      the worker path "never crosses the web audit" —
 *                      wrong, corrected 2026-08-24). STOP_REQUESTED is the
 *                      event that explains the gap between the last
 *                      heartbeat sample and ENCODER_STOPPED (owner question
 *                      2026-08-24: a 41s gap read as "stopping took 44s"
 *                      when ~23s of it was normal broadcasting between the
 *                      final 30s sample and the stop request).
 *   ENCODER_STOPPED    LiveChannelRun.endedAt (the mirror's leaving-RUNNING
 *                      observation).
 *
 * Pure and UI-free, like deriveRunHealth beside it: the API route feeds
 * persisted facts in; the chart renders the window, the three step lines
 * and the event marks on one axis.
 */

export type RunTimelineEventKind =
	| "START_REQUESTED"
	| "ENCODER_QUEUED"
	| "ENCODER_RUNNING"
	| "INPUT_CONNECTED"
	| "INPUT_DISCONNECTED"
	| "OUTPUT_ACTIVE"
	| "CONTENT_INSERTED"
	| "CONTENT_STOPPED"
	| "SCTE35_CUE"
	| "ESAM_SIGNAL"
	| "STOP_REQUESTED"
	| "RESTART_REQUESTED"
	| "TIMESHIFT_RESET"
	| "ENCODER_STOPPED";

export type RunTimelineEvent = {
	kind: RunTimelineEventKind;
	atMs: number;
	/** Which record produced it — the honesty trail, surfaced in tooltips. */
	source: "steplog" | "run" | "heartbeat" | "action";
};

export type RunTimelineWindow = {
	/** Axis origin: start request when recorded, else the run row's createdAt. */
	startMs: number;
	/** Observed stop; undefined while the run is still live (axis end = now). */
	endMs?: number;
};

export type RunTimeline = {
	window: RunTimelineWindow;
	/** Ascending by atMs; lifecycle events sort before transitions on a tie. */
	events: RunTimelineEvent[];
};

/** Lifecycle facts the route reads off the run row + step log. */
export type RunTimelineLifecycle = {
	/** Run row createdAt — always present, the axis fallback. */
	createdAtMs: number;
	/** START_LIVE_ENCODING.startedAt, when the step log carries it. */
	requestedAtMs?: number;
	/** START_LIVE_ENCODING.finishedAt — queue entry. */
	queuedAtMs?: number;
	/** LiveChannelRun.runningSince. */
	runningAtMs?: number;
	/** LiveChannelRun.endedAt. */
	endedAtMs?: number;
};

export type RunTimelineAction = {
	atMs: number;
	kind:
		| "CONTENT_INSERTED"
		| "CONTENT_STOPPED"
		| "SCTE35_CUE"
		| "ESAM_SIGNAL"
		| "STOP_REQUESTED"
		| "RESTART_REQUESTED"
		| "TIMESHIFT_RESET";
};

const TIE_ORDER: Record<RunTimelineEventKind, number> = {
	START_REQUESTED: 0,
	ENCODER_QUEUED: 1,
	ENCODER_RUNNING: 2,
	INPUT_CONNECTED: 3,
	OUTPUT_ACTIVE: 4,
	CONTENT_INSERTED: 5,
	CONTENT_STOPPED: 6,
	SCTE35_CUE: 7,
	ESAM_SIGNAL: 8,
	TIMESHIFT_RESET: 9,
	RESTART_REQUESTED: 10,
	INPUT_DISCONNECTED: 11,
	STOP_REQUESTED: 12,
	ENCODER_STOPPED: 13,
};

export function deriveRunTimeline(input: {
	lifecycle: RunTimelineLifecycle;
	lanes: RunHealthLanes;
	points: RunHealthPoint[];
	actions: RunTimelineAction[];
	/**
	 * MUST equal the gap the lanes were derived with (deriveRunHealth) —
	 * REQUIRED, not defaulted, because a caller who tunes one and omits the
	 * other gets spans and disconnect-events that silently disagree: the
	 * drift-by-omission shape review-292 made deriveRunHealth's nowMs
	 * required to prevent (review-294 note, adopted).
	 */
	spanGapMs: number;
}): RunTimeline {
	const { lifecycle, lanes, points, actions } = input;
	const gapMs = input.spanGapMs;
	const startMs = lifecycle.requestedAtMs ?? lifecycle.createdAtMs;
	const window: RunTimelineWindow = {
		startMs,
		...(lifecycle.endedAtMs !== undefined
			? { endMs: lifecycle.endedAtMs }
			: {}),
	};
	const events: RunTimelineEvent[] = [];
	if (lifecycle.requestedAtMs !== undefined) {
		events.push({
			kind: "START_REQUESTED",
			atMs: lifecycle.requestedAtMs,
			source: "steplog",
		});
	}
	if (lifecycle.queuedAtMs !== undefined) {
		events.push({
			kind: "ENCODER_QUEUED",
			atMs: lifecycle.queuedAtMs,
			source: "steplog",
		});
	}
	if (lifecycle.runningAtMs !== undefined) {
		events.push({
			kind: "ENCODER_RUNNING",
			atMs: lifecycle.runningAtMs,
			source: "run",
		});
	}
	for (const span of lanes.ingest) {
		events.push({
			kind: "INPUT_CONNECTED",
			atMs: span.fromMs,
			source: "heartbeat",
		});
		// The no-manufactured-disconnect rule (header, tightened by
		// review-294 C1): the next poll must have landed ON CADENCE. If it
		// did, spansOf guarantees it observed not-connected (a connected
		// poll within gapMs would have extended the span); if it came later,
		// the span broke because OBSERVATION lapsed — every poll on record
		// said CONNECTED, and drawing a disconnect would convert the #95
		// predicate's "no explicit signal" into a positive event.
		const next = points.find((p) => p.atMs > span.toMs);
		if (next && next.atMs - span.toMs <= gapMs) {
			events.push({
				kind: "INPUT_DISCONNECTED",
				atMs: span.toMs,
				source: "heartbeat",
			});
		}
	}
	for (const span of lanes.output) {
		events.push({
			kind: "OUTPUT_ACTIVE",
			atMs: span.fromMs,
			source: "heartbeat",
		});
	}
	for (const action of actions) {
		events.push({ kind: action.kind, atMs: action.atMs, source: "action" });
	}
	if (lifecycle.endedAtMs !== undefined) {
		events.push({
			kind: "ENCODER_STOPPED",
			atMs: lifecycle.endedAtMs,
			source: "run",
		});
	}
	events.sort(
		(a, b) => a.atMs - b.atMs || TIE_ORDER[a.kind] - TIE_ORDER[b.kind],
	);
	return { window, events };
}
