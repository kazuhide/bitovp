"use client";

import { formatDateTime, formatDurationMs } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import type { ChannelHealthReading } from "./channel-health";
import type { LiveChannelListItem } from "./live-shared";

/**
 * The three promoted cells of the Live operations list (audit
 * 4403130 §5.5): Health, Next event and Runtime.
 *
 * Every value here is TEXT, and colour is only ever a second channel on top
 * of it — the same rule the detail page's StatusStrip states about itself.
 * A row scanned in a monochrome screenshot, by a colour-blind operator, or
 * through a screen reader has to carry the same verdict as one scanned by an
 * operator watching for red.
 */

type Tone = "ok" | "warn" | "error" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
	ok: "text-emerald-400",
	warn: "text-amber-400",
	error: "text-red-400",
	neutral: "text-zinc-300",
};

type Facet = {
	key: string;
	label: string;
	value: string;
	tone: Tone;
	/** Long detail (an origin's unavailability reason) kept out of the cell. */
	title?: string;
};

function FacetList({ facets }: { facets: Facet[] }) {
	return (
		<div className="flex flex-wrap gap-x-3 gap-y-0.5">
			{facets.map((facet) => (
				<span
					key={facet.key}
					data-health-facet={facet.key}
					title={facet.title}
					className="whitespace-nowrap text-xs"
				>
					<span className="text-zinc-500">{facet.label}</span>{" "}
					<span className={`font-medium ${TONE_CLASS[facet.tone]}`}>
						{facet.value}
					</span>
				</span>
			))}
		</div>
	);
}

/**
 * Input / heartbeat / output / alerts / feeder for one channel.
 *
 * The Input and heartbeat readings reproduce the detail page's StatusStrip
 * line for line, and for the same reasons recorded there — a frozen sample's
 * wire word is the  lie and reads as unknown; a future-stamped one
 * reads as clock skew rather than as the freshest possible sample; a stopped
 * channel's absent ingest is the expected state and not a warning.
 *
 * ONE difference, deliberate: the heartbeat-age TONE follows core's vouching
 * window (the verdict this list also sorts and filters on) rather than the
 * strip's own 60-second display threshold. On the detail page those two can
 * differ harmlessly; here a cell that read "fine" while the row was sorted to
 * the top as stale would be the screen disagreeing with itself.
 */
export function HealthCell({ health }: { health: ChannelHealthReading }) {
	const { t } = useT();
	const {
		active,
		ingestConnected,
		ingestWord,
		heartbeatAgeSeconds,
		heartbeatSkewed,
		heartbeatStale,
		openAlerts,
		origin,
		activeFeeders,
		erroredFeeders,
	} = health;

	const heartbeatAt = health.heartbeatAtIso;
	const facets: Facet[] = [
		{
			key: "ingest",
			label: t("live.health.ingest"),
			value:
				ingestConnected === true
					? t("status.ingestConnected")
					: (ingestWord ?? (active ? t("status.unknown") : t("status.none"))),
			tone:
				ingestConnected === true ? "ok" : active ? "warn" : ("neutral" as Tone),
		},
		{
			key: "heartbeat",
			label: t("live.heartbeat"),
			value: !active
				? heartbeatAt
					? formatDateTime(heartbeatAt)
					: t("status.never")
				: heartbeatSkewed
					? t("status.clockSkew")
					: heartbeatAgeSeconds === null
						? t("status.never")
						: t("status.secondsAgo", { seconds: heartbeatAgeSeconds }),
			tone: !active ? "neutral" : heartbeatStale ? "warn" : "neutral",
		},
		{
			key: "output",
			label: t(
				!active && origin ? "live.list.lastOutput" : "live.health.output",
			),
			// Unknown stays unknown: an unobservable driver names its reason,
			// an unswept origin has neither — and neither is "no output".
			value:
				origin === null
					? t("status.unknown")
					: origin.endlist > 0
						? t("live.list.outputEnded")
						: origin.stale > 0
							? t("live.list.outputStalled")
							: origin.observed > 0
								? t(
										active
											? "live.list.outputAdvancing"
											: "live.list.outputAdvanced",
									)
								: t("live.list.outputUnobserved"),
			// Inactive = post-mortem, so the last verdict is REPORTED but not
			// alarmed: the origin observer only polls RUNNING channels, and a
			// stopped channel's playlist has stopped advancing BY DEFINITION —
			// the same reasoning the strip applies to a stopped channel's
			// disconnected ingest. This tracks the anomaly gate in
			// `channel-health.ts` exactly; a red cell on a row ranked healthy
			// would be the screen disagreeing with itself.
			tone: !active
				? "neutral"
				: origin === null
					? "neutral"
					: origin.endlist > 0 || origin.stale > 0
						? "error"
						: origin.observed > 0
							? "ok"
							: "neutral",
			title: origin?.unavailableReason ? t("origin.unavailable") : undefined,
		},
		{
			key: "alerts",
			label: t("alerts.title"),
			// A failed read is amber-unknown, never a green zero — the number an
			// operator glances at has to be one we actually have.
			value:
				openAlerts === "unknown" ? t("status.unknown") : String(openAlerts),
			tone: openAlerts === "unknown" ? "warn" : openAlerts > 0 ? "error" : "ok",
		},
		{
			key: "feeder",
			label: t("live.list.feederLabel"),
			value:
				erroredFeeders > 0
					? t("live.list.feederErrors", { count: erroredFeeders })
					: activeFeeders > 0
						? t("status.summaryFeeders", { count: activeFeeders })
						: t("status.none"),
			// Same post-mortem rule as the output facet: a feeder that failed
			// during a broadcast that has since ended is history, not an alarm.
			tone: !active
				? "neutral"
				: erroredFeeders > 0
					? "error"
					: activeFeeders > 0
						? "ok"
						: "neutral",
		},
	];
	return <FacetList facets={facets} />;
}

