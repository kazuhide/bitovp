import { QUEUE_NAMES } from "@bitovp/core";
import { DelayedError, type Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { createHandlers, HEARTBEAT_SWEEP_JOB } from "./handlers";
import { ATTEMPT_LEASE_MS } from "./orchestrator/processor";

function deps() {
	return {
		usageStatistics: vi.fn().mockResolvedValue({}),
		orchestrate: vi.fn().mockResolvedValue({ status: "FINISHED" }),
		liveChannel: vi.fn().mockResolvedValue({
			acknowledged: true,
			liveChannelId: "00000000-0000-4000-8000-0000000000bb",
			action: "stop",
			status: "STOPPED",
		} as const),
		liveHeartbeatSweep: vi.fn().mockResolvedValue({ polled: 0, failed: 0 }),
		feeder: vi.fn().mockResolvedValue({ status: "PUSHING" }),
		vmaf: vi.fn().mockResolvedValue({ status: "FINISHED" }),
		storageInspect: vi.fn().mockResolvedValue({ status: "FINISHED" }),
		notify: vi.fn().mockResolvedValue([]),
		startupProbe: vi.fn().mockResolvedValue({ status: "DONE" }),
		slateNormalize: vi.fn().mockResolvedValue({ status: "READY" }),
	};
}

describe("createHandlers", () => {
	it("registers a handler for every queue", () => {
		const handlers = createHandlers(deps());
		expect(Object.keys(handlers).sort()).toEqual(
			Object.keys(QUEUE_NAMES).sort(),
		);
	});

	it("routes orchestrator jobs to the processor with job data", async () => {
		const d = deps();
		const handlers = createHandlers(d);
		const job = {
			id: "1",
			name: "orchestrate",
			data: { encodingJobId: "x" },
		} as Job;
		await expect(handlers.orchestrator(job)).resolves.toEqual({
			acknowledged: true,
			queue: "orchestrator",
		});
		expect(d.orchestrate).toHaveBeenCalledWith({ encodingJobId: "x" });
	});

	it("keeps a lease-held delivery pending past the attempt lease instead of acknowledging it", async () => {
		const d = deps();
		d.orchestrate.mockResolvedValue({ status: "LEASE_HELD" });
		const moveToDelayed = vi.fn(async (_at: number, _token?: string) => {});
		const job = {
			data: { encodingJobId: "x" },
			token: "delivery-lock",
			moveToDelayed,
		} as unknown as Job;
		const before = Date.now();
		await expect(createHandlers(d).orchestrator(job)).rejects.toBeInstanceOf(
			DelayedError,
		);
		expect(moveToDelayed).toHaveBeenCalledWith(
			expect.any(Number),
			"delivery-lock",
		);
		expect(moveToDelayed.mock.calls[0]?.[0]).toBeGreaterThan(
			before + ATTEMPT_LEASE_MS,
		);
	});

	it.each([
		"FINISHED",
		"CANCELED",
		"QC_FAILED",
		"ERROR",
		"MISSING",
		"AWAITING_QC",
		"LEASE_LOST",
	])("acknowledges %s without delaying it", async (status) => {
		const d = deps();
		d.orchestrate.mockResolvedValue({ status });
		const moveToDelayed = vi.fn();
		const job = {
			data: { encodingJobId: "x" },
			moveToDelayed,
		} as unknown as Job;
		await expect(createHandlers(d).orchestrator(job)).resolves.toEqual({
			acknowledged: true,
			queue: "orchestrator",
		});
		expect(moveToDelayed).not.toHaveBeenCalled();
	});

	it("preserves the exact live processor result as BullMQ's returnvalue", async () => {
		const d = deps();
		const handlers = createHandlers(d);
		const job = {
			id: "1",
			name: "live-channel",
			data: { liveChannelId: "x", action: "stop" },
		} as Job;
		await expect(handlers.liveChannel(job)).resolves.toEqual({
			acknowledged: true,
			liveChannelId: "00000000-0000-4000-8000-0000000000bb",
			action: "stop",
			status: "STOPPED",
		});
		expect(d.liveChannel).toHaveBeenCalledWith({
			liveChannelId: "x",
			action: "stop",
		});
		expect(d.liveHeartbeatSweep).not.toHaveBeenCalled();
	});

	it("routes the repeatable sweep job to the heartbeat sweep, not the dispatcher", async () => {
		const d = deps();
		const handlers = createHandlers(d);
		const job = { id: "2", name: HEARTBEAT_SWEEP_JOB, data: {} } as Job;
		await expect(handlers.liveChannel(job)).resolves.toEqual({
			acknowledged: true,
			queue: "liveChannel",
		});
		expect(d.liveHeartbeatSweep).toHaveBeenCalledTimes(1);
		expect(d.liveChannel).not.toHaveBeenCalled();
	});

	it("routes feeder jobs to the session dispatcher with job data", async () => {
		const d = deps();
		const handlers = createHandlers(d);
		const job = {
			id: "3",
			name: "feeder",
			data: { feederSessionId: "f", action: "start" },
		} as Job;
		await expect(handlers.feederManager(job)).resolves.toEqual({
			acknowledged: true,
			queue: "feederManager",
		});
		expect(d.feeder).toHaveBeenCalledWith({
			feederSessionId: "f",
			action: "start",
		});
	});

	it("routes vmaf-runner jobs to the processor with job data", async () => {
		const d = deps();
		const handlers = createHandlers(d);
		const job = {
			id: "4",
			name: "vmaf",
			data: { vmafJobId: "v" },
		} as Job;
		await expect(handlers.vmafRunner(job)).resolves.toEqual({
			acknowledged: true,
			queue: "vmafRunner",
		});
		expect(d.vmaf).toHaveBeenCalledWith({ vmafJobId: "v" });
	});
});
