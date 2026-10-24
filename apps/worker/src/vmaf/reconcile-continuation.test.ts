import { type AppPrismaClient, projectSelected } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { qcContinuationJobId } from "./processor";
import { createStrandedVmafReconciler } from "./reconcile-stranded";

type Report = {
	id: string;
	encodingJobId: string | null;
	triggerKey: string | null;
	mode: string;
	status: string;
	gateVerdict?: { pass: boolean };
};
type Parent = { id: string; status: string };
type ReportWhere = {
	status: string | { in: string[] };
	mode?: string;
	triggerKey?: { startsWith: string };
	id?: { gt: string };
	encodingJob?: { is: { status: string } };
};
type ParentWhere = {
	id: string;
	status: string;
	vmafJobs?: {
		some: {
			id: string;
			mode: string;
			triggerKey: string;
			status: { in: string[] };
		};
	};
};

function report(id = "qc-0000", status = "FINISHED"): Report {
	return {
		id,
		encodingJobId: `encoding-${id}`,
		triggerKey: `vod-auto:encoding-${id}`,
		mode: "VOD",
		status,
		gateVerdict: { pass: true },
	};
}

function harness(rows = [report()]) {
	const parents: Parent[] = rows.flatMap((row) =>
		row.encodingJobId ? [{ id: row.encodingJobId, status: "AWAITING_QC" }] : [],
	);
	const jobs = new Map<string, ReturnType<typeof continuation>>();
	const scans: string[][] = [];
	const added: string[] = [];
	let beforeParentRead: (() => void) | undefined;

	function continuation(row: Report, state: string) {
		const job = {
			data: { encodingJobId: row.encodingJobId },
			state,
			getState: vi.fn(async (): Promise<string> => job.state),
			retry: vi.fn(async (from: string): Promise<void> => {
				if (job.state !== from) throw new Error("Job is no longer settled");
				job.state = "waiting";
			}),
		};
		return job;
	}
	const prisma = {
		vmafJob: {
			findMany: vi.fn(
				async ({
					where,
					take,
					select,
				}: {
					where: ReportWhere;
					take: number;
					select?: Record<string, boolean>;
				}) => {
					const found = rows
						.filter((row) => {
							const status = where.status;
							if (
								typeof status === "string"
									? row.status !== status
									: !status.in.includes(row.status)
							)
								return false;
							if (where.mode && row.mode !== where.mode) return false;
							if (
								where.triggerKey?.startsWith &&
								!row.triggerKey?.startsWith(where.triggerKey.startsWith)
							)
								return false;
							if (where.id?.gt && row.id <= where.id.gt) return false;
							const parentStatus = where.encodingJob?.is.status;
							return (
								parentStatus === undefined ||
								parents.some(
									(parent) =>
										parent.id === row.encodingJobId &&
										parent.status === parentStatus,
								)
							);
						})
						.sort((a, b) => a.id.localeCompare(b.id))
						.slice(0, take);
					scans.push(found.map((row) => row.id));
					return found.map((row) => projectSelected({ ...row }, select));
				},
			),
			updateMany: vi.fn(
				async ({
					where,
					data,
				}: {
					where: { id: string; status: string };
					data: { status: string };
				}) => {
					const row = rows.find(
						(row) => row.id === where.id && row.status === where.status,
					);
					if (!row) return { count: 0 };
					Object.assign(row, data);
					return { count: 1 };
				},
			),
		},
		encodingJob: {
			findFirst: vi.fn(async ({ where }: { where: ParentWhere }) => {
				beforeParentRead?.();
				const parent = parents.find(
					(parent) => parent.id === where.id && parent.status === where.status,
				);
				const owner = where.vmafJobs?.some;
				if (
					!parent ||
					(owner &&
						!rows.some(
							(row) =>
								row.encodingJobId === parent.id &&
								row.id === owner.id &&
								row.mode === owner.mode &&
								row.triggerKey === owner.triggerKey &&
								owner.status.in.includes(row.status),
						))
				)
					return null;
				return { id: parent.id };
			}),
		},
	};
	const orchestratorQueue = {
		getJob: vi.fn(async (id: string) => jobs.get(id)),
		add: vi.fn(
			async (
				_name: string,
				data: { encodingJobId: string },
				opts: { jobId: string },
			) => {
				if (!jobs.has(opts.jobId)) {
					const row = rows.find(
						(row) => row.encodingJobId === data.encodingJobId,
					);
					if (!row) throw new Error("Unknown encoding");
					jobs.set(opts.jobId, continuation(row, "waiting"));
					added.push(opts.jobId);
				}
			},
		),
	};
	const reconcile = createStrandedVmafReconciler({
		prisma: prisma as unknown as AppPrismaClient,
		queue: { name: "vmaf-runner", getJob: async () => undefined } as never,
		orchestratorQueue: orchestratorQueue as never,
	});
	return {
		rows,
		parents,
		jobs,
		scans,
		added,
		prisma,
		orchestratorQueue,
		reconcile,
		seed(state: string, row = rows[0] as Report) {
			const job = continuation(row, state);
			jobs.set(qcContinuationJobId(row.encodingJobId as string, row.id), job);
			return job;
		},
		beforeParentRead(run: () => void) {
			beforeParentRead = run;
		},
	};
}

