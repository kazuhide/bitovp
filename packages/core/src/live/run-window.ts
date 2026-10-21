import type { z } from "zod";
import type { LiveAutoShutdownUpdateReceipt } from "./auto-shutdown";
import {
	CHANNEL_STARTING_SCHEDULE_ACTIONS,
	LIVE_SCHEDULE_ACTION_VALUES,
	type LiveScheduleAction,
} from "./program-schedule";
import type { liveAutoShutdownSchema } from "./schema";

/**
 * How long may this run still be alive?
 *
 * Paid runs #1/#2 of the 2026-08-29 live audit set the PROVIDER's automatic
 * shutdown to `streamTimeoutMinutes = 6` and then armed feeder / slate / STOP
 * rows well past it. Bitmovin ended the encoding exactly as configured; our
 * rows fired afterwards, into nothing, and were recorded FIRED. That is not an
 * encoder defect: nothing in creation or in the API ever compared the schedule
 * window against the automatic shutdown the SAME request configured.
 *
 * This module is that comparison, written once. The arithmetic is trivial; the
 * load-bearing part is knowing WHICH knob may be compared at all.
 *
 * `LiveAutoShutdownConfiguration` (@bitmovin/api-sdk 1.278.0, generated from
 * the OpenAPI spec — the authority per AGENT-GUIDE) carries exactly three
 * fields, and their own doc comments split them cleanly:
 *
 *  - `streamTimeoutMinutes` — "Automatically shutdown the live stream after a
 *    predefined runtime in minutes." UNCONDITIONAL: a wall-clock cap on the
 *    whole run that needs no input event to fire. **HARD BOUND.**
 *  - `bytesReadTimeoutSeconds` — "…if there is no input anymore for a
 *    predefined number of seconds." Fires only after an idle gap, and when the
 *    input goes idle is not derivable from a schedule. **CONDITIONAL** — warn,
 *    never refuse.
 *  - `waitingForFirstConnectTimeoutMinutes` — "…if input is never connected
 *    for a predefined number of minutes." Any connection at all voids it.
 *    **CONDITIONAL** — warn, never refuse.
 *
 * One more hard bound is OURS, not the provider's: `LiveChannel.maxRunMinutes`,
 * which the scheduler sweep enforces as `runningSince + maxRunMinutes * 60_000`
 * (`apps/worker/src/scheduler/sweep.ts`, the runtime-cap scan). That expression
 * is reproduced here deliberately, so an arm-time refusal and the fire-time
 * stop cannot disagree about the instant.
 *
 * ANCHOR (`startAt`). The moment the run's clock starts. Since  a
 * channel provisions AT CREATION, so:
 *   - at creation the anchor is the provision request (`Date.now`) — the same
 *     anchor `deriveProgramSchedule` already uses for `maxRunMinutes`;
 *   - afterwards it is `runningSince ?? createdAt`.
 * Before a run is observed RUNNING that anchor is EARLY by the provisioning
 * ramp, so the bound is conservative by a few minutes. That is the safe
 * direction for a broadcast, it matches the cap the product already derives,
 * and every message names the instant it computed so the operator can see it.
 *
 * BOUNDARY. A moment AT the bound is refused, not accepted: at exactly
 * `endsAtMs` the provider is ending the run, so a row there is a coin flip and
 * not a schedule. Strictly-before is the whole accepted set.
 */

type LiveAutoShutdown = z.infer<typeof liveAutoShutdownSchema>;

/** Every field name of the SDK's auto-shutdown configuration. */
export type LiveAutoShutdownKnob = keyof LiveAutoShutdown;

type AutoShutdownKnobSpec =
	| {
			kind: "hard";
			/** The knob's own value converted to MINUTES. */
			minutes: (value: number) => number;
	  }
	| {
			kind: "conditional";
			message: (value: number, startsAtMs: number) => string;
	  };

/**
 * Every auto-shutdown knob, classified and given its behaviour. The
 * `satisfies` is the instrument: grow `liveAutoShutdownSchema` (i.e. the SDK
 * grew a knob) and this object stops compiling until someone decides whether
 * the new knob bounds a run or merely conditions it. A hand-listed array would
 * have let a new knob go unclassified, and an unclassified shutdown knob is
 * exactly the hole this row exists to close.
 *
 * It is not decoration: `liveRunWindow` below dispatches on `kind`, so moving
 * a knob between the two classes changes what gets refused.
 */
