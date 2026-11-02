import { describe, expect, it, vi } from "vitest";
import { createLocalVmafResources } from "./local-resources";
import { createResourceAdmission } from "./resource-admission";
import {
	VMAF_GPU_COMPUTE_CREDITS,
	type VmafResourceLeaseRequest,
} from "./resource-leases";
import type { LocalResourcePlan, ResourcePair } from "./resource-plan";
import { createSharedVmafExecution } from "./shared-execution";

const GiB = 1024 ** 3;
const pair: ResourcePair = {
	reference: {
		width: 1920,
		height: 1080,
		fps: 24,
		bitDepth: 8,
		chromaFactor: 1,
		codec: "h264",
		durationSeconds: 10,
	},
	distorted: {
		width: 1920,
		height: 1080,
		fps: 24,
		bitDepth: 8,
		chromaFactor: 1,
		codec: "h264",
		durationSeconds: 10,
	},
	model: "vmaf_v0.6.1",
};

it("reserves the whole shared host for Live preparation and borrows CPU authority without nested admission", async () => {
	const requests: VmafResourceLeaseRequest[] = [];
	const cpu = createResourceAdmission({
		capacityBytes: 8000,
		availableBytes: () => 8000,
	});
	const memory = createResourceAdmission({
		capacityBytes: 8 * GiB,
		availableBytes: () => 8 * GiB,
	});
	const readResources = () => ({
		cpuCapacity: 8,
		memoryLimitBytes: 8 * GiB,
		budgetBytes: 8 * GiB,
		reserveBytes: 0,
	});
	const shared = createSharedVmafExecution({
		hostKey: async () => "a".repeat(64),
		readResources,
		leases: {
			async run(request, signal, work) {
				requests.push(request);
				return cpu.run(request.requested.cpuMilliCores, signal, () =>
					memory.run(request.requested.hostBytes, signal, () =>
						work({
							signal,
							assertOwned: async () => signal.throwIfAborted(),
							fitsHeadroom: async () => true,
						}),
					),
				);
			},
		},
	});
	shared.registerDevice({
		deviceKey: "b".repeat(64),
		read: async () => ({ totalBytes: 8 * GiB, availableBytes: 8 * GiB }),
	});
	const resources = createLocalVmafResources({
		readResources,
		execute: (plan, signal, work) => shared.run(plan, signal, work),
	});
	const other = resources.begin(new AbortController().signal),
		live = resources.begin(new AbortController().signal);
	const entered = deferred(),
		hold = deferred(),
		prepEntered = deferred(),
		prepHold = deferred();
	const gpu = other.run(
		"gpu",
		{ ...pair, scoringBackend: "cuda" },
		1,
		async () => {
			entered.resolve();
			await hold.promise;
		},
		async () => ({
			threads: 1,
			decoderThreads: 1,
			cpuChargePerComparison: 4,
			concurrency: 2,
			estimatedBytes: 512 * 1024 ** 2,
			exclusive: false,
			manualFallback: false,
			gpu: {
				deviceKey: "b".repeat(64),
				bytes: GiB,
				computeCredits: VMAF_GPU_COMPUTE_CREDITS / 2,
			},
		}),
	);
	await entered.promise;
	if (!live.exclusivePrepared) throw new Error("Missing exclusive preparation");
	const resolver = vi.fn(async () => {
		throw new Error("Nested resolver must not run");
	});
	const prep = live.exclusivePrepared(
		"live",
		async (scoped, runSignal, assertOwned) => {
			prepEntered.resolve();
			expect(scoped.preparationScope).toBe("exclusive-cpu");
			await assertOwned();
			await scoped.run("live-cpu", pair, 1, async (plan) => {
				expect(plan.concurrency).toBe(1);
			});
			await expect(
				scoped.run(
					"gpu",
					{ ...pair, scoringBackend: "cuda" },
					1,
					async () => {},
				),
			).rejects.toThrow("CPU-only");
			await expect(
				scoped.run("resolver", pair, 1, async () => {}, resolver),
			).rejects.toThrow("resolver");
			expect(resolver).not.toHaveBeenCalled();
			runSignal.throwIfAborted();
			await prepHold.promise;
		},
	);
	await vi.waitFor(() => expect(requests).toHaveLength(2));
	expect(requests[1]?.requested).toMatchObject({
		cpuMilliCores: 8000,
		hostBytes: 8 * GiB,
	});
	expect(live.report().active).toBe(1); // Only the GPU comparison has entered.
	hold.resolve();
	await gpu;
	await prepEntered.promise;
	expect(requests).toHaveLength(2);
	expect(live.report().maxObservedActive).toBe(1);
	const next = other.run(
		"after-live",
		pair,
		1,
		async () => {},
		async () => ({
			threads: 1,
			concurrency: 1,
			estimatedBytes: GiB,
			exclusive: false,
			manualFallback: false,
		}),
	);
	await vi.waitFor(() => expect(requests).toHaveLength(3));
	expect(live.report().active).toBe(1);
	prepHold.resolve();
	await Promise.all([prep, next]);
	expect(live.report()).toMatchObject({ active: 0, queued: 0 });
});

