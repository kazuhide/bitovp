"use client";

import type { SceneAnalysisDocument } from "@bitovp/core";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";

const pageSize = 20;

export function SceneNavigator({
	scenes,
	currentSceneId,
	children,
}: {
	scenes: SceneAnalysisDocument["scenes"];
	currentSceneId?: string;
	children: (
		visible: SceneAnalysisDocument["scenes"],
		offset: number,
	) => ReactNode;
}) {
	const { t } = useT();
	const [search, setSearch] = useState("");
	const [page, setPage] = useState(0);
	const matches = useMemo(
		() =>
			scenes.filter((scene) =>
				`${scene.title} ${scene.summary} ${scene.keywords.join(" ")}`
					.toLocaleLowerCase()
					.includes(search.trim().toLocaleLowerCase()),
			),
		[scenes, search],
	);
	const activeIndex = matches.findIndex((scene) => scene.id === currentSceneId);
	const activePage = activeIndex < 0 ? -1 : Math.floor(activeIndex / pageSize);
	useEffect(() => {
		if (activePage >= 0) setPage(activePage);
	}, [activePage]);
	const pages = Math.max(1, Math.ceil(matches.length / pageSize));
	const visiblePage = Math.min(page, pages - 1);
	const offset = visiblePage * pageSize;
	return (
		<div className="min-w-0 space-y-3">
			<div className="flex items-center gap-2">
				<Input
					type="search"
					aria-label={t("library.searchScenes")}
					placeholder={t("library.searchScenes")}
					value={search}
					onChange={(event) => {
						setSearch(event.target.value);
						setPage(0);
					}}
				/>
				<InfoHint
					text={t("library.sceneNavigationHelp")}
					labelFor={t("library.scenes")}
				/>
			</div>
			{matches.length ? (
				children(matches.slice(offset, offset + pageSize), offset)
			) : (
				<p className="text-sm text-zinc-400">
					{t(search ? "library.noSceneMatches" : "library.noScenes")}
				</p>
			)}
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-xs text-zinc-400" aria-live="polite">
					{t("library.scenePage", {
						page: visiblePage + 1,
						pages,
						count: matches.length,
					})}
				</p>
				<div className="flex gap-2">
					<Button
						variant="secondary"
						size="sm"
						disabled={visiblePage === 0}
						onClick={() => setPage(visiblePage - 1)}
					>
						{t("library.previous")}
					</Button>
					<Button
						variant="secondary"
						size="sm"
						disabled={visiblePage + 1 >= pages}
						onClick={() => setPage(visiblePage + 1)}
					>
						{t("library.next")}
					</Button>
				</div>
			</div>
		</div>
	);
}
