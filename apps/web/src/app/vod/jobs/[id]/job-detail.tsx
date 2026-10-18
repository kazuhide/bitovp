"use client";

import type { PlayerClientConfig, QcVerdict } from "@bitovp/core";
import {
	encodingPlanSchema,
	inputFileSummaries,
	type ManifestPlaybackLink,
	perTitleResultsView,
	perTitleTemplates,
	planHasPerTitle,
	renditionSummaries,
	stepLogSchema,
	storageSummaries,
} from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
	JobAnalysisPanel,
	useJobAnalysis,
} from "@/app/library/job-analysis-panel";
import type { VmafJobListItem } from "@/app/qc/vmaf-shared";
import { isActiveVmafStatus, VMAF_STATUS_TONE } from "@/app/qc/vmaf-shared";
import type { JobListItem } from "@/app/vod/jobs/jobs-client";
import { isActiveJobStatus, STATUS_TONE } from "@/app/vod/jobs/jobs-client";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { SaveAsTemplateButton } from "@/components/save-as-template";
import { StepTimeline } from "@/components/step-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiError, apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { useQcVmafEnabled } from "@/lib/feature-flags/context";
import { useT } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { InternalHevcV2Badge } from "../../internal-hevc-v2-badge";
import { AuxOutputsPanel } from "./aux-outputs-panel";
import { InputFilesPanel } from "./input-files-panel";
import { OverviewStrip } from "./overview-strip";
import { PerTitleResultsPanel } from "./per-title-results-panel";
import { PlayerDialog } from "./player-dialog";
import { playableLinks } from "./player-preview";
import { PreviewRail } from "./preview-rail";
import { QcGatePanel } from "./qc-gate-panel";
import { RenditionTables } from "./rendition-tables";
import { anchorId, ResourcesTab } from "./resources-tab";
import { StoragePanel } from "./storage-panel";

type JobRow = JobListItem & {
	plan: unknown;
	stepLog: unknown;
	/**
	 * Named snapshots (C7). Keys today: `perTitleResults` (written by the
	 * capture route) and `encodingTimes` ( — burned by the job
	 * GET); both land via mergeEncodingJobSnapshot's jsonb merge, never a
	 * read-modify-write. `unknown` because the column is shared and every
	 * reader parses what it needs rather than trusting the shape.
	 */
	snapshots?: unknown;
	/** Bitmovin lifecycle stamps, burned server-side . */
	encodingTimes?: { queuedAt?: string; runningAt?: string };
	/** Cooperative-cancel flag ; set by the cancel route, cleared
	 * only by the worker flipping status to CANCELED. */
	cancelRequested: boolean;
	/** QC gate verdict , denormalized by the vmaf-runner; optional
	 * so a response cached before the column existed still renders. */
	qcVerdict?: QcVerdict | null;
	/** Delivery-forced timestamp . */
	qcOverriddenAt?: string | null;
	/** Template provenance : copied at launch; optional so a
	 * response cached before the columns existed still renders. */
	presetRevision?: number | null;
	preset?: { name: string; revision: number } | null;
	/** Null once the referenced BitmovinAccount row is deleted (FK SetNull). */
	bitmovinAccountId: string | null;
	/**
	 * Derived by the route, not here: deriving them client-side meant shipping
	 * every credential's config to the browser .
	 * Optional so a cached response from before the field existed still renders.
	 */
	playbackLinks?: ManifestPlaybackLink[];
	/**
	 * `{id → {label, provider}}` for the credentials this plan names — labels for
	 * the storage panels, nothing more (the route selects exactly those three
	 * columns, never `config`). Optional so a cached response from before the
	 * field existed still renders: the panel falls back to the raw id.
	 */
	credentialRefs?: Record<string, { label: string; provider: string }>;
};

type VmafJobsPage = { items: VmafJobListItem[]; nextCursor?: string };

type DetailTab = "overview" | "resources";

