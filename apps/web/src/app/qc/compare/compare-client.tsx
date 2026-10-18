"use client";

import { useQueries, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import { VmafScoreLegend } from "../vmaf-score-legend";
import {
	comparedModels,
	comparedSubsamples,
	fmtScore,
	jobShortLabel,
	mixesModels,
	mixesScoringGenerations,
	mixesSubsampling,
	renditionLabel,
	scoringGenerations,
	seriesColor,
	shortJobId,
	type VmafJobDetail,
	type VmafResultDetail,
} from "../vmaf-shared";
import { CompareFrameChart } from "./compare-frame-chart";
import { CompareLadderChart } from "./compare-ladder-chart";

/** Bounds for the comparison overlay — keep it readable, keep the URL sane. */
const MIN_JOBS = 2;
const MAX_JOBS = 6;
/** Cap the series that start toggled-on so a huge selection isn't a wall. */
const DEFAULT_SELECTED_CAP = 24;

/**
 * One (job × rendition) overlay series: a stable key, a human label (job short
 * label + rendition), its colour, the downsampled frames and the pooled mean.
 * `jobIndex`/`jobLabel` group the ladder curves (one curve per job).
 */
export type CompareSeries = {
	key: string;
	jobId: string;
	jobIndex: number;
	jobLabel: string;
	label: string;
	color: string;
	mean: number;
	result: VmafResultDetail;
};

/** Parse, dedupe and bound the `jobs` query param (comma-separated ids). */
function parseJobIds(raw: string | null): string[] {
	if (!raw) {
		return [];
	}
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const part of raw.split(",")) {
		const id = part.trim();
		if (id && !seen.has(id)) {
			seen.add(id);
			ids.push(id);
		}
	}
	return ids.slice(0, MAX_JOBS);
}

/**
 * VMAF report comparison client. Reads the `jobs` ids from the URL, fans out
 * one detail fetch per id (client-side — reusing the same per-id GET and its
 * cache as the detail page), flattens every (job × rendition) result into a
 * colour-keyed series list, and overlays them on a per-frame line chart and a
 * one-curve-per-job quality ladder. A series selector toggles each line on/off
 * in both charts. One job failing (404 / error) is noted and skipped; the rest
 * still render.
 */
