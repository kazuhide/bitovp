"use client";

import {
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailPopover } from "@/components/ui/detail-popover";
import { Input, SelectNative } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { RoleAccess, useMutationAccess } from "@/lib/auth/use-role-access";
import {
	type BulkCancelResult,
	type BulkDeleteResult,
	bulkSummary,
	MAX_BULK_IDS,
} from "@/lib/bulk-ops";
import { useQcVmafEnabled } from "@/lib/feature-flags/context";
import { formatDateTime, formatDuration } from "@/lib/format";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import {
	isActiveJobStatus,
	JOB_STATUSES,
	type JobStatus,
	STATUS_TONE,
} from "@/lib/job-status";

// The status contract lives in a UI-free module (`lib/job-status`) because the
// server routes gate on the SAME `isActiveJobStatus`; re-exported here so every
// existing `@/app/vod/jobs/jobs-client` import site is unchanged.
export { isActiveJobStatus, JOB_STATUSES, type JobStatus, STATUS_TONE };

export type JobListItem = {
	id: string;
	name: string;
	labels: string[];
	status: JobStatus;
	region: string | null;
	doneSteps: number;
	totalSteps: number;
	error: string | null;
	bitmovinEncodingId: string | null;
	/** QC gate verdict ; minimal shape — the list needs pass. */
	qcVerdict: { pass: boolean } | null;
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
};

type RegionDisplay = { primary: string; raw?: string };

/** Turn provider region enums into the spelling used in provider consoles. */
function regionDisplay(raw: string): RegionDisplay {
	const providers = [
		["AWS_", "AWS"],
		["GCE_", "GCP"],
		["GOOGLE_", "GCP"],
		["AZURE_", "Azure"],
		["AKAMAI_", "Akamai"],
		["OCI_", "OCI"],
	] as const;
	for (const [prefix, label] of providers) {
		if (raw.startsWith(prefix) && raw.length > prefix.length) {
			return {
				primary: `${label} ${raw.slice(prefix.length).toLowerCase().replaceAll("_", "-")}`,
				raw,
			};
		}
	}
	return { primary: raw };
}

type Page = { items: JobListItem[]; nextCursor?: string };

type BulkReRunResult = {
	created: { sourceId: string; newId: string }[];
	failed: { sourceId: string; error: string }[];
};

/* Selectable columns are persisted per browser. Identity and actions stay fixed. Quality-control columns start hidden while their gate remains configurable in the wizard. */
const TOGGLEABLE_COLUMNS = [
	{ key: "status", labelKey: "common.status" },
	{ key: "qc", labelKey: "jobs.qc" },
	{ key: "labels", labelKey: "common.labels" },
	{ key: "region", labelKey: "common.region" },
	{ key: "progress", labelKey: "common.progress" },
	{ key: "duration", labelKey: "common.duration" },
	{ key: "created", labelKey: "common.created" },
] as const satisfies readonly { key: string; labelKey: MessageKey }[];
type ColumnKey = (typeof TOGGLEABLE_COLUMNS)[number]["key"];
const DEFAULT_VISIBLE_COLUMNS: readonly ColumnKey[] = [
	"status",
	"labels",
	"region",
	"progress",
	"duration",
	"created",
];
const COLUMNS_STORAGE_KEY = "ovp-vod-jobs-columns";
const KNOWN_COLUMN_KEYS = new Set<string>(TOGGLEABLE_COLUMNS.map((c) => c.key));

function readStoredColumns(): Set<ColumnKey> {
	if (typeof window === "undefined") {
		return new Set(DEFAULT_VISIBLE_COLUMNS);
	}
	try {
		const raw = window.localStorage.getItem(COLUMNS_STORAGE_KEY);
		if (raw === null) {
			return new Set(DEFAULT_VISIBLE_COLUMNS);
		}
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return new Set(DEFAULT_VISIBLE_COLUMNS);
		}
		// Unknown keys are DROPPED, not kept: a renamed column must not leave
		// a ghost entry that reads as "visible" for a column that no longer
		// exists.
		const known = parsed.filter(
			(k): k is ColumnKey => typeof k === "string" && KNOWN_COLUMN_KEYS.has(k),
		);
		// review-253 117-A1: a NON-EMPTY stored array that filters to nothing is
		// schema drift (wholesale rename), not "the user turned everything off"
		// — fall back to defaults instead of a bare 3-column table.
		if (parsed.length > 0 && known.length === 0) {
			return new Set(DEFAULT_VISIBLE_COLUMNS);
		}
		return new Set(known);
	} catch {
		return new Set(DEFAULT_VISIBLE_COLUMNS);
	}
}

