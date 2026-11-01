import {
	createResourceAdmission,
	ResourceUnavailableError,
} from "./resource-admission";
import {
	type LocalResourceOptions,
	type LocalResourcePlan,
	planLocalResources,
	type ResourcePair,
} from "./resource-plan";
import { type LocalResources, readLocalResources } from "./resources";

export type LocalResourceUnit = LocalResourcePlan & {
	key: string;
	reservationBytes?: number;
};
export type LocalResourceReport = {
	cpuCapacity: number;
	memoryBudgetBytes?: number;
	controlReserveBytes: number;
	configured: LocalResourceOptions;
	units: LocalResourceUnit[];
	/** Shared execution activity across every session using this manager. */
	active: number;
	queued: number;
	maxObservedActive: number;
	maxObservedQueued: number;
};
export type LocalVmafResourceSession = {
	plan(pair: ResourcePair, pairCount: number): LocalResourcePlan;
	/** Lightweight descriptors may wait without preparing inputs or starting children. */
	descriptorConcurrency(pairCount: number): number;
	/** Hold one shared preparation permit through input cleanup, including scoring. */
	prepared<T>(key: string, work: () => Promise<T>): Promise<T>;
	run<T>(
		key: string,
		pair: ResourcePair,
		pairCount: number,
		work: (
			plan: LocalResourcePlan,
			runSignal: AbortSignal,
			assertOwned?: () => Promise<void>,
		) => Promise<T>,
		resolvePlan?: () => Promise<LocalResourcePlan>,
	): Promise<T>;
	report(): LocalResourceReport;
};
export type LocalVmafResources = {
	begin(signal: AbortSignal): LocalVmafResourceSession;
	jobCapacity?(): number;
};
export type SharedLocalVmafResources = LocalVmafResources & {
	jobCapacity(): number;
};
function copyUnit(unit: LocalResourceUnit): LocalResourceUnit {
	return {
		...unit,
		...(unit.gpu ? { gpu: { ...unit.gpu } } : {}),
		...(unit.reasons ? { reasons: [...unit.reasons] } : {}),
	};
}
type PreparationWaiter = {
	signal: AbortSignal;
	resolve(release: () => void): void;
	reject(error: unknown): void;
	cancel(): void;
};

/** VOD and Live sessions share preparation and memory reservations. The optional
 * executor owns execution admission completely, including cross-worker leases. */
