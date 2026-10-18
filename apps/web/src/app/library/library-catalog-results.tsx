"use client";

import { FileText } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n/context";
import type { LibraryCatalogItem } from "@/lib/library-catalog";
import { CatalogThumbnail } from "./catalog-thumbnail";
import { type LibraryView, libraryTimeLabel } from "./library-view-preference";

export function LibraryCatalogResults({
	items,
	view,
}: {
	items: LibraryCatalogItem[];
	view: LibraryView;
}) {
	const { t } = useT();
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
			{assets.map((item) => (
				<li
					key={item.id}
					className={
						grid
							? "min-w-0 overflow-hidden rounded-lg border border-zinc-800"
							: undefined
					}
				>
					<Link
						href={`/library/${encodeURIComponent(item.id)}`}
						className={`group ${grid ? "block h-full" : "flex items-start gap-4 p-3"} bg-zinc-950 transition-colors hover:bg-zinc-900/60 focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2`}
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
				</li>
			))}
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
