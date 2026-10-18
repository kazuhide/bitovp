import type { AppPrismaClient } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_SWEEP_JOB } from "../handlers";
import {
	deadJobScheduleWrites,
	isFinalManualStopFailure,
	recordDeadFeederJob,
	recordDeadJobScheduleOutcomes,
	recordFinalManualStopFailure,
	releaseDeadStageClaim,
} from "./dead-job-outcome";

/**
 *  / review-350 HIGH-1 — the dead-job verdicts, at last reachable.
 *
 * These branches lived in the `worker.on("failed", …)` closure in
 * `apps/worker/src/index.ts`, which nothing imports, so every one of them was
 * unreachable by the whole worker suite: review proved it by flipping the
 * insert-content verdict UNKNOWN→FAILED and watching 1589 tests stay green.
 * The provision/stop branch had consequently shipped writing NOTHING to the
 * schedule row — a scheduled STOP whose job died stayed FIRED/PENDING forever.
 */

const CHANNEL = "00000000-0000-4000-8000-0000000000bb";
const SCHEDULE = "33333333-3333-4333-8333-333333333333";
const SESSION = "00000000-0000-4000-8000-0000000000f1";
const RUN = "11111111-1111-4111-8111-111111111111";

const MANUAL_STOP_JOB = {
	name: "live-channel",
	attemptsMade: 5,
	opts: { attempts: 5 },
	data: {
		liveChannelId: CHANNEL,
		action: "stop",
		effect: {
			idempotencyKey: `manual:stop:${CHANNEL}:${RUN}`,
			liveChannelRunId: RUN,
			providerEncodingId: "encoding-1",
			admissionFenceVersion: 7,
			action: "STOP",
		},
	},
} as const;

describe("manual STOP final-delivery projection", () => {
	it("projects only the final failed attempt", () => {
		expect(
			isFinalManualStopFailure({ ...MANUAL_STOP_JOB, attemptsMade: 4 }),
		).toBe(false);
		expect(isFinalManualStopFailure(MANUAL_STOP_JOB)).toBe(true);
		expect(
			isFinalManualStopFailure({
				...MANUAL_STOP_JOB,
				attemptsMade: 1,
				finishedOn: Date.parse("2026-08-31T12:00:00.000Z"),
			}),
		).toBe(true);
		expect(
			isFinalManualStopFailure({
				...MANUAL_STOP_JOB,
				attemptsMade: 1,
			}),
		).toBe(false);
		expect(
			isFinalManualStopFailure({
				...MANUAL_STOP_JOB,
				data: { ...MANUAL_STOP_JOB.data, action: "restart" },
			}),
		).toBe(false);
	});

	function projectionStore(
		over: {
			runId?: string;
			providerEncodingId?: string;
			channelFence?: number;
			claim?: {
				state: "FAILED" | "DISPATCHING" | "ACKED";
				generation: number;
			};
		} = {},
	) {
		const channel = {
			name: "Akamai primary",
			status: "RUNNING",
			liveEffectFenceVersion: over.channelFence ?? 7,
			bitmovinEncodingId: over.providerEncodingId ?? "encoding-1",
		};
		const run = {
			id: over.runId ?? RUN,
			bitmovinEncodingId: over.providerEncodingId ?? "encoding-1",
		};
		const claim = over.claim
			? {
					...over.claim,
					liveChannelId: CHANNEL,
					liveChannelRunId: RUN,
					providerEncodingId: "encoding-1",
					action: "STOP",
				}
			: null;
		const updateMany = vi.fn(async () => ({ count: 1 }));
		const tx = {
			liveChannel: {
				findUnique: vi.fn(async () => channel),
				updateMany,
			},
			liveChannelRun: { findFirst: vi.fn(async () => run) },
			liveEffectClaim: { findUnique: vi.fn(async () => claim) },
		};
		const prisma = {
			...tx,
			$transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
		} as unknown as AppPrismaClient;
		return { prisma, updateMany };
	}

	it("makes a never-claimed exhausted stop visibly retryable under its exact run/fence", async () => {
		const t = projectionStore();
		const emitEvent = vi.fn(async () => undefined);
		await expect(
			recordFinalManualStopFailure(
				t.prisma,
				MANUAL_STOP_JOB,
				"database down",
				emitEvent,
			),
		).resolves.toBe(true);
		expect(t.updateMany).toHaveBeenCalledWith({
			where: {
				id: CHANNEL,
				status: { in: ["RUNNING", "STOPPING"] },
				liveEffectFenceVersion: 7,
			},
			data: {
				status: "ERROR",
				error: expect.stringMatching(/stop delivery exhausted.*retry Stop/i),
			},
		});
		expect(emitEvent).toHaveBeenCalledWith({
			kind: "CHANNEL_ERROR",
			liveChannelId: CHANNEL,
			name: "Akamai primary",
			error: expect.stringMatching(/stop delivery exhausted.*retry Stop/i),
			path: `/live/${CHANNEL}`,
		});
	});

	it("projects a conclusively FAILED pre-send claim at its claimed generation", async () => {
		const t = projectionStore({
			channelFence: 8,
			claim: { state: "FAILED", generation: 8 },
		});
		await expect(
			recordFinalManualStopFailure(t.prisma, MANUAL_STOP_JOB, "pre-send"),
		).resolves.toBe(true);
		expect(t.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ liveEffectFenceVersion: 8 }),
			}),
		);
	});

	it("never overwrites a newer run or an unresolved send-boundary owner", async () => {
		for (const over of [
			{ runId: "22222222-2222-4222-8222-222222222222" },
			{
				channelFence: 8,
				claim: { state: "DISPATCHING" as const, generation: 8 },
			},
		]) {
			const t = projectionStore(over);
			await expect(
				recordFinalManualStopFailure(t.prisma, MANUAL_STOP_JOB, "boom"),
			).resolves.toBe(false);
			expect(t.updateMany).not.toHaveBeenCalled();
		}
	});
});

