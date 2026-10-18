import { type AppPrismaClient, projecting, projectSelected } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertEngine, createOrphanResolver } from "./engine";

/**
 *  (design §8): the TRANSITION half — open once per breach edge
 * (P2002 from the partial unique index means "already open"), resolve by
 * the REAL event id, and both edges emit. Judgment (which rules breach)
 * is core's and tested there; this store fakes rows with honest
 * compare-and-set semantics (the named-slot lesson).
 */

const CH = "11111111-1111-4111-8111-111111111111";
const RULE = "22222222-2222-4222-8222-222222222222";
/** : the run the samples are scoped to, and the airing before it. */
const CURRENT_RUN = "77777777-7777-4777-8777-777777777777";
const PREVIOUS_RUN = "88888888-8888-4888-8888-888888888888";
/** The current run's row-creation time — the window's lower bound. */
const RUN_CREATED_AT = new Date("2026-08-13T10:00:00Z");

type HeartbeatRow = {
	at: Date;
	raw: unknown;
	/** Nullable through #108's two-step move; null = no run carried it. */
	liveChannelRunId?: string | null;
};

type EventRow = {
	id: string;
	ruleId: string;
	liveChannelId: string;
	openedAt: Date;
	resolvedAt: Date | null;
	context: unknown;
};

