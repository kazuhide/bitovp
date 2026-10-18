import { scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, parsePasswordHash, verifyPassword } from "./password";

describe("hashPassword", () => {
	it("emits scrypt$N$r$p$salt$hash", async () => {
		const hash = hashPassword("correct horse battery staple");
		const parts = hash.split("$");
		expect(parts[0]).toBe("scrypt");
		expect(Number(parts[1])).toBe(16_384);
		expect(Number(parts[2])).toBe(8);
		expect(Number(parts[3])).toBe(1);
		expect(Buffer.from(parts[4] as string, "base64")).toHaveLength(16);
		expect(Buffer.from(parts[5] as string, "base64")).toHaveLength(32);
	});

	it("salts per call — the same password never yields the same hash", async () => {
		expect(hashPassword("same-password")).not.toBe(
			hashPassword("same-password"),
		);
	});
});

describe("verifyPassword", async () => {
	const hash = hashPassword("correct horse battery staple");

	const cases: [name: string, password: string, expected: boolean][] = [
		["the exact password", "correct horse battery staple", true],
		["a wrong password", "incorrect horse battery staple", false],
		["a prefix of the password", "correct horse battery stapl", false],
		["a case-flipped password", "Correct Horse Battery Staple", false],
		["an empty password", "", false],
	];

	for (const [name, password, expected] of cases) {
		it(`${expected ? "accepts" : "rejects"} ${name}`, async () => {
			expect(await verifyPassword(password, hash)).toBe(expected);
		});
	}

	const malformed: [name: string, stored: string][] = [
		["an empty string", ""],
		["a bcrypt-shaped hash", "$2b$12$abcdefghijklmnopqrstuv"],
		["too few fields", "scrypt$16384$8$c2FsdA==$aGFzaA=="],
		["a non-numeric cost", "scrypt$N$8$1$c2FsdA==$aGFzaA=="],
		["a non-power-of-two N", "scrypt$16383$8$1$c2FsdA==$aGFzaA=="],
		["an empty salt", "scrypt$16384$8$1$$aGFzaA=="],
		["an empty digest", "scrypt$16384$8$1$c2FsdA==$"],
		// Cost ceiling: without it scryptSync would try to allocate 128*N*r
		// bytes (a terabyte) instead of answering "wrong password".
		["an N above the cost ceiling", `scrypt$${2 ** 30}$8$1$c2FsdA==$aGFzaA==`],
		["an r above the cost ceiling", "scrypt$16384$64$1$c2FsdA==$aGFzaA=="],
		["a p above the cost ceiling", "scrypt$16384$8$99$c2FsdA==$aGFzaA=="],
	];

	for (const [name, stored] of malformed) {
		it(`returns false (never throws) for ${name}`, async () => {
			expect(await verifyPassword("anything", stored)).toBe(false);
		});
	}

	it("verifies a hash produced with HIGHER cost parameters", async () => {
		// Parameters travel with the hash, so an operator who raised the cost —
		// or a future default increase — must keep verifying. Downward is a
		// different matter: parsePasswordHash floors the work factor, because a
		// hand-written `scrypt$2$1$1$…` passed every other check while costing
		// 0.004ms/hash against 18.9ms (a ~4,700x cracking speedup). This test used
		// to go DOWN to N=1024, which the floor now correctly rejects.
		const stronger = ["scrypt", 32_768, 8, 1].join("$");
		const salt = Buffer.from("0123456789abcdef");
		const key = scryptSync("legacy-password", salt, 32, {
			N: 32_768,
			r: 8,
			p: 1,
			maxmem: 256 * 32_768 * 8,
		});
		const stored = `${stronger}$${salt.toString("base64")}$${key.toString("base64")}`;
		expect(await verifyPassword("legacy-password", stored)).toBe(true);
		expect(await verifyPassword("other-password", stored)).toBe(false);
	});
});

