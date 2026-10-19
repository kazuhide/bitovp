export class ResetRowDeleted extends Error {
	constructor() {
		super("The work item was deleted by reset");
	}
}

/** Abort bounded local work when its owning row disappears. DB uncertainty also
 * stops local work, but is not reported as a successful deletion. */
export async function whileRowExists<T>(
	exists: () => Promise<boolean>,
	work: (signal: AbortSignal) => Promise<T>,
	intervalMs: number | (() => number) = 1_000,
): Promise<T> {
	const controller = new AbortController();
	let failed = false;
	let failure: unknown;
	let checking: Promise<void> | undefined;
	const check = async () => {
		try {
			if (!(await exists())) throw new ResetRowDeleted();
		} catch (error) {
			if (!failed) {
				failed = true;
				failure = error;
			}
			controller.abort(failure);
		}
	};
	await check();
	if (failed) throw failure;
	// A trusted resolver can use the first row read without another lookup.
	const timer = setInterval(
		() => {
			if (!checking)
				checking = check().finally(() => {
					checking = undefined;
				});
		},
		typeof intervalMs === "function" ? intervalMs() : intervalMs,
	);
	timer.unref();
	try {
		const result = await work(controller.signal);
		clearInterval(timer);
		await checking;
		await check();
		if (failed) throw failure;
		return result;
	} catch (error) {
		if (failed) throw failure;
		throw error;
	} finally {
		clearInterval(timer);
		await checking;
	}
}
