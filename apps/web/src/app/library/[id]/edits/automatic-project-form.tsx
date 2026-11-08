"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";
import type { AutomaticEditingContext } from "@/lib/library-editing";
import type { EditingEligibility } from "./editing-forms";
import { GenerationControls } from "./generation-controls";
import { wholeFramesForDuration } from "./generation-settings";
import { PrepareGenerationControls } from "./prepare-generation-controls";
import { useProductionCopy } from "./production-copy";

export function AutomaticProjectForm({
	contentId,
	initialTitle,
	eligibility,
	context,
	disabled,
	onBusyChange: notifyBusy,
}: {
	contentId: string;
	initialTitle: string;
	eligibility: EditingEligibility;
	context: AutomaticEditingContext;
	disabled: boolean;
	onBusyChange?(busy: boolean): void;
}) {
	const c = useProductionCopy(),
		{ t } = useT(),
		id = useId();
	const [seconds, setSeconds] = useState("30"),
		[busy, setBusy] = useState(false),
		[reserved, setReserved] = useState<{
			context: AutomaticEditingContext;
			eligibility: EditingEligibility;
		} | null>(null);
	const latestReservation = useRef({ context, eligibility });
	latestReservation.current = { context, eligibility };
	const onBusyChange = useCallback(
		(value: boolean) => {
			setReserved((previous) =>
				value ? (previous ?? structuredClone(latestReservation.current)) : null,
			);
			setBusy(value);
			notifyBusy?.(value);
		},
		[notifyBusy],
	);
	useEffect(() => () => notifyBusy?.(false), [notifyBusy]);
	const onReturn = useCallback(() => {
		setReserved(null);
		setBusy(false);
	}, []);
	// A normal eligibility poll must not replace an already reserved source or intent.
	const selected = reserved?.context ?? context;
	const selectedEligibility = reserved?.eligibility ?? eligibility;
	const frames = wholeFramesForDuration(seconds);
	const analysis = selectedEligibility.analyses.find(
		(item) => item.id === selected.analysisRevisionId,
	);
	const media = selectedEligibility.mediaVersions.find(
		(item) =>
			item.id === selected.mediaVersionId &&
			item.sourceId === selectedEligibility.sourceId &&
			item.state === "READY",
	);
	const ready =
		!!media &&
		!!analysis &&
		["READY", "NEEDS_CONFIRMATION"].includes(selected.status);
	const prepare =
		selected.status === "NEEDS_PREPARATION" &&
		!!analysis &&
		!!selected.preparation &&
		selectedEligibility.files.some(
			(file) => file.key === selected.preparation?.fileKey,
		);
	const available = ready || prepare;
	const contextHelp =
		selected.status === "PREPARING"
			? c.contextPreparing
			: selected.status === "ANALYSIS_PENDING"
				? c.contextAnalysisPending
				: selected.status === "NEEDS_PREPARATION" && prepare
					? c.contextNeedsPreparation
					: selected.status === "NEEDS_CONFIRMATION" && ready
						? c.contextNeedsConfirmation
						: selected.status === "READY" && ready
							? c.contextLoaded
							: c.contextUnavailable;
	const fields = (formId?: string) => (
		<div className="min-w-0 space-y-4">
			<p
				role="status"
				className={
					available ? "text-sm text-zinc-400" : "text-amber-300 text-sm"
				}
			>
				{contextHelp}
			</p>
			{selected.encodingId && (
				<dl className="grid min-w-0 gap-2 text-sm sm:grid-cols-2">
					<div className="min-w-0">
						<dt className="text-xs text-zinc-400">{c.encoding}</dt>
						<dd className="break-all">{selected.encodingId}</dd>
					</div>
					{analysis && (
						<div className="min-w-0">
							<dt className="text-xs text-zinc-400">
								{t("editing.autoPortrait.analysis")}
							</dt>
							<dd className="break-words">
								{analysis.locale}: {analysis.title}
							</dd>
						</div>
					)}
					{media && (
						<div className="min-w-0">
							<dt className="text-xs text-zinc-400">
								{t("editing.autoPortrait.media")}
							</dt>
							<dd className="break-words">
								{initialTitle} ·{" "}
								{((media.durationUs ?? 0) / 1_000_000).toFixed(1)}s
							</dd>
						</div>
					)}
				</dl>
			)}
			<Field
				label={t("editing.autoPortrait.duration")}
				htmlFor={`${id}-seconds`}
				hint={t("editing.autoPortrait.durationHelp")}
				error={
					frames === null
						? t("editing.autoPortrait.durationInvalid")
						: undefined
				}
			>
				<Input
					id={`${id}-seconds`}
					form={formId}
					type="number"
					inputMode="decimal"
					min={1}
					max={180}
					step="any"
					required
					value={seconds}
					disabled={disabled || busy || !available}
					aria-invalid={frames === null}
					onChange={(event) => setSeconds(event.target.value)}
				/>
			</Field>
			<div className="flex flex-wrap gap-2">
				{[15, 30, 60].map((value) => (
					<Button
						key={value}
						variant="secondary"
						size="sm"
						aria-pressed={seconds === String(value)}
						disabled={disabled || busy || !available}
						onClick={() => setSeconds(String(value))}
					>
						{t("editing.autoPortrait.presetSeconds", { seconds: value })}
					</Button>
				))}
			</div>
			<p className="text-sm text-zinc-400">{c.projectDraftOnly}</p>
		</div>
	);
	if (ready && media && analysis)
		return (
			<GenerationControls
				key={`${media.id}:${analysis.id}`}
				contentId={contentId}
				mediaVersionId={media.id}
				analysisRevisionId={analysis.id}
				targetDurationFrames={frames}
				disabled={disabled}
				renderMode="DRAFT"
				localStoryAvailable={selectedEligibility.localStoryAvailable === true}
				captionTranslationAvailable={
					selectedEligibility.captionTranslationAvailable === true
				}
				hasAudio={selected.hasAudio ?? undefined}
				onBusyChange={onBusyChange}
			>
				{fields}
			</GenerationControls>
		);
	if (prepare && selected.preparation && analysis)
		return (
			<PrepareGenerationControls
				contentId={contentId}
				eligibility={selectedEligibility}
				analysisRevisionId={analysis.id}
				targetDurationFrames={frames}
				disabled={disabled}
				renderMode="DRAFT"
				preparationTarget={selected.preparation}
				hasAudio={selected.hasAudio ?? undefined}
				onBusyChange={onBusyChange}
				onReturn={onReturn}
			>
				{fields}
			</PrepareGenerationControls>
		);
	return (
		<section className="min-w-0 space-y-4 rounded-lg border border-zinc-800 bg-zinc-950 p-4 sm:p-6">
			<h2 className="font-semibold text-lg">{c.projectCreate}</h2>
			{fields()}
			<Button className="w-full" disabled>
				{c.projectCreate}
			</Button>
		</section>
	);
}
