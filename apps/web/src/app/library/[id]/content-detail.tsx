"use client";
import type { ContentDetail, PlayerClientConfig } from "@bitovp/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import type { LibrarySceneSelection } from "@/lib/library-scenes";
import { ContentClipPanel } from "../content-clip-panel";
import { SourcePanel } from "../source-panel";
import { sourcePollingInterval } from "../source-polling";

type ContentDetailProps = {
	id: string;
	player?: PlayerClientConfig;
	initialScene?: LibrarySceneSelection;
	clipEditingAvailable?: boolean;
};

export function ContentDetailClient(props: ContentDetailProps) {
	return (
		<ContentDetailView
			key={`${props.id}:${JSON.stringify(props.initialScene ?? null)}`}
			{...props}
		/>
	);
}

function ContentDetailView({
	id,
	player,
	initialScene,
	clipEditingAvailable = false,
}: ContentDetailProps) {
	const { t } = useT();
	const query = useQuery({
		queryKey: ["library", id, initialScene ?? null],
		queryFn: () => apiFetch<ContentDetail>(`/api/library/${id}`),
		refetchOnMount: "always",
		refetchInterval: (query) =>
			sourcePollingInterval(query.state.data?.source.state),
	});
	const freshSelectionRead =
		query.isFetchedAfterMount && query.isSuccess && !query.isFetching;
	const content = query.data;
	const pinnedAnalysis = content?.source.analyses.find(
		(analysis) =>
			analysis.id === initialScene?.analysisRevisionId &&
			analysis.locale === initialScene?.locale,
	);
	const pinnedScene = pinnedAnalysis?.document.scenes.find(
		(scene) => scene.id === initialScene?.sceneId,
	);
	const validSelection =
		freshSelectionRead &&
		initialScene &&
		content?.revision === initialScene.contentRevision &&
		content.locale === initialScene.locale &&
		content.archived === initialScene.archived &&
		pinnedScene &&
		Number.isFinite(pinnedScene.startInSeconds) &&
		pinnedScene.endInSeconds > pinnedScene.startInSeconds
			? initialScene
			: undefined;
	const pendingAnalysis =
		content &&
		!pinnedAnalysis &&
		(content.source.state === "PENDING" ||
			content.source.state === "RUNNING") &&
		content.revision === initialScene?.contentRevision &&
		content.locale === initialScene?.locale &&
		content.archived === initialScene?.archived;
	return (
		<div className="mx-auto max-w-screen-2xl space-y-4">
			<Link href="/library" className="text-emerald-400 text-sm underline">
				← {t("library.title")}
			</Link>
			{(query.isPending ||
				(initialScene && !freshSelectionRead && query.isFetching)) && (
				<p role="status">{t("library.loading")}</p>
			)}
			{query.error && (
				<div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
					<span>{query.error.message}</span>
					<Button
						variant="secondary"
						size="sm"
						disabled={query.isFetching}
						onClick={() => void query.refetch()}
					>
						{t("library.refresh")}
					</Button>
				</div>
			)}
			{query.data && (
				<>
					{query.data.parent && (
						<p className="min-w-0 break-words text-sm text-zinc-400">
							{t("editing.originalContent")}:{" "}
							<Link
								href={`/library/${query.data.parent.contentId}`}
								className="rounded text-emerald-400 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-emerald-500"
							>
								{query.data.parent.title}
							</Link>
							{clipEditingAvailable && (
								<>
									{" · "}
									<Link
										href={`/library/edits/${query.data.parent.projectId}`}
										className="rounded text-emerald-400 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-emerald-500"
									>
										{t("editing.open")}
									</Link>
								</>
							)}
						</p>
					)}
					<header className="flex flex-wrap items-start justify-between gap-3">
						<div className="min-w-0 flex-1 space-y-2">
							<h1 className="break-words font-semibold text-2xl">
								{query.data.title}
							</h1>
							{query.data.description && (
								<p className="max-w-3xl whitespace-pre-wrap text-sm text-zinc-400">
									{query.data.description}
								</p>
							)}
							{query.data.tags.length > 0 && (
								<p className="text-xs text-zinc-400">
									{query.data.tags.join(" · ")}
								</p>
							)}
							{query.data.archived && (
								<p className="text-sm text-amber-300">
									{t("library.archived")}
								</p>
							)}
						</div>
						{clipEditingAvailable &&
							(!query.data.parent ? (
								<ContentClipPanel contentId={id} clipEditingAvailable />
							) : (
								<Link
									href={`/library/${id}/edits`}
									className="inline-flex h-9 items-center rounded-md border border-zinc-700 bg-zinc-900 px-4 font-medium text-sm text-zinc-200 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-emerald-500"
								>
									{t("editing.open")}
								</Link>
							))}
					</header>
					{freshSelectionRead &&
						initialScene &&
						!validSelection &&
						!pendingAnalysis && (
							<p role="status" className="text-sm text-amber-300">
								{t("library.sceneLinkChanged")}
							</p>
						)}
					<SourcePanel
						key={`${id}:${query.data.source.id}:${initialScene ? JSON.stringify(initialScene) : ""}`}
						source={query.data.source}
						initialLocale={query.data.locale}
						initialScene={validSelection}
						player={player}
					/>
				</>
			)}
		</div>
	);
}