const AUTO_SHUTDOWN_KNOBS = {
	bytesReadTimeoutSeconds: {
		kind: "conditional",
		message: (value) =>
			`bytesReadTimeoutSeconds=${value} ends the run ${value}s after the input stops. When an input goes idle cannot be derived from a schedule, so no scheduled time is checked against it.`,
	},
	streamTimeoutMinutes: { kind: "hard", minutes: (value) => value },
	waitingForFirstConnectTimeoutMinutes: {
		kind: "conditional",
		message: (value, startsAtMs) =>
			`waitingForFirstConnectTimeoutMinutes=${value} ends the run by ${iso(startsAtMs + value * 60_000)} if no input has ever connected. Any connection voids it, so no scheduled time is checked against it.`,
	},
} satisfies Record<LiveAutoShutdownKnob, AutoShutdownKnobSpec>;

const AUTO_SHUTDOWN_KNOB_NAMES = Object.keys(
	AUTO_SHUTDOWN_KNOBS,
) as LiveAutoShutdownKnob[];

/**
 * The classification alone, derived from the table above — exported so a test
 * can set-equal it against `liveAutoShutdownSchema`'s own keys instead of
 * against a second hand-written list.
 */
export const LIVE_AUTO_SHUTDOWN_KNOB_KIND = Object.fromEntries(
	AUTO_SHUTDOWN_KNOB_NAMES.map((knob) => [
		knob,
		AUTO_SHUTDOWN_KNOBS[knob].kind,
	]),
) as Record<LiveAutoShutdownKnob, "hard" | "conditional">;

/** One hard bound: this knob ends the run at this instant. */
export type LiveRunBound = {
	knob: LiveAutoShutdownKnob | "maxRunMinutes";
	/** The configured value, converted to minutes. */
	minutes: number;
	endsAtMs: number;
};

/** One conditional knob, with the sentence that names it and its condition. */
export type LiveRunConditionalNote = {
	knob: LiveAutoShutdownKnob;
	/** The configured value in the knob's OWN unit — seconds or minutes. */
	value: number;
	message: string;
};

export type LiveRunWindow = {
	/** The anchor the bounds were computed from. */
	startsAtMs: number;
	/** Every hard bound that applies, tightest first. */
	bounds: LiveRunBound[];
	/** The tightest hard bound, or null when nothing bounds the run. */
	bound: LiveRunBound | null;
	/** `bound?.endsAtMs` — the earliest instant the run may be over. */
	endsAtMs: number | null;
	/** Never refused on; surfaced as warnings that name the knob. */
	conditional: LiveRunConditionalNote[];
};

/**
 * Structurally the part of a live plan this reads. A whole `LiveChannelPlan`
 * satisfies it; so does `null`, which is how a caller says "no plan to read" —
 * a stored plan that no longer parses, or a check that only concerns our own
 * cap. A plan we cannot read yields NO bound and therefore no refusal: the
 * guard must never turn an unreadable plan into a refused schedule.
 */
export type LiveRunWindowPlan = {
	start?: { autoShutdown?: LiveAutoShutdown | null } | null;
} | null;

/**
 * The same input, read out of STORED plan JSON (`LiveChannel.plan`).
 *
 * Deliberately NOT `liveChannelPlanSchema.safeParse` — this guard must not
 * lose its population to unrelated plan drift. A stored plan from before some
 * future schema change would fail a whole-plan parse, and a failed parse means
 * no bound and therefore no refusal: the guard would go quiet on exactly the
 * old channels most likely to carry a hand-set shutdown. So only the knobs
 * this module classifies are read, each accepted only as a usable positive
 * number, and anything else is ignored.
 */
