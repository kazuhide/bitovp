import { describe, expect, it } from "vitest";
import {
	CHANNEL_STARTING_SCHEDULE_ACTIONS,
	LIVE_SCHEDULE_ACTION_VALUES,
	type LiveScheduleAction,
} from "./program-schedule";
import {
	isRunScopedScheduleAction,
	LIVE_AUTO_SHUTDOWN_KNOB_KIND,
	type LiveRunWindowPlan,
	liveRunWindow,
	liveRunWindowPlanFrom,
	programEndBeyondRunWindow,
	RUN_SCOPED_SCHEDULE_ACTIONS,
	scheduleBeyondRunWindow,
} from "./run-window";
import { liveAutoShutdownSchema } from "./schema";

/**
 *  — the cross-check the 2026-08-29 live audit's paid runs #1/#2
 * proved missing: `streamTimeoutMinutes = 6` and then feeder/slate/STOP rows
 * minutes past it, all accepted.
 *
 * Literal clock, no `Date.now`: every instant below is written out, so the
 * boundary arms (at the bound / one ms either side) mean what they say.
 */
const START = Date.parse("2026-09-01T12:00:00.000Z");
const MIN = 60_000;

function planWith(
	autoShutdown: Record<string, number>,
): NonNullable<LiveRunWindowPlan> {
	return { start: { autoShutdown } };
}

describe("auto-shutdown knob classification", () => {
	/**
	 * The population is the SCHEMA's own key set, not a second hand-written
	 * list — a knob added to `liveAutoShutdownSchema` (because the SDK grew
	 * one) fails here as well as at the `satisfies` in run-window.ts. Two
	 * instruments, two routes: the type check cannot see a runtime filter and
	 * this cannot see a compile error.
	 */
	it("classifies every field of liveAutoShutdownSchema and nothing else", () => {
		expect(Object.keys(LIVE_AUTO_SHUTDOWN_KNOB_KIND).sort()).toEqual(
			Object.keys(liveAutoShutdownSchema.shape).sort(),
		);
	});

	it("holds exactly one HARD knob — the unconditional runtime cap", () => {
		expect(LIVE_AUTO_SHUTDOWN_KNOB_KIND).toEqual({
			// "Automatically shutdown the live stream after a predefined
			// runtime in minutes" — no input event required.
			streamTimeoutMinutes: "hard",
			// "…if there is no input anymore for N seconds" — an idle gap.
			bytesReadTimeoutSeconds: "conditional",
			// "…if input is never connected for N minutes" — voided by any
			// connection.
			waitingForFirstConnectTimeoutMinutes: "conditional",
		});
	});
});

describe("liveRunWindow", () => {
	it("no knobs, no cap ⇒ no bound at all (nothing may be refused)", () => {
		const w = liveRunWindow(null, START);
		expect(w.bound).toBeNull();
		expect(w.endsAtMs).toBeNull();
		expect(w.bounds).toEqual([]);
		expect(w.conditional).toEqual([]);
		expect(liveRunWindow({ start: {} }, START).bound).toBeNull();
		expect(
			liveRunWindow({ start: { autoShutdown: {} } }, START).bound,
		).toBeNull();
	});

	it("streamTimeoutMinutes bounds the run at start + N minutes", () => {
		const w = liveRunWindow(planWith({ streamTimeoutMinutes: 6 }), START);
		expect(w.endsAtMs).toBe(Date.parse("2026-09-01T12:06:00.000Z"));
		expect(w.bound).toEqual({
			knob: "streamTimeoutMinutes",
			minutes: 6,
			endsAtMs: Date.parse("2026-09-01T12:06:00.000Z"),
		});
	});

	it("maxRunMinutes bounds the run with the sweep's own arithmetic", () => {
		const w = liveRunWindow(null, START, { maxRunMinutes: 90 });
		expect(w.endsAtMs).toBe(Date.parse("2026-09-01T13:30:00.000Z"));
		expect(w.bound?.knob).toBe("maxRunMinutes");
	});

	it("takes the TIGHTEST bound and keeps the rest, tightest first", () => {
		const w = liveRunWindow(planWith({ streamTimeoutMinutes: 120 }), START, {
			maxRunMinutes: 30,
		});
		expect(w.bounds.map((b) => b.knob)).toEqual([
			"maxRunMinutes",
			"streamTimeoutMinutes",
		]);
		expect(w.endsAtMs).toBe(Date.parse("2026-09-01T12:30:00.000Z"));
	});

	it("accepts a Date anchor and a millisecond anchor identically", () => {
		expect(liveRunWindow(null, new Date(START), { maxRunMinutes: 5 })).toEqual(
			liveRunWindow(null, START, { maxRunMinutes: 5 }),
		);
	});

	it("ignores knobs that carry no usable number", () => {
		expect(
			liveRunWindow({ start: { autoShutdown: undefined } }, START).bound,
		).toBeNull();
		expect(
			liveRunWindow(null, START, { maxRunMinutes: null }).bound,
		).toBeNull();
		expect(liveRunWindow(null, START, { maxRunMinutes: 0 }).bound).toBeNull();
	});

	/**
	 * The CONDITIONAL knobs never produce a bound — that is the whole rule
	 * ("only validate against the HARD ones"). They produce a sentence that
	 * names the knob, so the operator learns the run can still end early.
	 */
	it("bytesReadTimeoutSeconds warns and never bounds", () => {
		const w = liveRunWindow(planWith({ bytesReadTimeoutSeconds: 3600 }), START);
		expect(w.bound).toBeNull();
		expect(w.conditional).toHaveLength(1);
		expect(w.conditional[0]?.knob).toBe("bytesReadTimeoutSeconds");
		expect(w.conditional[0]?.message).toContain("bytesReadTimeoutSeconds=3600");
		expect(w.conditional[0]?.message).toContain("after the input stops");
	});

	it("waitingForFirstConnectTimeoutMinutes warns with its instant and never bounds", () => {
		const w = liveRunWindow(
			planWith({ waitingForFirstConnectTimeoutMinutes: 10 }),
			START,
		);
		expect(w.bound).toBeNull();
		expect(w.conditional[0]?.message).toContain("2026-09-01T12:10:00.000Z");
		expect(w.conditional[0]?.message).toContain(
			"if no input has ever connected",
		);
	});

	it("a conditional knob does not suppress the hard one beside it", () => {
		const w = liveRunWindow(
			planWith({ bytesReadTimeoutSeconds: 60, streamTimeoutMinutes: 6 }),
			START,
		);
		expect(w.bound?.knob).toBe("streamTimeoutMinutes");
		expect(w.conditional.map((c) => c.knob)).toEqual([
			"bytesReadTimeoutSeconds",
		]);
	});
});

