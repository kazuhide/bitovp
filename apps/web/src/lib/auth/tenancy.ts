import "server-only";
import {
	getIdentityPrisma,
	resolveApiTokenForAuthentication,
	type UserRole,
} from "@bitovp/db";
import { bearerToken, createTokenVerifier, tokenPrefixOf } from "./api-token";
import { loadAuthConfig } from "./config";
import { ipAllowedByPolicy, verifiedClientIp } from "./ip-policy";
import { parseRole, UNKNOWN_ROLE_CEILING } from "./roles";
import {
	type CookieReader,
	readSessionCookie,
	type SessionPayload,
	sessionIssuedAfterCutoff,
	verifySession,
} from "./session";
import { type ResolvedUser, resolveUserByIdFresh } from "./users";

export const DEFAULT_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
export const ORGANIZATION_HEADER = "x-bitovp-organization";
export const EXPECTED_ORGANIZATION_HEADER = "x-bitovp-expected-org";
export const EFFECTIVE_USER_HEADER = "x-bitovp-effective-user";
export const IMPERSONATION_HEADER = "x-bitovp-impersonating";

export class AuthContextError extends Error {
	constructor(
		public readonly status: 401 | 403 | 409 | 503,
		message: string,
		public readonly context?: AuthenticatedContext,
	) {
		super(message);
	}
}
export type AuthenticatedContext = {
	organizationId: string;
	actorUserId: string | null;
	effectiveUserId: string | null;
	role: UserRole;
	actorRole: UserRole;
	platformOwner: boolean;
	isImpersonating: boolean;
	organizationName: string;
	targetDisplayName: string | null;
	actor: string;
	tokenRoleKnown?: boolean;
	user?: ResolvedUser;
	payload?: SessionPayload;
};

export function cookiesFromHeaders(headers: Headers): CookieReader {
	const values = new Map<string, string>();
	for (const part of (headers.get("cookie") ?? "").split(";")) {
		const split = part.indexOf("=");
		if (split < 0) continue;
		const value = part.slice(split + 1).trim();
		try {
			values.set(part.slice(0, split).trim(), decodeURIComponent(value));
		} catch {
			values.set(part.slice(0, split).trim(), value);
		}
	}
	return {
		get: (name) => {
			const value = values.get(name);
			return value === undefined ? undefined : { value };
		},
	};
}

export async function resolveSessionIdentity(
	headers: Headers,
	cookies: CookieReader = cookiesFromHeaders(headers),
) {
	if (bearerToken(headers.get("authorization")) !== null)
		throw new AuthContextError(403, "A human user session is required");
	const config = loadAuthConfig();
	if (!config.ok)
		throw new AuthContextError(503, "Authentication is not configured");
	if (config.settings.mode !== "users")
		throw new AuthContextError(403, "A user session is required");
	const now = Date.now();
	const verdict = verifySession(
		readSessionCookie(cookies),
		config.settings.sessionSecret,
		now,
		"users",
	);
	if (!verdict.ok || verdict.payload.mode !== "users")
		throw new AuthContextError(401, "Authentication required");
	const user = await resolveUserByIdFresh(verdict.payload.sub, now);
	if (
		!user?.active ||
		user.sessionGeneration !== verdict.payload.sessionGeneration ||
		!sessionIssuedAfterCutoff(verdict.payload.iat, user.sessionsValidFromMs)
	)
		throw new AuthContextError(401, "Session is no longer valid");
	return { user, payload: verdict.payload };
}

/** Authentication and tenancy are derived from credentials, never forwarded headers. */
export async function resolveAuthenticatedContext(
	headers: Headers,
	cookies?: CookieReader,
): Promise<AuthenticatedContext> {
	try {
		return await resolveContext(headers, cookies);
	} catch (err) {
		if (err instanceof AuthContextError) throw err;
		throw new AuthContextError(503, "Authentication is unavailable (database)");
	}
}

