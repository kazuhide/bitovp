"use client";

import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import {
	hasCurrentScheduleOutcomeEvidence,
	type LiveScheduleOutcomeEvidenceKind,
	type LiveScheduleOutcomeKind,
	type LiveScheduleStatusKind,
} from "@/lib/live-runtime/schemas";
import {
	SCHEDULE_ACTION_LABEL_KEYS,
	SCHEDULE_OUTCOME_LABEL_KEYS,
	SCHEDULE_STATUS_LABEL_KEYS,
} from "./[id]/schedule-labels";

/**
 * The broadcast slot as a picture : stream-up → (slate cover) →
 * program → end, drawn to proportion, with the schedule rows' fates overlaid
 * when given. Shared by the creation wizard (planning view, no rows yet) and
 * the channel detail (operational view, rows with statuses).
 *
 * Deliberately a RENDERING of state owned elsewhere: the wizard's inputs and
 * the server's rows stay the source of truth, so this component takes values
 * and returns markup — no fetching, no clocks of its own (`now` is a prop for
 * the same reason the sweep takes `now`: a timeline that reads the wall
 * clock cannot be tested honestly).
 */

export type TimelineRow = {
	action: "START" | "STOP" | "SLATE_IN" | "FEEDER_START" | "FEEDER_SWITCH";
	status: LiveScheduleStatusKind;
	/**
	 * Audit 602ec286 HIGH-8: a FIRED row's colour comes from its DELIVERY, not
	 * its firing. Optional for the wizard's planning view (no rows have fired
	 * yet) and for a server that predates the column; absent reads as PENDING,
	 * the direction that cannot invent a success.
	 */
	outcome?: LiveScheduleOutcomeKind;
	outcomeEvidenceVersion?: number | null;
	outcomeEvidenceKind?: LiveScheduleOutcomeEvidenceKind | null;
	outcomeEvidenceAt?: string | null;
	fireAt: string;
};