describe("liveRunWindowPlanFrom (stored plan JSON)", () => {
	it("reads the knobs off a whole stored plan", () => {
		const stored = JSON.parse(
			JSON.stringify({
				planVersion: 1,
				name: "ch",
				start: { streamKey: "abc", autoShutdown: { streamTimeoutMinutes: 6 } },
			}),
		) as unknown;
		expect(
			liveRunWindow(liveRunWindowPlanFrom(stored), START).bound?.knob,
		).toBe("streamTimeoutMinutes");
	});

	/**
	 * The population argument: a stored plan that no longer validates as a
	 * whole must keep its bound. A `liveChannelPlanSchema` parse would return
	 * null here and the guard would go quiet on exactly the oldest channels.
	 */
	it("keeps the bound on a plan the full schema would reject", () => {
		const drifted = {
			// No planVersion, no bitmovin/liveInput/outputs, plus a key the
			// strict plan schema has never heard of.
			surpriseFieldFromAFutureSchema: true,
			start: { autoShutdown: { streamTimeoutMinutes: 6 } },
		} as unknown;
		expect(liveRunWindow(liveRunWindowPlanFrom(drifted), START).endsAtMs).toBe(
			Date.parse("2026-09-01T12:06:00.000Z"),
		);
	});

	it("ignores unusable values and absent blocks rather than guessing", () => {
		expect(liveRunWindowPlanFrom(null)).toBeNull();
		expect(liveRunWindowPlanFrom({})).toBeNull();
		expect(liveRunWindowPlanFrom({ start: {} })).toBeNull();
		expect(
			liveRunWindow(
				liveRunWindowPlanFrom({
					start: { autoShutdown: { streamTimeoutMinutes: "6" } },
				}),
				START,
			).bound,
		).toBeNull();
	});
});

describe("run-scoped schedule actions", () => {
	it("is the total action union minus the channel-STARTING ones", () => {
		expect([...RUN_SCOPED_SCHEDULE_ACTIONS].sort()).toEqual(
			LIVE_SCHEDULE_ACTION_VALUES.filter(
				(a) =>
					!(
						CHANNEL_STARTING_SCHEDULE_ACTIONS as readonly LiveScheduleAction[]
					).includes(a),
			)
				.slice()
				.sort(),
		);
		// Named too, so a union edit that changes the SET is visible here and
		// not just re-derived into agreement with itself.
		expect([...RUN_SCOPED_SCHEDULE_ACTIONS].sort()).toEqual([
			"FEEDER_START",
			"FEEDER_SWITCH",
			"SLATE_IN",
			"STOP",
		]);
		expect(isRunScopedScheduleAction("START")).toBe(false);
	});
});

