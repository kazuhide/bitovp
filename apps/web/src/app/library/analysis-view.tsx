"use client";

import type { ProviderAnalysisView, SceneAnalysisDocument } from "@bitovp/core";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import { AnalysisData, AnalysisHighlights } from "./analysis-data";
import { ContentCredits } from "./content-credits";

export function AnalysisView({
	document,
	providerAnalysis,
	onSeek,
	mode = "all",
	currentTime = null,
}: {
	document: SceneAnalysisDocument;
	providerAnalysis?: ProviderAnalysisView;
	onSeek?: (seconds: number) => void;
	mode?: "all" | "current";
	currentTime?: number | null;
}) {
	const { t } = useT();
	const [search, setSearch] = useState("");
	const [offset, setOffset] = useState(0);
	const scenes =
		mode === "current"
			? document.scenes
					.filter(
						(scene) =>
							currentTime !== null &&
							currentTime >= scene.startInSeconds &&
							currentTime < scene.endInSeconds,
					)
					.slice(0, 1)
			: document.scenes.filter((scene) =>
					`${scene.title} ${scene.summary} ${scene.keywords.join(" ")}`
						.toLocaleLowerCase()
						.includes(search.toLocaleLowerCase()),
				);
	const time = (seconds: number) => (
		<Button
			variant="ghost"
			disabled={!onSeek}
			onClick={() => onSeek?.(seconds)}
			aria-label={t("library.seek", { seconds })}
		>
			{seconds.toFixed(2)}s
		</Button>
	);
	return (
		<div className="space-y-4">
			{document.omittedSubjectCount ? (
				<p role="status" className="text-sm text-amber-300">
					{t("library.omittedSubjects", {
						count: document.omittedSubjectCount,
					})}
				</p>
			) : null}
			{mode === "all" && (
				<>
					<section className="space-y-2">
						<h3 className="font-semibold">{t("library.summary")}</h3>
						<p className="font-medium">{document.title}</p>
						<p className="whitespace-pre-wrap text-sm">
							{document.description}
						</p>
						<p className="text-xs text-zinc-400">
							{document.keywords.join(" · ")}
						</p>
					</section>
					<p className="text-sm">
						{t("library.classification")}:{" "}
						{[
							...document.sensitiveTopics,
							...document.iabSensitiveTopicTaxonomies,
						].join(" · ") || "—"}
					</p>
					<AnalysisHighlights providerAnalysis={providerAnalysis} />
					<ContentCredits credits={document.credits} />
					<h3 className="font-semibold">
						{t("library.scenes")} ({scenes.length})
					</h3>
					<Input
						type="search"
						aria-label={t("library.searchScenes")}
						placeholder={t("library.searchScenes")}
						value={search}
						onChange={(e) => {
							setSearch(e.target.value);
							setOffset(0);
						}}
					/>
				</>
			)}
			{scenes.length === 0 && (
				<p>
					{t(
						mode === "current" ? "library.noCurrentScene" : "library.noScenes",
					)}
				</p>
			)}
			{scenes
				.slice(
					mode === "current" ? 0 : offset,
					mode === "current" ? 1 : offset + 20,
				)
				.map((scene) => (
					<details
						key={scene.id}
						open={mode === "current" ? true : undefined}
						className="rounded-md border border-zinc-800 p-3"
					>
						<summary className="cursor-pointer break-words font-medium">
							{scene.startInSeconds.toFixed(2)}–{scene.endInSeconds.toFixed(2)}s
							· {scene.title || scene.type || scene.id}
						</summary>
						<div className="mt-3 space-y-3 text-sm">
							{time(scene.startInSeconds)}
							<p className="break-words leading-relaxed">
								{scene.summary || t("library.unreported")}
							</p>
							{scene.verboseSummary && (
								<details>
									<summary className="cursor-pointer text-zinc-400">
										{t("library.description")}
									</summary>
									<p className="mt-2 whitespace-pre-wrap">
										{scene.verboseSummary}
									</p>
								</details>
							)}
							<dl
								className={`rounded-md border p-3 ${(scene.adOpportunityInformation?.score ?? 0) > 0.5 ? "border-emerald-800/60 bg-emerald-950/30" : "border-zinc-700 bg-zinc-900/40"}`}
							>
								<dt className="flex items-center gap-2 text-xs text-zinc-400">
									{t("library.adOpportunity")}
									<InfoHint
										text={t("library.adThreshold")}
										labelFor={t("library.adOpportunity")}
									/>
								</dt>
								<dd className="my-1 font-mono text-xl">
									{scene.adOpportunityInformation?.score ??
										t("library.unreported")}
								</dd>
								{scene.adOpportunityInformation?.reason && (
									<>
										<dt className="text-xs text-zinc-400">
											{t("library.adReason")}
										</dt>
										<dd className="mt-1 break-words">
											{scene.adOpportunityInformation.reason}
										</dd>
									</>
								)}
							</dl>
							<dl className="space-y-1">
								<dt className="text-xs text-zinc-400">
									{t("library.dynamics")}
								</dt>
								<dd className="inline-block rounded bg-zinc-800 px-2 py-1 text-xs">
									{[
										scene.content?.dynamics?.tension,
										scene.content?.dynamics?.pacing,
									]
										.filter(Boolean)
										.join(" · ") || t("library.unreported")}
								</dd>
							</dl>
							{(scene.content?.characters.length ?? 0) > 0 && (
								<details>
									<summary className="cursor-pointer font-medium">
										{t("library.characters")} (
										{scene.content?.characters.length})
									</summary>
									<ul className="space-y-2">
										{scene.content?.characters.map((c, i) => (
											<li key={`${c.name}-${i}`}>
												<strong>{c.name || "—"}</strong> {c.playedBy} ·{" "}
												{c.description}
												{(c.appearance || c.characterAppearance?.summary) && (
													<p className="text-zinc-400">
														{c.appearance || c.characterAppearance?.summary}
													</p>
												)}
											</li>
										))}
									</ul>
								</details>
							)}
							{(scene.content?.objects.length ?? 0) > 0 && (
								<details>
									<summary className="cursor-pointer font-medium">
										{t("library.objects")} ({scene.content?.objects.length})
									</summary>
									<ul>
										{scene.content?.objects.map((o, i) => (
											<li key={`${o.category}-${i}`}>
												{o.category} · {o.description}
											</li>
										))}
									</ul>
								</details>
							)}
							{(scene.content?.settings?.length ?? 0) > 0 && (
								<details>
									<summary className="cursor-pointer font-medium">
										{t("library.settings")} ({scene.content?.settings?.length})
									</summary>
									<ul className="space-y-2">
										{scene.content?.settings?.map((s, i) => (
											<li key={`${s.location?.name}-${i}`}>
												{[
													s.location?.name,
													s.location?.description,
													s.timeOfDay,
													s.atmosphere?.mood,
													s.atmosphere?.lighting,
													s.atmosphere?.weather,
												]
													.filter(Boolean)
													.join(" · ")}
											</li>
										))}
									</ul>
								</details>
							)}
							{(scene.iab?.adOpportunityTaxonomies.length ?? 0) > 0 && (
								<section>
									<h4 className="font-medium">{t("library.adCategories")}</h4>
									<p>{scene.iab?.adOpportunityTaxonomies.join(" · ")}</p>
								</section>
							)}
							<div className="flex flex-wrap gap-1">
								{scene.keywords.map((keyword) => (
									<span
										key={keyword}
										className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400"
									>
										{keyword}
									</span>
								))}
							</div>
							<details>
								<summary className="cursor-pointer font-medium">
									{t("library.classification")}
								</summary>
								<p className="mt-2 break-words">
									{[
										...scene.sensitiveTopics,
										...(scene.iab?.contentTaxonomies ?? []),
										...(scene.iab?.sensitiveTopicTaxonomies ?? []),
									].join(" · ") || t("library.unreported")}
								</p>
							</details>
							<h4 className="font-medium">
								{t("library.shots")} ({scene.shots.length})
							</h4>
							{scene.shots.map((shot, index) => (
								<details
									key={`${shot.startInSeconds}-${index}`}
									className="border-zinc-800 border-l pl-3"
								>
									<summary className="cursor-pointer">
										{shot.startInSeconds.toFixed(2)}–
										{shot.endInSeconds.toFixed(2)}s
									</summary>
									{time(shot.startInSeconds)}
									<p>{shot.detailedDescription}</p>
									<p>{shot.keywords.join(" · ")}</p>
									<h5 className="mt-2 font-medium">{t("library.subjects")}</h5>
									<ul>
										{shot.mainSubjects.map((subject, i) => (
											<li key={`${subject.appearanceTimeInSeconds}-${i}`}>
												{time(
													shot.startInSeconds + subject.appearanceTimeInSeconds,
												)}{" "}
												{subject.classification} · {subject.description}
											</li>
										))}
									</ul>
								</details>
							))}
						</div>
					</details>
				))}
			{mode === "all" && (
				<>
					<div className="flex gap-2">
						<Button
							variant="secondary"
							disabled={offset === 0}
							onClick={() => setOffset(Math.max(0, offset - 20))}
						>
							{t("library.previous")}
						</Button>
						<Button
							variant="secondary"
							disabled={offset + 20 >= scenes.length}
							onClick={() => setOffset(offset + 20)}
						>
							{t("library.next")}
						</Button>
					</div>
					<AnalysisData
						document={document}
						providerAnalysis={providerAnalysis}
					/>
				</>
			)}
		</div>
	);
}
