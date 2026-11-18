"use client";

import { FileText } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n/context";
import type { LibraryCatalogItem } from "@/lib/library-catalog";
import { CatalogThumbnail } from "./catalog-thumbnail";
import { ContentRemovalAction } from "./content-removal-action";
import { type LibraryView, libraryTimeLabel } from "./library-view-preference";

const clipCounts = {
	en: {
		exported: (count: number) =>
			`${count} ${count === 1 ? "clip" : "clips"} exported`,
		drafts: (count: number) =>
			`${count} clip ${count === 1 ? "draft" : "drafts"}`,
		unavailable: "Export count unavailable",
	},
	ja: {
		exported: (count: number) => `書き出し済み ${count}件`,
		drafts: (count: number) => `クリップ案 ${count}件`,
		unavailable: "書き出し件数を取得できません",
	},
};

export function LibraryCatalogResults({
	items,
	view,
	onContentChanged,
}: {
	items: LibraryCatalogItem[];
	view: LibraryView;
	clipEditingAvailable?: boolean;
	onContentChanged?: () => void;
}) {
	const { locale, t } = useT();
	const copy = clipCounts[locale];
	const playback = items.filter(
		(item) => item.catalogMetadata.formats.length > 0,
	);
	const metadata = items.filter(
		(item) => item.catalogMetadata.formats.length === 0,
	);
	const rows = (assets: LibraryCatalogItem[], grid: boolean) => (
		<ul
			aria-label={t(
				grid || assets === playback
					? "library.filterPlayback"
					: "library.filterMetadataOnly",
			)}
			className={
				grid
					? "grid grid-cols-1 gap-4 @min-[536px]:grid-cols-2 @min-[812px]:grid-cols-3"
					: "divide-y divide-zinc-800 overflow-hidden rounded-md border border-zinc-800"
			}
		>
			{assets.map((item) => {
				const { clipProjectCount, clipExportCount, singleClipExport } = item;
				const draftCount =
					clipProjectCount !== undefined && clipExportCount !== undefined
						? clipProjectCount - clipExportCount
						: 0;
				const href = `/library/${encodeURIComponent(item.id)}`;
				const exportHref =
					clipExportCount === 1 && singleClipExport
						? `/library/edits/${encodeURIComponent(singleClipExport.projectId)}/result?exportId=${encodeURIComponent(singleClipExport.exportId)}`
						: `${href}#finished-clips`;
				return (
					<li
						key={item.id}
						className={
							grid
								? "flex min-w-0 flex-col overflow-hidden rounded-lg border border-zinc-800"
								: "flex min-w-0 items-start"
						}
					>
						<Link
							href={href}
							className={`group min-w-0 flex-1 ${grid ? "block" : "flex items-start gap-4 p-3"} bg-zinc-950 transition-colors hover:bg-zinc-900/60 focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2`}
						>
							{item.catalogMetadata.formats.length > 0 ? (
								<div
									className={
										grid
											? "overflow-hidden"
											: "mt-0.5 w-24 shrink-0 overflow-hidden rounded"
									}
								>
									<CatalogThumbnail
										compact={!grid}
										source={
											item.catalogPreview
												? {
														...item.catalogPreview,
														cacheKey: `${item.id}:${item.revision}`,
													}
												: undefined
										}
										fallback={t("library.thumbnailUnavailable")}
									/>
								</div>
							) : (
								<FileText
									className="mt-1 size-5 shrink-0 text-zinc-500"
									aria-hidden="true"
								/>
							)}
							<div className={`min-w-0 flex-1 space-y-2 ${grid ? "p-3" : ""}`}>
								<h2
									title={item.title}
									className="break-words font-medium text-sm text-zinc-100 group-hover:text-emerald-400"
								>
									{item.title}
								</h2>
								{item.description && (
									<p className="line-clamp-2 break-words text-xs leading-5 text-zinc-400">
										{item.description}
									</p>
								)}
								<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
									{item.catalogMetadata.formats.length ? (
										item.catalogMetadata.formats.map((kind) => (
											<Badge key={kind}>{kind}</Badge>
										))
									) : (
										<span>{t("library.noPlaybackMetadata")}</span>
									)}
									{item.locale !== "und" && <span>{item.locale}</span>}
									{draftCount > 0 && <span>{copy.drafts(draftCount)}</span>}
									{item.catalogMetadata.sceneCount !== undefined && (
										<span>
											{t("library.sceneCount", {
												count: item.catalogMetadata.sceneCount,
											})}
										</span>
									)}
									{item.catalogMetadata.duration !== undefined && (
										<span className="tabular-nums">
											{libraryTimeLabel(item.catalogMetadata.duration)}
										</span>
									)}
									{item.tags.length > 0 && (
										<span className="break-words text-zinc-500">
											{item.tags.slice(0, 3).join(" · ")}
										</span>
									)}
								</div>
							</div>
						</Link>
						<div
							className={`flex max-w-full flex-wrap items-center gap-2 px-3 py-2 text-xs text-zinc-400 ${grid ? "justify-between" : "justify-end"}`}
						>
							{clipExportCount !== undefined && clipExportCount > 0 ? (
								<Link
									className="rounded-sm font-medium text-emerald-400 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2"
									href={exportHref}
									prefetch={false}
								>
									{copy.exported(clipExportCount)}
								</Link>
							) : (
								<span>
									{clipExportCount === undefined
										? copy.unavailable
										: copy.exported(clipExportCount)}
								</span>
							)}
							<ContentRemovalAction
								content={item}
								onChanged={onContentChanged}
								className="ml-auto"
							/>
						</div>
					</li>
				);
			})}
		</ul>
	);
	return (
		<div className="@container space-y-4">
			{playback.length > 0 && rows(playback, view === "grid")}
			{metadata.length > 0 && (
				<section
					className="space-y-2"
					aria-label={t("library.filterMetadataOnly")}
				>
					{playback.length > 0 && (
						<h2 className="font-medium text-sm text-zinc-400">
							{t("library.filterMetadataOnly")}
						</h2>
					)}
					{rows(metadata, false)}
				</section>
			)}
		</div>
	);
}
