import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: { encodingJob: { updateMany } },
	}),
}));

import { POST } from "./route";

function id(n: number): string {
	return `00000000-0000-4000-8000-0000000000${n.toString().padStart(2, "0")}`;
}

/** Own rate-limit bucket per request — see the bulk-re-run test for why. */
let clientSeq = 0;
function postRequest(body: unknown, client?: string): Request {
	return new Request("http://test/api/encoding-jobs/bulk-cancel", {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "x-forwarded-for": client ?? `10.0.0.${++clientSeq}` },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	updateMany.mockResolvedValue({ count: 1 });
});

/**
 * These tests give each caller its own `x-forwarded-for` so one test's limiter
 * state cannot leak into the next. That only works when the app is TOLD how many
 * proxies write the header: `clientKey` returns one shared `"untrusted"` bucket
 * otherwise, because Next fills `x-forwarded-for` from the socket only when it is
 * ABSENT (`??=`), so a client-supplied value wins and keying on it would let any
 * caller mint a fresh bucket per request.
 *
 * The original derivation here took the FIRST hop and was therefore forgeable —
 * found on the login route, where it meant unlimited password guesses, and fixed
 * for every route at once. Declaring the topology is now part of the test, which
 * is the honest version: per-client rate limiting is a deployment property, not
 * something the app can assume.
 */
beforeEach(() => {
	vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
});

describe("POST /api/encoding-jobs/bulk-cancel", () => {
	it("rejects an empty id list", async () => {
		const res = await POST(postRequest({ ids: [] }));
		expect(res.status).toBe(400);
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("rejects more than 50 ids (the shared bulk cap)", async () => {
		const ids = Array.from({ length: 51 }, (_, i) => id(i));
		const res = await POST(postRequest({ ids }));
		expect(res.status).toBe(400);
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("accepts exactly 50 ids (boundary)", async () => {
		const ids = Array.from({ length: 50 }, (_, i) => id(i));
		const res = await POST(postRequest({ ids }));
		expect(res.status).toBe(200);
		expect(updateMany).toHaveBeenCalledTimes(50);
	});

	it("rejects non-uuid ids", async () => {
		const res = await POST(postRequest({ ids: ["nope"] }));
		expect(res.status).toBe(400);
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("rejects a missing/garbled body", async () => {
		const res = await POST(
			new Request("http://test/api/encoding-jobs/bulk-cancel", {
				method: "POST",
				body: "not json",
			}),
		);
		expect(res.status).toBe(400);
	});

	it("issues the SINGLE route's atomic claim per id — and never writes status", async () => {
		const a = id(1);
		const res = await POST(postRequest({ ids: [a] }));
		expect(res.status).toBe(200);
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: a,
				status: { in: ["QUEUED", "RUNNING"] },
				cancelRequested: false,
			},
			data: { cancelRequested: true },
		});
		// The worker is the single writer of `status`: the bulk claim must flip
		// ONLY the cooperative-cancel flag.
		const arg = updateMany.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(Object.keys(arg.data)).toEqual(["cancelRequested"]);
		expect(arg.data).not.toHaveProperty("status");
	});

	it("reports a 0-count claim as skipped (terminal / already canceling) without aborting", async () => {
		const claimable = id(1);
		const terminal = id(2);
		const alsoClaimable = id(3);
		updateMany.mockImplementation(
			async ({ where }: { where: { id: string } }) => ({
				count: where.id === terminal ? 0 : 1,
			}),
		);
		const res = await POST(
			postRequest({ ids: [claimable, terminal, alsoClaimable] }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			canceled: string[];
			skipped: { id: string; reason: string }[];
		};
		expect(body.canceled).toEqual([claimable, alsoClaimable]);
		expect(body.skipped).toEqual([
			{
				id: terminal,
				reason:
					"Job is not cancelable (already finished, canceled, or canceling)",
			},
		]);
	});

	it("isolates a per-id DB failure so the remaining ids still claim — and logs it", async () => {
		const bad = id(1);
		const good = id(2);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		updateMany.mockImplementation(
			async ({ where }: { where: { id: string } }) => {
				if (where.id === bad) {
					throw new Error("Database failed at secret-db.internal:5432");
				}
				return { count: 1 };
			},
		);
		const res = await POST(postRequest({ ids: [bad, good] }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			canceled: string[];
			skipped: { id: string; reason: string }[];
		};
		expect(body.canceled).toEqual([good]);
		expect(body.skipped).toEqual([{ id: bad, reason: "Cancel failed" }]);
		expect(JSON.stringify(body)).not.toContain("secret-db.internal");
		// Isolation must not mean silence: an unexpected failure is logged too.
		expect(logged).toHaveBeenCalledWith(
			expect.stringContaining(bad),
			expect.stringContaining("secret-db.internal:5432"),
		);
		logged.mockRestore();
	});

	it("deduplicates repeated ids so the one-shot claim runs once per job", async () => {
		const dup = id(7);
		const res = await POST(postRequest({ ids: [dup, dup, dup] }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { canceled: string[] };
		expect(body.canceled).toEqual([dup]);
		// Without dedup the 2nd/3rd claims would match 0 rows and be reported as
		// "already canceling" — a lie about our own request.
		expect(updateMany).toHaveBeenCalledTimes(1);
	});

	it("deduplicates CASE VARIANTS of one id", async () => {
		const lower = id(8);
		const res = await POST(postRequest({ ids: [lower, lower.toUpperCase()] }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { canceled: string[] };
		expect(body.canceled).toEqual([lower]);
		expect(updateMany).toHaveBeenCalledTimes(1);
	});

	it("rate-limits a cancel loop from one client", async () => {
		const CLIENT = "203.0.113.11";
		for (let i = 0; i < 30; i += 1) {
			const ok = await POST(postRequest({ ids: [id(9)] }, CLIENT));
			expect(ok.status).toBe(200);
		}
		const limited = await POST(postRequest({ ids: [id(9)] }, CLIENT));
		expect(limited.status).toBe(429);
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
});