it("checks scoring headroom inside an exclusive Live scope and inherits lease loss", async () => {
	let available = 4 * GiB;
	const lease = new AbortController();
	const authority = vi.fn(async () => lease.signal.throwIfAborted());
	let executionCalls = 0;
	const execute = async <T>(
		_plan: LocalResourcePlan,
		_signal: AbortSignal,
		work: (signal: AbortSignal, assert: () => Promise<void>) => Promise<T>,
	) => {
		executionCalls++;
		return work(lease.signal, authority);
	};
	const resources = createLocalVmafResources({
		readResources: () => ({
			cpuCapacity: 4,
			memoryLimitBytes: 4 * GiB,
			budgetBytes: available,
			reserveBytes: 0,
		}),
		execute,
	});
	const session = resources.begin(new AbortController().signal);
	if (!session.exclusivePrepared)
		throw new Error("Missing exclusive preparation");
	await session
		.exclusivePrepared("live", async (scoped) => {
			available = 1;
			await expect(
				scoped.run("too-large", pair, 1, async () => {}),
			).rejects.toThrow("waiting for memory");
			available = 4 * GiB;
			lease.abort(new Error("Lease lost"));
			await expect(
				scoped.run("revoked", pair, 1, async () => {}),
			).rejects.toThrow("Lease lost");
		})
		.catch((error) => expect(String(error)).toContain("Lease lost"));
	expect(executionCalls).toBe(1);
	expect(session.report()).toMatchObject({ active: 0, queued: 0 });
});

