"use client";

import { heartbeatSampleFresh } from "@bitovp/core";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import { type HeartbeatCounters, parseHeartbeat } from "./heartbeat";

/** Catalogue KEYS, not copy — module scope, so `useT` cannot be called here. */
const COUNTER_LABELS: { key: keyof HeartbeatCounters; labelKey: MessageKey }[] =
	[
		{ key: "droppedPacketsVideo", labelKey: "heartbeat.droppedVideo" },
		{ key: "droppedPacketsAudio", labelKey: "heartbeat.droppedAudio" },
		{ key: "corruptPacketsVideo", labelKey: "heartbeat.corruptVideo" },
		{ key: "corruptPacketsAudio", labelKey: "heartbeat.corruptAudio" },
	];

function statusTone(
	status: string,
	healthy: boolean | null,
): "neutral" | "ok" | "error" {
	if (healthy === false) {
		return "error";
	}
	if (healthy === true || status === "CONNECTED" || status === "HEALTHY") {
		return "ok";
	}
	if (status === "ERROR" || status === "DISCONNECTED") {
		return "error";
	}
	return "neutral";
}

/**
 * Heartbeat dashboard fed by the persisted `lastHeartbeat` column
 * ({ at, raw, deltas }): ingest status, per-stream table, per-poll packet
 * DELTAS (with the cumulative totals labelled separately — the SDK
 * counters are cumulative since encoding start) and the event list.
 */
