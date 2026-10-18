import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import {
	CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
	recordScheduleOutcomeBestEffort as recordScheduleOutcomeBestEffortImpl,
	recordScheduleOutcome as recordScheduleOutcomeImpl,
	type ScheduleOutcome,
	type ScheduleOutcomeEvidenceKind,
	transitionScheduleToStale,
} from "./schedule-outcome";

/**
 *  — the precedence between the four writers of `outcome`.
 *
 * These are BEHAVIOURAL against a fake that actually applies the WHERE, not
 * assertions about the argument object: the rule lives in the WHERE clause, so
 * a test that only inspected the call would pass on a WHERE that matches
 * everything. The fake below is the smallest thing that can tell those apart.
 */

type Row = {
	id: string;
	liveChannelId: string;
	liveChannelRunId?: string | null;
	action: string;
	status: string;
	feederSessionId: string | null;
	outcome: ScheduleOutcome;
	outcomeAt: Date | null;
	outcomeNote: string | null;
	note?: string | null;
	outcomeEvidenceVersion?: number | null;
	outcomeEvidenceKind?: string | null;
	outcomeEvidenceAt?: Date | null;
};

const ROW: Row = {
	id: "sched-1",
	liveChannelId: "chan-1",
	action: "SLATE_IN",
	status: "FIRED",
	feederSessionId: null,
	outcome: "PENDING",
	outcomeAt: null,
	outcomeNote: null,
};

function fakePrisma(rows: Row[]) {
	const updateMany = vi.fn(
		async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Partial<Row>;
		}) => {
			const hits = rows.filter((row) => {
				for (const [key, want] of Object.entries(where)) {
					if (typeof want === "object" && want !== null && "in" in want) {
						const allowed = (want as { in: unknown[] }).in;
						if (
							!allowed.includes(
								(row as unknown as Record<string, unknown>)[key],
							)
						) {
							return false;
						}
						continue;
					}
					if ((row as unknown as Record<string, unknown>)[key] !== want) {
						return false;
					}
				}
				return true;
			});
			for (const hit of hits) {
				Object.assign(hit, data);
			}
			return { count: hits.length };
		},
	);
	return {
		prisma: { liveSchedule: { updateMany } } as unknown as AppPrismaClient,
		updateMany,
	};
}

const AT = new Date("2026-08-29T12:00:00.000Z");

function defaultEvidenceFor(
	outcome: Exclude<ScheduleOutcome, "PENDING">,
): ScheduleOutcomeEvidenceKind {
	switch (outcome) {
		case "PROCESS_PUSHING":
			return "FEEDER_PROCESS_PUSHING";
		case "INGEST_CONNECTED":
			return "HEARTBEAT_INGEST_CONNECTED";
		case "SLATE_ARMED":
			return "SLATE_ARMED";
		case "DELIVERED":
			return "PROVIDER_RUNNING";
		case "FAILED":
			return "EFFECT_FAILED";
		case "UNKNOWN":
			return "JOB_TERMINAL_UNKNOWN";
	}
}

function recordScheduleOutcome(
	prisma: AppPrismaClient,
	target: Parameters<typeof recordScheduleOutcomeImpl>[1],
	outcome: Exclude<ScheduleOutcome, "PENDING">,
	note: string | null,
	at: Date,
	evidenceKind = defaultEvidenceFor(outcome),
) {
	return recordScheduleOutcomeImpl(
		prisma,
		target,
		outcome,
		note,
		at,
		evidenceKind,
	);
}

function recordScheduleOutcomeBestEffort(
	prisma: AppPrismaClient,
	target: Parameters<typeof recordScheduleOutcomeBestEffortImpl>[1],
	outcome: Exclude<ScheduleOutcome, "PENDING">,
	note: string | null,
	at: Date,
) {
	return recordScheduleOutcomeBestEffortImpl(
		prisma,
		target,
		outcome,
		note,
		at,
		defaultEvidenceFor(outcome),
	);
}

