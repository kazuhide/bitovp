import { z } from "zod";
import {
	isProviderFault,
	newProviderEvents,
	type ProviderHeartbeatEvent,
} from "./heartbeat-events";

/**
 * Live alert evaluation  — pure.
 * Called by the heartbeat sweep right after it appends the poll row (data
 * writer evaluates — no ordering races). State lives in AlertEvent rows,
 * so edges are computed against the caller-supplied set of OPEN rule ids:
 * a worker restart re-notifies nothing.
 *
 * Metrics: the design lists PACKET_DELTA_ZERO; it is RESERVED here, not
 * implemented — the heartbeat sample carries dropped/corrupt counters
 * only (no received-packet counter), so "packets stopped flowing" cannot
 * be computed honestly from the data we collect. Accepting the rule and
 * never firing it would be worse than refusing it (a named slot nobody
 * fills). The zod metric enum therefore EXCLUDES it.
 */

export const ALERT_METRICS = [
	"INPUT_DISCONNECTED",
	"HEARTBEAT_STALE",
	"BITRATE_BELOW",
	"FPS_BELOW",
	// : the ingest never arrived by AIR TIME. INPUT_DISCONNECTED
	// answers "is the feed unhealthy right now"; this one answers the
	// operator's sharper question on a scheduled channel — "the program was
	// supposed to start and there is still no feed". Breaches only inside the
	// channel's program window (programStartAt..programEndAt), resolves the
	// moment the feed arrives.
	"PROGRAM_START_NO_INGEST",
	// : the origin observer's own measurements (BITOVP×DELIVERY)
	// — an independent second opinion read from the origin's MEDIA playlists,
	// standing even when the encoder's self-report disagrees.
	"ORIGIN_MANIFEST_STALE",
	"ORIGIN_ENDLIST_PRESENT",
	"ORIGIN_EDGE_DELAY_ABOVE",
	// The provider's OWN fault report: a WARNING or ERROR entry that appeared
	// in the heartbeat's cumulative `events[]` since the previous poll (the
	// key-frame-interval WARNING that surfaced as an alert nowhere, 2026-09-02).
	// Opens on the poll that first carries the new entry; `windowPolls` is the
	// SILENCE it takes to resolve — that many consecutive polls with no new
	// WARNING/ERROR — because a cumulative list never "stops carrying" one.
	"PROVIDER_WARNING",
] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

/**
 *  §2 — the provenance contract. A BITMOVIN signal is Bitmovin's
 * self-report relayed by bitovp; a BITOVP signal is bitovp's own
 * measurement and stands even when the encoder's self-report disagrees.
 * The Record over the REAL union makes an unclassified new metric a tsc
 * error, never a missing badge (the PRODUCT_EVENT_KINDS idiom).
 */
export type MetricSource = "BITMOVIN" | "BITOVP";
export type MetricSubject = "INGEST" | "DELIVERY";
export const METRIC_CLASS: Record<
	AlertMetric,
	{ source: MetricSource; subject: MetricSubject }
> = {
	INPUT_DISCONNECTED: { source: "BITMOVIN", subject: "INGEST" },
	// Absence of Bitmovin data detected by OUR clock — it still describes
	// the Bitmovin feed's health, so it classes as BITMOVIN×INGEST .
	HEARTBEAT_STALE: { source: "BITMOVIN", subject: "INGEST" },
	BITRATE_BELOW: { source: "BITMOVIN", subject: "INGEST" },
	FPS_BELOW: { source: "BITMOVIN", subject: "INGEST" },
	PROGRAM_START_NO_INGEST: { source: "BITMOVIN", subject: "INGEST" },
	ORIGIN_MANIFEST_STALE: { source: "BITOVP", subject: "DELIVERY" },
	ORIGIN_ENDLIST_PRESENT: { source: "BITOVP", subject: "DELIVERY" },
	ORIGIN_EDGE_DELAY_ABOVE: { source: "BITOVP", subject: "DELIVERY" },
	// The encoder's self-report about ITS input (every observed message is
	// about the ingest: key-frame interval, AV-sync, property change, probe).
	PROVIDER_WARNING: { source: "BITMOVIN", subject: "INGEST" },
};

export const ALERT_SEVERITIES = ["WARN", "CRIT"] as const;
export type AlertSeverityKind = (typeof ALERT_SEVERITIES)[number];