function makeStore(over: {
	programStartAt?: Date | null;
	programEndAt?: Date | null;
	rules?: unknown[];
	heartbeats?: HeartbeatRow[];
	events?: EventRow[];
	failCreateWithP2002?: boolean;
	/**
	 * : the channel's newest run. Defaults to one created at
	 * RUN_CREATED_AT; `null` is the pre-#108 channel that has no run row at
	 * all, where the engine must not scope anything.
	 */
	run?: { id: string; createdAt: Date } | null;
	pollEpoch?: number;
	runEncodingId?: string;
}) {
	const run =
		over.run === undefined
			? { id: CURRENT_RUN, createdAt: RUN_CREATED_AT }
			: over.run;
	let nextId = 0;
	const store = {
		events: over.events ?? [],
		/** Orphan-resolver tests set this: eventRuleId → rule row. */
		ruleOf: undefined as
			| ((ruleId: string) => {
					enabled: boolean;
					liveChannelId: string | null;
					metric: string;
			  })
			| undefined,
		prisma: {
			$transaction: async <T>(fn: (tx: AppPrismaClient) => Promise<T>) =>
				fn(store.prisma as unknown as AppPrismaClient),
			alertRule: {
				findMany: vi.fn(async () =>
					(
						over.rules ?? [
							{
								id: RULE,
								metric: "INPUT_DISCONNECTED",
								threshold: null,
								windowPolls: 1,
							},
						]
					).map((rule) => ({ ...(rule as object) })),
				),
			},
			liveHeartbeat: {
				/**
				 * An HONEST double (the named-slot lesson): it APPLIES the
				 * where/orderBy/take Postgres would rather than accepting any
				 * query and handing back the whole table. That is the whole
				 * point for  — with a filtering store, deleting the
				 * engine's run scope makes the previous airing's rows reappear
				 * in the window and the alert fire, which is a behaviour test.
				 * Asserting the SHAPE of a `where` object instead would pass
				 * for any filter, including a wrong one.
				 */
				findMany: vi.fn(
					async (args: {
						where?: {
							at?: { gte?: Date };
							OR?: { liveChannelRunId: string | null }[];
						};
						orderBy?: { at?: "asc" | "desc" };
						take?: number;
						select?: Record<string, boolean>;
					}) => {
						const where = args?.where ?? {};
						const gte = where.at?.gte;
						const runIds = where.OR?.map((clause) => clause.liveChannelRunId);
						const rows = (over.heartbeats ?? [])
							.filter((row) => (gte ? row.at.getTime() >= gte.getTime() : true))
							.filter((row) =>
								runIds ? runIds.includes(row.liveChannelRunId ?? null) : true,
							)
							.sort((a, b) =>
								args?.orderBy?.at === "desc"
									? b.at.getTime() - a.at.getTime()
									: a.at.getTime() - b.at.getTime(),
							)
							.slice(0, args?.take ?? Number.POSITIVE_INFINITY);
						// Projected, so a dropped SELECT is a red test and not
						// a silently richer row than production ships.
						return rows.map((row) => projectSelected(row, args?.select));
					},
				),
			},
			liveChannelRun: {
				// : the engine reads its own run scope (it is not
				// threaded from the sweep — a caller that forgot would get the
				// pre-#243 cross-run window back silently).
				findFirst: vi.fn(projecting(async () => (run ? { ...run } : null))),
				updateMany: vi.fn(
					async (args: {
						where: {
							id: string;
							bitmovinEncodingId: string;
							heartbeatPollEpoch: number;
						};
					}) => ({
						count:
							run &&
							args.where.id === run.id &&
							args.where.bitmovinEncodingId ===
								(over.runEncodingId ?? "enc-1") &&
							args.where.heartbeatPollEpoch === (over.pollEpoch ?? 1)
								? 1
								: 0,
					}),
				),
			},
			liveChannel: {
				// : the engine reads the scheduled program window
				// itself. Projected via the shared helper so a wrong SELECT is
				// a red test, not a silent no-op (the #86 mock lesson).
				findUnique: vi.fn(async (args: { select?: Record<string, boolean> }) =>
					projectSelected(
						{
							id: CH,
							programStartAt: over.programStartAt ?? null,
							programEndAt: over.programEndAt ?? null,
						},
						args?.select,
					),
				),
			},
			alertEvent: {
				findMany: vi.fn(async (args?: { select?: { rule?: unknown } }) =>
					store.events
						.filter((event) => event.resolvedAt === null)
						.map((event) =>
							args?.select?.rule
								? {
										id: event.id,
										liveChannelId: event.liveChannelId,
										rule: { ...(store.ruleOf?.(event.ruleId) ?? {}) },
									}
								: { ruleId: event.ruleId },
						),
				),
				create: vi.fn(async (args: { data: Omit<EventRow, "id"> }) => {
					if (over.failCreateWithP2002) {
						const err = new Error("unique") as Error & { code: string };
						err.code = "P2002";
						throw err;
					}
					nextId += 1;
					const data = args.data as Partial<EventRow>;
					const row: EventRow = {
						...(data as EventRow),
						// The DB's column default — the engine's create omits it.
						resolvedAt: data.resolvedAt ?? null,
						id: `33333333-3333-4333-8333-33333333333${nextId}`,
					};
					store.events.push(row);
					return { ...row };
				}),
				findFirst: vi.fn(
					async (args: {
						where: { ruleId: string; liveChannelId: string };
					}) => {
						const hit = store.events.find(
							(event) =>
								event.ruleId === args.where.ruleId &&
								event.liveChannelId === args.where.liveChannelId &&
								event.resolvedAt === null,
						);
						return hit ? { id: hit.id } : null;
					},
				),
				updateMany: vi.fn(
					async (args: {
						where: { id: string };
						data: { resolvedAt: Date };
					}) => {
						let count = 0;
						for (const event of store.events) {
							if (event.id === args.where.id && event.resolvedAt === null) {
								event.resolvedAt = args.data.resolvedAt;
								count += 1;
							}
						}
						return { count };
					},
				),
			},
		},
	};
	return store;
}

const DISCONNECTED = {
	at: new Date("2026-08-13T10:00:00Z"),
	raw: { ingest: { status: "DISCONNECTED" } },
};
const CONNECTED = {
	at: new Date("2026-08-13T10:00:00Z"),
	raw: { ingest: { status: "CONNECTED" } },
};

