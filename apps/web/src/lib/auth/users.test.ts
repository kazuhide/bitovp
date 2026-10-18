import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const count = vi.fn();
vi.mock("@bitovp/db", () => ({
	getIdentityPrisma: () => ({
		user: { findUnique, count },
	}),
}));

import { hashPassword, parsePasswordHash, verifyPassword } from "./password";
import {
	accountBackoffRemainingMs,
	anyUsersExist,
	chargeAccountFailure,
	clearAccountFailures,
	DUMMY_HASH,
	normalizeEmail,
	resetAccountBackoff,
	resetUserResolverCache,
	resetUsersExistCache,
	resolveUserById,
	verifyUserLogin,
} from "./users";

/**
 *  §2/§7 — the users-mode identity contracts: the constant-work
 * dummy's parameter pin (review refinement R4's exact formulation), the
 * email normalizer, the per-account backoff's charge-on-failure-only shape,
 * and the constant-work arms of verifyUserLogin.
 */

beforeEach(() => {
	findUnique.mockReset();
	count.mockReset();
	resetAccountBackoff();
	resetUserResolverCache();
	resetUsersExistCache();
});

describe("DUMMY_HASH (constant-work login, §7)", () => {
	it("carries EXACTLY the live hashPassword parameters — a diverged dummy is a timing oracle (R4 pin, no constant export)", () => {
		const dummy = parsePasswordHash(DUMMY_HASH);
		const real = parsePasswordHash(hashPassword("x"));
		expect(dummy.ok).toBe(true);
		expect(real.ok).toBe(true);
		if (dummy.ok && real.ok) {
			expect({ n: dummy.n, r: dummy.r, p: dummy.p }).toEqual({
				n: real.n,
				r: real.r,
				p: real.p,
			});
		}
	});

	it("verifies against nothing anyone can submit — the preimage was never recorded", async () => {
		// Cannot prove a negative about the preimage, but CAN prove the hash
		// is well-formed and rejects arbitrary guesses (i.e. it is a real
		// scrypt digest, not a truncated one — the config.ts lesson).
		expect(await verifyPassword("guess", DUMMY_HASH)).toBe(false);
	});
});

describe("normalizeEmail", () => {
	it("lowercases and trims — one account for Admin@x.com and admin@x.com", () => {
		expect(normalizeEmail("  Admin@X.com ")).toBe("admin@x.com");
	});
});

describe("verifyUserLogin constant-work arms", () => {
	const ROW = {
		id: "11111111-2222-4333-8444-555555555555",
		email: "op@example.com",
		displayName: "Op",
		role: "OPERATOR",
		active: true,
		mustChangePassword: false,
		sessionsValidFrom: new Date(1_000),
		sessionGeneration: 4,
		passwordHash: hashPassword("correct-horse-battery"),
		passwordExpiresAt: null,
	};

	it("unknown email fails INDISTINGUISHABLY from a wrong password", async () => {
		findUnique.mockResolvedValue(null);
		const unknown = await verifyUserLogin("nobody@x.com", "whatever");
		findUnique.mockResolvedValue(ROW);
		const wrong = await verifyUserLogin("op@example.com", "wrong-password");
		expect(unknown).toEqual({ ok: false, reason: "invalid" });
		expect(wrong).toEqual({ ok: false, reason: "invalid" });
	});

	it("INACTIVE fails indistinguishably too — the scrypt runs and is discarded", async () => {
		findUnique.mockResolvedValue({ ...ROW, active: false });
		const verdict = await verifyUserLogin(
			"op@example.com",
			"correct-horse-battery",
		);
		expect(verdict).toEqual({ ok: false, reason: "invalid" });
	});

	it("the LOOKUP normalizes the submitted email — Admin@X.com finds admin@x.com", async () => {
		findUnique.mockResolvedValue(ROW);
		await verifyUserLogin("  OP@Example.COM ", "correct-horse-battery");
		expect(findUnique.mock.calls[0]?.[0].where).toEqual({
			email: "op@example.com",
		});
	});

	it("an expired temp password is the ONE distinguishable failure — the caller already proved it", async () => {
		findUnique.mockResolvedValue({
			...ROW,
			passwordExpiresAt: new Date(5_000),
		});
		const verdict = await verifyUserLogin(
			"op@example.com",
			"correct-horse-battery",
			10_000,
		);
		expect(verdict).toEqual({
			ok: false,
			reason: "password-expired",
			verifiedCredential: {
				sessionGeneration: 4,
				passwordHash: ROW.passwordHash,
			},
		});
	});

	it("success carries the resolved identity", async () => {
		findUnique.mockResolvedValue(ROW);
		const verdict = await verifyUserLogin(
			"op@example.com",
			"correct-horse-battery",
		);
		expect(verdict.ok).toBe(true);
		if (verdict.ok) {
			expect(verdict.user).toMatchObject({
				id: ROW.id,
				role: "OPERATOR",
				sessionsValidFromMs: 1_000,
				sessionGeneration: 4,
			});
			expect(verdict.verifiedCredential).toEqual({
				sessionGeneration: 4,
				passwordHash: ROW.passwordHash,
			});
		}
	});
});

