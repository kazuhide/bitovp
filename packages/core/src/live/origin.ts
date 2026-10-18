/**
 * Origin media-playlist observation  — PURE parsers and
 * checks. No fetch here: the worker fetches (driver or railed HTTP) and
 * hands the TEXT in; core answers "what does this playlist say" and "is it
 * advancing", so every rule is table-testable without a bucket.
 *
 * The design's sharpest review catch is load-bearing here and worth
 * restating: `#EXT-X-MEDIA-SEQUENCE` advances only when segments roll OFF
 * the window, so it sits at 0 while a healthy DVR window GROWS — for up to
 * ~3h at C8's recommended timeshift. This repo has retracted
 * media-sequence-as-progress TWICE (the verify engine's windowFull guard,
 * the MSL4 measurement's Part-6 correction). The PRIMARY progress signal is
 * therefore last-segment-URI change / segment-count growth; media-sequence
 * participates only as a corroborator, gated on the windowFull predicate.
 */

export class MasterPlaylistError extends Error {
	constructor() {
		super(
			"this is a MASTER playlist — origin checks evaluate MEDIA playlists only",
		);
		this.name = "MasterPlaylistError";
	}
}

export type ParsedMediaPlaylist = {
	segmentCount: number;
	lastSegmentUri: string | null;
	mediaSequence: number | null;
	targetDurationSeconds: number | null;
	hasEndlist: boolean;
	/** The NEWEST segment's start time, derived from the last PDT anchor
	 * PLUS the EXTINF durations accumulated after it (review-161-162 M1:
	 * reading the anchor VERBATIM was wrong by the whole DVR window under
	 * `ONCE_PER_PLAYLIST` placement — our own schema ships that mode, and a
	 * C8-sized window made a healthy channel read ~3h behind). ISO string;
	 * null when the playlist carries no parseable PDT. */
	newestPdt: string | null;
	/** Sum of EXTINF durations — the approximate-delay fallback's basis. */
	totalDurationSeconds: number;
};

/**
 * Parse ONE media playlist. Throws MasterPlaylistError on a master (the
 * C2 kill: evaluating a master silently "passes" every check — no EXTINF,
 * no sequence, no ENDLIST — which is the exact master-vs-media confusion
 * the verify engine has already guarded once).
 */
export function parseMediaPlaylist(text: string): ParsedMediaPlaylist {
	if (text.includes("#EXT-X-STREAM-INF")) {
		throw new MasterPlaylistError();
	}
	const lines = text.split(/\r?\n/);
	let segmentCount = 0;
	let lastSegmentUri: string | null = null;
	let mediaSequence: number | null = null;
	let targetDurationSeconds: number | null = null;
	let hasEndlist = false;
	let pendingPdt: string | null = null;
	let totalDurationSeconds = 0;
	let sawExtinf = false;
	let currentDuration = 0;
	// PDT anchoring (review-161-162 M1): a playlist may carry PDT once at
	// the top (`ONCE_PER_PLAYLIST` — our schema's FIRST placement mode), so
	// the newest segment's start = the LAST anchor plus every EXTINF
	// duration accumulated between the anchor segment's start and the
	// newest segment's start.
	let anchorPdtMs: number | null = null;
	let offsetSeconds = 0;
	let lastClosedDuration = 0;
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
			const value = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length));
			mediaSequence = Number.isFinite(value) ? value : null;
		} else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
			const value = Number(line.slice("#EXT-X-TARGETDURATION:".length));
			targetDurationSeconds = Number.isFinite(value) ? value : null;
		} else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
			pendingPdt = line.slice("#EXT-X-PROGRAM-DATE-TIME:".length).trim();
		} else if (line.startsWith("#EXTINF:")) {
			sawExtinf = true;
			const duration = Number.parseFloat(line.slice("#EXTINF:".length));
			currentDuration = Number.isFinite(duration) ? duration : 0;
			if (Number.isFinite(duration)) {
				totalDurationSeconds += duration;
			}
		} else if (line === "#EXT-X-ENDLIST") {
			hasEndlist = true;
		} else if (sawExtinf && line.length > 0 && !line.startsWith("#")) {
			// The URI line that closes the pending EXTINF.
			segmentCount += 1;
			lastSegmentUri = line;
			if (pendingPdt !== null) {
				const parsedMs = Date.parse(pendingPdt);
				if (Number.isFinite(parsedMs)) {
					anchorPdtMs = parsedMs;
					offsetSeconds = 0;
				}
			} else if (anchorPdtMs !== null) {
				// This segment starts one predecessor-duration after the
				// previous segment's start.
				offsetSeconds += lastClosedDuration;
			}
			lastClosedDuration = currentDuration;
			pendingPdt = null;
			sawExtinf = false;
		}
	}
	const newestPdt =
		anchorPdtMs === null
			? null
			: new Date(anchorPdtMs + offsetSeconds * 1000).toISOString();
	return {
		segmentCount,
		lastSegmentUri,
		mediaSequence,
		targetDurationSeconds,
		hasEndlist,
		newestPdt,
		totalDurationSeconds,
	};
}

/** The per-playlist slice of the run's observation cursor. */
export type OriginPlaylistCursor = {
	lastSegmentUri: string | null;
	segmentCount: number;
	mediaSequence: number | null;
	/** When the observer last saw PROGRESS (not merely last looked). */
	lastProgressAtMs: number;
};

