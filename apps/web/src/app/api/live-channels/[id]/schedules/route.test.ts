import { isStaleGeneration } from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 *  PR2 — arm/list routes. The validation table is the point:
 * arming the past, slate rows without their content triple, content
 * fields on non-slate rows, and the slate READY check (incl. the paging
 * CAP — review-187's non-terminating-pagination class: a constant-full
 * upstream must exhaust the cap, not the process).
 */

const channelFindUnique = vi.fn();
/** : the arm-time generation lookup (latest run by seq). */
const runFindFirst = vi.fn();
const scheduleFindMany = vi.fn();
const scheduleCreate = vi.fn();
const contentList = vi.fn();
const resolveLiveEncoding = vi.fn();
const sampleFindMany = vi.fn();
/** rev367 S-2: the staged-session join for switch rows. */
const sessionFindMany = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			liveChannel: { findUnique: channelFindUnique },
			liveChannelRun: { findFirst: runFindFirst },
			liveSchedule: { findMany: scheduleFindMany, create: scheduleCreate },
			startupSample: { findMany: sampleFindMany },
			feederSession: { findMany: sessionFindMany },
		},
	}),
}));

vi.mock("@/lib/server/live-channel-encoding", () => ({
	resolveLiveEncoding: (args: unknown) => resolveLiveEncoding(args),
}));

import { GET, POST } from "./route";

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000c1";
const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000a1";
const CONTENT_ID = "00000000-0000-4000-8000-0000000000d1";

const ctx = (id = CHANNEL_ID) => ({ params: Promise.resolve({ id }) });

function post(body: Record<string, unknown>) {
	return new Request(`http://test/api/live-channels/${CHANNEL_ID}/schedules`, {
		method: "POST",
		body: JSON.stringify(body),
	});
}

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

beforeEach(() => {
	vi.clearAllMocks();
	channelFindUnique.mockResolvedValue({ id: CHANNEL_ID });
	// : no run by default — a channel that has never aired, which is
	// the state every pre-existing arm case in this file assumes.
	runFindFirst.mockResolvedValue(null);
	sampleFindMany.mockResolvedValue([]);
	scheduleCreate.mockImplementation(async (args: { data: unknown }) => ({
		id: "created",
		...(args.data as Record<string, unknown>),
	}));
	resolveLiveEncoding.mockResolvedValue({
		ok: true,
		encodingId: "enc-1",
		api: {
			encoding: {
				encodings: { live: { insertableContent: { list: contentList } } },
			},
		},
	});
});

