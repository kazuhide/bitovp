import { getIdentityPrisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { loadAuthConfig } from "@/lib/auth/config";
import {
	cookieMaxAgeSeconds,
	issuedAtAfterCutoff,
	issueSession,
	requestIsHttps,
	sessionCookieName,
	sessionCookieOptions,
	signSession,
} from "@/lib/auth/session";
import { consumeSetupCode } from "@/lib/auth/setup-code";
import { DEFAULT_ORGANIZATION_ID } from "@/lib/auth/tenancy";
import {
	bumpUsersExist,
	hashPassword,
	normalizeEmail,
	passwordPolicyError,
} from "@/lib/auth/users";
import { jsonError } from "@/lib/server/http";
import { clientKey, createTokenBucketLimiter } from "@/lib/server/rate-limit";
import { readBoundedJson } from "@/lib/server/request-body";
import { MAX_SETUP_BODY_BYTES } from "@/lib/server/request-body-limits";

/**
 * First-boot admin creation . Lives under /api/auth — the
 * existing exemption prefix — so gate-coverage FORCES its named
 * API_EXEMPTIONS entry; it fails closed on its own the moment users exist,
 * re-checked INSIDE the Serializable transaction (two holders of a leaked
 * code cannot both become admin; the CAS burn in consumeSetupCode is the
 * first control, this transaction is the second).
 */

/**
 * Explicit budgets — the login route's are module-local consts and a new
 * route inherits NOTHING . Charged only on a WRONG code (the login
 * route's hard-won order): junk bodies and the zero-users 409s never touch
 * them, so they cannot be drained for free and a correct code is never
 * refused. On a fresh install a drainable arrival budget would mean setup
 * can never complete.
 */
const globalFailures = createTokenBucketLimiter({
	capacity: 20,
	refillPerMinute: 10,
});
const perIpFailures = createTokenBucketLimiter({
	capacity: 6,
	refillPerMinute: 3,
});

const bodySchema = z.strictObject({
	code: z.string().min(8).max(64),
	email: z.string().min(3).max(320),
	displayName: z.string().min(1).max(120),
	password: z.string().min(1).max(512),
});

export async function POST(req: Request) {
	const config = loadAuthConfig();
	if (!config.ok) {
		return jsonError(503, "Authentication is not configured", config.reason);
	}
	if (config.settings.mode !== "users") {
		return jsonError(
			409,
			"Initial administrator setup is not available with the current authentication settings",
		);
	}
	const body = await readBoundedJson(req, MAX_SETUP_BODY_BYTES);
	if (body.tooLarge) {
		return jsonError(413, "Request body is too large");
	}
	const parsed = bodySchema.safeParse(body.value);
	if (!parsed.success) {
		return jsonError(400, "code, email, displayName and password are required");
	}
	const policyError = passwordPolicyError(parsed.data.password);
	if (policyError) {
		return jsonError(422, policyError);
	}
	const ip = clientKey(req);
	if (!globalFailures.peek("all") || !perIpFailures.peek(ip)) {
		return jsonError(429, "Too many setup attempts — wait and retry");
	}

	const codeOk = await consumeSetupCode(parsed.data.code);
	if (!codeOk) {
		globalFailures.take("all");
		perIpFailures.take(ip);
		return jsonError(401, "Setup code is wrong, expired, or already used");
	}

	// scrypt BEFORE the transaction — ~19ms of CPU inside a Serializable
	// window would widen the conflict surface for nothing.
	const passwordHash = hashPassword(parsed.data.password);
	const email = normalizeEmail(parsed.data.email);
	const prisma = getIdentityPrisma();
	let admin: {
		id: string;
		sessionsValidFrom: Date;
		sessionGeneration: number;
	};
	try {
		admin = await prisma.$transaction(
			async (tx) => {
				// Same all-identity predicate as the gate, inside Serializable.
				// Deactivation must never reopen a claim-platform-owner window.
				const count = await tx.user.count();
				if (count > 0) {
					throw new SetupAlreadyDone();
				}
				const created = await tx.user.create({
					data: {
						email,
						displayName: parsed.data.displayName.trim(),
						passwordHash,
						role: "ADMIN",
						platformOwner: true,
						// The setup admin CHOSE this password — no forced rotate.
					},
					select: {
						id: true,
						sessionsValidFrom: true,
						sessionGeneration: true,
					},
				});
				await tx.membership.create({
					data: {
						userId: created.id,
						organizationId: DEFAULT_ORGANIZATION_ID,
						role: "ADMIN",
					},
				});
				return created;
			},
			{ isolationLevel: "Serializable" },
		);
	} catch (err) {
		if (err instanceof SetupAlreadyDone) {
			return jsonError(409, "Setup is already complete — sign in at /login");
		}
		if ((err as { code?: string }).code === "P2034") {
			// Losing the serialization race IS the already-done case.
			return jsonError(409, "Setup is already complete — sign in at /login");
		}
		throw err;
	}
	bumpUsersExist();

	const now = Date.now();
	const payload = issueSession({
		mode: "users",
		now: issuedAtAfterCutoff(now, admin.sessionsValidFrom.getTime()),
		idleMs: config.settings.idleMs,
		maxMs: config.settings.maxMs,
		sub: admin.id,
		sessionGeneration: admin.sessionGeneration,
	});
	const https = requestIsHttps(req.headers, req.url);
	const res = NextResponse.json(
		{ ok: true, email },
		{ status: 201, headers: { "cache-control": "no-store" } },
	);
	res.cookies.set(
		sessionCookieName(https),
		signSession(payload, config.settings.sessionSecret),
		sessionCookieOptions(https, cookieMaxAgeSeconds(payload, now)),
	);
	return res;
}

class SetupAlreadyDone extends Error {}
