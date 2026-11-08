"use client";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { type Translator, useT } from "@/lib/i18n/context";
import type { EditingProjectView } from "@/lib/library-editing";
import { editingErrorMessage } from "../editing-errors";
import { useCompositionCopy } from "./composition-copy";

export function editingStateLabel(state: string, t: Translator): string {
	const states = {
		PENDING: "editing.states.PENDING",
		QUEUED: "editing.states.QUEUED",
		PREPARING: "editing.states.PREPARING",
		READY: "editing.states.READY",
		RUNNING: "editing.states.RUNNING",
		RENDERING: "editing.states.RENDERING",
		VALIDATING: "editing.states.VALIDATING",
		SUCCEEDED: "editing.states.SUCCEEDED",
		ERROR: "editing.states.ERROR",
		FAILED: "editing.states.FAILED",
		CANCEL_REQUESTED: "editing.states.CANCEL_REQUESTED",
		CANCELED: "editing.states.CANCELED",
	} as const;
	return t(
		Object.hasOwn(states, state)
			? states[state as keyof typeof states]
			: "editing.processing",
	);
}
export function RenderPanel({
	project,
	disabled,
	generationDisabled,
	onGenerate,
	onCancel,
	previewOutdated = false,
	showGeneration = true,
}: {
	project: Pick<EditingProjectView, "renders" | "currentRevisionId">;
	disabled: boolean;
	generationDisabled: boolean;
	onGenerate: (kind: "PREVIEW" | "EXPORT") => void;
	onCancel: (id: string) => void;
	previewOutdated?: boolean;
	showGeneration?: boolean;
}) {
	const { t } = useT();
	const preview = project.renders.find(
		(run) =>
			run.kind === "PREVIEW" &&
			run.revisionId === project.currentRevisionId &&
			run.state === "SUCCEEDED" &&
			run.artifact,
	);
	const active = (kind: "PREVIEW" | "EXPORT") =>
		project.renders.some(
			(run) =>
				run.kind === kind &&
				run.revisionId === project.currentRevisionId &&
				!["SUCCEEDED", "ERROR", "FAILED", "CANCELED"].includes(run.state),
		);
	return (
		<section className="min-w-0 space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
			<h2 className="font-semibold">{t("editing.preview")}</h2>
			{preview?.artifact && previewOutdated && (
				<p role="status" className="text-amber-200 text-xs">
					{t("editing.generatedPreviewStale")}
				</p>
			)}
			{preview?.artifact ? (
				<details>
					<summary className="cursor-pointer text-sm text-zinc-300">
						{t("editing.generatedInspect")}
					</summary>
					<video
						controls
						muted
						playsInline
						preload="metadata"
						src={preview.artifact.url}
						className="max-h-96 w-full rounded-md bg-black"
						aria-label={t("editing.preview")}
					/>
				</details>
			) : (
				<p className="text-sm text-zinc-400">{t("editing.previewHelp")}</p>
			)}
			{showGeneration && (
				<div className="flex flex-wrap gap-2">
					<Button
						disabled={generationDisabled || active("PREVIEW")}
						onClick={() => onGenerate("PREVIEW")}
					>
						{t("editing.previewAction")}
					</Button>
					<Button
						variant="secondary"
						disabled={generationDisabled || active("EXPORT")}
						onClick={() => onGenerate("EXPORT")}
					>
						{t("editing.export")}
					</Button>
				</div>
			)}
			{showGeneration && !project.currentRevisionId && (
				<p className="text-xs text-zinc-400">{t("editing.revisionNeeded")}</p>
			)}
			<h3 className="border-zinc-800 border-t pt-4 font-medium text-sm">
				{t("editing.renders")}
			</h3>
			{project.renders.length === 0 && (
				<p className="text-sm text-zinc-400">{t("editing.noRenders")}</p>
			)}
			<ul className="space-y-3">
				{project.renders.map((run) => (
					<li
						key={run.id}
						className="space-y-2 border-zinc-800 border-b pb-3 text-sm"
					>
						<p>
							{t(run.kind === "PREVIEW" ? "editing.preview" : "editing.export")}{" "}
							· {editingStateLabel(run.state, t)}
						</p>
						{run.error && (
							<p className="break-words text-red-400">
								{editingErrorMessage(run.error, t)}
							</p>
						)}
						{run.artifact && (
							<a
								href={run.artifact.downloadUrl}
								className="text-emerald-400 underline"
							>
								{t(
									run.kind === "PREVIEW" ? "editing.preview" : "editing.export",
								)}
							</a>
						)}
						{run.artifact?.derivedContentId && (
							<Link
								href={`/library/${run.artifact.derivedContentId}`}
								className="block text-emerald-400 underline"
							>
								{t("editing.derived")}
							</Link>
						)}
						{![
							"SUCCEEDED",
							"ERROR",
							"FAILED",
							"CANCELED",
							"CANCEL_REQUESTED",
						].includes(run.state) && (
							<Button
								size="sm"
								variant="secondary"
								disabled={disabled}
								onClick={() => onCancel(run.id)}
							>
								{t("editing.cancel")}
							</Button>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}

export function CurrentExportStatus({
	project,
	outdated,
}: {
	project: Pick<EditingProjectView, "id" | "renders" | "currentRevisionId">;
	outdated: boolean;
}) {
	const { t } = useT(),
		c = useCompositionCopy();
	const latest = project.renders
		.filter((run) => run.kind === "EXPORT")
		.reduce<EditingProjectView["renders"][number] | undefined>(
			(prior, run) =>
				!prior || run.generation > prior.generation ? run : prior,
			undefined,
		);
	if (!latest) return null;
	const artifact = latest.state === "SUCCEEDED" ? latest.artifact : null;
	return (
		<section className="min-w-0 space-y-2 rounded-lg border border-zinc-800 p-4 text-sm">
			<h2 className="font-semibold">{c.currentOutput}</h2>
			<p role="status" aria-label={c.outputStatus}>
				{editingStateLabel(latest.state, t)}
			</p>
			{(outdated || latest.revisionId !== project.currentRevisionId) && (
				<p className="text-amber-300">
					{t("editing.autoPortrait.earlierRevision")}
				</p>
			)}
			{latest.error && (
				<p className="break-words text-amber-300">
					{editingErrorMessage(latest.error, t)}
				</p>
			)}
			<div className="flex flex-wrap gap-4">
				<Link
					href={`/library/edits/${project.id}/result`}
					className="text-emerald-400 underline"
				>
					{c.viewOutput}
				</Link>
				{artifact && (
					<a href={artifact.downloadUrl} className="text-emerald-400 underline">
						{t("editing.autoPortrait.download")}
					</a>
				)}
			</div>
		</section>
	);
}