function makeEngine(store: ReturnType<typeof makeStore>) {
	const emitEvent = vi.fn(async () => {});
	const engine = createAlertEngine({
		prisma: store.prisma as unknown as AppPrismaClient,
		emitEvent,
		now: () => new Date("2026-08-13T10:00:10Z"),
		sweepIntervalMs: 30_000,
	});
	return { engine, emitEvent };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("alert engine transitions", () => {
	it("a superseded heartbeat token cannot evaluate or mutate alerts", async () => {
		const store = makeStore({
			heartbeats: [DISCONNECTED],
			pollEpoch: 2,
		});
		const { engine, emitEvent } = makeEngine(store);
		const result = await engine(
			CH,
			"RUNNING",
			undefined,
			undefined,
			{ id: CURRENT_RUN, createdAt: RUN_CREATED_AT },
			{ runId: CURRENT_RUN, encodingId: "enc-1", epoch: 1 },
		);
		expect(result).toEqual({ opened: 0, resolved: 0 });
		expect(store.prisma.liveChannelRun.updateMany).toHaveBeenCalledWith({
			where: {
				id: CURRENT_RUN,
				liveChannelId: CH,
				bitmovinEncodingId: "enc-1",
				heartbeatPollEpoch: 1,
			},
			data: { heartbeatPollEpoch: 1 },
		});
		expect(store.prisma.alertRule.findMany).not.toHaveBeenCalled();
		expect(store.events).toHaveLength(0);
		expect(emitEvent).not.toHaveBeenCalled();
	});

	it("the current heartbeat token locks the run and evaluates inside that transaction", async () => {
		const store = makeStore({
			heartbeats: [DISCONNECTED],
			pollEpoch: 2,
		});
		const { engine } = makeEngine(store);
		await expect(
			engine(
				CH,
				"RUNNING",
				undefined,
				undefined,
				{ id: CURRENT_RUN, createdAt: RUN_CREATED_AT },
				{ runId: CURRENT_RUN, encodingId: "enc-1", epoch: 2 },
			),
		).resolves.toEqual({ opened: 1, resolved: 0 });
		expect(store.events).toHaveLength(1);
	});

	it("opens an event + emits ALERT_OPENED with the created id on a breach edge", async () => {
		const store = makeStore({ heartbeats: [DISCONNECTED] });
		const { engine, emitEvent } = makeEngine(store);
		const result = await engine(CH, "RUNNING");
		expect(result).toEqual({ opened: 1, resolved: 0 });
		expect(store.events).toHaveLength(1);
		expect(store.events[0]).toMatchObject({
			ruleId: RULE,
			liveChannelId: CH,
			resolvedAt: null,
		});
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "ALERT_OPENED",
				alertId: store.events[0]?.id,
				rule: "INPUT_DISCONNECTED",
			}),
		);
	});

	it("still-breaching + already-open ⇒ NO second open, NO emit (edge-triggered)", async () => {
		const store = makeStore({
			heartbeats: [DISCONNECTED],
			events: [
				{
					id: "44444444-4444-4444-8444-444444444444",
					ruleId: RULE,
					liveChannelId: CH,
					openedAt: new Date(),
					resolvedAt: null,
					context: {},
				},
			],
		});
		const { engine, emitEvent } = makeEngine(store);
		const result = await engine(CH, "RUNNING");
		expect(result).toEqual({ opened: 0, resolved: 0 });
		expect(emitEvent).not.toHaveBeenCalled();
	});

	it("recovery resolves the OPEN event by ITS id and emits ALERT_RESOLVED", async () => {
		const openId = "44444444-4444-4444-8444-444444444444";
		const store = makeStore({
			heartbeats: [CONNECTED],
			events: [
				{
					id: openId,
					ruleId: RULE,
					liveChannelId: CH,
					openedAt: new Date(),
					resolvedAt: null,
					context: {},
				},
			],
		});
		const { engine, emitEvent } = makeEngine(store);
		const result = await engine(CH, "RUNNING");
		expect(result).toEqual({ opened: 0, resolved: 1 });
		expect(store.events[0]?.resolvedAt).not.toBeNull();
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "ALERT_RESOLVED", alertId: openId }),
		);
	});

	it("a P2002 from the partial unique index is 'already open', never a throw or an emit", async () => {
		const store = makeStore({
			heartbeats: [DISCONNECTED],
			failCreateWithP2002: true,
		});
		const { engine, emitEvent } = makeEngine(store);
		await expect(engine(CH, "RUNNING")).resolves.toEqual({
			opened: 0,
			resolved: 0,
		});
		expect(emitEvent).not.toHaveBeenCalled();
	});

	it("healthy + nothing open ⇒ no writes at all", async () => {
		const store = makeStore({ heartbeats: [CONNECTED] });
		const { engine, emitEvent } = makeEngine(store);
		const result = await engine(CH, "RUNNING");
		expect(result).toEqual({ opened: 0, resolved: 0 });
		expect(store.prisma.alertEvent.create).not.toHaveBeenCalled();
		expect(store.prisma.alertEvent.updateMany).not.toHaveBeenCalled();
		expect(emitEvent).not.toHaveBeenCalled();
	});

	it("PROGRAM_START_NO_INGEST breaches THROUGH the engine — the fallback select must deliver the window (review-223 F9)", async () => {
		// now is 2026-08-13T10:00:10Z: inside the window below. The engine
		// reads the window itself here (no programWindow argument) — dropping
		// programStartAt from its select turns this red, which is the point:
		// review-223 caught a mutation of exactly that select surviving.
		const store = makeStore({
			programStartAt: new Date("2026-08-13T09:59:00Z"),
			programEndAt: new Date("2026-08-13T11:00:00Z"),
			rules: [
				{
					id: RULE,
					metric: "PROGRAM_START_NO_INGEST",
					threshold: null,
					windowPolls: 1,
				},
			],
			heartbeats: [DISCONNECTED],
		});
		const { engine, emitEvent } = makeEngine(store);
		const result = await engine(CH, "RUNNING");
		expect(result.opened).toBe(1);
		expect(store.events).toHaveLength(1);
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "ALERT_OPENED" }),
		);
	});

	it("the same evaluation with the window THREADED from the caller skips the channel read (review-223 F10)", async () => {
		const store = makeStore({
			// The store's own window is EMPTY: if the engine ignored the
			// argument and read the row anyway, no breach would open.
			programStartAt: null,
			programEndAt: null,
			rules: [
				{
					id: RULE,
					metric: "PROGRAM_START_NO_INGEST",
					threshold: null,
					windowPolls: 1,
				},
			],
			heartbeats: [DISCONNECTED],
		});
		const { engine } = makeEngine(store);
		const result = await engine(CH, "RUNNING", undefined, {
			programStartAt: new Date("2026-08-13T09:59:00Z"),
			programEndAt: new Date("2026-08-13T11:00:00Z"),
		});
		expect(result.opened).toBe(1);
		// F10's economy, pinned: the caller supplied the window, so the
		// engine made NO liveChannel read at all.
		expect(store.prisma.liveChannel.findUnique).not.toHaveBeenCalled();
	});

	it("no rules ⇒ no reads of heartbeats (cheap idle path)", async () => {
		const store = makeStore({ rules: [], heartbeats: [DISCONNECTED] });
		const { engine } = makeEngine(store);
		await engine(CH, "RUNNING");
		expect(store.prisma.liveHeartbeat.findMany).not.toHaveBeenCalled();
		//  added a second read; it rides the same early return.
		expect(store.prisma.liveChannelRun.findFirst).not.toHaveBeenCalled();
	});
});

