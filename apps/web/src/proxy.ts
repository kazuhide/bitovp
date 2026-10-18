import { type NextRequest, NextResponse } from "next/server";
import { ACTOR_HEADER, bearerToken } from "@/lib/auth/api-token-gate";
import { loadAuthConfig } from "@/lib/auth/config";
import { classifyPath, loginPath, type PathClass } from "@/lib/auth/gate";
import { ingressHostname } from "@/lib/auth/ingress-allowlist";
import { resolveProvider } from "@/lib/auth/provider";
import { publicContextError } from "@/lib/auth/public-context-error";
import {
	evaluateRole,
	isSelfTokenRevocation,
	ROLE_HEADER,
} from "@/lib/auth/roles";
import {
	cookieMaxAgeSeconds,
	readSessionCookie,
	renewSession,
	requestIsHttps,
	SESSION_COOKIE_NAMES,
	sessionCookieClearOptions,
	sessionCookieName,
	sessionCookieOptions,
	sessionIssuedAfterCutoff,
	signSession,
	verifySession,
} from "@/lib/auth/session";
import {
	AuthContextError,
	type AuthenticatedContext,
	EFFECTIVE_USER_HEADER,
	EXPECTED_ORGANIZATION_HEADER,
	IMPERSONATION_HEADER,
	ORGANIZATION_HEADER,
	resolveAuthenticatedContext,
} from "@/lib/auth/tenancy";
import {
	anyUsersExist,
	resolveUserByIdFresh as resolveUserById,
} from "@/lib/auth/users";
import { viewAsMayRead } from "@/lib/auth/view-as";
import { recordAccessNonAdmin } from "@/lib/server/access-audit";

/**
 * Request guard (Next 16 "proxy" convention, ex-middleware). Two layers, in
 * order: the P0 cross-site/Host guard on /api/* (unchanged), then the P5 auth
 * gate on everything the matcher sees. The cross-site layer stays scoped to
 * /api/* deliberately — a top-level page navigation from another site is a
 * legitimate `Sec-Fetch-Site: cross-site` request, so applying it to pages
 * would 403 an ordinary inbound link.
 *
 * `proxy.ts` runs on the NODE runtime, not the edge one (Next's build reports
 * `"runtime": "nodejs"` for it in functions-config-manifest.json), which is
 * what lets the session gate use node:crypto directly.
 *
 * Host/Origin are validated against an ALLOWLIST, not against each other:
 * comparing Origin to the reflected Host header is DNS-rebinding-weak (a
 * rebound hostname reflects itself and passes). Defaults cover local dev;
 * a deliberate exposure sets ALLOWED_ORIGIN_HOSTS to the public hostname —
 * and the hostname of the persisted public ingress (WP-G G-1: a tunnel's
 * name is minted at runtime) is accepted beside it, read on a miss only.
 */
const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1"];

/** ALLOWED_ORIGIN_HOSTS: comma-separated hostnames (any port), overriding the default. */
function allowedHostnames(): string[] {
	const raw = process.env.ALLOWED_ORIGIN_HOSTS;
	if (!raw || raw.trim() === "") {
		return DEFAULT_ALLOWED_HOSTS;
	}
	return raw
		.split(",")
		.map((host) => host.trim().toLowerCase())
		.filter((host) => host !== "");
}

/**
 * hostname (no port) of a Host-style header value, or null if unparsable.
 * The PORT-LESS match is intentional (review-noted): a cross-PORT page
 * (localhost:8080 → localhost:3100) shares the hostname, but different
 * ports are cross-ORIGIN yet same-SITE — so the Sec-Fetch-Site check above
 * already rejected it before this allowlist runs. The looser hostname
 * match is only reachable by browsers too old to send Sec-Fetch-Site;
 * defense in depth holds with the allowlist as the second layer.
 */
/**
 * Strict `host[:port]` grammar BEFORE URL parsing (security-review #310 A):
 * `new URL("http://" + value)` reads `evil@localhost` as host `localhost`,
 * so userinfo, a path, a query or whitespace in the Host header must be
 * "not a Host" (null), never a different host. One trailing dot is the same
 * DNS name (`host.example.` resolves to `host.example`); keeping it would
 * let a request slip past every equality check below (finding 2).
 */