describe("the work floor accepts every way of hardening, rejects weakening", () => {
	/**
	 * A review measured the first cut rejecting hashes that were STRONGER than the
	 * shipped default — `N=8192 r=32` is 32 MiB against 16 MiB — because I floored
	 * N alone and called it memory-hardness. scrypt's memory is `128*N*r`, so that
	 * reasoning was simply wrong. Memory is floored on `N*r`, total work on
	 * `N*r*p`, and both are frozen literals rather than the generation defaults so
	 * that raising a default later cannot retroactively reject existing hashes.
	 */
	function stored(n: number, r: number, p: number): string {
		const salt = Buffer.alloc(16, 3);
		const key = scryptSync("pw", salt, 32, {
			N: n,
			r,
			p,
			// A generous floor: OpenSSL rejects a maxmem below its own minimum, which
			// `256 * n * r` falls under for the tiny-N cases these tests need.
			maxmem: Math.max(32 * 1024 * 1024, 256 * n * r),
		});
		return [
			"scrypt",
			n,
			r,
			p,
			salt.toString("base64"),
			key.toString("base64"),
		].join("$");
	}

	const stronger: [string, number, number, number][] = [
		["the shipped parameters", 16_384, 8, 1],
		["hardened via r (2x memory)", 8192, 32, 1],
		["hardened via r and p (4x work)", 4096, 32, 4],
		["hardened via p (8x work)", 16_384, 8, 8],
		["hardened via N", 32_768, 8, 1],
	];
	for (const [name, n, r, p] of stronger) {
		it(`ACCEPTS ${name}`, () => {
			const parsed = parsePasswordHash(stored(n, r, p));
			expect(parsed.ok, `N=${n} r=${r} p=${p}`).toBe(true);
		});
	}

	const weaker: [string, number, number, number][] = [
		["a trivial work factor", 2, 1, 1],
		["half the shipped memory", 8192, 8, 1],
		// p cannot buy its way past the MEMORY floor. p=16 is the ceiling
		// (MAX_SCRYPT_P), so this is the most work a tiny N can claim — and it is
		// still refused, by the memory floor rather than the ceiling.
		["a tiny N with the maximum p", 2, 1, 16],
	];
	for (const [name, n, r, p] of weaker) {
		it(`REFUSES ${name}`, () => {
			const parsed = parsePasswordHash(stored(n, r, p));
			expect(parsed.ok, `N=${n} r=${r} p=${p}`).toBe(false);
			if (!parsed.ok) {
				expect(parsed.reason).toMatch(/work factor below/);
			}
		});
	}

	/**
	 * Both guards below were added in response to a review, and neither can be
	 * built with `stored` — scrypt itself refuses to produce these hashes, which
	 * is the entire point. So they are asserted on hand-written parameter strings,
	 * which is also the only way they arrive in reality (a hand-edited env value).
	 *
	 * Written because the round before this one shipped a guard with no test that
	 * entered it: deleting all three of its clauses left the suite at its exact
	 * green count.
	 */
	function raw(n: number, r: number, p: number): string {
		return [
			"scrypt",
			n,
			r,
			p,
			Buffer.alloc(16, 3).toString("base64"),
			Buffer.alloc(32, 4).toString("base64"),
		].join("$");
	}

	it("REFUSES an N that scrypt itself cannot accept for the given r", () => {
		// N < 2^(16*r) is OpenSSL's rule. r=1 caps N at 65536, and the memory floor
		// (N*r >= 131072) forces N above it — so this pair passes every other check
		// and used to throw at VERIFICATION time, where verifyPassword swallows it
		// and reports "wrong password" forever while the install looks configured.
		const parsed = parsePasswordHash(raw(131_072, 1, 1));
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expect(parsed.reason).toMatch(/below 2\^\(16\*r\)/);
		}
		// Not a blanket ban on large N: the same N with r=8 is fine.
		expect(parsePasswordHash(raw(131_072, 8, 1)).ok).toBe(true);
	});

	it("REFUSES parameters whose memory exceeds the absolute ceiling", () => {
		// The independent N and r ceilings admit N=2^20 r=32 — measured at 4.1 GiB
		// and 7.3 s per verification, times four concurrent verifications.
		const parsed = parsePasswordHash(raw(2 ** 20, 32, 1));
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expect(parsed.reason).toMatch(/must not exceed/);
		}
		// 256 MiB is the ceiling: 128*N*r at N=65536 r=32 is exactly that.
		expect(parsePasswordHash(raw(65_536, 32, 1)).ok).toBe(true);
		expect(parsePasswordHash(raw(131_072, 32, 1)).ok).toBe(false);
	});
});

describe("a well-formed hash string is not automatically a usable one", async () => {
	/**
	 * `scrypt$16384$8$1$AA==$AA==` parses, carries a one-byte salt and a one-byte
	 * digest, and `verifyPassword` derives a one-byte key to compare — so about
	 * 1 password in 256 signs in (measured: 1 hit in 512 tries). `auth:hash`
	 * never emits such a string, so it needs a hand-written env value; the point
	 * is that the config-level check that existed to stop exactly this accepted
	 * it, which made the check decorative.
	 */
	const TINY = "scrypt$16384$8$1$AA==$AA==";

	it("REFUSES the tiny hash — the salt is the first floor it fails", async () => {
		const parsed = parsePasswordHash(TINY);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expect(parsed.reason).toMatch(/salt must be at least/);
		}
	});

	it("REFUSES a short DIGEST even with a full-length salt", async () => {
		// The digest floor is the one that matters for brute force, so it needs its
		// own case — the salt check runs first and would otherwise mask it.
		const full = hashPassword("pw").split("$");
		const shortDigest = [
			"scrypt",
			full[1],
			full[2],
			full[3],
			full[4],
			"AA==",
		].join("$");
		const parsed = parsePasswordHash(shortDigest);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expect(parsed.reason).toMatch(/digest must be at least/);
		}
	});

	it("REFUSES a short SALT even with a full-length digest", async () => {
		const full = hashPassword("pw").split("$");
		const shortSalt = [
			"scrypt",
			full[1],
			full[2],
			full[3],
			"AA==",
			full[5],
		].join("$");
		const parsed = parsePasswordHash(shortSalt);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expect(parsed.reason).toMatch(/salt must be at least/);
		}
	});
	it("verifyPassword returns false for such a hash instead of comparing", async () => {
		// Without the length floor, SOME password matches; with it, none can.
		for (let i = 0; i < 300; i += 1) {
			expect(await verifyPassword(String(i), TINY)).toBe(false);
		}
	});

	it("still accepts what auth:hash produces", async () => {
		const stored = hashPassword("correct horse battery staple");
		expect(parsePasswordHash(stored).ok).toBe(true);
		expect(await verifyPassword("correct horse battery staple", stored)).toBe(
			true,
		);
		expect(await verifyPassword("wrong", stored)).toBe(false);
	});
});
