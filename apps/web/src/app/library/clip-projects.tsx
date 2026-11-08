"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import type {
	EditingProjectPage,
	EditingProjectSummary,
} from "@/lib/library-editing";
import { ClipThumbnail } from "./clip-thumbnail";

const linkClass =
	"rounded text-emerald-400 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-emerald-500";

export function ClipProjects({
	clipEditingAvailable = false,
	...props
}: {
	contentId: string;
	showCreate?: boolean;
	showHeading?: boolean;
	clipEditingAvailable?: boolean;
}) {
	return clipEditingAvailable ? <AvailableClipProjects {...props} /> : null;
}

function AvailableClipProjects({
	contentId,
	showCreate = true,
	showHeading = true,
}: {
	contentId: string;
	showCreate?: boolean;
	showHeading?: boolean;
}) {
	const { t } = useT();
	const [offset, setOffset] = useState(0);
	const query = useQuery({
		queryKey: ["library-edit-projects", contentId, offset],
		refetchOnMount: "always",
		queryFn: ({ signal }) =>
			apiFetch<EditingProjectPage>(
				`/api/library/edits?${new URLSearchParams({ contentId, offset: String(offset) })}`,
				{ signal },
			),
	});
	return (
		<section
			aria-label={t("editing.clipDrafts")}
			className="min-w-0 space-y-3 border-zinc-800 border-t pt-4"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				{showHeading ? (
					<h2 className="font-semibold">
						{t("editing.clipDrafts")}
						{query.data && (
							<span className="ml-2 font-normal text-sm text-zinc-400">
								{query.data.total}
							</span>
						)}
					</h2>
				) : (
					<span className="text-sm text-zinc-400">
						{query.data &&
							t("editing.clipDraftCount", { count: query.data.total })}
					</span>
				)}
				{showCreate && (
					<Link
						href={`/library/${contentId}/edits`}
						className={`${linkClass} text-sm`}
					>
						{t("editing.createAnotherClip")}
					</Link>
				)}
			</div>
			{query.isPending && (
				<p role="status" className="text-sm text-zinc-400">
					{t("editing.loading")}
				</p>
			)}
			{query.isError && (
				<div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
					<span>{t("editing.clipDraftsLoadFailed")}</span>
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
			{query.data && !query.isError && (
				<>
					{query.data.total === 0 && (
						<p className="text-sm text-zinc-400">{t("editing.noClipDrafts")}</p>
					)}
					<ul className="divide-y divide-zinc-800">
						{query.data.items.map((project) => (
							<ClipProjectRow key={project.id} project={project} />
						))}
					</ul>
					{(query.data.total > 25 || offset > 0) && (
						<nav
							aria-label={t("editing.clipDraftPages")}
							className="flex items-center gap-3"
						>
							<Button
								size="sm"
								variant="secondary"
								disabled={offset === 0 || query.isFetching}
								onClick={() => setOffset(Math.max(0, offset - 25))}
							>
								{t("library.previous")}
							</Button>
							<span className="text-xs text-zinc-400 tabular-nums">
								{offset + (query.data.items.length ? 1 : 0)}–
								{offset + query.data.items.length} / {query.data.total}
							</span>
							<Button
								size="sm"
								variant="secondary"
								disabled={
									query.isFetching ||
									offset + 25 >= query.data.total ||
									offset >= 10000
								}
								onClick={() => setOffset(Math.min(10000, offset + 25))}
							>
								{t("library.next")}
							</Button>
						</nav>
					)}
				</>
			)}
		</section>
	);
}

function ClipProjectRow({ project }: { project: EditingProjectSummary }) {
	const { t } = useT();
	const titleId = useId();
	const seconds =
		project.durationFrames !== null && project.fps
			? (project.durationFrames * project.fps.den) / project.fps.num
			: null;
	return (
		<li className="min-w-0 py-1">
			<Link
				href={`/library/edits/${project.id}`}
				aria-labelledby={titleId}
				className="flex min-w-0 items-center gap-3 rounded p-3 hover:bg-zinc-900/50 focus-visible:outline-2 focus-visible:outline-emerald-500"
			>
				<ClipThumbnail reference={project.thumbnail} />
				<div className="min-w-0 flex-1 space-y-1">
					<h3
						id={titleId}
						className="break-words font-medium text-sm leading-relaxed [overflow-wrap:anywhere]"
					>
						{project.title}
					</h3>
					<div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-400">
						<span>
							{t(
								project.variant === "PORTRAIT"
									? "editing.portrait"
									: "editing.landscape",
							)}
						</span>
						{seconds !== null && (
							<span className="tabular-nums">{seconds.toFixed(1)}s</span>
						)}
					</div>
				</div>
			</Link>
		</li>
	);
}
