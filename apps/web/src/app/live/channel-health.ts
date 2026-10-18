import { heartbeatSampleFresh, ingestConnectedTriState } from "@bitovp/core";
import { isActiveChannelStatus, type LiveChannelListItem } from "./live-shared";

/**
 * The Live list's operations layer : what turns
 * a page of channels into a comparison an operator can scan.
 *
 * The list used to be Name / Status / Encoding ID / Created / Delete, so
 * "which RUNNING channel has a dead ingest, an open alert, a stalled origin or
 * a broken feeder" could only be answered by opening every detail page in
 * turn. This module derives that answer per row, ranks the anomalies, and owns
 * the filter/sort predicates — one seam, so a mutation to any of them fails a
 * test rather than quietly reordering a fleet view.
 *
 * FRESHNESS IS NOT RE-DERIVED HERE. The verdict "may this sample speak for
 * now" comes from core's `heartbeatSampleFresh` / `ingestConnectedTriState`
 * with their own window (`INGEST_CONNECTED_MAX_AGE_MS`, 3 × the sweep cadence,
 * symmetric against clock skew since ) — the same call the detail
 * page makes. What this file reproduces is the strip's READING of that verdict
 * (skew, never, seconds-ago, post-mortem), not a second rule about time.
 */

/**
 * How near a fire time has to be for "Scheduled soon" to claim a channel.
 *
 * One named constant because the audit asked for one, and 15 minutes because
 * that is longer than the provisioning lead an operator is watching for
 * (`deadlineMarginSeconds` defaults to 5 minutes) and short enough that a
 * fleet with a nightly schedule is not permanently "soon". Deliberately has NO
 * lower bound in the predicate below: an ARMED row whose fire time has already
 * passed and has not fired yet is exactly what this filter is for.
 */
export const SCHEDULED_SOON_MS = 15 * 60_000;

export const LIVE_LIST_FILTERS = ["all", "active", "error", "soon"] as const;
export type LiveListFilter = (typeof LIVE_LIST_FILTERS)[number];

export const LIVE_LIST_SORTS = ["anomaly", "created"] as const;
export type LiveListSort = (typeof LIVE_LIST_SORTS)[number];

/**
 * The anomalies the cockpit ranks by, WORST FIRST — the array order is the
 * rank, so adding one in the wrong place is a visible edit rather than a
 * silent reshuffle of an operator's screen.
 *
 * `OUTPUT_NOT_ADVANCING` rather than "no output": the list has no cheap,
 * honest way to say a channel has no playable manifest (that needs the plan
 * and its output credential, per row), and the origin observer already answers
 * the stronger question — is the origin's playlist actually moving. An
 * unobservable or unswept origin stays UNKNOWN and is not an anomaly, because
 * an alarm every operator learns to ignore is worse than no alarm.
 */
export const CHANNEL_ANOMALIES = [
	"ERROR",
	"OPEN_ALERT",
	"STALE_HEARTBEAT",
	"FEEDER_ERROR",
	"OUTPUT_NOT_ADVANCING",
] as const;
export type ChannelAnomaly = (typeof CHANNEL_ANOMALIES)[number];

/** Rank of a row with nothing wrong — one past the worst named anomaly. */
export const HEALTHY_RANK = CHANNEL_ANOMALIES.length;

export type ChannelHealthReading = {
	/** RUNNING/PROVISIONING/STOPPING — an inactive row is a post-mortem. */
	active: boolean;
	/** core's tri-state: true / false / undefined = nothing can vouch. */
	ingestConnected: boolean | undefined;
	/** The raw wire word, ONLY while it is live truth (active + fresh). */
	ingestWord: string | null;
	/** The sample's own poll time — what a stopped channel's cell shows. */
	heartbeatAtIso: string | null;
	/** Sample age in seconds; null = never polled or unparseable stamp. */
	heartbeatAgeSeconds: number | null;
	/** The stamp sits in the future by more than core's skew tolerance. */
	heartbeatSkewed: boolean;
	/** Active, and no sample is fresh enough to speak for now. */
	heartbeatStale: boolean;
	openAlerts: number | "unknown";
	activeFeeders: number;
	erroredFeeders: number;
	origin: NonNullable<LiveChannelListItem["health"]>["origin"];
	/**
	 * How long the current run has been up — measured to its END once it has
	 * one. A stopped channel's runtime must not keep counting: that is the
	 * owner's "36406s ago" complaint about the detail strip, and a list would
	 * repeat it once per row. Null = the run never started.
	 */
	elapsedMs: number | null;
	/**
	 * Milliseconds left on the runtime cap — only while the channel is ACTIVE
	 * and a cap exists. Null otherwise, because "time left" on a broadcast
	 * that already ended is arithmetic, not information.
	 */
	remainingMs: number | null;
	anomalies: readonly ChannelAnomaly[];
	/** Index of the worst anomaly, or HEALTHY_RANK. The sort key. */
	rank: number;
};

