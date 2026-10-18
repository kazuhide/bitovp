import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const jobDeleteMany = vi.fn();
const vmafDeleteMany = vi.fn();
const vmafFindFirst = vi.fn();
const vmafCount = vi.fn();
const auditCreate = vi.fn();
const lockJob = vi.fn();
const snapshotJobs = vi.fn();
const findCapturedSource = vi.fn();

// Interactive $transaction: invoke the callback with a tx exposing the same
// model methods the shared delete helper uses.
const tx = {
	$queryRaw: lockJob,
	librarySource: { findUnique: findCapturedSource },
	vmafJob: { deleteMany: vmafDeleteMany, count: vmafCount },
	encodingJob: { deleteMany: jobDeleteMany, findMany: snapshotJobs },
};
const $transaction = vi.fn((cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			encodingJob: { findUnique, deleteMany: jobDeleteMany },
			vmafJob: {
				deleteMany: vmafDeleteMany,
				findFirst: vmafFindFirst,
				count: vmafCount,
			},
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
	return new Request("http://test/api/encoding-jobs/bulk-delete", {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "x-forwarded-for": client ?? `10.0.0.${++clientSeq}` },
	});
}

/** Row factory: terminal by default. */
function row(
	rowId: string,
	status = "FINISHED",
	accountId: string | null = null,
) {
	return { id: rowId, status, bitmovinAccountId: accountId };
}

