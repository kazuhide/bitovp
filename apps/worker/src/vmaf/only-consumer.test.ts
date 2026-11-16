import type { AppPrismaClient } from "@bitovp/db";
import { DelayedError, type Job, type Worker } from "bullmq";
import { expect, it, vi } from "vitest";
import { currentOrganizationId } from "../tenant/scope";
import { createVmafOnlyConsumer } from "./only-consumer";

const ORG = "ef984a2c-1d65-4f48-8eae-0f4be5c80432";
const ID = "7fb72f93-a388-46b1-a5b0-e50b1b27e751";
function setup() {
	const events: string[] = [];
	const row = { id: ID, mode: "VOD", params: {}, status: "PENDING" };
	const findFirst = vi.fn(async () => {
		events.push("owned");
		return { id: ID };
	});
	const findUnique = vi.fn(async () => {
		events.push("read");
		return row;
	});
	const prisma = {
		vmafJob: { findFirst, findUnique },
	} as unknown as AppPrismaClient;
	let consume!: (job: Job) => Promise<unknown>;
	const worker = {
		on: vi.fn(),
		close: vi.fn(async () => {}),
	} as unknown as Worker;
	const createWorker = vi.fn((_name, run) => {
		consume = run;
		return worker;
	});
	const vod = vi.fn(async () => {
		events.push(`vod:${currentOrganizationId()}`);
	});
	const live = vi.fn(async () => {
		events.push(`live:${currentOrganizationId()}`);
	});
	const active = vi.fn(async () => true);
	const forEachOrganization = vi.fn();
	const deps = {
		prisma,
		redisUrl: "redis://not-contacted",
		forEachOrganization,
		isOrganizationActive: active,
		processVod: vod,
		processLive: live,
		automaticRuntime: true,
		localCapacity: () => 2,
		cloudCapacity: 2,
		concurrency: 4,
		createWorker,
	};
	const job = {
		id: "same-job",
		token: "same-token",
		name: "vmaf",
		data: { organizationId: ORG, payload: { vmafJobId: ID } },
		moveToDelayed: vi.fn(async () => {}),
	} as unknown as Job;
	return {
		deps,
		job,
		row,
		worker,
		createWorker,
		findFirst,
		events,
		vod,
		live,
		active,
		forEachOrganization,
		run: (job: Job) => consume(job),
	};
}

it("creates only the normal VMAF consumer and authorizes before dispatch", async () => {
	const h = setup();
	expect(createVmafOnlyConsumer(h.deps)).toBe(h.worker);
	expect(h.createWorker).toHaveBeenCalledOnce();
	expect(h.createWorker.mock.calls[0]?.[0]).toBe("vmaf-runner");
	await expect(h.run(h.job)).resolves.toEqual({
		acknowledged: true,
		queue: "vmafRunner",
	});
	expect(h.events).toEqual(["owned", "read", "read", `vod:${ORG}`]);
	expect(h.vod).toHaveBeenCalledWith({ vmafJobId: ID });
	expect(h.live).not.toHaveBeenCalled();
	expect(h.forEachOrganization).not.toHaveBeenCalled();
});
it("rejects foreign rows and missing envelopes before processor or secret resolution", async () => {
	const h = setup();
	createVmafOnlyConsumer(h.deps);
	h.findFirst.mockResolvedValueOnce(null as never);
	await expect(h.run(h.job)).rejects.toThrow("Tenant resource unavailable");
	await expect(
		h.run({ ...h.job, data: { vmafJobId: ID } } as Job),
	).rejects.toThrow("Organization queue envelope is required");
	expect(h.vod).not.toHaveBeenCalled();
	expect(h.live).not.toHaveBeenCalled();
});
it("retains the normal LIVE processor dispatch", async () => {
	const h = setup();
	h.row.mode = "LIVE";
	createVmafOnlyConsumer(h.deps);
	await h.run(h.job);
	expect(h.live).toHaveBeenCalledWith({ vmafJobId: ID });
	expect(h.vod).not.toHaveBeenCalled();
});
it("delays excess owned parents through BullMQ without changing business status", async () => {
	const h = setup();
	h.deps.localCapacity = () => 1;
	let release!: () => void;
	h.vod.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	createVmafOnlyConsumer(h.deps);
	const first = h.run(h.job);
	await vi.waitFor(() => expect(h.vod).toHaveBeenCalledOnce());
	try {
		await expect(h.run(h.job)).rejects.toBeInstanceOf(DelayedError);
		expect(h.job.moveToDelayed).toHaveBeenCalledWith(
			expect.any(Number),
			"same-token",
		);
	} finally {
		release();
	}
	await first;
});
