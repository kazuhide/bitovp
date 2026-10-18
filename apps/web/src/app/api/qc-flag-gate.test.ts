import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * , the gate as ONE table rather than five near-identical cases.
 *
 * The rule this pins: OFF means nothing new can START and the browsing
 * surfaces are gone — it never means work that already exists becomes
 * unreachable. So the QC creation/browsing routes answer 404 while OFF, and
 * the RECOVERY PAIR (qc-override, qc-report) answers normally in BOTH states:
 * a job parked at AWAITING_QC under a BLOCK_MANIFESTS gate can only be
 * released through them .
 */
let qcVmafEnabled = false;

const prisma = {
	appSetting: {
		findUnique: async () => ({ value: { qcVmaf: qcVmafEnabled } }),
	},
	vmafJob: {
		findMany: async () => [],
		count: async () => 0,
		findUnique: async () => null,
		findFirst: async () => null,
	},
	encodingJob: { findUnique: async () => null },
	liveChannel: { findUnique: async () => null },
};

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({ prisma }),
}));
vi.mock("@/lib/server/queue", () => ({
	getVmafQueue: () => ({ add: async () => {} }),
	getOrchestratorQueue: () => ({ add: async () => {} }),
}));
vi.mock("@/lib/server/rate-limit", () => ({
	// The bulk-delete route builds a limiter at module scope; the gate answers
	// before it is consulted, so a permissive stub keeps this test about the
	// flag rather than about rate limiting.
	createFixedWindowLimiter: () => ({ take: () => ({ ok: true }) }),
	createTokenBucketLimiter: () => ({ take: () => ({ ok: true }) }),
	clientKey: () => "test",
}));

beforeEach(() => {
	qcVmafEnabled = false;
});

describe("the QC/VMAF flag gate (ledger #131)", () => {
	it("404s the creation and browsing routes while OFF", async () => {
		const { GET: labList, POST: measureExisting } = await import(
			"./vmaf-jobs/route"
		);
		const { GET: report, DELETE: deleteReport } = await import(
			"./vmaf-jobs/[id]/route"
		);
		const { GET: exportReport } = await import("./vmaf-jobs/[id]/export/route");
		const { POST: bulkDelete } = await import("./vmaf-jobs/bulk-delete/route");
		const { POST: capture } = await import(
			"./live-channels/[id]/capture-vmaf/route"
		);
		const params = { params: Promise.resolve({ id: "x" }) };
		const post = (body: unknown) =>
			new Request("http://t/x", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

		const statuses = await Promise.all([
			labList(new Request("http://t/api/vmaf-jobs")).then((r) => r.status),
			measureExisting(post({ encodingJobId: "x" })).then((r) => r.status),
			report(new Request("http://t/x"), params).then((r) => r.status),
			deleteReport(
				new Request("http://t/x", { method: "DELETE" }),
				params,
			).then((r) => r.status),
			exportReport(new Request("http://t/x"), params).then((r) => r.status),
			bulkDelete(post({ ids: ["x"] })).then((r) => r.status),
			capture(post({ model: "vmaf_v0.6.1" }), params).then((r) => r.status),
		]);
		expect(statuses).toEqual([404, 404, 404, 404, 404, 404, 404]);
	});

	it("does NOT 404 them while ON — the OFF case above is not passing for some other reason", async () => {
		qcVmafEnabled = true;
		const { GET: labList } = await import("./vmaf-jobs/route");
		const res = await labList(new Request("http://t/api/vmaf-jobs"));
		expect(res.status).not.toBe(404);
	});

	it("leaves the RECOVERY PAIR reachable while OFF — a parked job must stay releasable", async () => {
		const { POST: override } = await import(
			"./encoding-jobs/[id]/qc-override/route"
		);
		const { GET: evidence } = await import(
			"./encoding-jobs/[id]/qc-report/route"
		);
		const params = { params: Promise.resolve({ id: "x" }) };
		// The job does not exist in this harness, so both answer 404 for THAT
		// reason — what matters is the gate never runs. A gated route would
		// answer before touching the database at all, so the discriminator is
		// the error body, not the status.
		const overrideBody = await (
			await override(new Request("http://t/x", { method: "POST" }), params)
		).json();
		const evidenceBody = await (
			await evidence(new Request("http://t/x"), params)
		).json();
		for (const body of [overrideBody, evidenceBody]) {
			expect(JSON.stringify(body)).not.toContain("QC/VMAF is turned off");
		}
	});
});
