/**
 * Bounded retry for the start-1004 window — 's root cause, measured
 * 2026-08-14 with real credentials.
 *
 * POST /encodings/{id}/start intermittently answers HTTP 500 code 1004
 * ("An undefined error occurred") for a SHORT window after the encoding's
 * resources were created WITH the #38 idempotency stamp. Measured, not
 * reasoned: two fresh stamped encodings 500/1004'd on their immediate start,
 * and the SAME encodings answered 202 on a manual re-POST (+~3 min and
 * +3.5 h respectively), then ran to FINISHED — while the stamp-free twin
 * started first try. The stamp's customData writes settle asynchronously on
 * Bitmovin's side, and start's validation can lose that race; the 2026-08-14
 * E2E's stamp-on/stamp-off A/B (n=1 per arm) read this timing race as
 * "stamping breaks start".
 *
 * The retry is deliberately narrow: THIS signature only (500 + errorCode
 * 1004), start only (create ops never showed it, and manifest starts run
 * minutes after their creates — outside any settle window). The escalating
 * schedule totals ~11.75 min: measured cures were ~3 min (bfbc1846), 3–7 min
 * (6395414a — it outlived the first 2.75-min schedule and answered 202 on
 * the next manual probe), and one unbounded ≤3.5 h (c3666fbe, probed late).
 * A PERSISTENT 1004 still fails, carrying the attempt count so the error is
 * honest about the time already spent.
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