export function CompareClient() {
	const { t } = useT();
	const queryClient = useQueryClient();
	const params = useSearchParams();
	const jobIds = useMemo(() => parseJobIds(params.get("jobs")), [params]);

	// One query per id — same key/fn/cache as /qc/[id], so a report already
	// viewed is served from cache. `combine` collapses the result array into the
	// bits the view needs and yields a STABLE object reference (per render of the
	// same data), so downstream memos don't churn on every render.
	// Only fan out once there are enough ids to actually compare — below the
	// minimum we render the guard, so fetching would be wasted work.
	const enabled = jobIds.length >= MIN_JOBS;
	const { loadedJobs, failedIds, loading, fetching } = useQueries({
		queries: jobIds.map((id) => ({
			queryKey: ["vmaf-job", id],
			queryFn: () => apiFetch<VmafJobDetail>(`/api/vmaf-jobs/${id}`),
			staleTime: 30_000,
			enabled,
		})),
		combine: (results) => {
			const jobs: VmafJobDetail[] = [];
			const failed: string[] = [];
			results.forEach((q, i) => {
				const id = jobIds[i] as string;
				if (q.data) {
					jobs.push(q.data);
				}
				if (q.isError) {
					failed.push(id);
				}
			});
			return {
				loadedJobs: jobs,
				failedIds: failed,
				loading: results.some((q) => q.isLoading),
				fetching: results.some((q) => q.isFetching),
			};
		},
	});

	// Flatten (job × rendition) → series with a stable key + distinct colour.
	// Colour index runs across the whole flattened list so no two series share a
	// hue (until the palette wraps); the job index colours the ladder curves.
	const series = useMemo<CompareSeries[]>(() => {
		// jobShortLabel prefers the encoding name — but comparing re-runs of the
		// SAME encoding is a real use case, so when two loaded jobs resolve to the
		// same label, disambiguate each with its short id (a re-run is otherwise
		// indistinguishable in the legend). Names that are already unique stay clean.
		// When the loaded set mixes models, every label carries its model: the warning
		// above names the set, and without this nothing said WHICH report used which —
		// `encodingName` is always present for a VOD job, so the model appeared nowhere
		// per series (review finding).
		const showModel = mixesModels(loadedJobs);
		const labelCounts = new Map<string, number>();
		for (const job of loadedJobs) {
			const base = jobShortLabel(job, showModel);
			labelCounts.set(base, (labelCounts.get(base) ?? 0) + 1);
		}
		const out: CompareSeries[] = [];
		let colorIdx = 0;
		loadedJobs.forEach((job, jobIndex) => {
			const base = jobShortLabel(job, showModel);
			const jobLabel =
				(labelCounts.get(base) ?? 0) > 1
					? `${base} · ${shortJobId(job.id)}`
					: base;
			job.results.forEach((result, rIdx) => {
				out.push({
					key: `${job.id}:${result.id}`,
					jobId: job.id,
					jobIndex,
					jobLabel,
					label: `${jobLabel} · ${renditionLabel(result.renditionRef, rIdx, t("common.renditionNumbered", { n: rIdx + 1 }))}`,
					color: seriesColor(colorIdx++),
					mean: result.pooled.mean,
					result,
				});
			});
		});
		return out;
	}, [loadedJobs, t]);

	// Which series are toggled on. `null` until the user first interacts, so the
	// default (first DEFAULT_SELECTED_CAP series on — capped so a giant selection
	// doesn't paint a wall of lines) is derived from whatever series are loaded.
	// Once the user toggles anything, `selected` becomes the source of truth.
	const scope = jobIds.join(",");
	const [selection, setSelection] = useState<{
		scope: string;
		ids: Set<string>;
	} | null>(null);
	const selected = selection?.scope === scope ? selection.ids : null;
	function setSelected(ids: Set<string>) {
		setSelection({ scope, ids });
	}
	function retryFailed() {
		for (const id of failedIds)
			void queryClient.refetchQueries({
				queryKey: ["vmaf-job", id],
				exact: true,
			});
	}
	const effectiveSelected = useMemo(() => {
		if (selected) {
			return new Set(
				series.filter((item) => selected.has(item.key)).map((item) => item.key),
			);
		}
		return new Set(series.slice(0, DEFAULT_SELECTED_CAP).map((s) => s.key));
	}, [series, selected]);

	const shownSeries = series.filter((s) => effectiveSelected.has(s.key));

	function toggleSeries(key: string) {
		const base = new Set(effectiveSelected);
		if (base.has(key)) {
			base.delete(key);
		} else {
			base.add(key);
		}
		setSelected(base);
	}

	function setAll(on: boolean) {
		setSelected(new Set(on ? series.map((s) => s.key) : []));
	}

	// --- Guard: need at least two valid ids to compare. ---------------------
	if (jobIds.length < MIN_JOBS) {
		return (
			<GuardMessage>
				{t("uiX.pickTwoReportsHead")}{" "}
				<Link href="/qc" className="text-emerald-400 hover:underline">
					{t("ui.vmafLab")}
				</Link>
				{/* The tail names a BUTTON, so it takes that button's own label — hard-coding
				    "Compare selected" pointed Japanese users at text no screen shows. */}
				{t("uiX.pickTwoReportsTail", { label: t("qc.compareSelected") })}
			</GuardMessage>
		);
	}

	if (loading && loadedJobs.length === 0) {
		return (
			<section>
				<CompareHeader jobCount={jobIds.length} seriesCount={0} />
				<div
					role="status"
					aria-label={t("qc.loadingReports")}
					className="mt-6 space-y-2"
				>
					{jobIds.map((id) => (
						<div
							key={id}
							className="h-16 animate-pulse rounded-md bg-zinc-900"
						/>
					))}
				</div>
			</section>
		);
	}

	// Every requested id failed to load (all 404 / errored).
	if (loadedJobs.length === 0) {
		return (
			<GuardMessage>
				{t("prose.noReportsLoaded")}
				<Button
					size="sm"
					variant="secondary"
					disabled={fetching}
					onClick={retryFailed}
				>
					{t("common.retry")}
				</Button>
				{failedIds.length > 0 ? (
					<>
						{" "}
						(
						<span className="font-mono">
							{failedIds.map(shortJobId).join(", ")}
						</span>
						)
					</>
				) : null}
				{/*  (UX-02e): the sentence end and the "deleted" line come
				    from the catalogue — an English ". They may have been deleted."
				    used to sit here as a bare text node, inside the Japanese page.
				    No JSX spacer: the EN value carries its own spaces, the JA
				    value none. */}
				{t("common.sentenceEnd")}
				{t("qc.mayHaveBeenDeleted")}
				<Link href="/qc" className="text-emerald-400 hover:underline">
					{t("qc.backToLab")}
				</Link>
				{t("common.sentenceEnd")}
			</GuardMessage>
		);
	}

	const skippedIds = failedIds.filter(
		(id) => !loadedJobs.some((job) => job.id === id),
	);
	const resultlessJobs = loadedJobs.filter((j) => j.results.length === 0);

	return (
		<section>
			<CompareHeader jobCount={loadedJobs.length} seriesCount={series.length} />
			<VmafScoreLegend className="mt-3" />

			{mixesScoringGenerations(loadedJobs) ? (
				<p role="alert" className="mt-3 text-amber-400 text-xs">
					{t("qc.mixedScoringGenerations", {
						generations: scoringGenerations(loadedJobs).join(", "),
					})}
				</p>
			) : null}
			{mixesModels(loadedJobs) ? (
				<p role="alert" className="mt-3 text-amber-400 text-xs">
					{t("qc.mixedModels", {
						models: comparedModels(loadedJobs).join(", "),
					})}
				</p>
			) : null}
			{mixesSubsampling(loadedJobs) ? (
				<p role="alert" className="mt-3 text-amber-400 text-xs">
					{t("qc.mixedSubsampling", {
						strides: comparedSubsamples(loadedJobs).join(", "),
					})}
				</p>
			) : null}
			{failedIds.length > 0 ? (
				<p role="alert" className="mt-3 text-amber-400 text-xs">
					{skippedIds.length
						? t(
								skippedIds.length === 1
									? "uiX.skippedReportsOne"
									: "uiX.skippedReportsOther",
								{ count: skippedIds.length },
							)
						: t("qc.loadFailed")}{" "}
					<span className="font-mono">
						{skippedIds.map(shortJobId).join(", ")}
					</span>
					{t("common.sentenceEnd")}
					<Button
						size="sm"
						variant="secondary"
						disabled={fetching}
						onClick={retryFailed}
					>
						{t("common.retry")}
					</Button>
				</p>
			) : null}
			{resultlessJobs.length > 0 ? (
				<p className="mt-1 text-xs text-zinc-500">
					{t("qc.resultlessReports", {
						count: resultlessJobs.length,
						ids: resultlessJobs.map((job) => jobShortLabel(job)).join(", "),
					})}
				</p>
			) : null}

			{series.length === 0 ? (
				<p className="mt-6 text-sm text-zinc-500">
					{t("qc.noRenditionsToCompare")}
				</p>
			) : (
				<>
					<SeriesLegend
						series={series}
						selected={effectiveSelected}
						onToggle={toggleSeries}
						onAll={setAll}
					/>

					<h2 className="mt-8 font-medium text-sm text-zinc-200">
						{t("qc.perFrame")}
						<span className="ml-2 font-normal text-xs text-zinc-500">
							{t("uiX.downsampledSeries", {
								shown: shownSeries.length,
								total: series.length,
							})}
						</span>
					</h2>
					<CompareFrameChart series={shownSeries} />

					<h2 className="mt-8 font-medium text-sm text-zinc-200">
						{t("qc.qualityLadder")}
						<span className="ml-2 font-normal text-xs text-zinc-500">
							{t("ui.meanVmafVsBitrateOneCurvePer")}
						</span>
					</h2>
					<CompareLadderChart series={shownSeries} />
				</>
			)}
		</section>
	);
}