const HOST_GRAMMAR = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/;
function hostHeaderName(value: string): string | null {
	const raw = value.trim().toLowerCase();
	if (!HOST_GRAMMAR.test(raw)) {
		return null;
	}
	try {
		return new URL(`http://${raw}`).hostname.replace(/\.$/, "");
	} catch {
		return null; // e.g. a port out of range
	}
}

/** `192.168.1.5`, `[::1]` — a LAN address, never a published name. */
export function isIpLiteral(hostname: string): boolean {
	return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[");
}

/**
 * Static allowlist first; the persisted public-ingress hostname (WP-G G-1:
 * a quick tunnel's name is minted at sidecar start and cannot be in the
 * env) is consulted ONLY on a miss, so the common path never touches the
 * database and the miss path is cached and floored (ingress-allowlist.ts).
 */
async function hostnameAllowed(
	name: string,
	allowed: readonly string[],
): Promise<boolean> {
	if (allowed.includes(name)) {
		return true;
	}
	const ingress = await ingressHostname(name);
	return ingress !== null && ingress === name;
}

/**
 * What a published hostname may reach : the receiver
 * Bitmovin calls and the health probe. A quick tunnel publishes whatever the
 * sidecar forwards to, so any DNS-named Host the operator did not put on the
 * static allowlist (ALLOWED_ORIGIN_HOSTS, or localhost) is treated as a
 * webhook DOOR, not a second origin for the UI or the API — in
 * `AUTH_MODE=none` it would otherwise publish the whole install. The rule
 * does not consult the persisted ingress row on purpose (security-review
 * #310 finding 1): the row lags a sidecar restart by a tick, is absent while
 * the worker is down and unreadable during a database fault, and a guard
 * keyed on it was open in exactly those windows. IP literals are exempt so a
 * LAN address keeps serving pages as before; a LAN name (mDNS, an internal
 * DNS name) belongs on ALLOWED_ORIGIN_HOSTS like any hostname the API is
 * meant to answer on. A hostname on the static allowlist is unrestricted even
 * when it is also the ingress hostname — the operator's deliberate choice.
 */
export function ingressHostMayReach(pathname: string): boolean {
	return pathname === "/api/health" || pathname.startsWith("/api/webhooks/");
}

/**
 * Runs before path classification, so pages are covered too (the cross-site
 * guard below is API-only by design). No database read: the decision needs
 * only the Host header and the static allowlist.
 */
function ingressOnlyGuard(req: NextRequest): NextResponse | null {
	// No parseable Host, no allowance (security-review #310 B, final INFO):
	// an absent Host reaches the app only from an HTTP/1.0 client (Node
	// refuses HTTP/1.1 without one, HTTP/2 carries :authority) and a
	// malformed one from nothing legitimate; the cross-site guard already
	// refuses both for the API, so the door treats them the same for pages.
	const host = req.headers.get("host");
	const name = host === null ? null : hostHeaderName(host);
	if (
		name !== null &&
		(allowedHostnames().includes(name) || isIpLiteral(name))
	) {
		return null; // the allowlist and the auth gate decide, as before
	}
	if (ingressHostMayReach(req.nextUrl.pathname)) {
		return null;
	}
	return NextResponse.json(
		{ error: "This host serves only the webhook receiver" },
		{ status: 403 },
	);
}

/** Returns a rejection response, or null when the request may continue. */
async function crossSiteGuard(req: NextRequest): Promise<NextResponse | null> {
	const fetchSite = req.headers.get("sec-fetch-site");
	if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
		return NextResponse.json(
			{ error: "Cross-site requests are not allowed" },
			{ status: 403 },
		);
	}
	const allowed = allowedHostnames();
	const host = req.headers.get("host");
	const hostName = host ? hostHeaderName(host) : null;
	if (!hostName || !(await hostnameAllowed(hostName, allowed))) {
		return NextResponse.json({ error: "Host is not allowed" }, { status: 403 });
	}
	const origin = req.headers.get("origin");
	if (origin) {
		let originName: string;
		try {
			originName = new URL(origin).hostname.toLowerCase();
		} catch {
			return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
		}
		if (!(await hostnameAllowed(originName, allowed))) {
			return NextResponse.json(
				{ error: "Cross-origin requests are not allowed" },
				{ status: 403 },
			);
		}
	}
	return null;
}

