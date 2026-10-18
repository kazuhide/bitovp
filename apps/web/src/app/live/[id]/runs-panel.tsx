"use client";

import type { LiveChannelStatus } from "@bitovp/core";
import { useQuery } from "@tanstack/react-query";
import { LIVE_STATUS_TONE } from "@/app/live/live-shared";
import { CopyableId } from "@/components/copyable-id";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";

type RunRow = {
	id: string;
	seq: number;
	status: LiveChannelStatus;
	bitmovinEncodingId: string | null;
	outputPrefix: string;
	runningSince: string | null;
	endedAt: string | null;
	/**  PR1 — Bitmovin queue time for THIS run's provision. */
	queueSeconds: number | null;
	programStartAt: string | null;
	programEndAt: string | null;
	error: string | null;
	createdAt: string;
};

/**
 * The channel's run history : the visibility a
 * 1:1 model never had — today's step log used to be OVERWRITTEN by the next
 * airing. Newest first; each row is one Bitmovin encoding's lifetime.
 */
export function RunsPanel({
	channelId,
	currentRunId,
	currentRunStatus,
}: {
	channelId: string;
	currentRunId?: string | null;
	currentRunStatus?: LiveChannelStatus;
}) {
	const { t } = useT();
	const runs = useQuery({
		queryKey: ["live-channel-runs", channelId, currentRunId, currentRunStatus],
		queryFn: () =>
			apiFetch<{ runs: RunRow[] }>(`/api/live-channels/${channelId}/runs`),
	});

	const items = runs.data?.runs ?? [];
	if (runs.isPending) {
		return <p className="text-xs text-zinc-500">{t("runs.loading")}</p>;
	}
	if (runs.isError) {
		return (
			<div className="space-y-2">
				<p role="alert" className="text-red-400 text-sm">
					{t("runs.loadFailed")}
				</p>
				<Button
					variant="secondary"
					size="sm"
					disabled={runs.isFetching}
					onClick={() => runs.refetch()}
				>
					{t("common.retry")}
				</Button>
			</div>
		);
	}
	if (items.length === 0) {
		return <p className="text-sm text-zinc-500">{t("runs.empty")}</p>;
	}
	return (
		<ul className="space-y-2">
			{items.map((run) => (
				<li
					key={run.id}
					className="flex flex-col gap-1 rounded-md border border-zinc-800 bg-zinc-950 p-3"
				>
					<div className="flex items-center gap-2">
						<span className="font-medium text-sm text-zinc-100">
							{t("runs.seq", { n: run.seq })}
						</span>
						<Badge tone={LIVE_STATUS_TONE[run.status]}>{run.status}</Badge>
						<span className="ml-auto text-xs text-zinc-500">
							{formatDateTime(run.createdAt)}
						</span>
					</div>
					<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400">
						<span>
							{t("runs.window", {
								from: formatDateTime(run.runningSince ?? run.createdAt),
								to: run.endedAt ? formatDateTime(run.endedAt) : "—",
							})}
						</span>
						{run.bitmovinEncodingId ? (
							<CopyableId value={run.bitmovinEncodingId} />
						) : null}
						{typeof run.queueSeconds === "number" ? (
							<span>{t("runs.queueSeconds", { s: run.queueSeconds })}</span>
						) : null}
					</div>
					{run.outputPrefix ? (
						// #155: where THIS run's segments/manifests live — the
						// per-run subtree a re-air writes under. Empty means the
						// plan's own paths (seq 1, or a pre-#155 run) and stays
						// silent: no location claim beats a wrong one.
						<p className="break-all font-mono text-xs text-zinc-500">
							{run.outputPrefix}
						</p>
					) : null}
					{run.error ? (
						<p className="text-rose-400 text-xs">{t("live.recordedFailure")}</p>
					) : null}
				</li>
			))}
		</ul>
	);
}
