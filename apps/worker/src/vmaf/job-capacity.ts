import { DelayedError, type Job } from "bullmq";

/** Parent jobs wait in BullMQ rather than occupying all physical worker slots.
 * Comparison-level admission remains shared across every admitted parent. */
export function queueExcessVmafJobs<T>(options: {
	localCapacity(): number;
	cloudCapacity: number;
	/** Must run inside the authenticated tenant consumer, before any secret lookup. */
	classify(job: Job): Promise<"local" | "cloud" | "control">;
	process(job: Job): Promise<T>;
	now?: () => number;
}) {
	const valid = (value: number) =>
		Number.isSafeInteger(value) && value >= 1 && value <= 32;
	if (!valid(options.cloudCapacity))
		throw new Error("VMAF_CLOUD_CAPACITY_INVALID");
	let localActive = 0,
		cloudActive = 0;
	return async (job: Job): Promise<T> => {
		const kind = await options.classify(job);
		if (kind === "control") return options.process(job);
		const capacity =
			kind === "cloud" ? options.cloudCapacity : options.localCapacity();
		if (!valid(capacity)) throw new Error("VMAF_LOCAL_CAPACITY_INVALID");
		if ((kind === "cloud" ? cloudActive : localActive) >= capacity) {
			await job.moveToDelayed((options.now ?? Date.now)() + 1000, job.token);
			throw new DelayedError();
		}
		if (kind === "cloud") cloudActive++;
		else localActive++;
		try {
			return await options.process(job);
		} finally {
			if (kind === "cloud") cloudActive--;
			else localActive--;
		}
	};
}
