import { describe, expect, it, vi } from "vitest";
import {
	createVmafResourceLeases,
	VMAF_GPU_COMPUTE_CREDITS,
} from "./resource-leases";

const request = () => ({
	hostKey: "host-a",
	deviceKey: "gpu-a",
	capacity: {
		cpuMilliCores: 4000,
		hostBytes: 8192,
		gpuBytes: 8192,
		gpuComputeCredits: VMAF_GPU_COMPUTE_CREDITS,
	},
	requested: {
		cpuMilliCores: 1000,
		hostBytes: 1024,
		gpuBytes: 1024,
		gpuComputeCredits: VMAF_GPU_COMPUTE_CREDITS / 2,
	},
});

describe("resource lease boundary validation", () => {
	it("preserves exact compute-credit integers for every supported pool size", () => {
		expect(VMAF_GPU_COMPUTE_CREDITS).toBe(144403552893600);
		for (let count = 1; count <= 32; count++)
			expect(Number.isSafeInteger(VMAF_GPU_COMPUTE_CREDITS / count)).toBe(true);
	});
	it("rejects malformed or impossible reservations without contacting Redis", async () => {
		const evalRedis = vi.fn();
		const leases = createVmafResourceLeases({ redis: { eval: evalRedis } });
		const variants = [
			{ ...request(), hostKey: "bad{host}" },
			{ ...request(), deviceKey: "-" },
			{ ...request(), deviceKey: undefined },
			{ ...request(), requested: { ...request().requested, hostBytes: 0 } },
			{
				...request(),
				requested: { ...request().requested, cpuMilliCores: 4001 },
			},
			{ ...request(), requested: { ...request().requested, gpuBytes: NaN } },
			{
				...request(),
				requested: { ...request().requested, gpuComputeCredits: 0.5 },
			},
			{
				...request(),
				capacity: {
					...request().capacity,
					hostBytes: Number.MAX_SAFE_INTEGER + 1,
				},
			},
		];
		for (const value of variants)
			await expect(
				leases.run(value, new AbortController().signal, async () => 1),
			).rejects.toThrow();
		expect(evalRedis).not.toHaveBeenCalled();
	});
	it("rejects invalid configuration instead of weakening expiry or key isolation", () => {
		for (const patch of [
			{ leaseMs: 0 },
			{ renewMs: 30000 },
			{ pollMs: 0 },
			{ namespace: "bad{namespace}" },
			{ operationTimeoutMs: NaN },
		])
			expect(() =>
				createVmafResourceLeases({ redis: { eval: vi.fn() }, ...patch }),
			).toThrow();
	});
	it("does not enqueue an already-cancelled caller", async () => {
		const evalRedis = vi.fn(),
			work = vi.fn();
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const leases = createVmafResourceLeases({ redis: { eval: evalRedis } });
		await expect(
			leases.run(request(), controller.signal, work),
		).rejects.toThrow("cancelled");
		expect(evalRedis).not.toHaveBeenCalled();
		expect(work).not.toHaveBeenCalled();
	});
});
