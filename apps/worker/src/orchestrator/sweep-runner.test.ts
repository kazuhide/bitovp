import { describe, expect, it, vi } from "vitest";
import {
	CHANNEL_TIMED_OUT,
	createSingleFlightSweep,
	type HeartbeatSweepResult,
	runChannelsBounded,
} from "./sweep-runner";

/**
 * audit 602ec286 MODERATE-1 /  — the three rules the heartbeat sweep
 * is built from, each tested against an injected clock / explicit gates rather
 * than a wall-clock sleep.
 */

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("runChannelsBounded — bounded parallel lanes", () => {
	it("keeps at most `concurrency` items in flight at once", async () => {
		const items = ["a", "b", "c", "d", "e"];
		const gates = new Map<string, () => void>();
		const started: string[] = [];
		const outcomes: string[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const work = (item: string) =>
			new Promise<string>((resolve) => {
				started.push(item);
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				gates.set(item, () => {
					inFlight -= 1;
					resolve(`done:${item}`);
				});
			});
		const run = runChannelsBounded(items, work, {
			concurrency: 2,
			perItemTimeoutMs: 60_000, // never trips in this test
			onOutcome: (item) => outcomes.push(item),
		});
		await flush();
		// Only two lanes → only the first two items ever start.
		expect(started).toEqual(["a", "b"]);
		expect(maxInFlight).toBe(2);
		// Finish "a": its lane frees and pulls "c" — still ≤ 2 in flight.
		gates.get("a")?.();
		await flush();
		expect(started).toEqual(["a", "b", "c"]);
		expect(maxInFlight).toBe(2);
		expect(outcomes).toEqual(["a"]);
		// Drain the rest.
		gates.get("b")?.();
		gates.get("c")?.();
		await flush();
		expect(started).toEqual(["a", "b", "c", "d", "e"]);
		expect(maxInFlight).toBe(2);
		gates.get("d")?.();
		gates.get("e")?.();
		await run;
		expect(maxInFlight).toBe(2);
		expect([...outcomes].sort()).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("a hung item hits its deadline and frees its lane; the OTHER items still complete (row #270)", async () => {
		vi.useFakeTimers();
		try {
			const items = ["hung", "ok1", "ok2"];
			const outcomes = new Map<string, string | typeof CHANNEL_TIMED_OUT>();
			const work = (item: string) =>
				item === "hung"
					? new Promise<string>(() => {}) // never settles
					: Promise.resolve(`done:${item}`);
			// concurrency 1 (serial): the hung item is FIRST, so without the
			// per-item deadline it would block ok1/ok2 forever. The deadline is
			// exactly what lets the others through.
			const run = runChannelsBounded(items, work, {
				concurrency: 1,
				perItemTimeoutMs: 5_000,
				onOutcome: (item, outcome) => outcomes.set(item, outcome),
			});
			await vi.advanceTimersByTimeAsync(5_000);
			await run;
			expect(outcomes.get("hung")).toBe(CHANNEL_TIMED_OUT);
			expect(outcomes.get("ok1")).toBe("done:ok1");
			expect(outcomes.get("ok2")).toBe("done:ok2");
		} finally {
			vi.useRealTimers();
		}
	});

	it("a slow-but-in-budget item is NOT timed out — the deadline is per item", async () => {
		vi.useFakeTimers();
		try {
			const outcomes = new Map<string, string | typeof CHANNEL_TIMED_OUT>();
			const work = (item: string) =>
				new Promise<string>((resolve) =>
					setTimeout(() => resolve(`done:${item}`), 3_000),
				);
			const run = runChannelsBounded(["only"], work, {
				concurrency: 1,
				perItemTimeoutMs: 5_000,
				onOutcome: (item, outcome) => outcomes.set(item, outcome),
			});
			await vi.advanceTimersByTimeAsync(3_000);
			await run;
			// Settled at 3s, a full 2s inside its 5s budget.
			expect(outcomes.get("only")).toBe("done:only");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("createSingleFlightSweep — at most one sweep at a time", () => {
	it("skips an overlapping call while a sweep is in flight, then runs again after it finishes (row #270)", async () => {
		let calls = 0;
		let running = 0;
		let maxRunning = 0;
		let release: (() => void) | undefined;
		const run = async (): Promise<HeartbeatSweepResult> => {
			calls += 1;
			running += 1;
			maxRunning = Math.max(maxRunning, running);
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			running -= 1;
			return { polled: 1, failed: 0 };
		};
		const guarded = createSingleFlightSweep(run);

		const first = guarded(); // enters run, awaits its gate
		await Promise.resolve();
		expect(calls).toBe(1);

		// Overlapping tick while the first is still in flight.
		const secondP = guarded();
		await Promise.resolve();
		// The wrapped run was NOT entered a second time — this is the assertion a
		// removed guard turns red (it would read 2), never a hang.
		expect(calls).toBe(1);
		expect(await secondP).toEqual({ polled: 0, failed: 0, skipped: true });

		// Let the first finish; inFlight clears.
		release?.();
		expect(await first).toEqual({ polled: 1, failed: 0 });

		// A fresh tick now runs normally.
		const third = guarded();
		await Promise.resolve();
		expect(calls).toBe(2);
		release?.();
		expect(await third).toEqual({ polled: 1, failed: 0 });

		expect(maxRunning).toBe(1);
	});
});
