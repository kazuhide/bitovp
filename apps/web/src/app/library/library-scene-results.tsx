"use client";

import { FileText } from "lucide-react";
import Link from "next/link";
import { useT } from "@/lib/i18n/context";
import { type LibrarySceneHit, librarySceneHref } from "@/lib/library-scenes";
import { CatalogThumbnail } from "./catalog-thumbnail";
import { libraryTimeLabel } from "./library-view-preference";

export function LibrarySceneResults({ items }: { items: LibrarySceneHit[] }) {
	const { t } = useT();
	return (
		<ul className="divide-y divide-zinc-800 overflow-hidden rounded-md border border-zinc-800">
			{items.map((hit) => (
				<li
					key={`${hit.contentId}:${hit.contentRevision}:${hit.analysisRevisionId}:${hit.locale}:${hit.sceneId}`}
				>
					<Link
						href={librarySceneHref(hit)}
						className="group flex items-start gap-4 bg-zinc-950 p-3 transition-colors hover:bg-zinc-900/60 focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2"
					>
						{hit.catalogPreview ? (
							<div className="w-28 shrink-0 overflow-hidden rounded sm:w-40">
								<CatalogThumbnail
									compact
									source={{
										...hit.catalogPreview,
										cacheKey: `${hit.contentId}:${hit.contentRevision}:${hit.analysisRevisionId}:${hit.sceneId}`,
									}}
									fallback={t("library.thumbnailUnavailable")}
								/>
							</div>
						) : (
							<FileText
								className="mt-1 size-5 shrink-0 text-zinc-500"
								aria-hidden="true"
							/>
						)}
						<div className="min-w-0 flex-1 space-y-1">
							<h2 className="break-words font-medium text-sm text-zinc-100 group-hover:text-emerald-400">
								{hit.title.trim() ||
									`${t("library.scenes")} · ${libraryTimeLabel(hit.startInSeconds)}`}
							</h2>
							<p className="line-clamp-2 break-words text-sm text-zinc-400">
								{hit.summary}
							</p>
							<div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-400">
								<span className="tabular-nums">
									{libraryTimeLabel(hit.startInSeconds)}–
									{libraryTimeLabel(hit.endInSeconds)}
								</span>
								<span className="break-words">{hit.contentTitle}</span>
								<span>{hit.locale}</span>
								{hit.relevance && (
									<span className="tabular-nums">
										{t("library.sceneRelevance", {
											score: hit.relevance.score.toFixed(1),
										})}
									</span>
								)}
							</div>
						</div>
					</Link>
				</li>
			))}
		</ul>
	);
}
