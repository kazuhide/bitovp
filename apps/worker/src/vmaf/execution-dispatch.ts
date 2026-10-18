/** Allow cloud jobs to overlap without multiplying local FFmpeg workers. */
export function createLocalExecutionGate() {
	let tail: Promise<unknown> = Promise.resolve();
	return function local<T>(run: () => Promise<T>): Promise<T> {
		const current = tail.then(run, run);
		tail = current.catch(() => undefined);
		return current;
	};
}
export function cloudJobConcurrency(
	value: string | undefined,
	configured: boolean,
): number {
	if (!value?.trim()) return configured ? 2 : 1;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1 || n > 32)
		throw new Error("VMAF_JOB_CONCURRENCY must be an integer from 1 to 32");
	return n;
}
