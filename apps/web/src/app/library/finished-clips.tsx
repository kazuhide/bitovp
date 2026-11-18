"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
	type CSSProperties,
	type PointerEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { useDocumentOrganization } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import type { EditingProjectPage } from "@/lib/library-editing";
import { boundExportLinks, ClipExportVideo } from "./clip-export-video";

const copy = {
	ja: {
		title: "クリップ映像",
		clip: "クリップ",
		highlight: "ハイライト",
		trailer: "予告編",
		create: "クリップ映像を作る",
		resize: "クリップ映像欄の幅を調整",
		error: "クリップ映像を読み込めませんでした。",
		empty: "クリップ映像はまだありません。",
	},
	en: {
		title: "Clips",
		clip: "Clip",
		highlight: "Highlight",
		trailer: "Trailer",
		create: "Create a clip",
		resize: "Resize clips panel",
		error: "Clips could not be loaded.",
		empty: "No clips yet.",
	},
} as const;

const MIN_WIDTH = 296;
const MAX_WIDTH = 704;
const DEFAULT_WIDTH = 400;
const SOURCE_WIDTH_WITH_GAP = 440;
const PAGE_SIZE = 25;
const anchorId = "finished-clips";
const linkClass =
	"rounded text-emerald-400 text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-emerald-500";

type ClipLayoutProps = {
	contentId: string;
	canCreate?: boolean;
	children?: ReactNode;
};

export function FinishedClips(props: ClipLayoutProps) {
	const organizationId = useDocumentOrganization();
	return (
		<FinishedClipShelf
			key={`${organizationId}:${props.contentId}`}
			organizationId={organizationId}
			{...props}
		/>
	);
}

