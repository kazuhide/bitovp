import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "@/lib/auth/password";
import {
	SECURE_SESSION_COOKIE,
	SESSION_COOKIE,
	verifySession,
} from "@/lib/auth/session";

const userFindUnique = vi.fn();
type LoginUserUpdateManyArgs = {
	where: { sessionGeneration: number; passwordHash: string };
};
const userUpdateMany = vi.fn<
	(args: LoginUserUpdateManyArgs) => Promise<{ count: number }>
>(async () => ({ count: 1 }));
const userCount = vi.fn(async () => 1);
vi.mock("@bitovp/db", () => ({
	getIdentityPrisma: () => ({
		membership: { findMany: async () => [] },
		user: {
			findUnique: userFindUnique,
			updateMany: userUpdateMany,
			count: userCount,
		},
	}),
}));

import {
	resetAccountBackoff,
	resetUserResolverCache,
	resetUsersExistCache,
} from "@/lib/auth/users";
import { POST } from "./route";

const PASSWORD = "a-strong-team-password";
const HASH = hashPassword(PASSWORD);
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

let ipCounter = 0;

/** A fresh IP per test — the limiter is module state shared across this file. */
function login(
	body: unknown,
	init: { ip?: string; url?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
	const ip = init.ip ?? `10.0.0.${++ipCounter}`;
	return POST(
		new Request(init.url ?? "http://localhost:3100/api/auth/login", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forwarded-for": ip,
				...init.headers,
			},
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	);
}

function passwordMode(): void {
	vi.stubEnv("AUTH_MODE", "password");
	vi.stubEnv("AUTH_PASSWORD_HASH", HASH);
	vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("POST /api/auth/login", () => {
	beforeEach(passwordMode);

	it("sets an HttpOnly, SameSite=Lax, Path=/ cookie for the right password", async () => {
		const res = await login({ password: PASSWORD });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; expiresAt: string };
		expect(body.ok).toBe(true);
		expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());

		const [cookie] = res.headers.getSetCookie();
		expect(cookie).toContain(`${SESSION_COOKIE}=v1.`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=lax");
		expect(cookie).toContain("Path=/");
		// Plain http: Secure would make the browser drop the cookie outright.
		expect(cookie).not.toContain("Secure");
	});

	it("uses the __Host- prefixed, Secure cookie over https", async () => {
		const res = await login(
			{ password: PASSWORD },
			{ url: "https://ovp.example/api/auth/login" },
		);
		const [cookie] = res.headers.getSetCookie();
		expect(cookie).toContain(`${SECURE_SESSION_COOKIE}=v1.`);
		expect(cookie).toContain("Secure");
	});

	it("uses the __Host- prefixed cookie behind a TLS-terminating proxy", async () => {
		const res = await login(
			{ password: PASSWORD },
			{ headers: { "x-forwarded-proto": "https" } },
		);
		const [cookie] = res.headers.getSetCookie();
		expect(cookie).toContain(`${SECURE_SESSION_COOKIE}=v1.`);
	});

	const rejected: [name: string, body: unknown, status: number][] = [
		["a wrong password", { password: "not-the-password" }, 401],
		["a case-flipped password", { password: PASSWORD.toUpperCase() }, 401],
		["an empty password", { password: "" }, 400],
		["a missing password", {}, 400],
		["a non-string password", { password: 1234 }, 400],
		["an over-long password", { password: "x".repeat(513) }, 400],
		["a non-JSON body", "not json", 400],
	];

	for (const [name, body, status] of rejected) {
		it(`rejects ${name} with ${status} and sets no cookie`, async () => {
			const res = await login(body);
			expect(res.status).toBe(status);
			expect(res.headers.getSetCookie()).toEqual([]);
		});
	}

	it("does not say which part was wrong", async () => {
		const res = await login({ password: "not-the-password" });
		expect(await res.json()).toEqual({
			error: "Invalid password",
			details: { code: "AUTH_INVALID_CREDENTIALS" },
		});
	});

	it("rate-limits repeated attempts from one IP, and recovers as it refills", async () => {
		// Per-key accounting only happens when the app is TOLD how many proxies
		// append to x-forwarded-for. Without that the header is client-supplied
		// (Next fills it with `??=`, so a forged value wins) and keying on it is
		// theatre — a review corrected that assumption, so the test now states the
		// topology it is testing.
		vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
		const ip = "203.0.113.7";
		const statuses: number[] = [];
		for (let attempt = 0; attempt < 10; attempt++) {
			statuses.push((await login({ password: "wrong" }, { ip })).status);
		}
		// capacity 8, then the bucket is empty.
		expect(statuses.slice(0, 8).every((status) => status === 401)).toBe(true);
		expect(statuses.slice(8)).toEqual([429, 429]);

		// A different client is unaffected by the tripped bucket.
		expect(
			(await login({ password: "wrong" }, { ip: "203.0.113.8" })).status,
		).toBe(401);

		// refillPerMinute: 4 → one token back every 15s.
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 16_000);
		expect((await login({ password: PASSWORD }, { ip })).status).toBe(200);
		vi.useRealTimers();
	});
});

