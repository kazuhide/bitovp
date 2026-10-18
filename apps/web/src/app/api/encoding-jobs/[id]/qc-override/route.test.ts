import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Override-and-deliver route . The
 * pins: QC_FAILED-only (atomic claim, not a read-then-write), the flag rides
 * the SAME claim write, the audit record exists, the enqueue id is unique
 * per attempt (the /retry swallow lesson), and an enqueue failure reverts
 * BOTH status and flag — an un-acted override must not linger.
 */

const findUnique = vi.fn();
const updateMany = vi.fn();
const update = vi.fn();
const auditCreate = vi.fn(async () => ({}));
const queueAdd = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			encodingJob: { findUnique, updateMany, update },
			auditLog: { create: auditCreate },
		},
	}),
}));
vi.mock("@/lib/server/queue", () => ({
	getOrchestratorQueue: () => ({ add: queueAdd }),
}));

import { POST } from "./route";

const JOB_ID = "00000000-0000-4000-8000-0000000000aa";

/**
 * The actor the proxy stamps on an authenticated request. This route is the
 * one whose audit row was measured landing with an EMPTY actor ,
 * so its own test carries the header and asserts the value reaches the row.
 */
const ACTOR = "token:00000000-0000-4000-8000-0000000000ac";

function request(): [Request, { params: Promise<{ id: string }> }] {
	return [
		new Request(`http://test/api/encoding-jobs/${JOB_ID}/qc-override`, {
			method: "POST",
			headers: { "x-bitovp-actor": ACTOR },
		}),
		{ params: Promise.resolve({ id: JOB_ID }) },
	];
}

const BLOCKED_LOG = [
	{ step: "encoding", kind: "CREATE_ENCODING", status: "DONE" },
	{
		step: "manifest:hls",
		kind: "CREATE_MANIFEST_HLS",
		status: "PENDING",
		phase: "post-qc",
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	// review-203 N3: the route fail-fasts on the master key like /retry.
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
	findUnique.mockResolvedValue({
		id: JOB_ID,
		status: "QC_FAILED",
		stepLog: BLOCKED_LOG,
	});
	updateMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("POST /api/encoding-jobs/[id]/qc-override", () => {
	it("a broken MASTER_KEY fails BEFORE consuming the override (review-203 N3)", async () => {
		vi.unstubAllEnvs();
		const [req, params] = request();
		const res = await POST(req, params);
		expect(res.status).toBeGreaterThanOrEqual(500);
		// Nothing was claimed, audited or enqueued — the decision is intact.
		expect(updateMany).not.toHaveBeenCalled();
		expect(auditCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("404s an unknown job", async () => {
		findUnique.mockResolvedValue(null);
		const [req, params] = request();
		expect((await POST(req, params)).status).toBe(404);
	});

	it("409s any status but QC_FAILED — override is not a generic resume", async () => {
		for (const status of ["FINISHED", "AWAITING_QC", "ERROR", "RUNNING"]) {
			findUnique.mockResolvedValue({
				id: JOB_ID,
				status,
				stepLog: BLOCKED_LOG,
			});
			const [req, params] = request();
			const res = await POST(req, params);
			expect(res.status, status).toBe(409);
		}
		expect(updateMany).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("409s a QC_FAILED job with no blocked manifest steps", async () => {
		findUnique.mockResolvedValue({
			id: JOB_ID,
			status: "QC_FAILED",
			stepLog: [{ step: "encoding", kind: "CREATE_ENCODING", status: "DONE" }],
		});
		const [req, params] = request();
		expect((await POST(req, params)).status).toBe(409);
	});

	it("claims atomically: the flag rides the SAME write as the status flip", async () => {
		const [req, params] = request();
		const res = await POST(req, params);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; overriddenAt: string };
		expect(body.status).toBe("QUEUED");
		expect(updateMany).toHaveBeenCalledWith({
			where: { id: JOB_ID, status: "QC_FAILED" },
			data: expect.objectContaining({
				status: "QUEUED",
				error: null,
				qcOverriddenAt: expect.any(Date),
			}),
		});
		// Audited (the whole point of an OVERRIDE vs a silent resume) — and
		// ATTRIBUTED. `toHaveBeenCalled` alone was what let the original
		// defect ship: the row was written, with a NULL actor, and this
		// assertion could not tell the difference.
		expect(auditCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ actor: ACTOR }),
			}),
		);
		// Enqueued with a unique-per-attempt id (the /retry swallow lesson) —
		// and a DASH-joined one (BullMQ rejects ':').
		const opts = queueAdd.mock.calls[0]?.[2] as { jobId: string };
		expect(opts.jobId).toMatch(new RegExp(`^${JOB_ID}-qc-override-\\d+$`));
		expect(opts.jobId).not.toContain(":");
	});

	it("409s when a concurrent override wins the claim", async () => {
		updateMany.mockResolvedValue({ count: 0 });
		const [req, params] = request();
		expect((await POST(req, params)).status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("an enqueue failure reverts status AND flag — no QUEUED-forever, no stale override", async () => {
		queueAdd.mockRejectedValueOnce(new Error("redis gone"));
		const [req, params] = request();
		const res = await POST(req, params);
		expect(res.status).toBe(500);
		expect(update).toHaveBeenCalledWith({
			where: { id: JOB_ID },
			data: expect.objectContaining({
				status: "QC_FAILED",
				qcOverriddenAt: null,
			}),
		});
	});
});
