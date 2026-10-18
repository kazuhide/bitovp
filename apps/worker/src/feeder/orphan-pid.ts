/**
 * Orphan-ffmpeg reclaim primitives, shared by the feeder processor's stop
 * path and the boot reconciler (audit 2026-08-29 CRITICAL-2) so there is
 * exactly ONE kill ladder in the tree instead of a copy per caller.
 */

/** The node `process.kill` contract: 0 probes existence (throws ESRCH). */
export type KillPid = (pid: number, signal: "SIGTERM" | "SIGKILL" | 0) => void;

/**
 * Reads a live pid's command line (`ps -o command=` / `/proc/<pid>/cmdline`).
 * Returns null when the pid is gone or the command cannot be obtained.
 *
 * SECRETS: a feeder command line contains the push URL, and an RTMP push URL
 * carries the stream key. The string is matched in memory and DISCARDED —
 * never logged, never persisted, never returned to a caller that stores it.
 */
export type ReadProcessCommand = (pid: number) => Promise<string | null>;

/** Poll cadence while verifying a kill (probe → wait → probe). */
export const KILL_VERIFY_POLL_MS = 100;

/**
 * Pid-reuse guard. The recorded pid is a bare number: by the time anyone acts
 * on it the kernel may have handed it to something else entirely, and killing
 * that is strictly worse than leaving an orphan. Our feeder ffmpeg is
 * recognisable from two things that appear together in nothing else on the
 * box: the spool file is named for the session id (`<spoolDir>/<id>.mp4`,
 * fetch-source.ts) and the push is the infinite loop (`-stream_loop -1`,
 * command.ts).
 *
 * A custom spool layout that drops the session id simply fails to match — the
 * caller then declines to kill, which is the safe direction.
 */
export function looksLikeFeederFfmpeg(
	command: string,
	sessionId: string,
): boolean {
	return command.includes(sessionId) && command.includes("-stream_loop");
}

/**
 * Verified kill ladder: existence probe → SIGTERM → grace-window polling →
 * SIGKILL → re-poll.
 *
 * Returns TRUE only when the pid is provably gone. SIGKILL is as far as
 * escalation goes — an unkillable D-state pid cannot be helped — and the
 * caller must not claim absence on a false: that is the difference between
 * "we stopped it" and "we hope we stopped it", and the whole reclaim path
 * hangs off which of those got written to the row.
 */
export function createKillLadder(deps: {
	killPid?: KillPid;
	sleep(ms: number): Promise<void>;
	killGraceMs: number;
}) {
	return async function terminateOrphanPid(pid: number): Promise<boolean> {
		const killPid = deps.killPid;
		if (!killPid) {
			return false;
		}
		const graceMs = deps.killGraceMs;
		const alive = (): boolean => {
			try {
				killPid(pid, 0); // signal 0 = existence probe (throws ESRCH)
				return true;
			} catch {
				return false;
			}
		};
		// ESRCH straight away: the process provably never existed under this
		// pid (or already exited) — nothing to escalate, and it IS gone.
		if (!alive()) {
			return true;
		}
		try {
			killPid(pid, "SIGTERM");
		} catch {
			return true; // Died between probe and signal — done.
		}
		const polls = Math.max(1, Math.ceil(graceMs / KILL_VERIFY_POLL_MS));
		const stepMs = Math.min(graceMs, KILL_VERIFY_POLL_MS);
		for (let i = 0; i < polls; i += 1) {
			await deps.sleep(stepMs);
			if (!alive()) {
				return true;
			}
		}
		try {
			killPid(pid, "SIGKILL");
		} catch {
			return true;
		}
		for (let i = 0; i < polls; i += 1) {
			await deps.sleep(stepMs);
			if (!alive()) {
				return true;
			}
		}
		return false;
	};
}
