import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueSession, SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { resolveAuthenticatedContext } from "@/lib/auth/tenancy";
import type { ResolvedUser } from "@/lib/auth/users";

const { freshUser, populated } = vi.hoisted(() => ({
	freshUser: vi.fn(),
	populated: vi.fn(),
}));
vi.mock("@/lib/auth/users", () => ({
	resolveUserByIdFresh: freshUser,
	anyUsersExist: populated,
}));
// Keep the real resolver: the old wiring reaches its forced-rotation refusal.
vi.mock("@/lib/auth/tenancy", async (original) => {
	const actual = await original<typeof import("@/lib/auth/tenancy")>();
	return {
		...actual,
		resolveAuthenticatedContext: vi.fn(actual.resolveAuthenticatedContext),
	};
});
vi.mock("@/lib/auth/ingress-allowlist", () => ({
	ingressHostname: async () => null,
}));
vi.mock("@/lib/server/access-audit", () => ({
	recordAccessNonAdmin: async () => {},
}));

import { proxy } from "./proxy";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const SUB = "11111111-2222-4333-8444-555555555555";
const TARGET = "22222222-3333-4444-8555-666666666666";
const ORG = "00000000-0000-4000-8000-000000000001";
const ROTATION_PATHS = [
	["/change-password", "GET"],
	["/api/account/password", "POST"],
] as const;

function user(over: Partial<ResolvedUser> = {}): ResolvedUser {
	return {
		id: SUB,
		email: "rotate@example.com",
		displayName: "Rotate",
		role: "VIEWER",
		active: true,
		mustChangePassword: true,
		sessionsValidFromMs: 0,
		sessionGeneration: 0,
		...over,
	};
}
function cookie(impersonating = false) {
	const now = Date.now();
	const payload = issueSession({
		mode: "users",
		now,
		idleMs: 60_000,
		maxMs: 120_000,
		sub: SUB,
		sessionGeneration: 0,
		organizationId: ORG,
	});
	if (payload.mode !== "users") throw new Error("Expected a users session");
	return `${SESSION_COOKIE}=${signSession(
		impersonating
			? {
					...payload,
					targetUserId: TARGET,
					impersonationExpiresAt: now + 30_000,
					returnOrganizationId: ORG,
				}
			: payload,
		SECRET,
	)}`;
}
function request(path: string, method: string, session = cookie()) {
	return new NextRequest(`http://localhost:3100${path}`, {
		method,
		headers: {
			host: "localhost:3100",
			cookie: session,
			"sec-fetch-site": "same-origin",
			"x-bitovp-expected-org": ORG,
		},
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("AUTH_MODE", "users");
	vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
	vi.stubEnv("AUTH_ALLOW_INSECURE_HTTP", "true");
	populated.mockResolvedValue(true);
	freshUser.mockResolvedValue(user());
});
afterEach(() => vi.unstubAllEnvs());

describe("forced password rotation identity paths", () => {
	it.each(
		ROTATION_PATHS,
	)("admits %s after fresh identity checks without resolving tenant access", async (path, method) => {
		const response = await proxy(request(path, method));
		expect(response.status).toBe(200);
		expect(freshUser).toHaveBeenCalledWith(SUB, expect.any(Number));
		expect(resolveAuthenticatedContext).not.toHaveBeenCalled();
		expect(
			response.headers.get("x-middleware-request-x-bitovp-organization"),
		).toBeNull();
	});
	it.each(
		ROTATION_PATHS,
	)("refuses revoked identity on %s", async (path, method) => {
		freshUser.mockResolvedValue(user({ sessionGeneration: 1 }));
		const response = await proxy(request(path, method));
		expect(response.status).toBe(path.startsWith("/api/") ? 401 : 307);
		if (!path.startsWith("/api/"))
			expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
				"/login",
			);
		expect(resolveAuthenticatedContext).not.toHaveBeenCalled();
	});
	it.each(
		ROTATION_PATHS,
	)("refuses an invalid session on %s", async (path, method) => {
		const response = await proxy(
			request(path, method, `${SESSION_COOKIE}=invalid`),
		);
		expect(response.status).toBe(path.startsWith("/api/") ? 401 : 307);
		expect(freshUser).not.toHaveBeenCalled();
		expect(resolveAuthenticatedContext).not.toHaveBeenCalled();
	});
	it("redirects protected pages and refuses business API writes until rotation", async () => {
		const page = await proxy(request("/", "GET"));
		expect(page.status).toBe(307);
		expect(new URL(page.headers.get("location") ?? "").pathname).toBe(
			"/change-password",
		);
		const api = await proxy(request("/api/credentials", "POST"));
		expect(api.status).toBe(403);
		expect(await api.json()).toMatchObject({
			code: "password-rotate-required",
		});
		expect(resolveAuthenticatedContext).not.toHaveBeenCalled();
	});
	it.each(
		ROTATION_PATHS,
	)("refuses view-as account management on %s", async (path, method) => {
		freshUser.mockResolvedValue(user({ platformOwner: true }));
		const response = await proxy(request(path, method, cookie(true)));
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Exit view-as before managing your account",
		});
		expect(resolveAuthenticatedContext).not.toHaveBeenCalled();
	});
});