describe("GET /schedules", () => {
	it("404s an unknown channel", async () => {
		channelFindUnique.mockResolvedValue(null);
		const res = await GET(new Request("http://test"), ctx());
		expect(res.status).toBe(404);
	});

	it("returns the channel's rows — the ARMED set and the finished set", async () => {
		// : two queries, one flat array. The panel partitions by
		// STATUS, so the route asks for exactly those two buckets.
		scheduleFindMany
			.mockResolvedValueOnce([{ id: "armed-1" }])
			.mockResolvedValueOnce([{ id: "fired-1" }]);
		const res = await GET(new Request("http://test"), ctx());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([{ id: "armed-1" }, { id: "fired-1" }]);
		expect(scheduleFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { liveChannelId: CHANNEL_ID, status: "ARMED" },
				orderBy: { fireAt: "asc" },
			}),
		);
		expect(scheduleFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { liveChannelId: CHANNEL_ID, status: { not: "ARMED" } },
				orderBy: { fireAt: "desc" },
			}),
		);
	});

	it("the NEAREST upcoming rows cannot fall off the window (row #245)", async () => {
		/**
		 * Audit 2026-08-29 IMPORTANT-3. The old query was one
		 * `orderBy fireAt desc, take 200` over the whole table: with 250 rows
		 * armed into the future it returned the 250th…51st — the FURTHEST out
		 * — and dropped both the nearest upcoming rows and every past row.
		 *
		 * The harness is a real ordered store rather than a canned array,
		 * because the defect lives in ORDER × WINDOW: a mock that ignored
		 * `orderBy`/`take` would answer the same rows either way and green the
		 * bug.
		 */
		const day = 86_400_000;
		const base = Date.parse("2026-09-01T00:00:00.000Z");
		const future = Array.from({ length: 250 }, (_, i) => ({
			id: `armed-${i}`,
			status: "ARMED",
			fireAt: new Date(base + (i + 1) * day),
		}));
		const past = Array.from({ length: 50 }, (_, i) => ({
			id: `past-${i}`,
			status: "FIRED",
			fireAt: new Date(base - (i + 1) * day),
		}));
		const all = [...future, ...past];
		scheduleFindMany.mockImplementation(
			async (args: {
				where: { status?: unknown };
				orderBy: { fireAt: "asc" | "desc" };
				take: number;
			}) => {
				const armedOnly = args.where.status === "ARMED";
				const matched = all.filter((row) =>
					args.where.status === undefined
						? true
						: armedOnly
							? row.status === "ARMED"
							: row.status !== "ARMED",
				);
				const sorted = [...matched].sort((a, b) =>
					args.orderBy.fireAt === "asc"
						? a.fireAt.getTime() - b.fireAt.getTime()
						: b.fireAt.getTime() - a.fireAt.getTime(),
				);
				return sorted.slice(0, args.take);
			},
		);
		const res = await GET(new Request("http://test"), ctx());
		const body = (await res.json()) as Array<{ id: string }>;
		const ids = body.map((row) => row.id);
		// The nearest upcoming row, and the 200th-nearest, are both present.
		expect(ids).toContain("armed-0");
		expect(ids).toContain("armed-199");
		// The newest finished row is present too — under the old single
		// descending window every past row was crowded out by future ones.
		expect(ids).toContain("past-0");
		// And the far tail is what gets dropped, which is the safe direction.
		expect(ids).not.toContain("armed-249");
	});

	it("carries the delivery outcome to the panel (ledger #238)", async () => {
		/**
		 * The panel colours a FIRED row from `outcome`, so a projection that
		 * dropped these three fields would silently put every fired row back on
		 * the amber default — visually a regression, and by the DTO's own
		 * fallback rule not an error anywhere. Pinned by ASKING for a `select`
		 * to be absent: the route must return whole rows, because narrowing it
		 * is exactly how the fields would go missing.
		 */
		const row = {
			id: "s1",
			status: "FIRED",
			outcome: "FAILED",
			outcomeAt: new Date("2026-08-29T12:00:00.000Z"),
			outcomeNote: "the provider's scheduled insertion reached ERROR",
		};
		// A FIRED row belongs to the HISTORY query ;
		// `Once` on both so a lingering implementation cannot answer either.
		scheduleFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
		const res = await GET(new Request("http://test"), ctx());
		expect(await res.json()).toEqual([
			{
				id: "s1",
				status: "FIRED",
				outcome: "FAILED",
				outcomeAt: "2026-08-29T12:00:00.000Z",
				outcomeNote: "the provider's scheduled insertion reached ERROR",
			},
		]);
		// BOTH queries, not just the first: narrowing either one is how the
		// fields would go missing.
		for (const call of scheduleFindMany.mock.calls) {
			expect(call[0]).not.toHaveProperty("select");
		}
		expect(scheduleFindMany.mock.calls).toHaveLength(2);
	});

	/**
	 * rev367 S-2 — a switch row carries its staged session's LIVE phase. The
	 * row's own `readyAt` is a write-once record ("first became ready"); a
	 * takeover RE-STAGES the session without touching it, so the record can
	 * say ready over a source nobody holds. The panel reads the session.
	 */
	it("attaches the staged session's LIVE phase to a switch row — and null for a session that is gone", async () => {
		const armedSwitch = {
			id: "sw1",
			action: "FEEDER_SWITCH",
			status: "ARMED",
			feederSessionId: "fs-1",
			// The stale record the join exists to outrank.
			readyAt: new Date("2026-08-29T09:57:00.000Z"),
		};
		const goneSwitch = {
			id: "sw2",
			action: "FEEDER_SWITCH",
			status: "ARMED",
			feederSessionId: "fs-gone",
		};
		const plain = { id: "s-armed", action: "START", status: "ARMED" };
		scheduleFindMany
			.mockResolvedValueOnce([armedSwitch, goneSwitch, plain])
			.mockResolvedValueOnce([]);
		sessionFindMany.mockResolvedValueOnce([
			{
				id: "fs-1",
				status: "DOWNLOADING",
				commitAt: new Date("2026-08-29T10:00:00.000Z"),
				readyAt: null,
				committedAt: null,
			},
		]);
		const res = await GET(new Request("http://test"), ctx());
		const rows = (await res.json()) as Record<string, unknown>[];
		expect(rows[0]?.stagedSession).toEqual({
			id: "fs-1",
			status: "DOWNLOADING",
			commitAt: "2026-08-29T10:00:00.000Z",
			readyAt: null,
			committedAt: null,
		});
		// A named session that no longer exists is an explicit null…
		expect(rows[1]).toHaveProperty("stagedSession", null);
		// …and a row that names none keeps its exact prior shape.
		expect(rows[2]).not.toHaveProperty("stagedSession");
		// The join selects the phase columns only — never target or logTail.
		expect(sessionFindMany).toHaveBeenCalledWith({
			where: { id: { in: ["fs-1", "fs-gone"] } },
			select: {
				id: true,
				status: true,
				commitAt: true,
				readyAt: true,
				committedAt: true,
			},
		});
	});
});

