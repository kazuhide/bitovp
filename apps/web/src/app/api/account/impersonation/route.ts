import { getIdentityPrisma } from "@bitovp/db";
import { z } from "zod";
import { loadAuthConfig } from "@/lib/auth/config";
import { authError, sessionResponse } from "@/lib/auth/route-context";
import { signSession } from "@/lib/auth/session";
import {
	AuthContextError,
	requirePlatformOwner,
	resolveAuthenticatedContext,
	resolveSessionIdentity,
} from "@/lib/auth/tenancy";
import {
	accountBackoffRemainingMs,
	chargeAccountFailure,
	clearAccountFailures,
	verifyUserLogin,
} from "@/lib/auth/users";

const schema = z.strictObject({
	organizationId: z.uuid(),
	targetUserId: z.uuid(),
	currentPassword: z.string().min(1).max(512),
});
export async function POST(req: Request) {
	try {
		const { user, payload } = await requirePlatformOwner(req.headers);
		const input = schema.safeParse(await req.json());
		if (!input.success) return new Response(null, { status: 400 });
		const waitMs = accountBackoffRemainingMs(user.email);
		if (waitMs > 0)
			return new Response(
				JSON.stringify({ error: "Too many failed attempts — wait and retry" }),
				{
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after": String(Math.ceil(waitMs / 1000)),
					},
				},
			);
		const proof = await verifyUserLogin(user.email, input.data.currentPassword);
		if (!proof.ok) {
			chargeAccountFailure(user.email);
			throw new AuthContextError(401, "Current password is incorrect");
		}
		clearAccountFailures(user.email);
		const verified = proof.verifiedCredential;
		const claimed = await getIdentityPrisma().user.updateMany({
			where: {
				id: user.id,
				active: true,
				platformOwner: true,
				sessionGeneration: payload.sessionGeneration,
				passwordHash: verified.passwordHash,
			},
			data: { lastLoginAt: new Date() },
		});
		if (
			claimed.count !== 1 ||
			verified.sessionGeneration !== payload.sessionGeneration
		)
			throw new AuthContextError(409, "Credentials changed — sign in again");
		const next = {
			...payload,
			returnOrganizationId: payload.organizationId,
			organizationId: input.data.organizationId,
			targetUserId: input.data.targetUserId,
			impersonationExpiresAt: Math.min(payload.abs, Date.now() + 15 * 60_000),
		};
		const config = loadAuthConfig();
		if (!config.ok || config.settings.mode !== "users")
			throw new AuthContextError(503, "User authentication is unavailable");
		const secret = config.settings.sessionSecret;
		const headers = new Headers(req.headers);
		headers.delete("authorization");
		headers.delete("x-bitovp-expected-org");
		await resolveAuthenticatedContext(headers, {
			get: (name) =>
				name === "bitovp_session"
					? { value: signSession(next, secret) }
					: undefined,
		});
		return sessionResponse(req, next);
	} catch (err) {
		return authError(err);
	}
}
export async function DELETE(req: Request) {
	try {
		const { payload } = await resolveSessionIdentity(req.headers);
		const {
			targetUserId: _target,
			impersonationExpiresAt: _expiry,
			returnOrganizationId,
			...prior
		} = payload;
		const next = {
			...prior,
			organizationId: returnOrganizationId ?? prior.organizationId,
		};
		// The caller can recover even when the target org was disabled or IP policy changed.
		return sessionResponse(req, next);
	} catch (err) {
		return authError(err);
	}
}
