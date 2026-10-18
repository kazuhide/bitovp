"use client";

import type { LiveChannelStatus } from "@bitovp/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import type { HeartbeatReceiptPage } from "@/lib/server/heartbeat-receipt-value";
import { incomingMbps } from "./heartbeat";

const RECEIPTS_API = "/api/live-channels/[id]/runs/[runId]/heartbeat-receipts";
const ended = (status: string | undefined) =>
	status === "STOPPED" || status === "ERROR";

/** Mounted only inside the existing OPERATOR-gated heartbeat log. */
export function PushHeartbeatLog({
	channelId,
	runId,
	currentRunId,
	currentRunActive,
	currentRunStatus,
	open,
}: {
	channelId: string;
	runId: string;
	currentRunId: string | null;
	currentRunActive: boolean;
	currentRunStatus?: LiveChannelStatus;
	open: boolean;
}) {
	const { t } = useT();
	const [cursor, setCursor] = useState<string>();
	const [inspecting, setInspecting] = useState<Set<string>>(() => new Set());
	const [inspectionRows, setInspectionRows] = useState<
		HeartbeatReceiptPage["rows"] | null
	>(null);
	const [visible, setVisible] = useState(
		() =>
			typeof document !== "undefined" && document.visibilityState === "visible",
	);
	useEffect(() => {
		const update = () => setVisible(document.visibilityState === "visible");
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	const eligible =
		open && visible && !cursor && currentRunActive && runId === currentRunId;
	const log = useQuery({
		queryKey: [
			"live-run-heartbeat-receipts",
			channelId,
			runId,
			cursor,
			// One snapshot per current-run state change, even after fast polling stops.
			// Historical selections/pages stay fixed; inspected rows remain frozen below.
			runId === currentRunId && !cursor ? currentRunStatus : null,
		],
		enabled: open,
		refetchInterval: (query) =>
			eligible && inspecting.size === 0 && !ended(query.state.data?.run.status)
				? 2000
				: false,
		refetchIntervalInBackground: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		queryFn: () => {
			const path = RECEIPTS_API.replace("[id]", channelId).replace(
				"[runId]",
				runId,
			);
			const query = new URLSearchParams({ limit: "100" });
			if (cursor) query.set("cursor", cursor);
			return apiFetch<HeartbeatReceiptPage>(`${path}?${query}`);
		},
	});
	// Receipt order, not provider sample order; never force the reader's scroll.
	// Freeze inspection even if a read already in flight completes after opening.
	const rows = inspectionRows ?? log.data?.rows ?? [];
	const canResume = eligible && !ended(log.data?.run.status);
	return (
		<section className="space-y-2" aria-label={t("pushLog.title")}>
			<h4 className="font-medium text-sm text-zinc-200">
				{t("pushLog.title")}
			</h4>
			<p className="text-xs text-zinc-500">{t("pushLog.hint")}</p>
			<p className="text-xs text-zinc-400">
				{t(
					canResume && inspecting.size
						? "pushLog.inspecting"
						: canResume
							? "pushLog.auto"
							: "pushLog.paused",
				)}
			</p>
			{log.isError ? (
				<div role="status" className="text-amber-300 text-xs">
					{t("status.readUnavailable")}{" "}
					<Button variant="secondary" size="sm" onClick={() => log.refetch()}>
						{t("pushLog.retry")}
					</Button>
				</div>
			) : null}
			{rows.length === 0 ? (
				<p className="text-sm text-zinc-500">
					{log.isError
						? null
						: log.isPending
							? t("heartbeatLog.loading")
							: t("pushLog.empty")}
				</p>
			) : (
				<div className="max-h-96 overflow-auto rounded-md border border-zinc-800">
					<table className="w-full text-xs">
						<thead>
							<tr className="text-left text-zinc-500">
								{(
									[
										"pushLog.sampledAt",
										"pushLog.receivedAt",
										"heartbeatLog.ingest",
										"heartbeatLog.incomingMbps",
										"heartbeatLog.fps",
										"heartbeatLog.segmentMean",
										"pushLog.details",
									] as const
								).map((key) => (
									<th key={key} className="px-2 py-1.5 font-medium">
										{t(key)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => {
								const ingest = row.value.ingest;
								const video = ingest?.streams?.find(
									(stream) => stream.mediaType?.toUpperCase() === "VIDEO",
								);
								return (
									<tr
										key={row.id}
										data-receipt-id={row.id}
										className="border-zinc-800 border-t text-zinc-300"
									>
										<td className="whitespace-nowrap px-2 py-1.5 font-mono">
											{row.sampledAt ?? "—"}
										</td>
										<td className="whitespace-nowrap px-2 py-1.5 font-mono">
											{row.receivedAt}
										</td>
										<td className="px-2 py-1.5">
											{ingest?.status ?? t("common.unknown")}
										</td>
										<td className="px-2 py-1.5">
											{incomingMbps(video?.incomingBitrate)}
										</td>
										<td className="px-2 py-1.5">{video?.rate ?? "—"}</td>
										<td className="px-2 py-1.5">
											{row.value.output?.segments?.totalProcessingStatsMs
												?.mean ?? "—"}
										</td>
										<td className="px-2 py-1.5">
											<details
												onToggle={(event) => {
													const next = new Set(inspecting);
													if (event.currentTarget.open) next.add(row.id);
													else next.delete(row.id);
													setInspecting(next);
													setInspectionRows(
														next.size
															? (inspectionRows ?? log.data?.rows ?? [])
															: null,
													);
												}}
											>
												<summary className="cursor-pointer">
													{t("pushLog.details")}
												</summary>
												{inspecting.has(row.id) ? (
													<pre className="mt-1 max-h-80 max-w-xl overflow-auto rounded bg-zinc-950 p-2">
														{JSON.stringify(row, null, 2)}
													</pre>
												) : null}
											</details>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
			<div className="flex flex-wrap items-center gap-3">
				{log.data ? (
					<span className="text-xs text-zinc-500">
						{t("heartbeatLog.rowsLoaded", { count: rows.length })}
					</span>
				) : null}
				{log.data?.nextCursor ? (
					<Button
						variant="secondary"
						size="sm"
						disabled={log.isFetching}
						onClick={() => {
							setInspecting(new Set());
							setInspectionRows(null);
							setCursor(log.data?.nextCursor);
						}}
					>
						{t("pushLog.older")}
					</Button>
				) : null}
				{cursor ? (
					<Button
						variant="secondary"
						size="sm"
						onClick={() => {
							setInspecting(new Set());
							setInspectionRows(null);
							setCursor(undefined);
						}}
					>
						{t("pushLog.latest")}
					</Button>
				) : null}
			</div>
		</section>
	);
}