describe("POST /schedules — validation table", () => {
	it("arming the past is refused (the sweep's late policies are for rows that BECAME late)", async () => {
		const res = await POST(post({ action: "STOP", fireAt: PAST }), ctx());
		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({
			details: { code: "SCHEDULE_FIRE_TIME_NOT_FUTURE" },
		});
		expect(scheduleCreate).not.toHaveBeenCalled();
	});

	it("SLATE_IN without content/duration/account fails the schema", async () => {
		const res = await POST(post({ action: "SLATE_IN", fireAt: FUTURE }), ctx());
		// validationError answers 400 for schema refusals; 422 is reserved
		// for semantically-valid-but-refused (past fireAt, content state).
		expect(res.status).toBe(400);
		expect(resolveLiveEncoding).not.toHaveBeenCalled();
	});

	it("FEEDER rows cannot be armed manually — schedule-derived only (review-226 I3)", async () => {
		// Widening the display enum widened this schema too; without the
		// refinement a source-less feeder row would be created for the sweep
		// to ERROR. 400 at the schema, with the reason named.
		for (const action of ["FEEDER_START", "FEEDER_SWITCH"] as const) {
			const res = await POST(post({ action, fireAt: FUTURE }), ctx());
			expect(res.status).toBe(400);
		}
		expect(resolveLiveEncoding).not.toHaveBeenCalled();
	});

	it("content fields on a START row are refused", async () => {
		const res = await POST(
			post({
				action: "START",
				fireAt: FUTURE,
				insertableContentId: CONTENT_ID,
			}),
			ctx(),
		);
		expect(res.status).toBe(400);
		expect(scheduleCreate).not.toHaveBeenCalled();
	});

	it("arms a START with no Bitmovin contact at all", async () => {
		const res = await POST(post({ action: "START", fireAt: FUTURE }), ctx());
		expect(res.status).toBe(201);
		expect(resolveLiveEncoding).not.toHaveBeenCalled();
		expect(scheduleCreate).toHaveBeenCalledWith({
			data: {
				liveChannelId: CHANNEL_ID,
				// : NULL because this fixture's channel has never run.
				// Asserted in the EXACT shape so a stray field cannot slip in.
				liveChannelRunId: null,
				action: "START",
				fireAt: new Date(FUTURE),
				insertableContentId: null,
				slateDurationSeconds: null,
				airAt: null,
			},
		});
	});

	it("persists the airAt deadline pair on a START (ledger #160 PR2)", async () => {
		const AIR = "2027-01-01T01:00:00.000Z";
		const res = await POST(
			post({
				action: "START",
				fireAt: FUTURE,
				airAt: AIR,
				deadlineMarginSeconds: 600,
			}),
			ctx(),
		);
		expect(res.status).toBe(201);
		expect(scheduleCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				airAt: new Date(AIR),
				deadlineMarginSeconds: 600,
			}),
		});
	});

	it("refuses an airAt at or before fireAt — an already-expired deadline would false-alert on the next tick", async () => {
		const res = await POST(
			post({ action: "START", fireAt: FUTURE, airAt: FUTURE }),
			ctx(),
		);
		expect(res.status).toBe(400);
	});

	it("refuses airAt on a non-START row — the deadline scan never reads those", async () => {
		const res = await POST(
			post({ action: "STOP", fireAt: FUTURE, airAt: FUTURE }),
			ctx(),
		);
		expect(res.status).toBe(400);
	});

	it("404s an unknown channel before touching Bitmovin", async () => {
		channelFindUnique.mockResolvedValue(null);
		const res = await POST(post({ action: "STOP", fireAt: FUTURE }), ctx());
		expect(res.status).toBe(404);
		expect(resolveLiveEncoding).not.toHaveBeenCalled();
	});
});