describe("POST /api/auth/login — misconfiguration and other modes", () => {
	it("503s with a stable customer code and no environment diagnostic", async () => {
		const res = await login({ password: PASSWORD });
		expect(res.status).toBe(503);
		const body = (await res.json()) as {
			error: string;
			details: { code: string };
		};
		expect(body.error).toBe("Authentication is not configured");
		expect(body.details).toEqual({ code: "AUTH_NOT_CONFIGURED" });
		expect(JSON.stringify(body)).not.toMatch(/AUTH_PASSWORD_HASH|AUTH_MODE/);
	});

	it("503s AUTH_MODE=oidc rather than pretending to sign in", async () => {
		vi.stubEnv("AUTH_MODE", "oidc");
		const res = await login({ password: PASSWORD });
		expect(res.status).toBe(503);
		expect(res.headers.getSetCookie()).toEqual([]);
	});

	it("400s under AUTH_MODE=none — there is no session to issue", async () => {
		vi.stubEnv("AUTH_MODE", "none");
		const res = await login({ password: PASSWORD });
		expect(res.status).toBe(400);
		expect(res.headers.getSetCookie()).toEqual([]);
	});
});

describe("junk bodies cannot lock the operator out", () => {
	beforeEach(passwordMode);

	/**
	 * A review demonstrated the previous arrangement was a PERMANENT lockout, not
	 * a guess cap: the global token was consumed on arrival, so `{}` at 40 req/min
	 * held the bucket empty and the operator with the CORRECT password got 429 —
	 * 0 successes out of 5 under a sustained flood. Their first attempt with
	 * `{password:"wrong"}` FAILED to reproduce it, because scrypt refills the
	 * bucket faster than the attacker drains it; only bodies that never reach
	 * verification do it. That is why the accounting moved to the failure path.
	 */
	function junk(): Request {
		return new Request("http://test/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
	}

	it("the operator still signs in after a flood of junk bodies", async () => {
		for (let i = 0; i < 120; i += 1) {
			const res = await POST(junk());
			// Junk is a 400, never a 429 charged against the guess budget.
			expect([400, 429]).toContain(res.status);
		}
		const res = await POST(
			new Request("http://test/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ password: PASSWORD }),
			}),
		);
		expect(res.status).toBe(200);
	}, 30_000);

	/**
	 * This test asserted the OPPOSITE until a security round showed the property
	 * was only achievable by not limiting anything. Charging the budgets after
	 * `provider.verify` is what let a correct password through a drained
	 * budget — and it let every wrong one through too, since the budget could
	 * only change 401 into 429 once scrypt had already run. Measured: 188
	 * guesses/sec through a budget nominally set to 40/min.
	 *
	 * So the guarantee is deliberately narrower now: a drained budget refuses
	 * everyone, including the operator, until it refills (seconds). It is kept
	 * here rather than deleted because a future round WILL read the old title and
	 * "restore" it. See `guessrate.test.ts` for the trade and STATUS #33.
	 */
	it("a drained failure budget refuses even a CORRECT password", async () => {
		for (let i = 0; i < 45; i += 1) {
			await POST(
				new Request("http://test/api/auth/login", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ password: `wrong-${i}` }),
				}),
			);
		}
		const res = await POST(
			new Request("http://test/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ password: PASSWORD }),
			}),
		);
		expect(res.status).toBe(429);
	}, 30_000);

	it("wrong passwords DO get capped once the failure budget is gone", async () => {
		let sawLimit = false;
		for (let i = 0; i < 45; i += 1) {
			const res = await POST(
				new Request("http://test/api/auth/login", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ password: `wrong-${i}` }),
				}),
			);
			if (res.status === 429) {
				sawLimit = true;
			}
		}
		expect(sawLimit).toBe(true);
	}, 30_000);
});

