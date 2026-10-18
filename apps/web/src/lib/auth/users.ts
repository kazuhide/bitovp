import "server-only";
import { randomBytes } from "node:crypto";
import { getIdentityPrisma, type UserRole } from "@bitovp/db";
import { hashPassword, parsePasswordHash, verifyPassword } from "./password";

/**
 * Users-mode identity .
 *
 * Resolves global account validity. Organization authorization lives in
 * tenancy.ts and reads current Membership on every authenticated request.
 */

/** One shared normalizer for WRITE and LOOKUP — `Admin@x.com` and
 * `admin@x.com` must be one account, not two . */
export function normalizeEmail(raw: string): string {
	return raw.trim().toLowerCase();
}

/**
 * Constant-work dummy : a REAL scrypt hash generated from 32 random
 * bytes whose preimage was never recorded — frozen as a literal because a
 * module-load `scryptSync` would block the event loop once per process.
 * Its parameters MUST equal the live `hashPassword` parameters (a
 * fixed-parameter dummy diverging from real hashes becomes a timing
 * oracle); users.test.ts pins `parsePasswordHash(DUMMY_HASH)` ≡
 * `parsePasswordHash(hashPassword("x"))` on {n, r, p} without exporting
 * the module-private cost constants.
 */
export const DUMMY_HASH =
	"scrypt$16384$8$1$BroE4HLqqdcvsVJ4qdPwXQ==$zV/gB5j+QeH+AUTHXqYM0yQUIfBq/A19Mbg91v9Awpc=";

export type ResolvedUser = {
	id: string;
	email: string;
	displayName: string;
	role: UserRole;
	platformOwner?: boolean;
	active: boolean;
	mustChangePassword: boolean;
	sessionsValidFromMs: number;
	/** Signed into every users-mode cookie and matched exactly at the gate. */
	sessionGeneration: number;
};

type CacheEntry = { at: number; user: ResolvedUser | null };

/** Compatibility cache for non-authorization readers. Guards use the fresh resolver. */
const RESOLVER_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/** Test seam. */
export function resetUserResolverCache(): void {
	cache.clear();
}

/**
 * Cached identity reader. Returns null for a missing row
 * — the caller fails closed. Cached per user id for RESOLVER_TTL_MS.
 */
export async function resolveUserById(
	id: string,
	now: number = Date.now(),
	/** A verified users-cookie generation. When it is ahead of a warm cache,
	 * the signed value proves that cache predates a successful credential
	 * change on another web process, so the cache cannot reject the cookie. */
	verifiedSessionGeneration?: number,
): Promise<ResolvedUser | null> {
	const hit = cache.get(id);
	if (hit && now - hit.at < RESOLVER_TTL_MS) {
		if (
			verifiedSessionGeneration !== undefined &&
			(hit.user === null ||
				verifiedSessionGeneration > hit.user.sessionGeneration)
		) {
			return resolveUserByIdFresh(id, now);
		}
		return hit.user;
	}
	return resolveUserByIdFresh(id, now);
}

/**
 * Resolve directly from Postgres. All request guards and session polling
 * use this path so account/owner revocation takes effect on the next request.
 */
export async function resolveUserByIdFresh(
	id: string,
	now: number = Date.now(),
): Promise<ResolvedUser | null> {
	const row = await getIdentityPrisma().user.findUnique({
		where: { id },
		select: {
			id: true,
			email: true,
			displayName: true,
			role: true,
			platformOwner: true,
			active: true,
			mustChangePassword: true,
			sessionsValidFrom: true,
			sessionGeneration: true,
		},
	});
	const user: ResolvedUser | null = row
		? {
				id: row.id,
				email: row.email,
				displayName: row.displayName,
				role: row.role,
				platformOwner: row.platformOwner,
				active: row.active,
				mustChangePassword: row.mustChangePassword,
				sessionsValidFromMs: row.sessionsValidFrom.getTime(),
				sessionGeneration: row.sessionGeneration,
			}
		: null;
	cache.set(id, { at: now, user });
	return user;
}

