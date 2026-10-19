import { createResourceAdmission } from "./resource-admission";
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
};
export type LocalVmafResourceSession = {
	plan(pair: ResourcePair, pairCount: number): LocalResourcePlan;
	run<T>(
		key: string,
		pair: ResourcePair,
		pairCount: number,
		work: (plan: LocalResourcePlan) => Promise<T>,
	): Promise<T>;
	report(): LocalResourceReport;
};
export type LocalVmafResources = {
	begin(signal: AbortSignal): LocalVmafResourceSession;
};

/** Shared policy for local VOD and Live; the existing job gate stays in charge. */
export function createLocalVmafResources(
	options: LocalResourceOptions & {
		readResources?: () => LocalResources;
		onDiagnostic?: (message: string) => void;
	} = {},
): LocalVmafResources {
	const read = options.readResources ?? readLocalResources;
	let fallbackReported = false;
	return {
		begin(signal) {
			const snapshot = { ...read() };
			const units: LocalResourceUnit[] = [];
			const admission =
				snapshot.budgetBytes !== undefined
					? createResourceAdmission({
							capacityBytes: snapshot.budgetBytes,
							availableBytes: () => read().budgetBytes,
						})
					: undefined;
			return {
				plan: (pair, count) =>
					planLocalResources(snapshot, pair, options, count),
				async run(key, pair, count, work) {
					const plan = planLocalResources(snapshot, pair, options, count);
					const execute = async () => {
						signal.throwIfAborted();
						units.push({
							key,
							...plan,
							...(snapshot.budgetBytes !== undefined
								? {
										reservationBytes: plan.exclusive
											? snapshot.budgetBytes
											: plan.estimatedBytes,
									}
								: {}),
						});
						return work(plan);
					};
					if (plan.manualFallback) {
						if (!fallbackReported) {
							fallbackReported = true;
							(options.onDiagnostic ?? console.warn)(
								"Manual quality resource settings are active; available memory could not be detected, so automatic memory admission is unavailable.",
							);
						}
						return execute();
					}
					if (!admission)
						throw new Error("Local memory admission is unavailable");
					return admission.run(
						plan.estimatedBytes,
						signal,
						execute,
						plan.exclusive,
					);
				},
				report: () => ({
					cpuCapacity: snapshot.cpuCapacity,
					memoryBudgetBytes: snapshot.budgetBytes,
					controlReserveBytes: snapshot.reserveBytes,
					configured: {
						...(options.concurrency !== undefined
							? { concurrency: options.concurrency }
							: {}),
						...(options.threads !== undefined
							? { threads: options.threads }
							: {}),
					},
					units: units.map((unit) => ({ ...unit })),
				}),
			};
		},
	};
}
