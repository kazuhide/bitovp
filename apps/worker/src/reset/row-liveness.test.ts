import { afterEach, expect, it, vi } from "vitest";
import { ResetRowDeleted, whileRowExists } from "./row-liveness";

afterEach(() => vi.useRealTimers());
it("never starts a deleted work item", async () => {
	const work = vi.fn();
	await expect(whileRowExists(async () => false, work)).rejects.toBeInstanceOf(
		ResetRowDeleted,
	);
	expect(work).not.toHaveBeenCalled();
});
it("aborts an active process after reset and refuses a successful result", async () => {
	vi.useFakeTimers();
	let present = true;
	let aborted = false;
	const result = whileRowExists(
		async () => present,
		(signal) =>
			new Promise((resolve) => {
				signal.addEventListener("abort", () => {
					aborted = true;
					resolve("late output");
				});
			}),
	);
	const assertion = expect(result).rejects.toBeInstanceOf(ResetRowDeleted);
	await vi.advanceTimersByTimeAsync(1);
	present = false;
	await vi.advanceTimersByTimeAsync(1_000);
	await assertion;
	expect(aborted).toBe(true);
});
it("preserves normal work", async () => {
	await expect(
		whileRowExists(
			async () => true,
			async () => "ok",
		),
	).resolves.toBe("ok");
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

it.each([
	1_000, 250, 100,
])("accounts for worst-phase polling and an 850ms child teardown (%s)", async (interval) => {
	vi.useFakeTimers();
	let present = true;
	let closedAt: number | undefined;
	const started = deferred<void>();
	const begin = Date.now();
	const pending = whileRowExists(
		async () => present,
		(signal) => {
			started.resolve();
			return new Promise<void>((resolve) =>
				signal.addEventListener(
					"abort",
					() => {
						setTimeout(() => {
							closedAt = Date.now();
							resolve();
						}, 850);
					},
					{ once: true },
				),
			);
		},
		interval,
	);
	const rejected = expect(pending).rejects.toBeInstanceOf(ResetRowDeleted);
	await started.promise;
	present = false;
	await vi.advanceTimersByTimeAsync(interval + 849);
	expect(closedAt).toBeUndefined();
	await vi.advanceTimersByTimeAsync(1);
	await rejected;
	expect((closedAt as number) - begin).toBe(interval + 850);
	expect((closedAt as number) - begin <= 1_000).toBe(interval === 100);
	expect(vi.getTimerCount()).toBe(0);
});

it("resolves the trusted cadence once after the initial read succeeds", async () => {
	vi.useFakeTimers();
	let initialRead = false;
	const finished = deferred<string>();
	const started = deferred<void>();
	const cadence = vi.fn(() => {
		expect(initialRead).toBe(true);
		return 100;
	});
	const exists = vi.fn(async () => {
		initialRead = true;
		return true;
	});
	const pending = whileRowExists(
		exists,
		() => {
			started.resolve();
			return finished.promise;
		},
		cadence,
	);
	await started.promise;
	try {
		expect(cadence).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(300);
		expect(cadence).toHaveBeenCalledOnce();
	} finally {
		finished.resolve("ok");
		await pending;
	}
	expect(vi.getTimerCount()).toBe(0);
});

it("does not overlap a final recheck with a pending periodic read", async () => {
	vi.useFakeTimers();
	const reading = deferred<boolean>();
	const finished = deferred<string>();
	const started = deferred<void>();
	let active = 0;
	let maximumActive = 0;
	let reads = 0;
	const exists = vi.fn(async () => {
		active++;
		maximumActive = Math.max(maximumActive, active);
		reads++;
		try {
			return reads === 2 ? await reading.promise : true;
		} finally {
			active--;
		}
	});
	const pending = whileRowExists(
		exists,
		() => {
			started.resolve();
			return finished.promise;
		},
		100,
	);
	await started.promise;
	await vi.advanceTimersByTimeAsync(500);
	expect(reads).toBe(2);
	finished.resolve("ok");
	await Promise.resolve();
	await Promise.resolve();
	try {
		expect(maximumActive).toBe(1);
	} finally {
		reading.resolve(true);
		await pending;
	}
	expect(reads).toBe(3);
	expect(maximumActive).toBe(1);
	expect(vi.getTimerCount()).toBe(0);
});

it("aborts on database uncertainty, suppresses overlapping checks, and cleans up its timer", async () => {
	vi.useFakeTimers();
	const reading = deferred<boolean>();
	const started = deferred<void>();
	const closed = deferred<void>();
	const failure = new Error("Fixture database unavailable");
	let aborted = false;
	const exists = vi
		.fn()
		.mockResolvedValueOnce(true)
		.mockImplementation(() => reading.promise);
	const pending = whileRowExists(
		exists,
		(signal) => {
			started.resolve();
			signal.addEventListener(
				"abort",
				() => {
					aborted = true;
				},
				{ once: true },
			);
			return closed.promise.then(() => {
				signal.throwIfAborted();
			});
		},
		100,
	);
	const rejected = expect(pending).rejects.toBe(failure);
	await started.promise;
	await vi.advanceTimersByTimeAsync(500);
	expect(exists).toHaveBeenCalledTimes(2);
	reading.reject(failure);
	await vi.advanceTimersByTimeAsync(0);
	expect(aborted).toBe(true);
	closed.resolve();
	await rejected;
	expect(vi.getTimerCount()).toBe(0);
	await vi.advanceTimersByTimeAsync(500);
	expect(exists).toHaveBeenCalledTimes(2);
});

it.each([
	"deletion",
	"uncertainty",
])("never publishes success when a pending read discovers %s after work returns", async (kind) => {
	vi.useFakeTimers();
	const reading = deferred<boolean>();
	const finished = deferred<string>();
	const started = deferred<void>();
	const failure = new Error("Fixture database unavailable");
	let reads = 0;
	const exists = vi.fn(async () => (++reads === 2 ? reading.promise : true));
	const pending = whileRowExists(
		exists,
		() => {
			started.resolve();
			return finished.promise;
		},
		100,
	);
	const rejected =
		kind === "deletion"
			? expect(pending).rejects.toBeInstanceOf(ResetRowDeleted)
			: expect(pending).rejects.toBe(failure);
	await started.promise;
	await vi.advanceTimersByTimeAsync(500);
	finished.resolve("stale success");
	await Promise.resolve();
	await Promise.resolve();
	if (kind === "deletion") reading.resolve(false);
	else reading.reject(failure);
	await rejected;
	expect(reads).toBe(3);
	expect(vi.getTimerCount()).toBe(0);
});

it.each([
	"deletion",
	"uncertainty",
])("preserves the first liveness failure when the final recheck changes (%s)", async (kind) => {
	vi.useFakeTimers();
	const reading = deferred<boolean>();
	const finished = deferred<string>();
	const started = deferred<void>();
	const failure = new Error("Fixture database unavailable");
	let reads = 0;
	const exists = vi.fn(async () => {
		reads++;
		if (reads === 1) return true;
		if (reads === 2) return reading.promise;
		if (kind === "deletion") throw failure;
		return false;
	});
	const pending = whileRowExists(
		exists,
		() => {
			started.resolve();
			return finished.promise;
		},
		100,
	);
	const rejected =
		kind === "deletion"
			? expect(pending).rejects.toBeInstanceOf(ResetRowDeleted)
			: expect(pending).rejects.toBe(failure);
	await started.promise;
	await vi.advanceTimersByTimeAsync(100);
	finished.resolve("late result");
	await Promise.resolve();
	await Promise.resolve();
	if (kind === "deletion") reading.resolve(false);
	else reading.reject(failure);
	await rejected;
	expect(reads).toBe(3);
	expect(vi.getTimerCount()).toBe(0);
});

it.each([
	undefined,
	null,
	0,
	false,
	"",
])("rejects an initial non-Error uncertainty without starting work (%s)", async (reason) => {
	const work = vi.fn().mockResolvedValue("unexpected success");
	const cadence = vi.fn(() => 100);
	const outcome = await whileRowExists(
		async () => {
			throw reason;
		},
		work,
		cadence,
	).then(
		(value) => ({ kind: "resolved", value }),
		(failure) => ({ kind: "rejected", failure }),
	);
	expect(outcome).toEqual({ kind: "rejected", failure: reason });
	expect(work).not.toHaveBeenCalled();
	expect(cadence).not.toHaveBeenCalled();
});

it.each([
	undefined,
	null,
	0,
	false,
	"",
])("preserves a deferred non-Error uncertainty across a later final failure (%s)", async (reason) => {
	vi.useFakeTimers();
	const reading = deferred<boolean>();
	const finished = deferred<string>();
	const started = deferred<void>();
	let reads = 0;
	const exists = vi.fn(async () => {
		reads++;
		if (reads === 1) return true;
		if (reads === 2) return reading.promise;
		throw new Error("Later fixture error");
	});
	const pending = whileRowExists(
		exists,
		() => {
			started.resolve();
			return finished.promise;
		},
		100,
	).then(
		(value) => ({ kind: "resolved", value }),
		(failure) => ({ kind: "rejected", failure }),
	);
	await started.promise;
	await vi.advanceTimersByTimeAsync(100);
	finished.resolve("stale success");
	await Promise.resolve();
	await Promise.resolve();
	reading.reject(reason);
	expect(await pending).toEqual({ kind: "rejected", failure: reason });
	expect(reads).toBe(3);
	expect(vi.getTimerCount()).toBe(0);
});
