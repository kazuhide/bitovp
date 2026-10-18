import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.fn();
const organizationFindUnique = vi.fn(async () => ({
	name: "Main",
	active: true,
	allowedIpCidrs: [] as string[],
}));
vi.mock("@bitovp/db", () => ({
	getIdentityPrisma: () => ({
		organization: { findUnique: organizationFindUnique },
		membership: {
			findUnique: async () => {
				const u = await userFindUnique();
				return u ? { role: u.role, active: true } : null;
			},
			findMany: async () => [],
		},
		user: { findUnique: userFindUnique, count: vi.fn(async () => 1) },
	}),
}));

import type { SessionDto } from "@/lib/auth/dto";
import {
	issueSession,
	SECURE_SESSION_COOKIE,
	SESSION_COOKIE,
	signSession,
} from "@/lib/auth/session";
import { POST as logout } from "../logout/route";
import { GET } from "./route";

const HASH =
	"scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g=";
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const IDLE_MS = 720 * 60_000;
const MAX_MS = 168 * 3_600_000;

async function sessionResponse(cookie?: string): Promise<Response> {
	return GET(
		new Request("http://localhost:3100/api/auth/session", {
			headers: cookie ? { cookie } : {},
		}),
	);
}

async function session(cookie?: string): Promise<SessionDto> {
	const res = await sessionResponse(cookie);
	return res.json() as Promise<SessionDto>;
}

function expectPrivateNoStore(res: Response): void {
	expect(res.headers.get("cache-control")).toBe("private, no-store");
}

