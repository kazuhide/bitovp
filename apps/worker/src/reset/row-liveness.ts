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
	intervalMs = 1_000,
): Promise<T> {
	const controller = new AbortController();
	let failure: unknown;
	let checking: Promise<void> | undefined;
	const check = async () => {
		try {
			if (!(await exists())) throw new ResetRowDeleted();
		} catch (error) {
			failure = error;
			controller.abort(error);
		}
	};
	await check();
	if (failure) throw failure;
	const timer = setInterval(() => {
		if (!checking)
			checking = check().finally(() => {
				checking = undefined;
			});
	}, intervalMs);
	timer.unref();
	try {
		const result = await work(controller.signal);
		await check();
		if (failure) throw failure;
		return result;
	} catch (error) {
		throw failure ?? error;
	} finally {
		clearInterval(timer);
		await checking;
	}
}