export function createLocalVmafResources(
	options: LocalResourceOptions & {
		readResources?: () => LocalResources;
		onDiagnostic?: (message: string) => void;
		execute?: <T>(
			plan: LocalResourcePlan,
			signal: AbortSignal,
			work: (
				signal: AbortSignal,
				assertOwned: () => Promise<void>,
			) => Promise<T>,
		) => Promise<T>;
	} = {},
): SharedLocalVmafResources {
	const read = options.readResources ?? readLocalResources;
	let fallbackReported = false;
	let snapshot: LocalResources | undefined;
	let admission: ReturnType<typeof createResourceAdmission> | undefined;
	let busy = 0,
		preparationCapacity = 1,
		preparationActive = 0;
	let active = 0,
		pendingRuns = 0,
		maxObservedActive = 0,
		maxObservedQueued = 0;
	const queue: PreparationWaiter[] = [];
	const queued = () => pendingRuns + queue.length;
	const observeQueue = () => {
		maxObservedQueued = Math.max(maxObservedQueued, queued());
	};
	function potential() {
		const current = snapshot as LocalResources;
		const cpu = Math.max(
			1,
			Math.floor(options.concurrency ?? current.cpuCapacity),
		);
		// The smallest legacy working-set class bounds preparation fan-out only;
		// execution still reserves the actual comparison's full estimate.
		const memory =
			current.budgetBytes === undefined
				? options.concurrency !== undefined && options.threads !== undefined
					? cpu
					: 1
				: Math.max(1, Math.floor(current.budgetBytes / (320 * 1024 ** 2)));
		return Math.max(1, Math.min(32, cpu, memory));
	}
	function refresh() {
		if (snapshot && busy > 0) return;
		const current = read();
		// Planning against physical capacity prevents an active child's own RAM
		// from turning the next valid comparison into an impossible estimate.
		snapshot = {
			...current,
			budgetBytes:
				current.memoryLimitBytes !== undefined
					? Math.max(0, current.memoryLimitBytes - current.reserveBytes)
					: current.budgetBytes,
		};
		admission =
			!options.execute && snapshot.budgetBytes !== undefined
				? createResourceAdmission({
						capacityBytes: snapshot.budgetBytes,
						availableBytes: () => read().budgetBytes,
						accountUnmaterializedReservations: true,
					})
				: undefined;
		preparationCapacity = Math.min(preparationCapacity, potential());
	}
	function remove(waiter: PreparationWaiter) {
		const index = queue.indexOf(waiter);
		if (index >= 0) queue.splice(index, 1);
		waiter.signal.removeEventListener("abort", waiter.cancel);
	}
	function drain() {
		while (queue.length && preparationActive < preparationCapacity) {
			const waiter = queue[0] as PreparationWaiter;
			remove(waiter);
			if (waiter.signal.aborted) {
				waiter.reject(waiter.signal.reason);
				continue;
			}
			preparationActive++;
			let released = false;
			waiter.resolve(() => {
				if (released) return;
				released = true;
				preparationActive--;
				drain();
			});
		}
		observeQueue();
	}
	function prepare(signal: AbortSignal) {
		return new Promise<() => void>((resolve, reject) => {
			if (signal.aborted) return reject(signal.reason);
			const waiter: PreparationWaiter = {
				signal,
				resolve,
				reject,
				cancel: () => {
					remove(waiter);
					reject(signal.reason);
					drain();
				},
			};
			signal.addEventListener("abort", waiter.cancel, { once: true });
			queue.push(waiter);
			drain();
		});
	}
	return {
		jobCapacity: () => preparationCapacity,
		begin(signal) {
			refresh();
			let sessionSnapshot = snapshot as LocalResources;
			const units: LocalResourceUnit[] = [];
			return {
				plan: (pair, count) =>
					planLocalResources(snapshot as LocalResources, pair, options, count),
				descriptorConcurrency: (count) =>
					Math.max(
						1,
						Math.min(
							Number.isSafeInteger(count) && count > 0 ? count : 1,
							potential(),
						),
					),
				async prepared(_key, work) {
					signal.throwIfAborted();
					busy++;
					let release: (() => void) | undefined;
					try {
						release = await prepare(signal);
						signal.throwIfAborted();
						return await work();
					} finally {
						busy--;
						release?.();
					}
				},
				async run(key, pair, count, work, resolvePlan) {
					signal.throwIfAborted();
					busy++;
					pendingRuns++;
					observeQueue();
					let waiting = true;
					try {
						sessionSnapshot = snapshot as LocalResources;
						// Calibration resolves and releases its own reservation before
						// this comparison acquires execution capacity.
						const plan = resolvePlan
							? await resolvePlan()
							: planLocalResources(sessionSnapshot, pair, options, count);
						signal.throwIfAborted();
						if (
							![plan.threads, plan.concurrency].every(
								(n) => Number.isSafeInteger(n) && n > 0,
							) ||
							!Number.isSafeInteger(plan.estimatedBytes) ||
							plan.estimatedBytes < 0
						)
							throw new ResourceUnavailableError("estimate");
						preparationCapacity = Math.max(
							1,
							Math.min(plan.concurrency, potential()),
						);
						drain();
						const launch = async (
							runSignal: AbortSignal,
							assertOwned?: () => Promise<void>,
						) => {
							runSignal.throwIfAborted();
							pendingRuns--;
							waiting = false;
							active++;
							maxObservedActive = Math.max(maxObservedActive, active);
							units.push(
								copyUnit({
									key,
									...plan,
									...(!options.execute &&
									sessionSnapshot.budgetBytes !== undefined
										? {
												reservationBytes: plan.exclusive
													? sessionSnapshot.budgetBytes
													: plan.estimatedBytes,
											}
										: {}),
								}),
							);
							try {
								return await work(plan, runSignal, assertOwned);
							} finally {
								active--;
							}
						};
						if (options.execute)
							return await options.execute(plan, signal, launch);
						if (plan.manualFallback) {
							if (!fallbackReported) {
								fallbackReported = true;
								(options.onDiagnostic ?? console.warn)(
									"Manual quality resource settings are active; available memory could not be detected, so automatic memory admission is unavailable.",
								);
							}
							return await launch(signal);
						}
						if (!admission)
							throw new Error("Local memory admission is unavailable");
						return await admission.run(
							plan.estimatedBytes,
							signal,
							() => launch(signal),
							plan.exclusive,
						);
					} finally {
						if (waiting) pendingRuns--;
						busy--;
					}
				},
				report: () => ({
					cpuCapacity: sessionSnapshot.cpuCapacity,
					memoryBudgetBytes: sessionSnapshot.budgetBytes,
					controlReserveBytes: sessionSnapshot.reserveBytes,
					configured: {
						...(options.concurrency !== undefined
							? { concurrency: options.concurrency }
							: {}),
						...(options.threads !== undefined
							? { threads: options.threads }
							: {}),
					},
					units: units.map(copyUnit),
					active,
					queued: queued(),
					maxObservedActive,
					maxObservedQueued,
				}),
			};
		},
	};
}
