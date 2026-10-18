import { ingestConnectedFromHeartbeat } from "./alerts";

/**
 * Run health derivation (2026-08-23, owner ask): "is THIS broadcast healthy,
 * at a glance" — three layers per heartbeat poll, and their from→to spans
 * over a run's lifetime:
 *
 *   ingest   — the input is actually arriving (the sample's own ingest block
 *              says CONNECTED/healthy; `ingestConnectedFromHeartbeat`, the
 *              #95 predicate — explicit signals only, never a negation).
 *   encoder  — a heartbeat existed at t: the sweep persists a Poll row ONLY
 *              when the encoder responds, and a Push receipt IS a response
 *              , so row presence at t IS the evidence; there is no
 *              second source to cross-check inside one sample.
 *   output   — encode output is being produced: the sample's delivery block
 *              carries a manifest update whose wall-clock time is within the
 *              freshness window of the poll. Absence of the block answers
 *              false (a reader must not infer output from silence — the
 *              #159/#161 lesson: empty outlier arrays are not health).
 *
 * `at` is the row's own clock — our poll time for a Poll row, the provider's
 * sample time for a Push receipt . Pure and UI-free: the API route feeds persisted rows in, the
 * channel page renders points (live lamps) and lanes (the run timeline).
 */

/** One heartbeat poll, reduced to the three health booleans. */
export type RunHealthPoint = {
	/** Poll time, epoch ms (LiveHeartbeat.at). */
	atMs: number;
	ingest: boolean;
	encoder: boolean;
	output: boolean;
};

/** A continuous true-span of one lane, in poll time. */
export type RunHealthSpan = { fromMs: number; toMs: number };

export type RunHealthLanes = {
	ingest: RunHealthSpan[];
	encoder: RunHealthSpan[];
	output: RunHealthSpan[];
};

export type RunHealth = {
	points: RunHealthPoint[];
	lanes: RunHealthLanes;
	/** The newest point, when any exist — the "now" lamps for a RUNNING run. */
	latest?: RunHealthPoint;
};

/**
 * Two consecutive true points further apart than this break the span: the
 * sweep polls every ~30s, so 3 polls of silence (the same bound
 * INGEST_CONNECTED_MAX_AGE_MS encodes) means the lane was NOT continuously
 * healthy across the gap — a span that bridged it would paint uptime nobody
 * observed.
 */
export const RUN_HEALTH_SPAN_GAP_MS = 90_000;

/**
 * How recent the newest manifest update must be, relative to the POLL time,
 * to count as "output flowing at this poll". Same bound as the span gap: one
 * missed update cycle plus slack.
 */
export const RUN_HEALTH_OUTPUT_FRESH_MS = 90_000;

/** The persisted row shape the route feeds in (LiveHeartbeat columns). */
export type RunHealthInputRow = {
	at: Date | string;
	raw: unknown;
};

/**
 * The newest `manifestUpdateWallClockTime` across the sample's HLS manifests,
 * epoch ms — undefined when the sample carries no delivery block or no
 * parseable update. Exported so the heartbeat log's "newest manifest update
 * age" column and the worker's output stalled/unstalled log line read the
 * SAME field the health lanes do.
 */
export function newestManifestUpdateMs(raw: unknown): number | undefined {
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	const output = (
		raw as {
			output?: {
				manifests?: {
					hls?: Array<{
						manifestUpdates?: Array<{
							manifestUpdateWallClockTime?: string;
						}>;
					}>;
				};
			};
		}
	).output;
	const lists = output?.manifests?.hls ?? [];
	let newest: number | undefined;
	for (const manifest of lists) {
		// manifestUpdates is NEWEST-FIRST  — but
		// scanning all entries costs little and does not bet on the ordering.
		for (const update of manifest.manifestUpdates ?? []) {
			const t = update.manifestUpdateWallClockTime
				? Date.parse(update.manifestUpdateWallClockTime)
				: Number.NaN;
			if (Number.isFinite(t) && (newest === undefined || t > newest)) {
				newest = t;
			}
		}
	}
	return newest;
}

/**
 * The output lane's per-poll verdict, on its own: is encode output flowing at
 * poll time `atMs`? `true`/`false` are the health lane's exact predicate
 * (|poll − newest manifest update| within `freshMs`); `null` means the sample
 * carries NO manifest update at all — a DASH-only plan's structurally
 * unobservable output (review-292 N3), which a reader must not paint as
 * stalled. `deriveRunHealth` folds `null` into `false` for the lane (absence
 * is never health); the state-change log keeps the three-way answer so it
 * never logs "stalled" for an output nothing can observe.
 */
