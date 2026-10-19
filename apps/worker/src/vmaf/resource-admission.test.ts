import { afterEach, describe, expect, it, vi } from "vitest";
import { createResourceAdmission } from "./resource-admission";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("local quality measurement memory admission", () => {
	it("reserves before another caller can launch and wakes in FIFO order", async () => {
		const gate = createResourceAdmission({
			capacityBytes: 10,
			availableBytes: () => 10,
		});
		const signal = new AbortController().signal;
		const release = await gate.acquire(8, signal);
		const order: string[] = [];
		const large = gate.run(8, signal, async () => order.push("large"));
		const small = gate.run(2, signal, async () => order.push("small"));
		await Promise.resolve();
		expect(order).toEqual([]);
		release();
		await Promise.all([large, small]);
		expect(order).toEqual(["large", "small"]);
	});

	it("reserves exclusive capacity while comparing only its working set with current headroom", async () => {
		const gate = createResourceAdmission({
			capacityBytes: 10,
			availableBytes: () => 8,
		});
		const signal = new AbortController().signal;
		const release = await gate.acquire(4, signal, true);
		const started = vi.fn();
		const next = gate.run(4, signal, async () => started());
		await Promise.resolve();
		expect(started).not.toHaveBeenCalled();
		release();
		await next;
		expect(started).toHaveBeenCalledOnce();
	});

	it("does not admit exclusive work below its working-set estimate and removes a canceled waiter", async () => {
		const gate = createResourceAdmission({
			capacityBytes: 10,
			availableBytes: () => 3,
		});
		const controller = new AbortController();
		const started = vi.fn();
		const pending = gate.run(4, controller.signal, async () => started(), true);
		const rejected = expect(pending).rejects.toThrow("Canceled fixture");
		await Promise.resolve();
		expect(started).not.toHaveBeenCalled();
		controller.abort(new Error("Canceled fixture"));
		await rejected;
		await expect(
			gate.run(3, new AbortController().signal, async () => "released"),
		).resolves.toBe("released");
	});

	it("waits longer than thirty seconds while a granted holder can release", async () => {
		vi.useFakeTimers();
		const gate = createResourceAdmission({
			capacityBytes: 10,
			availableBytes: () => 10,
		});
		const signal = new AbortController().signal;
		const holder = deferred();
		const first = gate.run(10, signal, () => holder.promise);
		await Promise.resolve();
		const started = vi.fn();
		let failure: unknown;
		const next = gate
			.run(10, signal, async () => started())
			.catch((error) => {
				failure = error;
			});
		await vi.advanceTimersByTimeAsync(225_000);
		expect(started).not.toHaveBeenCalled();
		expect(failure).toBeUndefined();
		holder.resolve();
		await Promise.all([first, next]);
		expect(started).toHaveBeenCalledOnce();
	});

	it("does not subtract active reservations from observed headroom a second time", async () => {
		let available = 10;
		const gate = createResourceAdmission({
			capacityBytes: 10,
			availableBytes: () => available,
		});
		const signal = new AbortController().signal;
		const release = await gate.acquire(6, signal);
		available = 4;
		await expect(gate.run(4, signal, async () => "overlap")).resolves.toBe(
			"overlap",
		);
		release();
	});

	it("bounds an external headroom stall after all active holders have finished", async () => {
		vi.useFakeTimers();
		let available = 10;
		const gate = createResourceAdmission({
			capacityBytes: 10,
			availableBytes: () => available,
		});
		const signal = new AbortController().signal;
		const release = await gate.acquire(10, signal);
		available = 0;
		const next = gate.acquire(10, signal);
		const rejected = expect(next).rejects.toThrow("memory used by other work");
		await vi.advanceTimersByTimeAsync(40_000);
		release();
		await vi.advanceTimersByTimeAsync(29_999);
		await vi.advanceTimersByTimeAsync(251);
		await rejected;
	});

	it("rejects an impossible single estimate without blocking following work", async () => {
		const gate = createResourceAdmission({
			capacityBytes: 10,
			availableBytes: () => 10,
		});
		const signal = new AbortController().signal;
		await expect(gate.acquire(11, signal)).rejects.toThrow("more memory");
		await expect(gate.run(10, signal, async () => "finished")).resolves.toBe(
			"finished",
		);
	});

	it("removes a cancelled FIFO head and releases a granted permit exactly once", async () => {
		const gate = createResourceAdmission({
			capacityBytes: 10,
			availableBytes: () => 10,
		});
		const signal = new AbortController().signal;
		const release = await gate.acquire(10, signal);
		const cancelled = new AbortController();
		const first = gate.acquire(10, cancelled.signal);
		const rejected = expect(first).rejects.toThrow("cancelled fixture");
		cancelled.abort(new Error("cancelled fixture"));
		await rejected;
		release();
		release();
		const held = await gate.acquire(10, signal);
		let admitted = false;
		const next = gate.run(1, signal, async () => {
			admitted = true;
		});
		await Promise.resolve();
		expect(admitted).toBe(false);
		held();
		await next;
	});

	it("returns the permit when abort wins immediately after grant", async () => {
		const gate = createResourceAdmission({
			capacityBytes: 10,
			availableBytes: () => 10,
		});
		const controller = new AbortController();
		const work = vi.fn();
		const result = gate.run(10, controller.signal, async () => work());
		controller.abort(new Error("grant race"));
		await expect(result).rejects.toThrow("grant race");
		expect(work).not.toHaveBeenCalled();
		await expect(
			gate.run(10, new AbortController().signal, async () => "next"),
		).resolves.toBe("next");
	});

	it("holds memory through post-processing and releases after a failure", async () => {
		const gate = createResourceAdmission({
			capacityBytes: 10,
			availableBytes: () => 10,
		});
		const signal = new AbortController().signal;
		const parsing = deferred();
		const first = gate.run(10, signal, async () => {
			await parsing.promise;
			throw new Error("result persistence failed");
		});
		const rejected = expect(first).rejects.toThrow("result persistence failed");
		const work = vi.fn();
		const second = gate.run(10, signal, async () => work());
		await Promise.resolve();
		expect(work).not.toHaveBeenCalled();
		parsing.resolve();
		await rejected;
		await second;
		expect(work).toHaveBeenCalledOnce();
	});
});