/** VIEWERs get the readable name/metrics only; action columns are not placeholders. */
function colSpanFor(visible: Set<ColumnKey>, canOperate: boolean): number {
	return (canOperate ? 3 : 1) + visible.size;
}

export function JobsClient() {
	const qcVmafEnabled = useQcVmafEnabled();
	const { t } = useT();
	const canOperate = useMutationAccess("vod.jobs.list");
	const queryClient = useQueryClient();
	const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(
		() => new Set(DEFAULT_VISIBLE_COLUMNS),
	);
	useEffect(() => {
		setVisibleColumns(readStoredColumns());
	}, []);
	const toggleColumn = (key: ColumnKey) => {
		setVisibleColumns((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			window.localStorage.setItem(
				COLUMNS_STORAGE_KEY,
				JSON.stringify([...next]),
			);
			return next;
		});
	};
	// : ONE wire point for the QC column — the header and the cell
	// both go through col, so the flag cannot hide one and leave the other.
	const col = (key: ColumnKey) =>
		visibleColumns.has(key) && (key !== "qc" || qcVmafEnabled);
	const [columnsOpen, setColumnsOpen] = useState(false);
	const [status, setStatus] = useState<JobStatus | "">("");
	const [qc, setQc] = useState<"" | "pass" | "fail">("");
	const [label, setLabel] = useState("");
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

	const jobs = useInfiniteQuery({
		// Filters are part of the key so changing them refetches from page 1.
		queryKey: ["encoding-jobs", { status, qc, label }],
		queryFn: ({ pageParam }) => {
			const params = new URLSearchParams();
			if (pageParam) {
				params.set("cursor", pageParam);
			}
			if (status) {
				params.set("status", status);
			}
			if (qc) {
				params.set("qc", qc);
			}
			if (label.trim()) {
				params.set("label", label.trim());
			}
			const qs = params.toString();
			return apiFetch<Page>(`/api/encoding-jobs${qs ? `?${qs}` : ""}`);
		},
		initialPageParam: "",
		getNextPageParam: (last: Page) => last.nextCursor ?? null,
		// Refetching re-loads every accumulated page — poll fast only while
		// the first page shows active jobs.
		refetchInterval: (query) =>
			query.state.data?.pages[0]?.items.some((job) =>
				isActiveJobStatus(job.status),
			)
				? 10_000
				: 60_000,
	});
	const items = useMemo(
		() => jobs.data?.pages.flatMap((p) => p.items) ?? [],
		[jobs.data],
	);

	const reRun = useMutation({
		mutationFn: (ids: string[]) =>
			apiFetch<BulkReRunResult>("/api/encoding-jobs/bulk-re-run", {
				method: "POST",
				body: JSON.stringify({ ids }),
			}),
		onSuccess: (result) => {
			const failed = new Set(result.failed.map((item) => item.sourceId));
			setSelected(
				(previous) => new Set([...previous].filter((id) => failed.has(id))),
			);
			jobs.refetch();
		},
	});

	// Per-row delete (terminal-only — the button is disabled for active jobs,
	// mirroring the route's 409 guard). LOCAL records only; refetch on success.
	const remove = useMutation({
		mutationFn: (id: string) =>
			apiFetch(`/api/encoding-jobs/${id}`, { method: "DELETE" }),
		onSuccess: () => {
			setSelected(new Set());
			queryClient.invalidateQueries({ queryKey: ["encoding-jobs"] });
		},
	});

	// Bulk cancel: cooperative-cancel flag per id (the worker owns the terminal
	// CANCELED transition). Only ACTIVE rows are sent — the route's atomic claim
	// matches QUEUED|RUNNING only, so anything else would come back "skipped".
	const bulkCancel = useMutation({
		mutationFn: (ids: string[]) =>
			apiFetch<BulkCancelResult>("/api/encoding-jobs/bulk-cancel", {
				method: "POST",
				body: JSON.stringify({ ids }),
			}),
		onSuccess: (result) => {
			const skipped = new Set(result.skipped.map((item) => item.id));
			setSelected(
				(previous) => new Set([...previous].filter((id) => skipped.has(id))),
			);
			queryClient.invalidateQueries({ queryKey: ["encoding-jobs"] });
		},
	});

	// Bulk delete: terminal rows only (same guard as the per-row delete), behind
	// the shared confirm dialog. LOCAL records only.
	const bulkDelete = useMutation({
		mutationFn: (ids: string[]) =>
			apiFetch<BulkDeleteResult>("/api/encoding-jobs/bulk-delete", {
				method: "POST",
				body: JSON.stringify({ ids }),
			}),
		onSuccess: (result) => {
			const skipped = new Set(result.skipped.map((item) => item.id));
			setSelected(
				(previous) => new Set([...previous].filter((id) => skipped.has(id))),
			);
			queryClient.invalidateQueries({ queryKey: ["encoding-jobs"] });
		},
	});

	// Actions only include loaded rows; changing filters clears the selection.
	// Failed bulk items stay selected so recovery cannot re-run successful jobs.
	const selectedJobs = useMemo(
		() => items.filter((job) => selected.has(job.id)),
		[items, selected],
	);
	const visibleSelected = useMemo(
		() => selectedJobs.map((job) => job.id),
		[selectedJobs],
	);
	// Per-action eligible subsets, both derived from the SHARED
	// `isActiveJobStatus` — the same predicate the routes' guards use, so the
	// buttons can never offer (or hide) something the server would answer
	// differently.
	const cancelableSelected = useMemo(
		() =>
			selectedJobs
				.filter((job) => isActiveJobStatus(job.status))
				.map((j) => j.id),
		[selectedJobs],
	);
	const deletableSelected = useMemo(
		() =>
			selectedJobs
				.filter((job) => !isActiveJobStatus(job.status))
				.map((j) => j.id),
		[selectedJobs],
	);
	const allVisibleSelected =
		items.length > 0 && visibleSelected.length === items.length;

	function toggleOne(id: string, on: boolean) {
		setSelected((prev) => {
			const next = new Set(prev);
			if (on) {
				next.add(id);
			} else {
				next.delete(id);
			}
			return next;
		});
	}

	function toggleAll(on: boolean) {
		setSelected(on ? new Set(items.map((job) => job.id)) : new Set());
	}

	return (
		<section>
			<header className="flex items-center justify-between">
				<div>
					<h1 className="font-semibold text-xl text-zinc-50">
						{t("jobs.title")}
					</h1>
				</div>
				<RoleAccess control="vod.jobs.list">
					<Link
						href="/vod/new"
						className="inline-flex h-9 items-center rounded-md bg-emerald-600 px-4 font-medium text-sm text-white transition-colors hover:bg-emerald-500"
					>
						{t("jobs.newJob")}
					</Link>
				</RoleAccess>
			</header>

			<div className="mt-6 flex flex-wrap items-center gap-3">
				<div className="flex items-center gap-2 text-xs text-zinc-400">
					<label htmlFor="job-status-filter">{t("common.status")}</label>
					<SelectNative
						id="job-status-filter"
						className="w-40"
						value={status}
						onChange={(e) => {
							setSelected(new Set());
							setStatus(e.target.value as JobStatus | "");
						}}
					>
						<option value="">{t("jobs.all")}</option>
						{JOB_STATUSES.map((s) => (
							<option key={s} value={s}>
								{s}
							</option>
						))}
					</SelectNative>
				</div>
				{qcVmafEnabled ? (
					<div className="flex items-center gap-2 text-xs text-zinc-400">
						<label htmlFor="job-qc-filter">{t("jobs.qc")}</label>
						<SelectNative
							id="job-qc-filter"
							className="w-32"
							value={qc}
							onChange={(e) => {
								setSelected(new Set());
								setQc(e.target.value as "" | "pass" | "fail");
							}}
						>
							<option value="">{t("jobs.all")}</option>
							<option value="pass">{t("jobs.qcPass")}</option>
							<option value="fail">{t("jobs.qcFail")}</option>
						</SelectNative>
					</div>
				) : null}
				<div className="flex items-center gap-2 text-xs text-zinc-400">
					<label htmlFor="job-label-filter">{t("jobs.label")}</label>
					<Input
						id="job-label-filter"
						className="w-48"
						placeholder={t("jobs.filterByLabel")}
						value={label}
						onChange={(e) => {
							setSelected(new Set());
							setLabel(e.target.value);
						}}
					/>
				</div>
				{status || qc || label ? (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							setSelected(new Set());
							setStatus("");
							setQc("");
							setLabel("");
						}}
					>
						{t("common.clear")}
					</Button>
				) : null}
				<div className="relative ml-auto">
					<Button
						variant="secondary"
						size="sm"
						aria-expanded={columnsOpen}
						onClick={() => setColumnsOpen((v) => !v)}
					>
						{t("jobs.columns")}
					</Button>
					{columnsOpen ? (
						<div className="absolute right-0 z-10 mt-1 w-48 rounded-md border border-zinc-800 bg-zinc-950 p-2 shadow-lg">
							{TOGGLEABLE_COLUMNS.filter(
								(c) => c.key !== "qc" || qcVmafEnabled,
							).map((c) => (
								<label
									key={c.key}
									className="flex items-center gap-2 rounded px-1.5 py-1 text-xs text-zinc-300 hover:bg-zinc-900"
								>
									<input
										type="checkbox"
										className="accent-emerald-600"
										checked={col(c.key)}
										onChange={() => toggleColumn(c.key)}
									/>
									{t(c.labelKey)}
								</label>
							))}
						</div>
					) : null}
				</div>
			</div>

			<RoleAccess control="vod.jobs.list">
				{visibleSelected.length > 0 ? (
					<div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-900/60 bg-emerald-950/30 px-3 py-2">
						<span className="text-sm text-emerald-200">
							{t("uiX.selectedCount", { count: visibleSelected.length })}
						</span>
						<div className="flex flex-wrap items-center gap-2">
							<Button
								size="sm"
								disabled={
									reRun.isPending || visibleSelected.length > MAX_BULK_IDS
								}
								title={
									visibleSelected.length > MAX_BULK_IDS
										? t("uiX.upToNJobsPerBulk", { max: MAX_BULK_IDS })
										: undefined
								}
								onClick={() => reRun.mutate(visibleSelected)}
							>
								{reRun.isPending
									? t("jobs.rerunning")
									: t("jobs.rerunSelected")}
							</Button>
							<Button
								variant="secondary"
								size="sm"
								disabled={
									bulkCancel.isPending ||
									cancelableSelected.length === 0 ||
									cancelableSelected.length > MAX_BULK_IDS
								}
								title={
									cancelableSelected.length === 0
										? t("jobs.noActiveInSelection")
										: cancelableSelected.length > MAX_BULK_IDS
											? t("uiX.upToNJobsPerBulk", { max: MAX_BULK_IDS })
											: undefined
								}
								onClick={() => bulkCancel.mutate(cancelableSelected)}
							>
								{bulkCancel.isPending
									? t("jobDetail.canceling")
									: cancelableSelected.length !== visibleSelected.length
										? t("uiX.cancelSelectedCount", {
												count: cancelableSelected.length,
											})
										: t("uiX.cancelSelected")}
							</Button>
							<DeleteResourceButton
								resourceLabel={t("uiX.selectedJobsCount", {
									count: deletableSelected.length,
								})}
								disabled={
									deletableSelected.length === 0 ||
									deletableSelected.length > MAX_BULK_IDS
								}
								disabledReason={
									deletableSelected.length === 0
										? t("jobs.noTerminalInSelection")
										: t("uiX.upToNJobsPerBulk", { max: MAX_BULK_IDS })
								}
								confirmTitle={t(
									deletableSelected.length === 1
										? "uiX.deleteNJobsOne"
										: "uiX.deleteNJobsOther",
									{ count: deletableSelected.length },
								)}
								confirmDescription={t("jobs.deleteConfirmMany")}
								pending={bulkDelete.isPending}
								onConfirm={() => bulkDelete.mutate(deletableSelected)}
							/>
						</div>
					</div>
				) : null}
			</RoleAccess>

			{/* Outcomes remain visible after the successful rows leave the selection. */}
			{reRun.data ||
			bulkCancel.data ||
			bulkDelete.data ||
			reRun.isError ||
			bulkCancel.isError ||
			bulkDelete.isError ? (
				<div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
					{reRun.data ? (
						<span className="text-zinc-400">
							{bulkSummary(
								reRun.data.created.length,
								reRun.data.failed.length,
								"re-run",
							)}
						</span>
					) : null}
					{bulkCancel.data ? (
						<span className="text-zinc-400">
							{bulkSummary(
								bulkCancel.data.canceled.length,
								bulkCancel.data.skipped.length,
								"canceling",
							)}
						</span>
					) : null}
					{bulkDelete.data ? (
						<span className="text-zinc-400">
							{bulkSummary(
								bulkDelete.data.deleted.length,
								bulkDelete.data.skipped.length,
								"deleted",
							)}
						</span>
					) : null}
					{reRun.isError ? (
						<span role="alert" className="text-red-400">
							{reRun.error instanceof ApiError
								? reRun.error.message
								: t("jobs.rerunFailed")}
						</span>
					) : null}
					{bulkCancel.isError ? (
						<span role="alert" className="text-red-400">
							{bulkCancel.error instanceof ApiError
								? bulkCancel.error.message
								: t("jobs.cancelFailed")}
						</span>
					) : null}
					{bulkDelete.isError ? (
						<span role="alert" className="text-red-400">
							{bulkDelete.error instanceof ApiError
								? bulkDelete.error.message
								: t("jobs.bulkDeleteFailed")}
						</span>
					) : null}
				</div>
			) : null}

			{[
				...(reRun.data?.failed.map((item) => ({
					id: item.sourceId,
					reason: item.error,
				})) ?? []),
				...(bulkCancel.data?.skipped ?? []),
				...(bulkDelete.data?.skipped ?? []),
			].map((item, index) => (
				<p key={`${index}-${item.id}`} className="mt-2 text-xs text-amber-400">
					<Link href={`/vod/jobs/${item.id}`} className="underline">
						{items.find((job) => job.id === item.id)?.name ?? item.id}
					</Link>
					{": "}
					<span>
						{item.reason === "Re-run failed"
							? t("jobs.rerunFailed")
							: item.reason === "Cancel failed"
								? t("jobs.cancelFailed")
								: item.reason === "Delete failed"
									? t("jobs.deleteFailed")
									: item.reason}
					</span>
				</p>
			))}

			{remove.isError ? (
				<p role="alert" className="mt-3 text-red-400 text-sm">
					{remove.error instanceof ApiError
						? remove.error.message
						: t("jobs.deleteFailed")}
				</p>
			) : null}

			{jobs.isError ? (
				<p role="alert" className="mt-6 text-red-400 text-sm">
					{t("jobs.loadFailed")}
				</p>
			) : (
				<div className="mt-3 overflow-x-auto rounded-lg border border-zinc-800">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-zinc-800 border-b text-left text-xs text-zinc-500">
								{canOperate ? (
									<th className="w-8 px-3 py-2">
										<input
											type="checkbox"
											aria-label={t("jobs.selectAllLoaded")}
											className="accent-emerald-600"
											checked={allVisibleSelected}
											onChange={(e) => toggleAll(e.target.checked)}
										/>
									</th>
								) : null}
								<th className="px-3 py-2 font-medium">{t("common.name")}</th>
								{col("status") ? (
									<th className="px-3 py-2 font-medium">
										{t("common.status")}
									</th>
								) : null}
								{col("qc") ? (
									<th className="px-3 py-2 font-medium">{t("jobs.qc")}</th>
								) : null}
								{col("labels") ? (
									<th className="px-3 py-2 font-medium">
										{t("common.labels")}
									</th>
								) : null}
								{col("region") ? (
									<th className="px-3 py-2 font-medium">
										{t("common.region")}
									</th>
								) : null}
								{col("progress") ? (
									<th className="px-3 py-2 font-medium">
										{t("common.progress")}
									</th>
								) : null}
								{col("duration") ? (
									<th className="px-3 py-2 font-medium">
										{t("common.duration")}
									</th>
								) : null}
								{col("created") ? (
									<th className="px-3 py-2 font-medium">
										{t("common.created")}
									</th>
								) : null}
								{canOperate ? (
									<th className="px-3 py-2 text-right font-medium">
										{t("common.actions")}
									</th>
								) : null}
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800/70">
							{items.map((job) => (
								<tr key={job.id} className="hover:bg-zinc-900/40">
									{canOperate ? (
										<td className="px-3 py-2 align-top">
											<input
												type="checkbox"
												aria-label={t("uiX.selectJobNamed", {
													name: job.name,
												})}
												className="mt-0.5 accent-emerald-600"
												checked={selected.has(job.id)}
												onChange={(e) => toggleOne(job.id, e.target.checked)}
											/>
										</td>
									) : null}
									{/*
									 * Same fix as the channels list (owner report
									 * 2026-08-21): min-w-48 keeps the identity column
									 * from collapsing on narrow windows, max-w-0 is
									 * what lets truncate bite in an auto table, w-full
									 * hands it the slack. A worker error sentence
									 * (hundreds of chars) otherwise sets the column's
									 * intrinsic width and shoves every other column
									 * into the scroll region.
									 */}
									<td className="w-full min-w-48 max-w-0 px-3 py-2">
										<Link
											href={`/vod/jobs/${job.id}`}
											className="block truncate text-zinc-200 hover:text-emerald-400"
										>
											{job.name}
										</Link>
										{job.error ? (
											<div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
												<span className="text-red-400">
													{t("jobs.providerFailure")}
												</span>
												<DetailPopover
													summary={t("jobs.technicalDetails")}
													label={t("jobs.providerFailureDetail")}
												>
													<p className="select-all whitespace-pre-wrap break-all font-mono text-zinc-200">
														{job.error}
													</p>
												</DetailPopover>
											</div>
										) : null}
									</td>
									{col("status") ? (
										<td className="px-3 py-2">
											<Badge tone={STATUS_TONE[job.status]}>{job.status}</Badge>
										</td>
									) : null}
									{col("qc") ? (
										<td className="px-3 py-2">
											{job.qcVerdict ? (
												<Badge tone={job.qcVerdict.pass ? "ok" : "error"}>
													{job.qcVerdict.pass
														? t("jobs.qcPass")
														: t("jobs.qcFail")}
												</Badge>
											) : (
												<span className="text-xs text-zinc-600">—</span>
											)}
										</td>
									) : null}
									{col("labels") ? (
										<td className="px-3 py-2">
											{job.labels.length > 0 ? (
												<span className="flex flex-wrap gap-1">
													{job.labels.map((l) => (
														<Badge
															key={l}
															className="max-w-[12rem] truncate"
															title={l}
														>
															{l}
														</Badge>
													))}
												</span>
											) : (
												<span className="text-xs text-zinc-600">—</span>
											)}
										</td>
									) : null}
									{col("region") ? (
										<td className="px-3 py-2 text-xs text-zinc-400">
											{job.region ? (
												<span className="flex flex-col gap-0.5">
													<span>{regionDisplay(job.region).primary}</span>
													{regionDisplay(job.region).raw ? (
														<code className="text-[10px] text-zinc-600">
															{regionDisplay(job.region).raw}
														</code>
													) : null}
												</span>
											) : (
												"—"
											)}
										</td>
									) : null}
									{col("progress") ? (
										<td className="px-3 py-2">
											<JobProgress
												done={job.doneSteps}
												total={job.totalSteps}
											/>
										</td>
									) : null}
									{col("duration") ? (
										<td className="px-3 py-2 text-xs text-zinc-400">
											<JobDuration job={job} />
										</td>
									) : null}
									{col("created") ? (
										<td className="px-3 py-2 text-xs text-zinc-400">
											{formatDateTime(job.createdAt)}
										</td>
									) : null}
									{canOperate ? (
										<td className="px-3 py-2 text-right">
											<RoleAccess control="vod.jobs.list">
												<DeleteResourceButton
													resourceLabel={job.name}
													disabled={isActiveJobStatus(job.status)}
													disabledReason={t("ui.cancelTheJobBeforeDeleting")}
													confirmTitle={t("uiX.deleteJobNamed", {
														name: job.name,
													})}
													confirmDescription={t("jobs.deleteConfirmOne")}
													pending={
														remove.isPending && remove.variables === job.id
													}
													onConfirm={() => remove.mutate(job.id)}
												/>
											</RoleAccess>
										</td>
									) : null}
								</tr>
							))}
							{!jobs.isLoading && items.length === 0 ? (
								<tr>
									<td
										colSpan={colSpanFor(visibleColumns, canOperate)}
										className="px-3 py-10 text-center text-sm text-zinc-500"
									>
										{/* review-202 I1: qc was missing here while the
										    Clear-filters predicate had it — a QC-only filter
										    with zero matches claimed the account was empty. */}
										{status || qc || label
											? t("jobs.noMatches")
											: t("jobs.emptyHint")}
									</td>
								</tr>
							) : null}
						</tbody>
					</table>
					{jobs.hasNextPage ? (
						<div className="border-zinc-800 border-t p-2">
							<Button
								variant="secondary"
								size="sm"
								disabled={jobs.isFetchingNextPage}
								onClick={() => jobs.fetchNextPage()}
							>
								{jobs.isFetchingNextPage
									? t("common.loading")
									: t("jobs.loadMore")}
							</Button>
						</div>
					) : null}
				</div>
			)}
		</section>
	);
}

