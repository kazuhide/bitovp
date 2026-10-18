import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";

const {
	findUnique,
	updateMany,
	auditCreate,
	verifyUserLogin,
	invalidateUserCache,
} = vi.hoisted(() => ({
	findUnique: vi.fn(),
	updateMany: vi.fn(),
	auditCreate: vi.fn(),
	verifyUserLogin: vi.fn(),
	invalidateUserCache: vi.fn(),
}));

vi.mock("@bitovp/db", () => ({
	getIdentityPrisma: () => ({
		user: { findUnique, updateMany },
		auditLog: { create: auditCreate },
	}),
}));

vi.mock("@/lib/auth/users", () => ({
	accountBackoffRemainingMs: () => 0,
	chargeAccountFailure: vi.fn(),
	clearAccountFailures: vi.fn(),
	hashPassword: () => "new-password-hash",
	invalidateUserCache,
	passwordPolicyError: () => null,
	verifyUserLogin,
}));

vi.mock("@/lib/auth/tenancy", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	resolveSessionIdentity: async () => ({
		user: { id: USER_ID },
		payload: {
			mode: "users",
			sub: USER_ID,
			sessionGeneration: 7,
			organizationId: "00000000-0000-4000-8000-000000000001",
		},
	}),
}));

import { POST } from "./route";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef"; // gitleaks:allow -- test-only HMAC secret
const USER_ID = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
	vi.stubEnv("AUTH_MODE", "users");
	vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
	vi.stubEnv("AUTH_ALLOW_INSECURE_HTTP", "true");
	findUnique.mockResolvedValue({ email: "admin@example.com" });
	updateMany.mockResolvedValue({ count: 1 });
	auditCreate.mockResolvedValue({});
	verifyUserLogin.mockResolvedValue({
		ok: true,
		user: {
			id: USER_ID,
			email: "admin@example.com",
			displayName: "Admin",
			role: "ADMIN",
			active: true,
			mustChangePassword: false,
			sessionsValidFromMs: 0,
			sessionGeneration: 7,
		},
		verifiedCredential: {
			sessionGeneration: 7,
			passwordHash: "old-password-hash",
		},
	});
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("POST /api/account/password session boundary", () => {
	it("revokes through the update millisecond and returns a session issued after it", async () => {
		const now = 1_760_000_000_000;
		vi.useFakeTimers();
		vi.setSystemTime(now);

		const res = await POST(
			new Request("http://localhost:3100/api/account/password", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-bitovp-actor": `user:${USER_ID}`,
				},
				body: JSON.stringify({
					currentPassword: "current-password",
					newPassword: "new-password-long-enough",
				}),
			}),
		);

		expect(res.status).toBe(200);
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					active: true,
					id: USER_ID,
					passwordHash: "old-password-hash",
					sessionGeneration: 7,
				},
				data: expect.objectContaining({
					sessionsValidFrom: new Date(now),
					sessionGeneration: { increment: 1 },
				}),
			}),
		);
		const cookie = res.headers.getSetCookie()[0] ?? "";
		const signed = cookie.match(new RegExp(`^${SESSION_COOKIE}=([^;]+)`))?.[1];
		const verdict = verifySession(signed, SECRET, now, "users");
		expect(verdict.ok).toBe(true);
		if (verdict.ok) {
			expect(verdict.payload.iat).toBeGreaterThan(now);
			if (verdict.payload.mode === "users") {
				expect(verdict.payload.sessionGeneration).toBe(8);
			}
		}
		expect(invalidateUserCache).toHaveBeenCalledWith(USER_ID);
	});

	it("returns 409 without overwriting an admin reset that commits during current-password verification", async () => {
		let finishVerification:
			| ((value: Awaited<ReturnType<typeof verifyUserLogin>>) => void)
			| undefined;
		verifyUserLogin.mockReturnValue(
			new Promise((resolve) => {
				finishVerification = resolve;
			}),
		);
		// The admin reset wins generation 7 -> 8 while the self-service route
		// is still verifying the generation-7 hash. Its later CAS must lose.
		updateMany.mockResolvedValue({ count: 0 });
		const inFlight = POST(
			new Request("http://localhost:3100/api/account/password", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-bitovp-actor": `user:${USER_ID}`,
				},
				body: JSON.stringify({
					currentPassword: "current-password",
					newPassword: "new-password-long-enough",
				}),
			}),
		);
		await vi.waitFor(() => {
			expect(verifyUserLogin).toHaveBeenCalled();
		});
		finishVerification?.({
			ok: true,
			user: {
				id: USER_ID,
				email: "admin@example.com",
				displayName: "Admin",
				role: "ADMIN",
				active: true,
				mustChangePassword: false,
				sessionsValidFromMs: 0,
				sessionGeneration: 7,
			},
			verifiedCredential: {
				sessionGeneration: 7,
				passwordHash: "old-password-hash",
			},
		});

		const res = await inFlight;
		expect(res.status).toBe(409);
		expect((await res.json()).error).toContain("changed while it was verified");
		expect(res.headers.getSetCookie()).toEqual([]);
		expect(invalidateUserCache).not.toHaveBeenCalled();
		expect(auditCreate).not.toHaveBeenCalled();
	});
});