/**
 *  (audit 4403130 §4 IMPORTANT-1, second defect): the engine read
 * heartbeats by `liveChannelId` ALONE, so right after a re-air the previous
 * airing's samples were still the newest rows in the table and were evaluated
 * as if they belonged to the new run.
 *
 * Every arm below drives the SAME default rule (INPUT_DISCONNECTED,
 * windowPolls 1) and varies only which run a sample belongs to and when it
 * was stamped, against a store that really filters.
 */
describe("heartbeat window is scoped to the CURRENT run", () => {
	const disconnectedAt = (at: string, liveChannelRunId?: string | null) => ({
		at: new Date(at),
		raw: { ingest: { status: "DISCONNECTED" } },
		...(liveChannelRunId !== undefined ? { liveChannelRunId } : {}),
	});

	it("the PREVIOUS run's disconnected tail cannot open an alert on the new run", async () => {
		const store = makeStore({
			heartbeats: [
				disconnectedAt("2026-08-13T09:58:00Z", PREVIOUS_RUN),
				disconnectedAt("2026-08-13T09:59:00Z", PREVIOUS_RUN),
			],
		});
		const { engine, emitEvent } = makeEngine(store);
		await expect(engine(CH, "RUNNING")).resolves.toEqual({
			opened: 0,
			resolved: 0,
		});
		expect(store.events).toHaveLength(0);
		expect(emitEvent).not.toHaveBeenCalled();
	});

	it("the CURRENT run's own disconnect still opens — the scope narrows the window, it does not disable the rule", async () => {
		const store = makeStore({
			heartbeats: [
				disconnectedAt("2026-08-13T09:59:00Z", PREVIOUS_RUN),
				disconnectedAt("2026-08-13T10:00:05Z", CURRENT_RUN),
			],
		});
		const { engine } = makeEngine(store);
		await expect(engine(CH, "RUNNING")).resolves.toEqual({
			opened: 1,
			resolved: 0,
		});
	});

	it("a sample stamped with the PREVIOUS run but written after the new run began is excluded (the in-flight poll race)", async () => {
		// review-242 A3 stamps a sample onto the run that owns the ENCODING it
		// was fetched for, so the old run's last poll can land with a
		// timestamp INSIDE the new run's window. The timestamp bound alone
		// would admit it; the run-id arm is what refuses it.
		const store = makeStore({
			heartbeats: [disconnectedAt("2026-08-13T10:00:05Z", PREVIOUS_RUN)],
		});
		const { engine } = makeEngine(store);
		await expect(engine(CH, "RUNNING")).resolves.toEqual({
			opened: 0,
			resolved: 0,
		});
	});

	it("an UNSTAMPED sample from BEFORE the run began is excluded by the time bound alone", async () => {
		// The arm the run-id filter cannot reach, and the reason both halves
		// are here: a pre-#108 (or not-yet-stamped) sample carries a NULL run
		// id, so the OR clause admits it and only `at >= run.createdAt` keeps
		// the previous airing out. Contrast the "no run row" case below, where
		// the identical row is evaluated because there is no boundary at all.
		const store = makeStore({
			heartbeats: [disconnectedAt("2026-08-13T09:58:00Z", null)],
		});
		const { engine } = makeEngine(store);
		await expect(engine(CH, "RUNNING")).resolves.toEqual({
			opened: 0,
			resolved: 0,
		});
	});

	it("an UNSTAMPED sample inside the run's window still counts (#108's column is nullable)", async () => {
		// null means "no run carried this encoding", not "another run's" —
		// dropping the null arm would blind the engine on every channel whose
		// run has no bitmovinEncodingId yet.
		const store = makeStore({
			heartbeats: [disconnectedAt("2026-08-13T10:00:05Z", null)],
		});
		const { engine } = makeEngine(store);
		await expect(engine(CH, "RUNNING")).resolves.toEqual({
			opened: 1,
			resolved: 0,
		});
	});

	it("a channel with NO run row is unscoped, exactly as before #243", async () => {
		const store = makeStore({
			run: null,
			heartbeats: [disconnectedAt("2026-08-13T09:58:00Z", null)],
		});
		const { engine } = makeEngine(store);
		await expect(engine(CH, "RUNNING")).resolves.toEqual({
			opened: 1,
			resolved: 0,
		});
	});

	/**
	 * review-347: the heartbeat sweep already loads this row one statement
	 * earlier for the stale anchor, so it hands the scope over rather than
	 * paying for a second identical query per channel per tick. Threaded and
	 * self-read must produce the SAME window — these arms pin both directions.
	 */
	it("a CALLER-SUPPLIED run scopes the window and costs NO liveChannelRun read", async () => {
		const store = makeStore({
			// The store's own run says the airing began an hour EARLIER, so a
			// self-read would admit the 09:58 row. Only the supplied run's
			// createdAt excludes it — the two cannot be confused.
			run: { id: CURRENT_RUN, createdAt: new Date("2026-08-13T09:00:00Z") },
			heartbeats: [disconnectedAt("2026-08-13T09:58:00Z", null)],
		});
		const { engine } = makeEngine(store);
		await expect(
			engine(CH, "RUNNING", undefined, undefined, {
				id: CURRENT_RUN,
				createdAt: RUN_CREATED_AT,
			}),
		).resolves.toEqual({ opened: 0, resolved: 0 });
		expect(store.prisma.liveChannelRun.findFirst).not.toHaveBeenCalled();
	});

	it("a caller-supplied NULL means 'looked, no run row' — unscoped, and still no read", async () => {
		const store = makeStore({
			heartbeats: [disconnectedAt("2026-08-13T09:58:00Z", null)],
		});
		const { engine } = makeEngine(store);
		await expect(
			engine(CH, "RUNNING", undefined, undefined, null),
		).resolves.toEqual({ opened: 1, resolved: 0 });
		expect(store.prisma.liveChannelRun.findFirst).not.toHaveBeenCalled();
	});

	it("OMITTING the run still self-reads it — the fallback cannot be lost by a forgetful caller", async () => {
		const store = makeStore({
			heartbeats: [disconnectedAt("2026-08-13T09:58:00Z", null)],
		});
		const { engine } = makeEngine(store);
		await expect(engine(CH, "RUNNING")).resolves.toEqual({
			opened: 0,
			resolved: 0,
		});
		expect(store.prisma.liveChannelRun.findFirst).toHaveBeenCalledTimes(1);
	});

	it("a re-air RESOLVES the previous run's open event instead of inheriting its breach", async () => {
		// The other half of the same defect: run N ended DISCONNECTED with an
		// open event, run N+1 starts clean. Scoped, the new run's window is
		// empty, nothing breaches, and the stale event resolves.
		const store = makeStore({
			heartbeats: [disconnectedAt("2026-08-13T09:59:00Z", PREVIOUS_RUN)],
			events: [
				{
					id: "99999999-9999-4999-8999-999999999999",
					ruleId: RULE,
					liveChannelId: CH,
					openedAt: new Date("2026-08-13T09:59:30Z"),
					resolvedAt: null,
					context: {},
				},
			],
		});
		const { engine } = makeEngine(store);
		await expect(engine(CH, "RUNNING")).resolves.toEqual({
			opened: 0,
			resolved: 1,
		});
	});
});