/** Invalidate one user's cache entry NOW (login, password change, admin edits)
 * so the actor sees their own change without waiting out the TTL. */
export function invalidateUserCache(id: string): void {
	cache.delete(id);
}

/**
 * Zero-users bootstrap check : cache only populated installations.
 * Proxy and route bundles (or web processes) can have separate module caches;
 * setup's local invalidation cannot clear another instance's negative result.
 * Rechecking an empty installation lets setup's immediate redirect observe
 * the committed administrator, without assuming shared process memory.
 */
const USERS_EXIST_TTL_MS = 5_000;
let usersExistCache: { at: number; value: true } | null = null;

export async function anyUsersExist(
	now: number = Date.now(),
): Promise<boolean> {
	if (usersExistCache && now - usersExistCache.at < USERS_EXIST_TTL_MS) {
		return usersExistCache.value;
	}
	const count = await getIdentityPrisma().user.count();
	usersExistCache = count > 0 ? { at: now, value: true } : null;
	return count > 0;
}

/** Invalidate this instance after user mutations; other instances use the TTL. */
export function bumpUsersExist(): void {
	usersExistCache = null;
}

/** Test seam. */
export function resetUsersExistCache(): void {
	usersExistCache = null;
}

type VerifiedCredential = {
	/** Both fields form the self-service password-change CAS. */
	readonly sessionGeneration: number;
	readonly passwordHash: string;
};

export type UserVerifyResult =
	| {
			ok: true;
			user: ResolvedUser;
			verifiedCredential: VerifiedCredential;
	  }
	| {
			ok: false;
			/**
			 * `invalid` is the single indistinguishable failure (unknown email,
			 * wrong password, inactive — all constant-work, §7).
			 * `password-expired` is the ONE deliberate distinguishable case:
			 * the caller already proved the password, so telling them to ask
			 * an admin for a reissue leaks nothing .
			 */
			reason: "invalid";
	  }
	| {
			ok: false;
			reason: "password-expired";
			/** Expired temp passwords remain valid proof for replacing themselves. */
			verifiedCredential: VerifiedCredential;
	  };

/**
 * Verify email+password with constant work on every failure arm : the
 * unknown-email arm runs scrypt against DUMMY_HASH and discards; the
 * inactive arm runs the REAL verification and discards — inactive must be
 * indistinguishable from unknown.
 */
export async function verifyUserLogin(
	email: string,
	password: string,
	now: number = Date.now(),
): Promise<UserVerifyResult> {
	const row = await getIdentityPrisma().user.findUnique({
		where: { email: normalizeEmail(email) },
		select: {
			id: true,
			email: true,
			displayName: true,
			role: true,
			platformOwner: true,
			active: true,
			mustChangePassword: true,
			sessionsValidFrom: true,
			sessionGeneration: true,
			passwordHash: true,
			passwordExpiresAt: true,
		},
	});
	if (!row) {
		await verifyPassword(password, DUMMY_HASH);
		return { ok: false, reason: "invalid" };
	}
	const passwordOk = await verifyPassword(password, row.passwordHash);
	if (!passwordOk || !row.active) {
		return { ok: false, reason: "invalid" };
	}
	const verifiedCredential = {
		sessionGeneration: row.sessionGeneration,
		passwordHash: row.passwordHash,
	} satisfies VerifiedCredential;
	if (row.passwordExpiresAt && now >= row.passwordExpiresAt.getTime()) {
		return {
			ok: false,
			reason: "password-expired",
			verifiedCredential,
		};
	}
	return {
		ok: true,
		verifiedCredential,
		user: {
			id: row.id,
			email: row.email,
			displayName: row.displayName,
			role: row.role,
			platformOwner: row.platformOwner,
			active: row.active,
			mustChangePassword: row.mustChangePassword,
			sessionsValidFromMs: row.sessionsValidFrom.getTime(),
			sessionGeneration: row.sessionGeneration,
		},
	};
}

