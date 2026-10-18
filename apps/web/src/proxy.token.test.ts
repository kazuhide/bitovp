import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAuthConfig } from "@/lib/auth/config";
import { issueSession, SESSION_COOKIE, signSession } from "@/lib/auth/session";

/**
 *  (docs/API-USAGE.md) — the TOKEN PATH through the real proxy.
 * Its own file: the gate module is mocked here (the prisma-backed loader
 * belongs to integration reality, not this test), and proxy.test.ts keeps
 * the session flows untouched.
 *
 * The pinned rails: a presented Bearer bo_… takes the token path ONLY (a
 * VALID session cannot rescue a bad token — mixed fallbacks hide
 * misconfigured clients); pages NEVER accept tokens; AUTH_MODE=none still
 * validates a presented token so a bad one fails loudly.
 */

const verifyApiTokenRequest = vi.fn();
vi.mock("@/lib/auth/api-token-gate", async () => {
	const actual = await vi.importActual<typeof import("@/lib/auth/api-token")>(
		"@/lib/auth/api-token",
	);
	return {
		ACTOR_HEADER: "x-bitovp-actor",
		bearerToken: actual.bearerToken,
		verifyApiTokenRequest: (...args: unknown[]) =>
			verifyApiTokenRequest(...args),
	};
});

vi.mock("@/lib/auth/tenancy", async () => {
	const actual =
		await vi.importActual<typeof import("@/lib/auth/tenancy")>(
			"@/lib/auth/tenancy",
		);
	const { proxyContextFixture } = await import(
		"@/lib/auth/proxy-context.test-support"
	);
	return {
		...actual,
		resolveAuthenticatedContext: proxyContextFixture(
			(token) => verifyApiTokenRequest(token),
			undefined,
			actual.AuthContextError,
		),
	};
});
vi.mock("@/lib/server/access-audit", () => ({
	recordAccessNonAdmin: async () => {},
}));
// WP-G G-1: the Host-miss path reads the persisted ingress; no DB here.
vi.mock("@/lib/auth/ingress-allowlist", () => ({
	ingressHostname: async () => null,
}));

import { proxy } from "./proxy";

const HASH =
	"scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g=";
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const TOKEN = `bo_${"a".repeat(43)}`;

function apiRequest(headers: Record<string, string> = {}): NextRequest {
	return new NextRequest("http://localhost:3100/api/credentials", {
		method: "GET",
		headers: { host: "localhost:3100", ...headers },
	});
}

function validCookie(): string {
	const token = signSession(
		issueSession({
			mode: "password",
			now: Date.now(),
			idleMs: 720 * 60_000,
			maxMs: 168 * 3_600_000,
		}),
		SECRET,
	);
	return `${SESSION_COOKIE}=${token}`;
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
	vi.stubEnv("AUTH_MODE", "password");
	vi.stubEnv("AUTH_PASSWORD_HASH", HASH);
	vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
	verifyApiTokenRequest.mockResolvedValue({
		ok: true,
		tokenId: "tok-1",
		role: "OPERATOR",
	});
});

