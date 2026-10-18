/**
 * The `fetch` the Bitmovin SDK gets, wrapped to survive a dropped connection.
 *
 * A real 26-step VOD job died at the HLS-manifest step with:
 *
 *   Request failed: Invalid response body while trying to fetch
 *   https://api.bitmovin.com/v1/encoding/manifests/hls: Premature close
 *
 * That message comes from `buildBitmovinErrorFromError` (RestClient.js:315) — the
 * branch where `fetch` itself REJECTED rather than returning a response. `Premature
 * close` is undici saying the connection died before the response body arrived.
 *
 * Measured, not assumed: five consecutive POSTs of the same shape to the same
 * endpoint from a short-lived process all returned a readable body (401, ~280ms). The
 * request is well-formed too — `hlsMediaPlaylistVersion: "4"` is correct, since the
 * SDK's `HlsVersion` is a string enum (`HLS_V4 = "4"`). What the worker has that the
 * probe does not is a LONG-LIVED connection pool: it pauses between steps, the API's
 * load balancer sends FIN on an idle pooled socket, and undici writes the next
 * request into it just as it closes. Retrying opens a fresh socket.
 *
 * Only a REJECTION is retried. A response that arrived is returned untouched whatever
 * its status — the SDK turns 4xx/5xx into a `BitmovinError` carrying the API's own
 * message, and repeating a request the API deliberately refused only wastes time and
 * doubles the audit trail.
 *
 * The cost, stated plainly: for a POST a dropped response means the outcome is
 * UNKNOWN, so a request that did reach the API leaves a duplicate resource behind.
 * That is the same trade the orchestrator already takes on a resumed create step
 * ("create ops re-execute — accepted P1 risk: benign orphan resources", processor.ts)
 * — an inert duplicate manifest beats a dead 26-step job.
 *
 * THAT TRADE DOES NOT EXTEND TO A START, and the owner overruled it. The premise above
 * is the word INERT: a spare manifest costs nothing, so repeating its create is cheap
 * insurance. Anything that STARTS WORK breaks the premise — repeating it risks a second
 * billable run — and it broke in production. Four live encodings ran for up to 7h19m
 * with `live/start` issued twice, 249ms apart, against two encodings whose create
 * payloads were byte-identical. "The outcome is unknown" is a reason to go and LOOK,
 * not a reason to send it again; `startedDuringCrashWindow` is what looking looks like.
 *
 * So `isRetryable` refuses `/start` and `/live/start` for VOD and live alike, and the
 * rejection propagates. A visible error the orchestrator can resolve by reading status
 * is strictly cheaper than a second run nobody recorded. Everything else keeps the
 * retry, because the 26-step job that motivated it is a measured failure too and taking
 * the retry away from every create would trade it for an unmeasured one.
 *
 * The dedup that removes it
 * is the ledgered `customData` follow-up, not this file's job.
 */

/** Matches the SDK's `FetchAPI`: `(url: string, init?: any) => Promise<Response>`. */
export type SdkFetch = (url: string, init?: unknown) => Promise<Response>;

export type RetryingFetchOptions = {
	/** Total attempts, including the first. 1 disables retrying. */
	attempts?: number;
	/** Base backoff; attempt n waits `delayMs * 2^(n-1)`. */
	delayMs?: number;
	/** Injected for tests — the default is a real timer. */
	sleep?: (ms: number) => Promise<void>;
	/** Injected for tests; defaults to `console.warn`. */
	warn?: (message: string) => void;
	/** Injected for tests; defaults to global `fetch`. */
	fetchImpl?: SdkFetch;
};

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 250;

