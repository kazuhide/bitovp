"use client";

import { formatSeconds } from "@/app/live/new/dvr-gauge";
import { useT } from "@/lib/i18n/context";
import type { LiveJumpEvent } from "./section-focus";

/**
 * Compact operational summary: alerts, playable output, feeders and timing.
 * Ingest state and observation freshness live in DeliveryStatusPanel. Unknown
 * readings stay unknown rather than becoming reassuring defaults.
 *
 * The two TIME cells address an operational gap: on a
 * healthy RUNNING channel the derived next action settles on `ON_AIR`, so the
 * page said nothing at all about the STOP or the slate that was about to fire,
 * and nothing about how long the broadcast had been up against its runtime cap
 * the two numbers a gallery operator watches. They belong on this row and
 * not in a new band, because the whole point of the strip is that the answer to
 * "is it all right?" is ONE horizontal scan.
 *
 * The next-event cell is the page's only link out of the header, and it is a
 * link rather than a button for the reason §5.7 gives: the header carries
 * "compact summary + a link to Programme", never a second copy of the control.
 */
export function StatusStrip({
	openAlerts,
	playableCount,
	feederCount,
	nextEvent,
	runStartedAt,
	runEndedAt,
	maxRunMinutes,
	programmeHref,
	onJump,
	active,
	nowMs,
}: {
	/**
	 * Open alerts, or `"unknown"` when the alert query failed
	 * . It was a plain `number` fed by `?? 0`, so a strip whose
	 * whole contract is "every value is a MEASUREMENT" printed a green zero
	 * for a list it had never read.
	 */
	openAlerts: number | "unknown";
	playableCount: number;
	/** Failed reads, including stale-data refetch failures, are not zero. */
	feederCount: number | "unknown";
	/**
	 * The soonest ARMED schedule row; `null` when nothing is armed, and
	 * `"unknown"` when the schedules query FAILED — the same three-valued
	 * shape `openAlerts` uses, and for the same reason
	 * a list nobody managed to read must not render as "none
	 * armed" on a strip whose whole contract is that every value is measured.
	 *
	 * `label` is already localised by the caller, which owns the action → copy
	 * map; the strip only does the arithmetic.
	 */
	nextEvent:
		| {
				label: string;
				fireAt: string;
				/* SLATE_IN only: how long the slate covers the feed. */
				slateDurationSeconds: number | null;
		  }
		| null
		| "unknown";
	/** When the CURRENT run started, for the elapsed figure. Null = never ran. */
	runStartedAt: string | null;
	/**
	 * When it ENDED. Present on a finished run, and the reason the runtime cell
	 * can say something true about one at all: `endedAt − runningSince` is a
	 * pair of worker stamps, i.e. a MEASUREMENT of how long the broadcast was
	 * up, where `now − runningSince` after a stop is just the age of a fact.
	 */
	runEndedAt: string | null;
	/** The runtime cap , for the remaining figure. */
	maxRunMinutes: number | null;
	/** Anchor for the next-event cell — the Programme layer's heading. */
	programmeHref: string;
	/**
	 *  / review-366 I2: taking that anchor hands focus to the Programme
	 * layer's heading, the same way the rail entries and the next-action CTA do.
	 * Three docblocks already SAID it did while this cell was a bare `href`.
	 *
	 * The event is passed because the handler cancels the default action on a
	 * same-fragment click — see `section-focus.ts`.
	 */
	onJump?: (event: LiveJumpEvent, targetId: string) => void;
	/** RUNNING/STOPPING; inactive freezes the measured run duration. */
	active: boolean;
	/** Injected so the age is testable without faking timers. */
	nowMs: number;
}) {
	const { t } = useT();
	/**
	 * Countdown to the next armed row. A NEGATIVE remainder is not "0s": the
	 * sweep reaps a due row within one 30s tick, so a row still armed past its
	 * fireAt is evidence the worker is not running — the same reasoning
	 * `overdueArmedCount` uses one level up. It reads as overdue, in amber.
	 */
	const armedNext = nextEvent === "unknown" ? null : nextEvent;
	const nextEventMs =
		armedNext === null ? null : Date.parse(armedNext.fireAt) - nowMs;
	const nextEventOverdue = nextEventMs !== null && nextEventMs < 0;
	const nextEventText =
		nextEvent === "unknown"
			? t("status.summaryUnavailable")
			: armedNext === null || nextEventMs === null
				? t("status.summaryNoneArmed")
				: `${
						nextEventOverdue
							? t("status.nextEventOverdue", {
									action: armedNext.label,
									countdown: formatSeconds(Math.round(-nextEventMs / 1000)),
								})
							: t("status.nextEventIn", {
									action: armedNext.label,
									countdown: formatSeconds(Math.round(nextEventMs / 1000)),
								})
					}${
						armedNext.slateDurationSeconds !== null
							? ` · ${t("status.nextEventSlate", {
									seconds: armedNext.slateDurationSeconds,
								})}`
							: ""
					}`;

	/**
	 * Elapsed against the cap — LIVE, and therefore gated on `active` like
	 * every other clock-reading cell in this file.
	 *
	 * Review of #360 caught the first cut without that gate: `now −
	 * runningSince` keeps counting after the broadcast ends, so a channel that
	 * ran ten minutes under a two-hour cap and stopped three days ago rendered
	 * 「3d 0h 10m elapsed · cap reached」in amber, growing on every view. The
	 * amber made it worse: it implied a cap had bitten a run that had
	 * simply finished.
	 *
	 * Both live figures use the same anchored `nowMs` as the delivery panel's
	 * freshness readings, so a skewed viewer clock cannot make them disagree.
	 */
	const elapsedSeconds =
		!active || runStartedAt === null
			? null
			: Math.max(0, Math.round((nowMs - Date.parse(runStartedAt)) / 1000));
	const remainingSeconds =
		elapsedSeconds === null || maxRunMinutes === null
			? null
			: maxRunMinutes * 60 - elapsedSeconds;
	/**
	 * The post-mortem figure: how long the broadcast was up, FROZEN, from the
	 * run's own two worker stamps. No viewer clock enters it, so it reads the
	 * same three days later as it did at the stop — which is what makes it a
	 * measurement rather than an artifact. A finished run with no `endedAt`
	 * (a legacy row) has no such measurement and says None rather than
	 * inventing one from the current time.
	 */
	const ranForSeconds =
		active || runStartedAt === null || runEndedAt === null
			? null
			: Math.max(
					0,
					Math.round(
						(Date.parse(runEndedAt) - Date.parse(runStartedAt)) / 1000,
					),
				);
	const runtimeText = !active
		? ranForSeconds === null
			? t("status.none")
			: t("status.runtimeRan", { duration: formatSeconds(ranForSeconds) })
		: elapsedSeconds === null
			? t("status.none")
			: remainingSeconds === null
				? t("status.runtimeElapsed", {
						elapsed: formatSeconds(elapsedSeconds),
					})
				: remainingSeconds <= 0
					? t("status.runtimeCapReached", {
							elapsed: formatSeconds(elapsedSeconds),
						})
					: t("status.runtimeRemaining", {
							elapsed: formatSeconds(elapsedSeconds),
							remaining: formatSeconds(remainingSeconds),
						});

	const cells: {
		key: string;
		label: string;
		value: string;
		tone: "ok" | "warn" | "error" | "neutral";
		/** Renders the value as an in-page link to the section that owns it. */
		href?: string;
	}[] = [
		{
			key: "alerts",
			label: t("alerts.title"),
			// A failed read is amber-unknown, never a green zero: the number
			// an operator glances at here has to be one we actually have.
			value:
				openAlerts === "unknown" ? t("status.unknown") : String(openAlerts),
			tone: openAlerts === "unknown" ? "warn" : openAlerts > 0 ? "error" : "ok",
		},
		{
			key: "playable",
			label: t("status.playable"),
			value: String(playableCount),
			tone: playableCount > 0 ? "ok" : "neutral",
		},
		{
			key: "feeders",
			label: t("live.feeders"),
			value:
				feederCount === "unknown" ? t("status.unknown") : String(feederCount),
			tone:
				feederCount === "unknown" ? "warn" : feederCount > 0 ? "ok" : "neutral",
		},
		{
			key: "next-event",
			label: t("status.nextEvent"),
			value: nextEventText,
			tone:
				nextEvent === "unknown"
					? "warn"
					: nextEventOverdue
						? "warn"
						: "neutral",
			href: programmeHref,
		},
		{
			key: "runtime",
			label: t("status.runtime"),
			value: runtimeText,
			// A cap that has passed is not an error — the sweep is about to
			// stop the channel, which is what the operator asked for — but it
			// is the one runtime value worth colouring. `remainingSeconds` is
			// null whenever the channel is not active, so a FINISHED run can no
			// longer wear the amber (the review-#360 symptom).
			tone:
				remainingSeconds !== null && remainingSeconds <= 0 ? "warn" : "neutral",
		},
	];

	const toneClass = {
		ok: "text-emerald-400",
		warn: "text-amber-400",
		error: "text-red-400",
		neutral: "text-zinc-300",
	} as const;

	return (
		<section
			aria-label={t("status.regionLabel")}
			className="flex flex-wrap gap-x-6 gap-y-2 rounded-md border border-zinc-800 bg-zinc-900/40 px-4 py-2.5"
		>
			{cells.map((cell) => (
				<div key={cell.key} className="flex items-baseline gap-1.5">
					<span className="text-xs text-zinc-500">{cell.label}</span>
					{cell.href ? (
						<a
							href={cell.href}
							onClick={(event) =>
								onJump?.(event, (cell.href as string).replace(/^#/, ""))
							}
							data-status-cell={cell.key}
							className={`font-medium text-sm underline decoration-zinc-700 underline-offset-4 hover:decoration-zinc-400 ${toneClass[cell.tone]}`}
						>
							{cell.value}
						</a>
					) : (
						<span
							data-status-cell={cell.key}
							className={`font-medium text-sm ${toneClass[cell.tone]}`}
						>
							{cell.value}
						</span>
					)}
				</div>
			))}
		</section>
	);
}
