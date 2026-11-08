"use client";

import { compositionDurationFrames } from "@bitovp/core";
import Link from "next/link";
import { useState } from "react";
import { useT } from "@/lib/i18n/context";
import type {
	AnyEditingProjectView,
	EditingRenderView,
} from "@/lib/library-editing";
import { editingErrorMessage } from "../../editing-errors";
import { useCompositionCopy } from "../composition-copy";
import { editingStateLabel } from "../render-panel";

const terminal = new Set(["SUCCEEDED", "ERROR", "FAILED", "CANCELED"]);
export const renderIsActive = (run: EditingRenderView | undefined) =>
	!!run && !terminal.has(run.state);
export function latestPortraitExport(project: AnyEditingProjectView) {
	return project.renders
		.filter((run) => run.kind === "EXPORT")
		.reduce<EditingRenderView | undefined>(
			(latest, run) =>
				!latest || run.generation > latest.generation ? run : latest,
			undefined,
		);
}

const linkFocus =
	"rounded-md focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2";
export function PortraitResultContent({
	project,
	run,
	videoAttempt,
}: {
	project: AnyEditingProjectView;
	run: EditingRenderView | undefined;
	videoAttempt: number;
}) {
	const { t, locale } = useT();
	const c = useCompositionCopy();
	const isComposition = project.draft.schemaVersion === 2;
	const auto = project.draft.autoGeneration;
	const frames =
		run?.durationFrames ??
		(project.draft.schemaVersion === 2
			? compositionDurationFrames(project.draft)
			: project.draft.clips.reduce(
					(total, clip) => total + clip.durationFrames,
					0,
				));
	const seconds = (count: number) =>
		new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
			count / 30,
		);
	const artifact = run?.state === "SUCCEEDED" ? run.artifact : null;
	return (
		<div className="grid min-w-0 gap-6 md:grid-cols-2 md:items-start">
			<div className="mx-auto w-full min-w-0 max-w-sm">
				{artifact ? (
					<PortraitVideo
						key={`${artifact.id}:${videoAttempt}`}
						artifact={artifact}
						label={
							isComposition
								? c.resultTitle
								: t("editing.autoPortrait.resultTitle")
						}
					/>
				) : (
					<div
						style={{
							aspectRatio: `${project.draft.canvas.width} / ${project.draft.canvas.height}`,
						}}
						className="flex max-h-[70vh] items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-300"
					>
						{isComposition
							? `${project.draft.canvas.width}×${project.draft.canvas.height}`
							: t("editing.portrait")}
					</div>
				)}
			</div>
			<section className="min-w-0 space-y-4">
				<p
					role="status"
					aria-live="polite"
					aria-atomic="true"
					className="font-medium text-zinc-200"
				>
					{run
						? editingStateLabel(run.state, t)
						: t("editing.autoPortrait.waiting")}
				</p>
				{(auto || run) && (
					<p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-300">
						{auto && (
							<span>
								{t("editing.autoPortrait.requestedDuration", {
									seconds: seconds(auto.requestedDurationFrames),
								})}
							</span>
						)}
						<span>
							{t("editing.autoPortrait.actualDuration", {
								seconds: seconds(frames),
							})}
						</span>
					</p>
				)}
				{!auto && (
					<p className="text-sm text-zinc-400">
						{t("editing.autoPortrait.manualResult")}
					</p>
				)}
				{run && run.revisionId !== project.currentRevisionId && (
					<p className="text-amber-300 text-sm">
						{t("editing.autoPortrait.earlierRevision")}
					</p>
				)}
				{run?.error && (
					<p className="break-words text-amber-300 text-sm">
						{editingErrorMessage(run.error, t)}
					</p>
				)}
				{run?.state === "SUCCEEDED" && !artifact && (
					<p role="alert" className="text-amber-300 text-sm">
						{t("editing.autoPortrait.missingArtifact")}
					</p>
				)}
				<div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
					{artifact && (
						<a
							href={artifact.downloadUrl}
							className={`${linkFocus} inline-flex min-h-10 items-center justify-center bg-emerald-600 px-4 py-2 font-medium text-sm text-white hover:bg-emerald-500`}
						>
							{t("editing.autoPortrait.download")}
						</a>
					)}
					<Link
						href={`/library/edits/${project.id}`}
						className={`${linkFocus} inline-flex min-h-10 items-center justify-center border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800`}
					>
						{t("editing.autoPortrait.edit")}
					</Link>
				</div>
				{artifact?.derivedContentId && (
					<Link
						href={`/library/${artifact.derivedContentId}`}
						className={`${linkFocus} inline-block text-emerald-400 text-sm underline`}
					>
						{t("editing.derived")}
					</Link>
				)}
				<p className="max-w-prose text-sm text-zinc-400">
					{t("editing.autoPortrait.resultHelp")}
				</p>
				{isComposition && (
					<p className="max-w-prose text-sm text-zinc-400">{c.resultHelp}</p>
				)}
				{auto && !isComposition && (
					<p className="max-w-prose text-sm text-zinc-400">
						{t("editing.autoPortrait.limitations")}
					</p>
				)}
				{auto?.binding.kind === "EDITOR_ATTESTED" && (
					<p className="text-sm text-zinc-400">
						{locale === "ja"
							? "素材と解析の対応は編集者が確認しています。"
							: "The editor verified this source and analysis association."}
					</p>
				)}
				{auto?.binding.kind === "FIXTURE_AUTHORED" && (
					<p className="max-w-prose text-amber-300 text-sm">
						{t("editing.autoPortrait.fixtureMetadata")}
					</p>
				)}
			</section>
		</div>
	);
}

function PortraitVideo({
	artifact,
	label,
}: {
	artifact: NonNullable<EditingRenderView["artifact"]>;
	label: string;
}) {
	const { t } = useT();
	const [failed, setFailed] = useState(false);
	return (
		<div className="space-y-3">
			<video
				controls
				muted
				playsInline
				preload="metadata"
				src={artifact.url}
				aria-label={label}
				className="mx-auto block h-auto max-h-[70vh] w-auto max-w-full rounded-lg bg-black object-contain"
				onError={() => setFailed(true)}
			/>
			{failed && (
				<p role="alert" className="text-amber-300 text-sm">
					{t("editing.autoPortrait.videoError")}
				</p>
			)}
		</div>
	);
}