describe("POST /schedules — the slate READY check", () => {
	const slateBody = {
		action: "SLATE_IN",
		fireAt: FUTURE,
		bitmovinAccountId: ACCOUNT_ID,
		insertableContentId: CONTENT_ID,
		slateDurationSeconds: 300,
	};

	it("arms when the content is READY, persisting the content params", async () => {
		contentList.mockResolvedValue({
			items: [{ id: CONTENT_ID, status: "READY" }],
		});
		const res = await POST(post(slateBody), ctx());
		expect(res.status).toBe(201);
		expect(scheduleCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				action: "SLATE_IN",
				insertableContentId: CONTENT_ID,
				slateDurationSeconds: 300,
			}),
		});
	});

	it("finds content on a LATER page (pagination is real, not first-page-only)", async () => {
		const fullPage = Array.from({ length: 100 }, (_, i) => ({
			id: `other-${i}`,
			status: "READY",
		}));
		contentList
			.mockResolvedValueOnce({ items: fullPage })
			.mockResolvedValueOnce({ items: [{ id: CONTENT_ID, status: "READY" }] });
		const res = await POST(post(slateBody), ctx());
		expect(res.status).toBe(201);
		expect(contentList).toHaveBeenCalledTimes(2);
	});

	it("refuses content that is not READY, naming its status", async () => {
		contentList.mockResolvedValue({
			items: [{ id: CONTENT_ID, status: "DOWNLOADING" }],
		});
		const res = await POST(post(slateBody), ctx());
		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({
			error: expect.stringContaining("DOWNLOADING"),
			details: {
				code: "SCHEDULE_CONTENT_NOT_READY",
				status: "DOWNLOADING",
			},
		});
		expect(scheduleCreate).not.toHaveBeenCalled();
	});

	it("refuses content that does not exist on the current encoding", async () => {
		contentList.mockResolvedValue({ items: [] });
		const res = await POST(post(slateBody), ctx());
		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({
			details: { code: "SCHEDULE_CONTENT_NOT_FOUND" },
		});
		expect(scheduleCreate).not.toHaveBeenCalled();
	});

	it("a constant-full upstream exhausts the page CAP, not the process", async () => {
		// Every page full, target never present — the review-187 class.
		contentList.mockResolvedValue({
			items: Array.from({ length: 100 }, (_, i) => ({
				id: `decoy-${i}`,
				status: "READY",
			})),
		});
		const res = await POST(post(slateBody), ctx());
		expect(res.status).toBe(422);
		expect(contentList).toHaveBeenCalledTimes(5);
	});

	it("propagates the resolver's refusal (no encoding yet)", async () => {
		resolveLiveEncoding.mockResolvedValue({
			ok: false,
			response: new Response(JSON.stringify({ error: "no encoding" }), {
				status: 409,
			}),
		});
		const res = await POST(post(slateBody), ctx());
		expect(res.status).toBe(409);
		expect(scheduleCreate).not.toHaveBeenCalled();
	});
});

/**
 *  PR3 — arm-time auto-lead. The resolution happens HERE, once
 * (never in the sweep); the profile's honesty contract decides P90 vs the
 * default; and a manually chosen EARLIER fireAt always survives.
 */