/** Header: back link + counts of jobs/series being compared. */
function CompareHeader({
	jobCount,
	seriesCount,
}: {
	jobCount: number;
	seriesCount: number;
}) {
	const { t } = useT();
	return (
		<header className="flex flex-wrap items-center gap-3">
			<Link href="/qc" className="text-sm text-zinc-400 hover:text-emerald-400">
				{t("ui.vmafLab2")}
			</Link>
			<h1 className="font-semibold text-xl text-zinc-50">
				{t("qc.compareReports")}
			</h1>
			<span data-testid="compare-counts" className="text-xs text-zinc-500">
				{/* Localize both report and series counts. Catalogue-key parity cannot detect a hardcoded noun that never entered the catalogue. */}
				{t(jobCount === 1 ? "uiX.reportCountOne" : "uiX.reportCountOther", {
					count: jobCount,
				})}
				{seriesCount > 0 ? (
					<>
						{" · "}
						{t("uiX.seriesCount", { count: seriesCount })}
					</>
				) : null}
			</span>
		</header>
	);
}

/** A centred guard/empty message panel with a link back. */
function GuardMessage({ children }: { children: React.ReactNode }) {
	return (
		<section>
			<CompareHeader jobCount={0} seriesCount={0} />
			<div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-8 text-sm text-zinc-400">
				{children}
			</div>
		</section>
	);
}