function token(mode: "password" | "none", now = Date.now()): string {
	return signSession(
		issueSession({ mode, now, idleMs: IDLE_MS, maxMs: MAX_MS }),
		SECRET,
	);
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("GET /api/auth/session", () => {
	beforeEach(() => {
		vi.stubEnv("AUTH_MODE", "password");
		vi.stubEnv("AUTH_PASSWORD_HASH", HASH);
		vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
	});

	it("reports an anonymous caller", async () => {
		expect(await session()).toEqual({
			mode: "password",
			configured: true,
			authenticated: false,
			loginKind: "password-form",
		});
	});

	it("marks password-mode session state private and non-cacheable", async () => {
		expectPrivateNoStore(await sessionResponse());
		expectPrivateNoStore(
			await sessionResponse(`${SESSION_COOKIE}=${token("password")}`),
		);
	});

	it("reports a valid session with its expiries", async () => {
		const dto = await session(`${SESSION_COOKIE}=${token("password")}`);
		expect(dto.authenticated).toBe(true);
		expect(Date.parse(dto.expiresAt as string)).toBeGreaterThan(Date.now());
		expect(Date.parse(dto.absoluteExpiresAt as string)).toBeGreaterThan(
			Date.parse(dto.expiresAt as string),
		);
	});

	it("reads the __Host- cookie too", async () => {
		const dto = await session(`${SECURE_SESSION_COOKIE}=${token("password")}`);
		expect(dto.authenticated).toBe(true);
	});

	const invalid: [name: string, cookie: string][] = [
		[
			"a tampered token",
			`${SESSION_COOKIE}=${token("password").slice(0, -1)}X`,
		],
		["garbage", `${SESSION_COOKIE}=nonsense`],
		// A lone "%" throws in decodeURIComponent — must read as "no session".
		["a malformed percent-escape", `${SESSION_COOKIE}=100%`],
		["an empty value", `${SESSION_COOKIE}=`],
		[
			"an expired token",
			`${SESSION_COOKIE}=${token("password", Date.now() - IDLE_MS - 1)}`,
		],
		["a none-mode token", `${SESSION_COOKIE}=${token("none")}`],
		["an unrelated cookie", "other=value"],
	];

	for (const [name, cookie] of invalid) {
		it(`reports ${name} as unauthenticated`, async () => {
			const dto = await session(cookie);
			expect(dto.authenticated).toBe(false);
			expect(dto.expiresAt).toBeUndefined();
		});
	}

	it("never echoes the hash or the signing secret", async () => {
		const body = JSON.stringify(
			await session(`${SESSION_COOKIE}=${token("password")}`),
		);
		expect(body).not.toContain(HASH);
		expect(body).not.toContain(SECRET);
	});
});

describe("GET /api/auth/session — unconfigured and alternate modes", () => {
	it("reports configured:false with a stable code and no raw setup diagnostic", async () => {
		const res = await sessionResponse();
		expectPrivateNoStore(res);
		const dto = (await res.json()) as SessionDto;
		expect(dto.configured).toBe(false);
		expect(dto.authenticated).toBe(false);
		expect(dto.reasonCode).toBe("AUTH_NOT_CONFIGURED");
		expect(dto).not.toHaveProperty("reason");
	});

	it("reports the OIDC seam as unconfigured", async () => {
		vi.stubEnv("AUTH_MODE", "oidc");
		const res = await sessionResponse();
		expectPrivateNoStore(res);
		const dto = (await res.json()) as SessionDto;
		expect(dto).toMatchObject({
			mode: "oidc",
			configured: false,
			authenticated: false,
			loginKind: "idp-redirect",
			reasonCode: "AUTH_PROVIDER_UNAVAILABLE",
		});
		expect(dto).not.toHaveProperty("reason");
	});

	it("reports AUTH_MODE=none as open", async () => {
		vi.stubEnv("AUTH_MODE", "none");
		const res = await sessionResponse();
		expectPrivateNoStore(res);
		expect(await res.json()).toEqual({
			mode: "none",
			configured: true,
			authenticated: true,
			loginKind: "disabled",
		});
	});
});

describe("POST /api/auth/logout", () => {
	it("expires both cookie names", async () => {
		const res = logout();
		expect(res.status).toBe(200);
		const cookies = res.headers.getSetCookie();
		expect(cookies).toHaveLength(2);
		for (const name of [SECURE_SESSION_COOKIE, SESSION_COOKIE]) {
			const cleared = cookies.find((value) => value.startsWith(`${name}=`));
			expect(cleared).toContain("Max-Age=0");
			expect(cleared).toContain("HttpOnly");
			expect(cleared).toContain("Path=/");
		}
		expect(await res.json()).toEqual({ ok: true });
	});
});

describe("users mode (#32 §6 — the named resolver exception)", () => {
	const SUB = "11111111-2222-4333-8444-555555555555";

	beforeEach(() => {
		vi.stubEnv("AUTH_MODE", "users");
		vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
		vi.stubEnv("AUTH_ALLOW_INSECURE_HTTP", "true");
		userFindUnique.mockReset();
		organizationFindUnique
			.mockReset()
			.mockResolvedValue({ name: "Main", active: true, allowedIpCidrs: [] });
	});

	it.each([
		true,
		false,
	])("only actual platform-owner %s has recovery identity when current-org IP policy denies", async (platformOwner) => {
		userFindUnique.mockResolvedValue({
			id: SUB,
			email: "owner@example.com",
			displayName: "Owner",
			role: "ADMIN",
			platformOwner,
			active: true,
			mustChangePassword: false,
			sessionsValidFrom: new Date(0),
			sessionGeneration: 0,
		});
		organizationFindUnique.mockResolvedValue({
			name: "Main",
			active: true,
			allowedIpCidrs: ["192.0.2.0/24"],
		});
		const signed = signSession(
			issueSession({
				mode: "users",
				now: Date.now(),
				idleMs: IDLE_MS,
				maxMs: MAX_MS,
				sub: SUB,
				sessionGeneration: 0,
			}),
			SECRET,
		);
		const dto = await session(`${SESSION_COOKIE}=${signed}`);
		expect(dto.authenticated).toBe(platformOwner);
		if (platformOwner)
			expect(dto).toMatchObject({
				platformOwner: true,
				organizationUnavailable: true,
				role: "ADMIN",
			});
		expect(dto.organizationId).toBeUndefined();
		expect(dto.organizationName).toBeUndefined();
	});
	it("returns the DB-RESOLVED role — the cookie carries no role claim at all (mu-security handoff check 3)", async () => {
		const { resetUserResolverCache } = await import("@/lib/auth/users");
		resetUserResolverCache();
		userFindUnique.mockResolvedValue({
			id: SUB,
			email: "op@example.com",
			displayName: "Op",
			role: "VIEWER",
			active: true,
			mustChangePassword: false,
			sessionsValidFrom: new Date(0),
			sessionGeneration: 0,
		});
		const token = signSession(
			issueSession({
				mode: "users",
				now: Date.now(),
				idleMs: IDLE_MS,
				maxMs: MAX_MS,
				sub: SUB,
				sessionGeneration: 0,
			}),
			SECRET,
		);
		const res = await sessionResponse(`${SESSION_COOKIE}=${token}`);
		expectPrivateNoStore(res);
		const dto = (await res.json()) as SessionDto;
		expect(dto.authenticated).toBe(true);
		expect(dto.role).toBe("VIEWER");
		expect(dto.displayName).toBe("Op");
		expect(dto.mustChangePassword).toBe(false);
	});

	it("a cookie older than sessionsValidFrom reads unauthenticated here too", async () => {
		const { resetUserResolverCache } = await import("@/lib/auth/users");
		resetUserResolverCache();
		const iat = Date.now();
		userFindUnique.mockResolvedValue({
			id: SUB,
			email: "op@example.com",
			displayName: "Op",
			role: "OPERATOR",
			active: true,
			mustChangePassword: false,
			sessionsValidFrom: new Date(iat + 1_000),
			sessionGeneration: 0,
		});
		const token = signSession(
			issueSession({
				mode: "users",
				now: iat,
				idleMs: IDLE_MS,
				maxMs: MAX_MS,
				sub: SUB,
				sessionGeneration: 0,
			}),
			SECRET,
		);
		const dto = await session(`${SESSION_COOKIE}=${token}`);
		expect(dto.authenticated).toBe(false);
		expect(dto.role).toBeUndefined();
	});

	it("treats a cookie issued in the same millisecond as sessionsValidFrom as revoked", async () => {
		const { resetUserResolverCache } = await import("@/lib/auth/users");
		resetUserResolverCache();
		const iat = Date.now();
		userFindUnique.mockResolvedValue({
			id: SUB,
			email: "op@example.com",
			displayName: "Op",
			role: "ADMIN",
			active: true,
			mustChangePassword: false,
			sessionsValidFrom: new Date(iat),
			sessionGeneration: 0,
		});
		const signed = signSession(
			issueSession({
				mode: "users",
				now: iat,
				idleMs: IDLE_MS,
				maxMs: MAX_MS,
				sub: SUB,
				sessionGeneration: 0,
			}),
			SECRET,
		);
		const dto = await session(`${SESSION_COOKIE}=${signed}`);
		expect(dto.authenticated).toBe(false);
		expect(dto.role).toBeUndefined();
	});

	it("reports a newer-iat cookie from an older session generation as unauthenticated", async () => {
		const { resetUserResolverCache } = await import("@/lib/auth/users");
		resetUserResolverCache();
		const resetAt = Date.now();
		userFindUnique.mockResolvedValue({
			id: SUB,
			email: "op@example.com",
			displayName: "Op",
			role: "ADMIN",
			active: true,
			mustChangePassword: true,
			sessionsValidFrom: new Date(resetAt),
			sessionGeneration: 8,
		});
		const signed = signSession(
			issueSession({
				mode: "users",
				now: resetAt + 1_000,
				idleMs: IDLE_MS,
				maxMs: MAX_MS,
				sub: SUB,
				sessionGeneration: 7,
			}),
			SECRET,
		);
		const dto = await session(`${SESSION_COOKIE}=${signed}`);
		expect(dto.authenticated).toBe(false);
		expect(dto.role).toBeUndefined();
	});

	it("reads users fresh even when another request cached the old role inside the resolver TTL", async () => {
		const { resetUserResolverCache, resolveUserById } = await import(
			"@/lib/auth/users"
		);
		resetUserResolverCache();
		const iat = Date.now();
		let row = {
			id: SUB,
			email: "op@example.com",
			displayName: "Op",
			role: "ADMIN",
			active: true,
			mustChangePassword: false,
			sessionsValidFrom: new Date(0),
			sessionGeneration: 0,
		};
		userFindUnique.mockImplementation(() => Promise.resolve(row));
		// Models a proxy request on this process caching ADMIN immediately
		// before a different web instance commits the role change.
		expect((await resolveUserById(SUB, iat))?.role).toBe("ADMIN");
		row = {
			...row,
			role: "VIEWER",
			// The real PATCH writes the role and revocation cutoff together.
			sessionsValidFrom: new Date(iat + 1),
			sessionGeneration: 1,
		};

		const signed = signSession(
			issueSession({
				mode: "users",
				now: iat,
				idleMs: IDLE_MS,
				maxMs: MAX_MS,
				sub: SUB,
				sessionGeneration: 0,
			}),
			SECRET,
		);
		const dto = await session(`${SESSION_COOKIE}=${signed}`);
		expect(dto.authenticated).toBe(false);
		expect(dto.role).toBeUndefined();
		expect(userFindUnique).toHaveBeenCalledTimes(2);
	});
});
