/**
 * The poll-sleep seam , extracted so it is testable
 * WITHOUT driving a whole processor run — review-186 I1 measured the inline
 * ternary as dead code under the entire suite: collapsing it (or throwing
 * inside the produced sleep) survived 842/842 because no processor test ever
 * reaches ctx.poll.sleep. Both processors build their poll sleep here.
 *
 * Contract, pinned by poll-sleep.test.ts:
 * - wakeSleep ABSENT ⇒ the returned function IS deps.sleep (byte-identical
 *   prior behaviour — the fixed-interval poll is the floor).
 * - wakeSleep PRESENT ⇒ it is called with the ms and a LATE-READ ids getter
 *   (the encoding id exists only after CREATE_ENCODING runs).
 */
export function pollSleepFor(
	deps: {
		sleep(ms: number): Promise<void>;
		wakeSleep?(ms: number, interestedIds: () => string[]): Promise<void>;
	},
	ids: Map<string, string>,
): (ms: number) => Promise<void> {
	const wake = deps.wakeSleep;
	if (!wake) {
		return deps.sleep;
	}
	return (ms: number) => wake(ms, () => [...ids.values()]);
}