export function JobDetail({
	id,
	player,
}: {
	id: string;
	player?: PlayerClientConfig;
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const router = useRouter();
	const [playback, setPlayback] = useState<{
		url: string;
		kind: "HLS" | "DASH";
		/** Lets the dialog ask whether CORS is why playback failed. */
		manifestKey: string;
	} | null>(null);
	const [tab, setTab] = useState<DetailTab>("overview");
	/** Disclosure state for the step timeline, lifted so a tab switch keeps it. */
	const [timelineOpen, setTimelineOpen] = useState(false);

	const job = useQuery({
		queryKey: ["encoding-job", id],
		queryFn: () => apiFetch<JobRow>(`/api/encoding-jobs/${id}`),
		refetchInterval: (query) =>
			query.state.data?.status === "QUEUED" ||
			query.state.data?.status === "RUNNING" ||
			query.state.data?.status === "AWAITING_QC"
				? 5_000
				: false,
	});
	const qcVmafEnabled = useQcVmafEnabled();
	const parsedAnalysisPlan = encodingPlanSchema.safeParse(job.data?.plan);
	const analysisEnabled =
		parsedAnalysisPlan.success && !!parsedAnalysisPlan.data.aiSceneAnalysis;
	const analysis = useJobAnalysis(
		id,
		analysisEnabled || job.data?.status === "FINISHED",
	);
	const [selectedLocale, setSelectedLocale] = useState<string>();
	const analysisLocale =
		selectedLocale ?? analysis.data?.source?.locales[0] ?? "en";
	const sceneAnalysis = analysis.data?.source?.analyses.find(
		(item) => item.locale === analysisLocale,
	)?.document;
	const [analysisSeek, setAnalysisSeek] = useState<{
		seconds: number;
		requestId: number;
	}>();
	const vmaf = useQuery({
		queryKey: ["vmaf-jobs", "for-encoding", id],
		// : the route 404s while QC/VMAF is off, so do not ask. The
		// QC gate panel below still renders for a job that CARRIES a gate — it
		// simply has no report to link to, which is the honest state when the
		// lab does not exist for this deployment.
		enabled: qcVmafEnabled,
		queryFn: () =>
			apiFetch<VmafJobsPage>(
				`/api/vmaf-jobs?encodingJobId=${encodeURIComponent(id)}`,
			),
		refetchInterval: (query) =>
			isActiveJobStatus(job.data?.status ?? "DRAFT") ||
			job.data?.status === "AWAITING_QC" ||
			query.state.data?.items.some((report) =>
				isActiveVmafStatus(report.status),
			)
				? 5_000
				: false,
	});
	const jobStatus = job.data?.status;
	const settledMeasurements = JSON.stringify(
		(vmaf.data?.items ?? [])
			.filter(
				(report) => report.status === "FINISHED" || report.status === "ERROR",
			)
			.map(({ id, status }) => ({ id, status }))
			.sort((left, right) => left.id.localeCompare(right.id)),
	);
	// Discover automatic measurements created at an encoding transition,
	// including the final transition after an earlier empty reports read.
	useEffect(() => {
		if (qcVmafEnabled && jobStatus) {
			void queryClient.invalidateQueries({
				queryKey: ["vmaf-jobs", "for-encoding", id],
			});
		}
	}, [id, jobStatus, qcVmafEnabled, queryClient]);
	// MARK_ONLY measurements finish after the encoding job stops polling;
	// Refresh for every settled identity/status, including an older overlapping
	// report or a new report first observed as FINISHED. Stable content avoids
	// a refetch loop when React Query returns an equivalent reports array.
	useEffect(() => {
		if (settledMeasurements !== "[]") {
			void queryClient.invalidateQueries({ queryKey: ["encoding-job", id] });
		}
	}, [id, settledMeasurements, queryClient]);

	// : re-measure from the detail page — the same lab-manual
	// POST the lab section uses; the route's qc-mirror gate answers 409 with
	// the honest alternative for mirror-less jobs.
	const measureVmaf = useMutation({
		mutationFn: () =>
			apiFetch<{ id: string }>("/api/vmaf-jobs", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ encodingJobId: id }),
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ["vmaf-jobs", "for-encoding", id],
			}),
	});
	const retryVmaf = useMutation({
		mutationFn: (reportId: string) =>
			apiFetch<{ id: string }>(`/api/vmaf-jobs/${reportId}/retry`, {
				method: "POST",
			}),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: ["vmaf-jobs", "for-encoding", id],
				}),
				queryClient.invalidateQueries({ queryKey: ["encoding-job", id] }),
			]);
		},
	});
	const vmafBusy = !!vmaf.data?.items.some((report) =>
		isActiveVmafStatus(report.status),
	);
	// Re-run as new: recompiles a FRESH job from this job's plan (distinct id;
	// source untouched). Copy settings only navigates to the editing wizard.
	// On success we surface a link to the new job rather than navigating, so the
	// operator stays on the source for comparison.
	const reRun = useMutation({
		mutationFn: () =>
			apiFetch<{ id: string }>(`/api/encoding-jobs/${id}/re-run-as-new`, {
				method: "POST",
			}),
	});

	// Cancel : sets the cooperative-cancel flag; the worker stops the
	// Bitmovin encoding and flips the job to CANCELED. Distinct from Retry
	// (resume) and Re-run-as-new. On success we refetch so the derived
	// "Canceling…" state shows until the worker reports CANCELED (polling keeps
	// running while QUEUED/RUNNING); a 409 means the job already finished/canceled.
	const cancel = useMutation({
		mutationFn: () =>
			apiFetch(`/api/encoding-jobs/${id}/cancel`, { method: "POST" }),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["encoding-job", id] }),
	});

	// Delete (terminal-only): removes this job + its VMAF reports/snapshots
	// (LOCAL records only — no Bitmovin/storage call). On success we leave the
	// detail and refresh the list. Active jobs never reach here: the button is
	// disabled (mirrors the route's 409 terminal-only guard).
	const remove = useMutation({
		mutationFn: () =>
			apiFetch(`/api/encoding-jobs/${id}`, { method: "DELETE" }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["encoding-jobs"] });
			router.push("/vod/jobs");
		},
	});

	if (job.isLoading) {
		return (
			<div
				role="status"
				aria-label={t("jobDetail.loading")}
				className="space-y-2"
			>
				{[0, 1, 2].map((i) => (
					<div key={i} className="h-16 animate-pulse rounded-md bg-zinc-900" />
				))}
			</div>
		);
	}
	if (job.isError || !job.data) {
		return (
			<p role="alert" className="text-red-400 text-sm">
				{t("jobDetail.loadFailed")}
			</p>
		);
	}

	const row = job.data;
	const plan = encodingPlanSchema.safeParse(row.plan);
	const entries = stepLogSchema.safeParse(row.stepLog);
	const links = row.playbackLinks ?? [];
	/**
	 * Playable NOW, per : a finished job only (rev433 —
	 * a running job's manifests, just-in-time or post-encoding, are not
	 * there yet when the operator lands on the page right after creation).
	 */
	const playable = playableLinks({ links, status: row.status });
	const playableKeys = new Set(playable.map((l) => l.key));
	const credentialRefs = row.credentialRefs ?? {};
	/**
	 * The detail view models. Derived here, from the SAME parsed plan the playable
	 * rules already use, so the panels cannot disagree with the player about what
	 * the plan says. `null` when the plan does not parse — a legacy or hand-edited
	 * row still renders its header, manifests and timeline rather than a blank
	 * page, which is the tolerance rule the selectors are built on.
	 */
	const detail = plan.success
		? {
				plan: plan.data,
				renditions: renditionSummaries(
					plan.data,
					entries.success ? entries.data : undefined,
				),
				inputFiles: inputFileSummaries(plan.data),
				storage: storageSummaries(plan.data),
			}
		: null;
	const planFacts = plan.success
		? {
				encoderVersion: plan.data.bitmovin.encoderVersion,
				// The wizard sets codec-local modes/presets. Do not present those
				// jobs as unspecified, or infer an effective mode from a preset.
				encodingMode:
					plan.data.generation.encodingMode ??
					(plan.data.renditions.some(
						(rendition) =>
							("encodingMode" in rendition && !!rendition.encodingMode) ||
							("presetConfiguration" in rendition &&
								!!rendition.presetConfiguration),
					)
						? t("jobDetail.encodingModeFromLadder")
						: undefined),
			}
		: {};
	/**
	 * Wall-clock of the encode itself, from the step log rather than the row: the
	 * row's updatedAt moves on every progress write, so it measures the job's
	 * lifetime, not the encode's.
	 */
	const encodeDuration = (() => {
		if (!entries.success) {
			return undefined;
		}
		const await_ = entries.data.find((e) => e.kind === "AWAIT_ENCODING");
		if (!await_?.startedAt || !await_.finishedAt) {
			return undefined;
		}
		const ms =
			new Date(await_.finishedAt).getTime() -
			new Date(await_.startedAt).getTime();
		return Number.isFinite(ms) && ms > 0 ? ms / 1000 : undefined;
	})();
	// Encoder startup : Bitmovin's own queuedAt→runningAt. The
	// chart-side rule hides the queue wait visually; this figure is where it
	// stays readable.
	const startupSeconds = (() => {
		const queued = row.encodingTimes?.queuedAt
			? Date.parse(row.encodingTimes.queuedAt)
			: Number.NaN;
		const running = row.encodingTimes?.runningAt
			? Date.parse(row.encodingTimes.runningAt)
			: Number.NaN;
		const s = (running - queued) / 1000;
		return Number.isFinite(s) && s >= 0 ? s : undefined;
	})();
	const doneCount = entries.success
		? entries.data.filter((e) => e.status === "DONE").length
		: 0;

	// : the runtime-id chips cross-link to the Resources tab. The
	// step log maps each created resource id to its producing step, whose
	// node the tab renders under anchorId(step); navigation mounts the tab
	// FIRST (the anchor does not exist while Overview is shown), then jumps.
	const anchorForResource = (resourceId: string): string | undefined => {
		if (!entries.success) {
			return undefined;
		}
		const producer = entries.data.find((e) => e.resourceId === resourceId);
		return producer ? `#${anchorId(producer.step)}` : undefined;
	};
	const openResource = (href: string) => {
		setTab("resources");
		requestAnimationFrame(() => {
			const target = document.getElementById(href.slice(1));
			// Focus FIRST (review-181 I2): the click unmounted the link, so
			// without an explicit move a keyboard/SR user is dumped on <body>
			// with nothing announced. The li carries tabIndex={-1}.
			target?.focus?.();
			// Optional-CALL: jsdom has no scrollIntoView, and the navigation must
			// not depend on it (the tab switch is the behaviour under test).
			target?.scrollIntoView?.({ block: "start" });
		});
	};

	// Cancel  is offered only while the job is still in flight and
	// not already being canceled. Once the flag is set but the worker hasn't yet
	// flipped status to CANCELED, the job is "Canceling…" (status still
	// QUEUED/RUNNING) — the button is replaced by that derived indicator.
	const isActive = isActiveJobStatus(row.status);
	const canceling = row.cancelRequested && isActive;
	const cancelable = isActive && !row.cancelRequested;

	return (
		<section>
			<header className="flex flex-wrap items-center gap-3">
				<h1 className="font-semibold text-xl text-zinc-50">{row.name}</h1>
				<InternalHevcV2Badge plan={plan.success ? plan.data : undefined} />
				<Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
				{canceling ? (
					<Badge tone="neutral">{t("jobDetail.canceling")}</Badge>
				) : null}
				{entries.success ? (
					<span className="text-xs text-zinc-500">
						{t("uiX.stepsProgress", {
							done: doneCount,
							total: entries.data.length,
						})}
					</span>
				) : null}
				<div className="ml-auto flex flex-wrap items-center gap-2">
					<RoleAccess control="vod.job.detail">
						<Button
							variant="secondary"
							size="sm"
							onClick={() => router.push(`/vod/new?from=${id}`)}
						>
							{t("jobDetail.copyAndEdit")}
						</Button>

						{row.status !== "DRAFT" &&
						row.status !== "AWAITING_QC" &&
						!isActive ? (
							<Button
								variant="secondary"
								size="sm"
								disabled={reRun.isPending}
								onClick={() => reRun.mutate()}
							>
								{reRun.isPending
									? t("jobDetail.creating")
									: t("jobDetail.rerunAsNew")}
							</Button>
						) : null}
						<DeleteResourceButton
							resourceLabel={t("ui.job")}
							disabled={isActive}
							disabledReason={t("ui.cancelTheJobBeforeDeleting")}
							confirmTitle={t("ui.deleteThisJob")}
							confirmDescription={t("jobs.deleteConfirmOne")}
							pending={remove.isPending}
							error={
								remove.isError
									? remove.error instanceof ApiError
										? remove.error.message
										: t("jobs.deleteFailed")
									: null
							}
							onConfirm={() => remove.mutate()}
						/>
						{cancelable ? (
							<Button
								variant="destructive"
								size="sm"
								className="ml-2"
								disabled={cancel.isPending}
								onClick={() => cancel.mutate()}
							>
								{cancel.isPending
									? t("jobDetail.canceling")
									: t("common.cancel")}
							</Button>
						) : null}
					</RoleAccess>
				</div>
			</header>

			{row.error ? (
				<p role="alert" className="mt-2 text-red-400 text-sm">
					{row.error}
				</p>
			) : null}

			{/* Cancel outcome. A 409 (the route's "not cancelable") means the job
			    already reached a terminal state between render and click — surface
			    the route message rather than a generic failure. */}
			{cancel.isError ? (
				<p role="alert" className="mt-2 text-red-400 text-sm">
					{cancel.error instanceof ApiError && cancel.error.status === 409
						? t("jobDetail.alreadyTerminal")
						: cancel.error instanceof ApiError
							? cancel.error.message
							: t("jobs.cancelFailed")}
				</p>
			) : null}

			{/* Re-run-as-new outcome. A failure (incl. the enqueue-failure 500 the
			    route surfaces) makes clear the SOURCE job is unchanged — only the
			    new run failed to start. */}
			{reRun.isSuccess ? (
				<p role="status" className="mt-2 text-emerald-400 text-sm">
					{t("uiX.newJobQueued")}{" "}
					<Link
						href={`/vod/jobs/${reRun.data.id}`}
						className="font-medium underline hover:text-emerald-300"
					>
						{t("uiX.openJobId", { id: reRun.data.id })}
					</Link>
				</p>
			) : null}
			{reRun.isError ? (
				<p role="alert" className="mt-2 text-red-400 text-sm">
					{t("uiX.couldNotStartNewRun")}
					{reRun.error instanceof ApiError ? `: ${reRun.error.message}` : ""}
					{t("common.sentenceEnd")}
					{t("uiX.thisJobIsUnchanged")}
				</p>
			) : null}

			{/* The encoding id MOVED into the overview strip (design §5 clause 1). It
			    was rendered here as well, so Overview showed it twice — the strip's
			    labelled field and this bare line (review finding). `uiX.encodingIdLine`
			    stays in the catalogue: the live channel detail still uses it. */}

			{/*  §5: the plan is on the row — hardening this job into
			    a launchable template is one click + a name. */}
			<div className="mt-3 flex items-center gap-2">
				<RoleAccess control="vod.job.detail">
					<SaveAsTemplateButton
						kind="FULL_PLAN"
						plan={row.plan}
						defaultName={row.name}
					/>
				</RoleAccess>
			</div>

			{/* Tabs: keep the existing detail (manifests / VMAF / timeline) on
			    Overview; Resources is the bm-xray-style resource tree. */}
			<div className="mt-6 flex gap-1 border-zinc-800 border-b" role="tablist">
				{(
					[
						["overview", t("ui.overview")],
						["resources", t("ui.resources")],
					] as const
				).map(([value, label]) => (
					<button
						key={value}
						type="button"
						role="tab"
						aria-selected={tab === value}
						onClick={() => setTab(value)}
						className={cn(
							"-mb-px border-b-2 px-3 py-2 font-medium text-sm transition-colors",
							tab === value
								? "border-emerald-500 text-zinc-50"
								: "border-transparent text-zinc-500 hover:text-zinc-300",
						)}
					>
						{label}
					</button>
				))}
			</div>

			{/*
			 * Two columns from `lg` up: job detail left, playback rail right.
			 *
			 * The rail sits OUTSIDE the tab switch because playback is orthogonal to
			 * which tab is open — an operator checking the resource tree should not
			 * lose the player. 380px keeps a 16:9 surface at ~214px, enough to see
			 * decode.
			 *
			 * The rail is FIRST in DOM and placed into column 2 explicitly on `lg`.
			 * The obvious alternative — detail first, `order-first` on the rail —
			 * displays correctly and READS wrongly: below `lg` the player appears
			 * above the detail while a keyboard or screen reader still traverses the
			 * whole left column to reach it. Explicit `col-start` keeps the desktop
			 * arrangement without making the two orders disagree (found by asserting
			 * DOM order rather than the class).
			 */}
			<div className="mt-4 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
				<div className="lg:col-start-2 lg:row-start-1">
					<PreviewRail
						player={player}
						sceneAnalysis={sceneAnalysis}
						seekRequest={analysisSeek}
						analyticsMeta={{
							// UI-DESIGN §2: videoId = encodingId — the dashboard's first-class
							// filter; the local job id rides customData5.
							videoId: row.bitmovinEncodingId ?? id,
							title: row.name,
							customData5: id,
						}}
						jobId={id}
						links={links}
						playable={playable}
						playableKeys={playableKeys}
						live={row.status === "RUNNING"}
						pending={row.status === "QUEUED" || row.status === "RUNNING"}
						// One player at a time: the rail's preview unmounts while the
						// enlarged dialog is open, so the two never buffer in parallel.
						showPlayer={playback === null}
						onPlay={(link) =>
							setPlayback({
								url: link.url as string,
								manifestKey: link.key,
								// SMOOTH never reaches here: `playableLinks` excludes it.
								kind: link.kind === "DASH" ? "DASH" : "HLS",
							})
						}
					/>
				</div>
				<div
					id="job-detail-content"
					className="min-w-0 lg:col-start-1 lg:row-start-1"
				>
					{tab === "overview" ? (
						<>
							{/* What was encoded — the answer this page did not have. All
							    three panels derive from the persisted plan + step log, so
							    they render for a DRAFT job and after Bitmovin's ~90-day
							    purge alike (C7). */}
							<OverviewStrip
								region={row.region}
								{...("encoderVersion" in planFacts &&
								planFacts.encoderVersion !== undefined
									? { encoderVersion: planFacts.encoderVersion }
									: {})}
								{...("encodingMode" in planFacts &&
								planFacts.encodingMode !== undefined
									? { encodingMode: planFacts.encodingMode }
									: {})}
								labels={row.labels}
								createdAt={row.createdAt}
								{...(encodeDuration !== undefined
									? { durationSeconds: encodeDuration }
									: {})}
								{...(startupSeconds !== undefined ? { startupSeconds } : {})}
								bitmovinEncodingId={row.bitmovinEncodingId}
								presetRevision={row.presetRevision ?? null}
								preset={row.preset ?? null}
							/>

							{detail ? (
								<>
									<RenditionTables
										video={detail.renditions.video}
										audio={detail.renditions.audio}
										subtitle={detail.renditions.subtitle}
										renditions={detail.plan.renditions}
										filters={detail.plan.filters}
										anchorForResource={anchorForResource}
										onOpenResource={openResource}
									/>
									<AuxOutputsPanel plan={detail.plan} />
									{/* Only for per-title plans: a fixed ladder has no results to
									    capture, and an empty "Per-Title results" heading on every
									    other job would be noise that reads as a missing feature. */}
									{planHasPerTitle(detail.plan) ? (
										<PerTitleResultsPanel
											view={perTitleResultsView({
												stepLog: job.data?.stepLog,
												snapshots: job.data?.snapshots,
											})}
											templateOrder={perTitleTemplates(detail.plan).map(
												(template: { rendition: string }) => template.rendition,
											)}
											// Terminal only, matching the route's own guard: the
											// results do not exist until the encoding finishes.
											canCapture={!isActive}
											jobId={id}
										/>
									) : null}
									<InputFilesPanel
										files={detail.inputFiles}
										credentialRefs={credentialRefs}
									/>
									<StoragePanel
										summaries={detail.storage}
										credentialRefs={credentialRefs}
									/>
								</>
							) : null}

							<JobAnalysisPanel
								jobId={id}
								enabled={
									analysisEnabled || analysis.data?.captureSuppressed === true
								}
								captureSuppressed={analysis.data?.captureSuppressed}
								source={analysis.data?.source}
								error={analysis.error}
								locale={analysisLocale}
								onLocaleChange={setSelectedLocale}
								onSeek={
									playable.length
										? (seconds) =>
												setAnalysisSeek((previous) => ({
													seconds,
													requestId: (previous?.requestId ?? 0) + 1,
												}))
										: undefined
								}
							/>

							{detail?.plan.qc?.gate ? (
								<QcGatePanel
									gate={detail.plan.qc.gate}
									verdict={row.qcVerdict ?? null}
									status={row.status}
									jobId={id}
									vmafJobId={vmaf.data?.items[0]?.id ?? null}
									measurementStatus={vmaf.data?.items[0]?.status ?? null}
									overriddenAt={row.qcOverriddenAt ?? null}
								/>
							) : null}

							{qcVmafEnabled && vmaf.isError ? (
								<div className="mt-4 flex items-center gap-3">
									<p role="alert" className="text-red-400 text-sm">
										{t("jobDetail.vmafLoadFailed")}
									</p>
									<Button
										variant="secondary"
										size="sm"
										disabled={vmaf.isFetching}
										onClick={() => vmaf.refetch()}
									>
										{t("common.retry")}
									</Button>
								</div>
							) : null}

							<RoleAccess control="vod.job.detail">
								{qcVmafEnabled && row.status === "FINISHED" ? (
									<div className="mt-8 flex items-center gap-3">
										<Button
											variant="secondary"
											size="sm"
											disabled={
												measureVmaf.isPending ||
												retryVmaf.isPending ||
												vmafBusy ||
												vmaf.isPending ||
												vmaf.isError
											}
											onClick={() => measureVmaf.mutate()}
										>
											{measureVmaf.isPending
												? t("common.saving")
												: t("jobDetail.measureVmaf")}
										</Button>
										{measureVmaf.isError ? (
											<p role="alert" className="text-red-400 text-xs">
												{measureVmaf.error instanceof ApiError
													? measureVmaf.error.message
													: String(measureVmaf.error)}
											</p>
										) : null}
									</div>
								) : null}
							</RoleAccess>
							{vmafBusy ? (
								<p role="status" className="mt-2 text-xs text-zinc-400">
									{t("jobDetail.vmafRunning")}
								</p>
							) : null}
							{retryVmaf.isSuccess ? (
								<p role="status" className="mt-2 text-xs text-emerald-400">
									{t("jobDetail.vmafRetryQueued")}
								</p>
							) : null}
							{retryVmaf.isError ? (
								<p role="alert" className="mt-2 text-xs text-red-400">
									{retryVmaf.error instanceof Error
										? retryVmaf.error.message
										: String(retryVmaf.error)}
								</p>
							) : null}
							{qcVmafEnabled && vmaf.data && vmaf.data.items.length > 0 ? (
								<>
									<h2 className="mt-8 font-medium text-sm text-zinc-200">
										{t("jobDetail.vmafReports")}
									</h2>
									<ul className="mt-2 space-y-2">
										{vmaf.data.items.map((report) => (
											<li
												key={report.id}
												className="flex items-center gap-3 rounded-md border border-zinc-800 px-3 py-2"
											>
												<Badge tone={VMAF_STATUS_TONE[report.status]}>
													{report.status}
												</Badge>
												<Link
													href={`/qc/${report.id}`}
													className="min-w-0 flex-1 truncate text-sm text-zinc-200 hover:text-emerald-400"
												>
													{report.model} · {report.mode}
												</Link>
												<span className="text-xs text-zinc-500">
													{t("jobDetail.viewReport")}
												</span>
												{report.localRetryAvailable &&
												(row.status === "FINISHED" ||
													row.status === "QC_FAILED") ? (
													<RoleAccess control="vod.job.detail">
														<Button
															variant="secondary"
															size="sm"
															title={t("jobDetail.retryVmafOnlyHint")}
															disabled={
																vmafBusy ||
																retryVmaf.isPending ||
																measureVmaf.isPending ||
																vmaf.isError
															}
															onClick={() => retryVmaf.mutate(report.id)}
														>
															{t("jobDetail.retryVmafOnly")}
														</Button>
													</RoleAccess>
												) : null}
											</li>
										))}
									</ul>
								</>
							) : null}

							{/*
							 * Collapsed by default: the progress header and the Resources tab
							 * already carry what the timeline says, so at full height it pushed
							 * the encoding detail below the fold for no one's benefit. Still one
							 * click away, because it is the diagnostic view when a step failed.
							 */}
							{/*
							 * `<summary><h2>` — collapsing this to a bare `<summary>` dropped
							 * "Step timeline" out of the heading outline entirely (it was an
							 * `<h2>` before), so the document went h1 → h3 → h2 with the
							 * section unreachable by heading navigation (review finding).
							 *
							 * `open` is controlled so the disclosure survives a tab
							 * round-trip: this `<details>` lives inside the overview branch,
							 * which unmounts on switching to Resources and came back closed —
							 * ironic given the rail was hoisted OUT of that branch for exactly
							 * that reason (review finding).
							 */}
							<details
								className="mt-8"
								open={timelineOpen}
								// `onToggle` on the <details>, not `onClick` + preventDefault on
								// the <summary>: the browser's own disclosure behaviour keeps
								// working (mouse, Enter, Space), state is synced from the result
								// rather than replacing it, and a static-element click handler
								// stops being a lint finding it deserved to be.
								onToggle={(event) => setTimelineOpen(event.currentTarget.open)}
							>
								<summary className="cursor-pointer">
									<h2 className="inline font-medium text-sm text-zinc-200 hover:text-zinc-50">
										{t("jobDetail.stepTimeline")}
									</h2>
								</summary>
								{entries.success ? (
									<StepTimeline entries={entries.data} />
								) : (
									<p className="mt-2 text-sm text-zinc-500">
										{t("jobDetail.stepLogUnavailable")}
									</p>
								)}
							</details>
						</>
					) : (
						<div className="mt-2">
							{entries.success ? (
								<ResourcesTab entries={entries.data} />
							) : (
								<p className="mt-2 text-sm text-zinc-500">
									{t("jobDetail.stepLogUnavailable")}
								</p>
							)}
						</div>
					)}
				</div>
			</div>

			<PlayerDialog
				player={player}
				sceneAnalysis={sceneAnalysis}
				seekRequest={analysisSeek}
				analyticsMeta={{
					// UI-DESIGN §2: videoId = encodingId — the dashboard's first-class
					// filter; the local job id rides customData5.
					videoId: row.bitmovinEncodingId ?? id,
					title: row.name,
					customData5: id,
				}}
				url={playback?.url ?? null}
				kind={playback?.kind ?? null}
				{...(playback
					? {
							diagnose: {
								scope: "vod" as const,
								id,
								manifestKey: playback.manifestKey,
							},
						}
					: {})}
				onClose={() => setPlayback(null)}
			/>
		</section>
	);
}