describe("scheduleBeyondRunWindow — the boundary table", () => {
	/**
	 * Each HARD knob × a fire time before / at / after the bound it produces.
	 * `at` is refused: at exactly that instant the run is ending, so the row
	 * is a race and not a schedule.
	 */
	const cases: {
		knob: string;
		window: ReturnType<typeof liveRunWindow>;
		endsAtMs: number;
	}[] = [
		{
			knob: "streamTimeoutMinutes",
			window: liveRunWindow(planWith({ streamTimeoutMinutes: 6 }), START),
			endsAtMs: START + 6 * MIN,
		},
		{
			knob: "maxRunMinutes",
			window: liveRunWindow(null, START, { maxRunMinutes: 6 }),
			endsAtMs: START + 6 * MIN,
		},
	];

	for (const { knob, window, endsAtMs } of cases) {
		it(`${knob}: a row one ms BEFORE the bound is accepted`, () => {
			expect(
				scheduleBeyondRunWindow(window, {
					action: "STOP",
					fireAtMs: endsAtMs - 1,
				}),
			).toBeNull();
		});

		it(`${knob}: a row exactly AT the bound is refused`, () => {
			const reason = scheduleBeyondRunWindow(window, {
				action: "STOP",
				fireAtMs: endsAtMs,
			});
			expect(reason).toContain(`${knob}=6`);
			expect(reason).toContain("2026-09-01T12:06:00.000Z");
		});

		it(`${knob}: a row AFTER the bound is refused, naming the knob and both instants`, () => {
			expect(
				scheduleBeyondRunWindow(window, {
					action: "STOP",
					fireAtMs: Date.parse("2026-09-01T12:20:00.000Z"),
				}),
			).toBe(
				`${knob}=6 ends the run by 2026-09-01T12:06:00.000Z; the STOP at 2026-09-01T12:20:00.000Z cannot fire into a live encoding`,
			);
		});
	}

	it("names the action it was given — the audit's feeder and slate rows too", () => {
		const window = liveRunWindow(planWith({ streamTimeoutMinutes: 6 }), START);
		const late = Date.parse("2026-09-01T12:20:00.000Z");
		for (const action of RUN_SCOPED_SCHEDULE_ACTIONS) {
			expect(
				scheduleBeyondRunWindow(window, { action, fireAtMs: late }),
			).toContain(`the ${action} at`);
		}
	});

	it("exempts START — it begins a NEW run whose clocks restart (#108)", () => {
		const window = liveRunWindow(planWith({ streamTimeoutMinutes: 6 }), START);
		expect(
			scheduleBeyondRunWindow(window, {
				action: "START",
				fireAtMs: Date.parse("2026-09-01T18:00:00.000Z"),
			}),
		).toBeNull();
	});

	it("refuses nothing when no knob is configured", () => {
		const window = liveRunWindow(null, START);
		expect(
			scheduleBeyondRunWindow(window, {
				action: "STOP",
				fireAtMs: Date.parse("2027-09-01T18:00:00.000Z"),
			}),
		).toBeNull();
	});

	it("blames the TIGHTEST knob when two bound the same run", () => {
		const window = liveRunWindow(
			planWith({ streamTimeoutMinutes: 120 }),
			START,
			{
				maxRunMinutes: 30,
			},
		);
		expect(
			scheduleBeyondRunWindow(window, {
				action: "SLATE_IN",
				fireAtMs: Date.parse("2026-09-01T12:45:00.000Z"),
			}),
		).toContain("maxRunMinutes=30");
	});
});

describe("programEndBeyondRunWindow", () => {
	it("accepts a program end one ms before the bound and refuses it AT the bound", () => {
		const window = liveRunWindow(planWith({ streamTimeoutMinutes: 60 }), START);
		const endsAtMs = START + 60 * MIN;
		expect(programEndBeyondRunWindow(window, endsAtMs - 1)).toBeNull();
		expect(programEndBeyondRunWindow(window, endsAtMs)).toContain(
			"streamTimeoutMinutes=60",
		);
	});

	it("refuses a runtime cap that would cut the program short (the cap is the BACKSTOP, the program end is the intent)", () => {
		const window = liveRunWindow(null, START, { maxRunMinutes: 30 });
		expect(
			programEndBeyondRunWindow(window, Date.parse("2026-09-01T13:00:00.000Z")),
		).toBe(
			"maxRunMinutes=30 ends the run by 2026-09-01T12:30:00.000Z; the program end at 2026-09-01T13:00:00.000Z is after that",
		);
	});

	it("accepts a cap that outlives the program (the derived span + margin)", () => {
		const window = liveRunWindow(null, START, { maxRunMinutes: 90 });
		expect(
			programEndBeyondRunWindow(window, Date.parse("2026-09-01T13:00:00.000Z")),
		).toBeNull();
	});

	it("refuses nothing when no knob is configured", () => {
		expect(
			programEndBeyondRunWindow(
				liveRunWindow(null, START),
				Date.parse("2030-01-01T00:00:00.000Z"),
			),
		).toBeNull();
	});
});
