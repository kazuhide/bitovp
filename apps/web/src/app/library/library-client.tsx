"use client";

import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, List } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import { type LibraryCatalog, MAX_LIBRARY_OFFSET } from "@/lib/library-catalog";
import type { LibrarySceneResults as SceneResults } from "@/lib/library-scenes";
import { LibraryCatalogResults } from "./library-catalog-results";
import { LibrarySceneResults } from "./library-scene-results";
import {
	type LibraryBrowseState,
	type LibraryView,
	libraryBrowseSearch,
	readLibraryBrowseState,
	readLibraryViewPreference,
	saveLibraryViewPreference,
} from "./library-view-preference";
import { SceneSearchControls } from "./scene-search-controls";

const filters = [
	["all", "library.filterAll"],
	["playback", "library.filterPlayback"],
	["metadata", "library.filterMetadataOnly"],
] as const;
type Result = { scope: string; offset: number } & (
	| { mode: "content"; data: LibraryCatalog }
	| { mode: "scenes"; data: SceneResults }
);

export function LibraryClient({
	initialQuery = readLibraryBrowseState({}),
}: {
	initialQuery?: LibraryBrowseState;
}) {
	const { t } = useT();
	const [state, setState] = useState(initialQuery);
	const {
		q,
		archived,
		playback,
		offset,
		mode,
		match = "all",
		sort = "relevance",
		locale = "",
	} = state;
	const [debouncedQ, setDebouncedQ] = useState(q);
	const [view, setView] = useState<LibraryView>("grid");
	const [lastResult, setLastResult] = useState<Result>();
	useEffect(() => setView(readLibraryViewPreference()), []);
	useEffect(() => {
		const timer = setTimeout(() => setDebouncedQ(q), 300);
		return () => clearTimeout(timer);
	}, [q]);
	useEffect(() => {
		window.history.replaceState(
			window.history.state,
			"",
			`${window.location.pathname}${libraryBrowseSearch(state)}`,
		);
	}, [state]);
	useEffect(() => {
		const restore = () => {
			const next = readLibraryBrowseState(
				Object.fromEntries(new URLSearchParams(window.location.search)),
			);
			setState(next);
			setDebouncedQ(next.q);
		};
		window.addEventListener("popstate", restore);
		return () => window.removeEventListener("popstate", restore);
	}, []);
	const search = new URLSearchParams({
		q: debouncedQ,
		archived: String(archived),
		offset: String(offset),
	});
	if (mode === "content") search.set("playback", playback);
	else {
		search.set("match", match);
		search.set("sort", sort);
		if (locale) search.set("locale", locale);
	}
	const scope = `${mode}:${search}`;
	const emptySceneQuery = mode === "scenes" && q.trim() === "";
	const query = useQuery({
		queryKey:
			mode === "content"
				? ["library", mode, debouncedQ, archived, playback, offset]
				: ["library", mode, debouncedQ, archived, match, sort, locale, offset],
		enabled: q === debouncedQ && !emptySceneQuery,
		queryFn: async ({ signal }): Promise<Result> =>
			mode === "content"
				? {
						mode,
						scope,
						offset,
						data: await apiFetch<LibraryCatalog>(`/api/library?${search}`, {
							signal,
						}),
					}
				: {
						mode,
						scope,
						offset,
						data: await apiFetch<SceneResults>(
							`/api/library/scenes?${search}`,
							{ signal },
						),
					},
	});
	const sceneOptions = useQuery({
		queryKey: ["library-scene-options", archived],
		enabled: mode === "scenes",
		staleTime: 60_000,
		queryFn: ({ signal }) =>
			apiFetch<{ locales: string[] }>(
				`/api/library/scenes/options?archived=${archived}`,
				{ signal },
			),
	});
	useEffect(() => {
		if (query.data?.scope === scope && q === debouncedQ)
			setLastResult(query.data);
	}, [query.data, scope, q, debouncedQ]);
	const result = emptySceneQuery
		? undefined
		: q === debouncedQ && query.data
			? query.data
			: lastResult?.mode === mode
				? lastResult
				: undefined;
	const stale = q !== debouncedQ || result?.scope !== scope;
	const busy = !emptySceneQuery && (q !== debouncedQ || query.isFetching);
	const error = q === debouncedQ ? query.error : null;
	const filtered =
		q !== "" ||
		archived ||
		playback !== "all" ||
		(mode === "scenes" &&
			(match !== "all" || sort !== "relevance" || locale !== ""));
	const change = (next: Partial<LibraryBrowseState>) =>
		setState((previous) => ({ ...previous, ...next, offset: 0 }));
	const clear = () =>
		change({
			q: "",
			archived: false,
			playback: "all",
			match: "all",
			sort: "relevance",
			locale: "",
		});
	const chooseView = (next: LibraryView) => {
		setView(next);
		saveLibraryViewPreference(next);
	};
	return (
		<Tabs
			value={mode}
			onValueChange={(value) =>
				change({ mode: value === "scenes" ? "scenes" : "content" })
			}
			className="mx-auto max-w-7xl space-y-4"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h1 className="font-semibold text-2xl">{t("library.title")}</h1>
				<TabsList aria-label={t("library.title")}>
					<TabsTrigger value="content">{t("library.contentTab")}</TabsTrigger>
					<TabsTrigger value="scenes">{t("library.scenesTab")}</TabsTrigger>
				</TabsList>
			</div>
			<TabsContent value={mode} className="mt-0 space-y-4">
				<div className="flex flex-wrap items-center gap-3">
					<Input
						className="max-w-md"
						type="search"
						maxLength={200}
						aria-label={t(
							mode === "scenes" ? "library.sceneSearch" : "library.search",
						)}
						placeholder={t(
							mode === "scenes" ? "library.sceneSearch" : "library.search",
						)}
						value={q}
						onChange={(event) => change({ q: event.target.value })}
					/>
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={archived}
							onChange={(event) => change({ archived: event.target.checked })}
						/>
						{t("library.archived")}
					</label>
					{filtered && (
						<Button variant="ghost" size="sm" onClick={clear}>
							{t("library.clearFilters")}
						</Button>
					)}
				</div>
				{mode === "scenes" && (
					<SceneSearchControls
						match={match}
						sort={sort}
						locale={locale}
						locales={sceneOptions.data?.locales ?? []}
						loading={sceneOptions.isFetching}
						failed={sceneOptions.isError}
						onChange={change}
						onRetry={() => void sceneOptions.refetch()}
					/>
				)}
				{mode === "content" && (
					<div className="flex flex-wrap items-center gap-2">
						{filters.map(([value, key]) => (
							<Button
								key={value}
								variant={playback === value ? "secondary" : "ghost"}
								size="sm"
								aria-pressed={playback === value}
								onClick={() => change({ playback: value })}
							>
								{t(key)}
								{result?.mode === "content" && (
									<span className="ml-2 text-zinc-400 tabular-nums">
										{result.data.counts[value]}
									</span>
								)}
							</Button>
						))}
						<InfoHint
							text={t("library.playbackHelp")}
							labelFor={t("library.filterPlayback")}
						/>
						<div className="ml-auto flex gap-1">
							<Button
								variant={view === "grid" ? "secondary" : "ghost"}
								size="sm"
								aria-label={t("library.gridView")}
								aria-pressed={view === "grid"}
								onClick={() => chooseView("grid")}
							>
								<LayoutGrid className="size-4" aria-hidden="true" />
							</Button>
							<Button
								variant={view === "list" ? "secondary" : "ghost"}
								size="sm"
								aria-label={t("library.listView")}
								aria-pressed={view === "list"}
								onClick={() => chooseView("list")}
							>
								<List className="size-4" aria-hidden="true" />
							</Button>
						</div>
					</div>
				)}
				{emptySceneQuery ? (
					<p className="text-sm text-zinc-400">
						{t("library.sceneSearchHint")}
					</p>
				) : (
					<>
						{busy && (
							<p role="status" className="text-sm text-zinc-400">
								{t(result ? "library.updating" : "library.loading")}
							</p>
						)}
						{error && (
							<div role="alert" className="flex items-center gap-3 text-sm">
								<span>{error.message}</span>
								<Button
									variant="secondary"
									size="sm"
									disabled={busy}
									onClick={() => void query.refetch()}
								>
									{t("library.refresh")}
								</Button>
							</div>
						)}
						{result && (
							<>
								<p className="text-sm text-zinc-400" aria-live="polite">
									{t("library.range", {
										start: result.data.items.length ? result.offset + 1 : 0,
										end: result.data.items.length
											? result.offset + result.data.items.length
											: 0,
										count: result.data.total,
									})}
								</p>
								{result.data.items.length === 0 ? (
									<div className="space-y-3 rounded-md border border-zinc-800 p-6 text-sm">
										<p>
											{t(
												mode === "scenes"
													? "library.sceneSearchEmpty"
													: filtered
														? "library.emptyFiltered"
														: "library.empty",
											)}
										</p>
										{filtered && (
											<Button variant="secondary" size="sm" onClick={clear}>
												{t("library.clearFilters")}
											</Button>
										)}
									</div>
								) : result.mode === "content" ? (
									<LibraryCatalogResults
										items={result.data.items}
										view={view}
									/>
								) : (
									<LibrarySceneResults items={result.data.items} />
								)}
								<div className="flex gap-2">
									<Button
										variant="secondary"
										disabled={
											busy || stale || Boolean(query.error) || offset === 0
										}
										onClick={() =>
											setState((previous) => ({
												...previous,
												offset: Math.max(0, offset - 25),
											}))
										}
									>
										{t("library.previous")}
									</Button>
									<Button
										variant="secondary"
										disabled={
											busy ||
											stale ||
											Boolean(query.error) ||
											offset + 25 > MAX_LIBRARY_OFFSET ||
											offset + 25 >= result.data.total
										}
										onClick={() =>
											setState((previous) => ({
												...previous,
												offset: offset + 25,
											}))
										}
									>
										{t("library.next")}
									</Button>
								</div>
							</>
						)}
					</>
				)}
			</TabsContent>
		</Tabs>
	);
}
