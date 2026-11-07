"use client";

import {
	deriveLiveChannelStatus,
	deriveProviderLifecycle,
	stepLogSchema,
} from "@bitovp/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { AisaChannelAnalysisPanel } from "@/app/live/aisa-channel-analysis";
import { AisaLiveIngest } from "@/app/live/aisa-live-ingest";
import type { LiveChannelDetailRow } from "@/app/live/live-shared";
import { LiveStatusBadge } from "@/app/live/live-status-badge";
import { CopyableId } from "@/components/copyable-id";
import { StepTimeline } from "@/components/step-timeline";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n/context";
import type { AisaSelectedRun } from "./aisa-run-selection";
import { DeepLinkFocus } from "./focus-handoff";
import { LiveAnnouncer } from "./live-announcer";
import { type AisaRunSelection, RunsPanel } from "./runs-panel";

/** A managed recording is still one channel and one run in ordinary Live history. */
export function AisaChannelDetail({
	row,
	lifecycleActions,
	nowMs,
	initialAisaRun,
}: {
	row: LiveChannelDetailRow;
	lifecycleActions: ReactNode;
	nowMs: number;
	initialAisaRun?: AisaSelectedRun;
}) {
	const { t } = useT();
	const router = useRouter();
	const [selected, setSelected] = useState<AisaSelectedRun | null>(
		initialAisaRun ?? null,
	);
	const current = row.currentRun;
	const selectedUnavailable = Boolean(
		initialAisaRun && initialAisaRun.liveChannelId !== row.id,
	);
	const selection =
		selected?.id === initialAisaRun?.id ? initialAisaRun : selected;
	const binding = selectedUnavailable
		? null
		: selection?.id === current?.id
			? current
			: (selection ?? current);
	const selectRun = (run: AisaRunSelection) => {
		setSelected({
			...(run.id === initialAisaRun?.id ? initialAisaRun : {}),
			...run,
			liveChannelId: row.id,
		});
		router.replace(
			`/live/${row.id}?runId=${encodeURIComponent(run.id)}#sec-analysis`,
			{ scroll: false },
		);
	};
	const imported = row.origin === "AISA_IMPORTED";
	const entries = stepLogSchema.safeParse(current?.stepLog ?? row.stepLog);
	const status = current
		? deriveLiveChannelStatus(current.status)
		: row.status === "CREATED"
			? deriveLiveChannelStatus(null)
			: row.status;
	const analysisId = binding?.aisaAnalysisId;
	const encodingId = binding?.bitmovinEncodingId;
	return (
		<LiveAnnouncer>
			<DeepLinkFocus />
			<section className="mx-auto max-w-6xl space-y-5">
				<Link
					href="/live"
					className="inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-emerald-400"
				>
					<span aria-hidden="true">←</span>
					{t("live.title")}
				</Link>
				<header className="space-y-3">
					<div className="flex flex-wrap items-center gap-3">
						<h1 className="min-w-0 break-words font-semibold text-xl text-zinc-50">
							{row.name}
						</h1>
						<LiveStatusBadge
							status={status}
							providerLifecycle={deriveProviderLifecycle(
								current ?? null,
								nowMs,
							)}
						/>
						<Badge>
							{t(imported ? "aisaLive.importedRun" : "aisaLive.title")}
						</Badge>
					</div>
					<p className="text-sm text-zinc-400">
						{t(
							imported
								? "aisaLive.importedReadOnly"
								: "aisaLive.managedActionsHint",
						)}
					</p>
					{!imported ? (
						<section
							id="sec-actions"
							aria-label={t("live.actions")}
							tabIndex={-1}
						>
							{lifecycleActions}
						</section>
					) : null}
					<div className="flex flex-wrap gap-x-6 gap-y-2 rounded-md border border-zinc-800 p-3">
						<CopyableId value={row.id} label={t("aisaLive.channelId")} />
						{current?.bitmovinEncodingId ? (
							<CopyableId
								value={current.bitmovinEncodingId}
								label={t("aisaLive.encodingId")}
							/>
						) : null}
					</div>
					{row.error ? (
						<p role="alert" className="text-sm text-rose-400">
							{t("live.recordedFailure")}
						</p>
					) : null}
				</header>
				{!imported && row.bitmovinAccountId && current?.aisaAnalysisId ? (
					<div id="sec-ingest">
						<AisaLiveIngest
							accountId={row.bitmovinAccountId}
							analysisId={current.aisaAnalysisId}
							encodingId={current.bitmovinEncodingId ?? undefined}
							running={current.status === "RUNNING"}
						/>
					</div>
				) : null}
				{selectedUnavailable ? (
					<p role="alert" className="text-sm text-amber-400">
						{t("aisaLive.selectedRunUnavailable")}
					</p>
				) : row.bitmovinAccountId && analysisId && encodingId ? (
					<div className="space-y-2">
						<div className="flex flex-wrap items-center gap-3 text-sm text-zinc-400">
							<p>{t("runs.seq", { n: binding?.seq ?? 0 })}</p>
							{binding?.id !== current?.id ? (
								<CopyableId
									value={encodingId}
									label={t("aisaLive.encodingId")}
								/>
							) : null}
						</div>
						<AisaChannelAnalysisPanel
							accountId={row.bitmovinAccountId}
							analysisId={analysisId}
							encodingId={encodingId}
							status={binding?.aisaStatus ?? undefined}
							initialSnapshot={binding?.aisaSnapshot}
						/>
					</div>
				) : (
					<p role="status" className="text-sm text-zinc-400">
						{t("aisaLive.pending")}
					</p>
				)}
				<section
					id="sec-runs"
					className="space-y-3 rounded-md border border-zinc-800 p-4"
				>
					<h2 className="font-medium text-zinc-100">{t("runs.heading")}</h2>
					<RunsPanel
						channelId={row.id}
						currentRunId={current?.id}
						currentRunStatus={current?.status}
						selectedAisaRunId={binding?.id}
						onSelectAisaRun={selectRun}
					/>
				</section>
				<section
					id="sec-steps"
					className="space-y-3 rounded-md border border-zinc-800 p-4"
				>
					<h2 className="font-medium text-zinc-100">
						{t("live.stepTimeline")}
					</h2>
					{current ? (
						<p className="text-xs text-zinc-500">
							{t("runs.seq", { n: current.seq })}
						</p>
					) : null}
					{entries.success ? (
						<StepTimeline entries={entries.data} />
					) : (
						<p className="text-sm text-zinc-500">
							{t("live.stepLogUnavailable")}
						</p>
					)}
				</section>
			</section>
		</LiveAnnouncer>
	);
}