/**
 * Per-ACCOUNT exponential backoff (§7 — NEW machinery, named in §3c's honest
 * accounting): keyed on the SUBMITTED email so a flood against a throwaway
 * address cannot drain anything shared, bounded LRU so unknown emails
 * neither grow memory nor probe for free, and NEVER a permanent lock — an
 * attacker must not be able to lock out the ADMIN. The global failure
 * budget stays as a CPU guard only (login route).
 */
const BACKOFF_MAX_ENTRIES = 1_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;
/** A quiet hour forgets the account's failure history. */
const BACKOFF_FORGET_MS = 3_600_000;

type BackoffEntry = { failures: number; lastFailureAt: number };
const backoff = new Map<string, BackoffEntry>();

/** Test seam. */
export function resetAccountBackoff(): void {
	backoff.clear();
}

function backoffDelayMs(failures: number): number {
	if (failures < 3) {
		return 0;
	}
	return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 3));
}

/** CHECK without charging (the login route's hard-won order, §3c): returns
 * the ms the caller must still wait, 0 when clear. */
export function accountBackoffRemainingMs(
	email: string,
	now: number = Date.now(),
): number {
	const key = normalizeEmail(email);
	const entry = backoff.get(key);
	if (!entry) {
		return 0;
	}
	if (now - entry.lastFailureAt > BACKOFF_FORGET_MS) {
		backoff.delete(key);
		return 0;
	}
	const readyAt = entry.lastFailureAt + backoffDelayMs(entry.failures);
	return Math.max(0, readyAt - now);
}

/** Charged ONLY on a failed verification — junk and successes never touch it. */
export function chargeAccountFailure(
	email: string,
	now: number = Date.now(),
): void {
	const key = normalizeEmail(email);
	const entry = backoff.get(key);
	if (entry) {
		// Refresh recency by re-inserting (Map preserves insertion order — the
		// eviction below drops the OLDEST entry).
		backoff.delete(key);
		backoff.set(key, { failures: entry.failures + 1, lastFailureAt: now });
	} else {
		if (backoff.size >= BACKOFF_MAX_ENTRIES) {
			// review-32 M4: evict the LOWEST-failures entry (oldest among
			// ties) — oldest-insertion eviction let 1,000 throwaway charges
			// wash a real target's ledger out. A heavy entry (a targeted
			// account) now survives probe floods; the residual (a flood of
			// ≥equal-weight keys, and per-process scope) is documented in
			// §9's limitation line.
			let evict: string | undefined;
			let evictFailures = Number.POSITIVE_INFINITY;
			for (const [entryKey, entry] of backoff) {
				if (entry.failures < evictFailures) {
					evict = entryKey;
					evictFailures = entry.failures;
				}
			}
			if (evict !== undefined) {
				backoff.delete(evict);
			}
		}
		backoff.set(key, { failures: 1, lastFailureAt: now });
	}
}

export function clearAccountFailures(email: string): void {
	backoff.delete(normalizeEmail(email));
}

/** Server-GENERATED temporary password : ≥128-bit, never admin-typed.
 * base64url of 18 random bytes = 24 chars, well past the 12-char floor. */
export function generateTemporaryPassword(): string {
	return randomBytes(18).toString("base64url");
}

/** §3c: temp passwords expire ~72h after issuance. */
export const TEMP_PASSWORD_TTL_MS = 72 * 3_600_000;

/** The one shared password floor  — all three call sites (setup wizard,
 * admin create/reset, self-service change) import THIS, so they cannot
 * diverge. Kept as a plain function rather than three zod copies. */
export const PASSWORD_MIN_LENGTH = 12;

export function passwordPolicyError(password: string): string | null {
	if (password.length < PASSWORD_MIN_LENGTH) {
		return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
	}
	if (password.length > 512) {
		return "Password must be at most 512 characters";
	}
	return null;
}

/** Re-exported so route code hashes through one door. */
export { hashPassword, parsePasswordHash };
