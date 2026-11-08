"use client";
import { type CompositionDocument, mediaTaskCreateSchema } from "@bitovp/core";
import { useQuery } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import type { AnyEditingProjectView } from "@/lib/library-editing";
import type { EditingEligibility } from "../../[id]/edits/editing-forms";
import {
	GenerationControls,
	type GenerationIntent,
} from "../../[id]/edits/generation-controls";
import { wholeFramesForDuration } from "../../[id]/edits/generation-settings";
import { useReproposalCopy } from "./reproposal-copy";
import { reproposalDefaults } from "./reproposal-settings";

type Snapshot = {
	document: CompositionDocument;
	project: AnyEditingProjectView;
	actorIdentity: string | null;
};

export function ReproposalDialog({
	project,
	document,
	actorIdentity,
	dirty,
	disabled,
	onReframe,
	beforeStart,
	onBusyChange,
}: {
	project: AnyEditingProjectView;
	document: CompositionDocument;
	actorIdentity: string | null;
	dirty: boolean;
	disabled: boolean;
	onReframe(value: "AUTO" | "FILL" | "FIT"): void;
	beforeStart(signal: AbortSignal): Promise<void>;
	onBusyChange(value: boolean): void;
}) {
	const c = useReproposalCopy(),
		{ t } = useT(),
		id = useId();
	const canMutate = useMutationAccess("library.edits.edit");
	const [open, setOpen] = useState(false),
		[busy, setBusy] = useState(false);
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [seconds, setSeconds] = useState("30");
	const intent = useRef<GenerationIntent | null>(null);
	const query = useQuery({
		queryKey: [
			"reproposal-source",
			snapshot?.project.media.sourceId,
			snapshot?.actorIdentity,
		],
		enabled:
			open &&
			!!snapshot?.document.analysisRevisionId &&
			!!snapshot?.actorIdentity,
		refetchOnMount: "always",
		queryFn: ({ signal }) =>
			apiFetch<EditingEligibility>(
				`/api/library/sources/${snapshot?.project.media.sourceId}/editing-eligibility`,
				{ signal },
			),
	});
	const uncertain = intent.current?.uncertain === true;
	const locked = disabled || !canMutate || busy;
	const changeOpen = (value: boolean) => {
		if (!value && busy && !intent.current?.uncertain) return;
		if (value) {
			const sameSource =
				snapshot?.document.mediaVersionId === document.mediaVersionId &&
				snapshot.document.analysisRevisionId === document.analysisRevisionId &&
				snapshot.actorIdentity === actorIdentity;
			if (!intent.current?.uncertain || !sameSource) {
				intent.current = null;
				setSnapshot(structuredClone({ document, project, actorIdentity }));
				setSeconds(
					String(
						reproposalDefaults(document, { localStory: false, japanese: false })
							.targetDurationFrames / 30,
					),
				);
			}
		} else {
			setBusy(false);
			onBusyChange(false);
			requestAnimationFrame(() =>
				globalThis.document.getElementById(id)?.focus(),
			);
		}
		setOpen(value);
	};
	const eligible = query.data;
	const media = eligible?.mediaVersions.find(
		(m) => m.id === snapshot?.document.mediaVersionId && m.state === "READY",
	);
	const analysis = eligible?.analyses.find(
		(a) => a.id === snapshot?.document.analysisRevisionId,
	);
	const frames = wholeFramesForDuration(seconds);
	const defaults =
		snapshot &&
		reproposalDefaults(snapshot.document, {
			localStory: eligible?.localStoryAvailable === true,
			japanese: eligible?.captionTranslationAvailable === true,
		});
	const held = intent.current?.uncertain
		? mediaTaskCreateSchema.safeParse(JSON.parse(intent.current.body))
		: null;
	const heldSettings =
		held?.success && held.data.kind === "GENERATE"
			? held.data.parameters
			: null;
	return (
		<>
			<Button
				id={id}
				variant="secondary"
				disabled={disabled || !canMutate}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => changeOpen(true)}
			>
				{c.open}
			</Button>
			<Dialog open={open} onOpenChange={changeOpen} title={c.title} wide>
				<section className="space-y-3">
					<h2 className="font-medium text-sm">{c.currentFraming}</h2>
					<p className="text-xs text-zinc-400">{c.framingHelp}</p>
					<div className="flex flex-wrap gap-2">
						{(
							[
								["FILL", c.fill],
								["AUTO", c.auto],
								["FIT", c.fit],
							] as const
						).map(([mode, label]) => (
							<Button
								key={mode}
								size="sm"
								variant="secondary"
								disabled={locked || uncertain}
								onClick={() => {
									onReframe(mode);
									changeOpen(false);
								}}
							>
								{label}
							</Button>
						))}
					</div>
				</section>
				<div className="mt-5">
					{!snapshot?.document.analysisRevisionId ? (
						<p className="text-sm text-zinc-400">{c.missingAnalysis}</p>
					) : query.isError ? (
						<div className="flex flex-wrap gap-3 text-sm">
							<p>{c.loadFailed}</p>
							<Button
								size="sm"
								variant="secondary"
								onClick={() => void query.refetch()}
							>
								{c.retry}
							</Button>
						</div>
					) : query.isSuccess && (!media || !analysis) ? (
						<p className="text-sm text-zinc-400">{c.sourceUnavailable}</p>
					) : !media || !analysis || !defaults ? (
						<p role="status" className="text-sm text-zinc-400">
							{c.loading}
						</p>
					) : (
						<GenerationControls
							contentId={snapshot.project.contentId}
							mediaVersionId={media.id}
							analysisRevisionId={analysis.id}
							targetDurationFrames={frames}
							disabled={
								disabled ||
								!canMutate ||
								snapshot.actorIdentity !== actorIdentity
							}
							renderMode="DRAFT"
							localStoryAvailable={eligible?.localStoryAvailable === true}
							hasAudio={
								snapshot.project.compositionSources?.find(
									(source) => source.mediaVersionId === media.id,
								)?.hasAudio
							}
							captionTranslationAvailable={
								eligible?.captionTranslationAvailable === true
							}
							initialSettings={heldSettings ?? defaults.settings}
							requestStore={intent}
							beforeStart={beforeStart}
							onBusyChange={(value) => {
								setBusy(value);
								onBusyChange(value);
							}}
							labels={{
								title: c.newTitle,
								help: c.newHelp,
								submit: dirty ? c.saveCreate : c.create,
							}}
						>
							<div className="space-y-3">
								<Field
									label={t("editing.autoPortrait.duration")}
									htmlFor={`${id}-seconds`}
									error={
										frames === null
											? t("editing.autoPortrait.durationInvalid")
											: undefined
									}
								>
									<Input
										id={`${id}-seconds`}
										type="number"
										inputMode="decimal"
										min={1}
										max={180}
										step="any"
										value={seconds}
										disabled={locked || uncertain}
										onChange={(event) => setSeconds(event.target.value)}
									/>
								</Field>
								{dirty && (
									<p className="text-xs text-zinc-400">{c.savingHelp}</p>
								)}
							</div>
						</GenerationControls>
					)}
				</div>
			</Dialog>
		</>
	);
}
