import { describe, expect, it, vi } from "vitest";
import {
	bearerToken,
	createTokenVerifier,
	hashToken,
	mintToken,
	TOKEN_CACHE_TTL_MS,
	tokenPrefixOf,
} from "./api-token";

/**
 *  (docs/API-USAGE.md): the verifier's whole contract — shape,
 * timing-safe mismatch, revoked/expired, the TTL cache HONORING a revocation
 * after expiry (the documented ≤60s latency), and the throttled touch.
 */

const ROW = (secret: string, over: Record<string, unknown> = {}) => ({
	id: "tok-1",
	tokenHash: hashToken(secret),
	role: "OPERATOR",
	revokedAt: null,
	expiresAt: null,
	...over,
});

describe("token shape helpers", () => {
	it("mints bo_ + 43 base64url chars and derives the 8-char prefix", () => {
		const { secret, prefix, tokenHash } = mintToken();
		expect(secret).toMatch(/^bo_[A-Za-z0-9_-]{43}$/);
		expect(prefix).toBe(secret.slice(3, 11));
		expect(tokenHash).toBe(hashToken(secret));
	});

	it("bearerToken extracts ONLY bo_ Bearer credentials", () => {
		expect(bearerToken("Bearer bo_abc")).toBe("bo_abc");
		// RFC 7235: scheme is case-insensitive (review-188 I3 — `bearer`
		// skipped the token path entirely, and under none-mode that let a
		// revoked token through unvalidated).
		expect(bearerToken("bearer bo_abc")).toBe("bo_abc");
		expect(bearerToken("BEARER bo_abc")).toBe("bo_abc");
		// A non-bo_ Bearer scheme is not ours and must not shadow sessions.
		expect(bearerToken("Bearer eyJhbGciOi...")).toBeNull();
		expect(bearerToken("Basic bo_abc")).toBeNull();
		expect(bearerToken(null)).toBeNull();
	});

	it("tokenPrefixOf refuses malformed shapes outright", () => {
		expect(tokenPrefixOf("bo_short")).toBeNull();
		expect(tokenPrefixOf(`nope_${"a".repeat(43)}`)).toBeNull();
		expect(tokenPrefixOf(mintToken().secret)).toHaveLength(8);
	});
});

