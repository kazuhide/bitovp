import { getIdentityPrisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { loadAuthConfig } from "@/lib/auth/config";
import { resolveProvider } from "@/lib/auth/provider";
import {
	cookieMaxAgeSeconds,
	issuedAtAfterCutoff,
	issueSession,
	requestIsHttps,
	sessionCookieName,
	sessionCookieOptions,
	signSession,
} from "@/lib/auth/session";
import { DEFAULT_ORGANIZATION_ID, listOrganizations } from "@/lib/auth/tenancy";
import {
	accountBackoffRemainingMs,
	chargeAccountFailure,
	clearAccountFailures,
	invalidateUserCache,
} from "@/lib/auth/users";
import { customerErrorDetails } from "@/lib/customer-error";
import { jsonError, readJson } from "@/lib/server/http";
import { clientKey, createTokenBucketLimiter } from "@/lib/server/rate-limit";

/**
 * RATE LIMITING, redesigned after a review demonstrated that the previous
 * arrangement was a permanent login lockout rather than a guess cap.
 *
 * The two goals pull against each other:
 *   A. cap total password GUESSES, even from a caller rotating its identity
 *   B. the operator must always be able to sign in
 *
 * The old code consumed a global token on ARRIVAL, before the body was parsed
 * and before scrypt ran — so `{}` at 40 req/min (0.67 req/s, one curl loop) held
 * the bucket empty forever and locked every operator out, on a platform where
 * "cannot sign in" means cannot stop a runaway billable pool or intervene in a
 * live event. Refill exactly equalled the rate needed to hold it, so the "locked
 * out for a minute" I claimed was "locked out for as long as the attacker
 * bothers".
 *
 * What separates the two goals is WHEN accounting happens. A junk body is not a
 * guess, and a CORRECT password is not an attack:
 *
 *   1. `verifyBudget` — consumed on arrival, generous. Its only job is to bound
 *      scrypt CPU (~19 ms/attempt), not to stop guessing. At 600/min an attacker
 *      can keep it near-empty, but it refills at 10/s, so the operator waits
 *      milliseconds, never minutes.
 *   2. `failureBudget` and the per-IP bucket — consumed ONLY on a failed
 *      verification. Junk bodies never touch them, so they cannot be drained for
 *      free, and a correct password is never refused by them. That makes goal B
 *      absolute rather than probabilistic.
 *
 * Residual, recorded in STATUS #33: an attacker can still burn scrypt CPU inside
 * the verify budget, and all of this is per-process.
 */
/**
 * A CONCURRENCY gate, not a rate limit — this is the third shape this control has
 * had and the reason is worth writing down.
 *
 * v1 charged a global RATE bucket on arrival: `{}` at 40 req/min held it empty
 * and the operator with the CORRECT password got 429 forever.
 * v2 raised the same bucket to 600/min, which only moved the threshold: measured
 * against the real limiter, 11 rps refused the operator 72% of attempts and
 * 50 rps refused 95%, indefinitely. My comment claimed "the operator waits
 * milliseconds, never minutes"; that was false, and raising the ceiling also
 * multiplied the scrypt DoS ~15x (review catch, both demonstrated).
 *
 * A rate cap on the arrival path can always refuse the operator, because it
 * cannot know a request is the operator until after verification. A concurrency
 * cap mostly costs LATENCY instead — but "cannot refuse" was too strong and a
 * reviewer measured it: above roughly service capacity (~180 verifications/s)
 * the queue fills and the operator sees 503s, 40% at 300 rps and 55% at 1000.
 * The difference from the arrival budgets is that this refusal is a bounded
 * tail-drop that clears on retry (measured: signed in on attempt 1 or 2 under a
 * 1000 rps flood), where an emptied bucket stayed empty for as long as the
 * attacker cared to hold it. Combined with scrypt moving off the event loop, a
 * burst queues instead of freezing the process.
 *
 * The bounded queue is the honest limit: past it we answer 503 (transient, clears
 * in milliseconds) rather than growing memory without limit.
 *
 * Guess-capping is not this control's job — that is the budgets below. But note
 * what they are and are not: charged only on a FAILED verification, and CHECKED
 * (without charging) before one. Charging alone limits nothing; a reviewer
 * measured 188 guesses/sec through a budget nominally set to 40/min, because
 * draining it only turned 401 into 429 while every guess still ran scrypt.
 * Checking is what stops the guess; charging only on failure is what keeps junk
 * from draining the check.
 */
const MAX_CONCURRENT_VERIFICATIONS = 4;
const MAX_QUEUED_VERIFICATIONS = 64;
let inFlight = 0;
/** Waiters in ARRIVAL order — see below for why the order matters. */
const waiters: Array<() => void> = [];

/**
 * FIFO hand-off, not a poll-and-race. The first version woke every waiter every
 * 5 ms to compete for a freed slot, so a newly-arrived request could take the
 * slot a long-waiting one had been queued for: no fairness, no bound. Measured
 * at 100 rps — a load where nothing should be refused — waits reached 4.6 s
 * against a 768 ms FIFO bound, 6x over, and that starvation is what produced
 * ~12 s operator latencies under flood (review catch, with the fix demonstrated:
 * p95 717 ms, max 768 ms, hard-bounded).
 *
 * Handing the freed slot to the OLDEST waiter also drops 64 timers × 200
 * wakeups/s of churn.
 *
 * `UV_THREADPOOL_SIZE` interacts with the concurrency number: scrypt runs on
 * libuv's threadpool (default 4), so 4 in flight occupies ALL of it and starves
 * co-tenants — `fs` for Next's own reads, `dns.lookup` for every outbound
 * connection to Bitmovin/Postgres/Redis. Measured: at pool 4 a co-tenant
 * `fs.readFile` sits at p50 17 ms; at pool 8, 0.2 ms for identical verification
 * throughput. Raise the pool rather than this number if you touch either.
 */
async function withVerificationSlot<T>(
	run: () => Promise<T>,
): Promise<T | "busy"> {
	if (inFlight >= MAX_CONCURRENT_VERIFICATIONS) {
		if (waiters.length >= MAX_QUEUED_VERIFICATIONS) {
			return "busy";
		}
		await new Promise<void>((resolve) => {
			waiters.push(resolve);
		});
	}
	inFlight += 1;
	try {
		return await run();
	} finally {
		inFlight -= 1;
		waiters.shift()?.();
	}
}

const failureBudget = createTokenBucketLimiter({
	capacity: 40,
	refillPerMinute: 40,
});
/** 8 immediate failures per client key, then one every 15s. */
const perKeyFailures = createTokenBucketLimiter({
	capacity: 8,
	refillPerMinute: 4,
});

/** Long enough for a passphrase, short enough that scrypt is never a DoS lever. */
const bodySchema = z.object({
	password: z.string().min(1).max(512),
	/** users mode (#32): which account the password claims. */
	email: z.string().min(3).max(320).optional(),
});

/** The body is one short string; anything larger is not a sign-in attempt. */
const MAX_LOGIN_BODY_BYTES = 4 * 1024;

export async function POST(req: Request) {
	const ip = clientKey(req);

	const config = loadAuthConfig();
	if (!config.ok) {
		return jsonError(
			503,
			"Authentication is not configured",
			customerErrorDetails("AUTH_NOT_CONFIGURED"),
		);
	}
	const { settings } = config;
	const provider = resolveProvider(settings);
	const readiness = provider.readiness();
	if (!readiness.ready) {
		return jsonError(
			503,
			"Authentication provider is unavailable",
			customerErrorDetails("AUTH_PROVIDER_UNAVAILABLE"),
		);
	}
	if (settings.mode !== "password" && settings.mode !== "users") {
		const rejected = await provider.verify({});
		return rejected.ok
			? jsonError(
					500,
					"Unsupported auth mode",
					customerErrorDetails("AUTH_MODE_UNSUPPORTED"),
				)
			: jsonError(
					rejected.status,
					rejected.error,
					customerErrorDetails("AUTH_MODE_UNSUPPORTED"),
				);
	}

	// Mirrors the webhook route's guard: App Router handlers have no default body
	// limit, and this is the other unauthenticated endpoint. Measured as
	// bandwidth-bound rather than amplifying (~70 ms for 100 MB, no event-loop
	// stall), so this is consistency, not urgency.
	if (Number(req.headers.get("content-length") ?? 0) > MAX_LOGIN_BODY_BYTES) {
		return jsonError(413, "Request body is too large");
	}
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return jsonError(
			400,
			"Password is required",
			customerErrorDetails("AUTH_PASSWORD_REQUIRED"),
		);
	}
	const email = parsed.data.email;
	if (settings.mode === "users" && !email) {
		return jsonError(
			400,
			"Email is required",
			customerErrorDetails("AUTH_EMAIL_REQUIRED"),
		);
	}
	// The per-ACCOUNT backoff is deliberately NOT checked here (review-32
	// B1): an arrival check refuses the CORRECT password too, which turns
	// the backoff into an unauthenticated lockout lever against any known
	// account — the third control on this route to be placed at arrival and
	// the third to become exactly that. This file's own lesson stands: we
	// cannot know a request is the operator until after verification. The
	// backoff acts on the FAILURE arm below.
	// CHECK the guess budgets before spending a verification on this request.
	// `peek` does not consume, so a junk body — which never reaches here — cannot
	// drain them, and a caller not already in penalty is never refused. Without
	// this the budgets were pure telemetry: the log filled with failures and
	// clients got "too many attempts" while every guess was still being tested.
	//
	// The honest cost, and it is a real trade rather than a free win: with
	// `TRUSTED_PROXY_HOPS` unset the per-key bucket collapses to one global
	// bucket, so during a sustained flood the operator's own attempt can be
	// refused too. That is RECOVERABLE — the bucket refills continuously, so a
	// retry gets through in seconds — where the earlier arrival-budget versions
	// were not, because nothing drained faster than the attacker refilled it.
	// Guessing the ONE shared password is total compromise of every Bitmovin key
	// and storage credential this app holds; a sign-in that needs a retry during
	// an active attack is not. Set TRUSTED_PROXY_HOPS for per-client accounting
	// and this stops being global at all.
	if (!failureBudget.peek("all") || !perKeyFailures.peek(ip)) {
		return jsonError(
			429,
			"Too many failed sign-in attempts — wait and retry",
			customerErrorDetails("AUTH_RATE_LIMITED"),
		);
	}

	// Verification runs inside the concurrency gate, AFTER the body parsed — so a
	// junk body costs nothing beyond parsing it, which is what made every earlier
	// version of this control drainable for free.
	const gated = await withVerificationSlot(() =>
		provider.verify({ password: parsed.data.password, email }),
	);
	if (gated === "busy") {
		// Distinct wording from the "Authentication is not configured" 503 on this
		// same route, and a Retry-After so a client can back off rather than spin.
		return NextResponse.json(
			{
				error: "Sign-in is busy — too many attempts in flight, retry shortly",
				details: customerErrorDetails("AUTH_BUSY"),
			},
			{ status: 503, headers: { "retry-after": "2" } },
		);
	}
	const result = gated;
	if (!result.ok) {
		// Accounting happens HERE, on a failure, so a correct password can never be
		// refused by a budget an attacker drained.
		const withinBudget = failureBudget.take("all") && perKeyFailures.take(ip);
		let accountWaitMs = 0;
		if (settings.mode === "users" && email && result.status === 401) {
			// The per-account ledger too — 400s (missing fields) are not guesses.
			chargeAccountFailure(email);
			accountWaitMs = accountBackoffRemainingMs(email);
		}
		// No password material in the log line, and the submitted EMAIL never
		// joins it either (#32 §7 — it would land in unrotated stdout). The key
		// is attacker-controlled text unless TRUSTED_PROXY_HOPS is set — do not
		// build alerting on it (review note).
		console.warn(`[auth] failed sign-in from ${ip}`);
		if (accountWaitMs > 0) {
			// In-window FAILURES read 429 with the wait; a correct password
			// never sees this arm (it took the success path above the charge).
			return NextResponse.json(
				{
					error:
						"Too many failed sign-in attempts for this account — wait and retry",
					details: customerErrorDetails("AUTH_RATE_LIMITED"),
				},
				{
					status: 429,
					headers: { "retry-after": String(Math.ceil(accountWaitMs / 1000)) },
				},
			);
		}
		if (!withinBudget) {
			return jsonError(
				429,
				"Too many failed sign-in attempts — wait and retry",
				customerErrorDetails("AUTH_RATE_LIMITED"),
			);
		}
		const code = result.passwordExpired
			? "AUTH_PASSWORD_EXPIRED"
			: result.error === "Email is required"
				? "AUTH_EMAIL_REQUIRED"
				: result.error === "Password is required"
					? "AUTH_PASSWORD_REQUIRED"
					: "AUTH_INVALID_CREDENTIALS";
		return jsonError(result.status, result.error, customerErrorDetails(code));
	}

	const now = Date.now();
	if (settings.mode === "users" && email) {
		clearAccountFailures(email);
	}
	if (settings.mode === "users" && result.user) {
		const userId = result.user.id;
		const verifiedCredential = result.verifiedCredential;
		if (!verifiedCredential) {
			return jsonError(
				500,
				"Sign-in verification did not return a credential generation",
			);
		}
		// This conditional write is the login's linearization point. Async scrypt
		// verified a snapshot; an admin reset may commit while it runs. Matching
		// BOTH the monotonic generation and the exact hash prevents a stale proof
		// from being promoted into a fresh cookie. A second read alone would still
		// leave a reset race between that read and minting; the signed generation
		// below plus the proxy equality check closes that later edge too.
		const claimed = await getIdentityPrisma().user.updateMany({
			where: {
				id: userId,
				active: true,
				sessionGeneration: verifiedCredential.sessionGeneration,
				passwordHash: verifiedCredential.passwordHash,
			},
			data: { lastLoginAt: new Date(now) },
		});
		if (claimed.count !== 1) {
			return jsonError(
				409,
				"Credentials changed while sign-in was being verified — retry with the current password",
				customerErrorDetails("AUTH_CREDENTIALS_CHANGED"),
			);
		}
		// Fresh resolver view at next gate pass.
		invalidateUserCache(userId);
	}
	const issuedAt =
		settings.mode === "users" && result.user
			? issuedAtAfterCutoff(now, result.user.sessionsValidFromMs)
			: now;
	const organizations =
		settings.mode === "users" && result.user
			? await listOrganizations(result.user.id)
			: [];
	const payload = issueSession({
		mode: settings.mode,
		now: issuedAt,
		idleMs: settings.idleMs,
		maxMs: settings.maxMs,
		...(settings.mode === "users" && result.user
			? {
					sub: result.user.id,
					organizationId: organizations[0]?.id ?? DEFAULT_ORGANIZATION_ID,
					sessionGeneration: result.user.sessionGeneration,
				}
			: {}),
	});
	const https = requestIsHttps(req.headers, req.url);
	const res = NextResponse.json({
		ok: true,
		mode: settings.mode,
		expiresAt: new Date(payload.exp).toISOString(),
		absoluteExpiresAt: new Date(payload.abs).toISOString(),
		...(settings.mode === "users" && result.user
			? { mustChangePassword: result.user.mustChangePassword }
			: {}),
	});
	res.cookies.set(
		sessionCookieName(https),
		signSession(payload, settings.sessionSecret),
		sessionCookieOptions(https, cookieMaxAgeSeconds(payload, now)),
	);
	return res;
}
