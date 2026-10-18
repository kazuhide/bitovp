/**
 * Worker lifecycle seams — the two halves of "a tick that is running when
 * the process is asked to stop" .
 *
 * They live in their own module because `index.ts` is the process entry
 * point: importing it boots queues, workers, timers and a Prisma client, so
 * nothing inside it can be asserted. Both functions here are pure wiring
 * over injected dependencies, which is exactly what the shutdown ORDER is —
 * and the order is the thing that was wrong.
 */

/** Anything with a close (BullMQ `Worker` and `Queue` both satisfy it). */
export type Closable = { close(): Promise<unknown> };

export type SweepLoop = {
	/** Start one tick and track it. Never throws, never rejects. */
	run(): void;
	/** Resolves once every tick started so far has settled. */
	drain(): Promise<void>;
	/** Refuse further ticks — called when shutdown begins. */
	stop(): void;
};

/**
 * A `setInterval` sweep whose in-flight tick can be AWAITED.
 *
 * The scheduler sweep claims a schedule row (and its channel) in the
 * database and hands the action to BullMQ a few statements later. Before
 * this, the interval callback dropped the returned promise on the floor and
 * `shutdown` closed the queue immediately — so a SIGTERM landing in that
 * window closed the queue out from under a committed claim, which is the
 * lost-handoff shape the outbox exists to recover from. Draining first
 * means the ordinary stop no longer manufactures the emergency.
 */
export function createSweepLoop(
	tick: () => Promise<unknown>,
	onError: (err: unknown) => void = () => {},
): SweepLoop {
	const pending = new Set<Promise<void>>();
	let stopped = false;
	return {
		run() {
			if (stopped) {
				return;
			}
			// `Promise.resolve.then(tick)` rather than `tick` so a
			// SYNCHRONOUS throw is caught by the same handler as a rejection
			// — an un-tracked synchronous failure would make drain lie.
			const settled = Promise.resolve()
				.then(tick)
				.then(
					() => undefined,
					(err: unknown) => {
						onError(err);
					},
				);
			pending.add(settled);
			void settled.finally(() => {
				pending.delete(settled);
			});
		},
		async drain() {
			// A loop, not one allSettled: a tick that starts another tick (or
			// an interval that fires once more before `stop` lands) must not
			// escape the drain.
			while (pending.size > 0) {
				await Promise.allSettled([...pending]);
			}
		},
		stop() {
			stopped = true;
		},
	};
}

/**
 * One shutdown drain, with its OWN budget .
 *
 * The drains used to share a single `Promise.race`, so the slowest one had to
 * fit inside the fastest one's budget. That is fine while every drain is a
 * bookkeeping sweep, and wrong the moment one of them has to WAIT FOR A
 * PROCESS TO DIE: the feeder takeover drain needs SIGTERM → the kill grace →
 * SIGKILL → a terminal write, which is longer than the 5s default all by
 * itself. It would therefore have timed out exactly in the case it exists for
 * — the hang — and logged the scheduler's recovery note while doing it.
 *
 * A bare function keeps the old shape (default budget, generic name) so every
 * existing caller and test reads unchanged.
 */
export type ShutdownDrain = {
	/** Named in the timeout log, so an operator learns WHICH one hung. */
	name: string;
	run(): Promise<void>;
	/** Overrides `drainTimeoutMs` for this drain alone. */
	timeoutMs?: number;
	/** What happens anyway if this drain is abandoned. */
	recovery?: string;
};

export type ShutdownDeps = {
	/**
	 * Signalled FIRST: their ffmpeg children would outlive this process
	 * otherwise. Returns the ids it signalled, for the log line.
	 */
	stopFeeders(): string[];
	/**
	 * In-flight best-effort loops, awaited BEFORE anything closes — a sweep
	 * mid-handoff needs the queue it is adding to.
	 */
	drains: Array<(() => Promise<void>) | ShutdownDrain>;
	/** Workers and queues; closed together, failures tolerated. */
	closables: Closable[];
	disconnect(): Promise<void>;
	exit(code: number): void;
	log?(message: string): void;
	/**
	 * Default upper bound, per drain. A tick blocked on a third party must not
	 * convert a graceful stop into the SIGKILL the container runtime sends
	 * next — the outbox row stays FIRED with no stamp, and the next boot's
	 * dispatcher pass recovers it. Bounded loss beats an unbounded wait.
	 *
	 * A `ShutdownDrain` may name its own; this is what the others get.
	 */
	drainTimeoutMs?: number;
};

export function createShutdown(
	deps: ShutdownDeps,
): (signal: string) => Promise<void> {
	const log = deps.log ?? ((message: string) => console.log(message));
	const timeoutMs = deps.drainTimeoutMs ?? 5_000;
	return async function shutdown(signal: string): Promise<void> {
		log(`[worker] ${signal} received, closing workers…`);
		const stoppedFeeders = deps.stopFeeders();
		if (stoppedFeeders.length > 0) {
			log(
				`[worker:feederManager] stopping ${stoppedFeeders.length} feeder session(s)…`,
			);
		}
		if (deps.drains.length > 0) {
			// Still concurrent — the drains are independent — but each is now
			// raced against ITS OWN budget, so the whole wait is bounded by the
			// largest and no drain is cut short by a sibling's number.
			await Promise.allSettled(
				deps.drains.map(async (entry) => {
					const drain: ShutdownDrain =
						typeof entry === "function" ? { name: "sweep", run: entry } : entry;
					const budget = drain.timeoutMs ?? timeoutMs;
					let timer: ReturnType<typeof setTimeout> | undefined;
					// A rejecting drain is DONE, not hung: it must not burn its
					// whole budget before the close sequence runs.
					const settled = drain.run().then(
						() => "drained" as const,
						() => "drained" as const,
					);
					const outcome = await Promise.race([
						settled,
						new Promise<"timeout">((resolve) => {
							timer = setTimeout(() => resolve("timeout"), budget);
						}),
					]);
					clearTimeout(timer);
					if (outcome === "timeout") {
						log(
							`[worker] the ${drain.name} drain was still running after ${budget}ms — closing anyway` +
								(drain.recovery ? ` (${drain.recovery})` : ""),
						);
					}
				}),
			);
		}
		await Promise.allSettled(
			deps.closables.map((closable) => closable.close()),
		);
		await deps.disconnect();
		deps.exit(0);
	};
}