describe("POST /schedules — auto-lead (ledger #160 PR3)", () => {
	const AIR = new Date(Date.now() + 2 * 3_600_000).toISOString();

	function profileSamples(n: number, seconds: number) {
		return Array.from({ length: n }, () => ({
			outcome: "RUNNING",
			queueSeconds: seconds,
			observedAt: new Date(),
		}));
	}

	it("the profile query reads CHANNEL samples ONLY — a probe-fed P90 would shorten the lead in the dangerous direction (review-pr34 B1)", async () => {
		sampleFindMany.mockResolvedValue(profileSamples(20, 600));
		await POST(
			post({ action: "START", airAt: AIR, autoLeadTime: true }),
			ctx(),
		);
		expect(sampleFindMany.mock.calls[0]?.[0].where).toMatchObject({
			source: "CHANNEL",
		});
	});

	it("derives fireAt = airAt − (P90 + margin) from the region profile", async () => {
		sampleFindMany.mockResolvedValue(profileSamples(20, 600));
		const res = await POST(
			post({ action: "START", airAt: AIR, autoLeadTime: true }),
			ctx(),
		);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.autoLead.source).toBe("P90");
		expect(body.autoLead.p90Seconds).toBe(600);
		// lead = 600 + 180 (core default margin)
		expect(body.autoLead.leadSeconds).toBe(780);
		const created = scheduleCreate.mock.calls[0]?.[0].data;
		expect(created.autoLeadTime).toBe(true);
		expect(created.fireAt.getTime()).toBe(Date.parse(AIR) - 780_000);
		expect(created.note).toContain("P90 600s");
	});

	it("falls back to the default lead below the honesty bar — and says so", async () => {
		sampleFindMany.mockResolvedValue(profileSamples(3, 600));
		const res = await POST(
			post({ action: "START", airAt: AIR, autoLeadTime: true }),
			ctx(),
		);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.autoLead.source).toBe("DEFAULT");
		expect(body.autoLead.leadSeconds).toBe(900);
		const created = scheduleCreate.mock.calls[0]?.[0].data;
		expect(created.note).toContain("insufficient data");
	});

	it("never shortens a manually chosen EARLIER fireAt", async () => {
		sampleFindMany.mockResolvedValue(profileSamples(20, 600));
		const manual = new Date(Date.parse(AIR) - 3_600_000).toISOString();
		const res = await POST(
			post({ action: "START", airAt: AIR, fireAt: manual, autoLeadTime: true }),
			ctx(),
		);
		expect(res.status).toBe(201);
		const created = scheduleCreate.mock.calls[0]?.[0].data;
		expect(created.fireAt.getTime()).toBe(Date.parse(manual));
	});

	it("a manually chosen LATER fireAt loses to the resolution — auto extends lead, never trims it", async () => {
		sampleFindMany.mockResolvedValue(profileSamples(20, 600));
		const manual = new Date(Date.parse(AIR) - 60_000).toISOString();
		const res = await POST(
			post({ action: "START", airAt: AIR, fireAt: manual, autoLeadTime: true }),
			ctx(),
		);
		expect(res.status).toBe(201);
		const created = scheduleCreate.mock.calls[0]?.[0].data;
		expect(created.fireAt.getTime()).toBe(Date.parse(AIR) - 780_000);
	});

	it("422s when the air time is closer than the resolved lead", async () => {
		sampleFindMany.mockResolvedValue(profileSamples(20, 600));
		const soon = new Date(Date.now() + 300_000).toISOString();
		const res = await POST(
			post({ action: "START", airAt: soon, autoLeadTime: true }),
			ctx(),
		);
		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({
			details: {
				code: "SCHEDULE_LEAD_TIME_TOO_SHORT",
				seconds: expect.any(Number),
			},
		});
	});

	it("schema: auto-lead demands START and an airAt; a bare arm still demands fireAt", async () => {
		expect(
			(
				await POST(
					post({ action: "STOP", fireAt: FUTURE, autoLeadTime: true }),
					ctx(),
				)
			).status,
		).toBe(400);
		expect(
			(await POST(post({ action: "START", autoLeadTime: true }), ctx())).status,
		).toBe(400);
		expect((await POST(post({ action: "START" }), ctx())).status).toBe(400);
	});
});

/**
 *  — arming past the moment the run ends by itself. The 2026-08-29
 * live audit armed feeder / slate / STOP rows minutes past a
 * `streamTimeoutMinutes = 6`; the provider ended the encoding on time and the
 * rows fired into nothing, recorded FIRED.
 */
