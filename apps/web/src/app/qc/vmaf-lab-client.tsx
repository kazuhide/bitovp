"use client";

import { DEFAULT_VMAF_MODEL } from "@bitovp/core";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { VMAF_MODELS } from "@/app/vod/new/wizard-sections";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldRowAction } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import {
	type BulkDeleteResult,
	bulkSummary,
	MAX_BULK_IDS,
} from "@/lib/bulk-ops";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import { CloudProgress } from "./cloud-progress";
import { VmafScoreLegend } from "./vmaf-score-legend";
import {
	fmtScore,
	isActiveVmafStatus,
	shortJobId,
	VMAF_STATUS_TONE,
	type VmafComputeProfileSummary,
	type VmafJobListItem,
} from "./vmaf-shared";

/** Max reports overlaid at once (mirrors the compare page's id guard). */
const MAX_COMPARE = 6;

type Page = { items: VmafJobListItem[]; nextCursor?: string };

/**
 * VMAF Lab index: every frame-level VMAF report (our own libvmaf pipeline —
 * Bitmovin has no VMAF API). Lists the encoding-job link, model, status and a
 * per-rendition mean-VMAF summary; each row links to its detail. Polls while
 * any report is PENDING/RUNNING (the worker fills results asynchronously).
 */
export function VmafLabClient() {
	const { t } = useT();
	const queryClient = useQueryClient();
	const router = useRouter();
	const jobs = useInfiniteQuery({
		queryKey: ["vmaf-jobs"],
		queryFn: ({ pageParam }) =>
			apiFetch<Page>(
				pageParam
					? `/api/vmaf-jobs?cursor=${encodeURIComponent(pageParam)}`
					: "/api/vmaf-jobs",
			),
		initialPageParam: "",
		getNextPageParam: (last: Page) => last.nextCursor ?? null,
		refetchInterval: (query) =>
			query.state.data?.pages[0]?.items.some(
				(j) => j.status === "PENDING" || j.status === "RUNNING",
			)
				? 10_000
				: 60_000,
	});
	const items = jobs.data?.pages.flatMap((p) => p.items) ?? [];

	// ONE selection set drives both bulk actions. Selectable = TERMINAL
	// (FINISHED|ERROR) via the shared `isActiveVmafStatus`, which is exactly the
	// bulk-delete route's guard; comparison additionally needs results, so it uses
	// the FINISHED subset. The set is pruned to currently-loaded selectable rows,
	// so a deleted/paged-out id can never linger in a count.
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const selectableIds = useMemo(
		() =>
			new Set(
				items.filter((j) => !isActiveVmafStatus(j.status)).map((j) => j.id),
			),
		[items],
	);
	const selectedIds = useMemo(
		() => [...selected].filter((id) => selectableIds.has(id)),
		[selected, selectableIds],
	);
	// Only FINISHED reports carry frame results to overlay.
	const comparableIds = useMemo(() => {
		const finished = new Set(
			items.filter((j) => j.status === "FINISHED").map((j) => j.id),
		);
		return selectedIds.filter((id) => finished.has(id));
	}, [items, selectedIds]);
	const overCompareCap = comparableIds.length > MAX_COMPARE;

	function toggleSelect(id: string) {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}

	function toggleAll(on: boolean) {
		setSelected(on ? new Set(selectableIds) : new Set());
	}

	function compareSelected() {
		if (comparableIds.length >= 2 && !overCompareCap) {
			router.push(`/qc/compare?jobs=${comparableIds.join(",")}`);
		}
	}

	// Per-row delete (terminal-only — disabled for PENDING/RUNNING, mirroring the
	// route's 409 guard). Removes the report + its frame results; refetch on done.
	const remove = useMutation({
		mutationFn: (id: string) =>
			apiFetch(`/api/vmaf-jobs/${id}`, { method: "DELETE" }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vmaf-jobs"] }),
	});

	// Bulk delete: the same shared pipeline per id, partial-failure isolated.
	const bulkDelete = useMutation({
		mutationFn: (ids: string[]) =>
			apiFetch<BulkDeleteResult>("/api/vmaf-jobs/bulk-delete", {
				method: "POST",
				body: JSON.stringify({ ids }),
			}),
		onSuccess: (result) => {
			setSelected(new Set(result.skipped.map((item) => item.id)));
			queryClient.invalidateQueries({ queryKey: ["vmaf-jobs"] });
		},
	});

	return (
		<section>
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 className="font-semibold text-xl text-zinc-50">
						{t("qc.title")}
					</h1>
				</div>
				{/* : measure an EXISTING finished job from here. */}
				<div className="flex shrink-0 flex-wrap items-center gap-2">
					{selectedIds.length > 0 ? (
						<span className="text-xs text-zinc-500">
							{t("uiX.selectedCount", { count: selectedIds.length })}
						</span>
					) : null}
					{bulkDelete.data ? (
						<span className="text-xs text-zinc-500">
							{bulkSummary(
								bulkDelete.data.deleted.length,
								bulkDelete.data.skipped.length,
								"deleted",
							)}
						</span>
					) : null}
					<Button
						size="sm"
						disabled={comparableIds.length < 2 || overCompareCap}
						title={
							overCompareCap
								? t("uiX.upToNReportsCompared", { max: MAX_COMPARE })
								: comparableIds.length < 2
									? t("qc.needTwoFinished")
									: undefined
						}
						onClick={compareSelected}
					>
						{t("qc.compareSelected")}
					</Button>
					<RoleAccess control="qc.jobs">
						<DeleteResourceButton
							resourceLabel={t("uiX.selectedReportsCount", {
								count: selectedIds.length,
							})}
							disabled={
								selectedIds.length === 0 || selectedIds.length > MAX_BULK_IDS
							}
							disabledReason={
								selectedIds.length === 0
									? t("qc.needOneTerminal")
									: t("uiX.upToNReportsPerBulk", { max: MAX_BULK_IDS })
							}
							confirmTitle={t(
								selectedIds.length === 1
									? "uiX.deleteNReportsOne"
									: "uiX.deleteNReportsOther",
								{ count: selectedIds.length },
							)}
							confirmDescription={t("qc.deleteConfirmMany")}
							pending={bulkDelete.isPending}
							onConfirm={() => bulkDelete.mutate(selectedIds)}
						/>
					</RoleAccess>
				</div>
			</header>

			{comparableIds.length < 2 || overCompareCap ? (
				<p className="mt-2 text-xs text-zinc-500">
					{overCompareCap
						? t("uiX.upToNReportsCompared", { max: MAX_COMPARE })
						: t("qc.needTwoFinished")}
				</p>
			) : null}
			<RoleAccess control="qc.jobs">
				<MeasureExistingSection />
			</RoleAccess>
			<VmafScoreLegend className="mt-4" />

			{remove.isError ? (
				<p role="alert" className="mt-3 text-red-400 text-sm">
					{remove.error instanceof ApiError
						? remove.error.message
						: t("qc.deleteFailed")}
				</p>
			) : null}
			{bulkDelete.isError ? (
				<p role="alert" className="mt-3 text-red-400 text-sm">
					{bulkDelete.error instanceof ApiError
						? bulkDelete.error.message
						: t("qc.bulkDeleteFailed")}
				</p>
			) : null}

			{bulkDelete.data?.skipped.length ? (
				<ul role="alert" className="mt-3 text-xs text-amber-400">
					{bulkDelete.data.skipped.map((item) => (
						<li key={item.id}>
							{items.find((job) => job.id === item.id)?.encodingName ??
								shortJobId(item.id)}
							: {item.reason}
						</li>
					))}
				</ul>
			) : null}
			{jobs.isError ? (
				<p role="alert" className="mt-6 text-red-400 text-sm">
					{t("qc.loadFailed")}{" "}
					<Button
						size="sm"
						variant="secondary"
						disabled={jobs.isFetching}
						onClick={() =>
							jobs.isFetchNextPageError ? jobs.fetchNextPage() : jobs.refetch()
						}
					>
						{t("common.retry")}
					</Button>
				</p>
			) : null}
			{!jobs.isError || jobs.data ? (
				<div className="mt-6 overflow-x-auto rounded-lg border border-zinc-800">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-zinc-800 border-b text-left text-xs text-zinc-500">
								<th className="w-8 px-3 py-2 font-medium">
									<input
										type="checkbox"
										aria-label={t("qc.selectAllLoaded")}
										className="size-3.5 accent-emerald-500"
										checked={
											selectableIds.size > 0 &&
											selectedIds.length === selectableIds.size
										}
										disabled={selectableIds.size === 0}
										onChange={(e) => toggleAll(e.target.checked)}
									/>
								</th>
								<th className="px-3 py-2 font-medium">{t("qc.report")}</th>
								<th className="px-3 py-2 font-medium">{t("qc.mode")}</th>
								<th className="px-3 py-2 font-medium">{t("qc.model")}</th>
								<th className="px-3 py-2 font-medium">{t("common.status")}</th>
								<th className="px-3 py-2 font-medium">
									{t("qc.meanPerRendition")}
								</th>
								<th className="px-3 py-2 font-medium">{t("common.created")}</th>
								<th className="px-3 py-2 text-right font-medium">
									{t("common.actions")}
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800/70">
							{items.map((job) => {
								// The human label for this report: the encoding name when we
								// have it (LIVE jobs / older rows fall back to the short id).
								// Used for the row link, the compare checkbox and the delete
								// button so they all name the report the same way.
								const label = job.encodingName ?? shortJobId(job.id);
								return (
									<tr key={job.id} className="hover:bg-zinc-900/40">
										<td className="px-3 py-2 align-top">
											{isActiveVmafStatus(job.status) ? (
												<input
													type="checkbox"
													disabled
													className="mt-0.5 size-3.5 cursor-not-allowed opacity-30"
													aria-label={t("uiX.selectReportUnavailable", {
														label,
														status: job.status.toLowerCase(),
													})}
													title={t("qc.waitToSelect")}
												/>
											) : (
												<input
													type="checkbox"
													className="mt-0.5 size-3.5 cursor-pointer accent-emerald-500"
													checked={selected.has(job.id)}
													onChange={() => toggleSelect(job.id)}
													aria-label={t("uiX.selectReport", { label })}
													title={
														job.status === "FINISHED"
															? undefined
															: t("qc.erroredNotComparable")
													}
												/>
											)}
										</td>
										<td className="px-3 py-2">
											<Link
												href={`/qc/${job.id}`}
												title={t("uiX.reportShortId", {
													id: shortJobId(job.id),
												})}
												className="block max-w-[18rem] truncate font-medium text-xs text-zinc-200 hover:text-emerald-400"
											>
												{job.encodingName ?? shortJobId(job.id)}
											</Link>
											<span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-zinc-500">
												<span className="font-mono">{job.model}</span>
												<span aria-hidden="true">·</span>
												<span>{formatDateTime(job.createdAt)}</span>
											</span>
											{job.encodingJobId ? (
												<Link
													href={`/vod/jobs/${job.encodingJobId}`}
													className="mt-0.5 block max-w-[18rem] truncate text-[11px] text-zinc-500 hover:text-emerald-400"
												>
													{job.encodingName ??
														`job ${shortJobId(job.encodingJobId)}`}
												</Link>
											) : null}
											{/* max-w matches the sibling link above: an
											    unbounded cell-mate restores the cell's
											    intrinsic width and the 18rem cap on the
											    first link stops mattering (UI loop
											    2026-08-21, found twice independently). */}
											{job.error ? (
												<p
													title={job.error}
													className="mt-0.5 max-w-[18rem] truncate text-red-400 text-xs"
												>
													{job.error}
												</p>
											) : null}
										</td>
										<td className="px-3 py-2 text-xs text-zinc-400">
											{job.mode}
										</td>
										<td className="px-3 py-2 font-mono text-xs text-zinc-400">
											{job.model}
										</td>
										<td className="px-3 py-2">
											<Badge tone={VMAF_STATUS_TONE[job.status]}>
												{job.status}
											</Badge>
											{job.computeTasks?.length ? (
												<CloudProgress
													tasks={job.computeTasks}
													active={isActiveVmafStatus(job.status)}
												/>
											) : null}
										</td>
										<td className="px-3 py-2">
											{job.renditionMeans.length > 0 ? (
												<div className="flex flex-wrap gap-x-3 gap-y-0.5">
													{job.renditionMeans.map((r) => (
														<span
															key={r.label}
															className="whitespace-nowrap text-xs"
														>
															<span className="text-zinc-500">{r.label}</span>{" "}
															<span className="font-medium text-zinc-300">
																{fmtScore(r.mean)}
															</span>
														</span>
													))}
												</div>
											) : (
												<span className="text-xs text-zinc-600">
													{isActiveVmafStatus(job.status)
														? t("qc.pendingScore")
														: "—"}
												</span>
											)}
										</td>
										<td className="px-3 py-2 text-xs text-zinc-400">
											{formatDateTime(job.createdAt)}
										</td>
										<td className="px-3 py-2 text-right">
											<RoleAccess control="qc.jobs">
												<DeleteResourceButton
													resourceLabel={t("qc.reportResourceLabel", { label })}
													disabled={isActiveVmafStatus(job.status)}
													disabledReason={t(
														"ui.waitForTheReportToFinishBefore",
													)}
													confirmTitle={t("ui.deleteThisVmafReport")}
													confirmDescription={t("qc.deleteConfirmOne")}
													pending={
														remove.isPending && remove.variables === job.id
													}
													onConfirm={() => remove.mutate(job.id)}
												/>
											</RoleAccess>
										</td>
									</tr>
								);
							})}
							{jobs.isLoading ? (
								<tr>
									<td
										colSpan={8}
										role="status"
										className="px-3 py-10 text-center text-zinc-500"
									>
										{t("common.loading")}
									</td>
								</tr>
							) : null}
							{!jobs.isLoading && !jobs.isError && items.length === 0 ? (
								<tr>
									<td
										colSpan={8}
										className="px-3 py-10 text-center text-sm text-zinc-500"
									>
										{t("empty.noVmafReports")}
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
									: t("qc.loadMore")}
							</Button>
						</div>
					) : null}
				</div>
			) : null}
		</section>
	);
}