describe("periodic recovery of a committed QC continuation", () => {
	it.each([
		["FINISHED", true],
		["FINISHED", false],
		["ERROR", undefined],
	] as const)("wakes a parked %s report without changing its verdict (%s)", async (status, pass) => {
		const row = {
			...report("qc-0000", status),
			gateVerdict: pass === undefined ? undefined : { pass },
		};
		const before = structuredClone(row);
		const t = harness([row]);
		expect(await t.reconcile()).toBe(0);
		expect(t.added).toEqual([
			qcContinuationJobId(row.encodingJobId as string, row.id),
		]);
		expect(row).toEqual(before);
		expect(t.parents[0]?.status).toBe("AWAITING_QC");
	});

	it("retries repeated enqueue failures on later ticks", async () => {
		const t = harness();
		t.orchestratorQueue.add.mockRejectedValueOnce(
			new Error("queue unavailable"),
		);
		t.orchestratorQueue.add.mockRejectedValueOnce(
			new Error("queue still unavailable"),
		);
		await t.reconcile();
		await t.reconcile();
		expect(t.added).toHaveLength(0);
		await t.reconcile();
		expect(t.added).toHaveLength(1);
		expect(t.rows[0]?.status).toBe("FINISHED");
	});

	it("recovers a wake lost while a stranded RUNNING report was retired", async () => {
		const t = harness([report("qc-0000", "RUNNING")]);
		t.orchestratorQueue.add.mockRejectedValueOnce(
			new Error("queue unavailable"),
		);
		expect(await t.reconcile()).toBe(1);
		expect(t.added).toHaveLength(0);
		expect(t.rows[0]?.status).toBe("ERROR");
		expect(await t.reconcile()).toBe(0);
		expect(t.added).toHaveLength(1);
	});

	it.each([
		"manual",
		"stale-owner",
		"deleted-parent",
		"resumed",
		"mark-only",
		"live",
	])("does not wake a %s report", async (kind) => {
		const t = harness();
		const row = t.rows[0] as Report;
		if (kind === "manual") row.triggerKey = `lab-manual:${row.id}`;
		if (kind === "stale-owner") row.triggerKey = "vod-auto:another-encoding";
		if (kind === "deleted-parent") t.parents.splice(0);
		if (kind === "resumed") (t.parents[0] as Parent).status = "RUNNING";
		if (kind === "mark-only") (t.parents[0] as Parent).status = "FINISHED";
		if (kind === "live") row.mode = "LIVE";
		await t.reconcile();
		expect(t.added).toHaveLength(0);
	});

	it.each([
		"replaced-measurement",
		"changed-parent-link",
		"resumed-parent",
		"deleted-parent",
	])("rechecks ownership before waking a %s discovered by the scan", async (kind) => {
		const t = harness();
		t.beforeParentRead(() => {
			if (kind === "replaced-measurement")
				(t.rows[0] as Report).triggerKey = null;
			if (kind === "changed-parent-link")
				(t.rows[0] as Report).encodingJobId = "another-encoding";
			if (kind === "resumed-parent")
				(t.parents[0] as Parent).status = "RUNNING";
			if (kind === "deleted-parent") t.parents.splice(0);
		});
		await t.reconcile();
		expect(t.added).toHaveLength(0);
	});

	it.each([
		"completed",
		"failed",
	])("does not retry a retained %s job after its measurement lost gate ownership", async (state) => {
		const t = harness();
		const job = t.seed(state);
		job.getState.mockImplementationOnce(async () => {
			(t.rows[0] as Report).triggerKey = null;
			return state;
		});
		await t.reconcile();
		expect(job.retry).not.toHaveBeenCalled();
		expect(job.state).toBe(state);
	});

	it.each([
		"waiting",
		"active",
		"delayed",
		"prioritized",
		"waiting-children",
		"unknown",
	])("preserves a continuation in %s instead of duplicating it", async (state) => {
		const t = harness();
		const job = t.seed(state);
		await t.reconcile();
		expect(t.added).toHaveLength(0);
		expect(job.retry).not.toHaveBeenCalled();
		expect(job.state).toBe(state);
	});

	it.each([
		"completed",
		"failed",
	])("revives a retained %s continuation under the same ID", async (state) => {
		const t = harness();
		const job = t.seed(state);
		await t.reconcile();
		await t.reconcile();
		expect(job.state).toBe("waiting");
		expect(job.retry).toHaveBeenCalledExactlyOnceWith(state);
		expect(t.jobs.size).toBe(1);
		expect(t.added).toHaveLength(0);
	});

	it("never retries a retained job carrying another encoding", async () => {
		const t = harness();
		const job = t.seed("failed");
		job.data.encodingJobId = "another-encoding";
		await t.reconcile();
		expect(job.retry).not.toHaveBeenCalled();
		expect(t.added).toHaveLength(0);
	});

	it("does not remove a continuation that became active during the state probe", async () => {
		const t = harness();
		const job = t.seed("completed");
		job.getState.mockImplementationOnce(async () => {
			job.state = "active";
			return "completed";
		});
		await t.reconcile();
		await t.reconcile();
		expect(job.state).toBe("active");
		expect(t.jobs.size).toBe(1);
		expect(t.added).toHaveLength(0);
	});

	it("re-adds a continuation on the next tick if its retained job disappeared before retry", async () => {
		const t = harness();
		const job = t.seed("failed");
		job.retry.mockImplementationOnce(async () => {
			t.jobs.clear();
			throw new Error("job no longer exists");
		});
		await t.reconcile();
		await t.reconcile();
		expect(t.added).toHaveLength(1);
		expect(t.jobs.size).toBe(1);
	});

	it("retries after an unavailable queue state probe", async () => {
		const t = harness();
		t.orchestratorQueue.getJob.mockRejectedValueOnce(
			new Error("queue unavailable"),
		);
		await t.reconcile();
		expect(t.added).toHaveLength(0);
		await t.reconcile();
		expect(t.added).toHaveLength(1);
	});

	it("reaches report 501 even while the first 500 remain parked and active", async () => {
		const t = harness(
			Array.from({ length: 501 }, (_, i) =>
				report(`qc-${String(i).padStart(4, "0")}`),
			),
		);
		for (const row of t.rows.slice(0, 500)) t.seed("active", row);
		await t.reconcile();
		expect(t.added).toHaveLength(0);
		await t.reconcile();
		expect(t.added).toEqual([
			qcContinuationJobId("encoding-qc-0500", "qc-0500"),
		]);
		expect(t.scans.every((scan) => scan.length <= 500)).toBe(true);
	});

	it("keeps recovery cursors local to each scoped reconciler", async () => {
		const rows = Array.from({ length: 501 }, (_, i) =>
			report(`qc-${String(i).padStart(4, "0")}`),
		);
		const first = harness(structuredClone(rows));
		const second = harness(structuredClone(rows));
		await first.reconcile();
		await second.reconcile();
		expect(second.added).toHaveLength(500);
		expect(second.added[0]).toBe(
			qcContinuationJobId("encoding-qc-0000", "qc-0000"),
		);
	});

	it("coalesces overlapping sweeps before they advance the cursor", async () => {
		const t = harness();
		const original = t.prisma.vmafJob.findMany.getMockImplementation();
		if (!original) throw new Error("Missing stateful report reader");
		let release!: () => void;
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		t.prisma.vmafJob.findMany.mockImplementationOnce(async (args) => {
			await wait;
			return original(args);
		});
		const first = t.reconcile();
		const second = t.reconcile();
		expect(second).toBe(first);
		release();
		await Promise.all([first, second]);
		expect(t.added).toHaveLength(1);
	});
});