/**
 * review-83b C1: an open event whose channel stopped, whose rule was
 * disabled, or whose rule was re-scoped could NEVER resolve — the engine
 * only runs for RUNNING channels with enabled in-scope rules, and no
 * manual resolve existed. 20 probed sweeps left the CRIT banner up. The
 * orphan resolver is the explicit transition.
 */
describe("PROVIDER_WARNING through the engine (the provider's own WARNING/ERROR entries)", () => {
	const KEYFRAME =
		"At least one input video stream key-frame interval is larger than the threshold: 2167 ms >= 2000 ms!";
	const connect = {
		time: "2026-08-13T10:00:19.000Z",
		details: { eventType: "FIRST_CONNECT", message: null },
	};
	const warning = {
		time: "2026-08-13T10:00:21.000Z",
		details: { eventType: "WARNING", message: KEYFRAME },
	};
	const poll = (second: number, events: unknown[]): HeartbeatRow => ({
		at: new Date(RUN_CREATED_AT.getTime() + second * 1000),
		raw: { ingest: { status: "CONNECTED", healthy: true }, events },
		liveChannelRunId: CURRENT_RUN,
	});
	const RULES = [
		{ id: RULE, metric: "PROVIDER_WARNING", threshold: null, windowPolls: 2 },
	];

	it("a WARNING that appears between two polls opens ONE alert carrying the provider's message", async () => {
		const store = makeStore({
			rules: RULES,
			heartbeats: [poll(0, [connect]), poll(30, [connect, warning])],
		});
		const { engine, emitEvent } = makeEngine(store);
		await expect(engine(CH, "RUNNING")).resolves.toEqual({
			opened: 1,
			resolved: 0,
		});
		expect(store.events[0]?.context).toMatchObject({
			eventType: "WARNING",
			message: KEYFRAME,
		});
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "ALERT_OPENED",
				rule: "PROVIDER_WARNING",
				source: "BITMOVIN",
				subject: "INGEST",
			}),
		);
	});

	it("the next poll, with the entry still in the cumulative list, opens NOTHING more (no duplicate)", async () => {
		const store = makeStore({
			rules: RULES,
			heartbeats: [
				poll(0, [connect]),
				poll(30, [connect, warning]),
				poll(60, [connect, warning]),
			],
			events: [
				{
					id: "44444444-4444-4444-8444-444444444444",
					ruleId: RULE,
					liveChannelId: CH,
					openedAt: new Date("2026-08-13T10:00:31Z"),
					resolvedAt: null,
					context: {},
				},
			],
		});
		const { engine, emitEvent } = makeEngine(store);
		await expect(engine(CH, "RUNNING")).resolves.toEqual({
			opened: 0,
			resolved: 0,
		});
		expect(store.events).toHaveLength(1);
		expect(emitEvent).not.toHaveBeenCalled();
	});

	it("resolves after windowPolls polls of silence, while the entry is STILL in the list", async () => {
		const list = [connect, warning];
		const store = makeStore({
			rules: RULES,
			heartbeats: [
				poll(0, [connect]),
				poll(30, list),
				poll(60, list),
				poll(90, list),
			],
			events: [
				{
					id: "44444444-4444-4444-8444-444444444444",
					ruleId: RULE,
					liveChannelId: CH,
					openedAt: new Date("2026-08-13T10:00:31Z"),
					resolvedAt: null,
					context: {},
				},
			],
		});
		const { engine, emitEvent } = makeEngine(store);
		await expect(engine(CH, "RUNNING")).resolves.toEqual({
			opened: 0,
			resolved: 1,
		});
		expect(store.events[0]?.resolvedAt).not.toBeNull();
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "ALERT_RESOLVED",
				rule: "PROVIDER_WARNING",
			}),
		);
	});

	it("fetches ONE row beyond the widest window so the oldest judged poll has its predecessor", async () => {
		const store = makeStore({ rules: RULES, heartbeats: [poll(0, [connect])] });
		const { engine } = makeEngine(store);
		await engine(CH, "RUNNING");
		expect(store.prisma.liveHeartbeat.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ take: 3 }),
		);
	});

	it("the run's FIRST sample already carrying the WARNING opens — its events are new by definition", async () => {
		const store = makeStore({
			rules: RULES,
			heartbeats: [poll(0, [connect, warning])],
		});
		const { engine } = makeEngine(store);
		await expect(engine(CH, "RUNNING")).resolves.toEqual({
			opened: 1,
			resolved: 0,
		});
	});

	it("a rule whose windowPolls exceeds the fetch cap cannot claim the oldest fetched row's entries as new", async () => {
		// windowPolls 25 > MAX_WINDOW_POLLS (20): the fetch is 21 rows and the
		// tail is ALL of them, so the oldest fetched row sits in the tail with
		// its predecessor unfetched. The window is full (21 of 21), so it does
		// NOT start at the run's first sample — that row's WARNING is not news.
		const list = [connect, warning];
		const store = makeStore({
			rules: [
				{
					id: RULE,
					metric: "PROVIDER_WARNING",
					threshold: null,
					windowPolls: 25,
				},
			],
			heartbeats: [
				poll(0, [connect]),
				...Array.from({ length: 21 }, (_, i) => poll(30 * (i + 1), list)),
			],
		});
		const { engine } = makeEngine(store);
		await expect(engine(CH, "RUNNING")).resolves.toEqual({
			opened: 0,
			resolved: 0,
		});
	});

	it("a full window whose oldest row already carries the entry does NOT re-open after the alert resolved", async () => {
		// windowPolls 2 → fetch 3. Four rows exist; the oldest fetched row
		// (30s) carries the WARNING but its predecessor (0s) was not fetched,
		// so nothing in the window is provably new — the silence holds.
		const list = [connect, warning];
		const store = makeStore({
			rules: RULES,
			heartbeats: [
				poll(0, [connect]),
				poll(30, list),
				poll(60, list),
				poll(90, list),
			],
		});
		const { engine } = makeEngine(store);
		await expect(engine(CH, "RUNNING")).resolves.toEqual({
			opened: 0,
			resolved: 0,
		});
	});
});