export function ProgramTimeline({
	streamUpAt,
	programStartAt,
	programEndAt,
	slate,
	rows,
	now,
}: {
	streamUpAt: Date | null;
	programStartAt: Date | null;
	programEndAt: Date | null;
	/* Whether the pre-air window is covered by a slate. */
	slate: boolean;
	rows?: TimelineRow[];
	now?: Date;
}) {
	const { t } = useT();
	if (!streamUpAt || !programStartAt || !programEndAt) {
		return (
			<p className="text-xs text-zinc-500">
				{t("schedule.timelineIncomplete")}
			</p>
		);
	}
	const up = streamUpAt.getTime();
	const start = programStartAt.getTime();
	const end = programEndAt.getTime();
	if (!(up <= start && start < end)) {
		return (
			<p role="alert" className="text-amber-400 text-xs">
				{t("schedule.timelineUnordered")}
			</p>
		);
	}
	const span = end - up;
	const pct = (ms: number) =>
		`${Math.max(0, Math.min(100, ((ms - up) / span) * 100)).toFixed(2)}%`;
	const preAirPct = ((start - up) / span) * 100;
	const nowMs = now?.getTime();

	/**
	 * Audit 602ec286 HIGH-8: a FIRED marker is coloured by its OUTCOME, never
	 * emerald-by-status. The old chain greened every FIRED row, so a slate
	 * whose provider entry went ERROR, a feed still only PROCESS_PUSHING, or a
	 * row left UNKNOWN all read as success on the timeline while the history
	 * list below them showed red or amber — one screen contradicting itself.
	 *
	 * Green is reserved for OBSERVED delivery: DELIVERED (START reached RUNNING
	 * / STOP observed terminal) and INGEST_CONNECTED (the provider confirmed the
	 * feed's ingest). FAILED is red. The in-progress positives PROCESS_PUSHING
	 * and SLATE_ARMED, plus PENDING/UNKNOWN, are amber — moved past "armed" but
	 * not a success. This mirrors `schedule-panel`'s `OUTCOME_TONE` exactly, so
	 * the two surfaces agree.
	 *
	 * Exhaustive `Record` on purpose : a new outcome is a
	 * COMPILE error here instead of silently inheriting a colour — which is how
	 * the untyped status chain greened FIRED in the first place.
	 */
	const OUTCOME_BAR: Record<LiveScheduleOutcomeKind, string> = {
		DELIVERED: "bg-emerald-500",
		INGEST_CONNECTED: "bg-emerald-500",
		FAILED: "bg-red-500",
		PROCESS_PUSHING: "bg-amber-500",
		SLATE_ARMED: "bg-amber-500",
		PENDING: "bg-amber-500",
		UNKNOWN: "bg-amber-500",
	};
	const rowTone = (row: TimelineRow) =>
		row.status === "FIRED"
			? (row.outcome === "DELIVERED" || row.outcome === "INGEST_CONNECTED") &&
				!hasCurrentScheduleOutcomeEvidence(row)
				? "bg-amber-500"
				: OUTCOME_BAR[row.outcome ?? "PENDING"]
			: row.status === "COMPLETED"
				? "bg-emerald-500"
				: row.status === "MISSED" || row.status === "ERROR"
					? "bg-red-500"
					: row.status === "SKIPPED_STALE_GENERATION"
						? "bg-amber-500"
						: row.status === "CANCELED"
							? "bg-zinc-600"
							: "bg-zinc-300";
	const rowLabel = (row: TimelineRow) =>
		row.status === "FIRED"
			? t(
					(row.outcome === "DELIVERED" || row.outcome === "INGEST_CONNECTED") &&
						!hasCurrentScheduleOutcomeEvidence(row)
						? "schedule.outcomeLegacyUnverified"
						: SCHEDULE_OUTCOME_LABEL_KEYS[row.outcome ?? "PENDING"],
				)
			: t(SCHEDULE_STATUS_LABEL_KEYS[row.status]);
	const rowSymbol = (row: TimelineRow) => {
		const tone = rowTone(row);
		if (tone === "bg-emerald-500") return "✓";
		if (tone === "bg-red-500") return "!";
		if (tone === "bg-amber-500") return "△";
		return "—";
	};

	return (
		<figure
			aria-label={t("schedule.timelineAria", {
				up: formatDateTime(streamUpAt.toISOString()),
				start: formatDateTime(programStartAt.toISOString()),
				end: formatDateTime(programEndAt.toISOString()),
			})}
			className="space-y-1"
		>
			<div className="relative h-6 overflow-hidden rounded border border-zinc-800 bg-zinc-900">
				{/* Pre-air window: slate cover (amber) or bare stream (zinc). */}
				{preAirPct > 0 ? (
					<div
						aria-hidden="true"
						data-segment={slate ? "slate" : "preair"}
						className={`absolute inset-y-0 left-0 ${slate ? "bg-amber-500/40" : "bg-zinc-700/40"}`}
						style={{ width: `${preAirPct.toFixed(2)}%` }}
						title={
							slate ? t("schedule.slateCover") : t("schedule.preAirNoSlate")
						}
					/>
				) : null}
				{/* The program itself. */}
				<div
					aria-hidden="true"
					data-segment="program"
					className="absolute inset-y-0 bg-emerald-500/30"
					style={{
						left: `${preAirPct.toFixed(2)}%`,
						width: `${(100 - preAirPct).toFixed(2)}%`,
					}}
					title={t("schedule.programWindow")}
				/>
				{/* Row markers: what actually happened, where. */}
				{(rows ?? []).map((row) => (
					<div
						key={`${row.action}-${row.fireAt}`}
						aria-hidden="true"
						data-marker={row.action}
						data-status={row.status}
						// audit 602ec286 HIGH-8: expose the outcome the bar is
						// coloured from, so a test (and an inspecting operator) can
						// read WHY a FIRED marker is amber or red rather than green.
						data-outcome={
							row.status === "FIRED" ? (row.outcome ?? "PENDING") : undefined
						}
						className={`absolute inset-y-0 w-0.5 ${rowTone(row)}`}
						style={{ left: pct(Date.parse(row.fireAt)) }}
						title={`${row.action} — ${row.status === "FIRED" ? (row.outcome ?? "PENDING") : row.status} @ ${formatDateTime(row.fireAt)}`}
					/>
				))}
				{/* Now, when inside the slot. */}
				{nowMs !== undefined && nowMs >= up && nowMs <= end ? (
					<div
						aria-hidden="true"
						data-marker="now"
						className="absolute inset-y-0 w-0.5 bg-sky-400"
						style={{ left: pct(nowMs) }}
						title={t("schedule.nowMarker")}
					/>
				) : null}
			</div>
			<figcaption className="flex flex-wrap justify-between gap-x-3 text-[11px] text-zinc-500">
				<span>
					{t("schedule.streamUpShort")}{" "}
					{formatDateTime(streamUpAt.toISOString())}
				</span>
				<span className="text-emerald-500">
					{t("schedule.onAirShort")}{" "}
					{formatDateTime(programStartAt.toISOString())}
				</span>
				<span>
					{t("schedule.endShort")} {formatDateTime(programEndAt.toISOString())}
				</span>
			</figcaption>
			{rows && rows.length > 0 ? (
				<ul
					aria-label={t("schedule.timelineEvents")}
					className="mt-2 space-y-1 text-xs text-zinc-300"
				>
					{rows.map((row) => (
						<li
							key={`${row.action}-${row.fireAt}`}
							className="flex items-start gap-2"
						>
							<span aria-hidden="true" className="w-3 shrink-0 text-center">
								{rowSymbol(row)}
							</span>
							<span>
								{t(SCHEDULE_ACTION_LABEL_KEYS[row.action])} — {rowLabel(row)} —{" "}
								<time dateTime={row.fireAt}>{formatDateTime(row.fireAt)}</time>
							</span>
						</li>
					))}
				</ul>
			) : null}
		</figure>
	);
}
