/**
 * Path classification for the auth gate in proxy.ts.
 *
 * Pure and client-safe on purpose (no node:crypto, no env, no next/server):
 * the login form reuses `safeNextPath`, and gate-coverage.test.ts enumerates
 * every route file on disk against `classifyPath` without a server runtime.
 */

/**
 * The complete set of API prefixes reachable WITHOUT a session. Every entry
 * carries the reason it is safe — an entry without one is an unauthenticated
 * route, and gate-coverage.test.ts fails any route file that is exempt here
 * but not named in its allowlist.
 *
 * - `/api/health` — liveness probe for docker/uptime checks; returns a
 *   constant, touches no data.
 * - `/api/webhooks` — Bitmovin cannot present a session cookie; that route
 *   authenticates with its own HMAC (BITMOVIN_WEBHOOK_SECRET) and refuses to
 *   persist anything unverified.
 * - `/api/auth` — the sign-in handshake itself; gating it would deadlock.
 */
export const API_EXEMPT_PREFIXES = [
	"/api/health",
	"/api/webhooks",
	"/api/auth",
] as const;

/**
 * Page paths reachable without a session: the login screen, and Next's own
 * asset/data routes (the matcher already skips `_next/static` and
 * `_next/image`; this is the in-code second layer).
 */
export const PAGE_EXEMPT_PREFIXES = [
	"/login",
	"/_next",
	"/favicon.ico",
] as const;

export type PathClass =
	| "api-exempt"
	| "api-guarded"
	| "page-exempt"
	| "page-guarded";

/** One trailing slash is normalized away; `..` is already resolved by URL parsing. */
function normalize(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith("/")) {
		return pathname.slice(0, -1);
	}
	return pathname === "" ? "/" : pathname;
}

/** Boundary-aware: `/api/healthz` must not inherit `/api/health`'s exemption. */
function underPrefix(path: string, prefixes: readonly string[]): boolean {
	return prefixes.some(
		(prefix) => path === prefix || path.startsWith(`${prefix}/`),
	);
}

export function classifyPath(pathname: string): PathClass {
	const path = normalize(pathname);
	if (path === "/api" || path.startsWith("/api/")) {
		return underPrefix(path, API_EXEMPT_PREFIXES)
			? "api-exempt"
			: "api-guarded";
	}
	return underPrefix(path, PAGE_EXEMPT_PREFIXES)
		? "page-exempt"
		: "page-guarded";
}

export function isApiPath(pathname: string): boolean {
	const path = normalize(pathname);
	return path === "/api" || path.startsWith("/api/");
}

const MAX_NEXT_LENGTH = 512;

/**
 * Open-redirect guard for `?next=`. Accepts only a same-origin PATH that the
 * page gate would itself have redirected: an absolute URL, a
 * protocol-relative `//evil.com`, a backslash form (`/\evil.com`, which some
 * browsers normalize to `//`), anything containing whitespace, and `/login`
 * itself (redirect loop) are all rejected → null.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
	if (!raw || raw.length > MAX_NEXT_LENGTH) {
		return null;
	}
	if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
		return null;
	}
	// CR/LF/TAB in a redirect target is header-smuggling material; any other
	// odd byte is percent-encoded by the parse below and caught by the origin
	// check.
	if (/\s/.test(raw)) {
		return null;
	}
	let url: URL;
	try {
		url = new URL(raw, "http://gate.invalid");
	} catch {
		return null;
	}
	if (url.origin !== "http://gate.invalid") {
		return null;
	}
	// Re-check AFTER normalization. `new URL` collapses `.` and `..`, so
	// `/..//evil.com` parses to pathname `//evil.com` — protocol-relative, and the
	// raw check above never saw it. The login form assigns this value to
	// `window.location`, so returning it would be an open redirect off a trusted
	// origin immediately after the operator typed the shared password: prime
	// "your session expired" phishing (review catch).
	if (url.pathname.startsWith("//") || url.pathname.startsWith("/\\")) {
		return null;
	}
	if (classifyPath(url.pathname) !== "page-guarded") {
		return null;
	}
	return `${url.pathname}${url.search}`;
}

/** `/login` with a validated `next`, or bare `/login` when nothing is safe to keep. */
export function loginPath(next: string | null | undefined): string {
	const safe = safeNextPath(next);
	return safe && safe !== "/"
		? `/login?next=${encodeURIComponent(safe)}`
		: "/login";
}
