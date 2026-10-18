"use client";

import { VMAF_SCORING_VERSION } from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ApiError, apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import { CloudProgress } from "../cloud-progress";
import {
	shortJobId,
	VMAF_STATUS_TONE,
	type VmafJobDetail,
} from "../vmaf-shared";
import { ExportButtons } from "./export-buttons";
import { FrameComparison } from "./frame-comparison";
import { LadderScatter } from "./ladder-scatter";
import { LivePanels, LiveQualityWarnings } from "./live-panels";
import { PooledTable } from "./pooled-table";
import { VmafContextBanner } from "./vmaf-context-banner";

/**
 * VMAF report detail (/qc/[id]). Composes the pooled summary table, the
 * overlaid per-frame time series and the quality-vs-bitrate ladder scatter,
 * plus full-data export. Polls while PENDING/RUNNING (the worker fills
 * results), surfaces job.error on ERROR. The downsampled per-frame series
 * comes straight from the detail route — no client-side decoding.
 */
export function VmafReport({ id }: { id: string }) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const router = useRouter();
	const report = useQuery({
		queryKey: ["vmaf-job", id],
		queryFn: () => apiFetch<VmafJobDetail>(`/api/vmaf-jobs/${id}`),
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			return status === "PENDING" ||
				status === "RUNNING" ||
				query.state.data?.computeTasks?.some((task) => !task.cleanedAt)
				? 5_000
				: false;
		},
	});

	// Delete (terminal-only): removes the report + its frame results (LOCAL
	// only). On success, leave for the lab index. Disabled while PENDING/RUNNING.
	const remove = useMutation({
		mutationFn: () => apiFetch(`/api/vmaf-jobs/${id}`, { method: "DELETE" }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["vmaf-jobs"] });
			router.push("/qc");
		},
	});

	const [cancelOpen, setCancelOpen] = useState(false);
	const cancel = useMutation({
		mutationFn: () =>
			apiFetch(`/api/vmaf-jobs/${id}/cancel`, { method: "POST" }),
		onSuccess: () => {
			setCancelOpen(false);
			queryClient.invalidateQueries({ queryKey: ["vmaf-job", id] });
			queryClient.invalidateQueries({ queryKey: ["vmaf-jobs"] });
		},
	});

	if (report.isLoading) {
		return (
			<div
				role="status"
				aria-label={t("qc.loadingReport")}
				className="space-y-2"
			>
				{[0, 1, 2].map((i) => (
					<div key={i} className="h-16 animate-pulse rounded-md bg-zinc-900" />
				))}
			</div>
		);
	}
	const loadError = report.isError ? (
		<p role="alert" className="text-red-400 text-sm">
			{t("qc.reportLoadFailed")}{" "}
			<Button
				size="sm"
				variant="secondary"
				disabled={report.isFetching}
				onClick={() => report.refetch()}
			>
				{t("common.retry")}
			</Button>
		</p>
	) : null;
	if (!report.data) {
		return (
			<div>
				{loadError}
				<Link href="/qc" className="text-sm text-emerald-400 underline">
					{t("qc.backToLab")}
				</Link>
			</div>
		);
	}

	const job = report.data;
	const hasResults = job.results.length > 0;
	const maxFrameCount = job.results.reduce(
		(m, r) => Math.max(m, r.frameCount),
		0,
	);
	// Title the report by its encoding name (plan.name); LIVE jobs / older rows
	// without one fall back to the short job id. The "VMAF report" context moves
	// to a small eyebrow so the recognisable name is the headline.
	const title = job.encodingName ?? shortJobId(job.id);

	return (
		<section>
			{loadError}
			<p className="text-xs text-zinc-500 uppercase tracking-wide">
				{t("qc.reportTitle")}
			</p>
			<header className="mt-1 flex flex-wrap items-center gap-3">
				<h1
					className="font-semibold text-xl text-zinc-50"
					title={t("uiX.reportShortId", { id: shortJobId(job.id) })}
				>
					{title}
				</h1>
				<Badge tone={VMAF_STATUS_TONE[job.status]}>{job.status}</Badge>
				<span className="font-mono text-xs text-zinc-500">{job.model}</span>
				{(job.scoringVersion ?? 1) < VMAF_SCORING_VERSION ? (
					/**
					 * An operator reading ONE report needs this as much as one
					 * comparing two: the number in front of them was produced by
					 * an older pipeline with timestamp-pairing defects (generations
					 * 1 and 2). Without this the historical report looks current.
					 */
					<Badge tone="error">
						{t("qc.staleScoringGeneration", {
							version: String(job.scoringVersion ?? 1),
						})}
					</Badge>
				) : null}
				{job.subsample !== null && job.subsample > 1 ? (
					/**
					 * Not an error — a subsampled run is a legitimate choice — but the
					 * report has to state the terms of its own measurement. The mean is
					 * trustworthy; the MINIMUM is the worst frame of a sample, and an
					 * operator reading a single report has no other way to know that the
					 * worst frame may simply not have been scored.
					 *
					 * `neutral`, not `error` like the stale-generation badge beside it:
					 * that badge means the number is WRONG, this one means the number is
					 * right and its minimum is scoped. Reusing `error` would put a
					 * deliberate speed/precision trade in the same visual class as a
					 * measurement defect.
					 */
					<Badge tone="neutral">
						{t("qc.subsampledBadge", { stride: String(job.subsample) })}
					</Badge>
				) : null}
				<span className="text-xs text-zinc-500">{job.mode}</span>
				{hasResults ? (
					<span className="text-xs text-zinc-500">
						{t(
							job.results.length === 1
								? "uiX.renditionCountOne"
								: "uiX.renditionCountOther",
							{ count: job.results.length },
						)}
					</span>
				) : null}
				{job.mode === "VOD" &&
				job.execution?.backend === "CLOUD" &&
				(job.status === "PENDING" || job.status === "RUNNING") ? (
					<RoleAccess control="qc.jobs">
						<Button
							size="sm"
							variant="destructive"
							disabled={cancel.isPending}
							onClick={() => setCancelOpen(true)}
						>
							{t("qc.cancelCloud")}
						</Button>
						<Dialog
							open={cancelOpen}
							onOpenChange={setCancelOpen}
							title={t("qc.cancelCloudTitle")}
							description={t("qc.cancelCloudConfirm", { name: title })}
						>
							<div className="flex justify-end gap-2">
								<Button
									size="sm"
									variant="secondary"
									disabled={cancel.isPending}
									onClick={() => setCancelOpen(false)}
								>
									{t("common.cancel")}
								</Button>
								<Button
									size="sm"
									variant="destructive"
									disabled={cancel.isPending}
									onClick={() => cancel.mutate()}
								>
									{t("qc.cancelCloud")}
								</Button>
							</div>
							{cancel.isError ? (
								<p role="alert" className="mt-2 text-xs text-red-400">
									{cancel.error instanceof ApiError
										? cancel.error.message
										: t("qc.cancelCloudFailed")}
								</p>
							) : null}
						</Dialog>
					</RoleAccess>
				) : null}
				<div className="ml-auto">
					<RoleAccess control="qc.report.delete">
						<DeleteResourceButton
							resourceLabel={t("qc.reportTitle")}
							disabled={job.status === "PENDING" || job.status === "RUNNING"}
							disabledReason={t("ui.waitForTheReportToFinishBefore")}
							confirmTitle={t("qc.deleteTitle")}
							confirmDescription={t("qc.deleteConfirmOne")}
							pending={remove.isPending}
							error={
								remove.isError
									? remove.error instanceof ApiError
										? remove.error.message
										: t("qc.deleteFailed")
									: null
							}
							onConfirm={() => remove.mutate()}
						/>
					</RoleAccess>
				</div>
			</header>
			{job.execution ? (
				<p className="mt-1 text-xs text-zinc-500">
					{t("qc.executionTarget")}:{" "}
					{job.execution.backend === "CLOUD"
						? t("qc.executionCloudReport", {
								profile: job.execution.profileId,
								budget: job.execution.budgetUsd,
							})
						: t("qc.executionLocal")}
				</p>
			) : null}
			{job.computeTasks?.length ? (
				<CloudProgress
					tasks={job.computeTasks}
					active={job.status === "PENDING" || job.status === "RUNNING"}
				/>
			) : null}
			{job.computeTasks?.length ? (
				<details className="mt-2 text-xs text-zinc-500">
					<summary className="cursor-pointer">{t("qc.computeTasks")}</summary>
					<ul className="mt-2 space-y-1">
						{job.computeTasks.map((task) => (
							<li key={task.id}>
								<span className="font-mono">{task.id.slice(0, 8)}</span> ·{" "}
								{task.state} ·{" "}
								{t("qc.computeReserved", {
									amount: task.reservedUsd.toFixed(2),
								})}{" "}
								·{" "}
								{t(
									task.cleanedAt
										? "qc.computeCleaned"
										: "qc.computeCleanupPending",
								)}
								{task.error ? (
									<span className="ml-1 text-amber-600 dark:text-amber-400">
										{t("qc.computeAttention")}
									</span>
								) : null}
							</li>
						))}
					</ul>
				</details>
			) : null}

			<p className="mt-1 text-xs text-zinc-500">
				{job.encodingJobId ? (
					<>
						{t("uiX.fromEncodingJob")}{" "}
						<Link
							href={`/vod/jobs/${job.encodingJobId}`}
							className="font-mono text-zinc-400 hover:text-emerald-400"
						>
							{job.encodingJobId}
						</Link>{" "}
						·{" "}
					</>
				) : null}
				{formatDateTime(job.createdAt)}
			</p>

			{job.error ? (
				<p role="alert" className="mt-3 text-red-400 text-sm">
					{job.error}
				</p>
			) : null}

			{job.status === "PENDING" || job.status === "RUNNING" ? (
				<div className="mt-6 space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-5 text-sm text-zinc-400">
					<div className="flex items-center gap-3">
						<span
							aria-hidden="true"
							className="h-3 w-3 animate-pulse rounded-full bg-emerald-500"
						/>
						{t("prose.vmafRunning")}
					</div>
					<VmafProgress
						done={job.doneUnits}
						total={job.totalUnits}
						active={true}
					/>
					<VmafResourcesLine job={job} />
				</div>
			) : null}

			{job.status === "FINISHED" &&
			(job.totalUnits > 0 || job.cores != null) ? (
				<div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
					{job.totalUnits > 0 ? (
						<span>
							{t(
								job.totalUnits === 1
									? "uiX.scoredUnitsOne"
									: "uiX.scoredUnitsOther",
								{ done: job.doneUnits, total: job.totalUnits },
							)}
						</span>
					) : null}
					<VmafResourcesLine job={job} />
				</div>
			) : null}

			{hasResults ? (
				<>
					{/* Above the numbers, deliberately: a correct score with no context is
					    what turned a healthy pipeline into an hours-long investigation. */}
					<VmafContextBanner
						results={job.results}
						model={job.model}
						referenceHeight={job.reference?.height ?? null}
					/>

					<div className="mt-8 flex items-center justify-between gap-3">
						<h2 className="font-medium text-sm text-zinc-200">
							{job.mode === "LIVE"
								? t("qc.windowedVmaf")
								: t("qc.pooledSummary")}
						</h2>
						<ExportButtons jobId={job.id} />
					</div>
					{job.mode === "LIVE" ? (
						<LiveQualityWarnings results={job.results} />
					) : null}
					<PooledTable results={job.results} />

					<h2 className="mt-8 font-medium text-sm text-zinc-200">
						{t("uiX.perFrameVmaf")}
						{maxFrameCount > 0 ? (
							<span className="ml-2 font-normal text-xs text-zinc-500">
								{t("uiX.downsampledExportFull", {
									frames: maxFrameCount.toLocaleString(),
								})}
							</span>
						) : null}
					</h2>
					<FrameComparison
						key={job.id}
						results={job.results}
						fps={job.reference?.fps}
						mode={job.mode}
					/>

					<h2 className="mt-8 font-medium text-sm text-zinc-200">
						{t("qc.qualityLadder")}
						<span className="ml-2 font-normal text-xs text-zinc-500">
							{t("ui.meanVmafVsBitrate")}
						</span>
					</h2>
					<LadderScatter results={job.results} />
					{job.mode === "LIVE" && job.results.some((result) => result.live) ? (
						<details className="mt-8 rounded-lg border border-zinc-800 p-4">
							<summary className="cursor-pointer text-sm text-zinc-300 focus-visible:outline-2 focus-visible:outline-emerald-500">
								<h2 className="inline font-medium">
									{t("qc.alignmentDiagnostics")}
								</h2>
								<span className="ml-2 text-xs text-zinc-500">
									{t("ui.loopOffsetConfidenceDrift")}
								</span>
							</summary>
							<LivePanels results={job.results} showWarnings={false} />
						</details>
					) : null}
				</>
			) : job.status === "ERROR" ? null : job.status === "FINISHED" ? (
				<p className="mt-6 text-sm text-zinc-500">
					{t("ui.thisReportFinishedWithNoRenditionResults")}
				</p>
			) : null}
		</section>
	);
}

