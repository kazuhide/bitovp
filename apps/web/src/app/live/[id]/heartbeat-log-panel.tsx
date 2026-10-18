"use client";

import type { LiveChannelStatus, ProviderHeartbeatEvent } from "@bitovp/core";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import type { HeartbeatLogResponse } from "@/app/api/live-channels/[id]/runs/[runId]/heartbeats/route";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { RoleAccess, useMutationAccess } from "@/lib/auth/use-role-access";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import {
	type HeartbeatLogView,
	heartbeatLogView,
	incomingMbps,
} from "./heartbeat";
import { ProviderDiagnosticsPanel } from "./provider-diagnostics-panel";
import { PushHeartbeatLog } from "./push-heartbeat-log";

/**
 * The two contract paths, spelled exactly as `ROUTE_RULES` and API-USAGE
 * spell them, with the bracket segments substituted at call time — the
 * mutation-controls census reads these literals off this file, so the panel
 * cannot drift from the floor that guards it.
 */
const HEARTBEAT_LOG_API = "/api/live-channels/[id]/runs/[runId]/heartbeats";
const HEARTBEAT_EXPORT_API =
	"/api/live-channels/[id]/runs/[runId]/heartbeats/export";
const PAGE_SIZE = 200;

function runPath(template: string, channelId: string, runId: string): string {
	return template.replace("[id]", channelId).replace("[runId]", runId);
}

type RunOption = {
	id: string;
	seq: number;
	status: string;
	createdAt: string;
	endedAt: string | null;
};

const SELECT_CLASS =
	"h-9 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200";

function ms(value: number | null): string {
	return value === null ? "—" : `${Math.round(value)}`;
}

function ageSeconds(value: number | null): string {
	return value === null ? "—" : `${Math.round(value / 1000)}`;
}

function delta(value: number | undefined): string {
	return value === undefined ? "—" : value > 0 ? `+${value}` : "0";
}

function statusTone(
	status: string,
	healthy: boolean | null,
): "neutral" | "ok" | "error" {
	if (healthy === false || status === "DISCONNECTED" || status === "ERROR") {
		return "error";
	}
	if (healthy === true || status === "CONNECTED") {
		return "ok";
	}
	return "neutral";
}

/**
 * Run-scoped diagnostics: verified Push receipts first, followed by every persisted poll,
 * oldest first, with a raw-JSON drawer per row so a provider field the table
 * does not know still reaches the operator. Pages through the OPERATOR-floor
 * route (`nextCursor`); the whole run leaves as one JSON file through the
 * ADMIN-floor export. The persistent event list is the provider's cumulative
 * `events[]` as of the run's newest sample, and each row lists only the
 * events that APPEARED at that poll (the list is cumulative — a difference is
 * the only honest per-row reading).
 */