/** Measure a finished job using its QC mirror or existing fixed MP4 outputs.
 * The API resolves the source without changing the historical encoding plan.
 */
function MeasureExistingSection() {
	const { t } = useT();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [encodingJobId, setEncodingJobId] = useState("");
	const [model, setModel] = useState<string>(DEFAULT_VMAF_MODEL);
	const [profileId, setProfileId] = useState("");
	const [budgetUsd, setBudgetUsd] = useState("");
	const [source, setSource] = useState<"" | "QC_MIRROR" | "OUTPUT_MP4">("");
	const [psnr, setPsnr] = useState<"" | "true" | "false">("");
	const [measurementMethod, setMeasurementMethod] = useState<
		"" | "FRAME_INDEX_BT709_10BIT"
	>("");
	const frameIndexAvailable = profileId !== "" && source === "OUTPUT_MP4";
	const profiles = useQuery({
		queryKey: ["vmaf-compute-profiles"],
		queryFn: () =>
			apiFetch<{ items: VmafComputeProfileSummary[] }>(
				"/api/vmaf-compute-profiles",
			),
		enabled: open,
	});
	const cloudProfile = profiles.data?.items.find((p) => p.id === profileId);
	const cloudBudget = Number(budgetUsd);
	const invalidCloud =
		profileId !== "" &&
		(!cloudProfile ||
			profiles.isError ||
			!Number.isFinite(cloudBudget) ||
			cloudBudget <= 0 ||
			cloudBudget > 100000);
	const finished = useInfiniteQuery({
		queryKey: ["encoding-jobs", "finished-for-lab"],
		queryFn: ({ pageParam }) =>
			apiFetch<{ items: { id: string; name: string }[]; nextCursor?: string }>(
				`/api/encoding-jobs?status=FINISHED${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
			),
		initialPageParam: "",
		getNextPageParam: (last) => last.nextCursor ?? null,
		enabled: open,
	});
	const finishedItems =
		finished.data?.pages.flatMap((page) => page.items) ?? [];
	const selectedJobExists = finishedItems.some(
		(job) => job.id === encodingJobId,
	);
	const missingJob = encodingJobId !== "" && !selectedJobExists;
	const missingProfile = profileId !== "" && !cloudProfile;
	const measure = useMutation({
		mutationFn: () =>
			apiFetch<{ id: string }>("/api/vmaf-jobs", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					encodingJobId,
					model,
					...(source ? { source } : {}),
					...(psnr !== "" ? { psnr: psnr === "true" } : {}),
					...(frameIndexAvailable && measurementMethod
						? { measurementMethod }
						: {}),
					execution:
						profileId === ""
							? { backend: "LOCAL" }
							: { backend: "CLOUD", profileId, budgetUsd: cloudBudget },
				}),
			}),
		onSuccess: () => {
			setEncodingJobId("");
			queryClient.invalidateQueries({ queryKey: ["vmaf-jobs"] });
		},
	});
	return (
		<div className="mt-4">
			<Button
				variant="secondary"
				size="sm"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				{t("qc.measureExisting")}
			</Button>
			{open ? (
				<div className="mt-3 flex flex-wrap items-start gap-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-4">
					<div className="w-full sm:w-auto sm:min-w-64">
						<Field label={t("qc.measureJob")} htmlFor="lab-measure-job">
							<SelectNative
								id="lab-measure-job"
								value={missingJob ? "" : encodingJobId}
								disabled={finished.isPending || measure.isPending}
								onChange={(e) => {
									setEncodingJobId(e.target.value);
									measure.reset();
								}}
							>
								<option value="">{t("common.select")}</option>
								{finishedItems.map((j: { id: string; name: string }) => (
									<option key={j.id} value={j.id}>
										{j.name}
									</option>
								))}
							</SelectNative>
						</Field>
						{finished.isPending ? (
							<p role="status" className="mt-1 text-xs text-zinc-500">
								{t("common.loading")}
							</p>
						) : null}
						{finished.isError ? (
							<div role="alert" className="mt-1 text-xs text-red-400">
								{t("qc.measureJobsLoadFailed")}{" "}
								<Button
									size="sm"
									variant="secondary"
									disabled={finished.isFetching}
									onClick={() =>
										finished.isFetchNextPageError
											? finished.fetchNextPage()
											: finished.refetch()
									}
								>
									{t("common.retry")}
								</Button>
							</div>
						) : null}
						{!finished.isPending &&
						!finished.isError &&
						finishedItems.length === 0 ? (
							<p className="mt-1 text-xs text-zinc-500">
								{t("qc.measureJobsEmpty")}
							</p>
						) : null}
						{missingJob ? (
							<p role="alert" className="mt-1 text-xs text-amber-400">
								{t("qc.measureSelectionMissing")}
							</p>
						) : null}
						{finished.hasNextPage && !finished.isFetchNextPageError ? (
							<Button
								size="sm"
								variant="secondary"
								disabled={finished.isFetchingNextPage}
								onClick={() => finished.fetchNextPage()}
							>
								{finished.isFetchingNextPage
									? t("common.loading")
									: t("qc.loadMore")}
							</Button>
						) : null}
					</div>
					<div className="w-56">
						<Field label={t("qc.measureModel")} htmlFor="lab-measure-model">
							<SelectNative
								id="lab-measure-model"
								value={model}
								disabled={measure.isPending}
								onChange={(e) => setModel(e.target.value)}
							>
								{VMAF_MODELS.map((m) => (
									<option key={m} value={m}>
										{m}
									</option>
								))}
							</SelectNative>
						</Field>
					</div>
					<div className="w-full sm:w-64">
						<Field
							label={t("qc.executionTarget")}
							htmlFor="lab-measure-execution"
						>
							<SelectNative
								id="lab-measure-execution"
								value={profileId}
								disabled={measure.isPending}
								onChange={(e) => {
									setProfileId(e.target.value);
									if (e.target.value === "") setMeasurementMethod("");
									setBudgetUsd("");
								}}
							>
								<option value="">{t("qc.executionLocal")}</option>
								{missingProfile ? (
									<option value={profileId} disabled>
										{t("qc.measureProfileMissing")}
									</option>
								) : null}
								{(profiles.data?.items ?? []).map((p) => (
									<option key={p.id} value={p.id}>
										{p.label} · {p.region}
									</option>
								))}
							</SelectNative>
						</Field>
						{missingProfile ? (
							<p role="alert" className="mt-1 text-xs text-amber-400">
								{t("qc.measureProfileMissing")}
							</p>
						) : null}
						{profiles.isPending ? (
							<p className="mt-1 text-xs text-zinc-500">
								{t("common.loading")}
							</p>
						) : profiles.isError ? (
							<p role="status" className="mt-1 text-xs text-zinc-500">
								{t("qc.executionProfilesUnavailable")}{" "}
								<Button
									size="sm"
									variant="secondary"
									disabled={profiles.isFetching}
									onClick={() => profiles.refetch()}
								>
									{t("common.retry")}
								</Button>
							</p>
						) : !profiles.data?.items.length ? (
							<p className="mt-1 text-xs text-zinc-500">
								{t("qc.executionLocalOnly")}
							</p>
						) : null}
					</div>
					{profileId !== "" ? (
						<div className="w-full sm:w-44">
							<Field
								label={t("qc.executionBudget")}
								htmlFor="lab-measure-budget"
							>
								<Input
									id="lab-measure-budget"
									type="number"
									min="0.01"
									max="100000"
									step="0.01"
									required
									value={budgetUsd}
									disabled={measure.isPending}
									onChange={(e) => setBudgetUsd(e.target.value)}
									aria-describedby="lab-measure-budget-hint"
								/>
							</Field>
						</div>
					) : null}
					<FieldRowAction>
						<Button
							size="sm"
							disabled={
								!selectedJobExists ||
								finished.isError ||
								measure.isPending ||
								invalidCloud
							}
							onClick={() => measure.mutate()}
						>
							{measure.isPending ? t("common.saving") : t("qc.measureRun")}
						</Button>
					</FieldRowAction>
					<details className="w-full border-zinc-800 border-t pt-3">
						<summary className="cursor-pointer text-sm text-zinc-300">
							{t("qc.measureAdvanced")}
						</summary>
						<div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
							<Field
								label={t("qc.measureSource")}
								htmlFor="lab-measure-source"
								help={t("qc.measureSourceHint")}
							>
								<SelectNative
									id="lab-measure-source"
									value={source}
									disabled={measure.isPending}
									onChange={(e) => {
										const next = e.target.value as typeof source;
										setSource(next);
										if (next !== "OUTPUT_MP4") setMeasurementMethod("");
									}}
								>
									<option value="">{t("qc.measureSourceAuto")}</option>
									<option value="QC_MIRROR">
										{t("qc.measureSourceMirror")}
									</option>
									<option value="OUTPUT_MP4">{t("qc.measureSourceMp4")}</option>
								</SelectNative>
							</Field>
							<Field label={t("qc.measurePsnr")} htmlFor="lab-measure-psnr">
								<SelectNative
									id="lab-measure-psnr"
									value={psnr}
									disabled={measure.isPending}
									onChange={(e) => setPsnr(e.target.value as typeof psnr)}
								>
									<option value="">{t("qc.measurePsnrInherit")}</option>
									<option value="true">{t("qc.measurePsnrOn")}</option>
									<option value="false">{t("qc.measurePsnrOff")}</option>
								</SelectNative>
							</Field>
							{frameIndexAvailable ? (
								<Field
									label={t("qc.measureMethod")}
									htmlFor="lab-measure-method"
								>
									<SelectNative
										id="lab-measure-method"
										value={measurementMethod}
										disabled={measure.isPending}
										onChange={(e) =>
											setMeasurementMethod(
												e.target.value as typeof measurementMethod,
											)
										}
									>
										<option value="">{t("qc.measureMethodDefault")}</option>
										<option value="FRAME_INDEX_BT709_10BIT">
											{t("qc.measureMethodFrameIndex")}
										</option>
									</SelectNative>
								</Field>
							) : null}
						</div>
						<p className="mt-2 text-xs text-zinc-500">
							{t("qc.measureMethodHint")}
						</p>
					</details>
					{encodingJobId === "" &&
					!finished.isPending &&
					!finished.isError &&
					finishedItems.length > 0 ? (
						<p className="w-full text-xs text-zinc-500">
							{t("qc.measureSelectJob")}
						</p>
					) : null}
					{profileId !== "" ? (
						<p
							id="lab-measure-budget-hint"
							className="w-full text-xs text-zinc-500"
						>
							{t("qc.executionBudgetHint")}
						</p>
					) : null}
					{measure.data ? (
						<p role="status" className="w-full text-xs">
							<Link
								href={`/qc/${measure.data.id}`}
								className="text-emerald-400 underline"
							>
								{t("qc.measureCreated")}
							</Link>
						</p>
					) : null}
					{measure.isError ? (
						<p role="alert" className="w-full text-red-400 text-xs">
							{measure.error instanceof ApiError
								? measure.error.message
								: String(measure.error)}
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}
