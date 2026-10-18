"use client";

import type { RunHealthPoint, RunTimelineWindow } from "@bitovp/core";
import { useId } from "react";
import {
	CartesianGrid,
	Line,
	LineChart,
	ReferenceDot,
	ReferenceLine,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { useT } from "@/lib/i18n/context";
import type { MessageKey } from "@/lib/i18n/messages/en";
import type { PushTimeline } from "../live-shared";
import type { DisplayTimelineEvent } from "./push-timeline";
import { jumpToLiveSection } from "./section-focus";

/* The run timeline starts at ENCODER_RUNNING, with allocation wait shown separately. Input, encoder, and output observations share a numeric epoch-millisecond axis with discrete lifecycle events. A category axis would collapse events whose timestamps do not exactly match poll samples. An ordered text list preserves exact times and accessible history. */

const LANE_BASE = { output: 0, encoder: 1.2, ingest: 2.4 } as const;
const ON = 0.85;
const OFF = 0.1;
const laneY = (lane: keyof typeof LANE_BASE, on: boolean) =>
	LANE_BASE[lane] + (on ? ON : OFF);
/**
 * Where each event kind's mark sits: on its subject's lane, at the level the
 * event ANNOUNCES (review-294 S2 — a disconnect dot on the healthy line said
 * the opposite of its own label, and a one-poll span stacked its connect and
 * disconnect at the same coordinate). Down-events sit at the OFF level,
 * up-events at ON; content floats above every lane.
 */
const EVENT_Y: Record<DisplayTimelineEvent["kind"], number> = {
	START_REQUESTED: LANE_BASE.encoder + OFF,
	ENCODER_QUEUED: LANE_BASE.encoder + OFF,
	ENCODER_RUNNING: LANE_BASE.encoder + ON,
	ENCODER_STOPPED: LANE_BASE.encoder + OFF,
	INPUT_CONNECTED: LANE_BASE.ingest + ON,
	INPUT_RECONNECTED: LANE_BASE.ingest + ON,
	INPUT_DISCONNECTED: LANE_BASE.ingest + OFF,
	OUTPUT_ACTIVE: LANE_BASE.output + ON,
	CONTENT_INSERTED: 3.45,
	CONTENT_STOPPED: 3.45,
	SCTE35_CUE: 3.45,
	ESAM_SIGNAL: 3.45,
	STOP_REQUESTED: LANE_BASE.encoder + OFF,
	RESTART_REQUESTED: LANE_BASE.encoder + OFF,
	TIMESHIFT_RESET: 3.45,
};
const EVENT_COLOR: Record<DisplayTimelineEvent["kind"], string> = {
	START_REQUESTED: "var(--color-zinc-400)",
	ENCODER_QUEUED: "var(--color-zinc-400)",
	ENCODER_RUNNING: "#10b981",
	ENCODER_STOPPED: "#ef4444",
	INPUT_CONNECTED: "#38bdf8",
	INPUT_RECONNECTED: "#38bdf8",
	INPUT_DISCONNECTED: "#ef4444",
	OUTPUT_ACTIVE: "#f59e0b",
	CONTENT_INSERTED: "#a78bfa",
	CONTENT_STOPPED: "#a78bfa",
	SCTE35_CUE: "#22d3ee",
	ESAM_SIGNAL: "#2dd4bf",
	STOP_REQUESTED: "#fb923c",
	RESTART_REQUESTED: "#facc15",
	TIMESHIFT_RESET: "#818cf8",
};

export function eventLabelKey(kind: DisplayTimelineEvent["kind"]): MessageKey {
	switch (kind) {
		case "START_REQUESTED":
			return "live.health.eventStartRequested";
		case "ENCODER_QUEUED":
			return "live.health.eventQueued";
		case "ENCODER_RUNNING":
			return "live.health.eventRunning";
		case "INPUT_CONNECTED":
			return "live.health.eventInputConnected";
		case "INPUT_RECONNECTED":
			return "live.health.eventInputReconnected";
		case "INPUT_DISCONNECTED":
			return "live.health.eventInputDisconnected";
		case "OUTPUT_ACTIVE":
			return "live.health.eventOutputActive";
		case "CONTENT_INSERTED":
			return "live.health.eventContentInserted";
		case "CONTENT_STOPPED":
			return "live.health.eventContentStopped";
		case "SCTE35_CUE":
			return "live.health.eventScte35";
		case "ESAM_SIGNAL":
			return "live.health.eventEsam";
		case "STOP_REQUESTED":
			return "live.health.eventStopRequested";
		case "RESTART_REQUESTED":
			return "live.health.eventRestartRequested";
		case "TIMESHIFT_RESET":
			return "live.health.eventTimeshiftReset";
		case "ENCODER_STOPPED":
			return "live.health.eventStopped";
	}
}

const clock = (ms: number) =>
	new Date(ms).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});