describe("metric-ownership partition (ledger #161 C3)", () => {
	it("an OPEN DELIVERY alert survives the heartbeat engine — no cross-sweep flapping", async () => {
		// An origin-sweep rule (BITOVP×DELIVERY) with an OPEN event, while
		// the heartbeat says everything is healthy. TWO layers keep this
		// engine's hands off it: the ownership filter (this PR) and core's
		// unknown-metric contract (#83: a metric the evaluator has no case
		// for neither opens nor resolves). MEASURED honestly: dropping the
		// filter ALONE stays green because layer 2 holds — this pin goes red
		// only when BOTH layers fail (someone teaches the evaluator origin
		// metrics AND removes the filter), which is exactly the accident it
		// exists to catch; the filter's own presence is what the design's C3
		// requires of the heartbeat side.
		const store = makeStore({
			rules: [
				{
					id: "55555555-5555-4555-8555-555555555555",
					metric: "ORIGIN_MANIFEST_STALE",
					threshold: null,
					windowPolls: 2,
					severity: "CRIT",
					enabled: true,
					liveChannelId: null,
				},
			],
			heartbeats: [],
			events: [
				{
					id: "66666666-6666-4666-8666-666666666666",
					ruleId: "55555555-5555-4555-8555-555555555555",
					liveChannelId: CH,
					openedAt: new Date(),
					resolvedAt: null,
					context: {},
				},
			],
		});
		const { engine, emitEvent } = makeEngine(store);
		const result = await engine(CH, "RUNNING");
		expect(result).toEqual({ opened: 0, resolved: 0 });
		expect(store.events[0]?.resolvedAt).toBeNull();
		expect(emitEvent).not.toHaveBeenCalled();
	});
});