describe("createTokenVerifier", () => {
	it("accepts a valid token and reports id + role", async () => {
		const { secret } = mintToken();
		const verify = createTokenVerifier({
			load: async () => ROW(secret),
		});
		expect(await verify(secret)).toEqual({
			ok: true,
			tokenId: "tok-1",
			role: "OPERATOR",
		});
	});

	it("rejects unknown / mismatch / revoked / expired, each by name", async () => {
		const { secret } = mintToken();
		const other = mintToken().secret;
		const now = Date.now();
		expect(
			await createTokenVerifier({ load: async () => null })(secret),
		).toEqual({ ok: false, reason: "unknown" });
		expect(
			await createTokenVerifier({ load: async () => ROW(other) })(secret),
		).toEqual({ ok: false, reason: "mismatch" });
		expect(
			await createTokenVerifier({
				load: async () => ROW(secret, { revokedAt: new Date(now) }),
			})(secret),
		).toEqual({ ok: false, reason: "revoked" });
		expect(
			await createTokenVerifier({
				load: async () => ROW(secret, { expiresAt: new Date(now - 1) }),
			})(secret),
		).toEqual({ ok: false, reason: "expired" });
		expect(
			await createTokenVerifier({ load: async () => null })("bo_nope"),
		).toEqual({ ok: false, reason: "malformed" });
	});

	it("caches by prefix — and a revocation is honored once the TTL expires", async () => {
		const { secret } = mintToken();
		let clock = 1_000_000;
		let revoked: Date | null = null;
		const load = vi.fn(async () => ROW(secret, { revokedAt: revoked }));
		const verify = createTokenVerifier({ load, now: () => clock });
		expect((await verify(secret)).ok).toBe(true);
		expect((await verify(secret)).ok).toBe(true);
		expect(load).toHaveBeenCalledTimes(1); // second hit served from cache
		// Revoke now: within the TTL the CACHE still answers valid — the
		// documented ≤60s latency, pinned as a property, not an accident.
		revoked = new Date(clock);
		clock += TOKEN_CACHE_TTL_MS - 1;
		expect((await verify(secret)).ok).toBe(true);
		// One ms past the TTL the loader re-runs and the revocation lands.
		clock += 2;
		const after = await verify(secret);
		expect(after).toEqual({ ok: false, reason: "revoked" });
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("caches UNKNOWN prefixes too — a bad-token flood is not a DB hit per request", async () => {
		const load = vi.fn(async () => null);
		const verify = createTokenVerifier({ load, now: () => 5_000_000 });
		const bogus = mintToken().secret;
		await verify(bogus);
		await verify(bogus);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("a DB fault is a STRUCTURED refusal, never a rejected promise (review-188 I1)", async () => {
		const load = vi.fn().mockRejectedValue(new Error("db down"));
		const verify = createTokenVerifier({ load, now: () => 3_000_000 });
		const { secret } = mintToken();
		await expect(verify(secret)).resolves.toEqual({
			ok: false,
			reason: "unavailable",
		});
		// NOT cached: the next request retries the DB.
		await verify(secret);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("a SYNC-throwing touch cannot fail a valid token (review-188 I1's nastier half)", async () => {
		const { secret } = mintToken();
		const verify = createTokenVerifier({
			load: async () => ROW(secret),
			touch: () => {
				throw new Error("getPrisma exploded");
			},
			now: () => 4_000_000,
		});
		await expect(verify(secret)).resolves.toEqual({
			ok: true,
			tokenId: "tok-1",
			role: "OPERATOR",
		});
	});

	it("a CORRUPT stored hash lands on mismatch, never a throw (review-188 N2)", async () => {
		// The length pre-check is load-bearing: without it timingSafeEqual
		// throws on unequal buffers (their M5 probe: 4 malformed cases -> 500).
		const { secret } = mintToken();
		for (const corrupt of ["", "g".repeat(64), "0".repeat(63)]) {
			const verify = createTokenVerifier({
				load: async () => ROW(secret, { tokenHash: corrupt }),
			});
			expect(await verify(secret)).toEqual({ ok: false, reason: "mismatch" });
		}
	});

	it("the sweep evicts STALE entries and spares FRESH ones (review-188 C1 — the first test was vacuous)", async () => {
		// The first version padSTARTed, so all 10k secrets shared their first
		// 8 chars, the cache held ONE key, and not a line of the sweep ever
		// ran — their MB1/MB2 (sweep emptied / call removed) survived 75/75.
		// padEnd gives genuinely distinct prefixes, and eviction has no
		// functional signature (their P11: a re-probe costs one load whether
		// swept or stale), so LIVENESS pins on the size accessor.
		let clock = 5_000_000;
		const load = vi.fn(async () => null);
		const verify = createTokenVerifier({ load, now: () => clock });
		const prefixOf = (i: number) => `bo_${String(i).padEnd(43, "x")}`;
		for (let i = 0; i < 10_000; i++) {
			await verify(prefixOf(i));
		}
		expect(verify.stats().cacheSize).toBe(10_000);
		// Age everything past the TTL; the next miss triggers ONE sweep.
		clock += TOKEN_CACHE_TTL_MS + 1;
		await verify(prefixOf(10_000));
		expect(verify.stats().cacheSize).toBe(1);
	});

	it("a sweep at the threshold spares FRESH entries (their P10 — the dangerous direction)", async () => {
		// Everything is younger than the TTL when the threshold is crossed:
		// the sweep must evict NOTHING (an eager evictor would turn the cache
		// into a self-inflicted load amplifier).
		const clock = 6_000_000;
		const load = vi.fn(async () => null);
		const verify = createTokenVerifier({ load, now: () => clock });
		const prefixOf = (i: number) => `bo_${String(i).padEnd(43, "y")}`;
		for (let i = 0; i < 10_001; i++) {
			await verify(prefixOf(i));
		}
		expect(verify.stats().cacheSize).toBe(10_001);
		// Re-probe of a fresh entry costs 0 extra loads.
		const before = load.mock.calls.length;
		await verify(prefixOf(0));
		expect(load.mock.calls.length).toBe(before);
	});

	it("the sweep is AMORTIZED to once per TTL (review-188 I4 — 102× CPU amplification per-miss)", async () => {
		// Size cannot discriminate this (with every entry fresh, an
		// unamortized sweep ALSO evicts nothing) — the sweepRuns counter can:
		// per-miss sweeping would run ~5k scans across the post-threshold
		// half of this burst; amortized runs exactly ONE, and exactly one
		// more after a TTL boundary.
		let clock = 7_000_000;
		const load = vi.fn(async () => null);
		const verify = createTokenVerifier({ load, now: () => clock });
		const prefixOf = (i: number) => `bo_${String(i).padEnd(43, "z")}`;
		for (let i = 0; i < 15_000; i++) {
			await verify(prefixOf(i));
		}
		// 5k misses ABOVE the threshold, one TTL window: one sweep, not 5k.
		expect(verify.stats().sweepRuns).toBe(1);
		clock += TOKEN_CACHE_TTL_MS + 1;
		await verify(prefixOf(20_000));
		expect(verify.stats().sweepRuns).toBe(2);
		// And that second sweep did the eviction work (liveness rides along).
		expect(verify.stats().cacheSize).toBe(1);
	});

	it("throttles the lastUsedAt touch to one per minute per token", async () => {
		const { secret } = mintToken();
		let clock = 2_000_000;
		const touch = vi.fn();
		const verify = createTokenVerifier({
			load: async () => ROW(secret),
			touch,
			now: () => clock,
		});
		await verify(secret);
		clock += 59_000;
		await verify(secret);
		expect(touch).toHaveBeenCalledTimes(1);
		clock += 2_000;
		await verify(secret);
		expect(touch).toHaveBeenCalledTimes(2);
	});
});
