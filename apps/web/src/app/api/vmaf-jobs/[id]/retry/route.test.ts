import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compilePlan, encodingPlanSchema, initStepLog } from "@bitovp/core";
import { autoTriggerKey } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "00000000-0000-4000-8000-000000000011";
const JOB = "00000000-0000-4000-8000-000000000022";
const findUnique = vi.fn();
const pointer = vi.fn();
const claim = vi.fn();
const create = vi.fn();
const count = vi.fn();
const encodingUpdate = vi.fn();
const encodingUpdateMany = vi.fn();
const add = vi.fn();
const getJob = vi.fn();
const disabled = vi.fn();
const queryRaw = vi.fn();
const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
	fn({
		$queryRaw: queryRaw,
		vmafJob: { findUnique, updateMany: claim, create, count },
		encodingJob: { update: encodingUpdate, updateMany: encodingUpdateMany },
	}),
);
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			vmafJob: { findUnique: pointer },
			$transaction: transaction,
		},
	}),
}));
vi.mock("@/lib/server/feature-flags", () => ({
	requireQcVmafEnabled: () => disabled(),
}));
vi.mock("@/lib/server/queue", () => ({
	getVmafQueue: () => ({ add, getJob }),
}));

import { POST } from "./route";

const plan = encodingPlanSchema.parse({
	...JSON.parse(
		readFileSync(
			resolve(
				process.cwd(),
				"../../packages/core/src/plan/__fixtures__/ai-scene-analysis-pertitle.plan.json",
			),
			"utf8",
		),
	),
	generation: { timing: "POST_ENCODING" },
	qc: {
		vmaf: true,
		model: "vmaf_v0.6.1",
		gate: {
			onFail: "BLOCK_MANIFESTS",
			rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 80 }],
		},
	},
});
const steps = initStepLog(compilePlan(plan)).map((step) => ({
	...step,
	status: step.phase === "post-qc" ? "PENDING" : "DONE",
}));
function row(overrides = {}) {
	return {
		id: ID,
		encodingJobId: JOB,
		mode: "VOD",
		status: "ERROR",
		params: {},
		model: "vmaf_v0.6.1",
		triggerKey: autoTriggerKey(JOB),
		encodingJob: {
			status: "FINISHED",
			plan,
			stepLog: steps,
			qcOverriddenAt: null,
		},
		...overrides,
	};
}
const post = () =>
	POST(new Request("http://localhost/retry", { method: "POST" }), {
		params: Promise.resolve({ id: ID }),
	});
