"use client";
import type { LibrarySourceView, PlayerClientConfig } from "@bitovp/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { PlaybackSurface } from "@/app/vod/jobs/[id]/playback-surface";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { SelectNative } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import type { LibrarySceneSelection } from "@/lib/library-scenes";
import { AnalysisData, AnalysisHighlights } from "./analysis-data";
import { AnalysisView } from "./analysis-view";
import { ContentCredits } from "./content-credits";
import { SceneTimeline } from "./scene-timeline";
export function SourcePanel({
	source,
	player = { provider: "native" },
	initialLocale,
	initialScene,
	embeddedPlayback,
}: {
	source: LibrarySourceView;
	player?: PlayerClientConfig;
	initialLocale?: string;
	initialScene?: LibrarySceneSelection;
	embeddedPlayback?: {
		locale: string;
		onLocaleChange: (locale: string) => void;
		onSeek?: (seconds: number) => void;
	};
}) {
	const { t } = useT();
	const id = useId();
	const canRetry = useMutationAccess("library.source.retry");
	const client = useQueryClient();
	const locales = [
		...new Set([
			...source.locales,
			...source.analyses.map((item) => item.locale),
		]),
	];
	const [localLocale, setLocalLocale] = useState(
		initialScene?.locale ??
			(initialLocale && locales.includes(initialLocale)
				? initialLocale
				: (source.analyses[0]?.locale ?? source.locales[0] ?? "en")),
	);
	const locale = embeddedPlayback?.locale ?? localLocale;
	const setLocale = embeddedPlayback?.onLocaleChange ?? setLocalLocale;
	const hasAnalysis = locales.length > 0;
	const [seekRequest, setSeekRequest] = useState<{
		seconds: number;
		requestId: number;
	}>();
	const analysis = source.analyses.find((item) => item.locale === locale);

	const [mediaTime, setMediaTime] = useState<number | null>(0);
	const playable = source.snapshot.playbackLinks.filter(
		(link) =>
			link.url &&
			(link.kind === "HLS" || link.kind === "DASH" || link.kind === "MP4"),
	);
	const hasPrivateOutput = source.snapshot.playbackLinks.some(
		(item) =>
			!item.url && item.reason?.code === "NOT_PUBLIC" && item.kind !== "SMOOTH",
	);
	const [selectedLink, setSelectedLink] = useState("");
	const link =
		playable.find((item) => item.key === selectedLink) ?? playable[0];
	const seek = useCallback(
		(seconds: number) => {
			setMediaTime(seconds);
			if (link)
				setSeekRequest((previous) => ({
					seconds,
					requestId: (previous?.requestId ?? 0) + 1,
				}));
		},
		[link],
	);
	const appliedScene = useRef(false);
	useEffect(() => {
		if (!initialScene || appliedScene.current || embeddedPlayback) return;
		const pinnedAnalysis = source.analyses.find(
			(item) =>
				item.locale === initialScene.locale &&
				item.id === initialScene.analysisRevisionId,
		);
		const scene = pinnedAnalysis?.document.scenes.find(
			(item) => item.id === initialScene.sceneId,
		);
		if (
			!scene ||
			!Number.isFinite(scene.startInSeconds) ||
			scene.endInSeconds <= scene.startInSeconds
		)
			return;
		appliedScene.current = true;
		setLocalLocale(initialScene.locale);
		seek(scene.startInSeconds);
	}, [initialScene, source.analyses, embeddedPlayback, seek]);
	const retry = useMutation({
		mutationFn: () =>
			apiFetch(`/api/library/sources/${source.id}/retry`, { method: "POST" }),
		onSuccess: () => {
			void client.invalidateQueries({ queryKey: ["library"] });
			void client.invalidateQueries({ queryKey: ["job-analysis"] });
		},
	});
	return (
		<section className="space-y-4">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-zinc-400">
				{!embeddedPlayback && (
					<h2 className="font-semibold text-sm">
						{t(hasAnalysis ? "library.analysis" : "library.playback")}{" "}
						<InfoHint
							text={t("library.identity")}
							labelFor={t("library.analysis")}
						/>
					</h2>
				)}
				{hasAnalysis && (
					<p role="status" className="text-sm">
						{t(
							(
								{
									PENDING: "library.pending",
									RUNNING: "library.running",
									READY: "library.ready",
									ERROR: "library.error",
								} as const
							)[source.state],
						)}
					</p>
				)}
				{source.error && (
					<p role="alert" className="break-words text-sm">
						{source.error}
					</p>
				)}
				{hasAnalysis && source.state === "ERROR" && canRetry && (
					<Button disabled={retry.isPending} onClick={() => retry.mutate()}>
						{t("library.retry")}
					</Button>
				)}
				{retry.error && <p role="alert">{retry.error.message}</p>}
				{source.jobId && !embeddedPlayback && (
					<Link
						href={`/vod/jobs/${source.jobId}`}
						className="text-emerald-400 text-sm underline"
					>
						{t("library.openJob")}
					</Link>
				)}
			</div>
			<div
				className={
					embeddedPlayback || !hasAnalysis
						? "space-y-4"
						: "grid items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]"
				}
			>
				{!embeddedPlayback && (
					<div className="order-1 min-w-0 space-y-4 xl:col-start-1 xl:row-start-1">
						{link ? (
							<>
								<SelectNative
									aria-label={t("library.playback")}
									value={link.key}
									onChange={(e) => {
										setSelectedLink(e.target.value);
										setSeekRequest(undefined);
										setMediaTime(null);
									}}
								>
									{playable.map((item) => (
										<option key={item.key} value={item.key}>
											{item.label}
										</option>
									))}
								</SelectNative>
								<PlaybackSurface
									url={link.url}
									kind={
										link.kind === "MP4"
											? "MP4"
											: link.kind === "DASH"
												? "DASH"
												: "HLS"
									}
									player={player}
									seekRequest={seekRequest}
									sceneAnalysis={analysis?.document}
									onTimeChange={setMediaTime}
								/>
							</>
						) : (
							<p className="text-sm text-zinc-400" role="status">
								{t(
									hasPrivateOutput
										? "playback.reasonNotPublic"
										: "library.noPlayback",
								)}
							</p>
						)}
						{analysis && (
							<SceneTimeline
								key={analysis.id}
								document={analysis.document}
								time={mediaTime}
								onSeek={seek}
							/>
						)}
					</div>
				)}
				<div
					className={
						!hasAnalysis
							? "hidden"
							: embeddedPlayback
								? "space-y-4"
								: "order-2 min-w-0 space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 xl:sticky xl:top-4 xl:col-start-2 xl:row-start-1 xl:row-span-2 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto"
					}
				>
					{hasAnalysis && !embeddedPlayback && (
						<h2 className="font-semibold">{t("library.currentScene")}</h2>
					)}
					{hasAnalysis && (
						<label htmlFor={`${id}-locale`} className="block space-y-1 text-sm">
							{t("library.locale")}
							<SelectNative
								value={locale}
								id={`${id}-locale`}
								onChange={(e) => setLocale(e.target.value)}
							>
								{[...new Set([locale, ...locales])].map((item) => (
									<option key={item} value={item}>
										{item}
									</option>
								))}
							</SelectNative>
						</label>
					)}
					{hasAnalysis &&
						(analysis ? (
							<AnalysisView
								key={analysis.id}
								document={analysis.document}
								providerAnalysis={analysis.providerAnalysis}
								mode={embeddedPlayback ? "all" : "current"}
								currentTime={mediaTime}
								onSeek={embeddedPlayback ? embeddedPlayback.onSeek : seek}
							/>
						) : (
							<p>{t("library.missingLocale")}</p>
						))}
				</div>
				{analysis && !embeddedPlayback && (
					<section className="order-3 min-w-0 space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 xl:col-start-1 xl:row-start-2">
						<h3 className="font-semibold">{t("library.globalMetadata")}</h3>
						<p className="break-words font-medium">
							{analysis.document.title || t("library.unreported")}
						</p>
						<p className="whitespace-pre-wrap break-words text-sm text-zinc-300">
							{analysis.document.description || t("library.unreported")}
						</p>
						<div className="flex flex-wrap gap-1">
							{analysis.document.keywords.map((keyword) => (
								<span
									key={keyword}
									className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400"
								>
									{keyword}
								</span>
							))}
						</div>
						{[
							...analysis.document.sensitiveTopics,
							...analysis.document.iabSensitiveTopicTaxonomies,
						].length > 0 && (
							<p className="break-words text-sm">
								{t("library.classification")}:{" "}
								{[
									...analysis.document.sensitiveTopics,
									...analysis.document.iabSensitiveTopicTaxonomies,
								].join(" · ")}
							</p>
						)}
						<AnalysisHighlights providerAnalysis={analysis.providerAnalysis} />
						<ContentCredits credits={analysis.document.credits} />
						<AnalysisData
							key={analysis.id}
							document={analysis.document}
							providerAnalysis={analysis.providerAnalysis}
						/>
					</section>
				)}
			</div>
			{source.contents.length > 0 && embeddedPlayback && (
				<div>
					<h3 className="font-medium">{t("library.linked")}</h3>
					<ul>
						{source.contents.map((content) => (
							<li key={content.id}>
								<Link
									href={`/library/${content.id}`}
									className="text-emerald-400 text-sm underline"
								>
									{content.title}
									{content.archived ? ` · ${t("library.archived")}` : ""}
								</Link>
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}
