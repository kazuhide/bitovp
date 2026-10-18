import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthMode } from "@/lib/auth/config";
import { issueSession, SESSION_COOKIE, signSession } from "@/lib/auth/session";
import type { ResolvedUser } from "@/lib/auth/users";

/**
 *  §4/§10 — the USERS-MODE proxy wiring, including the review's
 * three blocker mutations at the WIRING level (the table-level halves live
 * in roles.test.ts):
 *   1. an API token whose role is below a rule's floor is refused — drop
 *      the token-path role resolution and these go red;
 *   2. (unit half in roles.test.ts — the fallback);
 *   3. a VIEWER session GET on the stream-key REVEAL path is refused —
 *      delete the REVEAL row and this goes red.
 * Plus the §3 session rails: sessionsValidFrom watermark, forced rotate at
 * the gate, and the zero-users bootstrap pair (503 / redirect).
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
		isHumanActor: (actor: string | null) =>
			actor === "session" || actor?.startsWith("user:") === true,
	};
});

const resolveUserById = vi.fn();
const anyUsersExist = vi.fn();
vi.mock("@/lib/auth/users", () => ({
	resolveUserByIdFresh: (...args: unknown[]) => resolveUserById(...args),
	anyUsersExist: (...args: unknown[]) => anyUsersExist(...args),
}));

/**
 * The self-revoke arms run the REAL `DELETE /api/api-tokens/[id]` handler after
 * the proxy, because the CI kill-switch is a CHAIN — the proxy's ADMIN floor
 * and the handler's self-only rail — and asserting each half separately cannot
 * answer "can a leaked OPERATOR token still kill itself". These two mocks are
 * only what that handler needs.
 */
const updateMany = vi.fn();
const findUnique = vi.fn();
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: { apiToken: { updateMany, findUnique } },
	}),
}));
vi.mock("@bitovp/db", () => ({
	getTenantPrisma: () => ({ apiToken: { updateMany, findUnique } }),
}));
vi.mock("@/lib/server/audit", () => ({ writeAuditLog: async () => {} }));

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
			() => resolveUserById(),
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

import { DELETE } from "./app/api/api-tokens/[id]/route";
import { proxy } from "./proxy";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const HASH =
	"scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g=";
const TOKEN = `bo_${"a".repeat(43)}`;
const SUB = "11111111-2222-4333-8444-555555555555";

/**
 * #255: the env that makes `loadAuthConfig` return each mode with `ok: true`.
 * `satisfies Record<AuthMode, …>` derives the population from the UNION, not
 * from the modes I happened to think of — a fifth AUTH_MODE is a compile error
 * here rather than a silently untested branch of the token gate.
 */
const MODE_ENV = {
	password: {
		AUTH_MODE: "password",
		AUTH_PASSWORD_HASH: HASH,
		AUTH_SESSION_SECRET: SECRET,
	},
	users: {
		AUTH_MODE: "users",
		AUTH_SESSION_SECRET: SECRET,
		AUTH_ALLOW_INSECURE_HTTP: "true",
	},
	oidc: { AUTH_MODE: "oidc" },
	none: { AUTH_MODE: "none" },
} satisfies Record<AuthMode, Record<string, string>>;

const MODES = Object.keys(MODE_ENV) as AuthMode[];

function stubMode(mode: AuthMode): void {
	vi.unstubAllEnvs();
	for (const [name, value] of Object.entries(MODE_ENV[mode])) {
		vi.stubEnv(name, value);
	}
}

/** Real uuids: the DELETE handler's `invalidIdResponse` 400s anything else. */
const TOKEN_ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ID = "00000000-0000-4000-8000-0000000000b2";

/**
 * proxy → (only if it forwards) the REAL revoke handler, carrying the actor the
 * proxy stamped. Returns whichever response the caller would actually receive,
 * so an arm can assert 204 or 403 rather than "the gate said 200".
 */
async function revokeThroughProxy(
	targetId: string,
): Promise<{ res: Response; role: string | null }> {
	const gate = await proxy(
		request(`/api/api-tokens/${targetId}`, "DELETE", {
			authorization: `Bearer ${TOKEN}`,
		}),
	);
	// The GATE's headers are returned beside the final response, not discarded
	// (rev363 I1). Composing proxy → handler answered "does the kill-switch
	// work" but threw away everything the proxy ASSERTED about the caller, so
	// the exception's "grants no role" half was pinned by nothing: mutating
	// `role ?? undefined` to `role ?? "ADMIN"` left all 80 arms green.
	const role = gate.headers.get("x-middleware-request-x-bitovp-role");
	if (gate.status !== 200) {
		return { res: gate, role };
	}
	const actor = gate.headers.get("x-middleware-request-x-bitovp-actor");
	const res = await DELETE(
		new Request(`http://localhost:3100/api/api-tokens/${targetId}`, {
			method: "DELETE",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				...(actor === null ? {} : { "x-bitovp-actor": actor }),
			},
		}),
		{ params: Promise.resolve({ id: targetId }) },
	);
	return { res, role };
}

