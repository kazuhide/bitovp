/** A deadline is a stop request, never evidence of process exit or completion. */
export class VmafDeadlineExceeded extends Error {
	constructor() {
		super("Local measurement deadline exceeded; cleanup continues");
	}
}

/** Keep the lifetime of work (and its leases) even after abort. Recheck wall time
 * in bounded chunks so distant deadlines cannot overflow Node's timer range. */
export async function withVmafDeadline<T>(
	parent: AbortSignal,
	deadlineAt: string | undefined,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	parent.throwIfAborted();
	if (deadlineAt === undefined) return work(parent);
	const deadline = Date.parse(deadlineAt);
	if (!Number.isFinite(deadline))
		throw new Error("Invalid local measurement deadline");
	const controller = new AbortController();
	const abort = () => controller.abort(parent.reason);
	parent.addEventListener("abort", abort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const check = () => {
		if (controller.signal.aborted) return;
		const remaining = deadline - Date.now();
		if (remaining <= 0) controller.abort(new VmafDeadlineExceeded());
		else {
			timer = setTimeout(check, Math.min(remaining, 60_000));
			timer.unref();
		}
	};
	try {
		check();
		controller.signal.throwIfAborted();
		const result = await work(controller.signal);
		controller.signal.throwIfAborted();
		return result;
	} finally {
		if (timer) clearTimeout(timer);
		parent.removeEventListener("abort", abort);
	}
}
