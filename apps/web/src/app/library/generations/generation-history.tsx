"use client";

import { MEDIA_TASK_STATES } from "@bitovp/core";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useDocumentOrganization } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import { MAX_LIBRARY_OFFSET } from "@/lib/library-catalog";
import {
	GENERATION_HISTORY_PAGE_SIZE,
	GENERATION_HISTORY_PERIODS,
	type GenerationHistoryFilters,
	generationHistoryFilters,
	generationHistorySchema,
	generationHistorySearch,
	readGenerationHistoryFilters,
} from "@/lib/library-generation-history";
import {
	browserLibraryBrowseLocation,
	type LibraryBrowseLocation,
} from "../library-view-preference";

const labels = {
	en: {
		title: "Generation history",
		search: "Content title",
		status: "Status",
		period: "Updated",
		allStates: "All statuses",
		allDates: "Any time",
		dates: { day: "Last 24 hours", week: "Last 7 days", month: "Last 30 days" },
		states: {
			PENDING: "Queued",
			RUNNING: "Running",
			SUCCEEDED: "Completed",
			ERROR: "Failed",
			CANCELED: "Canceled",
		},
		refresh: "Refresh",
		loading: "Loading generation history…",
		error: "Could not load generation history.",
		empty: "No generation jobs found.",
		missingTitle: "Source title unavailable",
		progress: "View progress",
		details: "View job",
		result: "View export",
		draft: "Open draft",
		previous: "Previous",
		next: "Next",
	},
	ja: {
		title: "生成履歴",
		search: "素材名",
		status: "状態",
		period: "更新日時",
		allStates: "すべての状態",
		allDates: "すべての期間",
		dates: { day: "過去24時間", week: "過去7日間", month: "過去30日間" },
		states: {
			PENDING: "待機中",
			RUNNING: "処理中",
			SUCCEEDED: "完了",
			ERROR: "失敗",
			CANCELED: "キャンセル済み",
		},
		refresh: "更新",
		loading: "生成履歴を読み込み中…",
		error: "生成履歴を取得できませんでした。",
		empty: "該当する生成ジョブはありません。",
		missingTitle: "素材名を取得できません",
		progress: "進捗を見る",
		details: "ジョブを見る",
		result: "書き出し結果を見る",
		draft: "編集案を開く",
		previous: "前へ",
		next: "次へ",
	},
};
const inProgress = (state: string) =>
	state === "PENDING" || state === "RUNNING";
const stateTone = {
	PENDING: "neutral",
	RUNNING: "neutral",
	SUCCEEDED: "ok",
	ERROR: "error",
	CANCELED: "neutral",
} as const;
const selectClass =
	"h-9 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100 focus-visible:outline-2 focus-visible:outline-emerald-500";
const linkClass =
	"rounded-sm font-medium text-sm text-emerald-400 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2";

