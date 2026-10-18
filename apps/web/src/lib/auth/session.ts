import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AuthMode } from "./config";

/**
 * Signed session cookie — HMAC-SHA256 over a tiny JSON payload, no JWT and
 * no auth framework (the whole primitive is ~80 lines of node:crypto; a
 * dependency would add a parser attack surface we do not need for one
 * self-issued token).
 *
 * There is no server-side session store: the cookie IS the session, so a
 * compromised AUTH_SESSION_SECRET is a full compromise and rotating it
 * invalidates every session (that is the intended revocation lever).
 */
const TOKEN_VERSION = "v1";

const COOKIE_BASE = "bitovp_session";

/**
 * Two names for one cookie: over https we use the `__Host-` prefix, which
 * browsers only accept with Secure + Path=/ + no Domain — that is what stops
 * a sibling subdomain from overwriting the session. Over plain http the
 * prefix is rejected by the browser, so the bare name is used there.
 */
export const SESSION_COOKIE = COOKIE_BASE;
export const SECURE_SESSION_COOKIE = `__Host-${COOKIE_BASE}`;

export const SESSION_COOKIE_NAMES = [
	SECURE_SESSION_COOKIE,
	SESSION_COOKIE,
] as const;

/**
 * Options for DELETING a session cookie, by name.
 *
 * One function rather than the same three lines in `logout/route.ts` and
 * `proxy.ts`, because the duplication was the defect's hiding place: the logout
 * copy was reviewed, fixed and pinned by tests while the proxy copy kept the
 * same bug, and a mutation proving it (`secure: true` on both names) left the
 * whole 1,376-test suite green. Both defect directions were invisible there.
 *
 * `secure` is per NAME and both settings are load-bearing in opposite
 * directions. `__Host-` REQUIRES Secure — RFC 6265bis §4.1.3.2 tells the UA to
 * ignore any `Set-Cookie` carrying that prefix without it, deletions included.
 * But a Secure `Set-Cookie` from a NON-trustworthy origin is also ignored
 * , and the bare name is exactly the cookie a plain-http install holds,
 * so setting it on both only moves the no-op from https to http. localhost hides
 * that, being trustworthy by definition, which is why the documented dev setup
 * never shows it (review catch, demonstrated in Chrome on a LAN-IP origin).
 */
export function sessionCookieClearOptions(name: string): {
	httpOnly: true;
	sameSite: "lax";
	path: "/";
	secure: boolean;
	maxAge: 0;
} {
	return {
		httpOnly: true,
		sameSite: "lax",
		path: "/",
		secure: name.startsWith("__Host-"),
		maxAge: 0,
	};
}

/**
 * Discriminated union on `mode`, `z.strictObject` per branch (#32 §3):
 * `sub` and `sessionGeneration` are REQUIRED in the `users` branch and
 * FORBIDDEN (not stripped) in every other. The earlier `z.object` payload
 * silently STRIPPED unknown keys and then cast — adding a field to the type
 * but not the schema compiled clean and yielded `undefined` at runtime. The
 * union makes those fail-closed shape claims parse-layer facts. There is
 * deliberately NO `role` claim: with DB-wins resolution a role inside a
 * signed token would be a required, authorization-shaped, never-read claim
 * (§3, refinement A).
 */
const timestamps = {
	/** issued-at (epoch ms) */
	iat: z.number().int().nonnegative(),
	/** idle expiry (epoch ms) */
	exp: z.number().int().nonnegative(),
	/** absolute expiry (epoch ms) — renewal never pushes past this */
	abs: z.number().int().nonnegative(),
};

