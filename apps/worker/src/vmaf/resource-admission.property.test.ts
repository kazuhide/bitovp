import assert from "node:assert/strict";
import fc from "fast-check";
import { afterEach, it, vi } from "vitest";
import { createResourceAdmission } from "./resource-admission";

const seeds = [20261118, 151152];
const action = fc.record({
	kind: fc.constantFrom(
		"acquire",
		"run",
		"abort",
		"finish",
		"releaseAgain",
		"headroom",
	),
	slot: fc.nat(7),
	amount: fc.nat(16),
	exclusive: fc.boolean(),
	immediateAbort: fc.boolean(),
	fail: fc.boolean(),
});
type Job = {
	id: number;
	bytes: number;
	charge: number;
	exclusive: boolean;
	mode: "acquire" | "run";
	state: "queued" | "active" | "finished" | "cancelled";
	controller: AbortController;
	release?: () => void;
	finish?: (fail: boolean) => void;
	pending: Promise<void>;
};

afterEach(() => vi.useRealTimers());

for (const reservations of [false, true]) {
	for (const seed of seeds) {
		it(`admission conserves permits and FIFO across generated operations (reservations=${reservations}, seed=${seed})`, async () => {
			const coverage = {
				traces: 0,
				actions: 0,
				acquireRequests: 0,
				runRequests: 0,
				granted: 0,
				runStarted: 0,
				exclusiveGranted: 0,
				queuedAbort: 0,
				activeAbort: 0,
				immediateAbort: 0,
				doubleRelease: 0,
				workFailure: 0,
				headroom: 0,
				concurrent: 0,
			};
			const started = performance.now();
			const details = await fc.check(
				fc.asyncProperty(
					fc.integer({ min: 2, max: 16 }),
					fc.array(action, { maxLength: 30 }),
					async (capacity, actions) => {
						vi.useFakeTimers();
						vi.setSystemTime(0);
						let available = capacity;
						const gate = createResourceAdmission({
							capacityBytes: capacity,
							availableBytes: () => available,
							accountUnmaterializedReservations: reservations,
							pollMilliseconds: 1,
						});
						const jobs: Job[] = [];
						const faults: unknown[] = [];
						const active = () => jobs.filter((job) => job.state === "active");
						const flush = () => vi.advanceTimersByTimeAsync(1);
						// Observe public grant events. The oracle has no drain loop or
						// implementation counters: capacity is summed from live permits.
						const grant = (job: Job) => {
							assert.equal(
								job.state,
								"queued",
								"cancelled request was granted",
							);
							assert(
								!jobs.some(
									(other) => other.id < job.id && other.state === "queued",
								),
								"FIFO bypass",
							);
							const holders = active();
							const charge = holders.reduce(
								(sum, other) => sum + other.charge,
								0,
							);
							assert(charge + job.charge <= capacity, "capacity overcommitted");
							assert(
								job.bytes + (reservations ? charge : 0) <= available,
								"headroom overcommitted",
							);
							if (holders.length) coverage.concurrent++;
							coverage.granted++;
							if (job.mode === "run") coverage.runStarted++;
							if (job.exclusive) coverage.exclusiveGranted++;
							if (job.charge === capacity)
								assert.equal(holders.length, 0, "exclusive overlap");
							job.state = "active";
						};
						try {
							coverage.traces++;
							for (const command of actions) {
								coverage.actions++;
								if (
									(command.kind === "acquire" || command.kind === "run") &&
									jobs.length < 8
								) {
									const bytes = 1 + (command.amount % capacity);
									const job: Job = {
										id: jobs.length,
										bytes,
										charge: command.exclusive ? capacity : bytes,
										exclusive: command.exclusive,
										mode: command.kind,
										state: "queued",
										controller: new AbortController(),
										pending: Promise.resolve(),
									};
									jobs.push(job);
									if (job.mode === "acquire") {
										coverage.acquireRequests++;
										job.pending = gate
											.acquire(bytes, job.controller.signal, command.exclusive)
											.then((release) => {
												job.release = release;
												grant(job);
											});
									} else {
										coverage.runRequests++;
										job.pending = gate.run(
											bytes,
											job.controller.signal,
											async () => {
												assert(
													!job.controller.signal.aborted,
													"work entered after abort",
												);
												grant(job);
												await new Promise<void>((resolve, reject) => {
													job.finish = (fail) =>
														fail
															? reject(new Error("generated work failure"))
															: resolve();
												});
											},
											command.exclusive,
										);
										if (command.immediateAbort) {
											coverage.immediateAbort++;
											job.state = "cancelled";
											job.controller.abort(
												new Error("generated immediate abort"),
											);
										}
									}
									job.pending = job.pending.catch((error) => {
										if (error instanceof assert.AssertionError)
											faults.push(error);
										else if (
											!job.controller.signal.aborted &&
											job.state !== "finished"
										)
											faults.push(error);
										if (job.state === "queued") job.state = "cancelled";
									});
								} else if (command.kind === "headroom") {
									available = command.amount % (capacity + 1);
									coverage.headroom++;
								} else {
									const candidates = jobs.filter((job) =>
										command.kind === "abort"
											? (job.state === "queued" || job.state === "active") &&
												!job.controller.signal.aborted
											: command.kind === "releaseAgain"
												? job.state === "finished" && job.release
												: job.state === "active",
									);
									const job = candidates[command.slot % candidates.length];
									if (job && command.kind === "abort") {
										if (job.state === "queued") {
											coverage.queuedAbort++;
											job.state = "cancelled";
										} else coverage.activeAbort++;
										job.controller.abort(new Error("generated cancel"));
									} else if (job && command.kind === "releaseAgain") {
										coverage.doubleRelease++;
										job.release?.();
									} else if (job && command.kind === "finish") {
										job.state = "finished";
										if (job.mode === "run" && command.fail)
											coverage.workFailure++;
										job.release?.();
										job.finish?.(command.fail);
									}
								}
								await flush();
								assert.deepEqual(faults, []);
								const waiting = jobs.find((job) => job.state === "queued");
								const held = active().reduce((sum, job) => sum + job.charge, 0);
								if (waiting) {
									assert(
										held + waiting.charge > capacity ||
											waiting.bytes + (reservations ? held : 0) > available,
										"eligible FIFO head did not make progress",
									);
								}
								assert(
									active().reduce((sum, job) => sum + job.charge, 0) <=
										capacity,
								);
							}
						} finally {
							try {
								// Cancel all waiters before releasing holders; cleanup must not
								// launch unobserved work or rely on a real timeout.
								for (const job of [...jobs].reverse()) {
									if (job.state === "queued") job.state = "cancelled";
									job.controller.abort(new Error("generated cleanup"));
								}
								for (const job of jobs) {
									if (job.state === "active") job.state = "finished";
									job.release?.();
									job.finish?.(false);
								}
								await flush();
								await Promise.all(jobs.map((job) => job.pending));
								available = capacity;
								let recovered = false;
								const controller = new AbortController();
								const probe = gate
									.acquire(capacity, controller.signal, true)
									.then(
										(release) => {
											recovered = true;
											release();
										},
										() => {},
									);
								await flush();
								controller.abort();
								await probe;
								assert(recovered, "permit leaked after trace cleanup");
								assert.equal(vi.getTimerCount(), 0);
							} finally {
								vi.useRealTimers();
							}
						}
						assert(
							performance.now() - started < 8000,
							"generated execution budget exceeded",
						);
					},
				),
				{
					seed,
					numRuns: 100,
					path: process.env.BITOVP_PROPERTY_REPLAY_PATH,
					verbose: 2,
				},
			);
			console.log(
				"Admission property evidence:",
				JSON.stringify({
					seed,
					reservations,
					...coverage,
					runs: details.numRuns,
					skipped: details.numSkips,
					shrinks: details.numShrinks,
					elapsedMs: Math.round(performance.now() - started),
					failed: details.failed,
					path: details.counterexamplePath,
					counterexample: details.counterexample,
					error: details.error,
				}),
			);
			assert(
				!details.failed && !details.interrupted,
				details.error ?? "property interrupted",
			);
			assert.equal(details.numSkips, 0);
			if (!process.env.BITOVP_PROPERTY_REPLAY_PATH) {
				assert.equal(details.numRuns, 100);
				for (const [name, count] of Object.entries(coverage))
					assert(count > 0, `vacuous action coverage: ${name}`);
			}
		}, 10000);
	}
}