export function liveRunWindowPlanFrom(planJson: unknown): LiveRunWindowPlan {
	const raw = (
		planJson as { start?: { autoShutdown?: unknown } } | null | undefined
	)?.start?.autoShutdown;
	if (raw === null || typeof raw !== "object") {
		return null;
	}
	const source = raw as Record<string, unknown>;
	const autoShutdown: Record<string, number> = {};
	for (const knob of AUTO_SHUTDOWN_KNOB_NAMES) {
		const value = configured(source[knob]);
		if (value !== null) {
			autoShutdown[knob] = value;
		}
	}
	return { start: { autoShutdown: autoShutdown as LiveAutoShutdown } };
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

/** A knob only bounds anything when it carries a usable positive number. */
function configured(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: null;
}

/**
 * The earliest moment this run may end on its own, from the provider's
 * automatic shutdown and from our own runtime cap. Pure — the caller passes
 * both the anchor and the cap, because neither lives in the plan.
 */
export function liveRunWindow(
	plan: LiveRunWindowPlan,
	startAt: Date | number,
	opts: {
		maxRunMinutes?: number | null;
		autoShutdownUpdate?: LiveAutoShutdownUpdateReceipt | null;
	} = {},
): LiveRunWindow {
	const startsAtMs = startAt instanceof Date ? startAt.getTime() : startAt;
	const autoShutdown =
		opts.autoShutdownUpdate?.configuration ?? plan?.start?.autoShutdown ?? null;

	const bounds: LiveRunBound[] = [];
	const conditional: LiveRunConditionalNote[] = [];
	for (const knob of AUTO_SHUTDOWN_KNOB_NAMES) {
		const value = configured(autoShutdown?.[knob]);
		if (value === null) {
			continue;
		}
		const spec: AutoShutdownKnobSpec = AUTO_SHUTDOWN_KNOBS[knob];
		if (spec.kind === "hard") {
			const minutes = spec.minutes(value);
			bounds.push({
				knob,
				minutes,
				endsAtMs: opts.autoShutdownUpdate?.scheduledShutdownAt
					? Date.parse(opts.autoShutdownUpdate.scheduledShutdownAt)
					: startsAtMs + minutes * 60_000,
			});
		} else {
			conditional.push({
				knob,
				value,
				message: spec.message(value, startsAtMs),
			});
		}
	}

	const maxRunMinutes = configured(opts.maxRunMinutes);
	if (maxRunMinutes !== null) {
		bounds.push({
			knob: "maxRunMinutes",
			minutes: maxRunMinutes,
			endsAtMs: startsAtMs + maxRunMinutes * 60_000,
		});
	}
	bounds.sort((a, b) => a.endsAtMs - b.endsAtMs);

	return {
		startsAtMs,
		bounds,
		bound: bounds[0] ?? null,
		endsAtMs: bounds[0]?.endsAtMs ?? null,
		conditional,
	};
}

/**
 * The schedule actions that act on the CURRENT run, so a fire time past that
 * run's end is unreachable. Derived by subtracting the channel-STARTING
 * actions from the total union rather than listed: a new action is run-scoped
 * (checked) by default, which is the safe direction — the opposite default
 * would silently exempt it.
 *
 * START is exempt on purpose and not by omission: since  a START
 * begins a NEW run with a NEW encoding, so the provider's shutdown clock — and
 * our cap, which measures from `runningSince` — start over.
 */
export const RUN_SCOPED_SCHEDULE_ACTIONS: readonly LiveScheduleAction[] =
	LIVE_SCHEDULE_ACTION_VALUES.filter(
		(action) =>
			!(
				CHANNEL_STARTING_SCHEDULE_ACTIONS as readonly LiveScheduleAction[]
			).includes(action),
	);

export function isRunScopedScheduleAction(action: LiveScheduleAction): boolean {
	return RUN_SCOPED_SCHEDULE_ACTIONS.includes(action);
}

function boundPrefix(bound: LiveRunBound): string {
	return `${bound.knob}=${bound.minutes} ends the run by ${iso(bound.endsAtMs)}`;
}

/**
 * Refusal text for a schedule row whose fire time is at or past the run's hard
 * bound, or null when the row can still fire. Mechanical English naming the
 * knob and the instant it produced — the operator has to be able to see which
 * of the two settings to move.
 */
export function scheduleBeyondRunWindow(
	window: LiveRunWindow,
	row: { action: LiveScheduleAction; fireAtMs: number },
): string | null {
	if (!isRunScopedScheduleAction(row.action)) {
		return null;
	}
	const bound = window.bound;
	if (!bound || row.fireAtMs < bound.endsAtMs) {
		return null;
	}
	return `${boundPrefix(bound)}; the ${row.action} at ${iso(row.fireAtMs)} cannot fire into a live encoding`;
}

/**
 * Refusal text for a program end that outlives the run, or null.
 *
 * Both halves of the cap/intent pair land here. `programEndAt` is the INTENT
 * (`program-schedule.ts`: "the STOP row is the intended end; `maxRunMinutes` is
 * the backstop"), so a backstop — or a provider shutdown — that lands first is
 * the misconfiguration, never the program.
 */
export function programEndBeyondRunWindow(
	window: LiveRunWindow,
	programEndAtMs: number,
): string | null {
	const bound = window.bound;
	if (!bound || programEndAtMs < bound.endsAtMs) {
		return null;
	}
	return `${boundPrefix(bound)}; the program end at ${iso(programEndAtMs)} is after that`;
}
