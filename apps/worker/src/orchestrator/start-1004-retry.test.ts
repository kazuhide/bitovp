import { describe, expect, it } from "vitest";
import {
	isStart1004,
	reconcileStartFailure,
	retryStart1004,
	START_1004_DELAYS_MS,
} from "./start-1004-retry";

/**
 * : the start-1004 window retry — measured 2026-08-14 (two fresh
 * stamped encodings 500/1004'd immediately, both answered 202 on a later
 * re-POST). These pin the narrowness as much as the retry: ONE signature
 * retries, everything else fails fast.
 */

const err1004 = () =>
	Object.assign(new Error("An undefined error occurred"), {
		httpStatusCode: 500,
		errorCode: 1004,
	});

describe("retryStart1004", () => {
	it("retries THE signature and reports how many attempts the window ate", async () => {
		const slept: number[] = [];
		let calls = 0;
		const { result, retries } = await retryStart1004(
			async () => {
				calls += 1;
				if (calls <= 2) {
					throw err1004();
				}
				return "started";
			},
			async (ms) => {
				slept.push(ms);
			},
		);
		expect(result).toBe("started");
		expect(retries).toBe(2);
		// The escalating schedule, in order — the measured ~3-minute cure
		// must fit inside the total.
		expect(slept).toEqual([START_1004_DELAYS_MS[0], START_1004_DELAYS_MS[1]]);
	});

	it("a NON-1004 failure fails fast — no retry, no sleep", async () => {
		const slept: number[] = [];
		const other = Object.assign(new Error("Not Found"), {
			httpStatusCode: 404,
			errorCode: 1000,
		});
		await expect(
			retryStart1004(
				async () => {
					throw other;
				},
				async (ms) => {
					slept.push(ms);
				},
			),
		).rejects.toBe(other);
		expect(slept).toEqual([]);
	});

	it("a PERSISTENT 1004 exhausts the schedule and throws the LAST error", async () => {
		const slept: number[] = [];
		let calls = 0;
		await expect(
			retryStart1004(
				async () => {
					calls += 1;
					throw err1004();
				},
				async (ms) => {
					slept.push(ms);
				},
			),
		).rejects.toMatchObject({ httpStatusCode: 500, errorCode: 1004 });
		expect(calls).toBe(START_1004_DELAYS_MS.length + 1);
		expect(slept).toEqual([...START_1004_DELAYS_MS]);
		// Total window covered: the measured cure point (~3 min) fits.
		// ≥10 min: the measured 3–7 min cure (6395414a) must fit with margin.
		expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(600_000);
	});

	it("isStart1004 rejects lookalikes (500 without 1004, 1004 without 500, non-objects)", () => {
		expect(isStart1004(err1004())).toBe(true);
		expect(
			isStart1004(Object.assign(new Error(), { httpStatusCode: 500 })),
		).toBe(false);
		expect(
			isStart1004(
				Object.assign(new Error(), { httpStatusCode: 503, errorCode: 1004 }),
			),
		).toBe(false);
		expect(isStart1004(new Error("plain"))).toBe(false);
		expect(isStart1004(null)).toBe(false);
	});
});

/**
 *  I-02: a start 5xx reconciles against the REMOTE state before
 * the job is declared failed — the request may have landed before the
 * error was minted.
 */
describe("reconcileStartFailure", () => {
	it("QUEUED/RUNNING/FINISHED mean the start LANDED", async () => {
		for (const status of ["QUEUED", "RUNNING", "FINISHED"]) {
			const outcome = await reconcileStartFailure(async () => ({
				status,
			}));
			expect(outcome).toEqual({ started: true, remoteStatus: status });
		}
	});

	it("CREATED means it genuinely never started", async () => {
		const outcome = await reconcileStartFailure(async () => ({
			status: "CREATED",
		}));
		expect(outcome.started).toBe(false);
	});

	it("a TERMINAL remote state is never treated as started (no blind retry)", async () => {
		for (const status of ["ERROR", "CANCELED"]) {
			const outcome = await reconcileStartFailure(async () => ({
				status,
			}));
			expect(outcome.started).toBe(false);
		}
	});

	it("an unreachable status probe changes nothing (best-effort)", async () => {
		const outcome = await reconcileStartFailure(async () => {
			throw new Error("network down");
		});
		expect(outcome).toEqual({ started: false });
	});
});
