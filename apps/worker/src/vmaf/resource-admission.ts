export class ResourceUnavailableError extends Error {
	constructor(reason: "estimate" | "headroom" | "unknown" | "metadata") {
		super(
			reason === "estimate"
				? "Quality measurement requires more memory than this worker can safely provide. Reduce VMAF_THREADS or increase worker memory."
				: reason === "headroom"
					? "Quality measurement is waiting for memory used by other work. Try again after memory becomes available."
					: reason === "metadata"
						? "Quality measurement could not estimate its resource needs from the video metadata. Check that both input videos report dimensions and duration or frame count."
						: "Automatic quality measurement could not determine available memory. Configure both VMAF_THREADS and VMAF_CONCURRENCY to select manual resource settings.",
		);
		this.name = "ResourceUnavailableError";
	}
}

type Waiter = {
	bytes: number;
	charge: number;
	signal: AbortSignal;
	resolve(release: () => void): void;
	reject(error: unknown): void;
	cancel(): void;
};

/** Memory already used by active children is included in availableBytes. */
export function createResourceAdmission(options: {
	capacityBytes: number;
	availableBytes(): number | undefined;
	pollMilliseconds?: number;
	externalStallMilliseconds?: number;
}) {
	const queue: Waiter[] = [];
	let reserved = 0;
	let holders = 0;
	let externalStallSince: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const remove = (waiter: Waiter) => {
		const index = queue.indexOf(waiter);
		if (index >= 0) queue.splice(index, 1);
		waiter.signal.removeEventListener("abort", waiter.cancel);
	};
	function drain() {
		if (timer) clearTimeout(timer);
		timer = undefined;
		while (queue.length > 0) {
			const waiter = queue[0] as Waiter;
			if (waiter.signal.aborted) {
				remove(waiter);
				waiter.reject(waiter.signal.reason);
				continue;
			}
			let available: number | undefined;
			try {
				available = options.availableBytes();
			} catch {
				available = undefined;
			}
			if (
				reserved + waiter.charge <= options.capacityBytes &&
				available !== undefined &&
				Number.isFinite(available) &&
				waiter.bytes <= available
			) {
				remove(waiter);
				reserved += waiter.charge;
				holders += 1;
				externalStallSince = undefined;
				let released = false;
				waiter.resolve(() => {
					if (released) return;
					released = true;
					reserved -= waiter.charge;
					holders -= 1;
					drain();
				});
				continue;
			}
			// A valid holder may take minutes. Only external pressure with no
			// active holder has a diagnostic deadline; release also wakes us.
			if (holders > 0) externalStallSince = undefined;
			else {
				externalStallSince ??= Date.now();
				if (
					Date.now() - externalStallSince >=
					(options.externalStallMilliseconds ?? 30_000)
				) {
					remove(waiter);
					waiter.reject(new ResourceUnavailableError("headroom"));
					externalStallSince = undefined;
					continue;
				}
			}
			timer = setTimeout(drain, options.pollMilliseconds ?? 250);
			return;
		}
		externalStallSince = undefined;
	}

	const acquire = (bytes: number, signal: AbortSignal, exclusive = false) =>
		new Promise<() => void>((resolve, reject) => {
			if (signal.aborted) return reject(signal.reason);
			if (
				!Number.isFinite(bytes) ||
				bytes <= 0 ||
				bytes > options.capacityBytes
			)
				return reject(new ResourceUnavailableError("estimate"));
			const waiter: Waiter = {
				bytes,
				charge: exclusive ? options.capacityBytes : bytes,
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
	return {
		acquire,
		async run<T>(
			bytes: number,
			signal: AbortSignal,
			work: () => Promise<T>,
			exclusive = false,
		): Promise<T> {
			const release = await acquire(bytes, signal, exclusive);
			try {
				signal.throwIfAborted();
				return await work();
			} finally {
				release();
			}
		},
	};
}