describe("POST /schedules — the run window (ledger #247)", () => {
	const NOW = "2026-09-01T12:00:00.000Z";
	/** The run started when the channel was created — #125: creation = provision. */
	const CREATED_AT = new Date("2026-09-01T12:00:00.000Z");

	function channel(over: {
		autoShutdown?: Record<string, number>;
		maxRunMinutes?: number | null;
		runningSince?: Date | null;
	}) {
		return {
			id: CHANNEL_ID,
			plan: over.autoShutdown
				? { start: { streamKey: "abc", autoShutdown: over.autoShutdown } }
				: null,
			maxRunMinutes: over.maxRunMinutes ?? null,
			runningSince: over.runningSince ?? null,
			createdAt: CREATED_AT,
		};
	}

	async function arm(body: Record<string, unknown>) {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		try {
			const res = await POST(post(body), ctx());
			return { status: res.status, body: await res.json() };
		} finally {
			vi.useRealTimers();
		}
	}

	it("refuses a STOP past the provider's streamTimeoutMinutes, naming the knob and both instants", async () => {
		channelFindUnique.mockResolvedValue(
			channel({ autoShutdown: { streamTimeoutMinutes: 6 } }),
		);
		const res = await arm({
			action: "STOP",
			fireAt: "2026-09-01T12:20:00.000Z",
		});
		expect(res.status).toBe(422);
		expect(res.body.error).toBe(
			"streamTimeoutMinutes=6 ends the run by 2026-09-01T12:06:00.000Z; the STOP at 2026-09-01T12:20:00.000Z cannot fire into a live encoding",
		);
		expect(res.body.details).toEqual({
			code: "SCHEDULE_OUTSIDE_RUN_WINDOW",
		});
		expect(scheduleCreate).not.toHaveBeenCalled();
	});

	it("arms a STOP inside the window and refuses it AT the bound", async () => {
		channelFindUnique.mockResolvedValue(
			channel({ autoShutdown: { streamTimeoutMinutes: 6 } }),
		);
		expect(
			(await arm({ action: "STOP", fireAt: "2026-09-01T12:05:59.999Z" }))
				.status,
		).toBe(201);
		expect(
			(await arm({ action: "STOP", fireAt: "2026-09-01T12:06:00.000Z" }))
				.status,
		).toBe(422);
	});

	it("our own maxRunMinutes bounds arming too, measured from runningSince", async () => {
		channelFindUnique.mockResolvedValue(
			channel({
				maxRunMinutes: 30,
				runningSince: new Date("2026-09-01T12:10:00.000Z"),
			}),
		);
		// The cap runs to 12:40 from runningSince, not to 12:30 from createdAt.
		expect(
			(await arm({ action: "STOP", fireAt: "2026-09-01T12:35:00.000Z" }))
				.status,
		).toBe(201);
		const late = await arm({
			action: "STOP",
			fireAt: "2026-09-01T12:45:00.000Z",
		});
		expect(late.status).toBe(422);
		expect(late.body.error).toContain("maxRunMinutes=30");
		expect(late.body.details).toEqual({
			code: "SCHEDULE_OUTSIDE_RUN_WINDOW",
		});
	});

	it("exempts START — it begins a NEW run whose shutdown clock restarts (#108)", async () => {
		channelFindUnique.mockResolvedValue(
			channel({ autoShutdown: { streamTimeoutMinutes: 6 } }),
		);
		const res = await arm({
			action: "START",
			fireAt: "2026-09-01T18:00:00.000Z",
		});
		expect(res.status).toBe(201);
		expect(scheduleCreate).toHaveBeenCalled();
	});

	it("refuses nothing on a channel with no auto-shutdown and no cap", async () => {
		channelFindUnique.mockResolvedValue(channel({}));
		expect(
			(await arm({ action: "STOP", fireAt: "2027-09-01T12:00:00.000Z" }))
				.status,
		).toBe(201);
	});

	it("refuses before the SLATE_IN content lookup — an impossible row costs no Bitmovin calls", async () => {
		channelFindUnique.mockResolvedValue(
			channel({ autoShutdown: { streamTimeoutMinutes: 6 } }),
		);
		const res = await arm({
			action: "SLATE_IN",
			fireAt: "2026-09-01T12:20:00.000Z",
			bitmovinAccountId: ACCOUNT_ID,
			insertableContentId: CONTENT_ID,
			slateDurationSeconds: 300,
		});
		expect(res.status).toBe(422);
		expect(res.body.error).toContain("the SLATE_IN at");
		expect(resolveLiveEncoding).not.toHaveBeenCalled();
		expect(contentList).not.toHaveBeenCalled();
	});

	it("names the conditional knobs on the 201 instead of refusing on them", async () => {
		channelFindUnique.mockResolvedValue(
			channel({
				autoShutdown: {
					bytesReadTimeoutSeconds: 3600,
					waitingForFirstConnectTimeoutMinutes: 10,
				},
			}),
		);
		const res = await arm({
			action: "STOP",
			fireAt: "2026-09-01T20:00:00.000Z",
		});
		expect(res.status).toBe(201);
		expect(
			(res.body.autoShutdownWarnings as { knob: string }[]).map((w) => w.knob),
		).toEqual([
			"bytesReadTimeoutSeconds",
			"waitingForFirstConnectTimeoutMinutes",
		]);
	});
});