export function HeartbeatLogPanel({
	channelId,
	currentRunId,
	currentRunStatus,
	open = false,
	currentRunActive = false,
}: {
	channelId: string;
	/** The channel's current run, preselected; null when the channel never ran. */
	currentRunId: string | null;
	currentRunStatus?: LiveChannelStatus;
	open?: boolean;
	currentRunActive?: boolean;
}) {
	const { t } = useT();
	const selectId = useId();
	const canRead = useMutationAccess("live.channel.heartbeat-log");
	const runs = useQuery({
		// Same key as RunsPanel: status changes refresh the list without a new timer.
		queryKey: ["live-channel-runs", channelId, currentRunId, currentRunStatus],
		queryFn: () =>
			apiFetch<{ runs: RunOption[] }>(`/api/live-channels/${channelId}/runs`),
		enabled: canRead,
	});
	const runOptions = useMemo(
		() => (Array.isArray(runs.data?.runs) ? runs.data.runs : []),
		[runs.data],
	);
	// Empty selection follows the current airing; an explicit historical id
	// stays fixed when another airing starts. The channel owner keys this panel.
	const [selectedRunId, setSelectedRunId] = useState("");
	const runId = selectedRunId || currentRunId || runOptions[0]?.id || null;
	const log = useInfiniteQuery({
		queryKey: ["live-run-heartbeat-log", channelId, runId],
		enabled: canRead && runId !== null,
		// rev433: the log used to freeze at the page's first fetch — a channel
		// that connected after the page opened showed only its WAITING rows.
		// Only the CURRENT run moves; an older run's log is history.
		refetchInterval: runId !== null && runId === currentRunId ? 30_000 : false,
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) => {
			const base = runPath(HEARTBEAT_LOG_API, channelId, runId ?? "");
			const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
			if (pageParam) {
				query.set("cursor", pageParam);
			}
			return apiFetch<HeartbeatLogResponse>(`${base}?${query.toString()}`);
		},
		getNextPageParam: (last) => last.nextCursor,
	});
	const pages = log.data?.pages ?? [];
	// Defensive on the wire shape: a page without `rows` (a proxy answering
	// with something else) renders as empty, never as a crashed channel page
	// — this panel is a diagnostic aside on a monitoring surface.
	const rawRows = useMemo(
		() => pages.flatMap((page) => (Array.isArray(page?.rows) ? page.rows : [])),
		[pages],
	);
	const rows = useMemo(() => {
		const out: HeartbeatLogView[] = [];
		let previousRaw: unknown;
		for (const row of rawRows) {
			out.push(heartbeatLogView(row, previousRaw));
			previousRaw = row.raw;
		}
		return out;
	}, [rawRows]);
	const run = pages[0]?.run;
	const latestEvents: ProviderHeartbeatEvent[] = Array.isArray(
		pages[0]?.latestEvents,
	)
		? (pages[0]?.latestEvents ?? [])
		: [];

	if (!canRead) {
		return (
			<p className="mt-2 text-sm text-zinc-500">
				{t("heartbeatLog.operatorOnly")}
			</p>
		);
	}
	if (runOptions.length === 0 && !runs.isPending) {
		return (
			<p className="mt-2 text-sm text-zinc-500">{t("heartbeatLog.noRuns")}</p>
		);
	}
	return (
		<div className="mt-2 space-y-3">
			<div className="flex flex-wrap items-end gap-3">
				<label className="flex flex-col gap-1 text-xs text-zinc-400">
					<span>{t("heartbeatLog.run")}</span>
					<select
						id={selectId}
						className={SELECT_CLASS}
						value={selectedRunId}
						onChange={(event) => setSelectedRunId(event.target.value)}
					>
						<option value="">{t("pushLog.current")}</option>
						{runOptions.map((option) => (
							<option key={option.id} value={option.id}>
								{t("runs.seq", { n: option.seq })} · {option.status} ·{" "}
								{formatDateTime(option.createdAt)}
							</option>
						))}
					</select>
				</label>
				{run?.summary ? (
					<span className="text-xs text-zinc-500">
						{t("heartbeatLog.summaryLine", {
							samples: run.summary.sampleCount,
							connectedMinutes: Math.round(
								run.summary.ingest.connectedSpanMs / 60_000,
							),
							warnings: run.summary.events.warning + run.summary.events.error,
						})}
						{run.summary.rowsPruned ? ` · ${t("heartbeatLog.rowsPruned")}` : ""}
					</span>
				) : null}
				<span className="grow" />
				{runId ? (
					<RoleAccess control="live.channel.heartbeat-export">
						<a
							className="inline-flex h-9 items-center rounded-md border border-zinc-700 px-3 text-xs text-zinc-200 hover:bg-zinc-900"
							href={runPath(HEARTBEAT_EXPORT_API, channelId, runId)}
							download
						>
							{t("heartbeatLog.export")}
						</a>
					</RoleAccess>
				) : null}
			</div>

			{runId ? (
				<ProviderDiagnosticsPanel
					channelId={channelId}
					runId={runId}
					status={
						runId === currentRunId
							? (currentRunStatus ??
								runOptions.find((option) => option.id === runId)?.status)
							: runOptions.find((option) => option.id === runId)?.status
					}
					open={open}
				/>
			) : null}

			{runId ? (
				<PushHeartbeatLog
					key={runId}
					channelId={channelId}
					runId={runId}
					currentRunId={currentRunId}
					currentRunActive={currentRunActive}
					currentRunStatus={currentRunStatus}
					open={open}
				/>
			) : null}
			<h4 className="border-zinc-800 border-t pt-3 font-medium text-sm text-zinc-200">
				{t("pushLog.poll")}
			</h4>

			{log.isError ? (
				<p
					role="status"
					className="rounded border border-amber-700/60 bg-amber-950/30 px-2 py-1.5 text-amber-300 text-xs"
				>
					{t("status.readUnavailable")}
				</p>
			) : null}

			<div>
				<h4 className="font-medium text-xs text-zinc-300">
					{t("heartbeatLog.eventsTitle")}
				</h4>
				{latestEvents.length > 0 ? (
					<ul className="mt-1 space-y-1">
						{latestEvents.map((event) => (
							<li
								key={event.key}
								className="flex flex-wrap gap-2 rounded border border-zinc-800/70 px-2 py-1 text-[11px]"
							>
								<span className="shrink-0 text-zinc-500">
									{event.time ? formatDateTime(event.time) : "—"}
								</span>
								<span
									className={`shrink-0 font-mono ${
										event.eventType === "WARNING" || event.eventType === "ERROR"
											? "text-amber-300"
											: "text-zinc-400"
									}`}
								>
									{event.eventType}
								</span>
								{event.message ? (
									<span className="min-w-0 break-words text-zinc-300">
										{event.message}
									</span>
								) : null}
							</li>
						))}
					</ul>
				) : (
					<p className="mt-1 text-xs text-zinc-500">
						{log.isPending
							? t("heartbeatLog.loading")
							: t("heartbeatLog.noEvents")}
					</p>
				)}
			</div>

			{rows.length === 0 ? (
				<p className="text-sm text-zinc-500">
					{log.isPending ? t("heartbeatLog.loading") : t("heartbeatLog.empty")}
				</p>
			) : (
				<div className="overflow-x-auto rounded-md border border-zinc-800">
					<table className="w-full text-xs">
						<thead>
							<tr className="border-zinc-800 border-b text-left text-[11px] text-zinc-500">
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeatLog.time")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeatLog.ingest")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeatLog.incomingMbps")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeatLog.fps")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeatLog.keyframe")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeatLog.packets")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeatLog.manifestAge")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeatLog.segmentMean")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeatLog.events")}
								</th>
								<th className="px-2 py-1.5 font-medium">
									{t("heartbeatLog.raw")}
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800/70">
							{rows.map((row, index) => (
								<tr key={row.id} data-heartbeat-row={row.id}>
									<td className="whitespace-nowrap px-2 py-1.5 font-mono text-zinc-400">
										{formatDateTime(row.at)}
									</td>
									<td className="px-2 py-1.5">
										<Badge tone={statusTone(row.ingestStatus, row.healthy)}>
											{row.ingestStatus}
										</Badge>
									</td>
									<td className="px-2 py-1.5 font-mono text-zinc-300">
										{incomingMbps(row.incomingBitrate)}
									</td>
									<td className="px-2 py-1.5 font-mono text-zinc-300">
										{row.fps === null ? "—" : row.fps}
									</td>
									<td className="px-2 py-1.5 font-mono text-zinc-300">
										{ms(row.keyframeAvg)} / {ms(row.keyframeMax)}
									</td>
									<td
										className={`px-2 py-1.5 font-mono ${
											Object.values(row.deltas).some((value) => value > 0)
												? "text-amber-300"
												: "text-zinc-300"
										}`}
									>
										{[
											row.deltas.droppedPacketsVideo,
											row.deltas.droppedPacketsAudio,
											row.deltas.corruptPacketsVideo,
											row.deltas.corruptPacketsAudio,
										]
											.map(delta)
											.join("/")}
									</td>
									<td className="px-2 py-1.5 font-mono text-zinc-300">
										{ageSeconds(row.manifestAgeMs)}
									</td>
									<td className="px-2 py-1.5 font-mono text-zinc-300">
										{ms(row.segmentMeanMs)}
									</td>
									<td className="px-2 py-1.5">
										{row.events.length > 0 ? (
											<span className="flex flex-wrap gap-1">
												{row.events.map((event) => (
													<Badge
														key={event.key}
														tone={
															event.eventType === "WARNING" ||
															event.eventType === "ERROR"
																? "warn"
																: "neutral"
														}
														title={event.message ?? undefined}
													>
														{event.eventType}
													</Badge>
												))}
											</span>
										) : (
											<span className="text-zinc-600">—</span>
										)}
									</td>
									<td className="px-2 py-1.5">
										<RawDrawer row={rawRows[index]} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			<div className="flex flex-wrap items-center gap-3">
				<p className="text-[11px] text-zinc-500">
					{t("heartbeatLog.rowsLoaded", { count: rows.length })}
				</p>
				{log.hasNextPage ? (
					<Button
						type="button"
						variant="secondary"
						size="sm"
						onClick={() => log.fetchNextPage()}
						disabled={log.isFetchingNextPage}
					>
						{t("heartbeatLog.loadMore")}
					</Button>
				) : null}
			</div>
			<p className="text-[11px] text-zinc-500">
				{t("heartbeatLog.columnsHint")}
			</p>
		</div>
	);
}

/**
 * The raw-JSON drawer: the persisted sample and deltas, verbatim. A native
 * `<details>` so the keyboard and screen-reader behaviour comes for free, and
 * the JSON is only stringified while open.
 */
function RawDrawer({
	row,
}: {
	row: { at: string; raw: unknown; deltas: unknown } | undefined;
}) {
	const { t } = useT();
	const [open, setOpen] = useState(false);
	if (!row) {
		return null;
	}
	return (
		<details
			onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
		>
			<summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">
				{t("heartbeatLog.rawToggle")}
			</summary>
			{open ? (
				<pre className="mt-1 max-h-96 max-w-2xl overflow-auto rounded border border-zinc-800 bg-zinc-950 p-2 text-[11px] text-zinc-300">
					{JSON.stringify(
						{ at: row.at, raw: row.raw, deltas: row.deltas },
						null,
						2,
					)}
				</pre>
			) : null}
		</details>
	);
}