const payloadSchema = z
	.discriminatedUnion("mode", [
		z.strictObject({
			...timestamps,
			mode: z.literal("users"),
			sub: z.uuid(),
			/** Exact DB generation whose credential was verified at sign-in. */
			sessionGeneration: z.number().int().nonnegative(),
			/** Pre-tenancy cookies remain confined to the migrated main organization. */
			organizationId: z.uuid().default("00000000-0000-4000-8000-000000000001"),
			targetUserId: z.uuid().optional(),
			impersonationExpiresAt: z.number().int().nonnegative().optional(),
			returnOrganizationId: z.uuid().optional(),
		}),
		z.strictObject({ ...timestamps, mode: z.literal("password") }),
		z.strictObject({ ...timestamps, mode: z.literal("oidc") }),
		z.strictObject({ ...timestamps, mode: z.literal("none") }),
	])
	.superRefine((payload, ctx) => {
		if (payload.mode !== "users") return;
		const hasTarget = payload.targetUserId !== undefined;
		if (
			hasTarget !== (payload.impersonationExpiresAt !== undefined) ||
			hasTarget !== (payload.returnOrganizationId !== undefined) ||
			(payload.impersonationExpiresAt !== undefined &&
				payload.impersonationExpiresAt > payload.abs)
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"View-as requires a target, expiry and return organization within the session lifetime",
			});
		}
	});

export type SessionPayload = z.infer<typeof payloadSchema>;

export type SessionVerdict =
	| { ok: true; payload: SessionPayload }
	| {
			ok: false;
			reason:
				| "absent"
				| "malformed"
				| "bad-signature"
				| "expired"
				| "stale-mode";
	  };

/**
 * `sessionsValidFrom` is an inclusive revocation cutoff: every cookie issued
 * at or before it is dead. Inclusive semantics close the same-millisecond
 * hole where an admin edit and the cookie it revokes can share Date.now.
 */
export function sessionIssuedAfterCutoff(
	issuedAtMs: number,
	cutoffMs: number,
): boolean {
	return issuedAtMs > cutoffMs;
}

/** Mint a replacement strictly after an inclusive revocation cutoff. */
export function issuedAtAfterCutoff(nowMs: number, cutoffMs: number): number {
	return Math.max(nowMs, cutoffMs + 1);
}

function signature(versionedBody: string, secret: string): string {
	return createHmac("sha256", secret).update(versionedBody).digest("base64url");
}

export function issueSession(input: {
	mode: AuthMode;
	now: number;
	idleMs: number;
	maxMs: number;
	/** REQUIRED when mode is "users" (parse-enforced at the mint boundary). */
	sub?: string;
	/** REQUIRED when mode is "users"; the gate requires exact DB equality. */
	sessionGeneration?: number;
	organizationId?: string;
	targetUserId?: string;
	impersonationExpiresAt?: number;
	returnOrganizationId?: string;
}): SessionPayload {
	const base = {
		iat: input.now,
		exp: input.now + Math.min(input.idleMs, input.maxMs),
		abs: input.now + input.maxMs,
	};
	// Through the schema, not a cast — issuing an invalid combination (users
	// without identity/generation, users-only fields outside users) must fail
	// HERE at mint, loudly.
	return payloadSchema.parse(
		input.mode === "users"
			? {
					...base,
					mode: "users",
					sub: input.sub,
					sessionGeneration: input.sessionGeneration,
					organizationId: input.organizationId,
					...(input.targetUserId ? { targetUserId: input.targetUserId } : {}),
					...(input.impersonationExpiresAt !== undefined
						? { impersonationExpiresAt: input.impersonationExpiresAt }
						: {}),
					...(input.returnOrganizationId
						? { returnOrganizationId: input.returnOrganizationId }
						: {}),
				}
			: { ...base, mode: input.mode },
	);
}

export function signSession(payload: SessionPayload, secret: string): string {
	const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
		"base64url",
	);
	const versioned = `${TOKEN_VERSION}.${body}`;
	return `${versioned}.${signature(versioned, secret)}`;
}

