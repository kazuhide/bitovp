import assert from "node:assert/strict";
import fc from "fast-check";
import { afterEach, it, vi } from "vitest";
import { VmafDeadlineExceeded, withVmafDeadline } from "./deadline";
import { createResourceAdmission } from "./resource-admission";

const epoch = Date.parse("2026-11-18T00:00:00Z");
const offsets = [
	undefined,
	-1,
	0,
	1,
	59_999,
	60_000,
	60_001,
	2 ** 31 - 1,
	2 ** 31,
	2 ** 31 + 1,
] as const;
const event = fc.record({
	kind: fc.constantFrom("tick", "boundary", "abort", "close", "unblock"),
	delta: fc.integer({ min: 0, max: 1000 }),
	fail: fc.boolean(),
});

afterEach(() => vi.useRealTimers());

for (const seed of [20261118, 151152]) {
	it(`deadline and admission preserve ownership across generated interleavings (seed=${seed})`, async () => {
		const coverage = {
			traces: 0,
			actions: 0,
			expired: 0,
			omitted: 0,
			distant: 0,
			started: 0,
			queuedAbort: 0,
			activeAbort: 0,
			heldAfterAbort: 0,
			workFailure: 0,
			success: 0,
			deadlineFailure: 0,
			parentFailure: 0,
			blocked: 0,
			exclusive: 0,
			reservations: 0,
		};
		const seenOffsets = new Set<number | undefined>();
		const startedAt = performance.now();
		const details = await fc.check(
			fc.asyncProperty(
				fc.constantFrom(...offsets),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				fc.array(event, { maxLength: 20 }),
				async (offset, blocked, exclusive, reservations, events) => {
					vi.useFakeTimers();
					vi.setSystemTime(epoch);
					seenOffsets.add(offset);
					coverage.traces++;
					if (offset === undefined) coverage.omitted++;
					else if (offset <= 0) coverage.expired++;
					else if (offset >= 2 ** 31 - 1) coverage.distant++;
					if (blocked) coverage.blocked++;
					if (exclusive) coverage.exclusive++;
					if (reservations) coverage.reservations++;
					const gate = createResourceAdmission({
						capacityBytes: 8,
						availableBytes: () => 8,
						accountUnmaterializedReservations: reservations,
						pollMilliseconds: 1000,
					});
					const parent = new AbortController();
					const parentReason = new Error("generated parent cancellation");
					const workReason = new Error("generated work failure");
					let releaseBlocker = blocked
						? await gate.acquire(8, new AbortController().signal)
						: undefined;
					let workStarted = false;
					let workClosed = false;
					let closeRequested = false;
					let workFailed = false;
					let closedAt: number | undefined;
					let signal: AbortSignal | undefined;
					let closeWork: ((fail: boolean) => void) | undefined;
					let outcome: "pending" | "passed" | "failed" = "pending";
					let failure: unknown;
					let now = epoch;
					let parentCancelledBeforeClose = false;
					// Oracle stores lifecycle facts only. Abort does not imply close.
					const check = () => {
						if (offset !== undefined && offset <= 0) assert(!workStarted);
						if (workStarted && !workClosed)
							assert.equal(
								outcome,
								"pending",
								"returned before owned work closed",
							);
						if (signal && !workClosed) {
							const expired = offset !== undefined && now >= epoch + offset;
							assert.equal(
								signal.aborted,
								parent.signal.aborted || expired,
								"abort signal differs from clock/cancellation model",
							);
						}
					};
					const pending = withVmafDeadline(
						parent.signal,
						offset === undefined
							? undefined
							: new Date(epoch + offset).toISOString(),
						(current) => {
							signal = current;
							return gate.run(
								4,
								current,
								async () => {
									assert(!current.aborted, "started cancelled work");
									workStarted = true;
									coverage.started++;
									await new Promise<void>((resolve, reject) => {
										closeWork = (fail) => {
											workClosed = true;
											workFailed = fail;
											closedAt = now;
											parentCancelledBeforeClose = parent.signal.aborted;
											if (fail) reject(workReason);
											else resolve();
										};
										if (closeRequested) closeWork(workFailed);
									});
								},
								exclusive,
							);
						},
					).then(
						() => {
							outcome = "passed";
						},
						(error) => {
							outcome = "failed";
							failure = error;
						},
					);
					const flush = () => vi.advanceTimersByTimeAsync(0);
					const assertHeld = async () => {
						if (!workStarted || workClosed || !signal?.aborted) return;
						coverage.heldAfterAbort++;
						const probeController = new AbortController();
						let probeStarted = false;
						const probe = gate.acquire(8, probeController.signal, true).then(
							(release) => {
								probeStarted = true;
								release();
							},
							() => {},
						);
						await flush();
						probeController.abort();
						await probe;
						assert(!probeStarted, "capacity reused before aborted work closed");
					};
					try {
						await flush();
						check();
						for (const operation of events) {
							coverage.actions++;
							if (operation.kind === "tick" || operation.kind === "boundary") {
								// Do not advance billions of ms through timers: distant cases
								// test overflow by remaining active over small generated ticks.
								const delta =
									operation.kind === "boundary" &&
									offset !== undefined &&
									offset > 0 &&
									offset <= 60_001
										? Math.max(0, epoch + offset - now)
										: operation.delta;
								now += delta;
								await vi.advanceTimersByTimeAsync(delta);
							} else if (operation.kind === "abort" && !parent.signal.aborted) {
								if (!workStarted && outcome === "pending")
									coverage.queuedAbort++;
								if (workStarted && !workClosed) coverage.activeAbort++;
								parent.abort(parentReason);
							} else if (operation.kind === "unblock") {
								releaseBlocker?.();
								releaseBlocker = undefined;
							} else if (operation.kind === "close" && !closeRequested) {
								closeRequested = true;
								workFailed = operation.fail;
								closeWork?.(operation.fail);
							}
							await flush();
							check();
							await assertHeld();
						}
						// Finish all work normally so a stuck waiter/permit becomes an
						// assertion, not a test timeout or a silent cancellation success.
						releaseBlocker?.();
						releaseBlocker = undefined;
						await flush();
						if (!workClosed) {
							closeRequested = true;
							closeWork?.(workFailed);
						}
						await flush();
						assert.notEqual(
							outcome,
							"pending",
							"wrapper did not settle after work closed",
						);
						await pending;
						if (workStarted && workFailed) {
							assert.equal(failure, workReason);
							coverage.workFailure++;
						} else if (
							offset !== undefined &&
							(offset <= 0 ||
								(!workStarted && now >= epoch + offset) ||
								(closedAt !== undefined && closedAt >= epoch + offset))
						) {
							assert.equal(outcome, "failed");
							if (failure instanceof VmafDeadlineExceeded)
								coverage.deadlineFailure++;
							else {
								assert.equal(failure, parentReason);
								coverage.parentFailure++;
							}
						} else if (
							parentCancelledBeforeClose ||
							(!workStarted && parent.signal.aborted)
						) {
							// Without a deadline the wrapper preserves work(parent), including
							// a work function which deliberately completes after cancellation.
							if (offset !== undefined || !workStarted) {
								assert.equal(failure, parentReason);
								coverage.parentFailure++;
							} else assert.equal(outcome, "passed");
						} else {
							assert.equal(outcome, "passed");
							coverage.success++;
						}
					} finally {
						try {
							parent.abort(parentReason);
							releaseBlocker?.();
							closeRequested = true;
							closeWork?.(false);
							await flush();
							await pending;
							let recovered = false;
							const controller = new AbortController();
							const probe = gate.acquire(8, controller.signal, true).then(
								(release) => {
									recovered = true;
									release();
								},
								() => {},
							);
							await flush();
							controller.abort();
							await probe;
							assert(recovered, "deadline leaked a permit");
							assert.equal(vi.getTimerCount(), 0);
						} finally {
							vi.useRealTimers();
						}
					}
					assert(
						performance.now() - startedAt < 8000,
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
			"Deadline property evidence:",
			JSON.stringify({
				seed,
				...coverage,
				offsets: [...seenOffsets].map((offset) => offset ?? "omitted"),
				runs: details.numRuns,
				skipped: details.numSkips,
				shrinks: details.numShrinks,
				elapsedMs: Math.round(performance.now() - startedAt),
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
			assert.equal(seenOffsets.size, offsets.length);
			for (const [name, count] of Object.entries(coverage))
				assert(count > 0, `vacuous action coverage: ${name}`);
		}
	}, 10000);
}