/**
 * The soonest ARMED row: what it will do, when, and how long from now.
 *
 * The countdown is computed from the SERVER-anchored clock the row already
 * carries, so a viewer whose laptop is five minutes fast does not read a
 * schedule as overdue. Past its fire time and still armed reads "due" rather
 * than as a negative duration — the sweep reaps within a grace window, and an
 * operator needs to see that it has not.
 */
export function NextEventCell({
	nextSchedule,
	nowMs,
}: {
	nextSchedule: LiveChannelListItem["nextSchedule"];
	nowMs: number;
}) {
	const { t } = useT();
	if (!nextSchedule) {
		return <span className="text-xs text-zinc-600">—</span>;
	}
	const fireAtMs = Date.parse(nextSchedule.fireAt);
	const remaining = Number.isFinite(fireAtMs) ? fireAtMs - nowMs : null;
	return (
		<div className="text-xs">
			<div className="font-medium text-zinc-200">{nextSchedule.action}</div>
			<div className="text-zinc-500">{formatDateTime(nextSchedule.fireAt)}</div>
			<div
				data-next-event="countdown"
				className={
					remaining !== null && remaining <= 0
						? "text-amber-400"
						: "text-zinc-400"
				}
			>
				{remaining === null
					? t("status.unknown")
					: remaining <= 0
						? t("live.list.countdownDue")
						: t("live.list.countdownIn", {
								duration: formatDurationMs(remaining),
							})}
			</div>
		</div>
	);
}

/**
 * Elapsed against the runtime cap  — the two halves an operator
 * checks before a channel hard-stops itself.
 *
 * No cap says so out loud. A channel already past its cap says THAT out loud
 * too: the sweep stops it, and the gap between "should have stopped" and
 * "stopped" is billed time.
 */
export function RuntimeCell({ health }: { health: ChannelHealthReading }) {
	const { t } = useT();
	const { active, elapsedMs, remainingMs } = health;
	if (elapsedMs === null) {
		return <span className="text-xs text-zinc-600">—</span>;
	}
	return (
		<div className="text-xs">
			<div className="text-zinc-200">
				{t("live.list.elapsed", { duration: formatDurationMs(elapsedMs) })}
			</div>
			{/* The cap line belongs to a broadcast that can still hit it. A
			    finished run shows how long it ran and stops there. */}
			{active ? (
				<div
					data-runtime="remaining"
					className={
						remainingMs !== null && remainingMs <= 0
							? "text-amber-400"
							: "text-zinc-500"
					}
				>
					{remainingMs === null
						? t("live.list.noCap")
						: remainingMs <= 0
							? t("live.list.capExceeded")
							: t("live.list.remaining", {
									duration: formatDurationMs(remainingMs),
								})}
				</div>
			) : null}
		</div>
	);
}