function user(over: Partial<ResolvedUser> = {}): ResolvedUser {
	return {
		id: SUB,
		email: "op@example.com",
		displayName: "Op",
		role: "OPERATOR",
		active: true,
		mustChangePassword: false,
		sessionsValidFromMs: 0,
		sessionGeneration: 0,
		...over,
	};
}

function request(
	path: string,
	method: string,
	headers: Record<string, string> = {},
): NextRequest {
	return new NextRequest(`http://localhost:3100${path}`, {
		method,
		headers: { host: "localhost:3100", ...headers },
	});
}

function cookieFor(
	sub: string,
	iat = Date.now(),
	sessionGeneration = 0,
): string {
	const token = signSession(
		issueSession({
			mode: "users",
			now: iat,
			idleMs: 720 * 60_000,
			maxMs: 168 * 3_600_000,
			sub,
			sessionGeneration,
		}),
		SECRET,
	);
	return `${SESSION_COOKIE}=${token}`;
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
	vi.stubEnv("AUTH_MODE", "users");
	vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
	// The TLS rail is config-level; tests run over http.
	vi.stubEnv("AUTH_ALLOW_INSECURE_HTTP", "true");
	anyUsersExist.mockResolvedValue(true);
	resolveUserById.mockResolvedValue(user());
	updateMany.mockResolvedValue({ count: 1 });
	findUnique.mockResolvedValue({ id: TOKEN_ID });
});