beforeEach(() => {
	vi.clearAllMocks();
	lockJob.mockResolvedValue([]);
	snapshotJobs.mockResolvedValue([]);
	findCapturedSource.mockResolvedValue(null);
	vmafDeleteMany.mockResolvedValue({ count: 0 });
	jobDeleteMany.mockResolvedValue({ count: 1 });
	// Default: no VMAF report is mid-scoring.
	vmafFindFirst.mockResolvedValue(null);
	vmafCount.mockResolvedValue(0);
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

describe("POST /api/encoding-jobs/bulk-delete", () => {
	it("skips uncaptured AISA history while deleting a captured job in the same batch", async () => {
		const uncaptured = id(1);
		const captured = id(2);
		findUnique.mockImplementation(
			async ({ where }: { where: { id: string } }) => row(where.id),
		);
		snapshotJobs.mockImplementation(
			async ({ where }: { where: { id: { in: string[] } } }) =>
				where.id.in.map((jobId) => ({
					id: jobId,
					bitmovinEncodingId: jobId,
					plan: { aiSceneAnalysis: {} },
				})),
		);
		findCapturedSource
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ id: "source-2" });
		const response = await POST(postRequest({ ids: [uncaptured, captured] }));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			deleted: [captured],
			skipped: [
				{
					id: uncaptured,
					reason: expect.stringMatching(/Capture AI Scene Analysis/),
				},
			],
		});
		expect(jobDeleteMany).toHaveBeenCalledTimes(1);
		expect(jobDeleteMany).toHaveBeenCalledWith({
			where: { id: captured, status: { notIn: ["QUEUED", "RUNNING"] } },
		});
		expect(lockJob).toHaveBeenCalledTimes(2);
		expect(snapshotJobs).toHaveBeenCalledWith({
			where: { status: "FINISHED", id: { in: [uncaptured] } },
			select: { id: true, plan: true, bitmovinEncodingId: true },
		});
	});
	it("rejects an empty id list", async () => {
		const res = await POST(postRequest({ ids: [] }));
		expect(res.status).toBe(400);
		expect($transaction).not.toHaveBeenCalled();
	});

	it("rejects more than 50 ids (the shared bulk cap)", async () => {
		const ids = Array.from({ length: 51 }, (_, i) => id(i));
		const res = await POST(postRequest({ ids }));
		expect(res.status).toBe(400);
		expect($transaction).not.toHaveBeenCalled();
	});

	it("rejects non-uuid ids", async () => {
		const res = await POST(postRequest({ ids: ["nope"] }));
		expect(res.status).toBe(400);
	});

	it("runs the single route's terminal-guarded transaction per id (dependents first)", async () => {
		const a = id(1);
		findUnique.mockResolvedValue(row(a));
		vmafDeleteMany.mockResolvedValue({ count: 2 });
		const res = await POST(postRequest({ ids: [a] }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ deleted: [a], skipped: [] });
		// VmafJobs (FK SetNull, not Cascade) go FIRST, inside the tx — and only
		// the TERMINAL ones: a report still being scored blocks the delete
		// instead of being destroyed with the job.
		expect(vmafDeleteMany).toHaveBeenCalledWith({
			where: { encodingJobId: a, status: { in: ["FINISHED", "ERROR"] } },
		});
		// …then the status-guarded parent delete, whose count is asserted.
		expect(jobDeleteMany).toHaveBeenCalledWith({
			where: { id: a, status: { notIn: ["QUEUED", "RUNNING"] } },
		});
		expect($transaction).toHaveBeenCalledTimes(1);
	});

	it("skips an active job with the single route's own 409 reason and never opens a tx for it", async () => {
		const active = id(1);
		const terminal = id(2);
		findUnique.mockImplementation(
			async ({ where }: { where: { id: string } }) =>
				where.id === active ? row(active, "RUNNING") : row(terminal),
		);
		const res = await POST(postRequest({ ids: [active, terminal] }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			deleted: string[];
			skipped: { id: string; reason: string }[];
		};
		expect(body.deleted).toEqual([terminal]);
		expect(body.skipped).toEqual([
			{
				id: active,
				reason: "Job is still RUNNING — cancel it before deleting",
			},
		]);
		// One transaction only — the active id never reached the guarded delete.
		expect($transaction).toHaveBeenCalledTimes(1);
	});

	it("skips a missing id (404 equivalent) without aborting the batch", async () => {
		const missing = id(1);
		const present = id(2);
		findUnique.mockImplementation(
			async ({ where }: { where: { id: string } }) =>
				where.id === missing ? null : row(present),
		);
		const res = await POST(postRequest({ ids: [missing, present] }));
		const body = (await res.json()) as {
			deleted: string[];
			skipped: { id: string; reason: string }[];
		};
		expect(body.deleted).toEqual([present]);
		expect(body.skipped).toEqual([{ id: missing, reason: "Not found" }]);
	});

	it("rolls back and skips an id that races out of the terminal set (guard hits 0 rows)", async () => {
		const raced = id(1);
		const ok = id(2);
		findUnique.mockImplementation(
			async ({ where }: { where: { id: string } }) => row(where.id),
		);
		jobDeleteMany.mockImplementation(
			async ({ where }: { where: { id: string } }) => ({
				count: where.id === raced ? 0 : 1,
			}),
		);
		const res = await POST(postRequest({ ids: [raced, ok] }));
		const body = (await res.json()) as {
			deleted: string[];
			skipped: { id: string; reason: string }[];
		};
		expect(body.deleted).toEqual([ok]);
		expect(body.skipped).toEqual([
			{
				id: raced,
				reason: "Job changed state and was not deleted — refresh and retry",
			},
		]);
		// Only the successful delete is audited — a rolled-back id leaves no trail.
		expect(auditCreate).toHaveBeenCalledTimes(1);
	});

	it("isolates an unexpected per-id DB error — and logs it", async () => {
		const boom = id(1);
		const ok = id(2);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		findUnique.mockImplementation(
			async ({ where }: { where: { id: string } }) => {
				if (where.id === boom) {
					throw new Error("connection reset");
				}
				return row(ok);
			},
		);
		const res = await POST(postRequest({ ids: [boom, ok] }));
		const body = (await res.json()) as {
			deleted: string[];
			skipped: { id: string; reason: string }[];
		};
		expect(body.deleted).toEqual([ok]);
		// A FIXED reason on the wire, matching `http.ts`'s policy for unexpected
		// errors — the detail belongs in the server log, asserted below. The bulk
		// routes used to echo `err.message` while the per-id routes did not
		// (review catch).
		expect(body.skipped).toEqual([{ id: boom, reason: "Delete failed" }]);
		expect(logged).toHaveBeenCalledWith(
			expect.stringContaining(boom),
			expect.stringContaining("connection reset"),
		);
		logged.mockRestore();
	});

	it("audits EVERY deletion under the resource path, recording the bulk endpoint", async () => {
		const a = id(1);
		const b = id(2);
		const account = "00000000-0000-4000-8000-00000000aaaa";
		findUnique.mockImplementation(
			async ({ where }: { where: { id: string } }) =>
				row(where.id, "FINISHED", account),
		);
		vmafDeleteMany.mockResolvedValue({ count: 1 });
		await POST(postRequest({ ids: [a, b] }));
		expect(auditCreate).toHaveBeenCalledTimes(2);
		const first = auditCreate.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(first.data).toMatchObject({
			method: "DELETE",
			path: `/api/encoding-jobs/${a}`,
			statusCode: 200,
			bitmovinAccountId: account,
		});
		expect(first.data.request).toMatchObject({
			via: "/api/encoding-jobs/bulk-delete",
		});
		expect(first.data.response).toMatchObject({ deletedVmafJobs: 1 });
	});

	it("deduplicates repeated ids", async () => {
		const dup = id(9);
		findUnique.mockResolvedValue(row(dup));
		const res = await POST(postRequest({ ids: [dup, dup] }));
		const body = (await res.json()) as { deleted: string[] };
		expect(body.deleted).toEqual([dup]);
		expect($transaction).toHaveBeenCalledTimes(1);
	});

	it("deduplicates CASE VARIANTS of one id", async () => {
		const lower = id(11);
		findUnique.mockResolvedValue(row(lower));
		const res = await POST(postRequest({ ids: [lower, lower.toUpperCase()] }));
		const body = (await res.json()) as { deleted: string[] };
		expect(body.deleted).toEqual([lower]);
		expect($transaction).toHaveBeenCalledTimes(1);
	});

	it("SKIPS a job whose VMAF report is still scoring, and deletes nothing", async () => {
		const scoring = id(12);
		findUnique.mockResolvedValue(row(scoring));
		vmafFindFirst.mockResolvedValue({ status: "RUNNING" });
		const res = await POST(postRequest({ ids: [scoring] }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			deleted: string[];
			skipped: { id: string; reason: string }[];
		};
		expect(body.deleted).toEqual([]);
		expect(body.skipped).toEqual([
			{
				id: scoring,
				reason:
					"A VMAF report for this job is still RUNNING — wait for it to finish before deleting",
			},
		]);
		// The old code ran an unguarded vmafJob.deleteMany and destroyed the
		// in-flight report along with the job.
		expect($transaction).not.toHaveBeenCalled();
		expect(vmafDeleteMany).not.toHaveBeenCalled();
		expect(jobDeleteMany).not.toHaveBeenCalled();
	});

	it("skips only the blocked id and still deletes the rest of the batch", async () => {
		const ok = id(13);
		const scoring = id(14);
		findUnique.mockImplementation(
			async ({ where }: { where: { id: string } }) => row(where.id),
		);
		vmafFindFirst.mockImplementation(
			async ({ where }: { where: { encodingJobId: string } }) =>
				where.encodingJobId === scoring ? { status: "PENDING" } : null,
		);
		const res = await POST(postRequest({ ids: [ok, scoring] }));
		const body = (await res.json()) as {
			deleted: string[];
			skipped: { id: string; reason: string }[];
		};
		expect(body.deleted).toEqual([ok]);
		expect(body.skipped.map((s) => s.id)).toEqual([scoring]);
	});

	it("still deletes TERMINAL vmaf reports with the job", async () => {
		const target = id(15);
		findUnique.mockResolvedValue(row(target));
		vmafDeleteMany.mockResolvedValue({ count: 2 });
		const res = await POST(postRequest({ ids: [target] }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { deleted: string[] };
		expect(body.deleted).toEqual([target]);
		// Status-guarded, never a bare deleteMany.
		expect(vmafDeleteMany).toHaveBeenCalledWith({
			where: {
				encodingJobId: target,
				status: { in: ["FINISHED", "ERROR"] },
			},
		});
	});

	/**
	 * The SHIPPED DEFAULT, which nothing else covers.
	 *
	 * Every other rate-limit test in the repo stubs `TRUSTED_PROXY_HOPS=1` so it
	 * can give each caller its own bucket — and with a single-hop header the
	 * first-hop and last-hop derivations return the SAME key, so those tests pass
	 * identically against the client-forgeable version this replaced. Verified by
	 * reverting `clientKey` and running the whole web suite: 11 failures, all of
	 * them in `rate-limit.test.ts`, none in any route suite.
	 *
	 * So this is the one place a route asserts what an install that has NOT
	 * declared its topology actually does: one shared bucket. That is deliberately
	 * a degraded-service trade rather than a bypass — a flood spends a budget the
	 * honest caller also draws on, which for a bulk-delete route is acceptable and
	 * for the login route was not (hence the peek gate there).
	 */
	it("shares ONE bucket across callers when no proxy topology is declared", async () => {
		vi.stubEnv("TRUSTED_PROXY_HOPS", "");
		findUnique.mockResolvedValue(row(id(17)));
		for (let i = 0; i < 30; i += 1) {
			const ok = await POST(postRequest({ ids: [id(17)] }, `198.51.100.${i}`));
			expect(ok.status).toBe(200);
		}
		// A 31st caller with a completely different address is refused: the address
		// was never the key. Under the forgeable version this was a fresh bucket.
		const other = await POST(postRequest({ ids: [id(17)] }, "203.0.113.200"));
		expect(other.status).toBe(429);
	});

	it("rate-limits a delete loop from one client", async () => {
		const CLIENT = "203.0.113.14";
		findUnique.mockResolvedValue(row(id(16)));
		for (let i = 0; i < 30; i += 1) {
			const ok = await POST(postRequest({ ids: [id(16)] }, CLIENT));
			expect(ok.status).toBe(200);
		}
		const limited = await POST(postRequest({ ids: [id(16)] }, CLIENT));
		expect(limited.status).toBe(429);
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
});
