import { NextResponse } from "next/server";
import { loadAuthConfig } from "@/lib/auth/config";
import { resolveProvider } from "@/lib/auth/provider";
import { readSessionCookie, verifySession } from "@/lib/auth/session";
import {
	listOrganizations,
	resolveAuthenticatedContext,
	resolveSessionIdentity,
} from "@/lib/auth/tenancy";

const PRIVATE_NO_STORE = {
	headers: { "cache-control": "private, no-store" },
} as const;

/** Every answer is identity/session-derived, including configured:false. */
function sessionJson(body: Record<string, unknown>) {
	return NextResponse.json(body, PRIVATE_NO_STORE);
}

/**
 * Session state for the login screen and the app shell's sign-out control.
 * Gate-exempt (it is part of the /api/auth handshake), so it deliberately
 * reveals only: which mode is configured, whether the caller holds a valid
 * cookie, and a stable reason code when setup needs administrator attention.
 * Raw environment/provider diagnostics stay server-side.
 */
export async function GET(req: Request) {
	const config = loadAuthConfig();
	if (!config.ok) {
		return sessionJson({
			mode: "password",
			configured: false,
			authenticated: false,
			loginKind: "password-form",
			reasonCode: "AUTH_NOT_CONFIGURED",
		});
	}
	const { settings } = config;
	const provider = resolveProvider(settings);
	const readiness = provider.readiness();
	if (!readiness.ready) {
		return sessionJson({
			mode: settings.mode,
			configured: false,
			authenticated: false,
			loginKind: provider.loginKind,
			reasonCode: "AUTH_PROVIDER_UNAVAILABLE",
		});
	}
	if (settings.mode !== "password" && settings.mode !== "users") {
		// mode none: every guarded path is open, so the caller is "authenticated"
		// in the only sense the UI cares about.
		return sessionJson({
			mode: settings.mode,
			configured: true,
			authenticated: settings.mode === "none",
			loginKind: provider.loginKind,
		});
	}
	const cookies = new Map<string, { value: string }>();
	for (const cookie of parseCookieHeader(req.headers.get("cookie"))) {
		cookies.set(cookie.name, { value: cookie.value });
	}
	const now = Date.now();
	const verdict = verifySession(
		readSessionCookie({ get: (name) => cookies.get(name) }),
		settings.sessionSecret,
		now,
		settings.mode,
	);
	if (settings.mode === "users") {
		// #32 §3, the NAMED exception to "no second verification path": this
		// route is api-exempt (forwarded as "anonymous" — it receives neither
		// the actor nor the role header by construction), so it verifies the
		// cookie itself. This browser-polled endpoint deliberately bypasses the
		// gate's process-local resolver cache: stacking a 60-second cache behind
		// a 60-second poll could take nearly 120 seconds to observe a role change
		// on a multi-web deployment. The fresh read also refreshes this process's
		// cache. The menu reads THIS value — the cookie carries no role claim.
		if (!verdict.ok || verdict.payload.mode !== "users") {
			return sessionJson({
				mode: settings.mode,
				configured: true,
				authenticated: false,
				loginKind: provider.loginKind,
			});
		}
		try {
			const identity = await resolveSessionIdentity(req.headers);
			const organizations = await listOrganizations(identity.user.id);
			let context: Awaited<ReturnType<typeof resolveAuthenticatedContext>>;
			try {
				context = await resolveAuthenticatedContext(req.headers);
			} catch {
				// Only identity recovery/forced rotation stays available. No tenant scope is asserted.
				if (!identity.user.platformOwner && !identity.user.mustChangePassword)
					throw new Error("Organization unavailable");
				return sessionJson({
					mode: settings.mode,
					configured: true,
					authenticated: true,
					loginKind: provider.loginKind,
					displayName: identity.user.displayName,
					email: identity.user.email,
					platformOwner: identity.user.platformOwner === true,
					...(identity.user.platformOwner && !identity.user.mustChangePassword
						? { role: "ADMIN" }
						: {}),
					mustChangePassword: identity.user.mustChangePassword,
					organizationUnavailable: true,
					organizations,
					actorUserId: identity.user.id,
					isImpersonating: identity.payload.targetUserId !== undefined,
					expiresAt: new Date(identity.payload.exp).toISOString(),
					absoluteExpiresAt: new Date(identity.payload.abs).toISOString(),
				});
			}
			return sessionJson({
				mode: settings.mode,
				configured: true,
				authenticated: true,
				loginKind: provider.loginKind,
				displayName: identity.user.displayName,
				email: identity.user.email,
				role: context.role,
				mustChangePassword: identity.user.mustChangePassword,
				platformOwner: context.platformOwner,
				organizationId: context.organizationId,
				organizationName: context.organizationName,
				organizations,
				actorUserId: context.actorUserId,
				effectiveUserId: context.effectiveUserId,
				isImpersonating: context.isImpersonating,
				targetDisplayName: context.targetDisplayName,
				impersonationExpiresAt: identity.payload.impersonationExpiresAt,
				expiresAt: new Date(identity.payload.exp).toISOString(),
				absoluteExpiresAt: new Date(identity.payload.abs).toISOString(),
			});
		} catch {
			return sessionJson({
				mode: settings.mode,
				configured: true,
				authenticated: false,
				loginKind: provider.loginKind,
			});
		}
	}
	return sessionJson({
		mode: settings.mode,
		configured: true,
		authenticated: verdict.ok,
		loginKind: provider.loginKind,
		...(verdict.ok
			? {
					expiresAt: new Date(verdict.payload.exp).toISOString(),
					absoluteExpiresAt: new Date(verdict.payload.abs).toISOString(),
				}
			: {}),
	});
}

/** Plain Request has no cookie jar; this route is testable without NextRequest. */
function parseCookieHeader(
	header: string | null,
): { name: string; value: string }[] {
	if (!header) {
		return [];
	}
	return header
		.split(";")
		.map((part) => {
			const index = part.indexOf("=");
			if (index === -1) {
				return null;
			}
			const raw = part.slice(index + 1).trim();
			let value: string;
			try {
				value = decodeURIComponent(raw);
			} catch {
				// A lone "%" makes decodeURIComponent throw; a malformed cookie must
				// read as "no session", not as a 500.
				value = raw;
			}
			return { name: part.slice(0, index).trim(), value };
		})
		.filter(
			(entry): entry is { name: string; value: string } => entry !== null,
		);
}
