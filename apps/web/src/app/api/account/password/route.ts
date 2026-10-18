import { getIdentityPrisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { loadAuthConfig } from "@/lib/auth/config";
import { authError } from "@/lib/auth/route-context";
import {
	cookieMaxAgeSeconds,
	issuedAtAfterCutoff,
	issueSession,
	requestIsHttps,
	sessionCookieName,
	sessionCookieOptions,
	signSession,
} from "@/lib/auth/session";
import { resolveSessionIdentity } from "@/lib/auth/tenancy";
import {
	accountBackoffRemainingMs,
	chargeAccountFailure,
	clearAccountFailures,
	hashPassword,
	invalidateUserCache,
	passwordPolicyError,
	verifyUserLogin,
} from "@/lib/auth/users";
import { jsonError, readJson } from "@/lib/server/http";

/**
 * Self-service password change  — the ONE api-guarded path a
 * forced-rotate session may reach (the gate allowlists it by name). Proving
 * the CURRENT password again here means a stolen live session cannot
 * silently swap the credential.
 *
 * The sessionsValidFrom bump kills every outstanding cookie INCLUDING the
 * one that made this request — so the response reissues a fresh session in
 * the same breath, one millisecond beyond the inclusive revocation cutoff.
 */
const bodySchema = z.strictObject({
	currentPassword: z.string().min(1).max(512),
	newPassword: z.string().min(1).max(512),
});

export async function POST(req: Request) {
	const config = loadAuthConfig();
	if (!config.ok) {
		return jsonError(503, "Authentication is not configured", config.reason);
	}
	if (config.settings.mode !== "users") {
		return jsonError(
			409,
			"Password changes are not available with the current authentication settings",
		);
	}
	let identity: Awaited<ReturnType<typeof resolveSessionIdentity>>;
	try {
		identity = await resolveSessionIdentity(req.headers);
	} catch (err) {
		return authError(err);
	}
	if (identity.payload.targetUserId)
		return jsonError(403, "Exit view-as before changing your password");
	const userId = identity.user.id;
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return jsonError(400, "currentPassword and newPassword are required");
	}
	const policyError = passwordPolicyError(parsed.data.newPassword);
	if (policyError) {
		return jsonError(422, policyError);
	}
	const prisma = getIdentityPrisma();
	const row = await prisma.user.findUnique({
		where: { id: userId },
		select: { email: true },
	});
	if (!row) {
		return jsonError(403, "A signed-in user session is required");
	}
	// review-32 m2: the re-prove is the whole point of this route, so it is
	// metered per account like login — a stolen SESSION must not brute-force
	// currentPassword unthrottled.
	const waitMs = accountBackoffRemainingMs(row.email);
	if (waitMs > 0) {
		return NextResponse.json(
			{ error: "Too many failed attempts — wait and retry" },
			{
				status: 429,
				headers: { "retry-after": String(Math.ceil(waitMs / 1000)) },
			},
		);
	}
	// Re-prove the CURRENT password (constant-work path shared with login).
	// An expired temp password is still the right proof for ROTATING it —
	// that is exactly what expiry demands — so only `invalid` refuses.
	const verdict = await verifyUserLogin(row.email, parsed.data.currentPassword);
	if (!verdict.ok && verdict.reason === "invalid") {
		chargeAccountFailure(row.email);
		return jsonError(401, "Current password is wrong");
	}
	clearAccountFailures(row.email);
	const now = Date.now();
	const verifiedCredential = verdict.verifiedCredential;
	const changed = await prisma.user.updateMany({
		// A current-password proof is a snapshot taken before async scrypt. An
		// admin reset (or a concurrent self-change) must win rather than being
		// overwritten afterward. Match both the ordered generation and the exact
		// hash that was verified; either changing makes this CAS lose.
		where: {
			id: userId,
			active: true,
			sessionGeneration: verifiedCredential.sessionGeneration,
			passwordHash: verifiedCredential.passwordHash,
		},
		data: {
			passwordHash: hashPassword(parsed.data.newPassword),
			mustChangePassword: false,
			passwordExpiresAt: null,
			// Kills every outstanding cookie for this user (§2/§7 — the
			// phished-cookie-survives-password-change hole).
			sessionsValidFrom: new Date(now),
			sessionGeneration: { increment: 1 },
		},
	});
	if (changed.count !== 1) {
		return jsonError(
			409,
			"The credential changed while it was verified — retry with the current password",
		);
	}
	invalidateUserCache(userId);
	const payload = issueSession({
		mode: "users",
		now: issuedAtAfterCutoff(now, now),
		idleMs: config.settings.idleMs,
		maxMs: config.settings.maxMs,
		sub: userId,
		organizationId: identity.payload.organizationId,
		sessionGeneration: verifiedCredential.sessionGeneration + 1,
	});
	const https = requestIsHttps(req.headers, req.url);
	const res = NextResponse.json(
		{ ok: true },
		{ headers: { "cache-control": "no-store" } },
	);
	res.cookies.set(
		sessionCookieName(https),
		signSession(payload, config.settings.sessionSecret),
		sessionCookieOptions(https, cookieMaxAgeSeconds(payload, now)),
	);
	return res;
}
