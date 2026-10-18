import { randomBytes, timingSafeEqual } from "node:crypto";
import { hashApiTokenSecret } from "@bitovp/core";

/**
 * API-token verification . Pure logic +
 * an in-process TTL cache; the DB access is INJECTED so the proxy gate, the
 * routes and the tests share one implementation with different loaders.
 *
 * Token shape: `bo_` + 43 base64url chars (32 random bytes). The prefix
 * (first 8 chars after `bo_`) is the lookup key and is NOT secret; the
 * stored hash is SHA-256 hex (not scrypt — the secret is 256-bit random, a
 * KDF adds per-request latency without security), compared timing-safely.
 *
 * CACHE CONTRACT (documented property, ledgered): revocation/expiry latency
 * is bounded by the TTL (≤60s). A revoked row stays "valid" in a process
 * for at most TOKEN_CACHE_TTL_MS after the revoke lands — and the MIRROR
 * holds too: a token minted after its exact prefix was probed stays
 * "unknown" for ≤TTL in that process (review-188 N3; PR2's mint→paste flow
 * is where it could surface, as one puzzling 401 within a minute).
 *
 * What the cache bounds, honestly (review-188 I2): REPEATED probes of the
 * SAME prefix (a misconfigured client hammering one bad token). A flood of
 * DISTINCT prefixes is one DB point-read each — bounded by the sweep below
 * (house pattern from rate-limit.ts), not by the cache.
 */

export const TOKEN_PREFIX = "bo_";
export const TOKEN_CACHE_TTL_MS = 60_000;
const PREFIX_LENGTH = 8;
/** 32 random bytes → 43 base64url chars (no padding). */
const SECRET_LENGTH = 43;
const TOKEN_SHAPE = new RegExp(`^bo_[A-Za-z0-9_-]{${SECRET_LENGTH}}$`);

export type ApiTokenRow = {
	id: string;
	tokenHash: string;
	role: string;
	revokedAt: Date | null;
	expiresAt: Date | null;
};

export type TokenLoader = (prefix: string) => Promise<ApiTokenRow | null>;

export type TokenVerdict =
	| { ok: true; tokenId: string; role: string }
	| {
			ok: false;
			reason:
				| "malformed"
				| "unknown"
				| "mismatch"
				| "revoked"
				| "expired"
				| "unavailable";
	  };

/** Mints a new token: the caller stores hash+prefix and shows secret ONCE. */
export function mintToken(): {
	secret: string;
	prefix: string;
	tokenHash: string;
} {
	const secret = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
	return {
		secret,
		prefix: tokenPrefixOf(secret) ?? "",
		tokenHash: hashToken(secret),
	};
}

/**
 * Re-exported, not re-implemented (review of PR #345). The verification
 * harness looks a token UP by this column to attribute a run, so the rule has
 * two consumers in two apps; a second spelling would degrade that lookup to
 * "no match" the day either side changed, with nothing failing. `@bitovp/core`
 * owns the derivation and pins it to a vector; this name stays so no caller
 * here has to move.
 */
export const hashToken = hashApiTokenSecret;

/** The lookup key, or null when the shape is not even a token. */
export function tokenPrefixOf(secret: string): string | null {
	if (!TOKEN_SHAPE.test(secret)) {
		return null;
	}
	return secret.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + PREFIX_LENGTH);
}

/** Bearer header → candidate secret, or null when no token was PRESENTED. */
export function bearerToken(header: string | null): string | null {
	// RFC 7235 §2.1: the auth-scheme is case-insensitive — `bearer` must not
	// silently skip the token path (review-188 I3: under AUTH_MODE=none that
	// casing let a REVOKED token through unvalidated).
	if (!header || !/^bearer /i.test(header)) {
		return null;
	}
	const candidate = header.slice("Bearer ".length).trim();
	// Only bo_ tokens enter the token path — any other Bearer scheme is not
	// ours and must not shadow the session flow.
	return candidate.startsWith(TOKEN_PREFIX) ? candidate : null;
}

type CacheEntry = { row: ApiTokenRow | null; loadedAt: number };