export function verifySession(
	token: string | undefined,
	secret: string,
	now: number,
	mode: AuthMode,
): SessionVerdict {
	if (!token) {
		return { ok: false, reason: "absent" };
	}
	const parts = token.split(".");
	if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
		return { ok: false, reason: "malformed" };
	}
	const body = parts[1] as string;
	const provided = Buffer.from(parts[2] as string, "utf8");
	const expected = Buffer.from(
		signature(`${TOKEN_VERSION}.${body}`, secret),
		"utf8",
	);
	// timingSafeEqual throws on a length mismatch, so the length check has to
	// come first; the length of an HMAC is not a secret.
	if (
		provided.length !== expected.length ||
		!timingSafeEqual(provided, expected)
	) {
		return { ok: false, reason: "bad-signature" };
	}
	let payload: SessionPayload;
	try {
		const parsed = payloadSchema.safeParse(
			JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
		);
		if (!parsed.success) {
			return { ok: false, reason: "malformed" };
		}
		payload = parsed.data;
	} catch {
		return { ok: false, reason: "malformed" };
	}
	if (
		payload.mode === "users" &&
		((payload.targetUserId !== undefined) !==
			(payload.impersonationExpiresAt !== undefined) ||
			(payload.targetUserId !== undefined) !==
				(payload.returnOrganizationId !== undefined) ||
			(payload.impersonationExpiresAt !== undefined &&
				payload.impersonationExpiresAt > payload.abs))
	)
		return { ok: false, reason: "malformed" };
	if (now >= payload.exp || now >= payload.abs) {
		return { ok: false, reason: "expired" };
	}
	// A cookie minted under a different AUTH_MODE must not survive the switch
	// (e.g. flipping none → password).
	if (payload.mode !== mode) {
		return { ok: false, reason: "stale-mode" };
	}
	return { ok: true, payload };
}

/**
 * Sliding renewal: re-issue once more than half the idle window has elapsed,
 * clamped to the absolute deadline. Returns null when there is nothing to
 * gain (which keeps Set-Cookie off most responses).
 */
export function renewSession(
	payload: SessionPayload,
	now: number,
	idleMs: number,
): SessionPayload | null {
	const nextExp = Math.min(now + idleMs, payload.abs);
	if (nextExp <= payload.exp || payload.exp - now > idleMs / 2) {
		return null;
	}
	return { ...payload, exp: nextExp };
}

export type CookieReader = {
	get(name: string): { value: string } | undefined;
};

/** Prefers the `__Host-` cookie; both names are HMAC-verified regardless. */
export function readSessionCookie(cookies: CookieReader): string | undefined {
	for (const name of SESSION_COOKIE_NAMES) {
		const found = cookies.get(name);
		if (found?.value) {
			return found.value;
		}
	}
	return undefined;
}

/**
 * https detection. `x-forwarded-proto` is trusted because TLS is normally
 * terminated by a reverse proxy; a client that forges it only makes us mint a
 * Secure cookie the browser then drops on http — self-inflicted, not an
 * escalation.
 */
export function requestIsHttps(headers: Headers, url: string): boolean {
	const forwarded = headers.get("x-forwarded-proto");
	if (forwarded) {
		return forwarded.split(",")[0]?.trim().toLowerCase() === "https";
	}
	try {
		return new URL(url).protocol === "https:";
	} catch {
		return false;
	}
}

export function sessionCookieName(secure: boolean): string {
	return secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}

export type SessionCookieOptions = {
	httpOnly: true;
	sameSite: "lax";
	path: "/";
	secure: boolean;
	maxAge: number;
};

/**
 * SameSite=Lax (not Strict) so following a link into the app still arrives
 * authenticated; the CSRF surface that Lax leaves open is top-level GET
 * navigation, and every state change here is a POST/DELETE on /api/* which
 * proxy.ts additionally rejects cross-site.
 */
export function sessionCookieOptions(
	secure: boolean,
	maxAgeSeconds: number,
): SessionCookieOptions {
	return {
		httpOnly: true,
		sameSite: "lax",
		path: "/",
		secure,
		maxAge: maxAgeSeconds,
	};
}

/** Cookie lifetime = the absolute deadline, so the browser drops it on its own. */
export function cookieMaxAgeSeconds(
	payload: SessionPayload,
	now: number,
): number {
	return Math.max(1, Math.ceil((payload.abs - now) / 1000));
}