describe("token authorization rides the §4 table (§10 mutation 1)", () => {
	it("a VIEWER token cannot POST an encoding job — 403 naming the floor", async () => {
		verifyApiTokenRequest.mockResolvedValue({
			ok: true,
			tokenId: "tok-1",
			role: "VIEWER",
		});
		const res = await proxy(
			request("/api/encoding-jobs", "POST", {
				authorization: `Bearer ${TOKEN}`,
			}),
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ minRole: "OPERATOR" });
	});

	it("an OPERATOR token passes the same request, with actor AND role stamped", async () => {
		verifyApiTokenRequest.mockResolvedValue({
			ok: true,
			tokenId: "tok-1",
			role: "OPERATOR",
		});
		const res = await proxy(
			request("/api/encoding-jobs", "POST", {
				authorization: `Bearer ${TOKEN}`,
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

	it("an UNPARSEABLE stored role denies — the bare String column fails closed", async () => {
		verifyApiTokenRequest.mockResolvedValue({
			ok: true,
			tokenId: "tok-1",
			role: "OWNER",
		});
		const res = await proxy(
			request("/api/encoding-jobs", "GET", {
				authorization: `Bearer ${TOKEN}`,
			}),
		);
		expect(res.status).toBe(403);
	});
});

describe("session authorization (§10 mutation 3) and the §3 rails", () => {
	it("a VIEWER session GET on the stream-key REVEAL path is refused", async () => {
		resolveUserById.mockResolvedValue(user({ role: "VIEWER" }));
		const res = await proxy(
			request("/api/live/stream-keys/abc", "GET", { cookie: cookieFor(SUB) }),
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ minRole: "OPERATOR" });
	});

	it("the same VIEWER reads an ordinary list fine — with user actor + role stamped", async () => {
		resolveUserById.mockResolvedValue(user({ role: "VIEWER" }));
		const res = await proxy(
			request("/api/encoding-jobs", "GET", { cookie: cookieFor(SUB) }),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-middleware-request-x-bitovp-actor")).toBe(
			`user:${SUB}`,
		);
		expect(res.headers.get("x-middleware-request-x-bitovp-role")).toBe(
			"VIEWER",
		);
	});

	it("a client-supplied role header is OVERWRITTEN, never forwarded", async () => {
		resolveUserById.mockResolvedValue(user({ role: "VIEWER" }));
		const res = await proxy(
			request("/api/encoding-jobs", "GET", {
				cookie: cookieFor(SUB),
				"x-bitovp-role": "ADMIN",
			}),
		);
		expect(res.headers.get("x-middleware-request-x-bitovp-role")).toBe(
			"VIEWER",
		);
	});

	it("a cookie older than sessionsValidFrom is DEAD — password change kills outstanding sessions", async () => {
		const iat = Date.now();
		resolveUserById.mockResolvedValue(
			user({ sessionsValidFromMs: iat + 1_000 }),
		);
		const res = await proxy(
			request("/api/encoding-jobs", "GET", { cookie: cookieFor(SUB, iat) }),
		);
		expect(res.status).toBe(401);
	});

	it("a cookie issued in the same millisecond as sessionsValidFrom is DEAD", async () => {
		const iat = Date.now();
		resolveUserById.mockResolvedValue(user({ sessionsValidFromMs: iat }));
		const res = await proxy(
			request("/api/encoding-jobs", "GET", { cookie: cookieFor(SUB, iat) }),
		);
		expect(res.status).toBe(401);
	});

	it("a cookie proved against an older session generation is DEAD even when its iat is newer than the reset cutoff", async () => {
		const resetAt = Date.now();
		const loginFinishedAt = resetAt + 1_000;
		resolveUserById.mockResolvedValue(
			user({ sessionsValidFromMs: resetAt, sessionGeneration: 8 }),
		);
		const res = await proxy(
			request("/api/encoding-jobs", "GET", {
				cookie: cookieFor(SUB, loginFinishedAt, 7),
			}),
		);
		expect(res.status).toBe(401);
	});

	it("passes the signed generation to the resolver so a warm older process can re-read before rejecting", async () => {
		const iat = Date.now();
		resolveUserById.mockResolvedValue(
			user({ sessionsValidFromMs: iat - 1, sessionGeneration: 8 }),
		);
		const res = await proxy(
			request("/api/encoding-jobs", "GET", {
				cookie: cookieFor(SUB, iat, 8),
			}),
		);
		expect(res.status).toBe(200);
		expect(resolveUserById).toHaveBeenCalledWith(SUB, expect.any(Number));
	});

	it("a deactivated user is refused at the gate — DB wins, not the cookie", async () => {
		resolveUserById.mockResolvedValue(user({ active: false }));
		const res = await proxy(
			request("/api/encoding-jobs", "GET", { cookie: cookieFor(SUB) }),
		);
		expect(res.status).toBe(401);
	});

	it("forced rotate blocks every API path EXCEPT the rotate itself (gate-enforced, §3c)", async () => {
		resolveUserById.mockResolvedValue(user({ mustChangePassword: true }));
		const blocked = await proxy(
			request("/api/encoding-jobs", "GET", { cookie: cookieFor(SUB) }),
		);
		expect(blocked.status).toBe(403);
		expect(await blocked.json()).toMatchObject({
			code: "password-rotate-required",
		});
		const rotate = await proxy(
			request("/api/account/password", "POST", { cookie: cookieFor(SUB) }),
		);
		expect(rotate.status).toBe(200);
	});
});

describe("DB outage fails CLOSED (§3 / mu-security handoff check 4)", () => {
	it("a throwing user resolver answers 503, never a Next error page", async () => {
		resolveUserById.mockRejectedValue(new Error("connection refused"));
		const api = await proxy(
			request("/api/encoding-jobs", "GET", { cookie: cookieFor(SUB) }),
		);
		expect(api.status).toBe(503);
		expect((await api.json()).error).toContain("database");
	});

	it("a throwing zero-users check answers 503 on pages too", async () => {
		anyUsersExist.mockRejectedValue(new Error("connection refused"));
		const page = await proxy(request("/dashboard", "GET"));
		expect(page.status).toBe(503);
	});
});

describe("zero-users bootstrap (§3: one state, two renderings)", () => {
	beforeEach(() => {
		anyUsersExist.mockResolvedValue(false);
	});

	it("API answers 503 with a stable setup code and no developer command", async () => {
		const res = await proxy(request("/api/encoding-jobs", "GET"));
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body).toMatchObject({
			error: "Initial administrator setup is required",
			details: { code: "AUTH_SETUP_REQUIRED" },
		});
		expect(JSON.stringify(body)).not.toContain("auth:create-user");
	});

	it("pages redirect to /setup, and /setup itself renders", async () => {
		const page = await proxy(request("/dashboard", "GET"));
		expect(page.status).toBe(307);
		expect(page.headers.get("location")).toContain("/setup");
		const setup = await proxy(request("/setup", "GET"));
		expect(setup.status).toBe(200);
	});

	it("once users exist, /setup redirects HOME — no claim-this-install form for signed-in eyes", async () => {
		anyUsersExist.mockResolvedValue(true);
		const res = await proxy(request("/setup", "GET"));
		expect(res.status).toBe(307);
		expect(res.headers.get("location")).not.toContain("/setup");
	});
});

/**
 *  — the role a TOKEN carries is evaluated in EVERY auth mode.
 *
 * The token ROW carries a role regardless of AUTH_MODE; only password-mode
 * SESSIONS are role-less. The proxy nonetheless ran `parseRole` → `roleRefusal`
 * only under `mode === "users"`, so on this password-mode deployment the
 * default OPERATOR verification token read `GET /api/audit-logs`. Measured on the
 * 2026-08-29 billed re-audit's GO-11 readback, so the arms below run the WHOLE
 * mode union rather than only the mode the defect was found in.
 */
const ADMIN_ROUTES = ["/api/audit-logs"] as const;
const RETIRED_EVIDENCE_ROUTES = [
	"/api/verification-runs",
	"/api/settings/api-coverage",
] as const;

describe.each(
	MODES,
)("#255 — a token's role rides the §4 table (%s mode)", (mode) => {
	beforeEach(() => {
		stubMode(mode);
	});

	it.each(
		ADMIN_ROUTES,
	)("an OPERATOR token is REFUSED on %s — #230's ADMIN floor holds in this mode", async (path) => {
		verifyApiTokenRequest.mockResolvedValue({
			ok: true,
			tokenId: "tok-1",
			role: "OPERATOR",
		});
		const res = await proxy(
			request(path, "GET", { authorization: `Bearer ${TOKEN}` }),
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ minRole: "ADMIN" });
	});

	it.each(
		RETIRED_EVIDENCE_ROUTES,
	)("an OPERATOR token reaches the universal 404 handler for %s", async (path) => {
		verifyApiTokenRequest.mockResolvedValue({
			ok: true,
			tokenId: "tok-1",
			role: "OPERATOR",
		});
		const res = await proxy(
			request(path, "GET", { authorization: `Bearer ${TOKEN}` }),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-middleware-request-x-bitovp-role")).toBe(
			"OPERATOR",
		);
	});

	it.each(
		ADMIN_ROUTES,
	)("an ADMIN token READS %s, with the role stamped on the forwarded request", async (path) => {
		verifyApiTokenRequest.mockResolvedValue({
			ok: true,
			tokenId: "tok-1",
			role: "ADMIN",
		});
		const res = await proxy(
			request(path, "GET", { authorization: `Bearer ${TOKEN}` }),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-middleware-request-x-bitovp-role")).toBe("ADMIN");
	});

	it("an OPERATOR token still POSTs an encoding job — the fix is a floor, not a wall", async () => {
		verifyApiTokenRequest.mockResolvedValue({
			ok: true,
			tokenId: "tok-1",
			role: "OPERATOR",
		});
		const res = await proxy(
			request("/api/encoding-jobs", "POST", {
				authorization: `Bearer ${TOKEN}`,
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

	it("an OPERATOR token REVOKES ITSELF — 204, carrying its OWN role and no other", async () => {
		// #255 put /api/api-tokens at an ADMIN floor in every mode, which took
		// review-189 I5's kill-switch away from exactly the OPERATOR tokens
		// that need it. SELF_REVOCATION_EXCEPTION gives it back by SUBJECT.
		// End-to-end (gate + real handler), so a 204 here means a leaked token
		// can still kill itself from CI.
		verifyApiTokenRequest.mockResolvedValue({
			ok: true,
			tokenId: TOKEN_ID,
			role: "OPERATOR",
		});
		const { res, role } = await revokeThroughProxy(TOKEN_ID);
		expect(res.status).toBe(204);
		expect(updateMany).toHaveBeenCalledWith({
			where: { id: TOKEN_ID, revokedAt: null },
			data: { revokedAt: expect.any(Date) },
		});
		// The exception clears a FLOOR; it does not promote the caller. The
		// stamped role is still the token's own (rev363 I1).
		expect(role).toBe("OPERATOR");
	});

	it("the same OPERATOR token revoking ANOTHER id is refused at the ADMIN floor — 403", async () => {
		// The exception is scoped by SUBJECT. Killing someone else's credential
		// is still the admin act review-189 I5 cut, and the refusal comes from
		// the PROXY — the request never reaches the handler's own rail.
		verifyApiTokenRequest.mockResolvedValue({
			ok: true,
			tokenId: TOKEN_ID,
			role: "OPERATOR",
		});
		const { res } = await revokeThroughProxy(OTHER_ID);
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ minRole: "ADMIN" });
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("owning an id opens neither the inventory GET nor a read of that id", async () => {
		// The exception must not be read as "this token owns /api/api-tokens".
		verifyApiTokenRequest.mockResolvedValue({
			ok: true,
			tokenId: TOKEN_ID,
			role: "OPERATOR",
		});
		const list = await proxy(
			request("/api/api-tokens", "GET", {
				authorization: `Bearer ${TOKEN}`,
			}),
		);
		expect(list.status).toBe(403);
		const readOwn = await proxy(
			request(`/api/api-tokens/${TOKEN_ID}`, "GET", {
				authorization: `Bearer ${TOKEN}`,
			}),
		);
		expect(readOwn.status).toBe(403);
	});
});

describe("#255 — an UNPARSEABLE stored role outside users mode", () => {
	beforeEach(() => {
		stubMode("password");
		verifyApiTokenRequest.mockResolvedValue({
			ok: true,
			tokenId: "tok-1",
			role: "OWNER",
		});
	});

	it("is refused on an ADMIN route — an ADMIN we cannot PROVE is not an ADMIN", async () => {
		const res = await proxy(
			request("/api/audit-logs", "GET", {
				authorization: `Bearer ${TOKEN}`,
			}),
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ minRole: "ADMIN" });
	});

	it("still reaches an OPERATOR route — a fix must not lock out a working client", async () => {
		// And the role header is DELETED: we have none to assert, so a
		// client-supplied copy must not survive to the route. Asserting only
		// `toBeNull` would pass vacuously if no override were emitted at all
		// (review-189 C1's exact trap), so the request FORGES one and the
		// override header is checked alongside.
		const res = await proxy(
			request("/api/encoding-jobs", "POST", {
				authorization: `Bearer ${TOKEN}`,
				"x-bitovp-role": "ADMIN",
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-middleware-override-headers")).not.toBeNull();
		expect(res.headers.get("x-middleware-request-x-bitovp-role")).toBeNull();
	});

	it("but users mode still denies the SAME request outright — that half is unchanged", async () => {
		stubMode("users");
		const res = await proxy(
			request("/api/encoding-jobs", "POST", {
				authorization: `Bearer ${TOKEN}`,
			}),
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({
			error: "Invalid token role",
		});
	});

	it.each(
		MODES,
	)("can still REVOKE ITSELF in %s mode — 204, and no role header rides with it", async (mode) => {
		// The safe direction, and the one place the users-mode flat 403 also
		// yields: a holder who cannot prove a role can still kill its own
		// credential. The alternative is a leaked token nobody but an admin
		// can revoke — which is the failure this exception exists to avoid.
		stubMode(mode);
		verifyApiTokenRequest.mockResolvedValue({
			ok: true,
			tokenId: TOKEN_ID,
			role: "OWNER",
		});
		const { res, role } = await revokeThroughProxy(TOKEN_ID);
		expect(res.status).toBe(204);
		expect(updateMany).toHaveBeenCalledWith({
			where: { id: TOKEN_ID, revokedAt: null },
			data: { revokedAt: expect.any(Date) },
		});
		// The half this title has always claimed and nothing pinned until
		// rev363 I1: a role we could not PARSE is a role we must not ASSERT, so
		// the header is deleted rather than defaulted. `role ?? "ADMIN"` — the
		// plausible slip, since the caller just cleared an ADMIN floor — left
		// every arm green while stamping the forwarded request ADMIN.
		expect(role).toBeNull();
	});

	it("but an unparseable role revoking ANOTHER id is still refused", async () => {
		const { res } = await revokeThroughProxy(OTHER_ID);
		expect(res.status).toBe(403);
		expect(updateMany).not.toHaveBeenCalled();
	});
});

describe("#255 — password-mode SESSIONS are untouched", () => {
	beforeEach(() => {
		stubMode("password");
	});

	it("a password-mode session still reads an ADMIN route — its cookie carries no role at all", async () => {
		// The control arm for the fix's SCOPE: password mode's single shared
		// password is the install's admin credential and its cookie makes no
		// role claim, so nothing on the session path may start 403ing. Only
		// TOKENS gained a role decision.
		const cookie = signSession(
			issueSession({
				mode: "password",
				now: Date.now(),
				idleMs: 720 * 60_000,
				maxMs: 168 * 3_600_000,
			}),
			SECRET,
		);
		const res = await proxy(
			request("/api/audit-logs", "GET", {
				cookie: `${SESSION_COOKIE}=${cookie}`,
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-middleware-request-x-bitovp-actor")).toBe(
			"session",
		);
		expect(res.headers.get("x-middleware-request-x-bitovp-role")).toBe("ADMIN");
	});
});