describe("deadJobScheduleWrites (ledger #238)", () => {
	it("a dead provision closes the channel's FIRED START row as UNKNOWN", () => {
		expect(
			deadJobScheduleWrites(
				{ name: "live-channel", data: { liveChannelId: CHANNEL } },
				"lock lost",
			),
		).toEqual([
			{
				target: { channelStart: CHANNEL },
				outcome: "UNKNOWN",
				note: expect.stringContaining("lock lost"),
			},
		]);
	});

	it("an ABSENT action is a provision — the job schema's own default", () => {
		// `liveChannelJobSchema.action` defaults to "provision" and the create
		// path enqueues without one, so reading an absent action as anything
		// else would silently drop the commonest start.
		const [write] = deadJobScheduleWrites(
			{ data: { liveChannelId: CHANNEL } },
			"boom",
		);
		expect(write?.target).toEqual({ channelStart: CHANNEL });
	});

	it("a dead stop closes the channel's FIRED STOP row as UNKNOWN — not FAILED", () => {
		/**
		 * The HIGH-1 defect in one arm: this branch used to write nothing, so
		 * the row read "Fired — outcome not confirmed yet" beside a channel the
		 * same handler had just marked ERROR, and was then resolved by an
		 * unrelated later stop. UNKNOWN and not FAILED because a dead job is
		 * evidence about the job, never about the encoder.
		 */
		expect(
			deadJobScheduleWrites(
				{ data: { liveChannelId: CHANNEL, action: "stop" } },
				"stalled twice",
			),
		).toEqual([
			{
				target: { channelStop: CHANNEL },
				outcome: "UNKNOWN",
				note: expect.stringContaining("stalled twice"),
			},
		]);
	});

	it("a durable manual stop never owns or mutates a scheduled STOP outcome", async () => {
		expect(deadJobScheduleWrites(MANUAL_STOP_JOB, "stalled twice")).toEqual([]);

		const updateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
		const prisma = {
			liveSchedule: { updateMany },
		} as unknown as AppPrismaClient;
		await recordDeadJobScheduleOutcomes(
			prisma,
			MANUAL_STOP_JOB,
			"stalled twice",
			new Date("2026-08-31T12:00:00.000Z"),
		);
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("a dead slate closes its own row by id as UNKNOWN — the POST may have landed", () => {
		expect(
			deadJobScheduleWrites(
				{
					data: {
						liveChannelId: CHANNEL,
						action: "insert-content",
						params: { scheduleId: SCHEDULE },
					},
				},
				"killed",
			),
		).toEqual([
			{
				target: { scheduleId: SCHEDULE },
				outcome: "UNKNOWN",
				note: expect.stringContaining("provider's answer"),
			},
		]);
	});

	it("a dead feeder start or switch is UNKNOWN, because its ffmpeg may still be pushing", () => {
		/**
		 * review-350 MEDIUM. This branch used to write FAILED, which the
		 * audit's own CRITICAL-2 contradicts: a dead feeder-start job can leave
		 * an orphaned ffmpeg pushing a live, billing feed. "It failed" is a
		 * claim this path cannot make.
		 */
		// : a dead COMMIT is the same shape — the request may or may
		// not have landed, and the held session's own transitions will say.
		for (const action of ["feeder-start", "feeder-switch", "feeder-commit"]) {
			expect(
				deadJobScheduleWrites(
					{
						data: {
							liveChannelId: CHANNEL,
							action,
							params: { scheduleId: SCHEDULE },
						},
					},
					"lock lost",
				),
			).toEqual([
				{
					target: { scheduleId: SCHEDULE },
					outcome: "UNKNOWN",
					note: expect.stringContaining("orphaned"),
				},
			]);
		}
	});

	it("a dead PRE-STAGE closes no row — the row has not fired (row #240)", () => {
		expect(
			deadJobScheduleWrites(
				{
					data: {
						liveChannelId: CHANNEL,
						action: "feeder-stage",
						params: { scheduleId: SCHEDULE },
					},
				},
				"lock lost",
			),
		).toEqual([]);
	});

	it("closes nothing for jobs that own no schedule row", () => {
		// Enumerated rather than sampled: the heartbeat sweep (which rides the
		// same queue with no payload), restart (never scheduled), the parameter
		// actions, live-to-VOD, and the id-less shapes of every branch above.
		const noRow: Parameters<typeof deadJobScheduleWrites>[0][] = [
			{ name: HEARTBEAT_SWEEP_JOB },
			{ name: HEARTBEAT_SWEEP_JOB, data: { liveChannelId: CHANNEL } },
			{ data: { liveChannelId: CHANNEL, action: "restart" } },
			{ data: { liveChannelId: CHANNEL, action: "live-to-vod" } },
			{ data: { liveChannelId: CHANNEL, action: "scte35" } },
			{ data: { liveChannelId: CHANNEL, action: "reset-timeshift" } },
			{ data: { action: "stop" } },
			{ data: { action: "provision" } },
			{ data: { liveChannelId: CHANNEL, action: "insert-content" } },
			{ data: { liveChannelId: CHANNEL, action: "feeder-start" } },
			undefined,
		];
		for (const job of noRow) {
			expect(deadJobScheduleWrites(job, "boom")).toEqual([]);
		}
	});
});

describe("recordDeadJobScheduleOutcomes", () => {
	it("writes each decision through the shared precedence, redacted", async () => {
		// The parameter is DECLARED so `mock.calls[0][0]` has a type — an
		// argument-less `vi.fn` types its calls as `[][]`, which vitest runs
		// happily and tsc rejects (the class the guide names: for a type error
		// in a test file, typecheck is the only detector of the six).
		const updateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
		const prisma = {
			liveSchedule: { updateMany },
		} as unknown as AppPrismaClient;
		const at = new Date("2026-08-29T12:00:00.000Z");
		await recordDeadJobScheduleOutcomes(
			prisma,
			{ data: { liveChannelId: CHANNEL, action: "stop" } },
			"connection to postgresql://u:hunter2@db/x failed",
			at,
		);
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				liveChannelId: CHANNEL,
				action: "STOP",
				status: "FIRED",
				// UNKNOWN may only replace PENDING — it never downgrades an
				// answer the processor already recorded.
				outcome: { in: ["PENDING"] },
			},
			data: {
				outcome: "UNKNOWN",
				outcomeAt: at,
				outcomeEvidenceVersion: 1,
				outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
				outcomeEvidenceAt: at,
				// Non-vacuous in both directions: the prose proves the note
				// arrived, the negative proves it arrived redacted.
				outcomeNote: expect.stringContaining("the scheduled stop's job died"),
			},
		});
		const written = (
			updateMany.mock.calls[0]?.[0] as unknown as {
				data: { outcomeNote: string };
			}
		).data.outcomeNote;
		expect(written).not.toContain("hunter2");
	});

	it("writes nothing at all for a job that closes no row", async () => {
		const updateMany = vi.fn(async () => ({ count: 1 }));
		const prisma = {
			liveSchedule: { updateMany },
		} as unknown as AppPrismaClient;
		await recordDeadJobScheduleOutcomes(
			prisma,
			{ name: HEARTBEAT_SWEEP_JOB },
			"boom",
			new Date(),
		);
		expect(updateMany).not.toHaveBeenCalled();
	});
});