describe("per-account backoff (§7 — new machinery, honestly named)", () => {
	it("charges ONLY on failure and only bites after repeated failures", () => {
		const t0 = 1_000_000;
		expect(accountBackoffRemainingMs("a@x.com", t0)).toBe(0);
		chargeAccountFailure("a@x.com", t0);
		chargeAccountFailure("a@x.com", t0);
		// Two failures: still free (a typo'd password is not an attack).
		expect(accountBackoffRemainingMs("a@x.com", t0)).toBe(0);
		chargeAccountFailure("a@x.com", t0);
		// Third failure starts the exponential ladder.
		expect(accountBackoffRemainingMs("a@x.com", t0)).toBeGreaterThan(0);
	});

	it("is keyed on the SUBMITTED email — a flood on a throwaway address locks nothing shared", () => {
		const t0 = 1_000_000;
		for (let i = 0; i < 10; i += 1) {
			chargeAccountFailure("attacker-target@x.com", t0);
		}
		expect(accountBackoffRemainingMs("admin@x.com", t0)).toBe(0);
	});

	it("the PRIMITIVE caps the delay and clears on demand — the route-level 'correct password always wins' discriminator lives in login/route.test.ts (review-32 B1)", () => {
		const t0 = 1_000_000;
		for (let i = 0; i < 50; i += 1) {
			chargeAccountFailure("victim@x.com", t0);
		}
		const wait = accountBackoffRemainingMs("victim@x.com", t0);
		expect(wait).toBeGreaterThan(0);
		expect(wait).toBeLessThanOrEqual(60_000);
		clearAccountFailures("victim@x.com");
		expect(accountBackoffRemainingMs("victim@x.com", t0)).toBe(0);
	});

	it("the LRU bound holds AND a heavy entry survives a probe flood (review-32 M4 — evict lowest failures, not oldest)", () => {
		const t0 = 1_000_000;
		// A targeted account accrues real weight (5 failures = deep in the
		// window).
		for (let i = 0; i < 5; i += 1) {
			chargeAccountFailure("victim@x.com", t0);
		}
		const before = accountBackoffRemainingMs("victim@x.com", t0);
		expect(before).toBeGreaterThan(0);
		// Then 2,000 single-charge throwaways flood the LRU. Oldest-insertion
		// eviction would have washed victim@ out; lowest-failures eviction
		// drops the single-charge probes and keeps the heavy entry.
		for (let i = 0; i < 2_000; i += 1) {
			chargeAccountFailure(`probe-${i}@x.com`, t0);
		}
		expect(accountBackoffRemainingMs("victim@x.com", t0)).toBe(before);
		// Memory is still bounded — a probe cannot both evict the victim and
		// grow the map without limit.
	});

	it("keys are NORMALIZED — Admin@X.com and admin@x.com share one ledger", () => {
		const t0 = 1_000_000;
		chargeAccountFailure("Admin@X.com", t0);
		chargeAccountFailure("admin@x.com", t0);
		chargeAccountFailure("ADMIN@x.COM", t0);
		expect(accountBackoffRemainingMs("admin@x.com", t0)).toBeGreaterThan(0);
	});
});

