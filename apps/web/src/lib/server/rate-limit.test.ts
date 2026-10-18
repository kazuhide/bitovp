import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clientKey,
	createFixedWindowLimiter,
	createTokenBucketLimiter,
	resetTrustedHopsWarning,
} from "./rate-limit";

describe("createFixedWindowLimiter", () => {
	it("allows up to the limit per window, then rejects", () => {
		const limiter = createFixedWindowLimiter({ limit: 3, windowMs: 1000 });
		expect(limiter.check("ip", 0)).toBe(true);
		expect(limiter.check("ip", 10)).toBe(true);
		expect(limiter.check("ip", 20)).toBe(true);
		expect(limiter.check("ip", 30)).toBe(false);
	});

	it("resets after the window elapses", () => {
		const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 1000 });
		expect(limiter.check("ip", 0)).toBe(true);
		expect(limiter.check("ip", 500)).toBe(false);
		expect(limiter.check("ip", 1001)).toBe(true);
	});

	it("tracks keys independently", () => {
		const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 1000 });
		expect(limiter.check("a", 0)).toBe(true);
		expect(limiter.check("b", 0)).toBe(true);
		expect(limiter.check("a", 1)).toBe(false);
	});
});

describe("createTokenBucketLimiter", () => {
	it("allows a burst up to capacity, then trips", () => {
		const limiter = createTokenBucketLimiter({
			capacity: 3,
			refillPerMinute: 60,
		});
		expect(limiter.take("ip", 0)).toBe(true);
		expect(limiter.take("ip", 0)).toBe(true);
		expect(limiter.take("ip", 0)).toBe(true);
		expect(limiter.take("ip", 0)).toBe(false);
	});

	it("recovers one attempt per refill interval", () => {
		// 4/min → one token every 15s.
		const limiter = createTokenBucketLimiter({
			capacity: 2,
			refillPerMinute: 4,
		});
		expect(limiter.take("ip", 0)).toBe(true);
		expect(limiter.take("ip", 0)).toBe(true);
		expect(limiter.take("ip", 0)).toBe(false);
		expect(limiter.take("ip", 14_999)).toBe(false);
		expect(limiter.take("ip", 15_001)).toBe(true);
		expect(limiter.take("ip", 15_002)).toBe(false);
	});

	it("never refills past capacity", () => {
		const limiter = createTokenBucketLimiter({
			capacity: 2,
			refillPerMinute: 60,
		});
		expect(limiter.take("ip", 0)).toBe(true);
		// An hour of idling must not bank an hour of attempts.
		expect(limiter.take("ip", 3_600_000)).toBe(true);
		expect(limiter.take("ip", 3_600_000)).toBe(true);
		expect(limiter.take("ip", 3_600_000)).toBe(false);
	});

	it("tracks keys independently", () => {
		const limiter = createTokenBucketLimiter({
			capacity: 1,
			refillPerMinute: 1,
		});
		expect(limiter.take("a", 0)).toBe(true);
		expect(limiter.take("b", 0)).toBe(true);
		expect(limiter.take("a", 0)).toBe(false);
	});

	it("is monotonic under a clock that jumps backwards", () => {
		const limiter = createTokenBucketLimiter({
			capacity: 1,
			refillPerMinute: 60,
		});
		expect(limiter.take("ip", 10_000)).toBe(true);
		expect(limiter.take("ip", 0)).toBe(false);
	});
});

/**
 * There was no test here at all, on four rate-limited routes, and that is how a
 * client-forgeable limiter key shipped: `clientKey` read the FIRST
 * `x-forwarded-for` hop, and its comment claimed that with no proxy every caller
 * shares one bucket. Next fills the header from the socket only when it is
 * ABSENT (`??=`), so a supplied value wins — varying it minted a fresh bucket per
 * request and the limit was unenforceable. The same derivation on the login route
 * meant unlimited password guesses.
 */