describe("recordScheduleOutcome precedence (ledger #238)", () => {
	it("canceled START fails only its exact run's pending FIRED START", async () => {
		const current = { ...ROW, action: "START", liveChannelRunId: "run-2" };
		const rows: Row[] = [
			{ ...current },
			{ ...current, liveChannelRunId: "run-1" },
			{ ...current, liveChannelRunId: null },
			{ ...current, outcome: "DELIVERED" },
			{ ...current, outcome: "UNKNOWN" },
			{ ...current, action: "STOP" },
			{ ...current, status: "SCHEDULED" },
			{ ...current, liveChannelId: "other-channel" },
		];
		const { prisma } = fakePrisma(rows);
		await expect(
			recordScheduleOutcome(
				prisma,
				{
					canceledChannelStart: {
						liveChannelId: "chan-1",
						liveChannelRunId: "run-2",
					},
				},
				"FAILED",
				"startup canceled",
				AT,
			),
		).resolves.toBe(1);
		expect(rows.map((row) => row.outcome)).toEqual([
			"FAILED",
			"PENDING",
			"PENDING",
			"DELIVERED",
			"UNKNOWN",
			"PENDING",
			"PENDING",
			"PENDING",
		]);
	});

	it("refuses a non-failure outcome through the canceled START target", async () => {
		const { prisma, updateMany } = fakePrisma([]);
		await expect(
			recordScheduleOutcome(
				prisma,
				{
					canceledChannelStart: {
						liveChannelId: "chan-1",
						liveChannelRunId: "run-2",
					},
				},
				"DELIVERED",
				null,
				AT,
			),
		).rejects.toThrow("can only record FAILED");
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("writes the current evidence version, kind and timestamp with the outcome", async () => {
		const rows = [{ ...ROW }];
		const { prisma } = fakePrisma(rows);
		await expect(
			recordScheduleOutcome(
				prisma,
				{ scheduleId: "sched-1" },
				"DELIVERED",
				"provider running",
				AT,
				"PROVIDER_RUNNING",
			),
		).resolves.toBe(1);
		expect(rows[0]).toMatchObject({
			outcomeEvidenceVersion: CURRENT_SCHEDULE_OUTCOME_EVIDENCE_VERSION,
			outcomeEvidenceKind: "PROVIDER_RUNNING",
			outcomeEvidenceAt: AT,
		});
	});

	it("moves status, outcome and stale evidence in one guarded update", async () => {
		const rows = [{ ...ROW, status: "ARMED" }];
		const { prisma, updateMany } = fakePrisma(rows);
		await expect(
			transitionScheduleToStale(prisma, {
				scheduleId: "sched-1",
				note: "run changed",
				at: AT,
			}),
		).resolves.toBe(true);
		expect(updateMany).toHaveBeenCalledTimes(1);
		expect(rows[0]).toMatchObject({
			status: "SKIPPED_STALE_GENERATION",
			outcome: "FAILED",
			note: "run changed",
			outcomeNote: "run changed",
			outcomeEvidenceKind: "STALE_GENERATION_REFUSAL",
		});
	});

	it("a channel-level stale STOP fallback never retires a future ARMED stop", async () => {
		const rows = [
			{ ...ROW, id: "fired-stop", action: "STOP", status: "FIRED" },
			{ ...ROW, id: "future-stop", action: "STOP", status: "ARMED" },
		];
		const { prisma } = fakePrisma(rows);
		await expect(
			transitionScheduleToStale(prisma, {
				channelStop: "chan-1",
				note: "run changed",
				at: AT,
			}),
		).resolves.toBe(true);
		expect(rows[0]).toMatchObject({
			status: "SKIPPED_STALE_GENERATION",
			outcome: "FAILED",
		});
		expect(rows[1]).toMatchObject({ status: "ARMED", outcome: "PENDING" });
	});
	it("writes DELIVERED over PENDING", async () => {
		const rows = [{ ...ROW }];
		const { prisma } = fakePrisma(rows);
		await expect(
			recordScheduleOutcome(
				prisma,
				{ scheduleId: "sched-1" },
				"DELIVERED",
				"pushing",
				AT,
			),
		).resolves.toBe(1);
		expect(rows).toEqual([
			expect.objectContaining({
				outcome: "DELIVERED",
				outcomeNote: "pushing",
				outcomeAt: AT,
			}),
		]);
	});

	it("FAILED overwrites a DELIVERED written earlier — a feed that died is not delivered", async () => {
		const rows = [{ ...ROW, outcome: "DELIVERED" as ScheduleOutcome }];
		const { prisma } = fakePrisma(rows);
		await expect(
			recordScheduleOutcome(
				prisma,
				{ scheduleId: "sched-1" },
				"FAILED",
				"ffmpeg exhausted its restarts",
				AT,
			),
		).resolves.toBe(1);
		expect(rows.map((r) => r.outcome)).toEqual(["FAILED"]);
	});

	it("DELIVERED NEVER overwrites FAILED — the precedence the dead-job handler depends on", async () => {
		/**
		 * The ordering hazard this exists for: the out-of-process dead-job
		 * handler and the in-process session writer race, and a restarted push
		 * calls the DELIVERED writer again. Without this direction a failed
		 * airing would silently go back to green.
		 */
		const rows = [
			{
				...ROW,
				outcome: "FAILED" as ScheduleOutcome,
				outcomeNote: "the source could not be fetched",
			},
		];
		const { prisma } = fakePrisma(rows);
		await expect(
			recordScheduleOutcome(
				prisma,
				{ scheduleId: "sched-1" },
				"DELIVERED",
				"pushing",
				AT,
			),
		).resolves.toBe(0);
		expect(rows).toEqual([
			expect.objectContaining({
				outcome: "FAILED",
				outcomeNote: "the source could not be fetched",
			}),
		]);
	});

	it("a second FAILED keeps the FIRST reason — the retry ladder's last message is the least informative", async () => {
		const rows = [
			{
				...ROW,
				outcome: "FAILED" as ScheduleOutcome,
				outcomeNote: "the source could not be fetched",
			},
		];
		const { prisma } = fakePrisma(rows);
		await expect(
			recordScheduleOutcome(
				prisma,
				{ scheduleId: "sched-1" },
				"FAILED",
				"scheduled feeder job died: attempt 5",
				AT,
			),
		).resolves.toBe(0);
		expect(rows.map((r) => r.outcomeNote)).toEqual([
			"the source could not be fetched",
		]);
	});

	it("UNKNOWN may only replace PENDING — it never downgrades an answer we hold", async () => {
		for (const held of ["DELIVERED", "FAILED"] as const) {
			const rows = [{ ...ROW, outcome: held as ScheduleOutcome }];
			const { prisma } = fakePrisma(rows);
			await expect(
				recordScheduleOutcome(
					prisma,
					{ scheduleId: "sched-1" },
					"UNKNOWN",
					"the job died",
					AT,
				),
			).resolves.toBe(0);
			expect(rows.map((r) => r.outcome)).toEqual([held]);
		}
	});

	it("DELIVERED does NOT replace UNKNOWN — a manual start hours later must not relabel a given-up row (audit MODERATE-2)", async () => {
		/**
		 * The channelStart/channelStop lookups match "any FIRED row of that
		 * action on this channel". A scheduled start that failed for good is
		 * left UNKNOWN by the dead-job handler; a manual start hours afterwards
		 * reaches provision → RUNNING → DELIVERED and reverse-looks-up that SAME
		 * FIRED row. Before this fix, DELIVERED replaced UNKNOWN and the stale
		 * row went green. Now UNKNOWN outranks the positive and the old row
		 * keeps its honest "we never found out".
		 */
		const rows = [
			{
				...ROW,
				action: "START",
				outcome: "UNKNOWN" as ScheduleOutcome,
			},
		];
		const { prisma } = fakePrisma(rows);
		await expect(
			recordScheduleOutcome(
				prisma,
				{ channelStart: "chan-1" },
				"DELIVERED",
				"the channel reached RUNNING",
				AT,
			),
		).resolves.toBe(0);
		expect(rows.map((r) => r.outcome)).toEqual(["UNKNOWN"]);
	});

	// ── audit 602ec286 §17 P1-4: the media-witnessed progression ──────────
	// PENDING → PROCESS_PUSHING → INGEST_CONNECTED → DELIVERED (feeder/lifecycle)
	// and the off-ladder SLATE_ARMED. Each rung is proven by what it may and
	// may NOT replace, against the fake that actually applies the WHERE.

	it("PROCESS_PUSHING climbs from PENDING", async () => {
		const rows = [{ ...ROW, outcome: "PENDING" as ScheduleOutcome }];
		const { prisma } = fakePrisma(rows);
		await expect(
			recordScheduleOutcome(
				prisma,
				{ scheduleId: "sched-1" },
				"PROCESS_PUSHING",
				"pushing",
				AT,
			),
		).resolves.toBe(1);
		expect(rows.map((r) => r.outcome)).toEqual(["PROCESS_PUSHING"]);
	});

	it("PROCESS_PUSHING does NOT drag INGEST_CONNECTED back down — a restart's fresh push is not a downgrade", async () => {
		const rows = [{ ...ROW, outcome: "INGEST_CONNECTED" as ScheduleOutcome }];
		const { prisma } = fakePrisma(rows);
		await expect(
			recordScheduleOutcome(
				prisma,
				{ scheduleId: "sched-1" },
				"PROCESS_PUSHING",
				"pushing again after a restart",
				AT,
			),
		).resolves.toBe(0);
		expect(rows.map((r) => r.outcome)).toEqual(["INGEST_CONNECTED"]);
	});

	it("INGEST_CONNECTED replaces PROCESS_PUSHING — the provider confirming outranks our ffmpeg merely running", async () => {
		const rows = [{ ...ROW, outcome: "PROCESS_PUSHING" as ScheduleOutcome }];
		const { prisma } = fakePrisma(rows);
		await expect(
			recordScheduleOutcome(
				prisma,
				{ scheduleId: "sched-1" },
				"INGEST_CONNECTED",
				"provider bound the ingest",
				AT,
			),
		).resolves.toBe(1);
		expect(rows.map((r) => r.outcome)).toEqual(["INGEST_CONNECTED"]);
	});

	it("INGEST_CONNECTED never un-fails a FAILED row nor downgrades a DELIVERED one", async () => {
		for (const held of ["FAILED", "DELIVERED", "UNKNOWN"] as const) {
			const rows = [{ ...ROW, outcome: held as ScheduleOutcome }];
			const { prisma } = fakePrisma(rows);
			await expect(
				recordScheduleOutcome(
					prisma,
					{ scheduleId: "sched-1" },
					"INGEST_CONNECTED",
					"provider bound the ingest",
					AT,
				),
			).resolves.toBe(0);
			expect(rows.map((r) => r.outcome)).toEqual([held]);
		}
	});

	it("FAILED overwrites INGEST_CONNECTED — a feed that connected then died is not delivered", async () => {
		const rows = [{ ...ROW, outcome: "INGEST_CONNECTED" as ScheduleOutcome }];
		const { prisma } = fakePrisma(rows);
		await expect(
			recordScheduleOutcome(
				prisma,
				{ scheduleId: "sched-1" },
				"FAILED",
				"ingest dropped, restarts exhausted",
				AT,
			),
		).resolves.toBe(1);
		expect(rows.map((r) => r.outcome)).toEqual(["FAILED"]);
	});

	it("SLATE_ARMED climbs from PENDING but is off the feeder ladder — it never replaces INGEST_CONNECTED", async () => {
		const fromPending = [{ ...ROW, outcome: "PENDING" as ScheduleOutcome }];
		const a = fakePrisma(fromPending);
		await expect(
			recordScheduleOutcome(
				a.prisma,
				{ scheduleId: "sched-1" },
				"SLATE_ARMED",
				"provider armed the insertion",
				AT,
			),
		).resolves.toBe(1);
		expect(fromPending.map((r) => r.outcome)).toEqual(["SLATE_ARMED"]);

		const fromConnected = [
			{ ...ROW, outcome: "INGEST_CONNECTED" as ScheduleOutcome },
		];
		const b = fakePrisma(fromConnected);
		await expect(
			recordScheduleOutcome(
				b.prisma,
				{ scheduleId: "sched-1" },
				"SLATE_ARMED",
				"provider armed the insertion",
				AT,
			),
		).resolves.toBe(0);
		expect(fromConnected.map((r) => r.outcome)).toEqual(["INGEST_CONNECTED"]);
	});

	it("DELIVERED replaces every in-progress positive below it (PROCESS_PUSHING / INGEST_CONNECTED / SLATE_ARMED)", async () => {
		for (const held of [
			"PROCESS_PUSHING",
			"INGEST_CONNECTED",
			"SLATE_ARMED",
			"PENDING",
		] as const) {
			const rows = [{ ...ROW, outcome: held as ScheduleOutcome }];
			const { prisma } = fakePrisma(rows);
			await expect(
				recordScheduleOutcome(
					prisma,
					{ scheduleId: "sched-1" },
					"DELIVERED",
					"the channel reached RUNNING",
					AT,
				),
			).resolves.toBe(1);
			expect(rows.map((r) => r.outcome)).toEqual(["DELIVERED"]);
		}
	});

	it("the feederSessionId target finds the row the session was bound to, and only that one", async () => {
		const rows = [
			{
				...ROW,
				id: "sched-1",
				feederSessionId: "fs-1",
				action: "FEEDER_START",
			},
			{
				...ROW,
				id: "sched-2",
				feederSessionId: "fs-2",
				action: "FEEDER_START",
			},
		];
		const { prisma } = fakePrisma(rows);
		await expect(
			recordScheduleOutcome(
				prisma,
				{ feederSessionId: "fs-2" },
				"FAILED",
				"ingest never bound",
				AT,
			),
		).resolves.toBe(1);
		expect(rows.map((r) => `${r.id}:${r.outcome}`)).toEqual([
			"sched-1:PENDING",
			"sched-2:FAILED",
		]);
	});

	it("the channelStart target touches only FIRED START rows on that channel", async () => {
		/**
		 * review-350 HIGH-2. The scheduled START had no writer at all, so every
		 * successful start rendered permanently amber. Its lookup is the STOP
		 * one's twin — the provision enqueue carries no schedule id either — so
		 * the ACTION is the only thing separating the two, and a start that
		 * resolved a STOP row would be worse than the amber it replaced.
		 */
		const rows = [
			{ ...ROW, id: "fired-start", action: "START", status: "FIRED" },
			{ ...ROW, id: "armed-start", action: "START", status: "ARMED" },
			{ ...ROW, id: "fired-stop", action: "STOP", status: "FIRED" },
			{
				...ROW,
				id: "other-channel",
				liveChannelId: "chan-2",
				action: "START",
				status: "FIRED",
			},
		];
		const { prisma } = fakePrisma(rows);
		await expect(
			recordScheduleOutcome(
				prisma,
				{ channelStart: "chan-1" },
				"DELIVERED",
				"the channel reached RUNNING",
				AT,
			),
		).resolves.toBe(1);
		expect(
			rows.filter((r) => r.outcome === "DELIVERED").map((r) => r.id),
		).toEqual(["fired-start"]);
	});

	it("a MANUAL start on a channel with no fired row writes nothing, and that is not an error", async () => {
		const rows = [
			{ ...ROW, id: "armed-start", action: "START", status: "ARMED" },
		];
		const { prisma } = fakePrisma(rows);
		await expect(
			recordScheduleOutcome(
				prisma,
				{ channelStart: "chan-1" },
				"DELIVERED",
				null,
				AT,
			),
		).resolves.toBe(0);
		expect(rows.map((r) => r.outcome)).toEqual(["PENDING"]);
	});

	it("the channelStop target touches only FIRED STOP rows on that channel", async () => {
		/**
		 * This target identifies rows by channel + action rather than by id (the
		 * stop enqueue carries no schedule id), so the FIRED fence is the only
		 * thing standing between it and tomorrow's armed stop.
		 */
		const rows = [
			{ ...ROW, id: "fired-stop", action: "STOP", status: "FIRED" },
			{ ...ROW, id: "armed-stop", action: "STOP", status: "ARMED" },
			{ ...ROW, id: "fired-slate", action: "SLATE_IN", status: "FIRED" },
			{
				...ROW,
				id: "other-channel",
				liveChannelId: "chan-2",
				action: "STOP",
				status: "FIRED",
			},
		];
		const { prisma } = fakePrisma(rows);
		await expect(
			recordScheduleOutcome(
				prisma,
				{ channelStop: "chan-1" },
				"DELIVERED",
				null,
				AT,
			),
		).resolves.toBe(1);
		expect(
			rows.filter((r) => r.outcome === "DELIVERED").map((r) => r.id),
		).toEqual(["fired-stop"]);
	});

	it("the best-effort wrapper swallows a write failure — the thing it describes already happened", async () => {
		const prisma = {
			liveSchedule: {
				updateMany: vi.fn(async () => {
					throw new Error("connection reset");
				}),
			},
		} as unknown as AppPrismaClient;
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			recordScheduleOutcomeBestEffort(
				prisma,
				{ scheduleId: "sched-1" },
				"FAILED",
				"boom",
				AT,
			),
		).resolves.toBeUndefined();
		expect(logged).toHaveBeenCalled();
		logged.mockRestore();
	});
});