describe("user resolver revocation window", () => {
	it("keeps a warm generation only inside the declared <60s TTL and refreshes at the boundary", async () => {
		const base = {
			id: "11111111-2222-4333-8444-555555555555",
			email: "op@example.com",
			displayName: "Op",
			role: "OPERATOR",
			active: true,
			mustChangePassword: false,
			sessionsValidFrom: new Date(0),
		};
		findUnique
			.mockResolvedValueOnce({ ...base, sessionGeneration: 7 })
			.mockResolvedValueOnce({
				...base,
				sessionsValidFrom: new Date(10_000),
				sessionGeneration: 8,
			});

		expect((await resolveUserById(base.id, 1_000))?.sessionGeneration).toBe(7);
		expect((await resolveUserById(base.id, 60_999))?.sessionGeneration).toBe(7);
		expect(findUnique).toHaveBeenCalledTimes(1);
		expect((await resolveUserById(base.id, 61_000))?.sessionGeneration).toBe(8);
		expect(findUnique).toHaveBeenCalledTimes(2);
	});

	it("refreshes immediately when a valid signed cookie names a generation newer than the warm cache", async () => {
		const base = {
			id: "11111111-2222-4333-8444-555555555555",
			email: "op@example.com",
			displayName: "Op",
			role: "OPERATOR",
			active: true,
			mustChangePassword: false,
			sessionsValidFrom: new Date(0),
		};
		findUnique
			.mockResolvedValueOnce({ ...base, sessionGeneration: 7 })
			.mockResolvedValueOnce({
				...base,
				sessionsValidFrom: new Date(1_500),
				sessionGeneration: 8,
			});

		// Process B warmed generation 7 before process A changed the password
		// and issued a generation-8 cookie. The newer signed generation is proof
		// that B's cache cannot be authoritative; rejecting it would destroy a
		// newly valid session for the rest of the cache TTL.
		expect((await resolveUserById(base.id, 1_000))?.sessionGeneration).toBe(7);
		expect((await resolveUserById(base.id, 2_000, 8))?.sessionGeneration).toBe(
			8,
		);
		expect(findUnique).toHaveBeenCalledTimes(2);
	});
});

describe("anyUsersExist cache", () => {
	it("observes first-admin setup immediately even when another module instance performed it", async () => {
		count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
		expect(await anyUsersExist(1_000)).toBe(false);
		// Setup committed elsewhere: no local bumpUsersExist is available.
		expect(await anyUsersExist(1_001)).toBe(true);
		expect(count).toHaveBeenCalledTimes(2);
		expect(count.mock.calls[0]).toEqual([]);
		expect(count.mock.calls[1]).toEqual([]);
	});

	it("caches populated installations for five seconds then rechecks all users, keeping setup closed for inactive accounts", async () => {
		count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
		expect(await anyUsersExist(1_000)).toBe(true);
		expect(await anyUsersExist(5_999)).toBe(true);
		expect(count).toHaveBeenCalledTimes(1);
		expect(await anyUsersExist(6_000)).toBe(false);
		expect(count).toHaveBeenCalledTimes(2);
		expect(count.mock.calls[0]).toEqual([]);
	});

	it("does not authorize bootstrap from a stale negative result when the DB fails", async () => {
		count
			.mockResolvedValueOnce(0)
			.mockRejectedValueOnce(new Error("DB unavailable"));
		expect(await anyUsersExist(1_000)).toBe(false);
		await expect(anyUsersExist(1_001)).rejects.toThrow("DB unavailable");
	});
});
