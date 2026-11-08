import { describe, expect, it, vi } from "vitest";
import type { AutoExecutionCandidate } from "./auto-execution-policy";
import { createNativeCalibrationBudget } from "./native-calibration-budget";

type Run = (
	budgetMs: number,
	signal: AbortSignal,
) => Promise<AutoExecutionCandidate[]>;
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing test value");
	return value;
}
const key = "a".repeat(64);
const signal = () => new AbortController().signal;
function candidates(
	hostBytes = 100,
	counts = [1, 2],
): AutoExecutionCandidate[] {
	return counts.map((concurrency) => ({
		profileKey: key,
		scope: "native-with-cpu-parity",
		concurrency,
		cpuThreads: 1,
		decoderThreads: 1,
		inflightFrames: 4,
		hostBytesPerComparison: hostBytes,
		gpuBytesPerComparison: 200,
		trials: Array.from({ length: 3 }, () => ({
			cpuVerified: true,
			workFrames: 32,
			wallMs: 10,
		})),
	}));
}
function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	let reject: (error: unknown) => void = () => {};
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe("native calibration search budget", () => {
	it("revisits a higher cap after this process completed a smaller parallel search", async () => {
		const budget = createNativeCalibrationBudget();
		let cached = false;
		const run = vi.fn<Run>(async (ms) => {
			if (ms > 0) cached = true;
			return cached ? candidates() : [];
		});
		for (const maxConcurrency of [2, 6, 6])
			await budget.calibrate({
				profileKey: key,
				maxConcurrency,
				signal: signal(),
				run,
			});
		expect(run.mock.calls.map(([ms]) => ms)).toEqual([0, 30000, 0, 30000, 0]);
	});
	it("keeps a pre-existing adequate cache read-only when a fresh worker sees higher capacity", async () => {
		const budget = createNativeCalibrationBudget();
		const run = vi.fn<Run>(async () => candidates());
		for (const maxConcurrency of [2, 6, 6])
			await budget.calibrate({
				profileKey: key,
				maxConcurrency,
				signal: signal(),
				run,
			});
		expect(run.mock.calls.map(([ms]) => ms)).toEqual([0, 0, 0]);
	});
	it("spends another budget only for a newly eligible higher concurrency cap", async () => {
		const budget = createNativeCalibrationBudget();
		let cached = false;
		const run = vi.fn<Run>(async (ms) => {
			if (ms > 0) cached = true;
			return cached ? candidates(100, [1]) : [];
		});
		for (const maxConcurrency of [1, 4, 4, 2, 1, 4])
			await budget.calibrate({
				profileKey: key,
				maxConcurrency,
				signal: signal(),
				run,
			});
		expect(run.mock.calls.map(([ms]) => ms)).toEqual([
			0, 30000, 0, 30000, 0, 0, 0, 0,
		]);
	});
	it("lets a higher-cap follower search with its own callback after a serial origin settles", async () => {
		const budget = createNativeCalibrationBudget();
		const entered = deferred<void>(),
			finish = deferred<void>();
		let cached = false;
		const originSignal = signal(),
			followerSignal = signal();
		const origin = vi.fn<Run>(async (ms) => {
			if (ms > 0) {
				entered.resolve();
				await finish.promise;
				cached = true;
			}
			return cached ? candidates(100, [1]) : [];
		});
		const first = budget.calibrate({
			profileKey: key,
			maxConcurrency: 1,
			signal: originSignal,
			run: origin,
		});
		await entered.promise;
		const own = vi.fn<Run>(async (ms) =>
			candidates(999, ms > 0 ? [1, 4] : [1]),
		);
		const second = budget.calibrate({
			profileKey: key,
			maxConcurrency: 4,
			signal: followerSignal,
			run: own,
		});
		expect(own).not.toHaveBeenCalled();
		finish.resolve();
		expect((await first)[0]?.hostBytesPerComparison).toBe(100);
		expect((await second)[0]?.hostBytesPerComparison).toBe(999);
		expect(own.mock.calls.map(([ms]) => ms)).toEqual([0, 30000]);
		expect(own.mock.calls[1]?.[1]).toBe(followerSignal);
	});
	it("recognizes a completed parallel cache despite different aggregate work", async () => {
		const budget = createNativeCalibrationBudget();
		const rows = candidates().map((row) => ({
			...row,
			workload: { mode: "parallel-batch" as const, sampleFrames: 64 },
			trials: row.trials.map((t) => ({
				...t,
				workFrames: 64 * row.concurrency,
			})),
		}));
		const run = vi.fn<Run>(async () => rows);
		expect(
			await budget.calibrate({
				profileKey: key,
				maxConcurrency: 6,
				signal: signal(),
				run,
			}),
		).toBe(rows);
		expect(run.mock.calls.map(([ms]) => ms)).toEqual([0]);
	});
	it.each([
		"mode",
		"sample",
		"legacy",
		"fixed-sample",
	])("does not reuse mixed calibration workload metadata: %s", async (kind) => {
		const budget = createNativeCalibrationBudget();
		const rows = candidates().map((row) => ({
			...row,
			workload: { mode: "parallel-batch" as const, sampleFrames: 64 },
			trials: row.trials.map((t) => ({
				...t,
				workFrames: 64 * row.concurrency,
			})),
		}));
		const first = required(rows[0]),
			second = required(rows[1]);
		const mixed: AutoExecutionCandidate[] =
			kind === "fixed-sample"
				? [
						{
							...first,
							workload: {
								mode: "fixed-batch",
								sampleFrames: 16,
								fixedWorkUnits: 4,
							},
						},
						{
							...second,
							workload: {
								mode: "fixed-batch",
								sampleFrames: 32,
								fixedWorkUnits: 2,
							},
							trials: first.trials,
						},
					]
				: [
						first,
						{
							...second,
							workload:
								kind === "mode"
									? { mode: "fixed-batch", sampleFrames: 16, fixedWorkUnits: 4 }
									: kind === "sample"
										? { mode: "parallel-batch", sampleFrames: 32 }
										: undefined,
							trials: first.trials,
						},
					];
		const run = vi.fn<Run>(async (ms) => (ms > 0 ? rows : mixed));
		await budget.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: signal(),
			run,
		});
		expect(run.mock.calls.map(([ms]) => ms)).toEqual([0, 30000]);
	});
	it("checks cache first and reuses completed serial plus concurrent measurements", async () => {
		const budget = createNativeCalibrationBudget();
		const run = vi.fn<Run>(async () => candidates());
		const result = await budget.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: signal(),
			run,
		});
		expect(result).toEqual(candidates());
		expect(run.mock.calls).toEqual([[0, expect.any(AbortSignal)]]);
	});
	it("accepts a serial-only cache when only one comparison can fit", async () => {
		const budget = createNativeCalibrationBudget();
		const run = vi.fn<Run>(async () => candidates(100, [1]));
		expect(
			await budget.calibrate({
				profileKey: key,
				maxConcurrency: 1,
				signal: signal(),
				run,
			}),
		).toHaveLength(1);
		expect(run).toHaveBeenCalledTimes(1);
	});
	it("spends the search budget once and recomputes each later caller's full-length footprint", async () => {
		const budget = createNativeCalibrationBudget();
		let cached = false;
		const runs: ReturnType<typeof vi.fn<Run>>[] = [];
		const results: AutoExecutionCandidate[][] = [];
		for (let pair = 1; pair <= 8; pair++) {
			const run = vi.fn<Run>(async (ms: number) => {
				if (ms > 0) cached = true;
				return candidates(pair * 100, cached ? [1, 2] : [1]);
			});
			runs.push(run);
			results.push(
				await budget.calibrate({
					profileKey: key,
					maxConcurrency: 6,
					signal: signal(),
					run,
				}),
			);
		}
		expect(
			runs.flatMap((run) => run.mock.calls.map((call) => call[0])),
		).toEqual([0, 30000, 0, 0, 0, 0, 0, 0, 0]);
		expect(results.map((rows) => rows[0]?.hostBytesPerComparison)).toEqual([
			100, 200, 300, 400, 500, 600, 700, 800,
		]);
		expect(new Set(results).size).toBe(8);
	});
	it.each([
		{ counts: [] },
		{ counts: [1] },
	])("does not repeat a successful but incomplete search: %j", async ({
		counts,
	}) => {
		const budget = createNativeCalibrationBudget();
		const run = vi.fn<Run>(async () => candidates(100, counts));
		for (let i = 0; i < 8; i++)
			await budget.calibrate({
				profileKey: key,
				maxConcurrency: 6,
				signal: signal(),
				run,
			});
		expect(run.mock.calls.filter(([ms]) => ms > 0)).toHaveLength(1);
		expect(run).toHaveBeenCalledTimes(9);
	});
	it.each([
		(rows: AutoExecutionCandidate[]) => {
			required(rows[0]).profileKey = "b".repeat(64);
		},
		(rows: AutoExecutionCandidate[]) => {
			(rows[1] as unknown as { scope: string }).scope = "engine-only";
		},
		(rows: AutoExecutionCandidate[]) => {
			(required(rows[1]).trials[0] as { cpuVerified: boolean }).cpuVerified =
				false;
		},
		(rows: AutoExecutionCandidate[]) => {
			required(rows[1]).trials = required(rows[1]).trials.slice(0, 2);
		},
		(rows: AutoExecutionCandidate[]) => {
			required(rows[1]).trials = required(rows[1]).trials.map((t) => ({
				...t,
				workFrames: 64,
			}));
		},
	])("does not treat malformed or incompatible cache data as adequate", async (change) => {
		const budget = createNativeCalibrationBudget();
		const bad = candidates();
		change(bad);
		const run = vi.fn<Run>(async (ms: number) => (ms > 0 ? candidates() : bad));
		await budget.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: signal(),
			run,
		});
		expect(run).toHaveBeenCalledTimes(2);
		expect(run.mock.calls[1]?.[0]).toBe(30000);
	});
	it("shares one search while every follower reads its own converted candidates", async () => {
		const budget = createNativeCalibrationBudget();
		const entered = deferred<void>(),
			finish = deferred<void>();
		let cached = false;
		const firstRun = vi.fn<Run>(async (ms: number) => {
			if (ms > 0) {
				entered.resolve();
				await finish.promise;
				cached = true;
			}
			return candidates(100, cached ? [1, 2] : [1]);
		});
		const first = budget.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: signal(),
			run: firstRun,
		});
		await entered.promise;
		const followerRun = vi.fn<Run>(async () =>
			candidates(999, cached ? [1, 2] : [1]),
		);
		const follower = budget.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: signal(),
			run: followerRun,
		});
		expect(followerRun).not.toHaveBeenCalled();
		finish.resolve();
		expect((await first)[0]?.hostBytesPerComparison).toBe(100);
		expect((await follower)[0]?.hostBytesPerComparison).toBe(999);
		expect(followerRun.mock.calls).toEqual([[0, expect.any(AbortSignal)]]);
	});
	it("drains the origin before its API rejects and retries a survivor with its own media", async () => {
		const budget = createNativeCalibrationBudget();
		const owner = new AbortController();
		const entered = deferred<void>(),
			aborted = deferred<void>(),
			drain = deferred<void>();
		let searchSignal: AbortSignal | undefined;
		const ownerRun = vi.fn<Run>(async (ms, flightSignal) => {
			if (ms > 0) {
				searchSignal = flightSignal;
				entered.resolve();
				await new Promise<void>((resolve) =>
					flightSignal.addEventListener(
						"abort",
						() => {
							aborted.resolve();
							resolve();
						},
						{ once: true },
					),
				);
				await drain.promise;
				flightSignal.throwIfAborted();
			}
			return candidates(100, [1]);
		});
		let rejected = false;
		const first = budget
			.calibrate({
				profileKey: key,
				maxConcurrency: 6,
				signal: owner.signal,
				run: ownerRun,
			})
			.catch((error) => {
				rejected = true;
				throw error;
			});
		const firstRejected = expect(first).rejects.toThrow("owner cancelled");
		await entered.promise;
		const followerRun = vi.fn<Run>(async (ms) =>
			candidates(999, ms > 0 ? [1, 2] : [1]),
		);
		const follower = budget.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: signal(),
			run: followerRun,
		});
		owner.abort(new Error("owner cancelled"));
		await aborted.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(searchSignal?.aborted).toBe(true);
		expect(rejected).toBe(false);
		expect(followerRun).not.toHaveBeenCalled();
		drain.resolve();
		await firstRejected;
		expect((await follower)[0]?.hostBytesPerComparison).toBe(999);
		expect(followerRun.mock.calls.map(([ms]) => ms)).toEqual([0, 30000]);
	});
	it("lets an independently cancelled follower leave without cancelling the origin", async () => {
		const budget = createNativeCalibrationBudget();
		const owner = new AbortController(),
			followerController = new AbortController();
		const entered = deferred<void>(),
			finish = deferred<void>();
		let searchSignal: AbortSignal | undefined;
		const run = vi.fn<Run>(async (ms, flightSignal) => {
			if (ms > 0) {
				searchSignal = flightSignal;
				entered.resolve();
				await finish.promise;
			}
			return candidates(100, ms > 0 ? [1, 2] : [1]);
		});
		const first = budget.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: owner.signal,
			run,
		});
		await entered.promise;
		const followerRun = vi.fn<Run>(async () => candidates(999));
		const follower = budget.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: followerController.signal,
			run: followerRun,
		});
		followerController.abort(new Error("follower cancelled"));
		await expect(follower).rejects.toThrow("follower cancelled");
		expect(searchSignal?.aborted).toBe(false);
		expect(followerRun).not.toHaveBeenCalled();
		finish.resolve();
		expect(await first).toHaveLength(2);
	});
	it("rechecks a follower's old cache read after an originating search was cancelled", async () => {
		const budget = createNativeCalibrationBudget();
		const owner = new AbortController();
		const ownerCache = deferred<void>(),
			followerCache = deferred<void>(),
			entered = deferred<void>(),
			aborted = deferred<void>(),
			drain = deferred<void>();
		const ownerRun = vi.fn<Run>(async (ms, flightSignal) => {
			if (ms === 0) await ownerCache.promise;
			else {
				entered.resolve();
				await new Promise<void>((resolve) =>
					flightSignal.addEventListener(
						"abort",
						() => {
							aborted.resolve();
							resolve();
						},
						{ once: true },
					),
				);
				await drain.promise;
				flightSignal.throwIfAborted();
			}
			return candidates(100, [1]);
		});
		const first = budget.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: owner.signal,
			run: ownerRun,
		});
		const rejected = expect(first).rejects.toThrow("cancel owner");
		let reads = 0;
		const followerRun = vi.fn<Run>(async (ms) => {
			if (ms === 0 && ++reads === 1) {
				const old = candidates(999, [1]);
				await followerCache.promise;
				return old;
			}
			return candidates(999, ms > 0 ? [1, 2] : [1]);
		});
		const follower = budget.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: signal(),
			run: followerRun,
		});
		ownerCache.resolve();
		await entered.promise;
		owner.abort(new Error("cancel owner"));
		await aborted.promise;
		drain.resolve();
		await rejected;
		followerCache.resolve();
		expect(await follower).toHaveLength(2);
		expect(followerRun.mock.calls.map(([ms]) => ms)).toEqual([0, 0, 30000]);
	});
	it("waits for an abandoned origin's settlement before a later caller retries", async () => {
		const budget = createNativeCalibrationBudget();
		const owner = new AbortController();
		const entered = deferred<void>(),
			aborted = deferred<void>(),
			drain = deferred<void>();
		const originalRun = vi.fn<Run>(async (ms, flightSignal) => {
			if (ms > 0) {
				entered.resolve();
				await new Promise<void>((resolve) =>
					flightSignal.addEventListener(
						"abort",
						() => {
							aborted.resolve();
							resolve();
						},
						{ once: true },
					),
				);
				await drain.promise;
				flightSignal.throwIfAborted();
			}
			return candidates(100, [1]);
		});
		const first = budget.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: owner.signal,
			run: originalRun,
		});
		const rejected = expect(first).rejects.toThrow("origin cancelled");
		await entered.promise;
		owner.abort(new Error("origin cancelled"));
		await aborted.promise;
		const retryRun = vi.fn<Run>(async (ms) =>
			candidates(999, ms > 0 ? [1, 2] : [1]),
		);
		const later = budget.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: signal(),
			run: retryRun,
		});
		expect(retryRun).not.toHaveBeenCalled();
		drain.resolve();
		await rejected;
		expect((await later)[0]?.hostBytesPerComparison).toBe(999);
		expect(retryRun.mock.calls.map((call) => call[0])).toEqual([0, 30000]);
	});
	it("propagates a real search failure to current callers and lets a later call retry", async () => {
		const budget = createNativeCalibrationBudget();
		const entered = deferred<void>(),
			finish = deferred<void>();
		const failure = new Error("native parity failure");
		const run = vi.fn<Run>(async (ms: number) => {
			if (ms > 0) {
				entered.resolve();
				await finish.promise;
				throw failure;
			}
			return candidates(100, [1]);
		});
		const first = budget.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: signal(),
			run,
		});
		await entered.promise;
		const second = budget.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: signal(),
			run,
		});
		finish.resolve();
		await expect(first).rejects.toBe(failure);
		await expect(second).rejects.toBe(failure);
		expect(run.mock.calls.filter(([ms]) => ms > 0)).toHaveLength(1);
		const retry = vi.fn<Run>(async (ms: number) =>
			candidates(999, ms > 0 ? [1, 2] : [1]),
		);
		expect(
			(
				await budget.calibrate({
					profileKey: key,
					maxConcurrency: 6,
					signal: signal(),
					run: retry,
				})
			)[0]?.hostBytesPerComparison,
		).toBe(999);
		expect(retry.mock.calls.map((call) => call[0])).toEqual([0, 30000]);
	});
	it("keeps real search failures visible to a caller whose cache read was already pending", async () => {
		const budget = createNativeCalibrationBudget();
		const entered = deferred<void>(),
			finish = deferred<void>(),
			cache = deferred<void>();
		const failure = new Error("native invalid");
		const slowRun = vi.fn<Run>(async () => {
			await cache.promise;
			return candidates(999, [1]);
		});
		const slow = budget.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: signal(),
			run: slowRun,
		});
		const run = vi.fn<Run>(async (ms: number) => {
			if (ms > 0) {
				entered.resolve();
				await finish.promise;
				throw failure;
			}
			return candidates(100, [1]);
		});
		const first = budget.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: signal(),
			run,
		});
		await entered.promise;
		finish.resolve();
		await expect(first).rejects.toBe(failure);
		cache.resolve();
		await expect(slow).rejects.toBe(failure);
		expect(slowRun).toHaveBeenCalledTimes(1);
	});
	it("tracks different profile keys independently", async () => {
		const budget = createNativeCalibrationBudget();
		const run = vi.fn<Run>(async () => []);
		for (const profileKey of [key, "b".repeat(64), key])
			await budget.calibrate({
				profileKey,
				maxConcurrency: 6,
				signal: signal(),
				run,
			});
		expect(run.mock.calls.map((call) => call[0])).toEqual([
			0, 30000, 0, 30000, 0,
		]);
	});
	it("allows a restarted worker to fill a previously incomplete search", async () => {
		const firstProcess = createNativeCalibrationBudget();
		const incomplete = vi.fn<Run>(async () => candidates(100, [1]));
		await firstProcess.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: signal(),
			run: incomplete,
		});
		await firstProcess.calibrate({
			profileKey: key,
			maxConcurrency: 6,
			signal: signal(),
			run: incomplete,
		});
		expect(incomplete.mock.calls.map(([ms]) => ms)).toEqual([0, 30000, 0]);
		const restarted = createNativeCalibrationBudget();
		const fill = vi.fn<Run>(async (ms) =>
			candidates(999, ms > 0 ? [1, 2] : [1]),
		);
		expect(
			await restarted.calibrate({
				profileKey: key,
				maxConcurrency: 6,
				signal: signal(),
				run: fill,
			}),
		).toHaveLength(2);
		expect(fill.mock.calls.map(([ms]) => ms)).toEqual([0, 30000]);
	});
	it("does not consume a search allowance after a cache-only failure", async () => {
		const budget = createNativeCalibrationBudget();
		const failure = new Error("cache unavailable");
		const bad = vi.fn<Run>(async () => {
			throw failure;
		});
		await expect(
			budget.calibrate({
				profileKey: key,
				maxConcurrency: 6,
				signal: signal(),
				run: bad,
			}),
		).rejects.toBe(failure);
		const retry = vi.fn<Run>(async (ms) =>
			candidates(999, ms > 0 ? [1, 2] : [1]),
		);
		expect(
			await budget.calibrate({
				profileKey: key,
				maxConcurrency: 6,
				signal: signal(),
				run: retry,
			}),
		).toHaveLength(2);
		expect(retry.mock.calls.map(([ms]) => ms)).toEqual([0, 30000]);
	});
	it("caps an internal search allowance at thirty seconds", () => {
		for (const searchBudgetMs of [0, 30_001, Number.NaN, 1.5])
			expect(() => createNativeCalibrationBudget({ searchBudgetMs })).toThrow(
				"NATIVE_CALIBRATION_BUDGET_OPTIONS_INVALID",
			);
	});
	it("rejects pre-cancelled or invalid requests without invoking the adapter", async () => {
		const budget = createNativeCalibrationBudget();
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const run = vi.fn<Run>(async () => []);
		await expect(
			budget.calibrate({
				profileKey: key,
				maxConcurrency: 6,
				signal: controller.signal,
				run,
			}),
		).rejects.toThrow("cancelled");
		for (const maxConcurrency of [0, 33, 1.5, NaN])
			await expect(
				budget.calibrate({
					profileKey: key,
					maxConcurrency,
					signal: signal(),
					run,
				}),
			).rejects.toThrow("NATIVE_CALIBRATION_BUDGET_OPTIONS_INVALID");
		expect(run).not.toHaveBeenCalled();
	});
});
