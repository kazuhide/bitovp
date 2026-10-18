import { describe, expect, it, vi } from "vitest";
import {
	createStrandedVmafReconciler,
	STRANDED_VMAF_ERROR,
} from "./reconcile-stranded";

/**
 * . The owner's report is the fixture: a VMAF row RUNNING since
 * 2026-06-21, blocking the data reset on 2026-08-18, with the app offering no
 * way to touch it and the refusal message pointing at Bitmovin — which never
 * saw this job, because VMAF is our own ffmpeg pipeline.
 */
function harness(
	rows: {
		id: string;
		encodingJobId?: string | null;
		triggerKey?: string | null;
	}[],
	states: Record<string, string | null>,
	options: { parkedJobId?: string; updateCount?: number } = {},
) {
	const updates: { where: unknown; data: unknown }[] = [];
	const added: { name: string; data: unknown; opts: unknown }[] = [];
	const prisma = {
		vmafJob: {
			findMany: vi.fn(async () =>
				rows.map((r) => ({ encodingJobId: null, triggerKey: null, ...r })),
			),
			updateMany: vi.fn(async (args: { where: unknown; data: unknown }) => {
				updates.push(args);
				// review-3: a hardcoded 1 made `retired += count` unpinnable and
				// hid the peer-finished-first path entirely.
				return { count: options.updateCount ?? 1 };
			}),
		},
		encodingJob: {
			findFirst: vi.fn(async (args: { where: { id: string } }) =>
				args.where.id === options.parkedJobId ? { id: args.where.id } : null,
			),
		},
	} as unknown as Parameters<typeof createStrandedVmafReconciler>[0]["prisma"];
	const queue = {
		name: "vmaf-runner",
		getJob: vi.fn(async (id: string) => {
			const state = states[id];
			return state === undefined ? undefined : { getState: async () => state };
		}),
	} as unknown as Parameters<typeof createStrandedVmafReconciler>[0]["queue"];
	const orchestratorQueue = {
		add: vi.fn(async (name: string, data: unknown, opts: unknown) => {
			added.push({ name, data, opts });
		}),
	} as unknown as NonNullable<
		Parameters<typeof createStrandedVmafReconciler>[0]["orchestratorQueue"]
	>;
	return { prisma, queue, orchestratorQueue, updates, added };
}

describe("retiring a VMAF report whose worker went away", () => {
	it("retires a RUNNING row the queue no longer holds", async () => {
		const { prisma, queue, updates } = harness([{ id: "v1" }], {});
		const retired = await createStrandedVmafReconciler({ prisma, queue })();
		expect(retired).toBe(1);
		// Conditional on RUNNING: a peer finishing between the read and this
		// write keeps its result.
		expect(updates[0]?.where).toEqual({ id: "v1", status: "RUNNING" });
		expect(updates[0]?.data).toEqual({
			status: "ERROR",
			error: STRANDED_VMAF_ERROR,
		});
		// The message must not send anyone to Bitmovin — that was the original
		// defect one layer up.
		expect(STRANDED_VMAF_ERROR).not.toMatch(/bitmovin/i);
	});

	it("leaves a row alone while a worker genuinely owns it", async () => {
		for (const state of ["active", "waiting", "delayed", "prioritized"]) {
			const { prisma, queue, updates } = harness([{ id: "v1" }], {
				v1: state,
			});
			const retired = await createStrandedVmafReconciler({ prisma, queue })();
			expect(retired, `state ${state} must survive`).toBe(0);
			expect(updates).toHaveLength(0);
		}
	});

	it("retires a row whose job exists but is FINISHED or failed in the queue", async () => {
		// The claim outlived the job: the row says RUNNING while the queue says
		// the attempt is over. Nothing is working on it.
		const { prisma, queue, updates } = harness([{ id: "v1" }], {
			v1: "failed",
		});
		expect(await createStrandedVmafReconciler({ prisma, queue })()).toBe(1);
		expect(updates).toHaveLength(1);
	});

	it("asks the QUEUE, not the clock — no updatedAt anywhere in the decision", async () => {
		// A long ffmpeg run that has not written a row in hours is still
		// running; a staleness threshold would retire it. The queue answers the
		// actual question, and `jobId === VmafJob.id` for every producer.
		const { prisma, queue } = harness([{ id: "v1" }], { v1: "active" });
		await createStrandedVmafReconciler({ prisma, queue })();
		expect(vi.mocked(prisma.vmafJob.findMany).mock.calls[0]?.[0]).toEqual({
			where: { status: "RUNNING" },
			// encodingJobId rides along for the parked-job wake (review-3 I1);
			// `take` bounds a pathological table.
			select: { id: true, encodingJobId: true, triggerKey: true },
			take: 500,
		});
		expect(vi.mocked(queue.getJob)).toHaveBeenCalledWith("v1");
	});
});