function parseMs(iso: string | null | undefined): number | null {
	if (!iso) {
		return null;
	}
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Everything the Health, Next event and Runtime cells show for one row, plus
 * the anomaly rank the sort and the Error filter both read.
 *
 * `nowMs` is the SERVER-anchored clock (the response's `serverNow` offset
 * applied to a ticking browser clock), not `Date.now`: heartbeat stamps are
 * written by the worker, and comparing them against a viewer's clock is how a
 * healthy channel reads as disconnected on a fast laptop (review-260 127-A5).
 */
export function readChannelHealth(
	item: LiveChannelListItem,
	nowMs: number,
): ChannelHealthReading {
	const health = item.health ?? null;
	const active = isActiveChannelStatus(item.status);
	const sample = health?.heartbeat ?? null;
	const fresh = heartbeatSampleFresh(sample, nowMs);
	const ingestConnected = ingestConnectedTriState(active, sample, nowMs);
	const atMs = parseMs(sample?.at);
	/**
	 * Negative age = the sample is stamped in the FUTURE (worker/browser clock
	 * skew). Reported as skew rather than clamped to "0s ago", which is the
	 * freshest possible reading for a value we cannot trust (review-234 N4).
	 */
	const rawAgeSeconds =
		atMs === null ? null : Math.round((nowMs - atMs) / 1000);
	const heartbeatSkewed = rawAgeSeconds !== null && rawAgeSeconds < 0;
	const openAlerts = health?.openAlerts ?? "unknown";
	const origin = health?.origin ?? null;
	const heartbeatStale = active && !fresh;
	const startedMs = parseMs(health?.runningSince);
	const endedMs = parseMs(health?.endedAt);
	const elapsedMs =
		startedMs === null ? null : Math.max(0, (endedMs ?? nowMs) - startedMs);
	const cap = health?.maxRunMinutes ?? null;
	const remainingMs =
		!active || startedMs === null || cap === null
			? null
			: startedMs + cap * 60_000 - nowMs;

	const anomalies: ChannelAnomaly[] = [];
	if (item.status === "ERROR") {
		anomalies.push("ERROR");
	}
	// `"unknown"` is NOT an anomaly: a failed alert read is a gap in what we
	// know, and promoting it to the top of the list would bury the channels we
	// do know are breaching. The Health cell says "unknown" out loud instead.
	if (typeof openAlerts === "number" && openAlerts > 0) {
		anomalies.push("OPEN_ALERT");
	}
	if (heartbeatStale) {
		anomalies.push("STALE_HEARTBEAT");
	}
	/**
	 * Both of the next two are gated on `active` for exactly the reason
	 * `heartbeatStale` is (review of PR #359, reproduced): they read the
	 * CURRENT run's LAST RECORDED state, and the origin observer only polls
	 * RUNNING channels. So a channel stopped BECAUSE its output stalled — or
	 * one that merely caught a stale/ENDLIST tick on its final poll, which is
	 * what a clean shutdown looks like from the origin — would rank above
	 * every healthy row FOREVER, with nothing an operator could do to clear
	 * it. That is precisely the alarm this module's header calls worse than no
	 * alarm.
	 *
	 * `OPEN_ALERT` and `ERROR` above are deliberately NOT gated, and the
	 * difference is actionability rather than status: an open alert event is
	 * resolvable by hand from the channel's Alerts section, and an ERROR row
	 * is restartable or deletable — each still names work an operator can do,
	 * which is what a rank at the top of this list is asking for.
	 *
	 * The FACTS are not suppressed — the Health cell still reports the last
	 * feeder failure and the last origin verdict as a post-mortem readout,
	 * toned neutral there for the same reason. Only the RANKING is gated.
	 */
	if (active && (health?.erroredFeeders ?? 0) > 0) {
		anomalies.push("FEEDER_ERROR");
	}
	if (active && origin && (origin.stale > 0 || origin.endlist > 0)) {
		anomalies.push("OUTPUT_NOT_ADVANCING");
	}
	const rank: number =
		anomalies.length === 0
			? HEALTHY_RANK
			: Math.min(
					...anomalies.map((anomaly) => CHANNEL_ANOMALIES.indexOf(anomaly)),
				);

	return {
		active,
		ingestConnected,
		ingestWord: active && fresh ? (sample?.raw.ingest.status ?? null) : null,
		heartbeatAtIso: sample?.at ?? null,
		heartbeatAgeSeconds: heartbeatSkewed ? null : rawAgeSeconds,
		heartbeatSkewed,
		heartbeatStale,
		openAlerts,
		activeFeeders: health?.activeFeeders ?? 0,
		erroredFeeders: health?.erroredFeeders ?? 0,
		origin,
		elapsedMs,
		remainingMs,
		anomalies,
		rank,
	};
}

/** Is a row due (or overdue) inside the "soon" window? */
export function scheduledSoon(
	item: LiveChannelListItem,
	nowMs: number,
): boolean {
	const fireAtMs = parseMs(item.nextSchedule?.fireAt);
	return fireAtMs !== null && fireAtMs - nowMs <= SCHEDULED_SOON_MS;
}

function matchesFilter(
	item: LiveChannelListItem,
	health: ChannelHealthReading,
	filter: LiveListFilter,
	nowMs: number,
): boolean {
	switch (filter) {
		case "active":
			return health.active;
		/**
		 * "Error" is every row that needs someone — the ERROR status AND every
		 * anomaly the Health column shows. A RUNNING channel whose ingest died
		 * two minutes ago needs the operator more urgently than an ERROR row
		 * that has been stopped for a day, and a filter that hid it behind a
		 * status enum would send them back to opening detail pages.
		 */
		case "error":
			return health.rank < HEALTHY_RANK;
		case "soon":
			return scheduledSoon(item, nowMs);
		default:
			return true;
	}
}

/**
 * Case-insensitive substring on the NAME only.
 *
 * Deliberately not the encoding id: the id is a copy target, not something an
 * operator types, and matching it would make a paste of an unrelated id look
 * like a filtered-to-nothing list rather than a no-match.
 */
function matchesQuery(item: LiveChannelListItem, query: string): boolean {
	const needle = query.trim().toLowerCase();
	return needle === "" || item.name.toLowerCase().includes(needle);
}

export type ArrangedChannel = {
	item: LiveChannelListItem;
	health: ChannelHealthReading;
};

/**
 * Filter + sort the loaded page in one pass, so the Health cell, the Error
 * filter and the anomaly sort can never disagree about a row: they all read
 * the SAME reading.
 *
 * The `created` sort reproduces the server's own `createdAt desc, id desc`
 * order rather than trusting the array to already be in it — TanStack
 * concatenates pages, and a page boundary is exactly where an unsorted
 * "already sorted" assumption stops holding.
 *
 * Secondary order is the name, then the id: two channels with the same
 * anomaly and the same name must not swap places between two polls.
 */
export function arrangeChannels(
	items: readonly LiveChannelListItem[],
	options: { filter: LiveListFilter; query: string; sort: LiveListSort },
	nowMs: number,
): ArrangedChannel[] {
	const rows = items
		.map((item) => ({ item, health: readChannelHealth(item, nowMs) }))
		.filter(
			({ item, health }) =>
				matchesFilter(item, health, options.filter, nowMs) &&
				matchesQuery(item, options.query),
		);
	return rows.sort((a, b) => {
		if (options.sort === "anomaly" && a.health.rank !== b.health.rank) {
			return a.health.rank - b.health.rank;
		}
		if (options.sort === "created") {
			const created = b.item.createdAt.localeCompare(a.item.createdAt);
			if (created !== 0) {
				return created;
			}
		}
		return (
			a.item.name.localeCompare(b.item.name) ||
			a.item.id.localeCompare(b.item.id)
		);
	});
}

/**
 * Per-viewer conveniences, remembered in localStorage. Not shared state and
 * not a preference the server knows about — a filter one operator left on
 * their own laptop.
 */
const PREFS_STORAGE_KEY = "ovp-live-list-prefs";

export type LiveListPrefs = { filter: LiveListFilter; sort: LiveListSort };

export const DEFAULT_LIVE_LIST_PREFS: LiveListPrefs = {
	filter: "all",
	sort: "anomaly",
};

/**
 * Reads the stored preferences, and answers the defaults for every way that
 * can fail: no window (SSR), nothing stored, unparseable JSON, a value from a
 * renamed option set, or a browser that throws on the accessor itself
 * (private mode, blocked site data).
 *
 * The free-text SEARCH is deliberately not stored. A filter an operator
 * chose is a setting; a half-typed name that silently hides nine of ten
 * channels on their next visit is a bug report.
 */
export function readLiveListPrefs(): LiveListPrefs {
	if (typeof window === "undefined") {
		return DEFAULT_LIVE_LIST_PREFS;
	}
	try {
		const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
		if (raw === null) {
			return DEFAULT_LIVE_LIST_PREFS;
		}
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) {
			return DEFAULT_LIVE_LIST_PREFS;
		}
		const { filter, sort } = parsed as Partial<LiveListPrefs>;
		return {
			filter: (LIVE_LIST_FILTERS as readonly string[]).includes(filter ?? "")
				? (filter as LiveListFilter)
				: DEFAULT_LIVE_LIST_PREFS.filter,
			sort: (LIVE_LIST_SORTS as readonly string[]).includes(sort ?? "")
				? (sort as LiveListSort)
				: DEFAULT_LIVE_LIST_PREFS.sort,
		};
	} catch {
		return DEFAULT_LIVE_LIST_PREFS;
	}
}

/** Best-effort write — a viewer who cannot store preferences still gets a list. */
export function writeLiveListPrefs(prefs: LiveListPrefs): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		// Private mode / blocked site data: the preference is lost, not the page.
	}
}
