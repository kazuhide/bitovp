import { QUEUE_NAMES } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { createFeederOrphanReconciler } from "./reconcile-orphans";

/**
 * Audit 2026-08-29 CRITICAL-2, boot half.
 *
 * A START job that dies outside the worker leaves its `-stream_loop -1` ffmpeg
 * reparented and pushing forever — the child does not go with the process that
 * spawned it. Nothing at startup ever looked at what the last incarnation left
 * behind, so the only remedy was an operator who knew to look at a pid column.
 *
 * The three gates below are all "do not kill what is not ours", and each has
 * its own arm here: the SQL filter (host), the queue discriminator (someone is
 * still supervising this push), and the command-line identity check (the
 * kernel recycles pids).
 */

const SESSION_ID = "00000000-0000-4000-8000-0000000000f1";
const CHANNEL_ID = "00000000-0000-4000-8000-0000000000bb";
const HOST = "worker-a";
const NOW = "2026-08-29T00:00:00.000Z";
const FEEDER_CMD = `ffmpeg -hide_banner -nostdin -re -stream_loop -1 -i /var/spool/${SESSION_ID}.mp4 -c copy -f flv rtmp://203.0.113.7/live/sk`;

type Row = Record<string, unknown>;

type WhereClause = {
	pid?: number | { not: null };
	processGoneAt?: null;
	OR?: { ownerHost: string | null }[];
	ownerHost?: string | null;
	id?: string;
	/**  (review-365 I-1): the owner token the write CASes on. */
	ownerId?: string | null;
	ownerGeneration?: number;
	publisherGeneration?: number;
};

function setup(
	opts: {
		rows?: Row[];
		/** BullMQ state of the row's START job; null = no such job. */
		jobState?: string | null;
		alive?: (pid: number) => boolean;
		command?: string | null;
		hostname?: string;
		queueName?: string;
	} = {},
) {
	const rows: Row[] = opts.rows ?? [
		{
			id: SESSION_ID,
			liveChannelId: CHANNEL_ID,
			status: "PUSHING",
			pid: 4242,
			ownerHost: HOST,
			processGoneAt: null,
			error: null,
			// : no lease. That is both the pre-column shape and the
			// shape a dead worker leaves once its lease ages out, so every
			// existing arm below keeps testing the population it was written
			// for.
			ownerLeaseAt: null,
			ownerId: null,
			ownerGeneration: 0,
		},
	];

	// Faithful to the query the reconciler issues: an unreclaimed pid, on a
	// row this host may act on. A fake that ignored the filter would report a
	// clean sweep over rows the real query never returns.
	const matches = (row: Row, where: WhereClause): boolean => {
		if (where.id !== undefined && row.id !== where.id) {
			return false;
		}
		if (typeof where.pid === "object") {
			if (where.pid.not === null && row.pid === null) {
				return false;
			}
		} else if (where.pid !== undefined && row.pid !== where.pid) {
			return false;
		}
		if ("processGoneAt" in where && row.processGoneAt !== where.processGoneAt) {
			return false;
		}
		if (where.OR && !where.OR.some((c) => row.ownerHost === c.ownerHost)) {
			return false;
		}
		if ("ownerHost" in where && row.ownerHost !== where.ownerHost) {
			return false;
		}
		//  (review-365 I-1) — the OWNER FENCE, tested by key PRESENCE.
		// Prisma reads a supplied `null` on a scalar as IS NULL and an ABSENT
		// key as "no filter", and those are the same JS value: a fake that
		// tested truthiness would report the fence holding while the real query
		// filtered on nothing, and the takeover-race arm would pass vacuously.
		if ("ownerId" in where && row.ownerId !== where.ownerId) {
			return false;
		}
		if (
			"ownerGeneration" in where &&
			row.ownerGeneration !== where.ownerGeneration
		) {
			return false;
		}
		if (
			"publisherGeneration" in where &&
			row.publisherGeneration !== where.publisherGeneration
		) {
			return false;
		}
		return true;
	};

	const findMany = vi.fn(async ({ where }: { where: WhereClause }) =>
		rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
	);
	const updateMany = vi.fn(
		async ({ where, data }: { where: WhereClause; data: Row }) => {
			let count = 0;
			for (const row of rows) {
				if (matches(row, where)) {
					Object.assign(row, data);
					count += 1;
				}
			}
			return { count };
		},
	);
	/**
	 * Rows #238 and #242: the schedule row a scheduled feed was armed from.
	 *
	 * It exists here BECAUSE the outcome writer is best-effort — without a stub
	 * its `prisma.liveSchedule` read throws, the catch swallows it, and every
	 * assertion about the schedule outcome would pass over a call that never
	 * happened (the same reason `processor.test.ts` carries one).
	 */
	const liveSchedule = { updateMany: vi.fn(async () => ({ count: 1 })) };
	const prisma = {
		feederSession: { findMany, updateMany },
		liveSchedule,
	} as unknown as AppPrismaClient;

	const getJob = vi.fn(async () =>
		opts.jobState === undefined || opts.jobState === null
			? undefined
			: { getState: async () => opts.jobState },
	);
	const queue = {
		name: opts.queueName ?? QUEUE_NAMES.feederManager,
		getJob,
	} as unknown as Pick<Queue, "getJob" | "name">;

	const alive = opts.alive ?? (() => true);
	const killPid = vi.fn((pid: number, signal: "SIGTERM" | "SIGKILL" | 0) => {
		if (signal === 0 && !alive(pid)) {
			throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
		}
	});
	const readProcessCommand = vi.fn(async () =>
		opts.command === undefined ? FEEDER_CMD : opts.command,
	);
	const emitEvent = vi.fn(async () => {});

	const reconcile = createFeederOrphanReconciler({
		prisma,
		queue,
		hostname: opts.hostname ?? HOST,
		killPid,
		readProcessCommand,
		sleep: async () => {},
		now: () => NOW,
		killGraceMs: 1,
		emitEvent,
	});
	return {
		reconcile,
		rows,
		findMany,
		updateMany,
		getJob,
		killPid,
		readProcessCommand,
		emitEvent,
		liveSchedule,
	};
}