/**
 * doneUnits/totalUnits → a small bar + "done/total (XX%)" label. totalUnits=0
 * (older jobs, or the worker hasn't built the work list yet) ⇒ an indeterminate
 * "starting…" state rather than NaN%. Mirrors the encoding-job JobProgress.
 */
function VmafProgress({
	done,
	total,
	active,
}: {
	done: number;
	total: number;
	active: boolean;
}) {
	const { t } = useT();
	if (total <= 0) {
		return (
			<div
				className="flex items-center gap-2 text-xs text-zinc-500"
				role="status"
			>
				<div className="h-1.5 w-32 overflow-hidden rounded-full bg-zinc-800">
					<div
						className={`h-full w-1/3 rounded-full bg-emerald-600/70 ${
							active ? "animate-pulse" : ""
						}`}
					/>
				</div>
				<span>{t("ui.starting")}</span>
			</div>
		);
	}
	const pct = Math.min(100, Math.round((done / total) * 100));
	return (
		<div
			className="flex items-center gap-2 text-xs text-zinc-400"
			title={`${done}/${total} units`}
			role="status"
		>
			<div className="h-1.5 w-32 overflow-hidden rounded-full bg-zinc-800">
				<div
					className="h-full rounded-full bg-emerald-500 transition-[width]"
					style={{ width: `${pct}%` }}
				/>
			</div>
			<span className="tabular-nums">
				{done}/{total} ({pct}%)
			</span>
		</div>
	);
}

/**
 * "Running on N cores · T libvmaf threads × C concurrent" — the execution
 * profile recorded at run time. Each piece is omitted when null (jobs created
 * before the observability migration); renders nothing if none are known.
 */
function VmafResourcesLine({
	job,
}: {
	job: Pick<VmafJobDetail, "cores" | "threads" | "concurrency">;
}) {
	const { t } = useT();
	const parts: string[] = [];
	if (job.cores != null) {
		parts.push(
			t(job.cores === 1 ? "uiX.coresCountOne" : "uiX.coresCountOther", {
				count: job.cores,
			}),
		);
	}
	if (job.threads != null) {
		parts.push(
			t(
				job.threads === 1 ? "uiX.libvmafThreadsOne" : "uiX.libvmafThreadsOther",
				{ count: job.threads },
			),
		);
	}
	if (job.concurrency != null) {
		parts.push(t("uiX.concurrentCount", { count: job.concurrency }));
	}
	if (parts.length === 0) {
		return null;
	}
	return (
		<span className="text-xs text-zinc-500">
			{t("uiX.runningOn", { parts: parts.join(" · ") })}
		</span>
	);
}
