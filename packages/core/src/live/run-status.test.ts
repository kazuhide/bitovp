import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIVE_CHANNEL_STATUS_VALUES } from "./next-action";
import {
	deriveLiveChannelStatus,
	isLiveRunStatus,
	isStaleGeneration,
	LIVE_RUN_LIVE_STATUSES,
} from "./run-status";

describe("run status derivation (ledger #108 §2)", () => {
	it("a channel that never ran derives IDLE — a value OUTSIDE the run enum", () => {
		expect(deriveLiveChannelStatus(null)).toBe("IDLE");
		expect(
			(LIVE_CHANNEL_STATUS_VALUES as readonly string[]).includes("IDLE"),
		).toBe(false);
	});

	it("otherwise the channel reports its latest run's state, one for one", () => {
		for (const status of LIVE_CHANNEL_STATUS_VALUES) {
			expect(deriveLiveChannelStatus(status)).toBe(status);
		}
	});

	it("the live set is exactly the enum minus the terminals", () => {
		const terminals = LIVE_CHANNEL_STATUS_VALUES.filter(
			(s) => !isLiveRunStatus(s),
		);
		expect(terminals).toEqual(["STOPPED", "ERROR"]);
		expect(LIVE_RUN_LIVE_STATUSES).toEqual([
			"CREATED",
			"PROVISIONING",
			"RUNNING",
			"STOPPING",
		]);
	});

	it("the migration's partial-index WHERE lists the SAME live set, byte for byte", () => {
		// The DB invariant (at most one non-terminal run per channel, ledger
		// #48) is only as good as the agreement between this constant and the
		// index predicate — so the test reads the MIGRATION and derives the
		// set from its SQL rather than trusting the comment.
		const sql = readFileSync(
			join(
				__dirname,
				"../../../db/prisma/migrations/20260817024758_live_channel_runs/migration.sql",
			),
			"utf8",
		);
		const match = sql.match(
			/"LiveChannelRun_one_live_per_channel"[\s\S]*?WHERE "status" IN \(([^)]+)\)/,
		);
		if (!match?.[1]) {
			throw new Error("partial index predicate not found in the migration");
		}
		const indexSet = match[1].split(",").map((v) => v.trim().replace(/'/g, ""));
		expect(indexSet).toEqual([...LIVE_RUN_LIVE_STATUSES]);
	});

	it("the anchor migration FLOORS every null lastHeartbeatAt — a backfilled run must not wake up already-stale (review-109pr1 catch #2)", () => {
		// #240 backfilled run #1 with createdAt = the CHANNEL's creation date
		// (right for the sort key); the anchor rule reads createdAt when
		// lastHeartbeatAt is null. Composed, a RUNNING backfilled run with an
		// empty window would CRIT on the first sweep after deploy. The
		// migration's floor is the guard — pinned here the same way the
		// partial-index predicate is: by reading the SQL.
		const sql = readFileSync(
			join(
				__dirname,
				"../../../db/prisma/migrations/20260817040152_run_last_heartbeat_at/migration.sql",
			),
			"utf8",
		);
		expect(sql).toMatch(
			/UPDATE "LiveChannelRun"\s+SET "lastHeartbeatAt" = now\(\)\s+WHERE "lastHeartbeatAt" IS NULL/,
		);
	});

	it("the anchor's write capability is pinned at the API, not the token — call-shaped, reader-proof (review-109pr1 rounds 5-6)", () => {
		// Round 5's mention-based scan answered the right question but would
		// FALSE-POSITIVE on R5's readers: `where:`/`orderBy:` values, and a
		// destructure `const { lastHeartbeatAt } = run` — grep-identical to
		// the shorthand write. The deadline fix (allow-listing reader files)
		// would silently re-open the hole. So the capability moved to an API:
		// mirror builds its update by EXPLICIT pick (a smuggled field
		// cannot reach prisma), and recordHeartbeat is the anchor's only
		// door. The pins are FUNCTION-CALL shaped — no read produces them.
		const roots = [
			join(__dirname, "../../../../apps/worker/src"),
			join(__dirname, "../../../../apps/web/src"),
		];
		const doorCallers: string[] = [];
		const directWriters: string[] = [];
		const visit = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					visit(full);
				} else if (
					/\.tsx?$/.test(entry.name) &&
					!/\.test\.tsx?$/.test(entry.name)
				) {
					const cleaned = readFileSync(full, "utf8")
						.replace(/\/\*[\s\S]*?\*\//g, "")
						.replace(/\/\/[^\n]*/g, "");
					const rel = full.split("/apps/")[1] ?? full;
					// Round 7: the door is a separate FACTORY — a RunMirror
					// physically lacks recordHeartbeat, so destructure/alias/
					// bracket on the mirror are TYPE errors (tsc holds the
					// capability). The residual entry is importing the factory,
					// so this pin watches TOKEN PRESENCE — you cannot import
					// without naming it; a dynamically-built name is the
					// accepted residual, stated as ever.
					if (/createHeartbeatDoor/.test(cleaned)) {
						doorCallers.push(rel);
					}
					// Direct run WRITES: LITERAL dot-calls only — an alias
					// (`const t = prisma.liveChannelRun; t.update(...)`) escapes
					// this grep, measured by the reviewer. The structural fix
					// (deps.prisma typed Omit<'liveChannelRun'> outside the
					// mirror) is deferred with its cost stated in ;
					// until then this claims exactly what it delivers: no
					// literal direct caller. PR3 landed its promised named
					// path: the actions route's start transaction creates and
					// revives run rows — the SECOND allowed writer, exactly as
					// this comment predicted before it existed.
					if (/liveChannelRun\.(update|updateMany|create)\(/.test(cleaned)) {
						directWriters.push(rel);
					}
				}
			}
		};
		for (const root of roots) {
			visit(root);
		}
		expect(doorCallers.sort()).toEqual([
			"worker/src/orchestrator/live-processor.ts",
			"worker/src/orchestrator/run-mirror.ts",
		]);
		expect(directWriters.sort()).toEqual([
			"web/src/app/api/live-channels/[id]/actions/route.ts",
			// : the reset's reconcile stamps `encoderStoppedConfirmedFor`
			// on a run the provider was seen to have stopped — a CAS on that one
			// NULL column, never lastHeartbeatAt, the anchor this pin protects.
			"web/src/lib/server/reset.ts",
			// : the alert engine performs a same-value epoch update
			// inside its transaction solely to validate and lock the exact poll
			// token before alert transitions. It cannot move provider evidence or
			// lastHeartbeatAt; the heartbeat door remains their only capability.
			"worker/src/alerts/engine.ts",
			// : the SEVENTH named writer — the feeder records the
			// media attributes the encoder bound to for this run, so a later
			// switch can be refused before it makes the encoder drop the
			// ingest. It writes `ingestMedia` ONLY and never lastHeartbeatAt,
			// the anchor this pin protects, and it writes it exactly once per
			// run (CAS on a NULL column), which is why it cannot ride the
			// mirror: the mirror targets the channel's LATEST run with an
			// unconditional pick, and this write must name ONE run and land
			// only while that run has no reference yet.
			"worker/src/feeder/processor.ts",
			// : the SIXTH named writer — the origin observer
			// persists its per-run cursor (originObservation ONLY, never
			// lastHeartbeatAt, the anchor this pin protects; the cursor
			// lives on the RUN by design — §4's re-air boundary).
			"worker/src/live/origin-observer.ts",
			// : the provider-lifecycle door is the only writer of the
			// exact provider observation, terminal stamp and heartbeat poll epoch.
			// Every update is fenced on run id + encoding id (and epoch for a
			// sweep); it can terminalise status/error/endedAt but never writes
			// lastHeartbeatAt, whose separate capability remains pinned above.
			"worker/src/live/provider-lifecycle.ts",
			// : the stranded-run retirement — the THIRD named
			// writer. It writes status/error/endedAt on dead-job evidence and
			// never touches lastHeartbeatAt, the anchor this pin protects; a
			// run it retires has no live heartbeat writer by construction
			// (that writer's death is the trigger).
			"worker/src/live/reconcile-stranded-runs.ts",
			// The per-run heartbeat SUMMARY writer (2026-09-02, 7-day retention):
			// writes `heartbeatSummary` + `heartbeatSummaryAt` ONLY, as a CAS on
			// run id + the endedAt it read + `heartbeatSummaryAt IS NULL`, and
			// never lastHeartbeatAt — it READS the anchor to tell "rows pruned"
			// from "never polled".
			"worker/src/live/run-heartbeat-summary.ts",
			// A confirmed manual STOP binds the provider-terminal word and its
			// timestamp to the exact claimed run before resolving older ambiguous
			// effects. This writer is CAS-scoped by run id + channel id + encoding
			// id and never touches lastHeartbeatAt.
			"worker/src/orchestrator/live-processor.ts",
			"worker/src/orchestrator/run-mirror.ts",
			//  / review-284 N2: the FOURTH named writer — the
			// scheduler sweep's claimWithRun creates/revives run rows INSIDE
			// the channel-claim transaction (the same tx-atomicity reason the
			// actions route is on this list: a run write that fails must roll
			// the claim back, which a mirror call outside the tx cannot do).
			// It writes id/seq/status/outputPrefix/error/endedAt and never
			// lastHeartbeatAt, the anchor this pin protects.
			//  PR1: the FIFTH named writer — the startup sampler
			// mirrors queueSeconds onto the run row after the success upsert.
			// It writes queueSeconds ONLY and never lastHeartbeatAt, the
			// anchor this pin protects; best-effort (its failure never breaks
			// the RUNNING transition, pinned in startup-sample.test.ts).
			"worker/src/orchestrator/startup-sample.ts",
			"worker/src/scheduler/sweep.ts",
			// Organization deactivation refuses an unstarted run without changing heartbeat anchors.
			"worker/src/tenant/admission.ts",
		]);
	});
});