/**
 * review-351 — the dead feeder START job, which landed the session ERROR with
 * its forensic pid and NOTIFIED NOBODY, on the most common trigger of the
 * orphan-ffmpeg case (audit CRITICAL-2).
 */
/**
 *  — a dead pre-stage releases its claim, guarded on the row still
 * being ARMED with no session: a stage that created its session before dying
 * has done its work, and releasing it would create a second one.
 */
describe("releaseDeadStageClaim (row #240)", () => {
	function prismaWith(count: number) {
		const updateMany = vi.fn(async () => ({ count }));
		return {
			prisma: { liveSchedule: { updateMany } } as unknown as AppPrismaClient,
			updateMany,
		};
	}

	it("releases both stage stamps of an ARMED, session-less row", async () => {
		const { prisma, updateMany } = prismaWith(1);
		await expect(
			releaseDeadStageClaim(prisma, {
				data: {
					liveChannelId: CHANNEL,
					action: "feeder-stage",
					params: { scheduleId: SCHEDULE },
				},
			}),
		).resolves.toBe(1);
		expect(updateMany).toHaveBeenCalledWith({
			where: { id: SCHEDULE, status: "ARMED", feederSessionId: null },
			data: { stagedAt: null, stageDispatchedAt: null },
		});
	});

	it("touches nothing for any other action, or without a schedule id", async () => {
		const { prisma, updateMany } = prismaWith(1);
		await expect(
			releaseDeadStageClaim(prisma, {
				data: {
					liveChannelId: CHANNEL,
					action: "feeder-commit",
					params: { scheduleId: SCHEDULE },
				},
			}),
		).resolves.toBe(0);
		await expect(
			releaseDeadStageClaim(prisma, {
				data: { liveChannelId: CHANNEL, action: "feeder-stage" },
			}),
		).resolves.toBe(0);
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("never throws out of the failed-event handler it runs in", async () => {
		const prisma = {
			liveSchedule: {
				updateMany: vi.fn(async () => {
					throw new Error("db down");
				}),
			},
		} as unknown as AppPrismaClient;
		await expect(
			releaseDeadStageClaim(prisma, {
				data: {
					liveChannelId: CHANNEL,
					action: "feeder-stage",
					params: { scheduleId: SCHEDULE },
				},
			}),
		).resolves.toBe(0);
	});
});

describe("recordDeadFeederJob", () => {
	function setup(
		over: {
			pid?: number | null;
			count?: number;
			/** : the ownership lease this session carries. */
			ownerLeaseAt?: Date | null;
		} = {},
	) {
		const findUnique = vi.fn(async () => ({
			pid: over.pid === undefined ? 4242 : over.pid,
			liveChannelId: CHANNEL,
			ownerLeaseAt: over.ownerLeaseAt ?? null,
		}));
		const updateMany = vi.fn(async () => ({ count: over.count ?? 1 }));
		const scheduleUpdateMany = vi.fn(async () => ({ count: 1 }));
		const emitEvent = vi.fn(async () => {});
		const prisma = {
			feederSession: { findUnique, updateMany },
			liveSchedule: { updateMany: scheduleUpdateMany },
		} as unknown as AppPrismaClient;
		return {
			prisma,
			emitEvent,
			findUnique,
			updateMany,
			scheduleUpdateMany,
			deps: {
				prisma,
				emitEvent,
				now: () => new Date("2026-08-29T12:00:00.000Z"),
			},
		};
	}

	const startJob = { data: { feederSessionId: SESSION, action: "start" } };

	beforeEach(() => vi.clearAllMocks());

	it("EMITS FEEDER_ERROR beside the session write — the notification that was missing", async () => {
		const t = setup();
		await recordDeadFeederJob(t.deps, startJob, "lock lost");
		expect(t.updateMany).toHaveBeenCalledWith({
			where: {
				id: SESSION,
				status: { in: ["CREATED", "DOWNLOADING", "PUSHING"] },
			},
			data: {
				status: "ERROR",
				stoppedAt: new Date("2026-08-29T12:00:00.000Z"),
				// The pid is KEPT and named: it is the only pointer to the
				// ffmpeg that may still be pushing.
				error: expect.stringContaining("orphaned at pid 4242"),
			},
		});
		expect(t.emitEvent).toHaveBeenCalledWith({
			kind: "FEEDER_ERROR",
			feederSessionId: SESSION,
			liveChannelId: CHANNEL,
			error: expect.stringContaining("Worker lost the session"),
			path: `/live/${CHANNEL}`,
		});
	});

	it("closes the schedule row that armed the session as UNKNOWN, beside the emit", async () => {
		const t = setup();
		await recordDeadFeederJob(t.deps, startJob, "lock lost");
		expect(t.scheduleUpdateMany).toHaveBeenCalledWith({
			where: {
				feederSessionId: SESSION,
				outcome: { in: ["PENDING"] },
			},
			data: {
				outcome: "UNKNOWN",
				outcomeAt: new Date("2026-08-29T12:00:00.000Z"),
				outcomeEvidenceVersion: 1,
				outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
				outcomeEvidenceAt: new Date("2026-08-29T12:00:00.000Z"),
				outcomeNote: expect.stringContaining("Worker lost the session"),
			},
		});
	});

	it("says so when no pid was ever recorded", async () => {
		const t = setup({ pid: null });
		await recordDeadFeederJob(t.deps, startJob, "lock lost");
		expect(t.emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				error: expect.stringContaining("no ffmpeg pid was recorded"),
			}),
		);
	});

	it("a LOST transition emits nothing and closes nothing — the winner owns the session", async () => {
		/**
		 * The same fence the channel arm learned as review-336 C3. An
		 * unconditional emit here would raise an incident about a session
		 * another worker is running, or duplicate the one `markTerminal`
		 * already sent.
		 */
		const t = setup({ count: 0 });
		await recordDeadFeederJob(t.deps, startJob, "lock lost");
		expect(t.emitEvent).not.toHaveBeenCalled();
		expect(t.scheduleUpdateMany).not.toHaveBeenCalled();
	});

	it("a dead STOP job touches nothing — the session may genuinely still be pushing", async () => {
		const t = setup();
		await recordDeadFeederJob(
			t.deps,
			{ data: { feederSessionId: SESSION, action: "stop" } },
			"lock lost",
		);
		expect(t.findUnique).not.toHaveBeenCalled();
		expect(t.updateMany).not.toHaveBeenCalled();
		expect(t.emitEvent).not.toHaveBeenCalled();
	});

	/**
	 *  — the staleness guard. BullMQ retires a stalled start job after
	 * ~150s and the takeover window is 90s, so on a worker death the takeover
	 * lands FIRST and this handler fires afterwards, about a session another
	 * worker is already pushing. #216 gave the live failed handler the same
	 * guard for the same ordering.
	 */
	it("ignores a dead START job whose session now carries a FRESH lease", async () => {
		const t = setup({ ownerLeaseAt: new Date("2026-08-29T12:00:00.000Z") });
		const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
		await recordDeadFeederJob(t.deps, startJob, "lock lost");
		expect(t.updateMany).not.toHaveBeenCalled();
		expect(t.emitEvent).not.toHaveBeenCalled();
		expect(t.scheduleUpdateMany).not.toHaveBeenCalled();
		expect(logged).toHaveBeenCalled();
		logged.mockRestore();
	});

	it("still closes the session when that lease is STALE", async () => {
		// The control arm: the only difference from the test above is the
		// lease's age. A guard that skipped every session with a non-null lease
		// would pass that test and fail this one — and would silently retire
		// the whole dead-job path the moment the lease columns shipped.
		const t = setup({
			ownerLeaseAt: new Date("2026-08-29T11:00:00.000Z"),
		});
		await recordDeadFeederJob(t.deps, startJob, "lock lost");
		expect(t.updateMany).toHaveBeenCalled();
		expect(t.emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "FEEDER_ERROR" }),
		);
	});

	it("never throws out of the failed-event handler it runs in", async () => {
		const prisma = {
			feederSession: {
				findUnique: vi.fn(async () => {
					throw new Error("connection reset");
				}),
			},
		} as unknown as AppPrismaClient;
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			recordDeadFeederJob({ prisma }, startJob, "lock lost"),
		).resolves.toBeUndefined();
		expect(logged).toHaveBeenCalled();
		logged.mockRestore();
	});
});
