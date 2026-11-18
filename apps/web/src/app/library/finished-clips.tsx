"use client";

import { useQuery } from "@tanstack/react-query";
import { Film, Play } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useDocumentOrganization } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import type { EditingProjectPage } from "@/lib/library-editing";
import {
	boundExportLinks,
	ClipExportVideo,
	exportPoster,
} from "./clip-export-video";

const copy = {
	ja: {
		title: "制作済みの映像",
		clip: "クリップ",
		highlight: "ハイライト",
		trailer: "予告編",
		preview: "{title} を試写",
		error: "制作済みの映像を読み込めませんでした。",
		empty: "制作済みの映像はまだありません。",
	},
	en: {
		title: "Finished clips",
		clip: "Clip",
		highlight: "Highlight",
		trailer: "Trailer",
		preview: "Preview {title}",
		error: "Finished clips could not be loaded.",
		empty: "No finished clips yet.",
	},
} as const;

export function FinishedClips({ contentId }: { contentId: string }) {
	const organizationId = useDocumentOrganization();
	return organizationId ? (
		<FinishedClipShelf
			key={`${organizationId}:${contentId}`}
			contentId={contentId}
			organizationId={organizationId}
		/>
	) : null;
}

function FinishedClipShelf({
	contentId,
	organizationId,
}: {
	contentId: string;
	organizationId: string;
}) {
	const { t, locale } = useT();
	const labels = copy[locale];
	const headingId = useId();
	const shelf = useRef<HTMLElement>(null);
	useEffect(() => {
		// Content arrives after navigation, when the initial fragment scroll may be over.
		if (window.location.hash === "#finished-clips") {
			shelf.current?.scrollIntoView?.({ block: "nearest" });
		}
	}, []);
	const [offset, setOffset] = useState(0);
	const [selectedId, setSelectedId] = useState<string>();
	const [posters, setPosters] = useState<ReadonlyMap<string, string>>(
		new Map(),
	);
	const query = useQuery({
		queryKey: [
			"library-edit-projects",
			contentId,
			"exports",
			organizationId,
			offset,
		],
		queryFn: ({ signal }) =>
			apiFetch<EditingProjectPage>(
				`/api/library/edits?${new URLSearchParams({ contentId, offset: String(offset), scope: "exports" })}`,
				{ signal },
			),
		refetchOnMount: "always",
	});
	const items = (query.data?.items ?? []).flatMap((project) => {
		const run = project.latestSuccessfulExport;
		return run ? [{ project, run }] : [];
	});
	const selected = query.isError
		? undefined
		: items.find(({ run }) => run.id === selectedId);
	const selectedLinks = selected
		? boundExportLinks(selected.run.artifact, organizationId)
		: null;

	return (
		<aside
			ref={shelf}
			id="finished-clips"
			aria-labelledby={headingId}
			className="min-w-0 space-y-3 border-zinc-800 border-t pt-4 xl:w-1/4 xl:min-w-60 xl:max-w-96 xl:shrink-0 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-4"
		>
			<h2 id={headingId} className="font-semibold text-sm">
				{labels.title}
			</h2>
			{query.isPending && (
				<p role="status" className="text-sm text-zinc-400">
					{t("editing.loading")}
				</p>
			)}
			{query.isError && (
				<div role="alert" className="space-y-2 text-sm text-zinc-400">
					<p>{labels.error}</p>
					<Button
						size="sm"
						variant="secondary"
						disabled={query.isFetching}
						onClick={() => void query.refetch()}
					>
						{t("editing.refresh")}
					</Button>
				</div>
			)}
			{query.isSuccess && (
				<>
					{query.data.total === 0 && (
						<p className="text-sm text-zinc-400">{labels.empty}</p>
					)}
					{items.length > 0 && (
						<ul className="flex snap-x gap-2 overflow-x-auto px-1 pb-2">
							{items.map(({ project, run }) => {
								const versionId = `${headingId}-${run.id}`;
								const earlier =
									run.id !== project.latestExport?.id ||
									!run.matchesCurrentDraft;
								const purpose =
									run.purpose === "TRAILER"
										? labels.trailer
										: run.purpose === "HIGHLIGHT"
											? labels.highlight
											: labels.clip;
								const poster = posters.get(run.artifact.id);
								return (
									<li key={run.id} className="w-40 shrink-0 snap-start">
										<button
											type="button"
											aria-label={labels.preview.replace(
												"{title}",
												project.title,
											)}
											aria-describedby={
												earlier
													? `${versionId}-type ${versionId}-earlier`
													: `${versionId}-type`
											}
											aria-pressed={selectedId === run.id}
											className="block min-w-0 w-full space-y-1 rounded-md border border-zinc-800 p-2 text-left hover:bg-zinc-900 focus-visible:outline-2 focus-visible:outline-emerald-500 aria-pressed:border-emerald-500"
											onClick={() => setSelectedId(run.id)}
										>
											<span className="relative flex aspect-video items-center justify-center overflow-hidden rounded bg-zinc-900 text-zinc-500">
												{poster ? (
													<Image
														src={poster}
														alt=""
														width={192}
														height={108}
														unoptimized
														className="h-full w-full object-contain"
													/>
												) : (
													<Film className="size-5" aria-hidden="true" />
												)}
												<Play
													className="absolute right-2 bottom-2 size-4 text-white"
													aria-hidden="true"
												/>
											</span>
											<span className="block break-words font-medium text-sm [overflow-wrap:anywhere]">
												{project.title}
											</span>
											<span
												id={`${versionId}-type`}
												className="block text-xs text-zinc-400"
											>
												{purpose}
												{run.durationFrames !== null &&
													` · ${(run.durationFrames / 30).toFixed(1)}s`}
											</span>
											{earlier && (
												<span
													id={`${versionId}-earlier`}
													className="block text-xs text-zinc-400"
												>
													{t("editing.earlierExport")}
												</span>
											)}
										</button>
									</li>
								);
							})}
						</ul>
					)}
					{(offset > 0 || query.data.total > 25) && (
						<nav aria-label={labels.title} className="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="secondary"
								disabled={offset === 0 || query.isFetching}
								onClick={() => setOffset(Math.max(0, offset - 25))}
							>
								{t("library.previous")}
							</Button>
							<Button
								size="sm"
								variant="secondary"
								disabled={
									offset + 25 >= query.data.total ||
									offset >= 10_000 ||
									query.isFetching
								}
								onClick={() => setOffset(offset + 25)}
							>
								{t("library.next")}
							</Button>
						</nav>
					)}
				</>
			)}
			{selected && (
				<div className="space-y-2 border-zinc-800 border-t pt-3">
					<h3 className="break-words font-medium text-sm">
						{selected.project.title}
					</h3>
					{selectedLinks ? (
						<ClipExportVideo
							key={selected.run.artifact.id}
							src={selectedLinks.media}
							title={selected.project.title}
							autoPlay
							onFrame={(video) => {
								const artifactId = selected.run.artifact.id;
								if (posters.has(artifactId)) return;
								const still = exportPoster(video);
								if (still)
									setPosters((previous) => {
										const entries = [...previous, [artifactId, still] as const];
										return new Map(entries.slice(-25));
									});
							}}
						/>
					) : (
						<p role="alert" className="text-sm text-amber-300">
							{t("editing.autoPortrait.videoError")}
						</p>
					)}
					<Link
						href={`/library/edits/${selected.project.id}/result?exportId=${selected.run.id}`}
						className="text-emerald-400 text-sm underline underline-offset-4"
					>
						{t("editing.watchExport")}
					</Link>
				</div>
			)}
		</aside>
	);
}
