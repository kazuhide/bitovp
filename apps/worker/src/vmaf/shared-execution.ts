import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ResourceUnavailableError } from "./resource-admission";
import {
	VMAF_GPU_COMPUTE_CREDITS,
	type VmafResourceLeaseContext,
	type VmafResourceLeaseRequest,
} from "./resource-leases";
import type { LocalResourcePlan } from "./resource-plan";
import { type LocalResources, readLocalResources } from "./resources";

export type SharedVmafDevice = {
	deviceKey: string;
	/** Re-reads physical headroom and verifies the selected executable/device. */
	read(
		signal: AbortSignal,
	): Promise<{ totalBytes: number | null; availableBytes: number | null }>;
};
type Leases = {
	run<T>(
		request: VmafResourceLeaseRequest,
		signal: AbortSignal,
		work: (context: VmafResourceLeaseContext) => Promise<T>,
	): Promise<T>;
};

/** The boot ID is common to native processes and containers on this host. */
export async function localVmafHostKey() {
	const boot = (
		await readFile("/proc/sys/kernel/random/boot_id", "utf8")
	).trim();
	if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(boot))
		throw new Error("VMAF_RESOURCE_HOST_ID_UNAVAILABLE");
	return createHash("sha256")
		.update(`bitovp-host-boot-v1:${boot}`)
		.digest("hex");
}

/** CPU/RAM/device accounting is shared through Redis. Headroom checks remain
 * conservative: not-yet-materialized reservations also consume the live budget. */
export function createSharedVmafExecution(deps: {
	leases: Leases;
	hostKey: () => Promise<string>;
	readResources?: () => LocalResources;
	sleep?: (signal: AbortSignal) => Promise<unknown>;
}) {
	const devices = new Map<string, SharedVmafDevice>();
	const read = deps.readResources ?? readLocalResources;
	const sleep = deps.sleep ?? ((signal) => delay(250, undefined, { signal }));
	return {
		registerDevice(device: SharedVmafDevice) {
			devices.set(device.deviceKey, device);
		},
		async run<T>(
			plan: LocalResourcePlan,
			signal: AbortSignal,
			work: (
				signal: AbortSignal,
				assertOwned: () => Promise<void>,
			) => Promise<T>,
		): Promise<T> {
			if (
				!Number.isSafeInteger(plan.estimatedBytes) ||
				plan.estimatedBytes <= 0
			)
				throw new ResourceUnavailableError("estimate");
			const hostKey = await deps.hostKey();
			if (!/^[a-f0-9]{64}$/.test(hostKey))
				throw new Error("VMAF_RESOURCE_HOST_ID_UNAVAILABLE");
			const initial = read();
			const hostBudget =
				initial.memoryLimitBytes === undefined
					? initial.budgetBytes
					: Math.floor(initial.memoryLimitBytes - initial.reserveBytes);
			if (
				!hostBudget ||
				!Number.isSafeInteger(hostBudget) ||
				hostBudget < plan.estimatedBytes ||
				plan.manualFallback
			)
				throw new ResourceUnavailableError("estimate");
			const cpu = Math.floor(initial.cpuCapacity * 1000);
			if (!Number.isSafeInteger(cpu) || cpu <= 0)
				throw new ResourceUnavailableError("unknown");
			const device = plan.gpu ? devices.get(plan.gpu.deviceKey) : undefined;
			if (plan.gpu && !device)
				throw new Error("VMAF_RESOURCE_DEVICE_UNAVAILABLE");
			const sample = async (activeSignal = signal) => {
				activeSignal.throwIfAborted();
				const host = read();
				const gpu = device ? await device.read(activeSignal) : undefined;
				const total = gpu?.totalBytes;
				if (
					gpu &&
					([gpu.totalBytes, gpu.availableBytes].some(
						(n) =>
							n !== null && (!Number.isSafeInteger(n) || (n as number) < 0),
					) ||
						(gpu.totalBytes !== null &&
							(gpu.totalBytes <= 0 ||
								(gpu.availableBytes !== null &&
									gpu.availableBytes > gpu.totalBytes))))
				)
					throw new Error("VMAF_RESOURCE_DEVICE_MEMORY_INVALID");
				const reserve = total
					? Math.max(512 * 1024 ** 2, Math.ceil(total * 0.1))
					: 0;
				const gpuBudget = total
					? Math.max(0, total - reserve)
					: plan.gpu?.bytes;
				const gpuAvailable =
					gpu?.availableBytes === null || gpu?.availableBytes === undefined
						? undefined
						: Math.max(0, gpu.availableBytes - reserve);
				return { hostAvailable: host.budgetBytes, gpuAvailable, gpuBudget };
			};
			const fits = (available: Awaited<ReturnType<typeof sample>>) =>
				available.hostAvailable !== undefined &&
				available.hostAvailable >= plan.estimatedBytes &&
				(!plan.gpu ||
					available.gpuAvailable === undefined ||
					available.gpuAvailable >= plan.gpu.bytes);
			for (;;) {
				const available = await sample();
				if (
					plan.gpu &&
					(!available.gpuBudget || available.gpuBudget < plan.gpu.bytes)
				)
					throw new ResourceUnavailableError("estimate");
				if (!fits(available)) {
					await sleep(signal);
					continue;
				}
				const exclusive = plan.exclusive;
				const capacity = {
					cpuMilliCores: cpu,
					hostBytes: exclusive
						? hostBudget
						: Math.min(hostBudget, available.hostAvailable as number),
					...(plan.gpu
						? {
								gpuBytes: exclusive
									? available.gpuBudget
									: Math.min(
											available.gpuBudget as number,
											available.gpuAvailable ?? (available.gpuBudget as number),
										),
								gpuComputeCredits: VMAF_GPU_COMPUTE_CREDITS,
							}
						: {}),
				};
				const requested = {
					cpuMilliCores: exclusive
						? cpu
						: Math.min(
								cpu,
								Math.ceil(
									(plan.cpuChargePerComparison ??
										plan.threads + 2 * (plan.decoderThreads ?? 1) + 1) * 1000,
								),
							),
					hostBytes: exclusive ? hostBudget : plan.estimatedBytes,
					...(plan.gpu
						? {
								gpuBytes: exclusive ? available.gpuBudget : plan.gpu.bytes,
								gpuComputeCredits: exclusive
									? VMAF_GPU_COMPUTE_CREDITS
									: plan.gpu.computeCredits,
							}
						: {}),
				};
				const retry = Symbol("headroom changed while queued");
				const result = await deps.leases.run(
					{
						hostKey,
						...(device ? { deviceKey: device.deviceKey } : {}),
						capacity,
						requested,
					},
					signal,
					async (context) => {
						const headroom = await sample(context.signal);
						if (!fits(headroom)) return retry;
						if (
							!exclusive &&
							!(await context.fitsHeadroom({
								hostBytes: headroom.hostAvailable as number,
								...(headroom.gpuAvailable === undefined
									? {}
									: { gpuBytes: headroom.gpuAvailable }),
							}))
						)
							return retry;
						context.signal.throwIfAborted();
						await context.assertOwned();
						const value = await work(context.signal, context.assertOwned);
						await context.assertOwned();
						return value;
					},
				);
				if (result !== retry) return result as T;
				await sleep(signal);
			}
		},
	};
}