describe("proxy — API token path", () => {
	it.each([
		"USERS",
		"PASSWORD",
		"NONE",
		"invalid",
		" users ",
	])("#181 invalid AUTH_MODE=%s refuses a valid token and session", async (mode) => {
		vi.stubEnv("AUTH_MODE", mode);
		expect(loadAuthConfig().ok).toBe(false);
		for (const authorization of [`Bearer ${TOKEN}`, undefined]) {
			const res = await proxy(
				apiRequest({
					cookie: validCookie(),
					...(authorization ? { authorization } : {}),
				}),
			);
			expect(res.status).toBe(503);
			expect(await res.json()).toMatchObject({
				details: { code: "AUTH_NOT_CONFIGURED" },
			});
			expect(res.headers.get("x-middleware-next")).toBeNull();
		}
	});

	it.each([
		"password",
		"",
		undefined,
	])("#181 password/default mode (%s) requires usable config even for tokens", async (mode) => {
		vi.stubEnv("AUTH_MODE", mode);
		vi.stubEnv("AUTH_PASSWORD_HASH", "");
		expect(loadAuthConfig().ok).toBe(false);
		const res = await proxy(apiRequest({ authorization: `Bearer ${TOKEN}` }));
		expect(res.status).toBe(503);
		expect(res.headers.get("x-middleware-next")).toBeNull();
	});

	it.each([
		"",
		undefined,
	])("#181 blank/unset mode (%s) retains valid password configuration", async (mode) => {
		vi.stubEnv("AUTH_MODE", mode);
		expect(loadAuthConfig()).toMatchObject({
			ok: true,
			settings: { mode: "password" },
		});
		const res = await proxy(apiRequest({ authorization: `Bearer ${TOKEN}` }));
		expect(res.status).toBe(200);
		expect(res.headers.get("x-middleware-request-x-bitovp-actor")).toBe(
			"token:tok-1",
		);
	});

	it("#181 self-revocation cannot bypass invalid configuration", async () => {
		vi.stubEnv("AUTH_MODE", "USERS");
		const res = await proxy(
			new NextRequest("http://localhost:3100/api/api-tokens/tok-1", {
				method: "DELETE",
				headers: { host: "localhost:3100", authorization: `Bearer ${TOKEN}` },
			}),
		);
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({
			details: { code: "AUTH_NOT_CONFIGURED" },
		});
		expect(res.headers.get("x-middleware-next")).toBeNull();
	});

	it("a valid token authenticates an api-guarded request with NO session", async () => {
		const res = await proxy(apiRequest({ authorization: `Bearer ${TOKEN}` }));
		expect(res.status).toBe(200);
		expect(verifyApiTokenRequest).toHaveBeenCalledWith(TOKEN);
		// PR2: the VERIFIED actor rides the forwarded request headers.
		expect(res.headers.get("x-middleware-request-x-bitovp-actor")).toBe(
			"token:tok-1",
		);
	});

	it("a forged actor on the SESSION path is OVERWRITTEN with the server's (review-189 C1)", async () => {
		// The first pin here asserted the forwarded header was NULL — which
		// was vacuously true because the session path emitted NO override at
		// all, and null meant the ORIGINAL client header survived to the
		// route (review-189 measured "token:someone-else" delivered on a
		// live server; deleting the whole strip left 2,204 tests green).
		// The real invariant: every continuing response carries the override
		// AND the forwarded value EQUALS the server's — an assertion that
		// can actually fail.
		const res = await proxy(
			apiRequest({
				cookie: validCookie(),
				"x-bitovp-actor": "token:someone-else",
				"x-bitovp-role": "ADMIN",
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-middleware-override-headers")).not.toBeNull();
		expect(res.headers.get("x-middleware-request-x-bitovp-actor")).toBe(
			"session",
		);
		// Password mode proves the single owner with actor=session and asserts no
		// role. A forged ADMIN role must be deleted before a route sees it.
		expect(res.headers.get("x-middleware-request-x-bitovp-role")).toBe("ADMIN");
	});

	it("the none-mode path forwards actor 'none' over any forged value", async () => {
		vi.stubEnv("AUTH_MODE", "none");
		const res = await proxy(
			apiRequest({
				"x-bitovp-actor": "user:admin",
				"x-bitovp-role": "ADMIN",
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-middleware-override-headers")).not.toBeNull();
		expect(res.headers.get("x-middleware-request-x-bitovp-actor")).toBe("none");
		expect(res.headers.get("x-middleware-request-x-bitovp-role")).toBe("ADMIN");
	});

	it("EXEMPT paths forward actor 'anonymous' over any forged value", async () => {
		const res = await proxy(
			new NextRequest("http://localhost:3100/api/health", {
				method: "GET",
				headers: {
					host: "localhost:3100",
					"x-bitovp-actor": "token:someone-else",
					"x-bitovp-role": "ADMIN",
				},
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-middleware-override-headers")).not.toBeNull();
		expect(res.headers.get("x-middleware-request-x-bitovp-actor")).toBe(
			"anonymous",
		);
		expect(res.headers.get("x-middleware-request-x-bitovp-role")).toBeNull();
	});

	it("a token-path forged actor is overwritten by the verified token id", async () => {
		const res = await proxy(
			apiRequest({
				authorization: `Bearer ${TOKEN}`,
				"x-bitovp-actor": "user:admin",
				"x-bitovp-role": "ADMIN",
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-middleware-request-x-bitovp-actor")).toBe(
			"token:tok-1",
		);
		expect(res.headers.get("x-middleware-request-x-bitovp-role")).toBe(
			"OPERATOR",
		);
	});

	it("a bad token is a 401 naming the reason — even WITH a valid session (token path only)", async () => {
		verifyApiTokenRequest.mockResolvedValue({ ok: false, reason: "revoked" });
		const res = await proxy(
			apiRequest({
				authorization: `Bearer ${TOKEN}`,
				cookie: validCookie(),
			}),
		);
		expect(res.status).toBe(401);
		expect(((await res.json()) as { error: string }).error).toBe(
			"Invalid API token (revoked)",
		);
	});

	it("PAGE routes never accept tokens — the session flow runs instead", async () => {
		const res = await proxy(
			new NextRequest("http://localhost:3100/settings/credentials", {
				method: "GET",
				headers: {
					host: "localhost:3100",
					authorization: `Bearer ${TOKEN}`,
				},
			}),
		);
		// No session cookie → redirect to login; the token neither helped
		// nor was consulted.
		expect(res.status).toBe(307);
		expect(verifyApiTokenRequest).not.toHaveBeenCalled();
	});

	it("a NON-bo_ Bearer scheme falls through to the session flow", async () => {
		const res = await proxy(
			apiRequest({
				authorization: "Bearer some-oidc-jwt",
				cookie: validCookie(),
			}),
		);
		expect(res.status).toBe(200);
		expect(verifyApiTokenRequest).not.toHaveBeenCalled();
	});

	it("AUTH_MODE=none still VALIDATES a presented token — a bad one fails loudly", async () => {
		vi.stubEnv("AUTH_MODE", "none");
		verifyApiTokenRequest.mockResolvedValue({ ok: false, reason: "unknown" });
		const res = await proxy(apiRequest({ authorization: `Bearer ${TOKEN}` }));
		expect(res.status).toBe(401);
	});

	it("a DB outage is a 503 naming the database, never 401-bad-credential (review-188 I5)", async () => {
		// Their MB7: deleting the 503 branch fell through to '401 Invalid API
		// token (unavailable)' — telling a CI client its CREDENTIAL is bad
		// during a database outage, the exact wrong diagnosis I1 exists to
		// prevent. The mapping is the proxy's job, so it pins here.
		verifyApiTokenRequest.mockResolvedValue({
			ok: false,
			reason: "unavailable",
		});
		const res = await proxy(apiRequest({ authorization: `Bearer ${TOKEN}` }));
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error: string }).error).toContain(
			"database",
		);
	});

	it("AUTH_MODE=none without a token stays open (unchanged behaviour)", async () => {
		vi.stubEnv("AUTH_MODE", "none");
		const res = await proxy(apiRequest());
		expect(res.status).toBe(200);
		expect(verifyApiTokenRequest).not.toHaveBeenCalled();
	});

	it("session cookie renewal still rides the forwarded response (review-189 caveat)", async () => {
		// forward replaced the bare NextResponse.next on the session
		// path — the renewal cookie must land on the RETURNED response.
		// Renewal fires only past HALF the idle window (renewSession), so
		// the session is issued 7 hours ago (idle = 12h).
		const aged = signSession(
			issueSession({
				mode: "password",
				now: Date.now() - 7 * 3_600_000,
				idleMs: 720 * 60_000,
				maxMs: 168 * 3_600_000,
			}),
			SECRET,
		);
		const res = await proxy(
			apiRequest({ cookie: `${SESSION_COOKIE}=${aged}` }),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-middleware-request-x-bitovp-actor")).toBe(
			"session",
		);
		expect(res.headers.get("set-cookie")).toContain("bitovp_session");
	});
});