describe("shared local VMAF resource service", () => {
	it("connects the selected plan to atomic launch and records actual units", async () => {
		const service = createLocalVmafResources({
			concurrency: 2,
			readResources: () => ({
				cpuCapacity: 4,
				budgetBytes: 1.5 * GiB,
				reserveBytes: 0.5 * GiB,
			}),
		});
		const session = service.begin(new AbortController().signal);
		let finish!: () => void;
		const held = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const calls: string[] = [];
		const first = session.run("first", pair, 2, async (plan) => {
			expect(plan.threads).toBe(2);
			calls.push("first");
			await held;
		});
		const second = session.run("second", pair, 2, async () =>
			calls.push("second"),
		);
		await Promise.resolve();
		expect(calls).toEqual(["first", "second"]);
		finish();
		await Promise.all([first, second]);
		expect(session.report().units).toHaveLength(2);
		expect(session.report().configured.concurrency).toBe(2);
	});

	it("retains explicit threads but serializes a concurrency ceiling when memory is tighter", async () => {
		const service = createLocalVmafResources({
			threads: 4,
			concurrency: 2,
			readResources: () => ({
				cpuCapacity: 4,
				budgetBytes: 1.5 * GiB,
				reserveBytes: 0.5 * GiB,
			}),
		});
		const session = service.begin(new AbortController().signal);
		let finish!: () => void;
		const held = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const first = session.run("first", pair, 2, async (plan) => {
			expect(plan.threads).toBe(4);
			await held;
		});
		const next = vi.fn();
		const second = session.run("second", pair, 2, async () => next());
		await Promise.resolve();
		expect(next).not.toHaveBeenCalled();
		finish();
		await Promise.all([first, second]);
		expect(next).toHaveBeenCalledOnce();
	});

	it("admits an exclusive conservative estimate below reduced headroom and reports its distinct reservation", async () => {
		let budget = 3 * GiB;
		const service = createLocalVmafResources({
			concurrency: 2,
			readResources: () => ({
				cpuCapacity: 4,
				budgetBytes: budget,
				reserveBytes: 0.5 * GiB,
			}),
		});
		const session = service.begin(new AbortController().signal);
		budget = 2.5 * GiB;
		const unmeasured = { ...pair, model: "vmaf_v0.6.1neg" };
		await session.run("unmeasured", unmeasured, 2, async (plan) =>
			expect(plan.exclusive).toBe(true),
		);
		const unit = session.report().units[0];
		expect(unit?.estimatedBytes).toBeLessThan(budget);
		expect(unit?.reservationBytes).toBe(3 * GiB);
	});

	it("diagnoses the explicit manual fallback once without claiming memory protection", async () => {
		const diagnostic = vi.fn();
		const service = createLocalVmafResources({
			threads: 3,
			concurrency: 2,
			onDiagnostic: diagnostic,
			readResources: () => ({ cpuCapacity: 1, reserveBytes: 0.5 * GiB }),
		});
		for (let n = 0; n < 2; n++) {
			const session = service.begin(new AbortController().signal);
			await session.run("manual", pair, 2, async (plan) => {
				expect(plan.threads).toBe(3);
				expect(plan.decoderThreads).toBeUndefined();
			});
			expect(session.report().units[0]?.manualFallback).toBe(true);
		}
		expect(diagnostic).toHaveBeenCalledOnce();
		expect(diagnostic.mock.calls[0]?.[0]).toContain("unavailable");
	});
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function resolvedPlan(concurrency = 2): LocalResourcePlan {
	return {
		threads: 1,
		concurrency,
		estimatedBytes: 0.5 * GiB,
		exclusive: false,
		manualFallback: false,
		nativeInflightFrames: 2,
		cpuChargePerComparison: 1,
		basis: "runtime-calibration",
		profileKey: "profile-a",
		reasons: ["Measured end-to-end with CPU verification"],
		gpu: { deviceKey: "opaque-gpu-a", bytes: 1024, computeCredits: 4 },
	};
}
const ampleResources = () => ({
	cpuCapacity: 8,
	budgetBytes: 8 * GiB,
	reserveBytes: 0.5 * GiB,
});

describe("global local VMAF preparation and execution", () => {
	it("starts cold at one preparation, then runs eight units from two sessions through a shared capacity of two", async () => {
		const service = createLocalVmafResources({ readResources: ampleResources });
		const a = service.begin(new AbortController().signal),
			b = service.begin(new AbortController().signal);
		expect(service.jobCapacity()).toBe(1);
		expect(a.descriptorConcurrency(8)).toBe(8);
		const allowPlan = deferred(),
			release = deferred(),
			two = deferred();
		let active = 0,
			maximum = 0,
			preparations = 0;
		const work = Array.from({ length: 8 }, (_, index) => {
			const session = index % 2 ? b : a;
			return session.prepared(String(index), async () => {
				preparations++;
				if (index === 0) await allowPlan.promise;
				return session.run(
					String(index),
					pair,
					8,
					async () => {
						active++;
						maximum = Math.max(maximum, active);
						if (active === 2) two.resolve();
						try {
							await release.promise;
							return index;
						} finally {
							active--;
						}
					},
					async () => resolvedPlan(),
				);
			});
		});
		try {
			await vi.waitFor(() => expect(a.report().queued).toBe(7));
			expect(preparations).toBe(1);
			expect(a.report().maxObservedActive).toBe(0);
			allowPlan.resolve();
			await two.promise;
			expect(service.jobCapacity()).toBe(2);
			expect(preparations).toBe(2);
		} finally {
			allowPlan.resolve();
			release.resolve();
		}
		const completed = await Promise.all(work);
		expect(new Set(completed).size).toBe(8);
		expect(maximum).toBe(2);
		expect(a.report().maxObservedActive).toBe(2);
		expect(a.report().maxObservedQueued).toBeGreaterThanOrEqual(7);
		expect(a.report().active).toBe(0);
		expect(a.report().queued).toBe(0);
	});

	it("keeps preparation FIFO across sessions, removes queued cancellation, and returns failed permits", async () => {
		const service = createLocalVmafResources({ readResources: ampleResources });
		const a = service.begin(new AbortController().signal),
			cancel = new AbortController(),
			b = service.begin(cancel.signal);
		const hold = deferred(),
			entered = deferred(),
			order: string[] = [];
		const first = a.prepared("first", async () => {
			order.push("first");
			entered.resolve();
			await hold.promise;
		});
		await entered.promise;
		const cancelled = b.prepared("cancelled", async () => {
			order.push("cancelled");
		});
		const rejected = expect(cancelled).rejects.toThrow("cancelled preparation");
		const failed = a.prepared("failed", async () => {
			order.push("failed");
			throw new Error("preparation failed");
		});
		const failedOutcome = expect(failed).rejects.toThrow("preparation failed");
		const last = a.prepared("last", async () => {
			order.push("last");
			return 42;
		});
		cancel.abort(new Error("cancelled preparation"));
		await rejected;
		hold.resolve();
		await first;
		await failedOutcome;
		expect(await last).toBe(42);
		expect(order).toEqual(["first", "failed", "last"]);
		expect(a.report().queued).toBe(0);
	});

	it("does not stop holders when a resolved plan shrinks the shared preparation target", async () => {
		const service = createLocalVmafResources({ readResources: ampleResources });
		const session = service.begin(new AbortController().signal);
		await session.run(
			"warm",
			pair,
			4,
			async () => {},
			async () => resolvedPlan(2),
		);
		const holds = [deferred(), deferred()],
			entered = [deferred(), deferred()];
		let active = 0;
		const holders = holds.map((hold, index) =>
			session.prepared(String(index), async () => {
				active++;
				entered[index]?.resolve();
				try {
					await hold.promise;
				} finally {
					active--;
				}
			}),
		);
		await Promise.all(entered.map((item) => item.promise));
		await session.run(
			"shrink",
			pair,
			4,
			async () => {},
			async () => resolvedPlan(1),
		);
		expect(active).toBe(2);
		expect(service.jobCapacity()).toBe(1);
		let nextStarted = false;
		const next = session.prepared("next", async () => {
			nextStarted = true;
		});
		holds[0]?.resolve();
		await holders[0];
		expect(nextStarted).toBe(false);
		holds[1]?.resolve();
		await Promise.all(holders);
		await next;
		expect(nextStarted).toBe(true);
	});

	it("shares a single memory budget across sessions instead of multiplying it per job", async () => {
		const service = createLocalVmafResources({
			threads: 4,
			concurrency: 2,
			readResources: () => ({
				cpuCapacity: 4,
				budgetBytes: 1.5 * GiB,
				reserveBytes: 0.5 * GiB,
			}),
		});
		const a = service.begin(new AbortController().signal),
			b = service.begin(new AbortController().signal);
		const entered = deferred(),
			hold = deferred();
		const first = a.run("first", pair, 2, async () => {
			entered.resolve();
			await hold.promise;
		});
		await entered.promise;
		let secondStarted = false;
		const second = b.run("second", pair, 2, async () => {
			secondStarted = true;
		});
		try {
			await Promise.resolve();
			expect(secondStarted).toBe(false);
		} finally {
			hold.resolve();
		}
		await Promise.all([first, second]);
		expect(secondStarted).toBe(true);
		expect(a.report().maxObservedActive).toBe(1);
	});

	it("plans against stable capacity while active memory reduces current free headroom", async () => {
		let budget = 1.5 * GiB;
		const service = createLocalVmafResources({
			threads: 4,
			concurrency: 2,
			readResources: () => ({
				cpuCapacity: 4,
				budgetBytes: budget,
				reserveBytes: 0.5 * GiB,
			}),
		});
		const a = service.begin(new AbortController().signal),
			hold = deferred(),
			entered = deferred();
		const first = a.run("first", pair, 2, async () => {
			entered.resolve();
			await hold.promise;
		});
		await entered.promise;
		budget = 0.5 * GiB;
		const b = service.begin(new AbortController().signal);
		expect(() => b.plan(pair, 2)).not.toThrow();
		let secondStarted = false;
		const second = b.run("second", pair, 2, async () => {
			secondStarted = true;
		});
		try {
			await Promise.resolve();
			expect(secondStarted).toBe(false);
		} finally {
			budget = 1.5 * GiB;
			hold.resolve();
		}
		await Promise.all([first, second]);
		expect(secondStarted).toBe(true);
	});

	it("uses fresh headroom to prevent a burst of reservations that have not allocated memory yet", async () => {
		let budget = 3 * GiB;
		const service = createLocalVmafResources({
			threads: 4,
			concurrency: 2,
			readResources: () => ({
				cpuCapacity: 4,
				budgetBytes: budget,
				reserveBytes: 0.5 * GiB,
			}),
		});
		const a = service.begin(new AbortController().signal),
			hold = deferred(),
			entered = deferred();
		budget = 1.5 * GiB;
		const first = a.run("first", pair, 2, async () => {
			entered.resolve();
			await hold.promise;
		});
		await entered.promise;
		let secondStarted = false;
		const next = a.run("second", pair, 2, async () => {
			secondStarted = true;
		});
		try {
			await Promise.resolve();
			expect(secondStarted).toBe(false);
		} finally {
			hold.resolve();
		}
		await Promise.all([first, next]);
		expect(secondStarted).toBe(true);
	});

	it("resolves the plan before execution admission and passes through lease abort and publication authority", async () => {
		const lease = new AbortController(),
			caller = new AbortController(),
			asserted = vi.fn(async () => {}),
			events: string[] = [];
		const service = createLocalVmafResources({
			readResources: () => ({
				cpuCapacity: 8,
				budgetBytes: 1,
				reserveBytes: 0,
			}),
			execute: async (plan, signal, work) => {
				expect(signal).toBe(caller.signal);
				expect(plan).toEqual(resolvedPlan());
				events.push("acquire");
				return work(lease.signal, asserted);
			},
		});
		const session = service.begin(caller.signal);
		expect(
			await session.run(
				"gpu",
				{ ...pair, scoringBackend: "cuda" },
				8,
				async (plan, runSignal, assertOwned) => {
					events.push("work");
					expect(runSignal).toBe(lease.signal);
					await assertOwned?.();
					lease.abort(new Error("lost lease"));
					expect(runSignal.aborted).toBe(true);
					return plan.nativeInflightFrames;
				},
				async () => {
					events.push("resolve");
					return resolvedPlan();
				},
			),
		).toBe(2);
		expect(events).toEqual(["resolve", "acquire", "work"]);
		expect(asserted).toHaveBeenCalledOnce();
		expect(session.report().units[0]).toMatchObject({
			key: "gpu",
			basis: "runtime-calibration",
			profileKey: "profile-a",
			gpu: { deviceKey: "opaque-gpu-a" },
		});
		expect(session.report().maxObservedActive).toBe(1);
	});

	it("refreshes planning capacity when idle, but keeps queued holders on their original budget", async () => {
		let cpu = 8,
			budget = 3 * GiB;
		const service = createLocalVmafResources({
			readResources: () => ({
				cpuCapacity: cpu,
				budgetBytes: budget,
				reserveBytes: 0,
			}),
		});
		const a = service.begin(new AbortController().signal),
			hold = deferred(),
			entered = deferred();
		const first = a.prepared("held", async () => {
			entered.resolve();
			await hold.promise;
		});
		await entered.promise;
		budget = 2 * GiB;
		cpu = 4;
		const b = service.begin(new AbortController().signal);
		expect(b.report().memoryBudgetBytes).toBe(3 * GiB);
		expect(b.report().cpuCapacity).toBe(8);
		const queued = b.prepared("queued", async () => {
			expect(b.report().memoryBudgetBytes).toBe(3 * GiB);
		});
		hold.resolve();
		await Promise.all([first, queued]);
		const c = service.begin(new AbortController().signal);
		expect(c.report().memoryBudgetBytes).toBe(2 * GiB);
		expect(c.report().cpuCapacity).toBe(4);
	});
});

it("bounds lightweight descriptors by hardware and rejects unbounded descriptor counts", () => {
	const service = createLocalVmafResources({
		readResources: () => ({
			cpuCapacity: 128,
			budgetBytes: 128 * GiB,
			reserveBytes: 0,
		}),
	});
	const session = service.begin(new AbortController().signal);
	expect(session.descriptorConcurrency(1000)).toBe(32);
	expect(session.descriptorConcurrency(3)).toBe(3);
	for (const count of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0])
		expect(session.descriptorConcurrency(count)).toBe(1);
});

it("retains plan metadata as a report snapshot and clears failed resolver queue activity", async () => {
	const service = createLocalVmafResources({ readResources: ampleResources });
	const session = service.begin(new AbortController().signal);
	await expect(
		session.run(
			"bad-profile",
			pair,
			8,
			async () => {},
			async () => {
				throw new Error("Calibration cancelled");
			},
		),
	).rejects.toThrow("Calibration cancelled");
	expect(session.report().active).toBe(0);
	expect(session.report().queued).toBe(0);
	const plan = resolvedPlan();
	await session.run(
		"good-profile",
		pair,
		8,
		async () => {},
		async () => plan,
	);
	const report = session.report();
	if (report.units[0]?.gpu) report.units[0].gpu.bytes = 99;
	plan.reasons?.push("Changed after execution");
	expect(session.report().units[0]?.gpu?.bytes).toBe(1024);
	expect(session.report().units[0]?.reasons).toEqual([
		"Measured end-to-end with CPU verification",
	]);
});
