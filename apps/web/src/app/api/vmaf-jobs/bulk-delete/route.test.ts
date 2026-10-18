import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const vmafDeleteMany = vi.fn();
const auditCreate = vi.fn();

const tx = { vmafJob: { deleteMany: vmafDeleteMany } };
const $transaction = vi.fn((cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

let qcVmafEnabled = true;

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			// : the flag gate reads through the same context. The
			// harness default is ON so every pre-existing case keeps testing
			// what it was written for; the off-case pin flips it.
			appSetting: {
				findUnique: async () => ({ value: { qcVmaf: qcVmafEnabled } }),
			},
			vmafJob: { findUnique, deleteMany: vmafDeleteMany },
			auditLog: { create: auditCreate },
			$transaction,
		},
	}),
}));

import { POST } from "./route";

function id(n: number): string {
	return `00000000-0000-4000-8000-0000000000${n.toString().padStart(2, "0")}`;
}

/** Own rate-limit bucket per request — see the bulk-re-run test for why. */
let clientSeq = 0;
function postRequest(body: unknown, client?: string): Request {
	return new Request("http://test/api/vmaf-jobs/bulk-delete", {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "x-forwarded-for": client ?? `10.0.0.${++clientSeq}` },
	});
}

beforeEach(() => {
	qcVmafEnabled = true;
	vi.clearAllMocks();
	vmafDeleteMany.mockResolvedValue({ count: 1 });
	auditCreate.mockResolvedValue({});
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

describe("POST /api/vmaf-jobs/bulk-delete", () => {
	it("rejects an empty id list, >50 ids and non-uuids", async () => {
		expect((await POST(postRequest({ ids: [] }))).status).toBe(400);
		expect(
			(
				await POST(
					postRequest({ ids: Array.from({ length: 51 }, (_, i) => id(i)) }),
				)
			).status,
		).toBe(400);
		expect((await POST(postRequest({ ids: ["nope"] }))).status).toBe(400);
		expect($transaction).not.toHaveBeenCalled();
	});

	it("deletes terminal reports via the guarded deleteMany (results cascade by FK)", async () => {
		const a = id(1);
		findUnique.mockResolvedValue({ id: a, status: "FINISHED" });
		const res = await POST(postRequest({ ids: [a] }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ deleted: [a], skipped: [] });
		expect(vmafDeleteMany).toHaveBeenCalledWith({
			where: { id: a, status: { in: ["FINISHED", "ERROR"] } },
		});
	});

	it("skips an in-flight report with the single route's own reason", async () => {
		const running = id(1);
		const done = id(2);
		findUnique.mockImplementation(
			async ({ where }: { where: { id: string } }) =>
				where.id === running
					? { id: running, status: "RUNNING" }
					: { id: done, status: "ERROR" },
		);
		const res = await POST(postRequest({ ids: [running, done] }));
		const body = (await res.json()) as {
			deleted: string[];
			skipped: { id: string; reason: string }[];
		};
		// ERROR reports ARE deletable (terminal); RUNNING is not.
		expect(body.deleted).toEqual([done]);
		expect(body.skipped).toEqual([
			{
				id: running,
				reason:
					"VMAF report is still RUNNING — wait for it to finish before deleting",
			},
		]);
		expect($transaction).toHaveBeenCalledTimes(1);
	});

	it("skips a missing report and rolls back a raced one, isolating both", async () => {
		const missing = id(1);
		const raced = id(2);
		const ok = id(3);
		findUnique.mockImplementation(
			async ({ where }: { where: { id: string } }) =>
				where.id === missing ? null : { id: where.id, status: "FINISHED" },
		);
		vmafDeleteMany.mockImplementation(
			async ({ where }: { where: { id: string } }) => ({
				count: where.id === raced ? 0 : 1,
			}),
		);
		const res = await POST(postRequest({ ids: [missing, raced, ok] }));
		const body = (await res.json()) as {
			deleted: string[];
			skipped: { id: string; reason: string }[];
		};
		expect(body.deleted).toEqual([ok]);
		expect(body.skipped).toEqual([
			{ id: missing, reason: "Not found" },
			{
				id: raced,
				reason:
					"VMAF report changed state and was not deleted — refresh and retry",
			},
		]);
	});

	it("audits every deletion under the resource path with the bulk endpoint recorded", async () => {
		const a = id(1);
		findUnique.mockResolvedValue({ id: a, status: "FINISHED" });
		await POST(postRequest({ ids: [a] }));
		expect(auditCreate).toHaveBeenCalledTimes(1);
		const arg = auditCreate.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(arg.data).toMatchObject({
			method: "DELETE",
			path: `/api/vmaf-jobs/${a}`,
			statusCode: 200,
		});
		expect(arg.data.request).toMatchObject({
			via: "/api/vmaf-jobs/bulk-delete",
		});
	});

	it("deduplicates repeated ids", async () => {
		const dup = id(4);
		findUnique.mockResolvedValue({ id: dup, status: "FINISHED" });
		const res = await POST(postRequest({ ids: [dup, dup, dup] }));
		const body = (await res.json()) as { deleted: string[] };
		expect(body.deleted).toEqual([dup]);
		expect($transaction).toHaveBeenCalledTimes(1);
	});

	it("deduplicates CASE VARIANTS of one id", async () => {
		const lower = id(5);
		findUnique.mockResolvedValue({ id: lower, status: "FINISHED" });
		const res = await POST(postRequest({ ids: [lower, lower.toUpperCase()] }));
		const body = (await res.json()) as { deleted: string[] };
		expect(body.deleted).toEqual([lower]);
		expect($transaction).toHaveBeenCalledTimes(1);
	});

	it("rate-limits a delete loop from one client", async () => {
		const CLIENT = "203.0.113.15";
		findUnique.mockResolvedValue({ id: id(6), status: "FINISHED" });
		for (let i = 0; i < 30; i += 1) {
			const ok = await POST(postRequest({ ids: [id(6)] }, CLIENT));
			expect(ok.status).toBe(200);
		}
		const limited = await POST(postRequest({ ids: [id(6)] }, CLIENT));
		expect(limited.status).toBe(429);
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
});