/**
 * Legend + series selector + mean-VMAF table in one. Each row is a checkbox
 * (toggles the series in both charts), a colour swatch matching its line, the
 * series label and its mean VMAF (tinted by the quality threshold). "All" /
 * "None" bulk toggles sit at the top.
 */
function SeriesLegend({
	series,
	selected,
	onToggle,
	onAll,
}: {
	series: CompareSeries[];
	selected: Set<string>;
	onToggle: (key: string) => void;
	onAll: (on: boolean) => void;
}) {
	const { t } = useT();
	return (
		<div className="mt-6 rounded-lg border border-zinc-800">
			<div className="flex items-center justify-between border-zinc-800 border-b px-3 py-2">
				<span className="font-medium text-xs text-zinc-400">
					{t("uiX.seriesShown", {
						shown: selected.size,
						total: series.length,
					})}
				</span>
				<div className="flex items-center gap-2 text-xs">
					<button
						type="button"
						onClick={() => onAll(true)}
						className="text-zinc-400 hover:text-emerald-400"
					>
						{t("ui.all")}
					</button>
					<span className="text-zinc-700">·</span>
					<button
						type="button"
						onClick={() => onAll(false)}
						className="text-zinc-400 hover:text-emerald-400"
					>
						{t("ui.none")}
					</button>
				</div>
			</div>
			<ul className="grid grid-cols-1 gap-x-6 gap-y-1 p-3 sm:grid-cols-2 lg:grid-cols-3">
				{series.map((s) => {
					const on = selected.has(s.key);
					return (
						<li key={s.key}>
							<label className="flex cursor-pointer items-center gap-2 text-xs">
								<input
									type="checkbox"
									className="size-3.5 shrink-0 cursor-pointer accent-emerald-500"
									checked={on}
									onChange={() => onToggle(s.key)}
									aria-label={t("uiX.toggleSeries", { label: s.label })}
								/>
								<span
									aria-hidden="true"
									className="size-2.5 shrink-0 rounded-full"
									style={{
										background: s.color,
										opacity: on ? 1 : 0.3,
									}}
								/>
								<span
									className={`min-w-0 flex-1 truncate ${on ? "text-zinc-300" : "text-zinc-600"}`}
									title={`${s.jobLabel} · ${s.label}`}
								>
									{s.label}
								</span>
								<span
									className={`shrink-0 font-medium tabular-nums ${on ? "text-zinc-300" : "text-zinc-600"}`}
								>
									{fmtScore(s.mean)}
								</span>
							</label>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
