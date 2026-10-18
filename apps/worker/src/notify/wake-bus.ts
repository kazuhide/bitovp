/**
 * Wake bus : webhook-driven "poll now" signals. The
 * inbound dispatcher publishes an encoding id; polling loops sleep through
 * `sleep(ms, interested)` and wake EARLY when a signal for an id they care
 * about arrives. The poll loop remains the ONLY state writer — a wake only
 * shortens one sleep, so with no ingress (or Redis down) behaviour is
 * exactly the fixed-interval poll (#16's framing: an optimization, never a
 * correctness dependency).
 */

type Waiter = {
	interested(encodingId: string): boolean;
	wake(): void;
};

export type WakeBus = {
	/** Called by the pub/sub wiring; safe to call for unknown ids. */
	signal(encodingId: string): void;
	/** Resolves after ms, or EARLY on a matching signal. */
	sleep(ms: number, interested: (encodingId: string) => boolean): Promise<void>;
	/** Waiters currently parked (for tests/ops). */
	size(): number;
};

export function createWakeBus(): WakeBus {
	const waiters = new Set<Waiter>();
	return {
		signal(encodingId) {
			for (const waiter of [...waiters]) {
				// A throwing predicate must not skip the remaining waiters nor
				// escape into the pub/sub handler — the optimization can never
				// become a correctness dependency, STRUCTURALLY (review-186 N1;
				// unreachable today, [...].includes cannot throw).
				try {
					if (waiter.interested(encodingId)) {
						waiters.delete(waiter);
						waiter.wake();
					}
				} catch (err) {
					console.error(
						"[wake-bus] interest predicate threw (waiter left parked):",
						err instanceof Error ? err.message : err,
					);
				}
			}
		},
		sleep(ms, interested) {
			return new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					waiters.delete(waiter);
					resolve();
				}, ms);
				const waiter: Waiter = {
					interested,
					wake() {
						clearTimeout(timer);
						resolve();
					},
				};
				waiters.add(waiter);
			});
		},
		size() {
			return waiters.size;
		},
	};
}
