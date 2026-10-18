import { beforeEach, describe, expect, it, vi } from "vitest";

const PASSWORD = "correct horse battery staple";
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

vi.mock("@/lib/server/audit", () => ({ writeAuditLog: vi.fn(async () => {}) }));

/**
 * Count VERIFICATIONS by wrapping the real implementation.
 *
 * Counting response codes cannot do it, and my first attempt at this test made
 * exactly that mistake: without the pre-check, a drained budget returns 429
 * AFTER verifying, so "429 means the guess never ran" is false. The reviewer's
 * whole point was that the budgets relabelled responses rather than stopping
 * work, and a test that reads only the label reproduces the blind spot.
 */
const verifications = { count: 0 };
vi.mock("@/lib/auth/password", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/auth/password")>();
	return {
		...real,
		verifyPassword: async (password: string, stored: string) => {
			verifications.count += 1;
			return real.verifyPassword(password, stored);
		},
	};
});

const { hashPassword } = await import("@/lib/auth/password");
const HASH = hashPassword(PASSWORD);
const { POST } = await import("./route");

function attempt(password: string): Request {
	return new Request("http://test/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password }),
	});
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.stubEnv("AUTH_MODE", "password");
	vi.stubEnv("AUTH_PASSWORD_HASH", HASH);
	vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
	verifications.count = 0;
});

/**
 * The HIGH from the third security round, as a test.
 *
 * `failureBudget`/`perKeyFailures` were charged only AFTER `provider.verify`
 * had run scrypt, so draining them changed 401 into 429 and nothing else — they
 * throttled error codes, not guesses. A reviewer measured **188 guesses/sec
 * sustained** through a budget nominally set to 40/min, 280x over, and it was
 * invisible because the log filled with failed sign-ins while clients were being
 * told "too many attempts".
 *
 * The buckets are module state with no reset hook, so these run in declaration
 * order on purpose: the un-drained case first.
 */
describe("the guess budget actually stops guesses", () => {
	it("lets a correct password through while the budget has room", async () => {
		const res = await POST(attempt(PASSWORD));
		expect(res.status).toBe(200);
		expect(verifications.count).toBe(1);
	}, 30_000);

	it("stops SPENDING VERIFICATIONS once the budget is gone", async () => {
		const attempts = 120;
		for (let i = 0; i < attempts; i += 1) {
			await POST(attempt(`wrong-${i}`));
		}
		// The global failure budget is 40 at a 40/min refill, so a sequential burst
		// of 120 can verify only the first ~40 plus whatever refilled during the
		// run. Under the defect this was 120 — every guess tested.
		expect(verifications.count).toBeLessThan(attempts);
		expect(verifications.count).toBeLessThanOrEqual(60);
	}, 120_000);

	it("refuses even a CORRECT password once drained — the trade, pinned", async () => {
		// The cost of making the cap real, chosen deliberately: with
		// TRUSTED_PROXY_HOPS unset there is no trustworthy client identity, so the
		// per-key bucket IS the global one and a flood can refuse the operator too.
		//
		// Chosen because guessing the one shared password is total compromise of
		// every Bitmovin key and storage credential this app holds, while a sign-in
		// needing a retry during an active attack is not — and because this refusal
		// is RECOVERABLE, unlike the two arrival-budget versions before it.
		//
		// If you are here because this failed, you have changed that trade. Decide
		// it on purpose and update STATUS #33; do not just make it pass.
		const res = await POST(attempt(PASSWORD));
		expect(res.status).toBe(429);
		// And the point of the whole change: no scrypt was spent on it.
		expect(verifications.count).toBe(0);
	}, 30_000);
});
