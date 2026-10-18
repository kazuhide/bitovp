import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";

/**
 * Setup counts every global identity, matching the gate's anyUsersExist.
 * Deactivation cannot reopen the platform-owner bootstrap window.
 */

const state = { activeUsers: 0, totalUsers: 0 };
const userCount = vi.fn(
	async ({ where }: { where?: { active?: boolean } } = {}) =>
		where?.active === true ? state.activeUsers : state.totalUsers,
);
let createdSessionsValidFrom = new Date(0);
const userCreate = vi.fn(async (_args?: unknown) => ({
	id: "11111111-2222-4333-8444-555555555555",
	sessionsValidFrom: createdSessionsValidFrom,
	sessionGeneration: 0,
}));
const consumeSetupCode = vi.fn(async (_code: string) => true);

let lastTxOptions: { isolationLevel?: string } | undefined;
let txReject: { code: string } | null = null;
const prisma = {
	user: { count: userCount, create: userCreate },
	membership: { create: vi.fn(async (_args?: unknown) => ({})) },
	auditLog: { create: vi.fn(async () => ({})) },
	$transaction: async (
		fn: (tx: unknown) => Promise<unknown>,
		o?: { isolationLevel?: string },
	) => {
		lastTxOptions = o;
		if (txReject) {
			const err = txReject;
			txReject = null;
			throw Object.assign(new Error("serialization failure"), err);
		}
		return fn(prisma);
	},
};

vi.mock("@bitovp/db", () => ({ getIdentityPrisma: () => prisma }));
vi.mock("@/lib/auth/setup-code", () => ({
	consumeSetupCode: (code: string) => consumeSetupCode(code),
}));
vi.mock("@/lib/auth/users", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	bumpUsersExist: vi.fn(),
}));

import { POST } from "./route";

function setup(body: unknown): Request {
	return new Request("http://localhost:3100/api/auth/setup", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const GOOD = {
	code: "abcd-efgh-ijkl-mnop",
	email: "admin@example.com",
	displayName: "Admin",
	password: "a-strong-password-12",
};
const SECRET = "0".repeat(48);

beforeEach(() => {
	vi.clearAllMocks();
	state.activeUsers = 0;
	state.totalUsers = 0;
	lastTxOptions = undefined;
	txReject = null;
	createdSessionsValidFrom = new Date(0);
	consumeSetupCode.mockResolvedValue(true);
	vi.stubEnv("AUTH_MODE", "users");
	vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
	vi.stubEnv("AUTH_ALLOW_INSECURE_HTTP", "true");
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("POST /api/auth/setup zero-users predicate (review-32 M3)", () => {
	it("creates the first owner and default ADMIN membership only when no identity exists", async () => {
		const res = await POST(setup(GOOD));
		expect(res.status).toBe(201);
		// The in-transaction count asked the SAME question the gate asks.
		expect(userCount).toHaveBeenCalledWith();
		expect(userCreate.mock.calls[0]?.[0]).toMatchObject({
			data: { platformOwner: true, role: "ADMIN" },
		});
		expect(prisma.membership.create.mock.calls[0]?.[0]).toMatchObject({
			data: {
				organizationId: "00000000-0000-4000-8000-000000000001",
				role: "ADMIN",
			},
		});
	});

	it("all-deactivated identities keep owner bootstrap closed", async () => {
		state.totalUsers = 3;
		state.activeUsers = 0;
		const res = await POST(setup(GOOD));
		expect(res.status).toBe(409);
		expect(userCreate).not.toHaveBeenCalled();
	});

	it("refuses once an ACTIVE admin exists", async () => {
		state.activeUsers = 1;
		state.totalUsers = 1;
		const res = await POST(setup(GOOD));
		expect(res.status).toBe(409);
	});

	it("a wrong setup code never reaches the transaction", async () => {
		consumeSetupCode.mockResolvedValue(false);
		const res = await POST(setup(GOOD));
		expect(res.status).toBe(401);
		expect(userCreate).not.toHaveBeenCalled();
	});

	it("the bootstrap runs SERIALIZABLE — the TOCTOU control's load-bearing line is pinned (review-32 m8)", async () => {
		// This is the only thing stopping two holders of a leaked setup code
		// from both becoming admin; deleting the option must go red here.
		await POST(setup(GOOD));
		expect(lastTxOptions?.isolationLevel).toBe("Serializable");
	});

	it("losing the serialization race is the already-complete 409 (review-32 m8)", async () => {
		txReject = { code: "P2034" };
		const res = await POST(setup(GOOD));
		expect(res.status).toBe(409);
	});

	it("returns a first-admin session issued after the row's equal-millisecond cutoff", async () => {
		const now = 1_760_000_000_000;
		vi.useFakeTimers();
		vi.setSystemTime(now);
		createdSessionsValidFrom = new Date(now);
		const res = await POST(setup(GOOD));
		expect(res.status).toBe(201);
		expect(userCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				select: {
					id: true,
					sessionsValidFrom: true,
					sessionGeneration: true,
				},
			}),
		);
		const cookie = res.headers.getSetCookie()[0] ?? "";
		const signed = cookie.match(new RegExp(`^${SESSION_COOKIE}=([^;]+)`))?.[1];
		const verdict = verifySession(signed, SECRET, now, "users");
		expect(verdict.ok).toBe(true);
		if (verdict.ok) {
			expect(verdict.payload.iat).toBeGreaterThan(now);
			if (verdict.payload.mode === "users") {
				expect(verdict.payload.sessionGeneration).toBe(0);
			}
		}
	});
});
