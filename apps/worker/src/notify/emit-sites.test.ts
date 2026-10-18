import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 *  (design §8): a NEW terminal transition without an emit must
 * fail the suite. From-disk, the ledger-references idiom — the processors'
 * terminal STATUS WRITES are counted by shape (data:{status:"X"} literals
 * and persist(...{status:"X"}) calls; type unions and where-clauses do not
 * match), the emit calls are counted alongside, and both are PINNED.
 *
 * The write⇔emit pairing is per-file arithmetic, not per-line adjacency:
 * a transition added without its emit moves one count and not the other.
 * Numbers move only with narration, like every pin in this repo.
 */

const WORKER_SRC = join(__dirname, "..");

type Expectation = {
	file: string;
	writes: RegExp;
	writeCount: number;
	emitCount: number;
};

const EXPECTATIONS: Expectation[] = [
	{
		// setup-catch ERROR, step-loop ERROR, CANCELED finalize, FINISHED —
		// plus #86 PR2's two: the QC boundary's QC_FAILED (emits
		// JOB_QC_FAILED) and the trigger-failure ERROR (emits JOB_ERROR; a
		// park that cannot arrange its own wake-up is an incident). The
		// AWAITING_QC persist is deliberately OUTSIDE the union: parking is
		// not an outcome, and it has no emit to pair with.
		file: "orchestrator/processor.ts",
		// Order-insensitive within the object literal (review-183 I4/M5b: a
		// write spelled data:{error, status:"ERROR"} escaped the status-first
		// regex). STILL blind to: a status carried in a variable, and writes
		// built by a helper outside these files — named limits, not claims.
		// `persistIf(` is the same funnel with an extra where-guard (review-322
		// C1: the post-park ERROR write also CASes on status) — the count stays
		// 6 because the write moved spelling, not existence.
		writes:
			/(data:\s*\{[^}]*status:\s*"(ERROR|FINISHED|CANCELED|QC_FAILED)"|persist(?:If)?\([^)]*\{[^}]*status:\s*"(ERROR|FINISHED|CANCELED|QC_FAILED)")/gs,
		writeCount: 6,
		emitCount: 6,
	},
	{
		// markError, stop-STOPPED, restart-RUNNING, setup-ERROR, step-loop
		// ERROR persist, finalize-RUNNING persist, finalize-catch ERROR.
		file: "orchestrator/live-processor.ts",
		writes:
			/(data:\s*\{[^}]*status:\s*"(ERROR|STOPPED|RUNNING)"|persist\((?:liveChannelId, )?(?:entries|untouched)[^;]*?status:\s*(?:"(ERROR|RUNNING|STOPPED)"|feeders\.length\s*\?\s*"STOPPING"\s*:\s*"STOPPED"))/gs,
		// : the provision's persist is fenced on the lease token and
		// carries the channel id in its closure — `persist(entries, {...})`,
		// no longer `persist(liveChannelId, entries, {...})`. Same eight
		// sites; the pattern accepts both shapes so a moved COUNT still means
		// a moved site.
		// 7→8 : feederStart's enqueue-failure path marks the
		// SESSION row ERROR ("Enqueue failed — the schedule row can be
		// re-armed") — a terminal state the operator sees on the feeder
		// panel; no product event, matching the manual create route's own
		// enqueue-failure handling.
		// 8→9 / 7→8 : the provision
		// entry's provider gate — a REVIVE whose encoding reads back UNKNOWN
		// (or TERMINAL but already stamped) lands the channel ERROR through the
		// same fenced write the setup/finalize failures use, and emits
		// CHANNEL_ERROR on the arm the reconciler did not already emit for.
		// The TERMINAL writes and their emit live in `live/provider-lifecycle.ts`
		// (its own row below); the restart path's UNKNOWN refusal and readback
		// failures ride the existing markError, so they move no count here.
		// 9→7 : restart and provision finalize
		// no longer dual-write RUNNING here. Both writes moved into the ONE
		// transaction in `live/provider-lifecycle.ts`; their two CHANNEL_RUNNING
		// emits remain at the call sites here and run only after that commit.
		// 7→8 (rows #288/#289 SC-01): a feeder session whose durable effect
		// claim is lost while binding is terminalised before enqueue. As with the
		// adjacent enqueue-failure path, the operator-visible session owns that
		// ERROR; it does not represent a channel lifecycle transition.
		// 8→9: restart failure now has its own generation + PROVISIONING CAS so a
		// concurrent STOP cannot be overwritten with ERROR. A successful CAS emits
		// the matching CHANNEL_ERROR; a lost CAS performs neither operation.
		// 9→11 / 9→11 (startup cancellation): untouched queued startup
		// persists STOPPED only when no feeder occupies the run; the STOPPING
		// arm returns before its emit. Cleanup after an attempted CREATE/START
		// emits only after provider/feeder confirmation and its fenced STOPPED
		// persist. Neither path emits after a lost persist fence. Count both
		// the literal STOPPED persist and the explicit untouched ternary,
		// which the earlier ERROR/RUNNING-only persist pattern could not see.
		writeCount: 11,
		emitCount: 11,
	},
	{
		//  (audit 5c3d97ca BLOCKER-1): the provider-lifecycle
		// reconciler's TERMINAL arm — ONE transition, dual-written (the run row
		// with its `providerTerminalAt` stamp, then the channel row with its
		// coordinates cleared), ONE CHANNEL_ERROR. The UNKNOWN arm writes
		// `providerUnknownSince` only — no status moves, nothing to notify;
		// the grace alert for a long UNKNOWN is the sweep's (an
		// `emitChannelEvent(` call in live-processor.ts, deliberately outside
		// this instrument's `emitChannel(` shape: it pairs with no write).
		// 2→4 writes : commitRunning adds the
		// exact run + channel RUNNING pair in one transaction. Its two success
		// emits deliberately stay in live-processor.ts after the transaction
		// returns. 1→2 emits : one call follows the
		// fresh run+channel transaction; the second follows a successful repair
		// of a legacy/crash-partial terminal run whose channel was still live.
		// CANCELED now shares the terminal writes as STOPPED + CHANNEL_STOPPED.
		// Count their `status` shorthand too; the dual-write/emit total is unchanged.
		file: "live/provider-lifecycle.ts",
		writes: /data:\s*\{[^}]*\n\s*status(?::\s*"(ERROR|RUNNING)"|,)/gs,
		writeCount: 4,
		emitCount: 2,
	},
	{
		// markTerminal's single write (STOPPED and ERROR share it; the emit
		// branches on ERROR — a clean stop is not an incident).
		//
		// 1→2/1→2 (review HIGH, audit 2026-08-29 CRITICAL-2's sibling): the
		// registry-miss stop gained a SECOND terminal write — an unverified
		// kill ladder now lands the row at ERROR keeping its pid, instead of
		// claiming STOPPED for a process it could not confirm dead — and it
		// emits FEEDER_ERROR like every other feeder ERROR. The pattern is a
		// UNION so the new site is counted rather than silently unpaired: the
		// shorthand `data: { status,` is markTerminal, the `status: "ERROR"`
		// literal is the reclaim.
		//
		// 2→3/2→3 : the cross-host takeover
		// REFUSAL — `refuseCrossHostTakeover` retires a stale session whose old
		// pid it cannot prove gone at ERROR (a SECOND `status: "ERROR"` literal,
		// pid kept) instead of spawning a second push, and emits FEEDER_ERROR
		// like every other feeder ERROR. Paired, so it joins the union.
		//
		// The two `status: "STOPPED"` literal writes in that same file stay
		// deliberately OUTSIDE the union, on the precedent this table already
		// sets for orchestrator/processor.ts's AWAITING_QC park: a clean stop
		// is not an outcome anyone must be told about, so it has no emit to
		// pair with. They are terminal writes with a documented reason not to
		// notify, not writes that lost their emit.
		file: "feeder/processor.ts",
		writes: /(data:\s*\{\s*\n?\s*status,|status:\s*"ERROR")/g,
		writeCount: 3,
		emitCount: 3,
	},
	{
		// #86 PR2 split markTerminal's single write in two — the gate path
		// (verdict rides the same transaction) and the plain path — both
		// spelling `status,` first IN PLACE so this regex keeps seeing them.
		// Emits: the VMAF_FINISHED/ERROR ternary + MARK_ONLY's JOB_QC_FAILED.
		file: "vmaf/processor.ts",
		writes: /data:\s*\{\s*\n?\s*status,/g,
		writeCount: 2,
		emitCount: 2,
	},
	{
		file: "vmaf/live-processor.ts",
		writes: /data:\s*\{\s*\n?\s*status,/g,
		writeCount: 1,
		emitCount: 1,
	},
	{
		//  (rewritten with review-190): row transitions now flow
		// through the rowTo helper, so the write COUNT is its call sites
		// — 4 FIRED (start CREATED|ERROR / start STOPPED / stop / slate),
		// 5 ERROR (channel-gone ×2, unparsable step log, no-encoding
		// restart, slate missing fields), 2 COMPLETED (start already-up,
		// stop nothing-running), 1 MISSED (grace). Emits concentrate in the
		// emitFired/emitMissed helpers + the cap's inline emit = 3 call
		// sites; the pairing is helper-mediated, not 1:1 — every FIRED path
		// calls emitFired, every MISSED/ERROR outcome calls emitMissed, and
		// COMPLETED deliberately does not notify (nothing happened that an
		// operator must act on; the row says so in its note).
		file: "scheduler/sweep.ts",
		writes: /rowTo\(row, "(FIRED|MISSED|ERROR|COMPLETED)"/g,
		// 12→13 : the slate whose window is already over at fire
		// time lands MISSED ("program start already passed") — and it emits,
		// via the same emitMissed as every other MISSED.
		// 13→15 : fireFeeder adds one FIRED (the enqueue claim)
		// and one ERROR (source failed validation) — both wired to the same
		// emitFired/emitMissed helpers as every sibling.
		// 15→14 : the STOPPED arm's no-encoding refusal
		// (rowTo ERROR + emitMissed) is GONE on purpose — a re-air needs no
		// prior encoding, it creates a fresh one; the arm frees the per-run
		// columns and enqueues provision instead.
		// 14→15 : the STOPPED arm now COMPILES the re-air's
		// step log before claiming, and a plan that does not compile lands
		// the row at ERROR ("channel plan does not compile — cannot re-air")
		// through the same rowTo + emitMissed pair as every sibling. (An
		// interim during review-284 — never a published commit — counted a
		// 16th "start manually" refusal; the CREATED/ERROR arm re-airs or
		// compiles those cells instead of refusing, so 15 stands.)
		// Emits 3→4 : fireDeadlines' inline
		// SCHEDULE_NOT_RUNNING_AT_DEADLINE — deliberately WRITE-free in the
		// row-transition sense (the deadline stamp is bookkeeping on a row
		// whose lifecycle state does not move), so writes stays 15.
		// 15→18 (row 240, the two-phase feeder switch): `commitSwitch` adds
		// one MISSED (a switch whose session is not READY at fire time —
		// "not staged", emitMissed) and one FIRED (the commit's claim,
		// emitFired); `redispatchStrandedStages` adds one ERROR (a stage
		// claim whose source no longer parses — the same refusal the fire
		// path makes, through rowTo; its emit is the fire path's when the row
		// reaches it, so this ERROR is deliberately silent like the stranded
		// dispatcher's own). Emits stay 4: every new transition rides the
		// existing emitFired/emitMissed helpers, not a new inline call.
		// 18→20 (#185): CREATED/ERROR replay and STOPPED re-air now refuse
		// an incompatible or unreadable profile before claiming the channel.
		// Both terminal writes emitMissed on CAS success. The START outbox
		// refusal uses the already-counted strandedRowTo CAS + emitMissed.
		// 20→18 (deployment profile retirement): remove the CREATED/ERROR
		// replay and STOPPED re-air profile-refusal rowTo(ERROR) sites.
		// Regular compile failures still use rowTo + emitMissed. The removed
		// START outbox refusal used strandedRowTo, outside this rowTo pattern.
		// Emits remain 4 because outcomes still use the existing emit helpers.
		writeCount: 18,
		emitCount: 4,
	},
	{
		// : the watch sweep's notified transitions — the
		// STABLE→SUBMITTED claim (WATCH_SUBMITTED after the submit lands)
		// and the three ERROR writes (instantiation refusal, pipeline
		// refusal, submit throw), each with its WATCH_ERROR. 4→5/4→5
		// (review-87b I-2 fold): the lost-claim reaper's ERROR write + its
		// WATCH_ERROR. The SEEN/SKIPPED/STABLE bookkeeping writes are
		// deliberately unpaired — sighting an object is not an event anyone
		// subscribes to. data-scoped: the backpressure COUNT's where-clause
		// and the per-key serialization probe both say state:"SUBMITTED" in
		// a WHERE and must not be counted as writes.
		file: "watch/sweep.ts",
		writes: /data:\s*\{[^}]*state:\s*"(SUBMITTED|ERROR)"/gs,
		writeCount: 5,
		emitCount: 5,
	},
	{
		// : the alert engine's two lifecycle writes — the open
		// create (openedAt) and the by-id resolve claim (resolvedAt) — each
		// with its edge emit (ALERT_OPENED / ALERT_RESOLVED).
		file: "alerts/engine.ts",
		writes: /data:\s*\{[^}]*(openedAt|resolvedAt)/gs,
		// 2→3/2→3 (review-83b C1 fold): the orphan resolver's CAS resolve
		// write + its ALERT_RESOLVED emit — the stranded-alert escape.
		writeCount: 3,
		emitCount: 3,
	},
	{
		/**
		 *  / review-351: the dead FEEDER START job's terminal write
		 * and its emit — the pair this instrument could not see for as long as
		 * it lived in `index.ts`.
		 *
		 * Nothing imports `index.ts` (it is the process entry point: importing
		 * it starts workers and opens Redis), and the coverage test below walks
		 * the source for emit CALLS, so a file with a terminal write and NO
		 * emit is invisible to both halves of this guard. That is precisely the
		 * shape the gap had: the session was landed ERROR with its forensic pid
		 * kept, and nobody was notified — on the most common trigger of the
		 * orphan-ffmpeg case (audit CRITICAL-2). Extracting the handler into a
		 * module is what brings it inside the population.
		 * The second pair is the exhausted manual STOP projection: its fenced
		 * RUNNING/STOPPING -> ERROR write emits CHANNEL_ERROR so a queue handoff
		 * that exhausts all retries is visible outside the failed-job log.
		 */
		file: "live/dead-job-outcome.ts",
		writes: /data:\s*\{[^}]*status:\s*"ERROR"/gs,
		writeCount: 2,
		emitCount: 2,
	},
	{
		// : the origin observer's own alert lifecycle — one open
		// create (openedAt) + one CAS resolve (resolvedAt), each with its
		// edge emit, mirroring alerts/engine.ts's discipline for the
		// DELIVERY-owned half of the partition.
		file: "live/origin-observer.ts",
		writes: /data:\s*\{[^}]*(openedAt|resolvedAt)/gs,
		writeCount: 2,
		emitCount: 2,
	},
	{
		// Audit 2026-08-29 CRITICAL-2: the orphan sweep is a SECOND writer of
		// the feeder's terminal ERROR — a row still claiming to PUSH after its
		// ffmpeg was reclaimed would be a lie, and the dead-job handler that
		// would normally write it died with its worker. So it carries the same
		// obligation as markTerminal: one terminal write, one FEEDER_ERROR.
		// The reclaim of an ALREADY-terminal row writes no status at all (the
		// run's own outcome stands) and correctly has nothing to pair with.
		file: "feeder/reconcile-orphans.ts",
		writes: /status:\s*"(ERROR|STOPPED)"/g,
		writeCount: 1,
		emitCount: 1,
	},
];

const EMIT_CALL = /emitEvent\?\.\(|emitChannel\(/g;

describe("every terminal transition emits a product event (ledger #88)", () => {
	for (const expectation of EXPECTATIONS) {
		it(`${expectation.file}: ${expectation.writeCount} terminal writes, ${expectation.emitCount} emits`, () => {
			const src = readFileSync(join(WORKER_SRC, expectation.file), "utf8");
			const writes = [...src.matchAll(expectation.writes)].length;
			const emits = [...src.matchAll(EMIT_CALL)].length;
			expect(
				{ writes, emits },
				`${expectation.file} — a moved count without narration here means a terminal path gained or lost its emit`,
			).toEqual({
				writes: expectation.writeCount,
				emits: expectation.emitCount,
			});
		});
	}

	it("the expectations cover every file that emits — from disk, not from itself", () => {
		// The first version asserted covered.size === 5 where covered was
		// built FROM the expectations — a tautology; review-183's M5 added a
		// whole decoy processor with a terminal write + emit and stayed green.
		// This walks the worker source and demands set equality.
		const found: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(join(WORKER_SRC, dir), {
				withFileTypes: true,
			})) {
				const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
				if (entry.isDirectory()) {
					walk(rel);
					continue;
				}
				if (!/\.ts$/.test(entry.name) || /\.test\.ts$/.test(entry.name)) {
					continue;
				}
				const src = readFileSync(join(WORKER_SRC, rel), "utf8");
				if (EMIT_CALL.test(src)) {
					EMIT_CALL.lastIndex = 0;
					found.push(rel);
				}
				EMIT_CALL.lastIndex = 0;
			}
		};
		walk(".");
		expect(found.sort()).toEqual(EXPECTATIONS.map((e) => e.file).sort());
	});
});