describe("clientKey", () => {
	function req(xff?: string): Request {
		return new Request("http://test/api/x", {
			headers: xff === undefined ? {} : { "x-forwarded-for": xff },
		});
	}

	it("ignores the header entirely when no proxy is declared", () => {
		expect(clientKey(req("1.2.3.4"))).toBe("untrusted");
		expect(clientKey(req())).toBe("untrusted");
	});

	it("a token actor gets ITS OWN bucket, hops or no hops (ledger #81 PR3)", () => {
		// The header is proxy-verified (client copies stripped before the
		// gate), so per-token accounting is safe without TRUSTED_PROXY_HOPS —
		// #33's install-wide-bucket subcase closes for machine clients.
		const tokenReq = new Request("http://test/api/x", {
			headers: { "x-bitovp-actor": "token:tok-1" },
		});
		expect(clientKey(tokenReq)).toBe("token:tok-1");
		const other = new Request("http://test/api/x", {
			headers: { "x-bitovp-actor": "token:tok-2" },
		});
		expect(clientKey(other)).toBe("token:tok-2");
	});

	it("the token bucket WINS over an XFF chain when TRUSTED_PROXY_HOPS is set (review-81b I6)", () => {
		// The test above only exercised hops === 0 while its NAME claimed
		// "hops or no hops" — the reviewer's mutation (XFF wins at hops ≥ 1)
		// survived 32/32. Production is exactly the hops-set configuration,
		// where a regression re-collapses every token behind one proxy
		// egress IP into a shared bucket — the #33 subcase this closes.
		vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
		try {
			const tokenBehindProxy = new Request("http://test/api/x", {
				headers: {
					"x-bitovp-actor": "token:tok-1",
					"x-forwarded-for": "9.9.9.9, 10.0.0.1",
				},
			});
			expect(clientKey(tokenBehindProxy)).toBe("token:tok-1");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("a NON-token actor value never becomes a key (sessions keep IP accounting)", () => {
		const sessionReq = new Request("http://test/api/x", {
			headers: { "x-bitovp-actor": "session" },
		});
		expect(clientKey(sessionReq)).toBe("untrusted");
	});

	it("cannot be varied by the client when no proxy is declared", () => {
		// The bypass, as a test: 100 different headers, one bucket.
		const keys = new Set(
			Array.from({ length: 100 }, (_, i) => clientKey(req(`10.0.0.${i}`))),
		);
		expect(keys.size).toBe(1);
	});

	describe("with TRUSTED_PROXY_HOPS=1", () => {
		beforeEach(() => {
			vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
		});
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it("takes the LAST hop — the one the trusted proxy wrote", () => {
			expect(clientKey(req("9.9.9.9, 1.2.3.4"))).toBe("1.2.3.4");
		});

		it("is not forgeable by prepending hops", () => {
			// The client controls everything left of what the proxy appended.
			const forged = clientKey(req("evil-1, evil-2, evil-3, 1.2.3.4"));
			expect(forged).toBe("1.2.3.4");
		});

		it("falls back to one bucket when the header is missing or blank", () => {
			expect(clientKey(req())).toBe("untrusted");
			expect(clientKey(req("  ,  "))).toBe("untrusted");
		});
	});

	it("with TRUSTED_PROXY_HOPS=2 reads two from the right", () => {
		vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
		// client, outer-proxy, inner-proxy → the outer proxy wrote the client's IP.
		expect(clientKey(req("forged, 1.2.3.4, 10.0.0.1"))).toBe("1.2.3.4");
		vi.unstubAllEnvs();
	});

	/**
	 * Failing closed is right; failing closed SILENTLY was the gap. A typo bought
	 * install-wide throttling with no diagnostic, and since the key collapses to one
	 * bucket that now has a user-visible cost — an operator seeing shared 429s had
	 * nothing pointing at it (review catch).
	 */
	it("warns once when the value is set but unparseable", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			resetTrustedHopsWarning();
			vi.stubEnv("TRUSTED_PROXY_HOPS", "true");
			expect(clientKey(req("1.2.3.4"))).toBe("untrusted");
			expect(clientKey(req("1.2.3.4"))).toBe("untrusted");
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("TRUSTED_PROXY_HOPS");
		} finally {
			warn.mockRestore();
			vi.unstubAllEnvs();
		}
	});

	const quiet: [string, string][] = [
		["unset", ""],
		["an explicit zero", "0"],
	];
	for (const [name, value] of quiet) {
		it(`does NOT warn for ${name} — that is the documented way to switch it off`, () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				resetTrustedHopsWarning();
				vi.stubEnv("TRUSTED_PROXY_HOPS", value);
				expect(clientKey(req("1.2.3.4"))).toBe("untrusted");
				expect(warn).not.toHaveBeenCalled();
			} finally {
				warn.mockRestore();
				vi.unstubAllEnvs();
			}
		});
	}

	const bad: [string, string][] = [
		["a non-numeric value", "yes"],
		["zero", "0"],
		["a negative count", "-1"],
		["a fractional count", "1.5"],
	];
	for (const [name, value] of bad) {
		it(`treats ${name} as "do not trust the header"`, () => {
			vi.stubEnv("TRUSTED_PROXY_HOPS", value);
			expect(clientKey(req("1.2.3.4"))).toBe("untrusted");
			vi.unstubAllEnvs();
		});
	}

	it("does not read past the left end of a shorter chain than declared", () => {
		vi.stubEnv("TRUSTED_PROXY_HOPS", "5");
		expect(clientKey(req("1.2.3.4"))).toBe("untrusted");
		vi.unstubAllEnvs();
	});

	/**
	 * `Number` accepts more than an integer literal. These pin WHAT it accepts,
	 * so a future tightening is a deliberate change rather than a surprise.
	 */
	const permissive: [name: string, value: string, hops: number][] = [
		["scientific notation", "1e2", 100],
		["hex", "0x2", 2],
		["an explicit sign", "+3", 3],
		["a trailing-zero decimal", "1.0", 1],
		["surrounding whitespace", " 2 ", 2],
	];
	for (const [name, value, hops] of permissive) {
		it(`reads ${name} (${value}) as ${hops} hops`, () => {
			vi.stubEnv("TRUSTED_PROXY_HOPS", value);
			// A chain of exactly `hops` entries makes the parsed number observable:
			// the leftmost entry is the one at depth `hops`.
			const chain = Array.from({ length: hops }, (_, i) => `h${i}`).join(", ");
			expect(clientKey(req(chain))).toBe("h0");
			vi.unstubAllEnvs();
		});
	}

	it("treats a hop count longer than the chain as one shared bucket", () => {
		vi.stubEnv("TRUSTED_PROXY_HOPS", "1e2");
		const keys = new Set(
			Array.from({ length: 20 }, (_, i) => clientKey(req(`10.0.0.${i}`))),
		);
		expect(keys).toEqual(new Set(["untrusted"]));
		vi.unstubAllEnvs();
	});

	/**
	 * The hazard, pinned as behaviour rather than left as a caveat in a comment.
	 *
	 * `TRUSTED_PROXY_HOPS` is an assertion about the deployment. Set it HIGHER than
	 * the number of proxies that actually append and the extra depth is filled by
	 * whatever the client sent — which restores the per-request forgery the whole
	 * change was about. Inherent to counting from the right, not fixable here, so
	 * the test exists to make it visible to whoever reads this file next.
	 */
	it("is forgeable again if MORE hops are declared than exist", () => {
		vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
		// One real proxy appended 203.0.113.9; the client supplied the rest.
		const forged = [0, 1, 2].map((i) =>
			clientKey(req(`evil-${i}, 203.0.113.9`)),
		);
		expect(forged).toEqual(["evil-0", "evil-1", "evil-2"]);
		vi.unstubAllEnvs();
	});

	it("is NOT forgeable when the declared count matches reality", () => {
		vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
		const keys = new Set(
			[0, 1, 2].map((i) => clientKey(req(`evil-${i}, 203.0.113.9`))),
		);
		expect(keys).toEqual(new Set(["203.0.113.9"]));
		vi.unstubAllEnvs();
	});
});