let warnedReason: string | null = null;

/** Repeating the same config error per request just trains people to ignore it. */
function warnMisconfiguredOnce(reason: string): void {
	if (warnedReason === reason) {
		return;
	}
	warnedReason = reason;
	console.error(`[auth] refusing requests: ${reason}`);
}

/** Fail closed while keeping environment/provider diagnostics in server logs. */
function misconfigured(
	reason: string,
	isApi: boolean,
	requestUrl: string,
): NextResponse {
	warnMisconfiguredOnce(reason);
	if (isApi) {
		return NextResponse.json(
			{
				error: "Authentication is not configured",
				details: { code: "AUTH_NOT_CONFIGURED" },
			},
			{ status: 503 },
		);
	}
	return NextResponse.redirect(new URL("/login", requestUrl));
}

/** Users-mode DB outage : the page gate depends on Postgres — fail
 * CLOSED with a transient 503, mirroring the Bearer path's DB-fault answer,
 * never a Next error page and never fail-open. */
function databaseUnavailable(isApi: boolean): NextResponse {
	if (isApi) {
		return NextResponse.json(
			{ error: "Authentication is unavailable (database)" },
			{ status: 503 },
		);
	}
	return new NextResponse(
		"Authentication is unavailable (database). Retry shortly.\n",
		{ status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
	);
}

function clearSessionCookies(res: NextResponse): NextResponse {
	for (const name of SESSION_COOKIE_NAMES) {
		// Shared with the logout route on purpose — see sessionCookieClearOptions.
		// These two copies of the same rule diverged once already: the logout one was
		// fixed and pinned while this one kept the defect, and a mutation restoring it
		// here left the entire suite green.
		res.cookies.set(name, "", sessionCookieClearOptions(name));
	}
	return res;
}

function unauthenticated(
	req: NextRequest,
	isApi: boolean,
	staleCookie: boolean,
): NextResponse {
	// JSON, never a redirect: every /api/* caller is fetch (lib/api.ts parses
	// the body), and a 302 to /login would surface as an HTML parse error.
	const res = isApi
		? NextResponse.json({ error: "Authentication required" }, { status: 401 })
		: NextResponse.redirect(
				new URL(
					loginPath(`${req.nextUrl.pathname}${req.nextUrl.search}`),
					req.nextUrl,
				),
			);
	return staleCookie ? clearSessionCookies(res) : res;
}

/**
 * Every response that CONTINUES to a route MUST carry the request-header
 * override. A bare NextResponse.next forwards the ORIGINAL client
 * headers untouched — Next rewrites downstream headers only when the
 * middleware response carries x-middleware-override-headers, which only
 * NextResponse.next({request:{headers}}) emits (review-189/189b C1,
 * measured on live servers: the old local-`req` strip in proxy never
 * reached a handler, so a session request forging `token:someone-else`
 * DELIVERED it). The override DELETES any header not in the set, so pass
 * a FULL copy; the actor value is always OURS ("session" | "none" |
 * "anonymous" | token:<id>), never the client's.
 */
function forward(
	req: NextRequest,
	actor: string,
	role?: string,
	context?: AuthenticatedContext,
): NextResponse {
	const headers = new Headers(req.headers);
	headers.set(ACTOR_HEADER, actor);
	for (const name of [
		ORGANIZATION_HEADER,
		EFFECTIVE_USER_HEADER,
		IMPERSONATION_HEADER,
	])
		headers.delete(name);
	if (context) {
		headers.set(ORGANIZATION_HEADER, context.organizationId);
		if (context.effectiveUserId)
			headers.set(EFFECTIVE_USER_HEADER, context.effectiveUserId);
		headers.set(IMPERSONATION_HEADER, String(context.isImpersonating));
	}
	// Same forgery rail as the actor header (#32 §3): the role header is OURS
	// on every continuing path — deleted when we have none to assert, so a
	// client-supplied copy never reaches a route.
	if (role) {
		headers.set(ROLE_HEADER, role);
	} else {
		headers.delete(ROLE_HEADER);
	}
	return NextResponse.next({ request: { headers } });
}

/** §4's decision for api-guarded paths, both actor kinds. 403 or null. */
function roleRefusal(
	role: Parameters<typeof evaluateRole>[0],
	req: NextRequest,
): NextResponse | null {
	const decision = evaluateRole(role, req.nextUrl.pathname, req.method);
	if (decision.allowed) {
		return null;
	}
	return NextResponse.json(
		{
			error: `This action requires the ${decision.minRole} role`,
			minRole: decision.minRole,
		},
		{ status: 403 },
	);
}

/** Paths a forced-rotate session may still reach (#32 §2/§3c): the rotate
 * itself and the rotate page. /api/auth/* (logout, session) is api-exempt
 * and never reaches the gate. */
function allowedUnderForcedRotate(pathname: string): boolean {
	return (
		pathname === "/api/account/password" || pathname === "/change-password"
	);
}

function isIdentityPath(path: string): boolean {
	return (
		[
			"/change-password",
			"/api/account/password",
			"/api/account/organizations",
			"/api/account/organization",
			"/api/account/impersonation",
		].includes(path) || path.startsWith("/api/platform/")
	);
}
async function contextRefusal(
	err: unknown,
	req: NextRequest,
	isApi: boolean,
): Promise<NextResponse> {
	if (err instanceof AuthContextError) {
		if (err.context) {
			try {
				await recordAccessNonAdmin(err.context, req, err.status);
			} catch {
				return databaseUnavailable(isApi);
			}
		}
		if (
			err.status === 401 &&
			bearerToken(req.headers.get("authorization")) === null
		)
			return unauthenticated(req, isApi, true);
		const response = publicContextError(err);
		return NextResponse.json(
			{ error: response.error, details: { code: response.code } },
			{ status: err.status },
		);
	}
	return databaseUnavailable(isApi);
}
function tenantRequestRefusal(
	context: AuthenticatedContext,
	req: NextRequest,
): NextResponse | null {
	const path = req.nextUrl.pathname;
	if (context.isImpersonating && !viewAsMayRead(path, req.method))
		return NextResponse.json(
			{ error: "View-as is read-only" },
			{ status: 403 },
		);
	if (path.startsWith("/api/")) {
		const browser =
			req.headers.get("sec-fetch-site") !== null &&
			bearerToken(req.headers.get("authorization")) === null;
		if (
			browser &&
			req.headers.get(EXPECTED_ORGANIZATION_HEADER) !== context.organizationId
		)
			return NextResponse.json(
				{ error: "Organization changed — reload before continuing" },
				{ status: 409 },
			);
		if (
			!isSelfTokenRevocation(
				context.actor.startsWith("token:") ? context.actor.slice(6) : "",
				path,
				req.method,
			)
		) {
			if (
				context.tokenRoleKnown === false &&
				loadAuthConfig().ok &&
				process.env.AUTH_MODE === "users"
			)
				return NextResponse.json(
					{ error: "Invalid token role" },
					{ status: 403 },
				);
			return roleRefusal(context.role, req);
		}
	}
	return null;
}

async function usersGate(
	req: NextRequest,
	pathClass: PathClass,
	settings: Extract<
		ReturnType<typeof loadAuthConfig>,
		{ ok: true }
	>["settings"] & { mode: "users" },
): Promise<NextResponse> {
	const isApi = pathClass === "api-guarded";
	const path = req.nextUrl.pathname;
	const now = Date.now();

	// DB outage ⇒ 503, fail closed (§3 / mu-security handoff check 4): in
	// users mode the PAGE gate depends on Postgres — an outage must answer
	// 503 like the Bearer path's precedent, never fall through to a Next
	// error page (and never fail open). Easy to write, easy to never
	// execute — proxy.roles.test drives this arm deliberately.
	let populated: boolean;
	try {
		// Bootstrap (§3, one state two renderings): zero users ⇒ /api/*
		// answers 503 naming /setup; pages redirect to /setup, and /setup
		// itself renders.
		populated = await anyUsersExist(now);
	} catch {
		return databaseUnavailable(isApi);
	}
	if (!populated) {
		if (isApi) {
			return NextResponse.json(
				{
					error: "Initial administrator setup is required",
					details: { code: "AUTH_SETUP_REQUIRED" },
				},
				{ status: 503 },
			);
		}
		if (path === "/setup") {
			return forward(req, "anonymous");
		}
		return NextResponse.redirect(new URL("/setup", req.nextUrl));
	}
	// Users exist: the setup window is CLOSED — a signed-in user must not see
	// a "claim this install" form whose API would refuse them (refinement D).
	if (path === "/setup") {
		return NextResponse.redirect(new URL("/", req.nextUrl));
	}

	const verdict = verifySession(
		readSessionCookie(req.cookies),
		settings.sessionSecret,
		now,
		"users",
	);
	if (!verdict.ok) {
		return unauthenticated(req, isApi, verdict.reason !== "absent");
	}
	if (verdict.payload.mode !== "users") {
		// Parse-layer unreachable (the union requires sub ⇔ users); kept as
		// the fail-closed arm for the type system.
		return unauthenticated(req, isApi, true);
	}
	let user: Awaited<ReturnType<typeof resolveUserById>>;
	try {
		user = await resolveUserById(verdict.payload.sub, now);
	} catch {
		return databaseUnavailable(isApi);
	}
	// DB wins, always : missing row, deactivated, or a cookie older than
	// the sessionsValidFrom watermark (password change / admin reset / role
	// change) all fail closed with the cookie cleared.
	if (
		user === null ||
		!user.active ||
		verdict.payload.sessionGeneration !== user.sessionGeneration ||
		!sessionIssuedAfterCutoff(verdict.payload.iat, user.sessionsValidFromMs)
	) {
		return unauthenticated(req, isApi, true);
	}
	// Forced rotate is enforced by the GATE (§2 — a temp password is never a
	// full-access credential): only the rotate endpoint/page continue.
	if (user.mustChangePassword && !allowedUnderForcedRotate(path)) {
		if (isApi) {
			return NextResponse.json(
				{
					error:
						"Password change required before this session may act — POST /api/account/password",
					code: "password-rotate-required",
				},
				{ status: 403 },
			);
		}
		return NextResponse.redirect(new URL("/change-password", req.nextUrl));
	}
	const identityOnly =
		isIdentityPath(path) ||
		(user.platformOwner === true &&
			!verdict.payload.targetUserId &&
			(path === "/settings/organizations" ||
				(path === "/api/organizations" &&
					["GET", "HEAD"].includes(req.method))));
	let context: AuthenticatedContext | undefined;
	if (identityOnly) {
		if (
			verdict.payload.targetUserId &&
			!(path === "/api/account/impersonation" && req.method === "DELETE")
		)
			return NextResponse.json(
				{ error: "Exit view-as before managing your account" },
				{ status: 403 },
			);
		if (path.startsWith("/api/platform/") && !user.platformOwner)
			return NextResponse.json(
				{ error: "A platform owner session is required" },
				{ status: 403 },
			);
	} else {
		try {
			context = await resolveAuthenticatedContext(req.headers, req.cookies);
		} catch (err) {
			return contextRefusal(err, req, isApi);
		}
		const refusal = tenantRequestRefusal(context, req);
		try {
			await recordAccessNonAdmin(context, req, refusal ? refusal.status : 200);
		} catch {
			return databaseUnavailable(isApi);
		}
		if (refusal) return refusal;
	}
	const res = forward(req, `user:${user.id}`, context?.role, context);
	const renewed = renewSession(verdict.payload, now, settings.idleMs);
	if (renewed) {
		const https = requestIsHttps(req.headers, req.url);
		res.cookies.set(
			sessionCookieName(https),
			signSession(renewed, settings.sessionSecret),
			sessionCookieOptions(https, cookieMaxAgeSeconds(renewed, now)),
		);
	}
	return res;
}

async function authGate(
	req: NextRequest,
	pathClass: PathClass,
): Promise<NextResponse> {
	if (pathClass === "api-exempt" || pathClass === "page-exempt") {
		return forward(req, "anonymous");
	}
	const isApi = pathClass === "api-guarded";
	// API tokens : a presented Bearer bo_… takes the TOKEN PATH
	// ONLY — no session fallback (mixed fallbacks hide misconfigured
	// clients), pages never accept tokens (isApi gate), and a token is
	// validated even under AUTH_MODE=none so a bad one fails loudly instead
	// of silently succeeding (least-surprise for integration debugging).
	const presented = isApi
		? bearerToken(req.headers.get("authorization"))
		: null;
	if (presented !== null) {
		const configured = loadAuthConfig();
		if (!configured.ok) return misconfigured(configured.reason, true, req.url);
		let context: AuthenticatedContext;
		try {
			context = await resolveAuthenticatedContext(req.headers);
		} catch (err) {
			return contextRefusal(err, req, true);
		}
		const refusal = tenantRequestRefusal(context, req);
		try {
			await recordAccessNonAdmin(context, req, refusal ? refusal.status : 200);
		} catch {
			return databaseUnavailable(true);
		}
		if (refusal) return refusal;
		return forward(
			req,
			context.actor,
			context.tokenRoleKnown === false ? undefined : context.role,
			context,
		);
	}
	const config = loadAuthConfig();
	if (!config.ok) {
		return misconfigured(config.reason, isApi, req.url);
	}
	const { settings } = config;
	const readiness = resolveProvider(settings).readiness();
	if (!readiness.ready) {
		return misconfigured(readiness.reason, isApi, req.url);
	}
	if (settings.mode === "none") {
		try {
			const context = await resolveAuthenticatedContext(req.headers);
			const refusal = tenantRequestRefusal(context, req);
			return refusal ?? forward(req, "none", context.role, context);
		} catch (err) {
			return contextRefusal(err, req, isApi);
		}
	}
	if (settings.mode === "users") {
		return usersGate(req, pathClass, settings);
	}
	if (settings.mode !== "password") {
		// Unreachable while OIDC readiness is always false — kept as the
		// fail-closed default for any mode added to AUTH_MODES later.
		return misconfigured(
			`AUTH_MODE=${settings.mode} cannot validate sessions`,
			isApi,
			req.url,
		);
	}
	const now = Date.now();
	const verdict = verifySession(
		readSessionCookie(req.cookies),
		settings.sessionSecret,
		now,
		settings.mode,
	);
	if (!verdict.ok) {
		return unauthenticated(req, isApi, verdict.reason !== "absent");
	}
	let context: AuthenticatedContext;
	try {
		context = await resolveAuthenticatedContext(req.headers, req.cookies);
	} catch (err) {
		return contextRefusal(err, req, isApi);
	}
	const refusal = tenantRequestRefusal(context, req);
	if (refusal) return refusal;
	const res = forward(req, "session", context.role, context);
	const renewed = renewSession(verdict.payload, now, settings.idleMs);
	if (renewed) {
		const https = requestIsHttps(req.headers, req.url);
		res.cookies.set(
			sessionCookieName(https),
			signSession(renewed, settings.sessionSecret),
			sessionCookieOptions(https, cookieMaxAgeSeconds(renewed, now)),
		);
	}
	return res;
}

export async function proxy(req: NextRequest) {
	// No header pre-strip here: reassigning a local NextRequest never
	// reaches the route (review-189 C1 measured it) — the forgery rail is
	// forward's positive override on EVERY continuing path in authGate.
	const ingressOnly = ingressOnlyGuard(req);
	if (ingressOnly) {
		return ingressOnly;
	}
	const pathClass = classifyPath(req.nextUrl.pathname);
	if (pathClass === "api-exempt" || pathClass === "api-guarded") {
		const rejected = await crossSiteGuard(req);
		if (rejected) {
			return rejected;
		}
	}
	return authGate(req, pathClass);
}

export const config = {
	/**
	 * Everything except Next's own asset routes — the page gate needs page
	 * requests, not just /api/*. Kept as a literal because Next extracts it
	 * statically at build time; proxy.test.ts compiles this array and asserts
	 * every app/api route.ts path matches it.
	 */
	matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