beforeEach(() => {
	vi.resetAllMocks();
	disabled.mockResolvedValue(null);
	pointer.mockResolvedValue({ encodingJobId: JOB });
	findUnique.mockResolvedValue(row());
	claim.mockResolvedValue({ count: 1 });
	count.mockResolvedValue(0);
	create.mockResolvedValue({ id: "new-report" });
	getJob.mockResolvedValue(null);
});
describe("local VMAF-only retry", () => {
	it("preserves explicit reference preparation while regenerating proof and native selection", async () => {
		findUnique.mockResolvedValue(
			row({
				triggerKey: `lab-manual:${JOB}:model:1`,
				params: {
					execution: { backend: "LOCAL", localMode: "AUTO" },
					source: "QC_MIRROR",
					referencePreparation: "LOSSLESS_DISPLAY_SCALE_REMUX",
					localSelection: { backend: "cuda" },
					localScoring: { backend: "cuda" },
					referencePreparationEvidence: { frameCount: 1 },
				},
			}),
		);
		expect((await post()).status).toBe(201);
		expect(create.mock.calls[0]?.[0].data.params).toEqual({
			execution: { backend: "LOCAL", localMode: "AUTO" },
			source: "QC_MIRROR",
			referencePreparation: "LOSSLESS_DISPLAY_SCALE_REMUX",
			retryOf: ID,
		});
	});
	it.each([
		{
			referencePreparation: "UNKNOWN",
			localMode: "AUTO",
			kind: undefined,
			automatic: false,
			method: undefined,
		},
		{
			referencePreparation: "LOSSLESS_DISPLAY_SCALE_REMUX",
			localMode: "CPU",
			kind: undefined,
			automatic: false,
			method: undefined,
		},
		{
			referencePreparation: "LOSSLESS_DISPLAY_SCALE_REMUX",
			localMode: "AUTO",
			kind: "BANDING",
			automatic: false,
			method: undefined,
		},
		{
			referencePreparation: "LOSSLESS_DISPLAY_SCALE_REMUX",
			localMode: "AUTO",
			kind: undefined,
			automatic: true,
			method: undefined,
		},
		{
			referencePreparation: "LOSSLESS_DISPLAY_SCALE_REMUX",
			localMode: "AUTO",
			kind: undefined,
			automatic: false,
			method: "FRAME_INDEX_BT709_10BIT",
		},
	])("rejects unsupported reference preparation retry intent %# before claiming history", async (item) => {
		findUnique.mockResolvedValue(
			row({
				triggerKey: item.automatic
					? autoTriggerKey(JOB)
					: `lab-manual:${JOB}:model:1`,
				params: {
					execution: { backend: "LOCAL", localMode: item.localMode },
					referencePreparation: item.referencePreparation,
					...(item.kind ? { kind: item.kind } : {}),
					...(item.method ? { measurementMethod: item.method } : {}),
				},
			}),
		);
		expect((await post()).status).toBe(409);
		expect(claim).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
		expect(add).not.toHaveBeenCalled();
	});
	it("retains the Banding discriminator and generation when retrying CAMBI evidence", async () => {
		findUnique.mockResolvedValue(
			row({
				model: "CAMBI",
				params: {
					kind: "BANDING",
					source: "OUTPUT_MP4",
					execution: { backend: "LOCAL", localMode: "AUTO" },
					bandingSelection: { backend: "cuda" },
				},
			}),
		);
		expect((await post()).status).toBe(201);
		expect(create.mock.calls[0]?.[0].data).toMatchObject({
			model: "CAMBI",
			scoringVersion: 11,
			params: {
				kind: "BANDING",
				source: "OUTPUT_MP4",
				execution: { backend: "LOCAL", localMode: "AUTO" },
				retryOf: ID,
			},
		});
		expect(create.mock.calls[0]?.[0].data.params).not.toHaveProperty(
			"bandingSelection",
		);
	});

	it("keeps optional Banding for combined VMAF retries", async () => {
		findUnique.mockResolvedValue(
			row({ params: { banding: true, psnr: true } }),
		);
		expect((await post()).status).toBe(201);
		expect(create.mock.calls[0]?.[0].data.params).toMatchObject({
			banding: true,
			psnr: true,
		});
	});
	it("preserves an explicit Banding-off choice over a combined parent on retry", async () => {
		findUnique.mockResolvedValue(
			row({
				params: {
					banding: false,
					psnr: true,
					execution: { backend: "LOCAL", localMode: "CPU" },
				},
				encodingJob: {
					...row().encodingJob,
					plan: { ...plan, qc: { ...plan.qc, banding: true } },
				},
			}),
		);
		expect((await post()).status).toBe(201);
		expect(create.mock.calls[0]?.[0].data.params).toMatchObject({
			banding: false,
			psnr: true,
			execution: { backend: "LOCAL", localMode: "CPU" },
			retryOf: ID,
		});
	});
	it.each([
		"CPU",
		"AUTO",
	] as const)("preserves %s intent while creating a fresh measurement", async (localMode) => {
		const execution = { backend: "LOCAL", localMode };
		findUnique.mockResolvedValue(
			row({
				params: {
					execution,
					localSelection: { backend: "cuda", requested: localMode },
					localScoring: { backend: "cuda" },
				},
			}),
		);
		expect((await post()).status).toBe(201);
		expect(create.mock.calls[0]?.[0].data.params).toEqual({
			execution,
			retryOf: ID,
		});
	});
	it("keeps failed evidence and creates only a local VMAF queue item", async () => {
		expect((await post()).status).toBe(201);
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					triggerKey: autoTriggerKey(JOB),
					params: { execution: { backend: "LOCAL" }, retryOf: ID },
					status: "PENDING",
				}),
			}),
		);
		expect(add).toHaveBeenCalledWith(
			"vmaf",
			{ vmafJobId: "new-report" },
			expect.objectContaining({ jobId: "new-report" }),
		);
		expect(encodingUpdate).not.toHaveBeenCalled();
		expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: "Serializable",
		});
		expect(queryRaw).toHaveBeenCalled();
	});
	it("reopens a measurement-error gate only after every encoding step is done", async () => {
		const failed = row();
		failed.encodingJob.status = "QC_FAILED";
		findUnique.mockResolvedValue(failed);
		expect((await post()).status).toBe(201);
		expect(encodingUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "AWAITING_QC", error: null }),
			}),
		);
	});
	it("rejects unfinished pre-QC work instead of restarting encoding", async () => {
		const failed = row();
		failed.encodingJob.status = "QC_FAILED";
		failed.encodingJob.stepLog = steps.map((step, i) =>
			i === 0 ? { ...step, status: "PENDING" } : step,
		);
		findUnique.mockResolvedValue(failed);
		expect((await post()).status).toBe(409);
		expect(create).not.toHaveBeenCalled();
	});
	it.each([
		"active",
		"waiting",
		"delayed",
		"waiting-children",
	])("refuses a previous queue item in %s", async (state) => {
		getJob.mockResolvedValue({ getState: async () => state });
		expect((await post()).status).toBe(409);
		expect(create).not.toHaveBeenCalled();
	});
	it.each([
		"PENDING",
		"RUNNING",
		"FINISHED",
	])("refuses report state %s", async (status) => {
		findUnique.mockResolvedValue(row({ status }));
		expect((await post()).status).toBe(409);
		expect(add).not.toHaveBeenCalled();
	});
	it("refuses cloud retry rather than spending from an old budget", async () => {
		findUnique.mockResolvedValue(
			row({
				params: {
					execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
				},
			}),
		);
		expect((await post()).status).toBe(409);
		expect(add).not.toHaveBeenCalled();
	});
	it("refuses an active sibling and a duplicate claim", async () => {
		count.mockResolvedValueOnce(1);
		expect((await post()).status).toBe(409);
		claim.mockResolvedValueOnce({ count: 0 });
		expect((await post()).status).toBe(409);
		expect(create).not.toHaveBeenCalled();
	});
	it("refuses a report whose ownership already moved to a retry", async () => {
		findUnique.mockResolvedValue(row({ triggerKey: `retry-history:${ID}` }));
		expect((await post()).status).toBe(409);
		expect(add).not.toHaveBeenCalled();
	});
	it("retains output-source and PSNR choice for a manual measurement", async () => {
		findUnique.mockResolvedValue(
			row({
				triggerKey: `lab-manual:${JOB}:model:1`,
				params: { source: "OUTPUT_MP4", psnr: true },
			}),
		);
		expect((await post()).status).toBe(201);
		expect(create.mock.calls[0]?.[0].data).toMatchObject({
			params: { source: "OUTPUT_MP4", psnr: true },
			triggerKey: `lab-manual:${JOB}:vmaf_v0.6.1:retry-${ID}`,
		});
	});

	it("does not rewind a replacement already claimed when enqueue acknowledgement fails", async () => {
		const failed = row();
		failed.encodingJob.status = "QC_FAILED";
		findUnique.mockResolvedValue(failed);
		claim
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 });
		add.mockRejectedValueOnce(new Error("redis acknowledgement lost"));
		expect((await post()).status).toBe(500);
		expect(encodingUpdateMany).not.toHaveBeenCalled();
	});
	it("turns a concurrent serializable conflict into an actionable 409", async () => {
		transaction.mockRejectedValueOnce({ code: "P2034" });
		expect((await post()).status).toBe(409);
		expect(add).not.toHaveBeenCalled();
	});
	it("makes an enqueue failure actionable again without overriding a worker claim", async () => {
		const failed = row();
		failed.encodingJob.status = "QC_FAILED";
		findUnique.mockResolvedValue(failed);
		add.mockRejectedValueOnce(new Error("redis unavailable"));
		expect((await post()).status).toBe(500);
		expect(claim).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: { id: "new-report", status: "PENDING" },
				data: expect.objectContaining({ status: "ERROR" }),
			}),
		);
		expect(encodingUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: JOB, status: "AWAITING_QC" },
				data: expect.objectContaining({ status: "QC_FAILED" }),
			}),
		);
	});
});
