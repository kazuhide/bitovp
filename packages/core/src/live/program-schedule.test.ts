import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CHANNEL_STARTING_SCHEDULE_ACTIONS,
	DEFAULT_SCHEDULE_START_GRACE_MINUTES,
	deriveProgramSchedule,
	LIVE_SCHEDULE_ACTION_VALUES,
	type LiveScheduleAction,
	liveProgramScheduleSchema,
	MAX_RUN_CAP_MARGIN_MINUTES,
	programScheduleWindowError,
} from "./program-schedule";

const CRED = "00000000-0000-4000-8000-0000000000c1";
const T = (h: number, m = 0) =>
	`2026-09-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

const SLOT = {
	streamUpAt: T(20, 45),
	programStartAt: T(21),
	programEndAt: T(22),
};
const PROVISION_AT = Date.parse(T(20)); // #125: creation = provision; 45 min before stream-up

const SLATE = {
	slate: { source: { credentialId: CRED, bucket: "in", key: "slate.mp4" } },
};

describe("liveProgramScheduleSchema (ordering)", () => {
	it("accepts the canonical slot, with and without a slate", () => {
		expect(liveProgramScheduleSchema.safeParse(SLOT).success).toBe(true);
		expect(
			liveProgramScheduleSchema.safeParse({ ...SLOT, ...SLATE }).success,
		).toBe(true);
	});

	it("rejects streamUp after program start", () => {
		const r = liveProgramScheduleSchema.safeParse({
			...SLOT,
			streamUpAt: T(21, 30),
		});
		expect(r.success).toBe(false);
	});

	it("rejects a program that ends before (or when) it starts", () => {
		expect(
			liveProgramScheduleSchema.safeParse({ ...SLOT, programEndAt: T(21) })
				.success,
		).toBe(false);
	});

	it("rejects a slate whose window is zero — cover was asked for and none exists", () => {
		const r = liveProgramScheduleSchema.safeParse({
			...SLOT,
			streamUpAt: T(21),
			...SLATE,
		});
		expect(r.success).toBe(false);
		if (!r.success) {
			expect(JSON.stringify(r.error.issues)).toContain("slate");
		}
	});

	it("without a slate, streamUp == programStart is legal (no pre-air window needed)", () => {
		expect(
			liveProgramScheduleSchema.safeParse({ ...SLOT, streamUpAt: T(21) })
				.success,
		).toBe(true);
	});
});

describe("programScheduleWindowError (clock checks, split from the schema)", () => {
	const parsed = liveProgramScheduleSchema.parse(SLOT);

	it("refuses a slot in the past", () => {
		expect(programScheduleWindowError(parsed, new Date(T(23)))).toContain(
			"future",
		);
	});

	it("refuses a slot beyond the horizon — the year-typo guard", () => {
		const farOut = liveProgramScheduleSchema.parse({
			streamUpAt: "2027-09-01T20:45:00.000Z",
			programStartAt: "2027-09-01T21:00:00.000Z",
			programEndAt: "2027-09-01T22:00:00.000Z",
		});
		expect(programScheduleWindowError(farOut, new Date(T(10)))).toContain(
			"days out",
		);
	});

	it("accepts a same-day slot", () => {
		expect(programScheduleWindowError(parsed, new Date(T(10)))).toBeNull();
	});
});

describe("feeder-chain derivation (ledger #96)", () => {
	const FEED = {
		programFeed: {
			source: { credentialId: CRED, bucket: "in", key: "ep1.mp4" },
		},
	};

	it("a file-fed program with a slate derives the CHAIN: START, FEEDER_START(slate)@up, FEEDER_SWITCH(program)@air, STOP — and NO splice row", async () => {
		const d = deriveProgramSchedule(
			liveProgramScheduleSchema.parse({ ...SLOT, ...SLATE, ...FEED }),
			{ provisionAtMs: PROVISION_AT },
		);
		expect(d.rows.map((r) => r.action)).toEqual([
			// #125: no START row — the channel provisions at creation.
			"FEEDER_START",
			"FEEDER_SWITCH",
			"STOP",
		]);
		const preAir = d.rows[0];
		const program = d.rows[1];
		expect(preAir?.fireAt.toISOString()).toBe(T(20, 45));
		expect(preAir?.feederSource?.key).toBe("slate.mp4");
		// useful-until = air: past it, starting the slate loop is pointless.
		expect(preAir?.slateUntil?.toISOString()).toBe(T(21));
		expect(program?.fireAt.toISOString()).toBe(T(21));
		expect(program?.feederSource?.key).toBe("ep1.mp4");
		expect(program?.slateUntil?.toISOString()).toBe(T(22));
		// The slate is realised as a FEED — no insertable-content row at all.
		expect(d.rows.some((r) => r.action === "SLATE_IN")).toBe(false);
	});

	it("file-fed with up == air and no slate: chain is START, FEEDER_SWITCH, STOP", () => {
		const d = deriveProgramSchedule(
			liveProgramScheduleSchema.parse({
				...SLOT,
				streamUpAt: T(21),
				...FEED,
			}),
			{ provisionAtMs: PROVISION_AT },
		);
		expect(d.rows.map((r) => r.action)).toEqual(["FEEDER_SWITCH", "STOP"]);
	});

	it("REFUSES a file-fed program with a pre-air window and no slate — the encoder would sit unbound (#95 by construction)", () => {
		const r = liveProgramScheduleSchema.safeParse({ ...SLOT, ...FEED });
		expect(r.success).toBe(false);
		if (!r.success) {
			expect(JSON.stringify(r.error.issues)).toContain("needs a slate");
		}
	});
});

describe("deriveProgramSchedule", () => {
	it("derives STOP alone without a slate — no START row since #125 (creation provisions)", () => {
		const d = deriveProgramSchedule(liveProgramScheduleSchema.parse(SLOT), {
			provisionAtMs: PROVISION_AT,
		});
		expect(d.rows.map((r) => r.action)).toEqual(["STOP"]);
		expect(d.rows[0]?.fireAt.toISOString()).toBe(T(22));
	});

	it("a slate row is armed AT stream-up and bounded by slateUntil, with NO fixed duration", () => {
		const d = deriveProgramSchedule(
			liveProgramScheduleSchema.parse({ ...SLOT, ...SLATE }),
			{ provisionAtMs: PROVISION_AT },
		);
		const slate = d.rows.find((r) => r.action === "SLATE_IN");
		expect(slate?.fireAt.toISOString()).toBe(T(20, 45));
		// The duration is computed AT FIRE TIME from slateUntil: a fixed one
		// would overrun into the program by however late provisioning ran.
		expect(slate?.slateUntil?.toISOString()).toBe(T(21));
		expect(slate).not.toHaveProperty("slateDurationSeconds");
		expect(slate?.slateSource).toEqual({
			credentialId: CRED,
			bucket: "in",
			key: "slate.mp4",
		});
	});

	it("derives the runaway cap from PROVISION to end, plus the margin (#125)", () => {
		const d = deriveProgramSchedule(
			liveProgramScheduleSchema.parse({ ...SLOT, ...SLATE }),
			{ provisionAtMs: PROVISION_AT },
		);
		// 20:45 → 22:00 is 75 minutes; the cap backstops the STOP row.
		// #125: the cap counts from PROVISION (20:00) to end (22:00) — the
		// encoder runs from creation, and a streamUpAt-based span would fire
		// the slate before the program ended.
		expect(d.maxRunMinutes).toBe(120 + MAX_RUN_CAP_MARGIN_MINUTES);
	});

	it("carries the program window for the channel columns", () => {
		const d = deriveProgramSchedule(liveProgramScheduleSchema.parse(SLOT), {
			provisionAtMs: PROVISION_AT,
		});
		expect(d.programStartAt.toISOString()).toBe(T(21));
		expect(d.programEndAt.toISOString()).toBe(T(22));
	});
});

describe("CHANNEL_STARTING_SCHEDULE_ACTIONS (review-234 I1)", () => {
	it("classifies EVERY schedule action, so a new one cannot be forgotten", () => {
		// Table over the whole enum: adding an action to the union without a
		// row here fails to compile (the Record is total), and adding one
		// without deciding its side fails this assertion.
		const canStartAStoppedChannel: Record<LiveScheduleAction, boolean> = {
			START: true,
			// The sweep refuses these unless the channel is ALREADY RUNNING —
			// a slate cuts into a running program, a feeder pushes at a live
			// ingest. Armed on a stopped channel they start nothing and go
			// MISSED, so promising "the schedule will act" would be false.
			STOP: false,
			SLATE_IN: false,
			FEEDER_START: false,
			FEEDER_SWITCH: false,
		};
		for (const [action, canStart] of Object.entries(canStartAStoppedChannel)) {
			expect(
				(CHANNEL_STARTING_SCHEDULE_ACTIONS as readonly string[]).includes(
					action,
				),
				action,
			).toBe(canStart);
		}
	});

	it("the grace default is the number the worker actually uses", () => {
		expect(DEFAULT_SCHEDULE_START_GRACE_MINUTES).toBe(10);
	});

	it("the action union matches the web layer's list — no fork", () => {
		// The same guard the channel-status enum carries: the union was
		// declared twice (inline here, LIVE_SCHEDULE_ACTIONS in the web
		// schemas), which is how a "total" table can cover four of five.
		const shared = readFileSync(
			join(__dirname, "../../../../apps/web/src/lib/live-runtime/schemas.ts"),
			"utf8",
		);
		const block = /LIVE_SCHEDULE_ACTIONS = \[([^\]]*)\]/.exec(shared)?.[1];
		expect(block, "LIVE_SCHEDULE_ACTIONS not found").toBeTruthy();
		const fromWeb = [...(block as string).matchAll(/"([A-Z_]+)"/g)].map(
			(m) => m[1],
		);
		expect(fromWeb).toEqual([...LIVE_SCHEDULE_ACTION_VALUES]);
	});
});