function FinishedClipShelf({
	contentId,
	organizationId,
	canCreate = false,
	children,
}: ClipLayoutProps & { organizationId?: string }) {
	const { t, locale } = useT();
	const labels = copy[locale];
	const canEdit = useMutationAccess("library.edits.edit");
	const headingId = useId();
	const shelf = useRef<HTMLElement>(null);
	const layout = useRef<HTMLDivElement>(null);
	const [offset, setOffset] = useState(0);
	const [requestedWidth, setRequestedWidth] = useState(DEFAULT_WIDTH);
	const [maxWidth, setMaxWidth] = useState(MAX_WIDTH);
	const drag = useRef<{
		pointerId: number;
		startX: number;
		startWidth: number;
	} | null>(null);
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
		enabled: !!organizationId,
		placeholderData: keepPreviousData,
		refetchOnMount: "always",
	});
	const items = (query.isSuccess ? query.data.items : []).flatMap((project) => {
		const run = project.latestSuccessfulExport;
		return run ? [{ project, run }] : [];
	});
	const hasClips = items.length > 0;
	const constrainWidth = (value: number) =>
		Math.min(maxWidth, Math.max(MIN_WIDTH, value));
	const width = constrainWidth(requestedWidth);

	useEffect(() => {
		const element = layout.current;
		if (!element || !hasClips) return;
		const measure = () => {
			const available = Math.floor(element.getBoundingClientRect().width);
			if (available > 0) {
				setMaxWidth(
					Math.min(
						MAX_WIDTH,
						Math.max(MIN_WIDTH, available - SOURCE_WIDTH_WITH_GAP),
					),
				);
			}
		};
		measure();
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(measure);
		observer?.observe(element);
		return () => {
			drag.current = null;
			observer?.disconnect();
		};
	}, [hasClips]);

	useEffect(() => {
		// Results can appear after fragment navigation, once the request completes.
		if (!query.isPending && window.location.hash === `#${anchorId}`) {
			shelf.current?.scrollIntoView?.({ block: "nearest" });
		}
	}, [query.isPending]);

	function resizeFromPointer(event: PointerEvent<HTMLDivElement>) {
		const current = drag.current;
		if (current && event.pointerId === current.pointerId) {
			setRequestedWidth(
				constrainWidth(current.startWidth + current.startX - event.clientX),
			);
		}
	}

	function cancelResize(target: HTMLDivElement, pointerId: number) {
		const current = drag.current;
		if (!current || pointerId !== current.pointerId) return;
		drag.current = null;
		setRequestedWidth(current.startWidth);
		if (target.hasPointerCapture(pointerId)) {
			target.releasePointerCapture(pointerId);
		}
	}

	const pageNav = query.isSuccess &&
		(offset > 0 || query.data.total > PAGE_SIZE) && (
			<nav aria-label={labels.title} className="flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="secondary"
					disabled={offset === 0 || query.isFetching}
					onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
				>
					{t("library.previous")}
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={
						offset + PAGE_SIZE >= query.data.total ||
						offset >= 10_000 ||
						query.isFetching
					}
					onClick={() => setOffset(offset + PAGE_SIZE)}
				>
					{t("library.next")}
				</Button>
			</nav>
		);

	return (
		<div ref={layout} className="@container min-w-0">
			<div className="grid min-w-0 gap-5 @min-[820px]:flex @min-[820px]:items-start">
				<div className="min-w-0 flex-1">
					{organizationId && !hasClips && (
						<section
							ref={shelf}
							id={anchorId}
							aria-label={labels.title}
							className="mb-4 flex flex-wrap items-center gap-3 text-sm"
						>
							{query.isPending && (
								<p role="status" className="text-zinc-400">
									{t("editing.loading")}
								</p>
							)}
							{query.isError && (
								<div role="alert" className="flex flex-wrap items-center gap-3">
									<p className="text-zinc-400">{labels.error}</p>
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
									{canCreate && canEdit ? (
										<Link
											href={`/library/${contentId}/edits`}
											className={linkClass}
										>
											{labels.create}
										</Link>
									) : (
										<p className="text-zinc-400">{labels.empty}</p>
									)}
									{pageNav}
								</>
							)}
						</section>
					)}
					{children}
				</div>
				{hasClips && (
					<aside
						ref={shelf}
						id={anchorId}
						aria-labelledby={headingId}
						style={{ "--clips-width": `${width}px` } as CSSProperties}
						className="relative min-w-0 space-y-3 border-zinc-800 border-t pt-4 @min-[820px]:w-(--clips-width) @min-[820px]:shrink-0 @min-[820px]:border-t-0 @min-[820px]:border-l @min-[820px]:pt-0 @min-[820px]:pl-4"
					>
						{/* biome-ignore lint/a11y/useSemanticElements: This interactive pane splitter handles resizing. */}
						<div
							role="separator"
							tabIndex={0}
							aria-label={labels.resize}
							aria-orientation="vertical"
							aria-controls={anchorId}
							aria-valuemin={MIN_WIDTH}
							aria-valuemax={maxWidth}
							aria-valuenow={width}
							title={labels.resize}
							className="group absolute inset-y-0 -left-1.5 z-10 hidden w-3 touch-none cursor-col-resize items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 @min-[820px]:flex"
							onPointerDown={(event) => {
								if (event.button !== 0 || !event.isPrimary || drag.current)
									return;
								event.preventDefault();
								event.currentTarget.focus();
								event.currentTarget.setPointerCapture(event.pointerId);
								drag.current = {
									pointerId: event.pointerId,
									startX: event.clientX,
									startWidth: width,
								};
							}}
							onPointerMove={resizeFromPointer}
							onPointerUp={(event) => {
								if (event.pointerId !== drag.current?.pointerId) return;
								resizeFromPointer(event);
								drag.current = null;
								if (event.currentTarget.hasPointerCapture(event.pointerId)) {
									event.currentTarget.releasePointerCapture(event.pointerId);
								}
							}}
							onPointerCancel={(event) =>
								cancelResize(event.currentTarget, event.pointerId)
							}
							onLostPointerCapture={(event) =>
								cancelResize(event.currentTarget, event.pointerId)
							}
							onKeyDown={(event) => {
								if (event.key === "Escape" && drag.current) {
									event.preventDefault();
									cancelResize(event.currentTarget, drag.current.pointerId);
									return;
								}
								let nextWidth: number;
								switch (event.key) {
									case "ArrowLeft":
										nextWidth = width + 32;
										break;
									case "ArrowRight":
										nextWidth = width - 32;
										break;
									case "Home":
										nextWidth = MIN_WIDTH;
										break;
									case "End":
										nextWidth = maxWidth;
										break;
									default:
										return;
								}
								event.preventDefault();
								setRequestedWidth(constrainWidth(nextWidth));
							}}
						>
							<span
								aria-hidden="true"
								className="h-8 w-0.5 rounded bg-zinc-600 group-hover:bg-emerald-500 group-focus-visible:bg-emerald-500"
							/>
						</div>
						<h2 id={headingId} className="font-semibold text-sm">
							{labels.title}
						</h2>
						<ul
							key={query.data?.offset}
							className="flex snap-x items-start gap-3 overflow-x-auto pb-2"
						>
							{items.map(({ project, run }) => {
								const links = boundExportLinks(run.artifact, organizationId);
								const earlier =
									run.id !== project.latestExport?.id ||
									!run.matchesCurrentDraft;
								const purpose =
									run.purpose === "TRAILER"
										? labels.trailer
										: run.purpose === "HIGHLIGHT"
											? labels.highlight
											: labels.clip;
								return (
									<li
										key={run.id}
										className={`min-w-0 shrink-0 snap-start space-y-2 rounded-md border border-zinc-800 p-2 ${items.length > 1 ? "w-[min(94%,26rem)]" : "w-full"}`}
									>
										{links ? (
											<ClipExportVideo
												key={run.artifact.id}
												src={links.media}
												title={project.title}
												inline
											/>
										) : (
											<p
												role="alert"
												className="flex aspect-video items-center justify-center rounded-md bg-black p-2 text-center text-amber-300 text-sm"
											>
												{t("editing.autoPortrait.videoError")}
											</p>
										)}
										<h3 className="break-words font-medium text-sm [overflow-wrap:anywhere]">
											{project.title}
										</h3>
										<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
											<span>
												{purpose}
												{run.durationFrames !== null &&
													` · ${(run.durationFrames / 30).toFixed(1)}s`}
											</span>
											{earlier && <span>{t("editing.earlierExport")}</span>}
										</div>
										<Link
											href={`/library/edits/${project.id}/result?exportId=${run.id}`}
											className={linkClass}
										>
											{t("editing.watchExport")}
										</Link>
									</li>
								);
							})}
						</ul>
						{pageNav}
					</aside>
				)}
			</div>
		</div>
	);
}
