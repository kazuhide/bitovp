"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
	CartesianGrid,
	Line,
	LineChart,
	ReferenceDot,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import type { HeartbeatHistoryResponse } from "@/app/api/live-channels/[id]/heartbeats/route";
import { isActiveChannelStatus } from "@/app/live/live-shared";
import { apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";

/** The four per-poll packet-delta series, with the VMAF-report color family. */
const SERIES = [
	{
		key: "droppedPacketsVideo",
		labelKey: "heartbeat.droppedVideo",
		color: "#f59e0b",
	},
	{
		key: "droppedPacketsAudio",
		labelKey: "heartbeat.droppedAudio",
		color: "#fbbf24",
	},
	{
		key: "corruptPacketsVideo",
		labelKey: "heartbeat.corruptVideo",
		color: "#ef4444",
	},
	{
		key: "corruptPacketsAudio",
		labelKey: "heartbeat.corruptAudio",
		color: "#f472b6",
	},
] as const satisfies readonly {
	key: string;
	labelKey: MessageKey;
	color: string;
}[];

/** The measured incoming-bitrate overlay (right axis, Mbps) — its own toggle. */
const INCOMING_KEY = "incomingBitrate";
const INCOMING_COLOR = "#38bdf8";

/** Short clock label for the time axis / tooltip (full timestamp on hover). */
function clock(at: string): string {
	const date = new Date(at);
	return Number.isNaN(date.getTime())
		? "—"
		: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Heartbeat trend chart (the dashboard time-series). Fetches the channel's
 * recent LiveHeartbeat history and overlays the four per-poll packet-delta
 * counters as lines over time — a spike is a packet-loss event, distinct from
 * the lifetime totals the current-state panel shows. Ingest-status CHANGES are
 * marked with reference dots (amber when the new status reads unhealthy) so a
 * disconnect/reconnect is visible against the deltas. Refreshes on the same
 * RUNNING cadence as the detail page (the 30s sweep feeds it). Renders inside a
 * fixed-height box because Recharts' ResponsiveContainer measures via
 * ResizeObserver (0×0 under jsdom — the tests mock the container to a fixed
 * size).
 */
export function HeartbeatHistory({
	channelId,
	status,
	runId,
	alertMarks = [],
}: {
	channelId: string;
	status: string;
	/**
	 * Run-scoped post-mortem : fetch THIS
	 * run's samples un-windowed instead of the channel's recent 2h — for a
	 * finished broadcast, "recent relative to now" is empty. Static (no
	 * refetch): the run is over.
	 */
	runId?: string;
	/**
	 * Alert-open times  — rendered as red reference dots on the
	 * same time axis, linking the alert history to WHAT the chart showed.
	 */
	alertMarks?: { id: string; at: string; severity: string }[];
}) {
	const { t } = useT();
	// Filter visible measurement series.
	// — legend chips are toggle buttons; hidden series keep their chip
	// (dimmed) so "off" is visible state, not absence.
	const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
	const toggle = (key: string) =>
		setHidden((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	const history = useQuery({
		queryKey: ["live-channel-heartbeats", channelId, runId ?? "recent"],
		queryFn: () =>
			apiFetch<HeartbeatHistoryResponse>(
				runId
					? `/api/live-channels/${channelId}/heartbeats?runId=${runId}`
					: `/api/live-channels/${channelId}/heartbeats`,
			),
		// Same cadence as the heartbeat sweep while the channel is live; idle
		// channels and finished-run reviews don't accrue new points.
		refetchInterval:
			!runId && isActiveChannelStatus(status as never) ? 30_000 : false,
	});

	// review-83b C2: Recharts' default XAxis is a CATEGORY axis — a
	// ReferenceDot whose x is not byte-identical to a point's `at` string
	// collapses to cx=0 (the left border). Alert openedAt comes from a
	// different clock than the poll samples, so EVERY alert dot landed
	// there. A numeric epoch axis positions any timestamp truthfully.
	const points = (history.data?.points ?? []).map((point) => ({
		...point,
		atMs: Date.parse(point.at),
		// Right-axis series in Mbps (the payload carries bps). Undefined when the
		// sample never reported an incoming bitrate, so the line simply gaps.
		incomingMbps:
			point.incomingBitrate != null
				? point.incomingBitrate / 1_000_000
				: undefined,
	}));
	const hasIncoming = points.some((point) => point.incomingMbps != null);
	const showIncoming = hasIncoming && !hidden.has(INCOMING_KEY);

	// Mark only the polls where ingest status CHANGED from the previous point —
	// a steady stream would otherwise paint a dot on every poll. The first
	// point is always a marker (the baseline status).
	const statusChanges = useMemo(() => {
		const marks: { at: string; status: string; healthy: boolean }[] = [];
		let prev: string | undefined;
		for (const point of points) {
			if (point.ingestStatus !== prev) {
				marks.push({
					at: point.at,
					status: point.ingestStatus,
					healthy:
						point.ingestStatus === "CONNECTED" ||
						point.ingestStatus === "HEALTHY",
				});
				prev = point.ingestStatus;
			}
		}
		return marks;
	}, [points]);

	if (history.isLoading) {
		return (
			<div
				role="status"
				aria-label={t("heartbeat.loadingHistory")}
				className="mt-2 h-64 animate-pulse rounded-lg border border-zinc-800 bg-zinc-900/40"
			/>
		);
	}

	/* A failed history fetch must render an explicit error rather than an empty-history claim. Keep previously fetched points visible, with their stale status above the chart. */
	const unavailableLine = history.isError ? (
		<p
			role="status"
			data-heartbeat-unavailable="true"
			className="mt-2 rounded border border-amber-700/60 bg-amber-950/30 px-2 py-1.5 text-amber-300 text-xs"
		>
			{t("status.readUnavailable")}
		</p>
	) : null;

	if (points.length === 0) {
		return (
			unavailableLine ?? (
				<p className="mt-2 text-sm text-zinc-500">{t("heartbeat.noHistory")}</p>
			)
		);
	}

	return (
		<div className="mt-2">
			{unavailableLine}
			<div className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
				{SERIES.map((s) => (
					<button
						key={s.key}
						type="button"
						aria-pressed={!hidden.has(s.key)}
						onClick={() => toggle(s.key)}
						className={`flex items-center gap-1.5 text-[11px] ${
							hidden.has(s.key) ? "opacity-40" : ""
						}`}
					>
						<span
							aria-hidden
							className="inline-block h-2 w-2 rounded-full"
							style={{ background: s.color }}
						/>
						<span className="text-zinc-400">{t(s.labelKey)}</span>
					</button>
				))}
				{hasIncoming ? (
					<button
						type="button"
						aria-pressed={!hidden.has(INCOMING_KEY)}
						onClick={() => toggle(INCOMING_KEY)}
						className={`flex items-center gap-1.5 text-[11px] ${
							hidden.has(INCOMING_KEY) ? "opacity-40" : ""
						}`}
					>
						<span
							aria-hidden
							className="inline-block h-2 w-2 rounded-full"
							style={{ background: INCOMING_COLOR }}
						/>
						<span className="text-zinc-400">
							{t("heartbeatLog.incomingMbps")}
						</span>
					</button>
				) : null}
			</div>
			<div className="h-64 w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2">
				<ResponsiveContainer
					width="100%"
					height="100%"
					initialDimension={{ width: 0, height: 238 }}
				>
					<LineChart
						data={points}
						margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
					>
						<CartesianGrid
							stroke="var(--color-zinc-800)"
							strokeDasharray="3 3"
						/>
						<XAxis
							dataKey="atMs"
							type="number"
							domain={["dataMin", "dataMax"]}
							tickFormatter={(value) =>
								clock(new Date(Number(value)).toISOString())
							}
							stroke="var(--color-zinc-600)"
							tick={{ fill: "var(--color-zinc-400)", fontSize: 11 }}
							tickLine={false}
							minTickGap={32}
						/>
						<YAxis
							yAxisId="pkts"
							allowDecimals={false}
							stroke="var(--color-zinc-600)"
							tick={{ fill: "var(--color-zinc-400)", fontSize: 11 }}
							tickLine={false}
							width={36}
							label={{
								value: "packets",
								angle: -90,
								position: "insideLeft",
								fill: "var(--color-zinc-600)",
								fontSize: 10,
							}}
						/>
						{hasIncoming ? (
							<YAxis
								yAxisId="mbps"
								orientation="right"
								stroke="var(--color-zinc-600)"
								tick={{ fill: "var(--color-zinc-400)", fontSize: 11 }}
								tickLine={false}
								width={40}
								label={{
									value: "Mbps",
									angle: 90,
									position: "insideRight",
									fill: "var(--color-zinc-600)",
									fontSize: 10,
								}}
							/>
						) : null}
						<Tooltip
							contentStyle={{
								background: "var(--color-zinc-900)",
								border: "1px solid var(--color-zinc-700)",
								borderRadius: 6,
								fontSize: 12,
							}}
							labelStyle={{ color: "var(--color-zinc-200)" }}
							labelFormatter={(v) =>
								formatDateTime(new Date(Number(v)).toISOString())
							}
						/>
						{SERIES.filter((s) => !hidden.has(s.key)).map((s) => (
							<Line
								key={s.key}
								yAxisId="pkts"
								type="monotone"
								dataKey={s.key}
								name={t(s.labelKey)}
								stroke={s.color}
								strokeWidth={1.5}
								dot={false}
								isAnimationActive={false}
							/>
						))}
						{showIncoming ? (
							<Line
								yAxisId="mbps"
								type="monotone"
								dataKey="incomingMbps"
								name={t("heartbeatLog.incomingMbps")}
								stroke={INCOMING_COLOR}
								strokeWidth={1.5}
								dot={false}
								isAnimationActive={false}
								connectNulls
							/>
						) : null}
						{statusChanges.map((mark) => (
							<ReferenceDot
								key={mark.at}
								yAxisId="pkts"
								x={Date.parse(mark.at)}
								y={0}
								r={4}
								fill={mark.healthy ? "#10b981" : "#f59e0b"}
								stroke="var(--color-zinc-50)"
								strokeWidth={1}
								ifOverflow="extendDomain"
							/>
						))}
						{alertMarks.map((mark) => (
							<ReferenceDot
								// Keyed by EVENT id (review-83b N7): same-millisecond
								// alerts collided on the timestamp key.
								key={`alert-${mark.id}`}
								yAxisId="pkts"
								x={Date.parse(mark.at)}
								y={0}
								r={5}
								fill={mark.severity === "CRIT" ? "#ef4444" : "#f59e0b"}
								stroke="var(--color-zinc-900)"
								strokeWidth={1.5}
								ifOverflow="extendDomain"
							/>
						))}
					</LineChart>
				</ResponsiveContainer>
			</div>
			<p className="mt-1 text-[11px] text-zinc-500">
				{/* A run-scoped chart covers the whole broadcast; its caption must not claim a shorter rolling window. */}
				{runId
					? t("uiX.heartbeatHistoryRunHint")
					: t("uiX.heartbeatHistoryHint", {
							minutes: history.data?.windowMinutes ?? 120,
						})}
			</p>
		</div>
	);
}
