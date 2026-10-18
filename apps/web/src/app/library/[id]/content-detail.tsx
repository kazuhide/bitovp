"use client";
import type { ContentDetail, PlayerClientConfig } from "@bitovp/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import type { LibrarySceneSelection } from "@/lib/library-scenes";
import { SourcePanel } from "../source-panel";
import { sourcePollingInterval } from "../source-polling";

type ContentDetailProps = {
	id: string;
	player?: PlayerClientConfig;
	initialScene?: LibrarySceneSelection;
};

export function ContentDetailClient(props: ContentDetailProps) {
	return (
		<ContentDetailView
			key={`${props.id}:${JSON.stringify(props.initialScene ?? null)}`}
			{...props}
		/>
	);
}

function ContentDetailView({ id, player, initialScene }: ContentDetailProps) {
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