describe("orphan resolver (review-83b C1)", () => {
	function makeResolver(store: ReturnType<typeof makeStore>) {
		const emitEvent = vi.fn(async () => {});
		const resolver = createOrphanResolver({
			prisma: store.prisma as unknown as AppPrismaClient,
			emitEvent,
			now: () => new Date("2026-08-13T10:00:10Z"),
		});
		return { resolver, emitEvent };
	}

	const openEvent = (over: Partial<EventRow> = {}): EventRow => ({
		id: "44444444-4444-4444-8444-444444444441",
		ruleId: RULE,
		liveChannelId: CH,
		openedAt: new Date("2026-08-13T09:00:00Z"),
		resolvedAt: null,
		context: {},
		...over,
	});

	it("a STOPPED channel's open event resolves + emits (the operator's natural response to a CRIT)", async () => {
		const store = makeStore({ events: [openEvent()] });
		store.ruleOf = () => ({
			enabled: true,
			liveChannelId: null,
			metric: "INPUT_DISCONNECTED",
		});
		const { resolver, emitEvent } = makeResolver(store);
		const result = await resolver(new Set()); // channel NOT running
		expect(result.resolved).toBe(1);
		expect(store.events[0]?.resolvedAt).not.toBeNull();
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "ALERT_RESOLVED",
				liveChannelId: CH,
			}),
		);
	});

	it("a DISABLED rule's open event resolves (Disable is the UI's safe alternative to Delete)", async () => {
		const store = makeStore({ events: [openEvent()] });
		store.ruleOf = () => ({
			enabled: false,
			liveChannelId: null,
			metric: "INPUT_DISCONNECTED",
		});
		const { resolver } = makeResolver(store);
		const result = await resolver(new Set([CH]));
		expect(result.resolved).toBe(1);
	});

	it("a rule RE-SCOPED to another channel resolves its stranded event", async () => {
		const store = makeStore({ events: [openEvent()] });
		store.ruleOf = () => ({
			enabled: true,
			liveChannelId: "55555555-5555-4555-8555-555555555555",
			metric: "BITRATE_BELOW",
		});
		const { resolver } = makeResolver(store);
		const result = await resolver(new Set([CH]));
		expect(result.resolved).toBe(1);
	});

	it("a COVERED event (running channel, enabled in-scope rule) is untouched", async () => {
		const store = makeStore({ events: [openEvent()] });
		store.ruleOf = () => ({
			enabled: true,
			liveChannelId: CH,
			metric: "INPUT_DISCONNECTED",
		});
		const { resolver, emitEvent } = makeResolver(store);
		const result = await resolver(new Set([CH]));
		expect(result.resolved).toBe(0);
		expect(store.events[0]?.resolvedAt).toBeNull();
		expect(emitEvent).not.toHaveBeenCalled();
	});

	it("a GLOBAL rule's event on a running channel is covered", async () => {
		const store = makeStore({ events: [openEvent()] });
		store.ruleOf = () => ({
			enabled: true,
			liveChannelId: null,
			metric: "HEARTBEAT_STALE",
		});
		const { resolver } = makeResolver(store);
		expect((await resolver(new Set([CH]))).resolved).toBe(0);
	});
});