/** doneSteps/totalSteps → a small bar + label, "—" when progress is unknown. */
function JobProgress({ done, total }: { done: number; total: number }) {
	// totalSteps=0 ⇒ pre-migration job (or not yet compiled): unknown.
	if (total <= 0) {
		return <span className="text-xs text-zinc-600">—</span>;
	}
	const pct = Math.min(100, Math.round((done / total) * 100));
	return (
		<div className="flex items-center gap-2" title={`${done}/${total} steps`}>
			<div className="h-1.5 w-20 overflow-hidden rounded-full bg-zinc-800">
				<div
					className="h-full rounded-full bg-emerald-500"
					style={{ width: `${pct}%` }}
				/>
			</div>
			<span className="text-xs text-zinc-400">{pct}%</span>
		</div>
	);
}

/** Run time for terminal jobs; elapsed (with a live indicator) for active. */
function JobDuration({ job }: { job: JobListItem }) {
	const { t } = useT();
	const active = isActiveJobStatus(job.status);
	if (active) {
		return (
			<span className="inline-flex items-center gap-1.5 text-emerald-400">
				<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
				{t("ui.running")}
			</span>
		);
	}
	// finishedAt is stamped in the orchestrator's persist funnel (#116) and is
	// the FINISH time; updatedAt is merely the last write, which a late VMAF
	// verdict or snapshot backfill moves ( — the step-log comment
	// documents a real sighting). The fallback covers pre-migration rows the
	// backfill approximated with updatedAt — for those the two are equal, so
	// the fallback never re-introduces the inflation.
	return (
		<span>
			{formatDuration(job.createdAt, job.finishedAt ?? job.updatedAt)}
		</span>
	);
}
