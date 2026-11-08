/** One heavy editing cycle at a time across tenants in this worker process. */
export function createEditingWorkQueue() {
	let tail = Promise.resolve();
	return {
		createCycle(operation: () => Promise<unknown>, signal?: AbortSignal) {
			let pending: Promise<void> | undefined;
			return (): Promise<void> => {
				if (signal?.aborted) return Promise.resolve();
				if (pending) return pending;
				const next = tail.then(async () => {
					if (!signal?.aborted) await operation();
				});
				pending = next.finally(() => {
					pending = undefined;
				});
				tail = pending.catch(() => undefined);
				return pending;
			};
		},
	};
}