describe("feeder orphan reconcile (boot + tick)", () => {
	it("kills this host's live, identity-matched orphan and records the proof", async () => {
		// The pid stays alive until SIGTERM lands — a verified ladder.
		let termed = false;
		const s = setup({
			jobState: "completed",
			alive: () => !termed,
		});
		s.killPid.mockImplementation((pid, signal) => {
			if (signal === 0 && termed) {
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			}
			if (signal === "SIGTERM") {
				termed = true;
			}
			expect(pid).toBe(4242);
		});
		await expect(s.reconcile()).resolves.toBe(1);
		expect(s.killPid.mock.calls.map((c) => c[1])).toContain("SIGTERM");
		const row = s.rows[0];
		// A row still claiming to PUSH after its ffmpeg was reclaimed would be
		// a lie about a process this sweep just proved gone.
		expect(row?.status).toBe("ERROR");
		expect(row?.pid).toBeNull();
		expect(row?.ownerHost).toBeNull();
		expect(row?.processGoneAt).toEqual(new Date(NOW));
		expect(row?.error).toContain("killed at worker start");
		// : a feeder ending in ERROR notifies, whichever writer
		// lands it.
		expect(s.emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "FEEDER_ERROR",
				feederSessionId: SESSION_ID,
				liveChannelId: CHANNEL_ID,
			}),
		);
	});

	it("releases the dead owner's PUBLISHER CLAIM in the same write as the proof", async () => {
		// The audit's row after the backfill: PUSHING, pid kept, claim held,
		// its owner dead. ESRCH is one of the three release proofs — the same
		// instant stamps processGoneAt and publisherReleasedAt, so the channel
		// is free the moment the process is proven gone, never before.
		const s = setup({
			rows: [
				{
					id: SESSION_ID,
					liveChannelId: CHANNEL_ID,
					status: "PUSHING",
					pid: 4242,
					ownerHost: HOST,
					processGoneAt: null,
					error: null,
					ownerLeaseAt: null,
					ownerId: null,
					ownerGeneration: 0,
					publisherClaimedAt: new Date("2026-08-28T00:00:00.000Z"),
					publisherReleasedAt: null,
					publisherGeneration: 1,
				},
			],
			jobState: "completed",
			alive: () => false,
		});
		await expect(s.reconcile()).resolves.toBe(1);
		const row = s.rows[0];
		expect(row?.processGoneAt).toEqual(new Date(NOW));
		expect(row?.publisherReleasedAt).toEqual(new Date(NOW));
		expect(row?.publisherClaimedAt).toEqual(
			new Date("2026-08-28T00:00:00.000Z"),
		);
	});

	it("cannot apply an old pid's exit proof to a respawn under the same owner and claim", async () => {
		let termSent = false;
		let s: ReturnType<typeof setup>;
		s = setup({
			jobState: "completed",
			rows: [
				{
					id: SESSION_ID,
					liveChannelId: CHANNEL_ID,
					status: "PUSHING",
					pid: 4242,
					ownerHost: HOST,
					processGoneAt: null,
					error: null,
					ownerLeaseAt: null,
					ownerId: "owner-a",
					ownerGeneration: 3,
					publisherClaimedAt: new Date("2026-08-28T00:00:00.000Z"),
					publisherReleasedAt: null,
					publisherGeneration: 7,
				},
			],
		});
		s.killPid.mockImplementation((_pid, signal) => {
			if (signal === "SIGTERM") {
				termSent = true;
				return;
			}
			if (signal === 0 && termSent) {
				// The still-running owner observed the old exit and respawned before
				// the reconciler persisted its proof. Restarts keep the owner/claim
				// generations, so the process tuple is the indispensable fence.
				Object.assign(s.rows[0] as Row, {
					pid: 5000,
					ownerHost: HOST,
					processGoneAt: null,
					status: "PUSHING",
				});
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			}
		});

		await expect(s.reconcile()).resolves.toBe(0);
		expect(s.rows[0]?.pid).toBe(5000);
		expect(s.rows[0]?.processGoneAt).toBeNull();
		expect(s.rows[0]?.publisherGeneration).toBe(7);
		expect(s.rows[0]?.publisherReleasedAt).toBeNull();
	});

	it("keeps the claim with the pid when the orphan survives SIGKILL — no proof, no release (LC-02)", async () => {
		const s = setup({
			rows: [
				{
					id: SESSION_ID,
					liveChannelId: CHANNEL_ID,
					status: "PUSHING",
					pid: 4242,
					ownerHost: HOST,
					processGoneAt: null,
					error: null,
					ownerLeaseAt: null,
					ownerId: null,
					ownerGeneration: 0,
					publisherClaimedAt: new Date("2026-08-28T00:00:00.000Z"),
					publisherReleasedAt: null,
					publisherGeneration: 1,
				},
			],
			jobState: "completed",
			alive: () => true,
		});
		await expect(s.reconcile()).resolves.toBe(0);
		expect(s.rows[0]?.pid).toBe(4242);
		expect(s.rows[0]?.publisherReleasedAt).toBeNull();
	});

	it("leaves a RECYCLED pid alone — the number is live, but the process is not ours", async () => {
		const s = setup({
			jobState: "completed",
			command: "/usr/sbin/nginx -g daemon off;",
		});
		await expect(s.reconcile()).resolves.toBe(1);
		// Not one signal: killing 4242 here would kill nginx.
		expect(s.killPid.mock.calls.filter((c) => c[1] !== 0)).toHaveLength(0);
		// The reuse is itself proof our ffmpeg exited (a pid IS the identity),
		// so the row stops claiming a process and becomes deletable.
		const row = s.rows[0];
		expect(row?.pid).toBeNull();
		expect(row?.processGoneAt).toEqual(new Date(NOW));
		expect(row?.error).toContain("unrelated process");
	});

	it("never signals a pid whose command line cannot be read", async () => {
		const s = setup({ jobState: "completed", command: null });
		await expect(s.reconcile()).resolves.toBe(0);
		expect(s.killPid.mock.calls.filter((c) => c[1] !== 0)).toHaveLength(0);
		const row = s.rows[0];
		// Untouched: no information is not proof, in either direction.
		expect(row?.pid).toBe(4242);
		expect(row?.processGoneAt).toBeNull();
		expect(row?.status).toBe("PUSHING");
	});

	it("leaves a push whose START job is still live alone (the queue is the discriminator, not the clock)", async () => {
		const s = setup({ jobState: "active" });
		await expect(s.reconcile()).resolves.toBe(0);
		expect(s.getJob).toHaveBeenCalledWith(SESSION_ID);
		expect(s.killPid).not.toHaveBeenCalled();
		expect(s.readProcessCommand).not.toHaveBeenCalled();
		expect(s.rows[0]?.pid).toBe(4242);
	});

	it("leaves an unrecognised job state alone — a state must be KNOWN dead", async () => {
		// BullMQ adding a live state (or a FlowProducer's waiting-children)
		// must not turn this sweep into a killer of live work.
		const s = setup({ jobState: "waiting-children" });
		await expect(s.reconcile()).resolves.toBe(0);
		expect(s.killPid).not.toHaveBeenCalled();
	});

	it("proves absence for a pid that is already gone, without sending a signal", async () => {
		const s = setup({ jobState: "failed", alive: () => false });
		await expect(s.reconcile()).resolves.toBe(1);
		expect(s.killPid.mock.calls).toEqual([[4242, 0]]);
		expect(s.readProcessCommand).not.toHaveBeenCalled();
		const row = s.rows[0];
		expect(row?.processGoneAt).toEqual(new Date(NOW));
		expect(row?.error).toContain("already gone");
	});

	it("keeps the pid when an orphan survives SIGKILL (no proof, no stamp)", async () => {
		const s = setup({ jobState: "completed", alive: () => true });
		await expect(s.reconcile()).resolves.toBe(0);
		// Two existence probes before SIGTERM: this sweep's own (which
		// separates "already gone" from "alive, check identity") and the
		// shared ladder's, which stays self-contained because the operator
		// stop path calls it without a preceding probe.
		expect(s.killPid.mock.calls.map((c) => c[1])).toEqual([
			0,
			0,
			"SIGTERM",
			0,
			"SIGKILL",
			0,
		]);
		expect(s.rows[0]?.pid).toBe(4242);
		expect(s.rows[0]?.processGoneAt).toBeNull();
	});

	it("only reads rows this host may act on, and never a row already proven gone", async () => {
		const s = setup({
			jobState: "completed",
			alive: () => false,
			rows: [
				{
					id: SESSION_ID,
					liveChannelId: CHANNEL_ID,
					status: "ERROR",
					pid: 4242,
					ownerHost: HOST,
					processGoneAt: null,
					error: null,
				},
				{
					id: "00000000-0000-4000-8000-0000000000f2",
					liveChannelId: CHANNEL_ID,
					status: "ERROR",
					pid: 7777,
					// Another host's pid is a bare number here.
					ownerHost: "worker-b",
					processGoneAt: null,
					error: null,
				},
				{
					id: "00000000-0000-4000-8000-0000000000f3",
					liveChannelId: CHANNEL_ID,
					status: "ERROR",
					pid: 8888,
					ownerHost: HOST,
					// Already reclaimed by an operator stop.
					processGoneAt: new Date("2026-08-28T00:00:00.000Z"),
					error: null,
				},
				{
					id: "00000000-0000-4000-8000-0000000000f4",
					liveChannelId: CHANNEL_ID,
					status: "STOPPED",
					// Ordinary terminal shape: no process reference at all.
					pid: null,
					ownerHost: null,
					processGoneAt: null,
					error: null,
				},
			],
		});
		await expect(s.reconcile()).resolves.toBe(1);
		expect(s.killPid.mock.calls.map((c) => c[0])).toEqual([4242]);
		expect(s.rows[1]?.pid).toBe(7777);
		expect(s.rows[2]?.pid).toBe(8888);
	});

	it("adopts pre-column rows (null ownerHost) — they were written under the single-worker assumption", async () => {
		const s = setup({
			jobState: "completed",
			alive: () => false,
			rows: [
				{
					id: SESSION_ID,
					liveChannelId: CHANNEL_ID,
					status: "ERROR",
					pid: 4242,
					ownerHost: null,
					processGoneAt: null,
					error: "Worker lost the session",
				},
			],
		});
		await expect(s.reconcile()).resolves.toBe(1);
		expect(s.rows[0]?.processGoneAt).toEqual(new Date(NOW));
		// The original failure text is kept, the note appended once.
		expect(s.rows[0]?.error).toContain("Worker lost the session");
	});

	it("skips a row an operator stop reclaimed mid-sweep (guarded write matches zero rows)", async () => {
		// Review LOW-1: the sweep's write is optimistic — `processGoneAt: null`
		// in its WHERE — because an operator stop can reach the same row from
		// the other side. Here that stop lands while this sweep is probing;
		// ours must match nothing, count nothing, and leave the winner's stamp
		// and note untouched.
		const OTHER_AT = new Date("2026-08-28T12:00:00.000Z");
		const rows: Row[] = [
			{
				id: SESSION_ID,
				liveChannelId: CHANNEL_ID,
				status: "ERROR",
				pid: 4242,
				ownerHost: HOST,
				processGoneAt: null,
				error: null,
			},
		];
		const s = setup({
			jobState: "completed",
			rows,
			alive: () => {
				Object.assign(rows[0] as Row, {
					pid: null,
					ownerHost: null,
					processGoneAt: OTHER_AT,
					error: "the operator stop got there first",
				});
				return false;
			},
		});
		await expect(s.reconcile()).resolves.toBe(0);
		expect(rows[0]?.processGoneAt).toEqual(OTHER_AT);
		expect(rows[0]?.error).toBe("the operator stop got there first");
		expect(s.emitEvent).not.toHaveBeenCalled();
	});

	it("refuses to run against the wrong queue (it would answer 'no job' for every row)", () => {
		expect(() => setup({ queueName: "vmaf-runner" }).reconcile).toThrow(
			/needs the feeder-manager queue/,
		);
	});
});

