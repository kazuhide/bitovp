/**
 * Retry only encoding START responses with HTTP 500 and error code 1004.
 * Other errors fail immediately. After an uncertain failure, an exact-id
 * status read can establish whether the provider already accepted START.
 */

export const START_1004_DELAYS_MS: readonly number[] = [
	10_000, 20_000, 30_000, 45_000, 60_000, 90_000, 120_000, 150_000, 180_000,
];

export function isStart1004(err: unknown): boolean {
	if (typeof err !== "object" || err === null) {
		return false;
	}
	const e = err as { httpStatusCode?: unknown; errorCode?: unknown };
	return e.httpStatusCode === 500 && e.errorCode === 1004;
}

export async function retryStart1004<T>(
	fn: () => Promise<T>,
	sleep: (ms: number) => Promise<void>,
): Promise<{ result: T; retries: number }> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= START_1004_DELAYS_MS.length; attempt++) {
		if (attempt > 0) {
			const delay = START_1004_DELAYS_MS[attempt - 1];
			if (delay === undefined) {
				break;
			}
			await sleep(delay);
		}
		try {
			return { result: await fn(), retries: attempt };
		} catch (err) {
			// Anything else fails fast — the window has ONE signature.
			if (!isStart1004(err)) {
				throw err;
			}
			lastErr = err;
		}
	}
	throw lastErr;
}

/**
 *  I-02: a start 5xx does not prove the start FAILED — the
 * request may have landed before the error was minted. After the retry
 * schedule exhausts (or on any start failure), reconcile against the
 * REMOTE state read-only: QUEUED/RUNNING/FINISHED means the start landed
 * and the job must proceed; CREATED means it genuinely never started;
 * a terminal ERROR/CANCELED is never blind-retried. The probe itself is
 * best-effort — an unreachable status endpoint changes nothing.
 */
export const STARTED_STATUSES: ReadonlySet<string> = new Set([
	"QUEUED",
	"RUNNING",
	"FINISHED",
]);

export async function reconcileStartFailure(
	readStatus: () => Promise<{ status: string }>,
): Promise<{ started: boolean; remoteStatus?: string }> {
	let remote: { status: string };
	try {
		remote = await readStatus();
	} catch {
		return { started: false };
	}
	return {
		started: STARTED_STATUSES.has(remote.status),
		remoteStatus: remote.status,
	};
}

/** Internal control for one owned START; it never aborts an in-flight request. */
export type StartRetryControl = {
	check(attempted: boolean): Promise<void>;
	sleep(ms: number): Promise<void>;
};

class StartControlInterrupted extends Error {
	constructor(readonly reason: unknown) {
		super("START control interrupted");
	}
}

/** Keep the provider retry policy separate from cancellation and ownership failures. */
export async function startWithRetry1004<T>(
	send: () => Promise<T>,
	readStatus: () => Promise<{ status: string }>,
	control?: StartRetryControl,
): Promise<{ result: T; retries: number; reconciledFrom?: string }> {
	let attempted = false;
	const controlled = async (run: () => Promise<void>) => {
		try {
			await run();
		} catch (reason) {
			throw new StartControlInterrupted(reason);
		}
	};
	const check = async () => {
		if (control) await controlled(() => control.check(attempted));
	};
	const sleep = async (ms: number) => {
		if (!control) {
			await new Promise((resolve) => setTimeout(resolve, ms));
			return;
		}
		for (let remaining = ms; remaining > 0; ) {
			await check();
			const slice = Math.min(remaining, 1_000);
			await controlled(() => control.sleep(slice));
			remaining -= slice;
		}
	};
	try {
		try {
			const done = await retryStart1004(async () => {
				await check();
				attempted = true;
				return send();
			}, sleep);
			await check();
			return done;
		} catch (error) {
			if (error instanceof StartControlInterrupted) throw error;
			await check();
			const outcome = await reconcileStartFailure(readStatus);
			await check();
			if (outcome.started)
				return {
					result: undefined as T,
					retries: 0,
					reconciledFrom: outcome.remoteStatus,
				};
			throw error;
		}
	} catch (error) {
		if (error instanceof StartControlInterrupted) throw error.reason;
		throw error;
	}
}
