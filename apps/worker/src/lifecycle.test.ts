import { describe, expect, it, vi } from "vitest";
import { createShutdown, createSweepLoop } from "./lifecycle";

/**
 *  (audit 2026-08-29 CRITICAL-1), the shutdown half.
 *
 * The scheduler sweep commits a schedule row's claim and hands the action to
 * BullMQ a few statements later. `shutdown` used to close the queue
 * immediately, so a SIGTERM landing between those two writes CLOSED THE
 * QUEUE UNDER a committed claim — the ordinary stop manufacturing the exact
 * lost-handoff the outbox exists to recover from.
 *
 * The order is the behaviour, so the order is what these arms assert: an
 * event log the fakes append to, read back as a sequence.
 */

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("createSweepLoop", () => {
	it("drain() resolves only after the in-flight tick settles", async () => {
		const gate = deferred();
		const events: string[] = [];
		const loop = createSweepLoop(async () => {
			events.push("tick:start");
			await gate.promise;
			events.push("tick:end");
		});
		loop.run();
		const drained = loop.drain().then(() => {
			events.push("drained");
		});
		// A microtask turn with the tick still blocked: drain MUST NOT have
		// resolved. (`await null` twice — enough turns for a resolved
		// promise chain to flush, not enough for the gated one.)
		await null;
		await null;
		expect(events).toEqual(["tick:start"]);
		gate.resolve();
		await drained;
		expect(events).toEqual(["tick:start", "tick:end", "drained"]);
	});

	it("drain() waits for EVERY tick started, not just the last", async () => {
		const first = deferred();
		const second = deferred();
		const gates = [first, second];
		let started = 0;
		const finished: number[] = [];
		const loop = createSweepLoop(async () => {
			const index = started++;
			await gates[index]?.promise;
			finished.push(index);
		});
		loop.run();
		loop.run();
		let done = false;
		const drained = loop.drain().then(() => {
			done = true;
		});
		// Release them out of order: the drain owns both.
		second.resolve();
		await null;
		await null;
		expect(done).toBe(false);
		first.resolve();
		await drained;
		expect(finished.sort()).toEqual([0, 1]);
	});

	it("a failing tick is reported and still drains — a rejection must not wedge shutdown", async () => {
		const onError = vi.fn();
		const loop = createSweepLoop(async () => {
			throw new Error("db down");
		}, onError);
		loop.run();
		await expect(loop.drain()).resolves.toBeUndefined();
		expect(onError).toHaveBeenCalledWith(expect.any(Error));
	});

	it("a SYNCHRONOUS throw is caught too, so drain() cannot lie about it", async () => {
		const onError = vi.fn();
		const loop = createSweepLoop(() => {
			throw new Error("boom before the first await");
		}, onError);
		expect(() => loop.run()).not.toThrow();
		await expect(loop.drain()).resolves.toBeUndefined();
		expect(onError).toHaveBeenCalledWith(expect.any(Error));
	});

	it("stop() refuses further ticks", async () => {
		const tick = vi.fn(async () => undefined);
		const loop = createSweepLoop(tick);
		loop.stop();
		loop.run();
		await loop.drain();
		expect(tick).not.toHaveBeenCalled();
	});
});