export function RunTimelineChart({
	window: win,
	events,
	points,
	nowMs,
	pushTimeline,
	laneSources,
}: {
	window: RunTimelineWindow;
	events: DisplayTimelineEvent[];
	points: RunHealthPoint[];
	/** The axis end for a still-live run — the caller's clock, not ours. */
	nowMs: number;
	pushTimeline?: PushTimeline;
	/** : Push drew the state lines where it was received. */
	laneSources?: { push: boolean; pushTruncated: boolean };
}) {
	const { t } = useT();
	const descriptionId = useId();
	// Keep every change and the time bounds, not thousands of identical polls.
	// These are observations only, never inferred states between samples.
	const stateHistory = points
		.toSorted((a, b) => a.atMs - b.atMs)
		.filter((p, i, all) => {
			const previous = all[i - 1];
			return (
				!previous ||
				i === all.length - 1 ||
				p.ingest !== previous.ingest ||
				p.encoder !== previous.encoder ||
				p.output !== previous.output
			);
		});
	const endMs = win.endMs ?? nowMs;
	const runningAt = events.find((e) => e.kind === "ENCODER_RUNNING")?.atMs;
	// Axis origin = RUNNING (owner follow-up); window.startMs remains the
	// start request and feeds the startup FIGURE, not the axis. A run
	// that never reached RUNNING renders no chart (the caller guards).
	const chartStartMs = runningAt ?? win.startMs;
	// A degenerate window (clock skew, instant failure) still needs a domain.
	const domain: [number, number] = [
		chartStartMs,
		Math.max(endMs, chartStartMs + 1_000),
	];
	const rows: Array<Record<string, number>> = points.map((p) => ({
		atMs: p.atMs,
		ingest: laneY("ingest", p.ingest),
		encoder: laneY("encoder", p.encoder),
		output: laneY("output", p.output),
	}));
	// Axis anchors (review-294 C3): with an empty data array recharts builds
	// NO scales and every ReferenceDot/ReferenceLine silently returns null —
	// a just-RUNNING run with no heartbeat row yet would render an empty
	// frame with no event dots. Two rows carrying only an invisible `_axis`
	// value force both scales into existence without painting lane state
	// nobody observed. (The allocation BAND this fix originally served was
	// removed by the owner's axis-from-RUNNING follow-up; the mechanism
	// stays for the dots.)
	rows.push({ atMs: domain[0], _axis: 0 }, { atMs: domain[1], _axis: 3.6 });
	rows.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
	const stoppedAt = events.find((e) => e.kind === "ENCODER_STOPPED")?.atMs;
	const laneLabel = (y: number) =>
		y > 2
			? t("live.health.ingest")
			: y > 1
				? t("live.health.encoder")
				: t("live.health.output");
	return (
		<figure className="space-y-2">
			<p
				className="text-xs text-zinc-500"
				title={pushTimeline ? t("live.health.pushCoverage") : undefined}
			>
				{laneSources?.push
					? t("live.health.timelineSourcesPush")
					: t("live.health.timelineSources")}
			</p>
			{laneSources?.pushTruncated ? (
				<p className="text-xs text-zinc-500">
					{t("live.health.pushLanesTruncated")}
				</p>
			) : null}
			<div
				className="h-56 w-full max-w-2xl rounded-lg border border-zinc-800 bg-zinc-950 p-2"
				role="img"
				aria-label={t("live.health.timelineTitle")}
				aria-describedby={descriptionId}
			>
				<ResponsiveContainer
					width="100%"
					height="100%"
					initialDimension={{ width: 0, height: 206 }}
				>
					<LineChart
						data={rows}
						margin={{ top: 10, right: 16, bottom: 8, left: 0 }}
					>
						<CartesianGrid
							stroke="var(--color-zinc-800)"
							strokeDasharray="3 3"
						/>
						<XAxis
							dataKey="atMs"
							type="number"
							domain={domain}
							allowDataOverflow
							tickFormatter={(value) => clock(Number(value))}
							stroke="var(--color-zinc-600)"
							tick={{ fill: "var(--color-zinc-400)", fontSize: 11 }}
							tickLine={false}
							minTickGap={48}
						/>
						<YAxis
							domain={[0, 3.6]}
							ticks={[
								LANE_BASE.output + ON / 2,
								LANE_BASE.encoder + ON / 2,
								LANE_BASE.ingest + ON / 2,
							]}
							tickFormatter={(value) => laneLabel(Number(value))}
							stroke="var(--color-zinc-600)"
							tick={{ fill: "var(--color-zinc-400)", fontSize: 11 }}
							tickLine={false}
							width={72}
						/>
						<Tooltip
							contentStyle={{
								background: "var(--color-zinc-900)",
								border: "1px solid var(--color-zinc-700)",
								borderRadius: 6,
								fontSize: 12,
							}}
							labelStyle={{ color: "var(--color-zinc-200)" }}
							labelFormatter={(v) => clock(Number(v))}
							// Lane bases are multiples of 1.2 with ON=+0.85 / OFF=+0.1,
							// so `% 1.2` recovers the offset for every lane at once.
							formatter={(value, name) => [
								Number(value) % 1.2 > 0.5
									? t("live.health.ok")
									: t("live.health.down"),
								name,
							]}
						/>
						{/* The scale anchor — see the rows comment above. stroke none,
						    no dots, excluded from the tooltip: it must never PAINT. */}
						<Line
							dataKey="_axis"
							stroke="none"
							dot={false}
							activeDot={false}
							isAnimationActive={false}
							legendType="none"
							tooltipType="none"
						/>
						{/* ifOverflow=hidden CLIPS at the domain edge (N5) — the
						    pre-RUNNING events (start requested / queued) fall left of
						    the axis by design and vanish from the PLOT while keeping
						    their rows in the list below. */}
						{stoppedAt !== undefined ? (
							<ReferenceLine
								x={stoppedAt}
								stroke="#ef4444"
								strokeDasharray="4 3"
								ifOverflow="hidden"
							/>
						) : null}
						{(["ingest", "encoder", "output"] as const).map((lane) => (
							<Line
								key={lane}
								type="stepAfter"
								dataKey={lane}
								name={t(
									lane === "ingest"
										? "live.health.ingest"
										: lane === "encoder"
											? "live.health.encoder"
											: "live.health.output",
								)}
								stroke={
									lane === "ingest"
										? "#38bdf8"
										: lane === "encoder"
											? "#10b981"
											: "#f59e0b"
								}
								strokeWidth={1.5}
								dot={false}
								isAnimationActive={false}
							/>
						))}
						{events.map((e, i) => (
							<ReferenceDot
								// kind+atMs can collide only for same-kind same-ms
								// duplicates, which the index disambiguates.
								key={`${e.kind}-${e.atMs}-${i}`}
								x={e.atMs}
								y={EVENT_Y[e.kind]}
								r={4}
								fill={EVENT_COLOR[e.kind]}
								stroke="var(--color-zinc-900)"
								strokeWidth={1}
								ifOverflow="hidden"
							/>
						))}
					</LineChart>
				</ResponsiveContainer>
			</div>
			<div className="sr-only">
				<p id={descriptionId}>
					{t(
						stateHistory.length
							? "live.health.stateHistoryDescription"
							: "live.health.stateHistoryEmpty",
					)}
				</p>
				{stateHistory.length > 0 ? (
					<ol aria-label={t("live.health.stateHistory")}>
						{stateHistory.map((p, i) => (
							<li key={`${p.atMs}-${i}`}>
								<time dateTime={new Date(p.atMs).toISOString()}>
									{clock(p.atMs)}
								</time>{" "}
								{(["ingest", "encoder", "output"] as const).map(
									(lane, index) => (
										<span key={lane}>
											{index > 0 ? "; " : ""}
											{t(`live.health.${lane}`)}:{" "}
											{t(p[lane] ? "live.health.ok" : "live.health.down")}
										</span>
									),
								)}
							</li>
						))}
					</ol>
				) : null}
			</div>
			{/* The precision + screen-reader layer: every mark, in words. Omitted
			    while empty (review-294 S5) — early provisioning has no events
			    yet and an empty <ol> is a blank pretending to be a list. */}
			{events.length > 0 ? (
				<ol className="max-w-2xl space-y-0.5 text-xs">
					{events.map((e, i) => (
						<li
							key={`${e.kind}-${e.atMs}-${i}`}
							className="flex items-center gap-2"
						>
							<span
								aria-hidden
								className="inline-block h-2 w-2 rounded-full"
								style={{ background: EVENT_COLOR[e.kind] }}
							/>
							<time
								dateTime={new Date(e.atMs).toISOString()}
								className="tabular-nums text-zinc-500"
							>
								{clock(e.atMs)}
							</time>
							<span className="text-zinc-300">{t(eventLabelKey(e.kind))}</span>
							{e.source === "push" || e.source === "heartbeat" ? (
								<span className="text-zinc-500">
									{e.source === "push" ? "Push" : "Poll"}
								</span>
							) : null}
						</li>
					))}
				</ol>
			) : null}
			{pushTimeline?.truncated ? (
				<p className="text-xs text-zinc-400">
					{t("live.health.pushTruncated")}{" "}
					{/* biome-ignore lint/a11y/useValidAnchor: real fragment navigation; handler adds keyboard focus without replacing the link. */}
					<a
						href="#sec-heartbeat-log"
						className="underline underline-offset-2"
						onClick={(event) => jumpToLiveSection(event, "sec-heartbeat-log")}
					>
						{t("live.health.pushLogLink")}
					</a>
				</p>
			) : null}
		</figure>
	);
}