describe("the states it will and will not retire (review-3 I4)", () => {
	it("retires ONLY on a known-dead state — an unrecognised one is left alone", async () => {
		// The polarity is the point. The first cut enumerated the LIVE states,
		// so anything BullMQ added later (or `waiting-children`, which it
		// already has) would have been retired as dead with no test failing.
		for (const state of ["completed", "failed", "unknown"]) {
			const { prisma, queue, updates } = harness([{ id: "v1" }], { v1: state });
			expect(
				await createStrandedVmafReconciler({ prisma, queue })(),
				`${state} must retire`,
			).toBe(1);
			expect(updates).toHaveLength(1);
		}
		for (const state of [
			"active",
			"waiting",
			"delayed",
			"prioritized",
			"waiting-children",
			"some-state-bullmq-adds-in-2027",
		]) {
			const { prisma, queue, updates } = harness([{ id: "v1" }], { v1: state });
			expect(
				await createStrandedVmafReconciler({ prisma, queue })(),
				`${state} must survive`,
			).toBe(0);
			expect(updates).toHaveLength(0);
		}
	});

	it("counts what the database actually changed, not one per row", async () => {
		// A peer that finished between the read and the write keeps its result,
		// and the reconciler must not claim to have retired it.
		const { prisma, queue } = harness([{ id: "v1" }], {}, { updateCount: 0 });
		expect(await createStrandedVmafReconciler({ prisma, queue })()).toBe(0);
	});
});

describe("waking a job parked behind the retired report (review-3 I1)", () => {
	it("enqueues the QC continuation when its job sits at AWAITING_QC", async () => {
		const { prisma, queue, orchestratorQueue, added } = harness(
			// The vod-auto trigger row for that job — the SAME scope
			// resolveQcBoundary reads (review-3 S1).
			[
				{
					id: "v1",
					encodingJobId: "job-1",
					triggerKey: "vod-auto:job-1",
				},
			],
			{},
			{ parkedJobId: "job-1" },
		);
		expect(
			await createStrandedVmafReconciler({
				prisma,
				queue,
				orchestratorQueue,
			})(),
		).toBe(1);
		// Without this the fix creates a NEW stranded row: AWAITING_QC's only
		// exit is this continuation, and the processor's self-heal runs on a
		// redelivery that the reconciler's own precondition rules out.
		expect(added).toHaveLength(1);
		expect(added[0]?.data).toEqual({ encodingJobId: "job-1" });
		expect((added[0]?.opts as { jobId: string }).jobId).toBe(
			"job-1-resume-post-qc-v1",
		);
	});

	it("does not wake a job that is not parked", async () => {
		const { prisma, queue, orchestratorQueue, added } = harness(
			[{ id: "v1", encodingJobId: "job-1", triggerKey: "vod-auto:job-1" }],
			{},
			{ parkedJobId: undefined },
		);
		await createStrandedVmafReconciler({ prisma, queue, orchestratorQueue })();
		expect(added).toHaveLength(0);
	});

	it("does not wake anything when the row was NOT retired", async () => {
		const { prisma, queue, orchestratorQueue, added } = harness(
			[{ id: "v1", encodingJobId: "job-1", triggerKey: "vod-auto:job-1" }],
			{},
			{ parkedJobId: "job-1", updateCount: 0 },
		);
		await createStrandedVmafReconciler({ prisma, queue, orchestratorQueue })();
		expect(added).toHaveLength(0);
	});
});

describe("the queue it is pointed at (review-3 I5)", () => {
	it("refuses any queue but the VMAF runner", () => {
		const { prisma } = harness([], {});
		const wrong = { name: "orchestrator", getJob: async () => undefined };
		expect(() =>
			createStrandedVmafReconciler({
				prisma,
				queue: wrong as unknown as Parameters<
					typeof createStrandedVmafReconciler
				>[0]["queue"],
			}),
		).toThrow(/vmaf-runner/);
		// The failure mode it prevents: getJob on the wrong queue answers
		// undefined for every row, so EVERY running report reads as stranded.
	});
});

describe("the wake's scope matches the boundary's (review-3 S1)", () => {
	it("does NOT wake on a lab-manual row that merely names the same job", async () => {
		// resolveQcBoundary reads `vod-auto:<encodingJobId>` specifically —
		// scoped after an unscoped read once let a lab row fail-close a passing
		// job. Waking on any row carrying an encodingJobId is the writer's side
		// of that same mistake.
		const { prisma, queue, orchestratorQueue, added } = harness(
			[{ id: "v1", encodingJobId: "job-1", triggerKey: "lab-manual:v1" }],
			{},
			{ parkedJobId: "job-1" },
		);
		expect(
			await createStrandedVmafReconciler({
				prisma,
				queue,
				orchestratorQueue,
			})(),
		).toBe(1);
		expect(added).toHaveLength(0);
	});

	it("does not wake a row with no trigger key at all", async () => {
		const { prisma, queue, orchestratorQueue, added } = harness(
			[{ id: "v1", encodingJobId: "job-1", triggerKey: null }],
			{},
			{ parkedJobId: "job-1" },
		);
		await createStrandedVmafReconciler({ prisma, queue, orchestratorQueue })();
		expect(added).toHaveLength(0);
	});
});