export function HeartbeatPanel({
	lastHeartbeat,
	nowMs,
}: {
	lastHeartbeat: unknown;
	/**
	 * The comparison clock for "is this sample still vouching" — the parent's
	 * server-anchored now , never the raw
	 * viewer clock: a viewer 90 s fast read a fresh sample as stale here too
	 * (review-334 — the #127 lie's second place, clock half). Required, so a
	 * new mount site cannot fall back to `Date.now` by omission.
	 */
	nowMs: number;
}) {
	const { t } = useT();
	const view = parseHeartbeat(lastHeartbeat);
	if (!view) {
		return (
			<p className="mt-2 text-sm text-zinc-500">
				{t("prose.noHeartbeatSample")}
			</p>
		);
	}
	// review-260 127-A2: this panel renders the persisted SAMPLE — after a
	// stop or a dead sweep that sample freezes, and a green CONNECTED badge
	// on frozen evidence is the #127 lie in a second place. Past the vouching
	// window the badge goes neutral and says the sample is stale; the as-of
	// stamp below has always carried the exact time.
	//
	// : the SHARED helper, not a hand-rolled copy of its
	// comparison. The copy was one-sided (`now - at > MAX`), so a sample
	// stamped in the FUTURE by a skewed worker clock scored a negative age,
	// counted as not-stale, and painted the green CONNECTED badge this
	// very check exists to withhold — and an unparseable `at` did the same
	// through NaN. The helper answers both, with the symmetric window.
	const sampleStale = !heartbeatSampleFresh(lastHeartbeat, nowMs);
	return (
		<div className="mt-2 space-y-3">
			<div className="flex flex-wrap items-center gap-3">
				<Badge
					tone={
						sampleStale
							? "neutral"
							: statusTone(view.ingestStatus, view.healthy)
					}
				>
					{t("uiX.ingestStatusBadge", { status: view.ingestStatus })}
				</Badge>
				{sampleStale ? (
					<span className="text-xs text-zinc-500">{t("uiX.sampleStale")}</span>
				) : null}
				{view.healthy !== null ? (
					<span className="text-xs text-zinc-400">
						{t(view.healthy ? "uiX.healthy" : "uiX.unhealthy")}
					</span>
				) : null}
				<span className="text-xs text-zinc-500">
					{t("uiX.asOfSweep", {
						when: view.at ? formatDateTime(view.at) : "—",
					})}
				</span>
			</div>

			<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				{COUNTER_LABELS.map(({ key, labelKey }) => {
					const delta = view.deltas[key];
					const total = view.totals[key];
					return (
						<div
							key={key}
							className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2"
						>
							<p className="text-[11px] text-zinc-500">{t(labelKey)}</p>
							<p
								className={`font-mono text-lg ${
									(delta ?? 0) > 0 ? "text-amber-300" : "text-zinc-200"
								}`}
							>
								{delta !== undefined ? `+${delta}` : "—"}
							</p>
							<p className="text-[11px] text-zinc-600">
								{t("uiX.thisPollLifetime", { total: total ?? "—" })}
							</p>
						</div>
					);
				})}
			</div>
			<p className="text-[11px] text-zinc-500">{t("prose.heartbeatDeltas")}</p>

			{view.streams.length > 0 ? (
				<div className="overflow-x-auto rounded-md border border-zinc-800">
					<table className="w-full text-xs">
						<thead>
							<tr className="border-zinc-800 border-b text-left text-[11px] text-zinc-500">
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeat.stream")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeat.type")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeat.codec")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeat.resolution")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeat.rate")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeat.bitrate")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeat.keyframeAvg")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeat.keyframeMax")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeat.keyframeLastMinute")}
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800/70">
							{view.streams.map((stream) => (
								<tr key={stream.id}>
									<td className="px-2 py-1.5 font-mono text-zinc-400">
										{stream.id}
									</td>
									<td className="px-2 py-1.5 text-zinc-300">
										{stream.mediaType}
									</td>
									<td className="px-2 py-1.5 text-zinc-300">{stream.codec}</td>
									<td className="px-2 py-1.5 text-zinc-300">
										{stream.resolution}
									</td>
									<td className="px-2 py-1.5 text-zinc-300">{stream.rate}</td>
									<td className="px-2 py-1.5 text-zinc-300">
										{stream.bitrate}
									</td>
									<td className="px-2 py-1.5 font-mono text-zinc-300">
										{stream.keyframeAvg}
									</td>
									<td className="px-2 py-1.5 font-mono text-zinc-300">
										{stream.keyframeMax}
									</td>
									<td className="px-2 py-1.5 font-mono text-zinc-300">
										{stream.keyframeLastMinute}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p className="text-xs text-zinc-500">
					{t("heartbeat.noStreamDetails")}
				</p>
			)}

			{/*
			 * Events are connect/disconnect/warning transitions Bitmovin reports
			 * only when they happen — a healthy stream reports none after the
			 * initial FIRST_CONNECT. Keep the section (and its header) always
			 * visible with an explicit healthy-state line so an empty list reads
			 * as "nothing to report", not "the panel is broken". Live status,
			 * the "as of" timestamp and packet deltas above are the liveness
			 * signal that keeps updating every 30s sweep.
			 */}
			<div>
				<h4 className="font-medium text-xs text-zinc-300">
					{t("heartbeat.events")}
				</h4>
				{view.events.length > 0 ? (
					<ul className="mt-1 space-y-1">
						{view.events.map((event, index) => (
							<li
								key={index}
								className="flex gap-2 rounded border border-zinc-800/70 px-2 py-1 text-[11px]"
							>
								<span className="shrink-0 text-zinc-500">
									{event.time === "—" ? "—" : formatDateTime(event.time)}
								</span>
								{event.eventType !== "—" ? (
									<span
										className={`shrink-0 font-mono ${
											event.eventType === "WARNING" ||
											event.eventType === "ERROR"
												? "text-amber-300"
												: "text-zinc-400"
										}`}
									>
										{event.eventType}
									</span>
								) : null}
								{event.text !== event.eventType ? (
									<span className="min-w-0 break-all text-zinc-300">
										{event.text}
									</span>
								) : null}
							</li>
						))}
					</ul>
				) : (
					<p className="mt-1 text-xs text-zinc-500">
						{t("prose.noConnectEvents")}
					</p>
				)}
			</div>
		</div>
	);
}
