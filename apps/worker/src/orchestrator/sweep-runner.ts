/**
 * Concurrency, per-channel deadline, and the single-flight guard for the live
 * heartbeat sweep .
 *
 * The sweep used to poll every RUNNING channel in one serial `await` loop with
 * no per-channel bound, placed on a 30s BullMQ repeat scheduler. Two failures
 * followed on any fleet where a single sweep runs long: one hung channel (an
 * SDK poll that never settles) stalled every channel behind it, and the 30s
 * repeat jobs piled on top of the still-running sweep. These three rules are
 * extracted HERE so each is unit-tested against an injected clock, and
 * `createLiveHeartbeatSweep` in live-processor.ts is the single wiring site.
 */

/** Returned when a channel's work did not settle before its deadline. */
export const CHANNEL_TIMED_OUT = Symbol("channel-timed-out");
export type ChannelOutcome<R> = R | typeof CHANNEL_TIMED_OUT;

/**
 * Race one channel's `work` against a per-channel deadline. On timeout the
 * work promise is ABANDONED — a hung network poll never settles, which is the
 * whole reason the deadline exists — and CHANNEL_TIMED_OUT is returned so the
 * caller can count it and move on. The global timer is used deliberately so a
 * test's fake clock drives the deadline with no wall-clock sleep.
 *
 * Contract: `work` must NOT reject (the sweep's per-channel closure catches
 * everything). A settle after the deadline is dropped by the race and cannot
 * surface as an unhandled rejection because the closure never rejects.
 */
async function withChannelDeadline<R>(
	work: Promise<R>,
	timeoutMs: number,
): Promise<ChannelOutcome<R>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<typeof CHANNEL_TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(CHANNEL_TIMED_OUT), timeoutMs);
	});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

/**
 * Run `work` over `items` with at most `concurrency` in flight at once, each
 * call bounded by `perItemTimeoutMs`. A hung item releases its lane when its
 * deadline fires, so one stuck channel delays the freshness SLA of the others
 * by at most a single timeout rather than stalling the whole sweep
. `onOutcome` observes each item's result — the real
 * value, or CHANNEL_TIMED_OUT.
 *
 * Lanes share ONE iterator: `iterator.next` is synchronous and atomic in
 * single-threaded JS, so no item is processed twice or skipped, and at most
 * `lanes` items are ever being awaited at once.
 */
export async function runChannelsBounded<T, R>(
	items: readonly T[],
	work: (item: T) => Promise<R>,
	opts: {
		concurrency: number;
		perItemTimeoutMs: number;
		onOutcome: (item: T, outcome: ChannelOutcome<R>) => void;
	},
): Promise<void> {
	const lanes = Math.max(1, Math.min(opts.concurrency, items.length));
	if (lanes === 0) {
		return;
	}
	const iterator = items[Symbol.iterator]();
	async function lane(): Promise<void> {
		for (let next = iterator.next(); !next.done; next = iterator.next()) {
			const item = next.value;
			const outcome = await withChannelDeadline(
				work(item),
				opts.perItemTimeoutMs,
			);
			opts.onOutcome(item, outcome);
		}
	}
	await Promise.all(Array.from({ length: lanes }, () => lane()));
}

export type HeartbeatSweepResult = {
	polled: number;
	failed: number;
	/** Set when this tick was skipped because a prior sweep was still running. */
	skipped?: true;
	/**
	 * : channels whose provider readback was TERMINAL this tick and
	 * were reconciled (no heartbeat polled — the encoding is gone). Present
	 * only when non-zero, so the plain `{ polled, failed }` shape holds.
	 */
	terminal?: number;
	/**
	 *  (MEDIUM-1): results discarded because their poll token no
	 * longer matched (a later sweep claimed the channel, or the run moved).
	 */
	discarded?: number;
	/**
	 *  (MEDIUM-1): channels this sweep did not poll because another
	 * sweep's claim already bumped their epoch this tick.
	 */
	claimSkipped?: number;
};

/**
 * Wrap a sweep so at most ONE runs at a time. The
 * 30s repeat scheduler enqueues a fresh sweep every interval regardless of
 * whether the previous one finished; while one is in flight, an overlapping
 * tick returns `skipped` immediately and does no work — which both prevents
 * overlap (worker concurrency > 1) and drains a backlog cheaply (concurrency
 * 1, where the repeat jobs queue up behind a long sweep).
 */
export function createSingleFlightSweep(
	run: () => Promise<HeartbeatSweepResult>,
): () => Promise<HeartbeatSweepResult> {
	let inFlight = false;
	return async (): Promise<HeartbeatSweepResult> => {
		if (inFlight) {
			return { polled: 0, failed: 0, skipped: true };
		}
		inFlight = true;
		try {
			return await run();
		} finally {
			inFlight = false;
		}
	};
}