/** Rule shape as the API accepts it (rows add ids/timestamps). */
export const alertRuleCreateSchema = z
	.strictObject({
		liveChannelId: z.uuid().nullable().default(null),
		metric: z.enum(ALERT_METRICS),
		threshold: z.number().positive().optional(),
		windowPolls: z.number().int().min(1).max(20).default(2),
		severity: z.enum(ALERT_SEVERITIES).default("WARN"),
		enabled: z.boolean().default(true),
	})
	.superRefine((value, ctx) => {
		// #161 widened the numeric set: the origin edge-delay rule takes a
		// seconds threshold (design §3 — without this widening the rule
		// cannot be created at all).
		const numeric =
			value.metric === "BITRATE_BELOW" ||
			value.metric === "FPS_BELOW" ||
			value.metric === "ORIGIN_EDGE_DELAY_ABOVE";
		if (numeric && value.threshold === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["threshold"],
				message: "Numeric alert rules need a threshold",
			});
		}
		if (!numeric && value.threshold !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["threshold"],
				message:
					"Only BITRATE_BELOW, FPS_BELOW and ORIGIN_EDGE_DELAY_ABOVE take a threshold",
			});
		}
	});

export type AlertRuleCreate = z.infer<typeof alertRuleCreateSchema>;

/** The rule fields evaluation needs (a Prisma AlertRule row satisfies it). */
export type EvaluatableRule = {
	id: string;
	metric: string;
	threshold: number | null;
	windowPolls: number;
};

/**
 * One heartbeat observation, structurally (the worker's PersistedHeartbeat
 * satisfies it; core must not import worker types). Newest LAST.
 */