/**
 * : the lease gate this sweep gained, and the schedule row it was not
 * closing.
 */
describe("feeder orphan reconcile — owner lease (row #242)", () => {
	it("leaves a session alone while a FRESH lease says someone is supervising it", async () => {
		// The shape a TAKEOVER leaves on this host: the old start job is dead
		// (`completed`/`failed` — gate 2 passes), the pid is alive and its
		// command line IS this session's ffmpeg (gate 3 passes), and the sweep
		// would therefore SIGKILL it. The only thing that says "a worker owns
		// this push" is the lease — the resumed session has no job of its own.
		const s = setup({
			jobState: "completed",
			rows: [
				{
					id: SESSION_ID,
					liveChannelId: CHANNEL_ID,
					status: "PUSHING",
					pid: 4242,
					ownerHost: HOST,
					processGoneAt: null,
					error: null,
					ownerLeaseAt: new Date(NOW),
					ownerId: null,
					ownerGeneration: 0,
				},
			],
		});
		await expect(s.reconcile()).resolves.toBe(0);
		expect(s.killPid).not.toHaveBeenCalled();
		expect(s.rows[0]?.status).toBe("PUSHING");
		expect(s.rows[0]?.pid).toBe(4242);
	});

	it("reclaims the same row once that lease goes stale", async () => {
		// The control arm, read rather than assumed: the ONLY difference from
		// the test above is the lease's age. A gate that skipped every row with
		// a non-null lease would pass the first test and fail this one.
		let termed = false;
		const s = setup({
			jobState: "completed",
			alive: () => !termed,
			rows: [
				{
					id: SESSION_ID,
					liveChannelId: CHANNEL_ID,
					status: "PUSHING",
					pid: 4242,
					ownerHost: HOST,
					processGoneAt: null,
					error: null,
					ownerLeaseAt: new Date(Date.parse(NOW) - 10 * 60_000),
					ownerId: null,
					ownerGeneration: 0,
				},
			],
		});
		s.killPid.mockImplementation((pid, signal) => {
			if (signal === 0 && termed) {
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			}
			if (signal === "SIGTERM") {
				termed = true;
			}
			expect(pid).toBe(4242);
		});
		await expect(s.reconcile()).resolves.toBe(1);
		expect(s.rows[0]?.status).toBe("ERROR");
	});

	it("closes the schedule row that armed a reclaimed session (FAILED, with proof)", async () => {
		// Before this the sweep was the one terminal-ERROR writer that left the
		// ledger reading FIRED and green — a scheduled feed whose worker was
		// killed looked delivered. FAILED rather than the dead-job handler's
		// UNKNOWN, because this path verified the pid gone before it wrote
		// anything: the push IS over.
		const s = setup({ jobState: "completed", alive: () => false });
		await expect(s.reconcile()).resolves.toBe(1);
		const write = (
			s.liveSchedule.updateMany.mock.calls as unknown as {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}[][]
		)
			.at(-1)
			?.at(0);
		expect(write?.where).toMatchObject({ feederSessionId: SESSION_ID });
		expect(write?.data.outcome).toBe("FAILED");
		expect(String(write?.data.outcomeNote)).toContain("already gone");
	});

	it("writes NO schedule outcome for a row that was already terminal", async () => {
		// The reclaim of an already-terminal row records process proof and
		// nothing else — its own run already wrote whatever outcome it had, and
		// FAILED is sticky, so a second write here would only restamp it.
		const s = setup({
			jobState: "completed",
			alive: () => false,
			rows: [
				{
					id: SESSION_ID,
					liveChannelId: CHANNEL_ID,
					status: "ERROR",
					pid: 4242,
					ownerHost: HOST,
					processGoneAt: null,
					error: "the run failed",
					ownerLeaseAt: null,
					ownerId: null,
					ownerGeneration: 0,
				},
			],
		});
		await expect(s.reconcile()).resolves.toBe(1);
		expect(s.liveSchedule.updateMany).not.toHaveBeenCalled();
		expect(s.emitEvent).not.toHaveBeenCalled();
	});

	/**
	 * review-365 I-1: the takeover race this sweep could lose.
	 *
	 * Both sides are legal at once. Host A restarts after its worker died; its
	 * stalled START job is re-run, `start`'s claim CAS fails (the row is
	 * PUSHING, not CREATED) and the job COMPLETES — which is in `DEAD_STATES`,
	 * so gate 2 stops protecting the row at the same moment the lease goes
	 * stale and host B becomes free to resume it. B's claim is CROSS-HOST, so
	 * it stamps no `processGoneAt`: the old `where { id, processGoneAt: null }`
	 * still matched B's freshly resumed row.
	 *
	 * The fake reproduces the interleaving where it actually happens — INSIDE
	 * the kill ladder, between this pass's read and its write.
	 */
	it("does not write over a session that was CLAIMED while its ladder ran", async () => {
		let termed = false;
		const s = setup({
			jobState: "completed",
			alive: () => !termed,
			rows: [
				{
					id: SESSION_ID,
					liveChannelId: CHANNEL_ID,
					status: "PUSHING",
					pid: 4242,
					ownerHost: HOST,
					processGoneAt: null,
					error: null,
					ownerLeaseAt: new Date(Date.parse(NOW) - 10 * 60_000),
					ownerId: "worker-a/999/deadbeef",
					ownerGeneration: 3,
				},
			],
		});
		s.killPid.mockImplementation((pid, signal) => {
			if (signal === 0 && termed) {
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			}
			if (signal === "SIGTERM") {
				termed = true;
				// Worker B on another host wins the session right here: a new
				// owner, a bumped generation, DOWNLOADING again — and NO
				// `processGoneAt`, because B cannot prove anything about a pid
				// on this host.
				const row = s.rows[0];
				if (row) {
					row.ownerId = "worker-b/200/bbbbbbbb";
					row.ownerGeneration = 4;
					row.status = "DOWNLOADING";
					row.ownerLeaseAt = new Date(NOW);
				}
			}
			expect(pid).toBe(4242);
		});

		await expect(s.reconcile()).resolves.toBe(0);
		const row = s.rows[0];
		// B's row survives intact: no ERROR, no released pid, no proof stamp.
		expect(row?.status).toBe("DOWNLOADING");
		expect(row?.ownerId).toBe("worker-b/200/bbbbbbbb");
		expect(row?.processGoneAt).toBeNull();
		expect(row?.pid).toBe(4242);
		// And none of the terminal consequences fire for a row we did not win.
		expect(s.emitEvent).not.toHaveBeenCalled();
		expect(s.liveSchedule.updateMany).not.toHaveBeenCalled();
	});
});