export function createTokenVerifier(deps: {
	load: TokenLoader;
	/** Best-effort lastUsedAt write; throttled by the verifier (≤1/min). */
	touch?: (tokenId: string) => void;
	now?: () => number;
	ttlMs?: number;
}) {
	const now = deps.now ?? (() => Date.now());
	const ttl = deps.ttlMs ?? TOKEN_CACHE_TTL_MS;
	const cache = new Map<string, CacheEntry>();
	const lastTouched = new Map<string, number>();

	let lastSweptAt = 0;
	let sweepRuns = 0;
	let lastLoggedFault = "";
	let lastLoggedFaultAt = 0;

	/** rate-limit.ts's discipline: sweep expired entries when the map grows,
	    so an adversarial flood of distinct prefixes cannot grow it without
	    bound (review-188 I2 measured 500 permanent entries pre-sweep) —
	    AMORTIZED to once per TTL (review-188 I4: per-miss sweeping was O(n)
	    per request with n attacker-controlled, a measured 102× CPU
	    amplification while evicting nothing; per-TTL keeps the same memory
	    bound at O(n) per minute). */
	function sweep(at: number): void {
		if (cache.size < 10_000 || at - lastSweptAt < ttl) {
			return;
		}
		lastSweptAt = at;
		sweepRuns += 1;
		for (const [key, entry] of cache) {
			if (at - entry.loadedAt >= ttl) {
				cache.delete(key);
			}
		}
	}

	async function verifyToken(secret: string): Promise<TokenVerdict> {
		const prefix = tokenPrefixOf(secret);
		if (!prefix) {
			return { ok: false, reason: "malformed" };
		}
		const at = now();
		const cached = cache.get(prefix);
		let row: ApiTokenRow | null;
		if (cached && at - cached.loadedAt < ttl) {
			row = cached.row;
		} else {
			try {
				row = await deps.load(prefix);
			} catch (err) {
				// review-188 I1: a DB fault must be a STRUCTURED refusal, not a
				// rejected proxy promise surfacing as an opaque framework 500.
				// NOT cached — the next request retries the DB. Logged once per
				// distinct message (N10: silently swallowing it left the
				// operator unable to tell connection-refused from pool
				// exhaustion; proxy.ts's warnMisconfiguredOnce discipline).
				const message = err instanceof Error ? err.message : String(err);
				// Once per distinct message OR per TTL window (review-188 N11:
				// once-EVER suits static config, not a transient fault — a DB
				// that drops, recovers and drops again must log again).
				if (message !== lastLoggedFault || at - lastLoggedFaultAt >= ttl) {
					lastLoggedFault = message;
					lastLoggedFaultAt = at;
					console.error(`[api-token] verification unavailable: ${message}`);
				}
				return { ok: false, reason: "unavailable" };
			}
			sweep(at);
			cache.set(prefix, { row, loadedAt: at });
			// Unknown prefixes are cached too — this bounds REPEATED probes of
			// one prefix; the sweep bounds distinct-prefix floods (I2).
		}
		if (!row) {
			return { ok: false, reason: "unknown" };
		}
		const candidate = Buffer.from(hashToken(secret), "hex");
		const stored = Buffer.from(row.tokenHash, "hex");
		if (
			candidate.length !== stored.length ||
			!timingSafeEqual(candidate, stored)
		) {
			return { ok: false, reason: "mismatch" };
		}
		if (row.revokedAt !== null) {
			return { ok: false, reason: "revoked" };
		}
		if (row.expiresAt !== null && row.expiresAt.getTime() <= at) {
			return { ok: false, reason: "expired" };
		}
		const touched = lastTouched.get(row.id) ?? 0;
		if (deps.touch && at - touched >= 60_000) {
			lastTouched.set(row.id, at);
			try {
				deps.touch(row.id);
			} catch {
				// review-188 I1's nastier half: a SYNC throw from touch (e.g.
				// getPrisma's env loading) was rejecting an otherwise-VALID
				// token — intermittently, at most once per minute per token,
				// the worst diagnostic signature. Observability must never
				// fail a request.
			}
		}
		return { ok: true, tokenId: row.id, role: row.role };
	}
	// Eviction has NO functional signature (review-188 P11: a re-probe costs
	// one load whether the entry was swept or merely stale), and with every
	// entry fresh an unamortized sweep ALSO evicts nothing — size alone
	// cannot discriminate either property. The stats accessor is what makes
	// liveness AND amortization pinnable at all.
	verifyToken.stats = () => ({ cacheSize: cache.size, sweepRuns });
	return verifyToken;
}