export type HeartbeatObservation = {
	/** Poll time (ours), ISO. */
	at: string;
	raw: {
		ingest?: {
			status?: string;
			healthy?: boolean;
			streams?: unknown[];
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
};

export type RuleBreach = {
	ruleId: string;
	metric: string;
	/** Chart-linkable snapshot of what breached. */
	context: Record<string, unknown>;
};

export type AlertEvaluation = {
	open: RuleBreach[];
	resolve: string[];
};

function streamNumbers(
	observation: HeartbeatObservation,
	field: "bitrate" | "rate",
): number[] {
	const streams = observation.raw.ingest?.streams;
	if (!Array.isArray(streams)) {
		return [];
	}
	const out: number[] = [];
	for (const stream of streams) {
		if (typeof stream !== "object" || stream === null) {
			continue;
		}
		const record = stream as Record<string, unknown>;
		if (field === "rate") {
			// fps applies to video streams only; audio rows carry sampleRate
			// under other keys and must not satisfy an FPS rule.
			const looksVideo =
				record.mediaType === "VIDEO" ||
				typeof record.width === "number" ||
				typeof record.height === "number";
			if (!looksVideo) {
				continue;
			}
		}
		const value = record[field];
		if (typeof value === "number" && Number.isFinite(value)) {
			out.push(value);
		}
	}
	return out;
}

/**
 * A numeric rule breaches on one observation when EVERY reported value is
 * below the threshold AND at least one value was reported — a sample that
 * reports nothing is "no data", never a breach (false positives on
 * missing telemetry would train operators to ignore CRIT).
 */
function numericBreach(
	observation: HeartbeatObservation,
	field: "bitrate" | "rate",
	threshold: number,
): boolean {
	const values = streamNumbers(observation, field);
	return values.length > 0 && values.every((value) => value < threshold);
}

/**
 * Is the encoder's ingest CONNECTED, judged from the persisted heartbeat
 * COLUMN (`LiveChannel.lastHeartbeat`), whose shape is the worker's
 * `PersistedHeartbeat` wrapper `{ at, raw, deltas }` — the ingest block sits
 * under `raw`, exactly as `disconnected` reads its observations?
 *
 * Explicit signals only, and deliberately NOT the negation of
 * `disconnected`: a missing sample, a missing ingest block or a novel
 * status string all answer FALSE here — the callers (the slate fire gate and
 * the feeder bind-watchdog, ) act on "proven connected", because a
 * slate spliced into an encoder with no input renders NOTHING now and lands
 * on the wrong wall-clock later (the 2026-08-15 incident: insert accepted
 * 200 at 10:00:04 against WAITING_FOR_FIRST_CONNECT, and the operator saw a
 * black stream where the schedule promised a slate).
 */
export function ingestConnectedFromHeartbeat(sample: unknown): boolean {
	if (typeof sample !== "object" || sample === null) {
		return false;
	}
	// The persisted column is the WRAPPER `{ at, raw, deltas }` — the ingest
	// block lives under `raw` (review-224 C1: the first cut read the top
	// level, which the single production writer never emits, so the predicate
	// was constant-false and all three #95 fixes shipped inverted; every test
	// had hand-built the imagined flat shape. The writer's own test now feeds
	// this function its real output).
	const raw = (sample as { raw?: unknown }).raw;
	if (typeof raw !== "object" || raw === null) {
		return false;
	}
	const ingest = (raw as { ingest?: { status?: string; healthy?: boolean } })
		.ingest;
	if (!ingest) {
		return false;
	}
	return ingest.status === "CONNECTED" || ingest.healthy === true;
}

/**
 * How old a heartbeat sample may be and still VOUCH for a live connection.
 * 3 × the worker's 30s sweep cadence — one missed poll plus slack, the same
 * shape HEARTBEAT_STALE uses (windowPolls × sweepIntervalMs), fixed here so
 * UI readers that do not know the worker's constant share one bound.
 */
export const INGEST_CONNECTED_MAX_AGE_MS = 90_000;

/**
 * How far a heartbeat stamp may sit in the FUTURE and still describe a moment
 * this process can reason about — pure clock skew between the worker that
 * stamped the sample and the reader judging it (audit 4403130
 * §4 IMPORTANT-1 third defect).
 *
 * The window was one-sided until then: `now - at <= maxAge` with no lower
 * bound, so a sample stamped an HOUR ahead scored an age of -3,600,000 ms and
 * went on vouching for the whole hour it was ahead PLUS the 90s window —
 * a single frozen sample speaking for a channel for an hour and a half. Not a
 * hypothetical shape either: it is the same "an age is always positive"
 * assumption that let the negative HEARTBEAT_STALE age below suppress a real
 * breach. Both readers share ONE tolerance now, so a stamp that is merely
 * skewed still vouches and a stamp from a clock that is wrong enough to
 * matter vouches for nothing.
 *
 * 5s: 18× under the 90s vouching window, so ordinary NTP drift never costs a
 * live channel its "connected" badge, and ~50× over the sub-100ms skew a
 * healthy fleet shows — wide enough to be uninteresting, narrow enough that
 * the hour-ahead case above cannot hide in it.
 */
export const HEARTBEAT_FUTURE_SKEW_TOLERANCE_MS = 5_000;

/**
 * `ingestConnectedFromHeartbeat` answers "did the SAMPLE say connected" —
 * it deliberately knows nothing about WHEN the sample was taken, and every
 * reader that treated it as "is connected NOW" inherited a frozen stamp
 * : a stopped channel's
 * final CONNECTED sample froze the detail page at Connected forever, a
 * REVIVED run keeps its pre-error sample on the SAME row (review-243 R1's
 * presence-level read cannot help — presence is satisfied), and the
 * 2026-08-15 slate incident class reopens in that revive window.
 *
 * This is the "now" predicate: connected iff the sample says CONNECTED and
 * is younger than maxAgeMs. No timestamp = cannot vouch = false. Status
 * gating stays with the caller (the sweep checks RUNNING, the UI checks
 * isActiveChannelStatus) — this function owns only sample truth × time.
 */
export function ingestConnectedFresh(
	sample: unknown,
	nowMs: number,
	maxAgeMs: number = INGEST_CONNECTED_MAX_AGE_MS,
): boolean {
	return (
		heartbeatSampleFresh(sample, nowMs, maxAgeMs) &&
		ingestConnectedFromHeartbeat(sample)
	);
}

/**
 * The freshness half alone (review-260 127-B6): can this sample speak for
 * NOW at all? Composed into ingestConnectedFresh above and read directly by
 * UI that must decide whether to show a sample's CONTENT (the raw wire word
 * is live truth only inside the window — channel-detail's ingestStatusWord).
 * One window, one comparison, no hand-rolled copies.
 *
 * The window is SYMMETRIC : a stamp further ahead than
 * HEARTBEAT_FUTURE_SKEW_TOLERANCE_MS is not "extremely fresh", it describes a
 * moment that has not happened, and treating it as fresh held the green light
 * open — for as long as the clock was ahead — at the two places whose whole
 * job is withholding it: the slate fire gate (`sweep.ts` →
 * ingestConnectedFresh, the 2026-08-15 splice into a dead encoder) and the
 * detail page's connected/tri-state readings.
 */
export function heartbeatSampleFresh(
	sample: unknown,
	nowMs: number,
	maxAgeMs: number = INGEST_CONNECTED_MAX_AGE_MS,
): boolean {
	const at = persistedHeartbeatAtMs(sample);
	if (at === null) {
		return false;
	}
	const ageMs = nowMs - at;
	return ageMs >= -HEARTBEAT_FUTURE_SKEW_TOLERANCE_MS && ageMs <= maxAgeMs;
}

/**
 * The persisted heartbeat COLUMN's own poll time (`{ at, raw, deltas }.at`),
 * as epoch ms — null when absent or unparseable. The third hand-built reading
 * of this column  invented an `observedAt` key the writer never
 * emits and permanently counted every RUNNING channel stale; consumers parse
 * the wrapper through HERE now, coupled to the writer's real bytes by the
 * writer's own persist test.
 */
export function persistedHeartbeatAtMs(sample: unknown): number | null {
	if (typeof sample !== "object" || sample === null) {
		return null;
	}
	const at = (sample as { at?: unknown }).at;
	if (typeof at !== "string") {
		return null;
	}
	const ms = Date.parse(at);
	return Number.isFinite(ms) ? ms : null;
}

function disconnected(observation: HeartbeatObservation): boolean {
	const ingest = observation.raw.ingest;
	if (!ingest) {
		return false;
	}
	// Explicit signals only: a novel status string is unknown, not a breach.
	return ingest.status === "DISCONNECTED" || ingest.healthy === false;
}

/**
 * rev433 (owner 2026-09-07): the wire shape of an input nobody has pointed
 * an encoder at yet — `WAITING_FOR_FIRST_CONNECT` rides with healthy:false,
 * so `disconnected` is true for it. INPUT_DISCONNECTED must not OPEN on
 * it (nothing connected, nothing disconnected) but must not RESOLVE on it
 * either (an autoRestart cycle re-enters WAITING while the outage goes on);
 * PROGRAM_START_NO_INGEST keeps counting it — air time with no feed is
 * exactly this shape.
 */
function neverConnected(observation: HeartbeatObservation): boolean {
	return observation.raw.ingest?.status === "WAITING_FOR_FIRST_CONNECT";
}

/**
 * Is `now` inside a PLANNED pre-air wait — the channel carries a scheduled
 * program window and air time has not arrived yet ?
 *
 * "Planned" means exactly this and nothing softer: an operator entered a
 * programStartAt, the encoder was brought up ahead of it (the product starts
 * billing at channel creation, so being up early is the normal shape), and
 * the feed is legitimately absent until then — with or without a scheduled
 * FEEDER_START, because a hand-started encoder waits the same way.
 * WAITING_FOR_FIRST_CONNECT during that wait is the DESIGN, not a fault.
 *
 * No window configured ⇒ false: an unscheduled channel has no planned wait,
 * so nothing about its disconnection is excused. An unparseable stamp ⇒
 * false as well — a gate that cannot read its own window must not suppress.
 */
function beforeProgramStart(
	programStartAt: string | null | undefined,
	now: string,
): boolean {
	if (!programStartAt) {
		return false;
	}
	const startAtMs = Date.parse(programStartAt);
	const nowMs = Date.parse(now);
	return (
		Number.isFinite(startAtMs) && Number.isFinite(nowMs) && nowMs < startAtMs
	);
}

/**
 * The newest observation that may ANCHOR a staleness measurement, walking
 * back from the newest .
 *
 * HEARTBEAT_STALE used to anchor on `window[last]` unconditionally, and the
 * window is ordered by the sample's own `at` — so ONE sample stamped in the
 * future (a skewed worker clock) became the anchor, produced a negative age,
 * and silently suppressed the breach while the last REAL sample sat an hour
 * old. Exactly the rule that exists to notice missing data, defeated by a
 * timestamp. Skipping the future-stamped rows measures from the newest sample
 * that describes a moment that has happened.
 *
 * Unparseable stamps are skipped for the same reason (they anchored on NaN
 * before, which also read as "not stale" for a window that had older, usable
 * samples in it). Nothing usable ⇒ null, and the caller falls back to its
 * last-sign-of-life anchor exactly as before.
 */
function newestAnchorObservation(
	window: HeartbeatObservation[],
	nowMs: number,
): { at: string; atMs: number } | null {
	for (let index = window.length - 1; index >= 0; index -= 1) {
		const observation = window[index];
		if (!observation) {
			continue;
		}
		const atMs = Date.parse(observation.at);
		if (!Number.isFinite(atMs)) {
			continue;
		}
		if (atMs - nowMs > HEARTBEAT_FUTURE_SKEW_TOLERANCE_MS) {
			continue;
		}
		return { at: observation.at, atMs };
	}
	return null;
}

export function evaluateAlertRules(input: {
	rules: EvaluatableRule[];
	/** Recent observations, newest LAST. May be empty. */
	window: HeartbeatObservation[];
	/** Rule ids with an OPEN AlertEvent row for this channel. */
	openRuleIds: ReadonlySet<string>;
	channel: {
		status: string;
		/**
		 * Last sign of life (review-83b I3): the channel row's updatedAt —
		 * bumped by every successful poll's lastHeartbeat write, and by the
		 * RUNNING transition itself. Anchors HEARTBEAT_STALE when the window
		 * is EMPTY, so a channel whose FIRST poll fails gets the same
		 * windowPolls grace as one whose later polls fail, instead of an
		 * instant CRIT. Absent ⇒ an empty window cannot breach (fail quiet).
		 */
		lastTouchedAt?: string;
		/**
		 * The channel's scheduled program window , from the
		 * creation-time slot. Absent ⇒ PROGRAM_START_NO_INGEST never fires —
		 * an unscheduled channel has no air time to miss.
		 */
		programStartAt?: string | null;
		programEndAt?: string | null;
	};
	/** Sweep clock (ISO) — stale math needs "now", not the last sample. */
	now: string;
	sweepIntervalMs: number;
	/**
	 * PROVIDER_WARNING reads `events[]` as a DIFFERENCE between consecutive
	 * samples, so the window's OLDEST observation needs its predecessor to say
	 * anything. True = the window begins at the run's first sample (the caller
	 * fetched more rows than exist), so that sample's events are new by
	 * definition. False/absent = the predecessor was simply not fetched, and
	 * the oldest observation's events are treated as already known — the
	 * conservative side, because claiming novelty for a cumulative list's
	 * first entry would re-open the alert every time the window slid.
	 */
	windowStartsAtRunStart?: boolean;
}): AlertEvaluation {
	const open: RuleBreach[] = [];
	const resolve: string[] = [];
	const latest = input.window[input.window.length - 1];

	for (const rule of input.rules) {
		const windowPolls = Math.max(1, rule.windowPolls);
		let breaching = false;
		let context: Record<string, unknown> = {};

		switch (rule.metric) {
			case "INPUT_DISCONNECTED": {
				// A PLANNED pre-air wait is not a fault (audit
				// 4403130 §4 IMPORTANT-1, re-audit proof §9-7). This rule read
				// only the consecutive DISCONNECTED/healthy=false samples and
				// never the program window, so on paid runs #3–#5 it opened
				// during the scheduled WAITING_FOR_FIRST_CONNECT before the
				// feeder's own start time and resolved the moment the feed
				// arrived: a notification for the thing the operator asked for,
				// which is what trains a night shift to ignore the channel.
				//
				// The gate is the sibling rule's, deliberately:
				// PROGRAM_START_NO_INGEST (below) reads the same programStartAt
				// and OWNS the pre-air question from the other side — not by
				// being armed during the wait (it does not breach before air
				// time either) but by being the rule that fires the moment air
				// time passes with no feed. Pre-air is therefore nobody's
				// alarm, which is the point: the wait was scheduled. After air
				// time — or on an UNSCHEDULED channel, which has no planned
				// wait at all — this rule behaves exactly as it always has, and
				// nothing is suppressed after programEndAt either: a disconnect
				// on an overrunning channel is still a disconnect, and it is
				// still billing.
				//
				// The RESOLVE side of this gate (the shared edge logic at the
				// end of the loop) auto-resolves an open event the moment
				// programStartAt sits in the future, and that is safe ONLY
				// because the column has exactly one writer today: channel
				// CREATE (`apps/web/src/app/api/live-channels/route.ts`, the
				// `derived.programStartAt` branch), which cannot run on a
				// channel that already has alerts. A reschedule / edit-window
				// feature breaks that premise — moving air time on a LIVE
				// channel would silently close a real, unresolved disconnect.
				// Whoever adds one must suppress NEW opens only and never
				// auto-resolve an existing event from this gate.
				if (beforeProgramStart(input.channel.programStartAt, input.now)) {
					breaching = false;
					break;
				}
				const tail = input.window.slice(-windowPolls);
				// rev433: a never-connected sample counts only while the event is
				// already open (see `neverConnected`).
				const alreadyOpen = input.openRuleIds.has(rule.id);
				breaching =
					tail.length >= windowPolls &&
					tail.every(
						(s) => disconnected(s) && (alreadyOpen || !neverConnected(s)),
					);
				if (breaching && latest) {
					context = {
						status: latest.raw.ingest?.status ?? null,
						healthy: latest.raw.ingest?.healthy ?? null,
						at: latest.at,
					};
				}
				break;
			}
			case "PROGRAM_START_NO_INGEST": {
				const startAt = input.channel.programStartAt
					? Date.parse(input.channel.programStartAt)
					: Number.NaN;
				const endAt = input.channel.programEndAt
					? Date.parse(input.channel.programEndAt)
					: Number.NaN;
				const nowMs = Date.parse(input.now);
				const inWindow =
					Number.isFinite(startAt) &&
					nowMs >= startAt &&
					// Past the scheduled end the STOP row owns the situation;
					// an unparseable/absent end keeps the check live until stop.
					(!Number.isFinite(endAt) || nowMs <= endAt);
				if (input.channel.status !== "RUNNING" || !inWindow) {
					breaching = false;
					break;
				}
				// Same explicit-signal predicate as INPUT_DISCONNECTED, same
				// consecutive-polls window; an EMPTY window cannot breach
				// (design §3 — absence of data is not data).
				const tail = input.window.slice(-windowPolls);
				breaching = tail.length >= windowPolls && tail.every(disconnected);
				if (breaching) {
					context = {
						programStartAt: input.channel.programStartAt ?? null,
						status: latest?.raw.ingest?.status ?? null,
						healthy: latest?.raw.ingest?.healthy ?? null,
						at: latest?.at ?? null,
					};
				}
				break;
			}
			case "HEARTBEAT_STALE": {
				if (input.channel.status !== "RUNNING") {
					breaching = false;
					break;
				}
				// Absence of data cannot trigger a data-driven rule — this one
				// runs off the sweep's own clock (design §3).
				const staleAfterMs = windowPolls * input.sweepIntervalMs;
				const nowMs = Date.parse(input.now);
				// review-83b I3: an EMPTY window used to be age=∞ ⇒ instant
				// CRIT on the first tick after RUNNING when the first poll
				// failed — no grace at any windowPolls. The anchor for "no
				// samples yet" is the channel's last sign of life; without
				// one, empty cannot breach.
				//
				// : the anchor is the newest sample that can speak
				// for a moment that HAS happened, not simply the newest row —
				// a future-stamped sample used to anchor here and its negative
				// age suppressed the breach outright (see
				// newestAnchorObservation). The reported lastSampleAt names
				// THAT sample too: reporting one sample's time beside another
				// sample's age is how a reader is told a consistent lie.
				const anchorObservation = newestAnchorObservation(input.window, nowMs);
				const anchor =
					anchorObservation?.atMs ??
					(input.channel.lastTouchedAt
						? Date.parse(input.channel.lastTouchedAt)
						: Number.NaN);
				// Clamped at 0, and precisely about what that buys: an age is a
				// DURATION, and the anchor rule still admits a stamp up to the
				// skew tolerance ahead of now, so the subtraction can go
				// slightly negative. The clamp keeps this expression total.
				//
				// It is emphatically NOT what unsuppresses the breach — a
				// clamped 0 is under every threshold exactly as a negative
				// number was; the anchor CHOICE above is the whole fix. Nor
				// does it change any value emitted TODAY: `context.ageMs` is
				// only read on a breach, where the age exceeds staleAfterMs
				// and the clamp is inert. It is here so that the next reader
				// who emits this age outside a breach cannot inherit a
				// negative duration.
				const ageMs = Number.isFinite(anchor)
					? Math.max(0, nowMs - anchor)
					: Number.NaN;
				breaching = Number.isFinite(ageMs) && ageMs > staleAfterMs;
				context = {
					lastSampleAt: anchorObservation?.at ?? null,
					ageMs: Number.isFinite(ageMs) ? Math.round(ageMs) : null,
					staleAfterMs,
				};
				break;
			}
			case "BITRATE_BELOW":
			case "FPS_BELOW": {
				if (rule.threshold === null) {
					breaching = false;
					break;
				}
				const field = rule.metric === "BITRATE_BELOW" ? "bitrate" : "rate";
				const tail = input.window.slice(-windowPolls);
				breaching =
					tail.length >= windowPolls &&
					tail.every((observation) =>
						numericBreach(observation, field, rule.threshold as number),
					);
				if (breaching && latest) {
					context = {
						threshold: rule.threshold,
						values: streamNumbers(latest, field),
						at: latest.at,
					};
				}
				break;
			}
			case "PROVIDER_WARNING": {
				// Breaching while ANY observation in the last `windowPolls` carries
				// a WARNING/ERROR entry its predecessor did not — so the alert
				// opens on the poll that first shows the entry and resolves after
				// `windowPolls` consecutive polls of no NEW fault, whatever the
				// cumulative list still says. Identity (time|type|message) is the
				// dedupe: the provider's own duplicate entries are one event, and
				// the entry that stays in the list for the rest of the run is not
				// "appearing" again on the next poll.
				const tail = input.window.slice(-windowPolls);
				const tailStart = input.window.length - tail.length;
				let newest: ProviderHeartbeatEvent | undefined;
				let newestAt: string | undefined;
				const messages = new Set<string>();
				for (let offset = 0; offset < tail.length; offset += 1) {
					const observation = tail[offset];
					if (!observation) {
						continue;
					}
					const index = tailStart + offset;
					const predecessor = index > 0 ? input.window[index - 1] : undefined;
					if (predecessor === undefined && !input.windowStartsAtRunStart) {
						continue;
					}
					const faults = newProviderEvents(
						predecessor?.raw,
						observation.raw,
					).filter(isProviderFault);
					for (const fault of faults) {
						newest = fault;
						newestAt = observation.at;
						messages.add(fault.message ?? fault.eventType);
					}
				}
				breaching = newest !== undefined;
				if (newest) {
					context = {
						eventType: newest.eventType,
						message: newest.message,
						eventTime: newest.time,
						at: newestAt ?? null,
						messages: [...messages],
					};
				}
				break;
			}
			default: {
				// Unknown metric (e.g. a reserved one that slipped into the DB):
				// never breach, never resolve-flap — skip entirely.
				continue;
			}
		}

		const isOpen = input.openRuleIds.has(rule.id);
		if (breaching && !isOpen) {
			open.push({ ruleId: rule.id, metric: rule.metric, context });
		} else if (!breaching && isOpen) {
			// One edge rule for every metric, including #243's pre-air gate:
			// "not breaching" resolves, whatever silenced the rule. For the
			// pre-air gate that is safe only while programStartAt has a single
			// writer (channel CREATE) — see the INPUT_DISCONNECTED case above
			// before adding a reschedule / edit-window feature.
			resolve.push(rule.id);
		}
	}
	return { open, resolve };
}

/**
 * The UI's three-way answer about ingest . The
 * boolean `ingestConnectedFresh` folds "no sample can vouch" into `false`,
 * and a panel that reads `false` as "the encoder has NOT bound any input"
 * turns missing information into a stronger, wrong claim. Here:
 *   `true`      — a fresh sample says CONNECTED;
 *   `false`     — a fresh sample says otherwise (the encoder is up and not
 *                 receiving), or the channel is not active at all;
 *   `undefined` — the channel is active but no sample is fresh enough to
 *                 vouch (none persisted, or older than maxAgeMs): nothing is
 *                 known, and a panel must say "unconfirmed".
 */
export function ingestConnectedTriState(
	active: boolean,
	sample: unknown,
	nowMs: number,
	maxAgeMs: number = INGEST_CONNECTED_MAX_AGE_MS,
): boolean | undefined {
	if (!active) {
		return false;
	}
	if (!heartbeatSampleFresh(sample, nowMs, maxAgeMs)) {
		return undefined;
	}
	return ingestConnectedFromHeartbeat(sample);
}