/**
 *  — the ONE definition of "this row belongs to a different airing",
 * shared by the sweep's fire paths and the arm routes that decide what to
 * write. Two of the four cases are false for reasons that are not "same
 * generation", and both matter more than the true case.
 */
describe("isStaleGeneration (row #241)", () => {
	const RUN_1 = "run-1";
	const RUN_2 = "run-2";

	it("a row armed for another run IS stale", () => {
		expect(isStaleGeneration(RUN_1, RUN_2)).toBe(true);
	});

	it("a row armed for the current run is not", () => {
		expect(isStaleGeneration(RUN_1, RUN_1)).toBe(false);
	});

	it("an UNBOUND row is never stale — it binds lazily to whatever is current", () => {
		// Creation-time rows, and rows armed on a channel that has never
		// aired. Nailing them earlier would make a re-aired channel refuse its
		// own programme's stop, slate and feeder rows.
		expect(isStaleGeneration(null, RUN_2)).toBe(false);
		expect(isStaleGeneration(null, null)).toBe(false);
	});

	it("no current run FAILS OPEN — missing evidence is not evidence of a mismatch", () => {
		// Refusing a STOP because the run rows are gone is how an encoding
		// bills forever.
		expect(isStaleGeneration(RUN_1, null)).toBe(false);
	});
});