export function createRetryingFetch(
	options: RetryingFetchOptions = {},
): SdkFetch {
	const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
	const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
	const sleep =
		options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const doFetch =
		options.fetchImpl ?? ((url, init) => fetch(url, init as never));

	return async (url, init) => {
		let lastError: unknown;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				return await doFetch(url, init);
			} catch (err) {
				lastError = err;
				if (attempt === attempts) {
					break;
				}
				/**
				 * A START is never retried. The owner's call, and it is right.
				 *
				 * The trade this wrapper documents — a lost POST response leaves a duplicate
				 * resource — was accepted because a duplicate is inert. That premise holds for a
				 * spare manifest and fails completely for anything that STARTS WORK: repeating a
				 * start either double-starts the encoding or bills twice, and for live it did
				 * exactly that. Four live encodings ran for up to 7h19m, and the audit log shows
				 * `live/start` issued twice, 249ms apart, against two encodings.
				 *
				 * "The outcome is unknown" is a reason to go and LOOK, not a reason to send it
				 * again. The caller already has that pattern — `startedDuringCrashWindow` re-reads
				 * the status instead of trusting the call — and it is the only safe move here.
				 *
				 * So the rejection propagates untouched. That is a worse-looking failure and a
				 * cheaper one: a start that may or may not have landed becomes a visible error the
				 * orchestrator can resolve by reading status, rather than a second billable run
				 * nobody recorded.
				 */
				if (!isRetryable(url, init)) {
					break;
				}
				// Method and url only — an init body can carry a stream key or an
				// output path, and this line goes to the process log.
				const method =
					typeof init === "object" && init !== null && "method" in init
						? String((init as { method?: unknown }).method ?? "GET")
						: "GET";
				warn(
					`[sdk-fetch] ${method} ${url} failed at the transport layer ` +
						`(${errorSummary(err)}); retrying ${attempt}/${attempts - 1}`,
				);
				await sleep(delayMs * 2 ** (attempt - 1));
			}
		}
		throw lastError;
	};
}

/**
 * Whether repeating this request is safe when its outcome is unknown.
 *
 * Reads and idempotent verbs always are. A POST that STARTS something never is — repeating it
 * risks a second billable run, which is not a hypothetical: it happened, four times, for up to
 * 7h19m each.
 *
 * Deliberately a denylist of start endpoints rather than "no POST retries at all". The retry
 * exists because a real 26-step VOD job died on `POST /encoding/manifests/hls` with undici's
 * `Premature close` on an idle pooled socket, and a duplicate manifest genuinely is inert. Taking
 * the retry away from every create would trade a measured failure for an unmeasured one.
 */
export function isRetryable(url: string, init: unknown): boolean {
	const method = (
		typeof init === "object" && init !== null && "method" in init
			? String((init as { method?: unknown }).method ?? "GET")
			: "GET"
	).toUpperCase();
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
		return true;
	}
	// A verification marker means this POST can create a paid resource whose
	// exact identity must be reconciled by marker. Repeating it inside this
	// transport wrapper would happen before the adoption layer can observe the
	// unknown outcome and can therefore create an unledgered duplicate.
	if (method === "POST" && hasVerificationStamp(init)) {
		return false;
	}
	// `/start` (VOD), `/live/start` (live) — and with a query string or trailing slash, because a
	// path check that a URL shape can slip past is not a guard.
	const path = pathOf(url);
	// This PATCH mutates an active encoder through a durable effect claim.
	// A response lost after assignment must reach that claim as AMBIGUOUS,
	// never be sent again inside the transport layer (or logged with its key).
	if (/\/actions\/update-rtmp-ingest-points\/?$/.test(path)) return false;
	return !/\/(live\/)?start\/?$/.test(path);
}

function hasVerificationStamp(init: unknown): boolean {
	if (
		typeof init !== "object" ||
		init === null ||
		!("body" in init) ||
		typeof (init as { body?: unknown }).body !== "string"
	) {
		return false;
	}
	try {
		const body = JSON.parse((init as { body: string }).body) as {
			customData?: { bitovp?: { verification?: unknown } };
		};
		// Presence is enough for the conservative decision. A malformed marker
		// must not make a possibly-paid create retryable.
		return body.customData?.["bitovp"]?.verification !== undefined;
	} catch {
		return false;
	}
}

/** The path, with query and fragment removed; the raw string if it is not a URL. */
function pathOf(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return url.split("?")[0]?.split("#")[0] ?? url;
	}
}

/** A short cause for the log line. undici hides the real reason in `cause`. */
function errorSummary(err: unknown): string {
	if (!(err instanceof Error)) {
		return String(err);
	}
	const cause = (err as { cause?: unknown }).cause;
	const causeText =
		cause instanceof Error
			? `${(cause as { code?: string }).code ?? cause.name}: ${cause.message}`
			: cause === undefined
				? undefined
				: String(cause);
	return causeText ? `${err.message} — ${causeText}` : err.message;
}
