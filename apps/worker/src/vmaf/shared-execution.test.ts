import { expect, it, vi } from "vitest";
import {
	VMAF_GPU_COMPUTE_CREDITS,
	type VmafResourceLeaseRequest,
} from "./resource-leases";
import type { LocalResourcePlan } from "./resource-plan";
import { createSharedVmafExecution } from "./shared-execution";

const MiB = 1024 ** 2;
function harness() {
	const resources = {
		cpuCapacity: 8,
		memoryLimitBytes: 16_000 * MiB,
		reserveBytes: 1_000 * MiB,
		budgetBytes: 8_000 * MiB,
	};
	const requests: VmafResourceLeaseRequest[] = [];
	const authority = vi.fn(async () => {}),
		controller = new AbortController();
	const leases = {
		async run<T>(
			request: VmafResourceLeaseRequest,
			_signal: AbortSignal,
			work: (context: {
				signal: AbortSignal;
				assertOwned: () => Promise<void>;
				fitsHeadroom: () => Promise<boolean>;
			}) => Promise<T>,
		) {
			requests.push(request);
			return work({
				signal: controller.signal,
				assertOwned: authority,
				fitsHeadroom: async () => true,
			});
		},
	};
	const sleep = vi.fn(async (signal: AbortSignal) => {
		signal.throwIfAborted();
	});
	const execution = createSharedVmafExecution({
		leases,
		hostKey: async () => "a".repeat(64),
		readResources: () => ({ ...resources }),
		sleep,
	});
	const plan: LocalResourcePlan = {
		threads: 1,
		decoderThreads: 1,
		concurrency: 2,
		estimatedBytes: 500 * MiB,
		exclusive: false,
		manualFallback: false,
	};
	return { resources, requests, authority, controller, execution, plan, sleep };
}
it("charges both decoders and parity, rechecks ownership, and preserves the lease signal", async () => {
	const h = harness(),
		caller = new AbortController();
	await expect(
		h.execution.run(h.plan, caller.signal, async (signal, assertOwned) => {
			expect(signal).toBe(h.controller.signal);
			await assertOwned();
			return 42;
		}),
	).resolves.toBe(42);
	expect(h.requests[0]).toMatchObject({
		capacity: { cpuMilliCores: 8000, hostBytes: 8000 * MiB },
		requested: { cpuMilliCores: 4000, hostBytes: 500 * MiB },
	});
	expect(h.authority).toHaveBeenCalledTimes(3);
});
it("can reserve exclusive ownership while checking actual working memory rather than the whole host as free", async () => {
	const h = harness();
	h.resources.budgetBytes = 1000 * MiB;
	await expect(
		h.execution.run(
			{ ...h.plan, exclusive: true },
			h.controller.signal,
			async () => "complete",
		),
	).resolves.toBe("complete");
	expect(h.requests[0]).toMatchObject({
		capacity: { cpuMilliCores: 8000, hostBytes: 15_000 * MiB },
		requested: { cpuMilliCores: 8000, hostBytes: 15_000 * MiB },
	});
});
it("returns a changed-headroom lease before waiting and trying again", async () => {
	const h = harness();
	const work = vi.fn(async () => "complete");
	let reads = 0,
		released = 0;
	const execution = createSharedVmafExecution({
		hostKey: async () => "a".repeat(64),
		readResources: () => {
			reads++;
			return {
				...h.resources,
				budgetBytes: reads === 3 ? 0 : h.resources.budgetBytes,
			};
		},
		sleep: async () => {
			expect(released).toBe(1);
		},
		leases: {
			async run(_request, signal, callback) {
				try {
					return await callback({
						signal,
						assertOwned: h.authority,
						fitsHeadroom: async () => true,
					});
				} finally {
					released++;
				}
			},
		},
	});
	await expect(execution.run(h.plan, h.controller.signal, work)).resolves.toBe(
		"complete",
	);
	expect(released).toBe(2);
	expect(work).toHaveBeenCalledTimes(1);
});
it("uses separate GPU bytes and compute shares and checks device headroom freshly", async () => {
	const h = harness();
	const read = vi.fn(async () => ({
		totalBytes: 8000 * MiB,
		availableBytes: 6000 * MiB,
	}));
	h.execution.registerDevice({ deviceKey: "b".repeat(64), read });
	await h.execution.run(
		{
			...h.plan,
			gpu: {
				deviceKey: "b".repeat(64),
				bytes: 1000 * MiB,
				computeCredits: VMAF_GPU_COMPUTE_CREDITS / 2,
			},
		},
		h.controller.signal,
		async () => 1,
	);
	expect(h.requests[0]).toMatchObject({
		deviceKey: "b".repeat(64),
		capacity: {
			gpuBytes: 5200 * MiB,
			gpuComputeCredits: VMAF_GPU_COMPUTE_CREDITS,
		},
		requested: {
			gpuBytes: 1000 * MiB,
			gpuComputeCredits: VMAF_GPU_COMPUTE_CREDITS / 2,
		},
	});
	expect(read).toHaveBeenCalledTimes(2);
});
it("queued work aborts without starting when physical headroom is exhausted", async () => {
	const h = harness();
	h.resources.budgetBytes = 0;
	const work = vi.fn(async () => 1);
	h.sleep.mockImplementation(async (signal) => {
		h.controller.abort(new Error("cancelled waiting work"));
		signal.throwIfAborted();
	});
	await expect(
		h.execution.run(h.plan, h.controller.signal, work),
	).rejects.toThrow("cancelled waiting work");
	expect(h.requests).toHaveLength(0);
	expect(work).not.toHaveBeenCalled();
});