export function GenerationHistory({
	initialFilters,
	clipEditingAvailable,
	browseLocation = browserLibraryBrowseLocation,
}: {
	initialFilters: GenerationHistoryFilters;
	clipEditingAvailable: boolean;
	browseLocation?: LibraryBrowseLocation;
}) {
	const { locale, t } = useT();
	const organizationId = useDocumentOrganization();
	const copy = labels[locale];
	const date = new Intl.DateTimeFormat(locale, {
		dateStyle: "medium",
		timeStyle: "short",
	});
	const [filters, setFilters] = useState(initialFilters);
	const [debouncedQ, setDebouncedQ] = useState(filters.q);
	const pendingSearch = debouncedQ !== filters.q;
	useEffect(() => {
		const timer = setTimeout(() => setDebouncedQ(filters.q), 300);
		return () => clearTimeout(timer);
	}, [filters.q]);
	useEffect(() => {
		const restore = () => {
			const location = browseLocation();
			if (!location) return;
			const next = readGenerationHistoryFilters(
				Object.fromEntries(new URLSearchParams(location.search)),
			);
			setFilters(next);
			setDebouncedQ(next.q);
		};
		restore();
		window.addEventListener("popstate", restore);
		return () => window.removeEventListener("popstate", restore);
	}, [browseLocation]);

	const search = new URLSearchParams({ view: "history" });
	for (const [key, value] of generationHistorySearch({
		...filters,
		q: debouncedQ,
	}))
		search.set(key, value);
	const query = useQuery({
		queryKey: ["library-generation-history", organizationId, search.toString()],
		enabled: !pendingSearch,
		refetchOnMount: "always",
		queryFn: async ({ signal }) =>
			generationHistorySchema.parse(
				await apiFetch(`/api/library/media-tasks?${search}`, { signal }),
			),
		refetchInterval: ({ state }) =>
			state.data?.items.some((task) => inProgress(task.state)) ? 3000 : false,
		refetchIntervalInBackground: false,
	});
	const data = pendingSearch ? undefined : query.data;
	const loading = pendingSearch || query.isPending;
	const update = (patch: Partial<GenerationHistoryFilters>) => {
		const next = { ...filters, offset: 0, ...patch };
		const search = generationHistorySearch(next).toString();
		const location = browseLocation();
		if (!location) return;
		const url = `${location.pathname}${search ? `?${search}` : ""}`;
		// Update Next's canonical URL on filter changes. On remount the browser's
		// history entry can be newer than the saved server component props.
		if (url !== location.pathname + location.search)
			location.replaceUrl(url, null);
		setFilters(next);
	};
	return (
		<div className="mx-auto max-w-7xl space-y-5">
			<header className="space-y-2">
				<Link
					href="/library"
					className={`inline-flex items-center gap-2 ${linkClass}`}
				>
					<ArrowLeft aria-hidden="true" className="size-4" />
					{t("library.title")}
				</Link>
				<h1 className="font-semibold text-2xl">{copy.title}</h1>
			</header>
			<div className="flex flex-wrap items-end gap-3">
				<label
					htmlFor="generation-history-content-title"
					className="min-w-36 max-w-md flex-1 space-y-1 text-sm"
				>
					<span>{copy.search}</span>
					<Input
						id="generation-history-content-title"
						type="search"
						maxLength={200}
						value={filters.q}
						onChange={(event) => update({ q: event.target.value })}
					/>
				</label>
				<label className="space-y-1 text-sm">
					<span>{copy.status}</span>
					<select
						className={selectClass}
						value={filters.state}
						onChange={(event) =>
							update({
								state: generationHistoryFilters.shape.state.parse(
									event.target.value,
								),
							})
						}
					>
						<option value="">{copy.allStates}</option>
						{MEDIA_TASK_STATES.map((state) => (
							<option key={state} value={state}>
								{copy.states[state]}
							</option>
						))}
					</select>
				</label>
				<label className="space-y-1 text-sm">
					<span>{copy.period}</span>
					<select
						className={selectClass}
						value={filters.period}
						onChange={(event) =>
							update({
								period: generationHistoryFilters.shape.period.parse(
									event.target.value,
								),
							})
						}
					>
						<option value="">{copy.allDates}</option>
						{GENERATION_HISTORY_PERIODS.map((period) => (
							<option key={period} value={period}>
								{copy.dates[period]}
							</option>
						))}
					</select>
				</label>
				<Button
					variant="secondary"
					disabled={pendingSearch || query.isFetching}
					onClick={() => void query.refetch()}
				>
					<RefreshCw aria-hidden="true" className="size-4" />
					{copy.refresh}
				</Button>
			</div>
			{loading && (
				<p role="status" className="text-sm text-zinc-400">
					{copy.loading}
				</p>
			)}
			{!pendingSearch && query.isError && (
				<p role="alert" className="text-sm text-red-400">
					{copy.error}
				</p>
			)}
			{data?.items.length === 0 && !query.isError && (
				<p className="text-sm text-zinc-400">{copy.empty}</p>
			)}
			{data && data.items.length > 0 && (
				<ul
					className="divide-y divide-zinc-800 rounded-lg border border-zinc-800"
					aria-label={copy.title}
				>
					{data.items.map((task) => (
						<li className="space-y-3 px-4 py-3" key={task.taskId}>
							<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
								<h2 className="min-w-0 flex-1 break-words font-medium">
									{task.contentTitle ?? copy.missingTitle}
								</h2>
								<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
									<Badge tone={stateTone[task.state]}>
										{copy.states[task.state]}
									</Badge>
									<time
										className="text-xs text-zinc-400 tabular-nums"
										dateTime={task.updatedAt}
									>
										{date.format(new Date(task.updatedAt))}
									</time>
									<Link
										className={linkClass}
										href={`/library/generations/${task.taskId}?view=details`}
										prefetch={false}
									>
										{inProgress(task.state) ? copy.progress : copy.details}
									</Link>
								</div>
							</div>
							{task.clips.length > 0 && (
								<ul className="space-y-2">
									{task.clips.map((clip) => (
										<li
											key={clip.projectId}
											className="min-w-0 break-words text-sm text-zinc-300"
										>
											{clip.exportId ? (
												<Link
													className={linkClass}
													href={`/library/edits/${clip.projectId}/result?exportId=${clip.exportId}`}
													prefetch={false}
												>
													{copy.result} · {clip.title}
												</Link>
											) : clipEditingAvailable ? (
												<Link
													className={linkClass}
													href={`/library/edits/${clip.projectId}`}
													prefetch={false}
												>
													{copy.draft} · {clip.title}
												</Link>
											) : (
												clip.title
											)}
										</li>
									))}
								</ul>
							)}
						</li>
					))}
				</ul>
			)}
			{(filters.offset > 0 || data?.hasMore) && (
				<div className="flex justify-end gap-2">
					<Button
						variant="secondary"
						onClick={() =>
							update({
								offset: Math.max(
									0,
									filters.offset - GENERATION_HISTORY_PAGE_SIZE,
								),
							})
						}
						disabled={filters.offset === 0 || loading}
					>
						{copy.previous}
					</Button>
					<Button
						variant="secondary"
						onClick={() =>
							update({ offset: filters.offset + GENERATION_HISTORY_PAGE_SIZE })
						}
						disabled={
							!data?.hasMore ||
							filters.offset + GENERATION_HISTORY_PAGE_SIZE > MAX_LIBRARY_OFFSET
						}
					>
						{copy.next}
					</Button>
				</div>
			)}
		</div>
	);
}
