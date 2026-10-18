/**
 * Per-process fixed-window limiter for public ingress routes. Honest
 * caveats: state is per Node process (not shared across replicas) and
 * resets on restart — adequate as a DoS speed bump for the single-instance
 * P0 deployment; replace with Redis when the app scales out.
 *
 * What it is NOT: an authorization control, and not a per-account quota. It
 * bounds the RATE of a primitive; `MAX_BULK_IDS` bounds one request's size.
 * The two are independent — 50 ids per request says nothing about how many
 * requests per minute a `curl` loop can send.
 */
import { ACTOR_HEADER } from "@/lib/auth/api-token-gate";
export function createFixedWindowLimiter(options: {
	limit: number;
	windowMs: number;
}) {
	const windows = new Map<string, { count: number; resetAt: number }>();

	function sweep(now: number) {
		if (windows.size < 10_000) {
			return;
		}
		for (const [key, value] of windows) {
			if (now >= value.resetAt) {
				windows.delete(key);
			}
		}
	}

	return {
		/** Returns false when the key exceeded the window's budget. */
		check(key: string, now: number = Date.now()): boolean {
			sweep(now);
			const window = windows.get(key);
			if (!window || now >= window.resetAt) {
				windows.set(key, { count: 1, resetAt: now + options.windowMs });
				return true;
			}
			window.count++;
			return window.count <= options.limit;
		},
	};
}

/**
 * Token bucket for login attempts: `capacity` tries available immediately,
 * refilled continuously at `refillPerMinute`, so a burst is absorbed and a
 * sustained guessing loop is throttled to the refill rate.
 *
 * Same honest caveats as the limiter above: state is per Node process and
 * resets on restart, and the key is a client IP the app cannot verify unless a
 * trusted reverse proxy sets X-Forwarded-For. It is a brute-force speed bump,
 * not an account lockout.
 */
export function createTokenBucketLimiter(options: {
	capacity: number;
	refillPerMinute: number;
}) {
	const buckets = new Map<string, { tokens: number; updatedAt: number }>();
	const refillPerMs = options.refillPerMinute / 60_000;
	const fullAfterMs = options.capacity / refillPerMs;

	function sweep(now: number) {
		if (buckets.size < 10_000) {
			return;
		}
		for (const [key, bucket] of buckets) {
			if (now - bucket.updatedAt >= fullAfterMs) {
				buckets.delete(key);
			}
		}
	}

	return {
		/**
		 * Is a token available, WITHOUT consuming one?
		 *
		 * Needed because a budget charged only after the work it accounts for
		 * cannot limit that work — it only relabels the response. `take` after
		 * verification turns 401 into 429 while every guess still runs; `peek`
		 * before it is what actually stops one (review catch: 188 guesses/sec
		 * measured through a budget nominally set to 40/min).
		 *
		 * Deliberately does not refill-on-read beyond what `take` would compute, so
		 * peek and take agree about the same instant.
		 */
		peek(key: string, now: number = Date.now()): boolean {
			const bucket = buckets.get(key);
			if (!bucket) {
				return options.capacity >= 1;
			}
			const refilled = Math.min(
				options.capacity,
				bucket.tokens + Math.max(0, now - bucket.updatedAt) * refillPerMs,
			);
			return refilled >= 1;
		},

		/** Consumes one token; false when the bucket is empty. */
		take(key: string, now: number = Date.now()): boolean {
			sweep(now);
			const bucket = buckets.get(key);
			if (!bucket) {
				buckets.set(key, { tokens: options.capacity - 1, updatedAt: now });
				return true;
			}
			const refilled = Math.min(
				options.capacity,
				bucket.tokens + Math.max(0, now - bucket.updatedAt) * refillPerMs,
			);
			bucket.updatedAt = now;
			if (refilled < 1) {
				bucket.tokens = refilled;
				return false;
			}
			bucket.tokens = refilled - 1;
			return true;
		},
	};
}

/**
 * `TRUSTED_PROXY_HOPS`: how many proxies append to `x-forwarded-for` in front of
 * this app. 0 or unset means the header is not trusted at all.
 *
 * The header is NOT self-describing, and the comment this replaces had the rule
 * backwards: Next does `req.headers['x-forwarded-for'] ??= socket.remoteAddress`,
 * so a CLIENT-SUPPLIED header wins and "with no proxy every caller shares the
 * direct bucket" was false — any caller could mint a fresh bucket per request by
 * varying the header. That is not "throttles more, never less"; it is no throttle
 * at all. Found on the login path, where it meant unlimited password guesses;
 * these routes sit behind the auth gate, so the same bypass only costs an
 * ALREADY-AUTHENTICATED caller their rate limit — lower severity, identical bug.
 *
 * With `n >= 1` the n-th entry from the RIGHT was written by the outermost
 * trusted proxy and a client cannot forge past it.
 */
let warnedHops: string | undefined;

