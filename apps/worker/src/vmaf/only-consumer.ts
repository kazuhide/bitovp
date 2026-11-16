import { QUEUE_NAMES, vmafJobSchema } from "@bitovp/core";
import { type Job, Worker, type WorkerOptions } from "bullmq";
import {
	DEFAULT_LONG_JOB_MAX_STALLED_COUNT,
	stallOptionsFor,
} from "../stall-policy";
import { createTenantConsumer } from "../tenant/consumer";
import { createLocalExecutionGate } from "./execution-dispatch";
import { queueExcessVmafJobs } from "./job-capacity";

type Dependencies = Parameters<typeof createTenantConsumer>[0] & {
	redisUrl: string;
	processVod(data: unknown): Promise<unknown>;
	processLive(data: unknown): Promise<unknown>;
	automaticRuntime: boolean;
	localCapacity(): number;
	cloudCapacity: number;
	concurrency: number;
	maxStalledCount?: number;
	createWorker?(
		name: string,
		run: (job: Job) => Promise<unknown>,
		options: WorkerOptions,
	): Worker;
};
export function createVmafOnlyConsumer(deps: Dependencies): Worker {
	const consume = createTenantConsumer(deps);
	const local = deps.automaticRuntime
		? <T>(run: () => Promise<T>) => run()
		: createLocalExecutionGate();
	const dispatch = async (job: Job) => {
		const { vmafJobId } = vmafJobSchema.parse(job.data);
		const row = await deps.prisma.vmafJob.findUnique({
			where: { id: vmafJobId },
			select: { mode: true, params: true },
		});
		const params = row?.params as { execution?: { backend?: string } } | null;
		if (row?.mode === "LIVE") await local(() => deps.processLive(job.data));
		else if (params?.execution?.backend === "CLOUD")
			await deps.processVod(job.data);
		else await local(() => deps.processVod(job.data));
		return { acknowledged: true, queue: "vmafRunner" };
	};
	const admitted = queueExcessVmafJobs({
		localCapacity: deps.localCapacity,
		cloudCapacity: deps.cloudCapacity,
		classify: async (job) => {
			const { vmafJobId } = vmafJobSchema.parse(job.data);
			const row = await deps.prisma.vmafJob.findUnique({
				where: { id: vmafJobId },
				select: { mode: true, params: true, status: true },
			});
			if (!row || !["PENDING", "RUNNING"].includes(row.status))
				return "control";
			const params = row.params as { execution?: { backend?: string } } | null;
			return row.mode !== "LIVE" && params?.execution?.backend === "CLOUD"
				? "cloud"
				: "local";
		},
		process: dispatch,
	});
	const makeWorker =
		deps.createWorker ??
		((name, run, options) => new Worker(name, run, options));
	const worker = makeWorker(
		QUEUE_NAMES.vmafRunner,
		consume("vmafRunner", admitted),
		{
			connection: { url: deps.redisUrl },
			concurrency: deps.concurrency,
			...stallOptionsFor(
				"vmafRunner",
				deps.maxStalledCount ?? DEFAULT_LONG_JOB_MAX_STALLED_COUNT,
			),
		},
	);
	worker.on("ready", () =>
		console.log(
			`[worker:vmafRunner] role=vmaf-only listening on "${QUEUE_NAMES.vmafRunner}" (concurrency ${deps.concurrency})`,
		),
	);
	worker.on("failed", (job, error) =>
		console.error(`[worker:vmafRunner] job ${job?.id} failed:`, error.message),
	);
	worker.on("error", (error) =>
		console.error("[worker:vmafRunner] error:", error),
	);
	return worker;
}