export function outputFlowingAt(
	raw: unknown,
	atMs: number,
	freshMs: number = RUN_HEALTH_OUTPUT_FRESH_MS,
): boolean | null {
	const updateMs = newestManifestUpdateMs(raw);
	if (updateMs === undefined) {
		return null;
	}
	// |delta|, not one-sided — a future-dated manifestUpdateWallClockTime
	// (encoder/our clock skew) would be negative and always "fresh".
	return Math.abs(atMs - updateMs) <= freshMs;
}

function spansOf(
	points: RunHealthPoint[],
	lane: "ingest" | "encoder" | "output",
	gapMs: number,
): RunHealthSpan[] {
	const spans: RunHealthSpan[] = [];
	let open: RunHealthSpan | undefined;
	for (const p of points) {
		if (!p[lane]) {
			open = undefined;
			continue;
		}
		if (open && p.atMs - open.toMs <= gapMs) {
			open.toMs = p.atMs;
			continue;
		}
		open = { fromMs: p.atMs, toMs: p.atMs };
		spans.push(open);
	}
	return spans;
}

export function deriveRunHealth(
	rows: RunHealthInputRow[],
	options: {
		spanGapMs?: number;
		outputFreshMs?: number;
		/**
		 * The caller's clock — REQUIRED (review-292 follow-up 3: optional restored
		 * the frozen-lamp bug by omission; one caller exists, so tsc forces the
		 * next one to think). `latest` is returned ONLY while the
		 * newest poll is younger than latestMaxAgeMs — review-292 N1: without
		 * this, a dead encoder stops producing rows and the "now" lamps freeze
		 * green at the last good poll forever, 's frozen-stamp
		 * class re-committed by a NEW reader (the fourth time). The lanes and
		 * points are historical facts and stay; only the "now" claim expires.
		 */
		nowMs: number;
		latestMaxAgeMs?: number;
	},
): RunHealth {
	const gapMs = options.spanGapMs ?? RUN_HEALTH_SPAN_GAP_MS;
	const freshMs = options.outputFreshMs ?? RUN_HEALTH_OUTPUT_FRESH_MS;
	const samples = rows
		.map((row) => ({
			atMs: row.at instanceof Date ? row.at.getTime() : Date.parse(row.at),
			raw: row.raw,
		}))
		.filter((s) => Number.isFinite(s.atMs))
		.sort((a, b) => a.atMs - b.atMs);
	// The output lane carries the newest manifest update seen so far across
	// the time-ordered series. A poll sample reports the cumulative manifest
	// state, but a 2-second Push heartbeat lists only the updates of its own
	// window, so most Push samples carry none: judged on their own (the
	// previous per-sample `outputFlowingAt`) they read "output stopped" and
	// the lane flipped ON/OFF every few seconds over a healthy run (
	// seen on the 2026-09-08 run: 134 flips where poll-only drew 1). With the
	// carry-forward, a sample is ON when the newest update observed at or
	// before it is within freshMs — for poll-only series this is the same
	// verdict as before, because each poll already carries that newest time.
	let newestUpdateMs: number | undefined;
	const points: RunHealthPoint[] = samples.map((sample) => {
		const own = newestManifestUpdateMs(sample.raw);
		if (
			own !== undefined &&
			(newestUpdateMs === undefined || own > newestUpdateMs)
		) {
			newestUpdateMs = own;
		}
		return {
			atMs: sample.atMs,
			// The predicate reads the persisted WRAPPER shape `{raw}` —
			// review-224 C1's lesson is baked into its contract.
			ingest: ingestConnectedFromHeartbeat({ raw: sample.raw }),
			encoder: true,
			// |delta|, not one-sided (review-292 N2): a future-dated update must
			// not stay fresh forever. No update observed yet is NOT health.
			output:
				newestUpdateMs !== undefined &&
				Math.abs(sample.atMs - newestUpdateMs) <= freshMs,
		};
	});
	const lanes: RunHealthLanes = {
		ingest: spansOf(points, "ingest", gapMs),
		encoder: spansOf(points, "encoder", gapMs),
		output: spansOf(points, "output", gapMs),
	};
	const newest = points[points.length - 1];
	const maxAge = options.latestMaxAgeMs ?? RUN_HEALTH_SPAN_GAP_MS;
	// |delta| for the same reason as the output lane above (review-292
	// follow-up 2): a future-dated poll row must EXPIRE too, not live forever.
	const latest =
		newest && Math.abs(options.nowMs - newest.atMs) <= maxAge
			? newest
			: undefined;
	return { points, lanes, ...(latest ? { latest } : {}) };
}