function trustedHops(): number {
	const configured = process.env.TRUSTED_PROXY_HOPS;
	const raw = Number(configured);
	if (Number.isSafeInteger(raw) && raw > 0) {
		return raw;
	}
	// Fail closed, but say so ONCE. `TRUSTED_PROXY_HOPS=true` or a stray quote
	// silently bought install-wide throttling with no diagnostic, and since the
	// key now collapses to one bucket that has a user-visible cost — an operator
	// seeing shared 429s had nothing pointing at the typo (review catch).
	// "0" and "" are the documented ways to switch this off, so they stay quiet.
	if (configured && configured !== "0" && warnedHops !== configured) {
		warnedHops = configured;
		console.warn(
			`[rate-limit] TRUSTED_PROXY_HOPS=${JSON.stringify(configured)} is not a positive integer — the x-forwarded-for header will NOT be trusted and every caller shares one bucket`,
		);
	}
	return 0;
}

/** Test seam: the once-per-value warning above is module state. */
export function resetTrustedHopsWarning(): void {
	warnedHops = undefined;
}

/**
 * `Number` is permissive here and that is fine, but only because of WHICH way
 * it fails. Measured: `"1e2"` → 100, `"0x2"` → 2, `"+3"` → 3, `"1.0"` → 1,
 * leading/trailing whitespace tolerated; `"1_0"`, `"1,2"`, `"Infinity"`,
 * `"1e21"`, `2**53+1` and anything non-numeric → 0.
 *
 * Every one of those outcomes is CONSERVATIVE **relative to the declared depth**.
 * Zero yields one shared bucket explicitly. A value smaller than intended reads an
 * entry an inner proxy wrote — a constant, so again one shared bucket. And a value
 * larger than the chain is long yields `"untrusted"`. So it is deliberately not
 * tightened to a strict integer regex: strictness would buy nothing, and a
 * rejected-but-valid-looking value (`" 1"` copied out of a .env line) silently
 * dropping to 0 is worse.
 *
 * **What is NOT safe, and no parsing rule can make safe: declaring more hops than
 * actually exist.** The number is an assertion about the deployment, and if it is
 * too high the extra depth is filled by whatever the CLIENT sent. Measured with
 * one real proxy and `TRUSTED_PROXY_HOPS=2`: a client sending
 * `x-forwarded-for: evil` gets the key `evil`, a fresh one per request — exactly
 * the forgery this derivation replaced. At `5` the client pads four entries and
 * does the same.
 *
 * This is inherent to `x-forwarded-for` rather than a defect here: any scheme that
 * counts from the right trusts however many hops it is told to. It is called out
 * because "set TRUSTED_PROXY_HOPS to get per-client accounting" reads like a knob
 * where more is safer, and the opposite is true — too LOW over-throttles, too HIGH
 * disables the limiter. Pinned by tests in both directions.
 */

/**
 * Limiter bucket for a request. Shared by every rate-limited route — the four bulk
 * ops, storage inspections, the login route, the Bitmovin webhook receiver AND
 * both playback-cors routes  — so there is exactly one answer to
 * "who is this caller".
 *
 * That list is exhaustive as of the review that made it so — and it went stale
 * ONCE already: review-181 C1 caught the playback-cors pair landing their
 * limiter without this sentence, exactly the failure the next paragraph
 * predicts. The first version of
 * this comment claimed "every rate-limited route" while the WEBHOOK route still
 * read the leftmost `x-forwarded-for` hop, which is the one place it mattered most:
 * `/api/webhooks` is among the three paths the auth gate deliberately exempts, so
 * that bypass was reachable with no credentials. If you add a limiter, add it here
 * or this sentence becomes false again — `grep -rn "x-forwarded-for" apps/web/src`
 * outside this file should return only comments.
 *
 * Returns `"untrusted"` — one shared bucket — when there is no trustworthy
 * client identity. That genuinely does throttle more rather than less: a flood
 * spends a budget the honest caller also draws on, which for these routes is a
 * degraded-service trade rather than a bypass. Set `TRUSTED_PROXY_HOPS` to get
 * per-client accounting.
 */
export function clientKey(req: Request): string {
	// API tokens FIRST : the proxy-verified actor header is
	// unforgeable — and the mechanism is `forward`'s POSITIVE override on
	// every continuing path in authGate, not a stripping step before the gate,
	// which is the pre-review-189 story this comment used to tell and which
	// the repo measured as a no-op. The effect is the same and stronger: the
	// value is always ours. So
	// a token-authenticated caller gets ITS OWN bucket regardless of
	// TRUSTED_PROXY_HOPS — closing #33's "everything shares one install-wide
	// bucket" subcase for machine clients. Unauthenticated/bad-token traffic
	// never reaches a route (the proxy 401s it), so this cannot be minted as
	// a fresh-bucket-per-request bypass: the header only exists after a
	// successful verification.
	// ACTOR_HEADER, not the literal: renaming the constant would silently
	// collapse every token client into `trustedHops`'s install-wide
	// "untrusted" bucket at the default TRUSTED_PROXY_HOPS=0 — re-opening the
	// exact #33 subcase this block closes, with nothing going red
	// (security-review-212).
	const actor = req.headers.get(ACTOR_HEADER);
	if (actor?.startsWith("token:")) {
		return actor;
	}
	const hops = trustedHops();
	if (hops === 0) {
		return "untrusted";
	}
	const chain = req.headers
		.get("x-forwarded-for")
		?.split(",")
		.map((hop) => hop.trim())
		.filter((hop) => hop !== "");
	return chain?.[chain.length - hops] ?? "untrusted";
}