/**
 * What the origin observer knows about a RUN's FIRST PUBLISH .
 *
 *  - `"PUBLISHED"` — a media playlist carried at least one segment. STICKY for
 *    the life of the run: a later unreadable tick must not un-publish a run
 *    that demonstrably went on air.
 *  - `"AWAITING"` — this tick REACHED the origin (it had a reader and a
 *    bucket and asked the store for at least one media playlist) and nothing
 *    was there yet. This is evidence of ABSENCE, not absence of evidence.
 *  - absent (`null` from the reader below) — the observer has not looked yet,
 *    or could not look at all (no HLS in the plan, an undriveable origin, an
 *    underivable run prefix). Nothing about the origin is known.
 *
 * This is monitoring history, not all-target capture readiness. The capture
 * route separately checks its TS/fMP4 targets, including DASH-only outputs.
 */
export type OriginPublishState = "PUBLISHED" | "AWAITING";

/**
 * Reads the first-publish fact out of a run's persisted `originObservation`
 * JSON. The column is `Json?`, so every caller gets `unknown` from Prisma and
 * needs this narrowing without importing worker-only state types.
 *
 * Returns `null` for anything that is not one of the two known states,
 * INCLUDING a legacy row written before the field existed: those rows carry
 * cursors but no `publish`, and inferring "not published" from their absence
 * would refuse a channel that has been on air for hours.
 */
export function originPublishState(
	observation: unknown,
): OriginPublishState | null {
	if (typeof observation !== "object" || observation === null) {
		return null;
	}
	const value = (observation as { publish?: unknown }).publish;
	return value === "PUBLISHED" || value === "AWAITING" ? value : null;
}

export type OriginCheckVerdicts = {
	/** True when nothing progressed for longer than windowPolls × interval. */
	stale: boolean;
	/** Milliseconds since last observed progress. */
	sinceProgressMs: number;
	endlist: boolean;
	/** Seconds behind now, PDT-derived when possible. */
	edgeDelaySeconds: number | null;
	edgeDelayApproximate: boolean;
	nextCursor: OriginPlaylistCursor;
};

/**
 * Evaluate one playlist against its cursor.
 *
 * Progress = last-segment URI changed OR segment count grew (primary).
 * Media-sequence advance corroborates ONLY when the window is full
 * (count stopped growing) — the gate above. A first observation (no
 * cursor) is progress by definition: never open a stale alert on the
 * observer's own first look.
 */
export function evaluateOriginPlaylist(opts: {
	parsed: ParsedMediaPlaylist;
	cursor: OriginPlaylistCursor | null;
	nowMs: number;
	intervalMs: number;
	windowPolls: number;
}): OriginCheckVerdicts {
	const { parsed, cursor, nowMs } = opts;
	let progressed: boolean;
	if (cursor === null) {
		progressed = true;
	} else {
		const uriChanged =
			parsed.lastSegmentUri !== null &&
			parsed.lastSegmentUri !== cursor.lastSegmentUri;
		const grew = parsed.segmentCount > cursor.segmentCount;
		// The corroborator: once the window is FULL (growth stopped), the
		// sequence must move as segments roll off — its advance also counts
		// as progress (a same-length window sliding forward can keep the same
		// tail URI only when segment names repeat; the sequence still moves).
		const windowFull =
			parsed.segmentCount === cursor.segmentCount && parsed.segmentCount > 0;
		const sequenceAdvanced =
			windowFull &&
			parsed.mediaSequence !== null &&
			cursor.mediaSequence !== null &&
			parsed.mediaSequence > cursor.mediaSequence;
		progressed = uriChanged || grew || sequenceAdvanced;
	}
	const lastProgressAtMs = progressed
		? nowMs
		: (cursor?.lastProgressAtMs ?? nowMs);
	const sinceProgressMs = nowMs - lastProgressAtMs;
	const stale = sinceProgressMs > opts.windowPolls * opts.intervalMs;

	let edgeDelaySeconds: number | null = null;
	let edgeDelayApproximate = false;
	if (parsed.newestPdt !== null) {
		const pdtMs = Date.parse(parsed.newestPdt);
		if (Number.isFinite(pdtMs)) {
			edgeDelaySeconds = Math.max(0, Math.round((nowMs - pdtMs) / 1000));
		}
	}
	if (edgeDelaySeconds === null && parsed.targetDurationSeconds !== null) {
		// No PDT: the newest segment is at most one target duration old when
		// healthy — anything beyond sinceProgress + targetDuration is behind.
		// Marked approximate; the doc says which question each half answers.
		edgeDelaySeconds = Math.round(
			sinceProgressMs / 1000 + parsed.targetDurationSeconds,
		);
		edgeDelayApproximate = true;
	}

	return {
		stale,
		sinceProgressMs,
		endlist: parsed.hasEndlist,
		edgeDelaySeconds,
		edgeDelayApproximate,
		nextCursor: {
			lastSegmentUri: parsed.lastSegmentUri,
			segmentCount: parsed.segmentCount,
			mediaSequence: parsed.mediaSequence,
			lastProgressAtMs,
		},
	};
}