describe("createShutdown", () => {
	function harness(over: { drainMs?: number } = {}) {
		const events: string[] = [];
		const gate = deferred();
		const closable = (name: string) => ({
			close: async () => {
				events.push(`close:${name}`);
			},
		});
		const shutdown = createShutdown({
			stopFeeders: () => {
				events.push("stopFeeders");
				return ["feeder-1"];
			},
			drains: [
				async () => {
					events.push("drain:start");
					await gate.promise;
					events.push("drain:end");
				},
			],
			closables: [closable("worker"), closable("queue")],
			disconnect: async () => {
				events.push("disconnect");
			},
			exit: (code) => {
				events.push(`exit:${code}`);
			},
			log: (message) => {
				events.push(`log:${message.slice(0, 12)}`);
			},
			drainTimeoutMs: over.drainMs ?? 10_000,
		});
		return { events, gate, shutdown };
	}

	it("awaits the in-flight sweep BEFORE any queue or worker closes", async () => {
		const { events, gate, shutdown } = harness();
		const running = shutdown("SIGTERM");
		await null;
		await null;
		// The whole point: nothing has closed while the sweep is mid-handoff.
		expect(events).not.toContain("close:queue");
		expect(events).not.toContain("close:worker");
		expect(events).toContain("drain:start");
		gate.resolve();
		await running;
		expect(events.indexOf("drain:end")).toBeLessThan(
			events.indexOf("close:queue"),
		);
		expect(events.indexOf("drain:end")).toBeLessThan(
			events.indexOf("close:worker"),
		);
	});

	it("signals the feeders first, then drains, then closes, then disconnects, then exits", async () => {
		const { events, gate, shutdown } = harness();
		const running = shutdown("SIGINT");
		gate.resolve();
		await running;
		const order = events.filter((event) => !event.startsWith("log:"));
		expect(order).toEqual([
			"stopFeeders",
			"drain:start",
			"drain:end",
			"close:worker",
			"close:queue",
			"disconnect",
			"exit:0",
		]);
	});

	it("a sweep that never finishes is bounded — the stop does not become a SIGKILL", async () => {
		// The drain is best-effort BY DESIGN: an unbounded wait would let the
		// container runtime kill the process instead, which is the harsher
		// version of the same loss. The row stays FIRED and unstamped and the
		// next boot's dispatcher pass recovers it.
		const { events, shutdown } = harness({ drainMs: 5 });
		await shutdown("SIGTERM");
		expect(events).toContain("drain:start");
		expect(events).not.toContain("drain:end");
		expect(events).toContain("close:queue");
		expect(events).toContain("exit:0");
	});

	it("a drain that REJECTS still lets the close sequence run", async () => {
		const events: string[] = [];
		const shutdown = createShutdown({
			stopFeeders: () => [],
			drains: [
				async () => {
					throw new Error("drain blew up");
				},
			],
			closables: [
				{
					close: async () => {
						events.push("close");
					},
				},
			],
			disconnect: async () => {
				events.push("disconnect");
			},
			exit: (code) => {
				events.push(`exit:${code}`);
			},
			log: () => undefined,
		});
		await shutdown("SIGTERM");
		expect(events).toEqual(["close", "disconnect", "exit:0"]);
	});

	/**
	 * review-365 I-2: the drains stopped sharing one budget.
	 *
	 * They used to run inside a single `Promise.race`, so the slowest drain had
	 * to fit inside the smallest budget on the object. Every drain was a
	 * bookkeeping sweep when that was written; the feeder takeover drain waits
	 * for a PROCESS TO DIE, which is SIGTERM -> the kill grace -> SIGKILL -> a
	 * terminal write, longer than the 5s default by itself. It would have timed
	 * out precisely in the hang it exists for, and logged the scheduler's
	 * recovery note while doing it.
	 */
	it("gives each drain its OWN budget — a sibling's short one cannot cut it short", async () => {
		const events: string[] = [];
		const logs: string[] = [];
		const slow = deferred();
		const shutdown = createShutdown({
			stopFeeders: () => [],
			drains: [
				// A bookkeeping sweep on the tiny DEFAULT budget that never
				// finishes: under the old shared race this number bounded
				// everything on the object.
				async () => {
					events.push("sweep:start");
					await new Promise<void>(() => {});
				},
				{
					name: "feeder takeover",
					// The real budget's ROLE, not its value: long enough that the
					// arm turns on the drain FINISHING, never on a clock.
					timeoutMs: 60_000,
					run: async () => {
						events.push("takeover:start");
						await slow.promise;
						events.push("takeover:end");
					},
					recovery: "another worker resumes it",
				},
			],
			closables: [
				{
					close: async () => {
						events.push("close");
					},
				},
			],
			disconnect: async () => {
				events.push("disconnect");
			},
			exit: (code) => {
				events.push(`exit:${code}`);
			},
			log: (message) => logs.push(message),
			drainTimeoutMs: 5,
		});

		const running = shutdown("SIGTERM");
		// Resolve on the OBSERVED sibling TIMEOUT, not on a delay and not on
		// the takeover's own start: waiting for the sweep's budget to expire
		// first is what makes the arm discriminate. Under a SHARED budget the
		// takeover drain would have been abandoned in the same instant, so its
		// `takeover:end` would land after `close` and a second timeout line
		// would appear — both of which are asserted below.
		await vi.waitFor(() =>
			expect(logs.some((line) => line.includes("the sweep drain"))).toBe(true),
		);
		expect(events).toContain("takeover:start");
		slow.resolve();
		await running;

		// The takeover drain finished; only the sweep was abandoned.
		expect(events).toContain("takeover:end");
		expect(events.indexOf("takeover:end")).toBeLessThan(
			events.indexOf("close"),
		);
		const timedOut = logs.filter((line) => line.includes("still running"));
		expect(timedOut).toHaveLength(1);
		expect(timedOut.at(0)).toContain("the sweep drain");
		expect(timedOut.at(0)).not.toContain("feeder takeover");
	});

	it("names the drain that hung, and what recovers it", async () => {
		// The old message said "a sweep was still running" and offered the
		// SCHEDULE OUTBOX as the recovery, whichever drain had actually hung.
		const logs: string[] = [];
		const shutdown = createShutdown({
			stopFeeders: () => [],
			drains: [
				{
					name: "feeder takeover",
					timeoutMs: 1,
					run: () => new Promise<void>(() => {}),
					recovery: "another worker's takeover sweep resumes the session",
				},
			],
			closables: [],
			disconnect: async () => {},
			exit: () => {},
			log: (message) => logs.push(message),
		});
		await shutdown("SIGTERM");
		const timedOut = logs.find((line) => line.includes("still running"));
		expect(timedOut).toContain("the feeder takeover drain");
		expect(timedOut).toContain("after 1ms");
		expect(timedOut).toContain("another worker's takeover sweep resumes");
	});

	it("a REJECTING named drain settles at once instead of burning its budget", async () => {
		// Its budget is an hour; if a rejection were left to the race to
		// resolve, this test would take one.
		const events: string[] = [];
		const shutdown = createShutdown({
			stopFeeders: () => [],
			drains: [
				{
					name: "feeder takeover",
					timeoutMs: 3_600_000,
					run: async () => {
						throw new Error("drain blew up");
					},
				},
			],
			closables: [
				{
					close: async () => {
						events.push("close");
					},
				},
			],
			disconnect: async () => {
				events.push("disconnect");
			},
			exit: (code) => {
				events.push(`exit:${code}`);
			},
			log: () => undefined,
		});
		await shutdown("SIGTERM");
		expect(events).toEqual(["close", "disconnect", "exit:0"]);
	});
});