describe("users mode — the backoff acts on FAILURES, never on the correct password (review-32 B1)", () => {
	const SUB = "11111111-2222-4333-8444-555555555555";

	function usersMode(): void {
		vi.stubEnv("AUTH_MODE", "users");
		vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
		vi.stubEnv("AUTH_ALLOW_INSECURE_HTTP", "true");
		// Fresh per-test IPs only count separately with trusted hops — without
		// this the per-key bucket collapses to one file-wide key and ITS
		// arrival peek (the global CPU guard, not the account backoff) 429s
		// the correct password, masking what this describe pins.
		vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
	}

	beforeEach(() => {
		resetAccountBackoff();
		resetUserResolverCache();
		resetUsersExistCache();
		userFindUnique.mockReset();
		userUpdateMany.mockReset();
		userUpdateMany.mockResolvedValue({ count: 1 });
		userCount.mockClear();
		userFindUnique.mockResolvedValue({
			id: SUB,
			email: "admin@example.com",
			displayName: "Admin",
			role: "ADMIN",
			active: true,
			mustChangePassword: false,
			sessionsValidFrom: new Date(0),
			sessionGeneration: 0,
			passwordHash: HASH,
			passwordExpiresAt: null,
		});
	});

	it("after repeated failures the CORRECT password still signs in — an attacker cannot hold the admin out", async () => {
		usersMode();
		// Drive the account deep into the backoff window with wrong guesses.
		for (let i = 0; i < 5; i += 1) {
			await login({ email: "admin@example.com", password: "wrong-password" });
		}
		// The victim (or the admin) arrives with the REAL password: the old
		// arrival check answered 429 here — the exact lockout lever this
		// route's own comment warned about, shipped a third time.
		const res = await login({
			email: "admin@example.com",
			password: PASSWORD,
		});
		expect(res.status).toBe(200);
	});

	it("a wrong password INSIDE the window reads 429 with a retry-after", async () => {
		usersMode();
		for (let i = 0; i < 4; i += 1) {
			await login({ email: "admin@example.com", password: "wrong-password" });
		}
		const res = await login({
			email: "admin@example.com",
			password: "still-wrong",
		});
		expect(res.status).toBe(429);
		expect(res.headers.get("retry-after")).not.toBeNull();
	});

	it("mints a usable session after an equal-millisecond revocation cutoff", async () => {
		usersMode();
		const now = 1_760_000_000_000;
		vi.useFakeTimers();
		vi.setSystemTime(now);
		userFindUnique.mockResolvedValue({
			id: SUB,
			email: "admin@example.com",
			displayName: "Admin",
			role: "ADMIN",
			active: true,
			mustChangePassword: false,
			sessionsValidFrom: new Date(now),
			sessionGeneration: 0,
			passwordHash: HASH,
			passwordExpiresAt: null,
		});
		try {
			const res = await login({
				email: "admin@example.com",
				password: PASSWORD,
			});
			expect(res.status).toBe(200);
			const cookie = res.headers.getSetCookie()[0] ?? "";
			const signed = cookie.match(
				new RegExp(`^${SESSION_COOKIE}=([^;]+)`),
			)?.[1];
			const verdict = verifySession(signed, SECRET, now, "users");
			expect(verdict.ok).toBe(true);
			if (verdict.ok) {
				expect(verdict.payload.iat).toBeGreaterThan(now);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects the cookie when an admin reset commits while the old password is still being verified", async () => {
		usersMode();
		let current = {
			id: SUB,
			email: "admin@example.com",
			displayName: "Admin",
			role: "ADMIN" as const,
			active: true,
			mustChangePassword: false,
			sessionsValidFrom: new Date(0),
			sessionGeneration: 7,
			passwordHash: HASH,
			passwordExpiresAt: null,
		};
		let releaseSnapshotRead: (() => void) | undefined;
		const snapshotRead = new Promise<void>((resolve) => {
			releaseSnapshotRead = resolve;
		});
		userFindUnique.mockImplementation(async () => {
			const snapshot = { ...current };
			releaseSnapshotRead?.();
			return snapshot;
		});
		userUpdateMany.mockImplementation(async ({ where }) => ({
			count:
				where.sessionGeneration === current.sessionGeneration &&
				where.passwordHash === current.passwordHash
					? 1
					: 0,
		}));

		const inFlightLogin = login({
			email: "admin@example.com",
			password: PASSWORD,
		});
		await snapshotRead;
		// This is the deferred-verification interleaving: findUnique already
		// returned generation 7 + the old hash, while async scrypt is in flight.
		// The admin reset then commits generation 8 before login mints a cookie.
		current = {
			...current,
			passwordHash: hashPassword("replacement-admin-password"),
			sessionsValidFrom: new Date(Date.now()),
			sessionGeneration: 8,
			mustChangePassword: true,
		};
		const loginResponse = await inFlightLogin;
		expect(loginResponse.status).toBe(409);
		expect(loginResponse.headers.getSetCookie()).toEqual([]);
		expect((await loginResponse.json()).error).toContain(
			"Credentials changed while sign-in was being verified",
		);
		expect(userUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					passwordHash: HASH,
					sessionGeneration: 7,
				}),
			}),
		);
	}, 10_000);
});
