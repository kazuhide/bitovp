let active = 0;
const waiting: (() => void)[] = [];
const pump = () => {
	while (active < 2 && waiting.length) waiting.shift()?.();
};

/** A shared budget for original-media and edited-clip thumbnail decoders. */
export function withThumbnailDecoder<T>(
	signal: AbortSignal,
	capture: () => Promise<T>,
): Promise<T | null> {
	if (signal.aborted) return Promise.resolve(null);
	return new Promise((resolve) => {
		const cancel = () => {
			const index = waiting.indexOf(run);
			if (index >= 0) {
				waiting.splice(index, 1);
				resolve(null);
			}
			signal.removeEventListener("abort", cancel);
		};
		const run = () => {
			signal.removeEventListener("abort", cancel);
			if (signal.aborted) {
				resolve(null);
				return;
			}
			active++;
			let work: Promise<T>;
			try {
				work = capture();
			} catch {
				work = Promise.reject(new Error("Capture unavailable"));
			}
			void work
				.then(resolve, () => resolve(null))
				.finally(() => {
					active--;
					pump();
				});
		};
		waiting.push(run);
		signal.addEventListener("abort", cancel, { once: true });
		pump();
	});
}
