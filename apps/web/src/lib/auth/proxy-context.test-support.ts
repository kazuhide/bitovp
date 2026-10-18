import type { AuthContextError, AuthenticatedContext } from "./tenancy";

const DEFAULT_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
function cookiesFromHeaders(headers: Headers) {
	return {
		get: (name: string) => {
			const value = (headers.get("cookie") ?? "")
				.split(";")
				.find((item) => item.trim().startsWith(`${name}=`))
				?.trim()
				.slice(name.length + 1);
			return value === undefined ? undefined : { value };
		},
	};
}

import { bearerToken } from "./api-token";
import { loadAuthConfig } from "./config";
import { parseRole, UNKNOWN_ROLE_CEILING } from "./roles";
import { readSessionCookie, verifySession } from "./session";
import type { ResolvedUser } from "./users";
/** Proxy wiring fixture: credential primitives and the context resolver have separate real tests. */
export function proxyContextFixture(
	tokenVerifier: (token: string) => Promise<{
		ok: boolean;
		tokenId?: string;
		role?: string;
		reason?: string;
	}>,
	userResolver: (() => Promise<ResolvedUser | null>) | undefined,
	ErrorClass: typeof AuthContextError,
) {
	return async (headers: Headers): Promise<AuthenticatedContext> => {
		const config = loadAuthConfig();
		if (!config.ok)
			throw new ErrorClass(503, "Authentication is not configured");
		const base = {
			organizationId: DEFAULT_ORGANIZATION_ID,
			organizationName: "Main",
			actorUserId: null,
			effectiveUserId: null,
			role: "ADMIN" as const,
			actorRole: "ADMIN" as const,
			platformOwner: false,
			isImpersonating: false,
			targetDisplayName: null,
		};
		const token = bearerToken(headers.get("authorization"));
		if (token !== null) {
			const verdict = await tokenVerifier(token);
			if (!verdict.ok)
				throw new ErrorClass(
					verdict.reason === "unavailable" ? 503 : 401,
					verdict.reason === "unavailable"
						? "Token verification is unavailable (database)"
						: `Invalid API token (${verdict.reason})`,
				);
			const role = parseRole(verdict.role ?? "");
			return {
				...base,
				actor: `token:${verdict.tokenId}`,
				role:
					role ??
					(config.settings.mode === "users" ? "VIEWER" : UNKNOWN_ROLE_CEILING),
				actorRole: role ?? UNKNOWN_ROLE_CEILING,
				tokenRoleKnown: role !== null,
			};
		}
		if (config.settings.mode === "users") {
			const user = await userResolver?.();
			const verdict = verifySession(
				readSessionCookie(cookiesFromHeaders(headers)),
				config.settings.sessionSecret,
				Date.now(),
				"users",
			);
			if (!user || !verdict.ok || verdict.payload.mode !== "users")
				throw new ErrorClass(401, "Authentication required");
			return {
				...base,
				organizationId: verdict.payload.organizationId,
				actor: `user:${user.id}`,
				actorUserId: user.id,
				effectiveUserId: user.id,
				role: user.role,
				actorRole: user.role,
				platformOwner: user.platformOwner === true,
				user,
				payload: verdict.payload,
			};
		}
		return {
			...base,
			actor: config.settings.mode === "none" ? "none" : "session",
		};
	};
}