/**
 * , review-358 IMPORTANT — WHICH AIRING was this row armed for?
 *
 * `liveChannelRunId` NULL means two different things and the sweep's lazy
 * bind cannot tell them apart: a creation-time row written before any run
 * existed (which must stay lazy, or a re-air refuses its own programme), and
 * a row armed from the panel while an airing was already on (which is bound
 * to THAT airing). This door knows which one it is.
 */
describe("POST /schedules — arm-time generation bind (row #241)", () => {
	const RUN_1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
	const RUN_2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

	it("stamps the LIVE run when one is already on the air", async () => {
		runFindFirst.mockResolvedValue({ id: RUN_1, status: "RUNNING" });
		const res = await POST(post({ action: "STOP", fireAt: FUTURE }), ctx());
		expect(res.status).toBe(201);
		expect(runFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { liveChannelId: CHANNEL_ID },
				orderBy: { seq: "desc" },
			}),
		);
		expect(scheduleCreate.mock.calls[0]?.[0]?.data).toMatchObject({
			liveChannelRunId: RUN_1,
		});
	});

	it("the stamped row is REFUSED by the sweep's own rule once the channel re-airs — the silent rebind, closed", async () => {
		/**
		 * The CONSEQUENCE, not the shape. Without the stamp the row is NULL,
		 * and NULL is indistinguishable from a creation-time row: the sweep's
		 * lazy bind only runs when a row is first evaluated as DUE, so a row
		 * armed during run 1 whose fireAt lands after run 1 ended and run 2
		 * began is never evaluated during run 1 at all — it would bind to run 2
		 * and fire into the wrong airing.
		 *
		 * `isStaleGeneration` is the sweep's OWN comparison (core owns it), so
		 * this asserts against the real rule, not a restatement of it.
		 */
		runFindFirst.mockResolvedValue({ id: RUN_1, status: "RUNNING" });
		await POST(post({ action: "STOP", fireAt: FUTURE }), ctx());
		const armed = scheduleCreate.mock.calls[0]?.[0]?.data as {
			liveChannelRunId: string | null;
		};
		// A tick DURING run 1: the row is due against the airing it was armed
		// for, so it fires exactly as before.
		expect(isStaleGeneration(armed.liveChannelRunId, RUN_1)).toBe(false);
		// A tick AFTER the re-air: run 2 is current, and the row is refused.
		expect(isStaleGeneration(armed.liveChannelRunId, RUN_2)).toBe(true);
	});

	it("stamps a PROVISIONING run too — the airing has begun even before it is RUNNING", async () => {
		runFindFirst.mockResolvedValue({ id: RUN_1, status: "PROVISIONING" });
		await POST(post({ action: "STOP", fireAt: FUTURE }), ctx());
		expect(scheduleCreate.mock.calls[0]?.[0]?.data).toMatchObject({
			liveChannelRunId: RUN_1,
		});
	});

	it("leaves NULL on a channel that has never run — the lazy bind still owns those", async () => {
		runFindFirst.mockResolvedValue(null);
		await POST(post({ action: "STOP", fireAt: FUTURE }), ctx());
		expect(scheduleCreate.mock.calls[0]?.[0]?.data).toMatchObject({
			liveChannelRunId: null,
		});
	});

	it("leaves NULL when the latest run is TERMINAL — a stop armed tonight must not be bound to the airing that already ended", async () => {
		// The dangerous direction: binding to run 1 here would make the sweep
		// refuse this row against tomorrow's re-air, which is the very run it
		// exists to stop.
		runFindFirst.mockResolvedValue({ id: RUN_1, status: "STOPPED" });
		await POST(post({ action: "STOP", fireAt: FUTURE }), ctx());
		expect(scheduleCreate.mock.calls[0]?.[0]?.data).toMatchObject({
			liveChannelRunId: null,
		});
	});
});