async function resolveContext(
	headers: Headers,
	cookies?: CookieReader,
): Promise<AuthenticatedContext> {
	const config = loadAuthConfig();
	if (!config.ok)
		throw new AuthContextError(503, "Authentication is not configured");
	const settings = config.settings;
	let context: Omit<AuthenticatedContext, "organizationName">;
	const token = bearerToken(headers.get("authorization"));
	if (token !== null) {
		// Deliberately uncached: tenant/credential revocation takes effect next request.
		const prefix = tokenPrefixOf(token);
		if (!prefix) throw new AuthContextError(401, "Invalid API token");
		const row = await resolveApiTokenForAuthentication(prefix);
		const verify = createTokenVerifier({ load: async () => row, ttlMs: 0 });
		const verdict = await verify(token);
		if (!verdict.ok)
			throw new AuthContextError(
				verdict.reason === "unavailable" ? 503 : 401,
				verdict.reason === "unavailable"
					? "Token verification is unavailable (database)"
					: `Invalid API token (${verdict.reason})`,
			);
		const role = row ? parseRole(row.role) : null;
		if (
			row &&
			settings.mode !== "users" &&
			row.organizationId !== DEFAULT_ORGANIZATION_ID
		)
			throw new AuthContextError(
				403,
				"Legacy authentication is confined to the main organization",
			);
		if (!row) throw new AuthContextError(401, "Invalid API token");
		if (!row.userId && row.organizationId !== DEFAULT_ORGANIZATION_ID)
			throw new AuthContextError(
				403,
				"Legacy tokens are confined to the main organization",
			);
		let effectiveRole =
			role ?? (settings.mode === "users" ? "VIEWER" : UNKNOWN_ROLE_CEILING);
		let owner: ResolvedUser | null = null;
		let actorRole = effectiveRole;
		if (row.userId) {
			owner = await resolveUserByIdFresh(row.userId);
			const member = await getIdentityPrisma().membership.findUnique({
				where: {
					userId_organizationId: {
						userId: row.userId,
						organizationId: row.organizationId,
					},
				},
				select: { active: true, role: true },
			});
			if (!owner?.active || owner.mustChangePassword || !member?.active)
				throw new AuthContextError(
					403,
					"Token owner membership is unavailable",
				);
			actorRole = member.role;
			const rank = { ADMIN: 3, OPERATOR: 2, VIEWER: 1 };
			effectiveRole =
				rank[effectiveRole] <= rank[member.role] ? effectiveRole : member.role;
		}
		context = {
			organizationId: row.organizationId,
			actorUserId: owner?.id ?? null,
			effectiveUserId: null,
			role: effectiveRole,
			actorRole,
			platformOwner: owner?.platformOwner === true,
			isImpersonating: false,
			targetDisplayName: null,
			tokenRoleKnown: role !== null,
			user: owner ?? undefined,
			actor: `token:${row.id}`,
		};
	} else if (settings.mode === "users") {
		const { user, payload } = await resolveSessionIdentity(headers, cookies);
		if (user.mustChangePassword)
			throw new AuthContextError(403, "Password change required");
		const targetId = payload.targetUserId ?? user.id;
		const impersonating = payload.targetUserId !== undefined;
		let target = user;
		if (impersonating) {
			if (
				!user.platformOwner ||
				!payload.impersonationExpiresAt ||
				Date.now() >= payload.impersonationExpiresAt ||
				user.mustChangePassword
			)
				throw new AuthContextError(403, "View-as session is not permitted");
			const resolved = await resolveUserByIdFresh(targetId);
			if (!resolved?.active || resolved.mustChangePassword)
				throw new AuthContextError(403, "View-as target is unavailable");
			target = resolved;
		}
		const membership = await getIdentityPrisma().membership.findUnique({
			where: {
				userId_organizationId: {
					userId: targetId,
					organizationId: payload.organizationId,
				},
			},
			select: { role: true, active: true },
		});
		if (!membership?.active)
			throw new AuthContextError(403, "Organization membership is required");
		context = {
			organizationId: payload.organizationId,
			actorUserId: user.id,
			effectiveUserId: targetId,
			role: membership.role,
			actorRole: membership.role,
			platformOwner: user.platformOwner === true,
			isImpersonating: impersonating,
			targetDisplayName: impersonating ? target.displayName : null,
			actor: `user:${user.id}`,
			user,
			payload,
		};
	} else if (settings.mode === "none" || settings.mode === "password") {
		if (settings.mode === "password") {
			const verdict = verifySession(
				readSessionCookie(cookies ?? cookiesFromHeaders(headers)),
				settings.sessionSecret,
				Date.now(),
				"password",
			);
			if (!verdict.ok)
				throw new AuthContextError(401, "Authentication required");
		}
		context = {
			organizationId: DEFAULT_ORGANIZATION_ID,
			actorUserId: null,
			effectiveUserId: null,
			role: "ADMIN",
			actorRole: "ADMIN",
			platformOwner: false,
			isImpersonating: false,
			targetDisplayName: null,
			actor: settings.mode === "none" ? "none" : "session",
		};
	} else
		throw new AuthContextError(503, "Authentication provider is unavailable");
	const org = await getIdentityPrisma().organization.findUnique({
		where: { id: context.organizationId },
		select: { name: true, active: true, allowedIpCidrs: true },
	});
	if (!org?.active)
		throw new AuthContextError(403, "Organization is unavailable");
	const resolved = { ...context, organizationName: org.name };
	if (!ipAllowedByPolicy(org.allowedIpCidrs, verifiedClientIp(headers)))
		throw new AuthContextError(
			403,
			"Client IP is not allowed for this organization",
			resolved,
		);
	const expected = headers.get(EXPECTED_ORGANIZATION_HEADER);
	if (expected !== null && expected !== context.organizationId)
		throw new AuthContextError(
			409,
			"Organization changed — reload before continuing",
			resolved,
		);
	return resolved;
}

export async function listOrganizations(userId: string) {
	const memberships = await getIdentityPrisma().membership.findMany({
		where: { userId, active: true, organization: { active: true } },
		select: {
			role: true,
			organization: { select: { id: true, name: true, slug: true } },
		},
		orderBy: { organizationId: "asc" },
	});
	return memberships.map((row) => ({ ...row.organization, role: row.role }));
}

/** Guarded APIs verify these again even when directly invoked without Next proxy. */
export async function requireOrganizationAdmin(headers: Headers) {
	const context = await resolveAuthenticatedContext(headers);
	if (context.isImpersonating || context.role !== "ADMIN")
		throw new AuthContextError(
			403,
			"An organization administrator is required",
		);
	return context;
}
export async function requirePlatformOwner(headers: Headers) {
	const identity = await resolveSessionIdentity(headers);
	if (
		!identity.user.platformOwner ||
		identity.user.mustChangePassword ||
		identity.payload.targetUserId
	)
		throw new AuthContextError(403, "A platform owner session is required");
	return identity;
}
