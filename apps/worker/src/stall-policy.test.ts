import { QUEUE_NAMES } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_LONG_JOB_MAX_STALLED_COUNT,
	LONG_RUNNING_QUEUES,
	stallOptionsFor,
} from "./stall-policy";

/**
 * : BullMQ's `maxStalledCount` defaults to 1, so a job is retired
 * permanently on its SECOND worker death — and a stall is a dead worker, not
 * a bad job. Measured on a real encoding: SIGKILLed twice, it landed
 * `ERROR — job stalled more than allowable limit` at 15/34 while its Bitmovin
 * encoding kept running; `POST /retry` then took the same row to FINISHED
 * 34/34 in 70 seconds. The work was never the problem.
 */
/** loadEnv fills its own defaults, so an empty source is a valid baseline. */
const BASE_ENV: NodeJS.ProcessEnv = {};

describe("stall policy (ledger #92)", () => {
	it("raises the ceiling for every queue that holds a job for a long time", () => {
		for (const key of LONG_RUNNING_QUEUES) {
			expect(stallOptionsFor(key)).toEqual({
				maxStalledCount: DEFAULT_LONG_JOB_MAX_STALLED_COUNT,
			});
		}
		// Above 1, or the change is decorative: 1 is exactly the default that
		// retired a resumable job on the second kill.
		expect(DEFAULT_LONG_JOB_MAX_STALLED_COUNT).toBeGreaterThan(1);
	});

	it("contributes NO key for a short queue, leaving BullMQ's own default", () => {
		const short = (
			Object.keys(QUEUE_NAMES) as (keyof typeof QUEUE_NAMES)[]
		).filter((key) => !LONG_RUNNING_QUEUES.has(key));
		expect(short.length).toBeGreaterThan(0);
		for (const key of short) {
			// An empty object, not `{maxStalledCount: 1}` — spreading a value we
			// chose would freeze BullMQ's default at whatever it is today.
			expect(stallOptionsFor(key)).toEqual({});
		}
	});

	it("names only queues that exist", () => {
		// A renamed queue must not leave a dead entry silently un-raising the
		// ceiling on the queue that replaced it.
		for (const key of LONG_RUNNING_QUEUES) {
			expect(QUEUE_NAMES[key], `${key} is not a real queue`).toBeDefined();
		}
	});

	it("covers every queue whose handler can outlive one stall interval", () => {
		// Enumerated deliberately rather than asserted as a count: this is the
		// list a reader has to be able to check against the handlers, and a
		// count would pass while naming the wrong four.
		expect([...LONG_RUNNING_QUEUES].sort()).toEqual([
			"feederManager",
			"orchestrator",
			// #160 PR4: a probe batch holds its job for N × abandon-deadline
			// (serial by design), and every probe step is resumable — the
			// per-probe channel rows ARE the progress record.
			// : a normalization downloads, transcodes and uploads one
			// object — minutes — and is resumable (stale claim re-entered,
			// provider content adopted by marker).
			"slateNormalize",
			"startupProbe",
			"vmafRunner",
		]);
		// liveChannel is excluded ON PURPOSE: it multiplexes long jobs with the
		// non-idempotent insert-content (slate insertion SLATE_IN) and scte35 one-shots,
		// where a redelivery duplicates on air rather than resuming.
		expect(LONG_RUNNING_QUEUES.has("liveChannel")).toBe(false);
	});

	it("a blank or garbage override cannot reach the policy — env validation", async () => {
		const { loadEnv } = await import("@bitovp/core");
		// `KEY=` in a .env is the empty string, and `Number("")` is 0, which
		// BullMQ reads as "never fail" — the exact inverse of this module's
		// stated invariant. loadEnv strips blanks, so the default applies.
		expect(
			loadEnv({ ...BASE_ENV, WORKER_MAX_STALLED_COUNT: "" })
				.WORKER_MAX_STALLED_COUNT,
		).toBeUndefined();
		// Whitespace is NOT stripped (the filter tests for ""), so it fails
		// loudly instead of coercing to 0 — measured, not assumed: I expected
		// it to be stripped and it throws, which is the better outcome.
		expect(() =>
			loadEnv({ ...BASE_ENV, WORKER_MAX_STALLED_COUNT: "   " }),
		).toThrow();
		// Garbage fails loudly at startup rather than becoming NaN.
		expect(() =>
			loadEnv({ ...BASE_ENV, WORKER_MAX_STALLED_COUNT: "ten" }),
		).toThrow();
		// And 0 is rejected outright — it is the "never fail" value.
		expect(() =>
			loadEnv({ ...BASE_ENV, WORKER_MAX_STALLED_COUNT: "0" }),
		).toThrow();
		expect(
			loadEnv({ ...BASE_ENV, WORKER_MAX_STALLED_COUNT: "3" })
				.WORKER_MAX_STALLED_COUNT,
		).toBe(3);
	});

	it("honours an operator override", () => {
		expect(stallOptionsFor("orchestrator", 3)).toEqual({ maxStalledCount: 3 });
		expect(stallOptionsFor("notify", 3)).toEqual({});
	});
});
