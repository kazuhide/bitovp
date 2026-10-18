import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * ASYNC scrypt for the verify path. `scryptSync` blocks the Node event loop,
 * so a burst of sign-in attempts froze the WHOLE app — measured at 18.9 ms
 * each, i.e. ~11 s of dead process from one unauthenticated burst, during which
 * nothing responds including the live-channel and prewarmed-pool controls that
 * are the reason a lockout matters (review catch). The callback form runs on
 * libuv's threadpool, so the same burst costs LATENCY, not availability.
 *
 * `hashPassword` stays sync: it runs once, in a CLI script, off the request
 * path.
 */
const scryptAsync = promisify(scrypt) as (
	password: string,
	salt: Buffer,
	keylen: number,
	options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Shared-team-password hashing with node's scrypt. No dependency: the whole
 * primitive is in node:crypto, and a per-install random salt is encoded into
 * the stored string so two installs with the same password get different
 * hashes.
 *
 * Format: `scrypt$N$r$p$saltB64$hashB64`. The parameters travel WITH the hash
 * so raising the cost later still verifies old hashes.
 */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

/**
 * Cost ceiling for a hash read back from the environment: scrypt allocates
 * 128*N*r bytes, so an operator (or a mangled .env) naming N=2^30 would ask
 * node for a terabyte instead of returning "wrong password".
 */
const MAX_SCRYPT_N = 1 << 20;

/**
 * FROZEN floors — deliberately not `SCRYPT_N`/`SCRYPT_R`. If these tracked the
 * generation defaults, raising a default would retroactively invalidate every
 * hash produced under the old one and lock the operator out of their own install
 * (review catch). Lowering the floors later is a compatibility decision; raising
 * the generation default is not.
 *
 * TWO floors, because scrypt has two costs — and my first attempt got the split
 * wrong. Memory is `128 * N * r`, NOT N alone, so flooring N by itself rejected
 * `N=8192 r=32`, which uses 32 MiB against the shipped 16 MiB: TWICE the
 * memory-hardness, refused as too weak. Meanwhile `p` multiplies total work
 * without adding any memory, so flooring only the product would admit a
 * trivially parallelisable `N=2 p=65536`. Flooring memory AND total work covers
 * both directions; verified against all four legitimate hardening paths (higher
 * N, higher r, higher p, and r+p together) plus three weak ones.
 */
const MIN_SCRYPT_MEMORY = 16_384 * 8; // N*r — the shipped 16 MiB

/**
 * Total work. Equal to the memory floor, which makes the work clause UNREACHABLE
 * on its own — `p >= 1` is enforced above, so `n*r*p >= n*r` always. A reviewer
 * proved it by exhausting all 10,240 legal triples: zero are refused by this
 * clause and not the other.
 *
 * Kept rather than deleted, and this is a judgement call: raising it to demand
 * `p >= 2` at the floor would reject the parameters `hashPassword` itself emits,
 * so the honest options were "unreachable but explicit" or "gone". Explicit wins
 * because the memory floor's job is memory and this names the other axis, so the
 * next person raising either constant sees both. The comment now says it is
 * unreachable instead of implying a control it does not add.
 */
const MIN_SCRYPT_WORK = 16_384 * 8; // N*r*p

/**
 * OpenSSL requires `N < 2^(16*r)`, so the memory floor above can demand an N that
 * scrypt then refuses: `N=131072 r=1` passes every check here and throws at
 * verification time. The old behaviour was the worst kind — `loadAuthConfig`
 * reported the install CONFIGURED, the login page rendered, and every sign-in
 * failed as "wrong password" because `verifyPassword` swallows the throw. That is
 * exactly the config/verify disagreement this module promises cannot happen
 * (review catch; needs a hand-forged env value, hence not a blocker).
 */
function exceedsOpensslNLimit(n: number, r: number): boolean {
	return r <= 4 && n >= 2 ** (16 * r);
}

/**
 * An absolute memory ceiling. The independent N and r ceilings admit
 * `N=2^20 r=32` — measured at 4,130 MiB peak RSS and 7.3 s per verification, and
 * the gate allows four concurrently, so ~16 GiB. At `p=16` that is ~117 s holding
 * a threadpool thread, which defeats the async change this commit is built on:
 * the app stays responsive only while the pool drains. The old comment reasoned
 * about "a terabyte" while 4 GiB x 4 already OOMs a normal box (review catch).
 */
const MAX_SCRYPT_MEMORY_BYTES = 256 * 1024 * 1024;
const MAX_SCRYPT_R = 32;
const MAX_SCRYPT_P = 16;

/** node's default maxmem (32 MiB) is below 128*N*r for larger N — size it explicitly. */
function maxmem(n: number, r: number): number {
	return 256 * n * r;
}

export function hashPassword(password: string): string {
	const salt = randomBytes(SALT_BYTES);
	const key = scryptSync(password, salt, KEY_BYTES, {
		N: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
		maxmem: maxmem(SCRYPT_N, SCRYPT_R),
	});
	return [
		"scrypt",
		SCRYPT_N,
		SCRYPT_R,
		SCRYPT_P,
		salt.toString("base64"),
		key.toString("base64"),
	].join("$");
}

/**
 * Constant-time verification against a stored hash string. Returns false —
 * never throws — for a malformed stored hash so a login attempt cannot be
 * turned into a 500; `loadAuthConfig` is what rejects a malformed hash (503)
 * before any request reaches here.
 */
/**
 * Validates a stored hash string, returning the decoded parts or a reason.
 *
 * Shared with `loadAuthConfig` so the 503-at-startup check and the
 * verify-time check cannot disagree — the ONE thing that must not differ, since
 * config's job is to reject a bad hash before any request reaches verification.
 *
 * The minimum lengths are the part that matters. Without them
 * `scrypt$16384$8$1$AA==$AA==` is a well-formed hash string with a ONE-BYTE
 * salt and a ONE-BYTE digest, and `verifyPassword` derives a 1-byte key to
 * compare against it — so roughly 1 password in 256 signs in. Verified
 * empirically: 1 hit in 512 tries. `auth:hash` never produces such a string,
 * so this needs an operator to hand-write one — but the regex that was supposed
 * to stop exactly this accepted it, which made the check decorative.
 */
export function parsePasswordHash(stored: string):
	| {
			ok: true;
			n: number;
			r: number;
			p: number;
			salt: Buffer;
			expected: Buffer;
	  }
	| { ok: false; reason: string } {
	const parts = stored.split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") {
		return { ok: false, reason: "expected scrypt$N$r$p$salt$hash" };
	}
	const n = Number(parts[1]);
	const r = Number(parts[2]);
	const p = Number(parts[3]);
	if (!Number.isSafeInteger(n) || n <= 1 || n > MAX_SCRYPT_N) {
		return { ok: false, reason: `N must be 2..${MAX_SCRYPT_N}` };
	}
	if ((n & (n - 1)) !== 0) {
		return { ok: false, reason: "N must be a power of two" };
	}
	if (!Number.isSafeInteger(r) || r < 1 || r > MAX_SCRYPT_R) {
		return { ok: false, reason: `r must be 1..${MAX_SCRYPT_R}` };
	}
	if (!Number.isSafeInteger(p) || p < 1 || p > MAX_SCRYPT_P) {
		return { ok: false, reason: `p must be 1..${MAX_SCRYPT_P}` };
	}
	// Floors as well as ceilings — the same shape as the length bug this
	// validator was written to close. `scrypt$2$1$1$…` passed every other check
	// while costing 0.004 ms/hash against 18.9 ms at the shipped parameters: a
	// ~4,700x offline-cracking speedup from a string that "looked fine".
	//
	// Two corrections from a second review. The floor is on the PRODUCT `N*r*p`,
	// because that is what work means: flooring N alone rejected `N=8192 r=32`,
	// which is TWICE the shipped work, and would have 503'd the whole install for
	// an operator who hardened via r instead of N. And the bound is a FROZEN
	// literal, not derived from the current default — pinning it to `SCRYPT_N`
	// meant raising that default later would retroactively reject every existing
	// hash, contradicting this module's own promise that parameters travel with
	// the hash so old ones keep verifying.
	if (exceedsOpensslNLimit(n, r)) {
		return {
			ok: false,
			reason: `N must be below 2^(16*r) for r=${r} — scrypt itself rejects it`,
		};
	}
	if (128 * n * r > MAX_SCRYPT_MEMORY_BYTES) {
		return {
			ok: false,
			reason: `128*N*r must not exceed ${MAX_SCRYPT_MEMORY_BYTES} bytes`,
		};
	}
	if (n * r < MIN_SCRYPT_MEMORY || n * r * p < MIN_SCRYPT_WORK) {
		return {
			ok: false,
			reason: `work factor below the supported minimum (N*r>=${MIN_SCRYPT_MEMORY}, N*r*p>=${MIN_SCRYPT_WORK})`,
		};
	}
	const salt = Buffer.from(parts[4] as string, "base64");
	const expected = Buffer.from(parts[5] as string, "base64");
	if (salt.length < SALT_BYTES) {
		return { ok: false, reason: `salt must be at least ${SALT_BYTES} bytes` };
	}
	if (expected.length < KEY_BYTES) {
		return { ok: false, reason: `digest must be at least ${KEY_BYTES} bytes` };
	}
	return { ok: true, n, r, p, salt, expected };
}

export async function verifyPassword(
	password: string,
	stored: string,
): Promise<boolean> {
	const parsed = parsePasswordHash(stored);
	if (!parsed.ok) {
		return false;
	}
	const { n, r, salt, expected } = parsed;
	const p = parsed.p;
	let actual: Buffer;
	try {
		actual = await scryptAsync(password, salt, expected.length, {
			N: n,
			r,
			p,
			maxmem: maxmem(n, r),
		});
	} catch {
		return false;
	}
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
