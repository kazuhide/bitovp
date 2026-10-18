/**
 * Does a bucket's CORS configuration permit in-browser playback?
 *
 * Public-read does not imply CORS. hls.js, Shaka Player and Bitmovin Player all
 * fetch manifests and segments through XHR/fetch, so the bucket has to allow
 * the page's origin — and, for MP4 byte-range HLS and DASH, allow the `Range`
 * request header and *expose* the range response headers. Measured against the
 * real output bucket , `Access-Control-Expose-Headers` was absent from
 * every response while everything else was permissive: exactly the shape this
 * predicate exists to name.
 *
 * Pure and provider-agnostic — the rules arrive from whichever driver could
 * read them. Nothing here decides whether playback WILL fail, and the
 * `MISSING_EXPOSE_HEADERS` case has been measured not to stop hls.js or dash.js:
 * with the headers withheld, hls.js played fMP4 HLS and byte-range MP4 HLS, and
 * dash.js played DASH . That old
 * dash.js result does not clear the current Shaka preview path. Until Shaka is
 * measured against the same response shape, the UI keeps this verdict
 * actionable without claiming that the headers are conclusively causal.
 */

/** Provider-neutral CORS rule (mirrors `@bitovp/storage`'s BucketCorsRule). */
export type PlaybackCorsRule = {
	allowedOrigins: string[];
	allowedMethods: string[];
	allowedHeaders: string[];
	exposeHeaders: string[];
};

/**
 * Response headers a range-based player needs handed to JS. `Content-Range`
 * and `Accept-Ranges` are what a player uses to confirm the server honoured
 * the range at all; `Content-Length` is how it sizes the remainder.
 */
export const RANGE_RESPONSE_HEADERS = [
	"content-range",
	"accept-ranges",
	"content-length",
] as const;

export type PlaybackCorsVerdict =
	/** Origin allowed for GET, `Range` allowed, range headers exposed. */
	| { code: "OK" }
	/** The bucket has no CORS configuration at all. */
	| { code: "NO_RULES" }
	/** No rule matches this origin with GET. */
	| { code: "ORIGIN_NOT_ALLOWED"; origin: string }
	/** Matched, but the `Range` request header would fail the preflight. */
	| { code: "RANGE_HEADER_NOT_ALLOWED" }
	/** Matched, but these response headers are withheld from JS. */
	| { code: "MISSING_EXPOSE_HEADERS"; headers: string[] };

function fold(values: string[]): string[] {
	return values.map((v) => v.trim().toLowerCase());
}

/**
 * S3 allows ONE `*` anywhere in an allowed origin (`https://*.example.com`);
 * a bare `*` allows everything. Matching is exact otherwise — a scheme or port
 * mismatch is a mismatch, which is why `http://localhost:3100` and
 * `https://localhost:3100` are different origins to a bucket.
 */
function originMatches(pattern: string, origin: string): boolean {
	const p = pattern.trim();
	if (p === "*") {
		return true;
	}
	const star = p.indexOf("*");
	if (star === -1) {
		return p.toLowerCase() === origin.toLowerCase();
	}
	/**
	 * A wildcard pattern must still carry a scheme, and this is a FALSE GREEN if
	 * it does not.
	 *
	 * S3 matches `AllowedOrigin` against the whole `Origin` header, which always
	 * has a scheme — so `*.example.com` (a very common way to hand-write this)
	 * matches nothing and Chrome hard-fails. Without this guard the head was `""`
	 * for a leading `*`, the scheme was never required, and the panel reported
	 * `OK`: "the bucket's CORS rules allow this page… so CORS is not the cause",
	 * pointing the operator away from the actual fault. A false OK here is the
	 * worst output this predicate can produce. Unlike the cautiously implicated
	 * expose-header verdict, an origin mismatch is already a proven blocker.
	 */
	if (!p.slice(0, star).includes("://")) {
		return false;
	}
	const head = p.slice(0, star).toLowerCase();
	const tail = p.slice(star + 1).toLowerCase();
	const lower = origin.toLowerCase();
	return (
		lower.length >= head.length + tail.length &&
		lower.startsWith(head) &&
		lower.endsWith(tail)
	);
}

function allowsHeader(rule: PlaybackCorsRule, header: string): boolean {
	const allowed = fold(rule.allowedHeaders);
	return allowed.includes("*") || allowed.includes(header);
}

/**
 * Evaluates the rules the way a browser does: the FIRST rule matching the
 * origin and method wins, and a later, more permissive rule does not rescue
 * it. Ordering therefore matters, and a bucket whose first matching rule omits
 * `ExposeHeaders` is misconfigured even if a second rule sets them.
 */
export function checkPlaybackCors(
	rules: PlaybackCorsRule[] | null,
	options: { origin: string },
): PlaybackCorsVerdict {
	if (rules === null || rules.length === 0) {
		return { code: "NO_RULES" };
	}
	const match = rules.find(
		(rule) =>
			rule.allowedOrigins.some((pattern) =>
				originMatches(pattern, options.origin),
			) &&
			// Both reads FOLDED: `[" * "]` used to fall through to
			// ORIGIN_NOT_ALLOWED, the one raw comparison left in this file.
			(fold(rule.allowedMethods).includes("get") ||
				fold(rule.allowedMethods).includes("*")),
	);
	if (!match) {
		return { code: "ORIGIN_NOT_ALLOWED", origin: options.origin };
	}
	if (!allowsHeader(match, "range")) {
		// A player that sets `Range` explicitly turns the request non-simple, so
		// the browser preflights it — and a bucket allowing only origins and
		// methods rejects that preflight. Exposing the response headers is not
		// enough; the REQUEST header has to be allowed too.
		return { code: "RANGE_HEADER_NOT_ALLOWED" };
	}
	const exposed = fold(match.exposeHeaders);
	// S3 rejects `*` in ExposeHeaders at configuration time, but other
	// providers accept it — honour it rather than reporting a false miss.
	if (!exposed.includes("*")) {
		const missing = RANGE_RESPONSE_HEADERS.filter((h) => !exposed.includes(h));
		if (missing.length > 0) {
			return { code: "MISSING_EXPOSE_HEADERS", headers: [...missing] };
		}
	}
	return { code: "OK" };
}
