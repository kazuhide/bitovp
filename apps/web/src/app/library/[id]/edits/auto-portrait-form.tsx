"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import { editingErrorMessage } from "../../edits/editing-errors";
import type { EditingEligibility } from "./editing-forms";
import { GenerationControls } from "./generation-controls";
import { wholeFramesForDuration as wholeFrames } from "./generation-settings";
import { PrepareGenerationControls } from "./prepare-generation-controls";
import { useProductionCopy } from "./production-copy";

const generationResponse = z.object({ projectId: z.uuid() });
type Props = {
	contentId: string;
	initialTitle: string;
	eligibility: EditingEligibility;
	disabled: boolean;
	onBusyChange?(busy: boolean): void;
};
export function AutoPortraitForm({
	contentId,
	initialTitle,
	eligibility,
	disabled,
}: Props) {
	const { t } = useT();
	const copy = useProductionCopy();
	const id = useId();
	const [advanced, setAdvanced] = useState(false);
	const [advancedBusy, setAdvancedBusy] = useState(false);
	const [prepareOpen, setPrepareOpen] = useState(false);
	const [prepareBusy, setPrepareBusy] = useState(false);
	const [explicitMedia, setExplicitMedia] = useState(false);
	const [mediaId, setMediaId] = useState("");
	const [analysisId, setAnalysisId] = useState("");
	const [seconds, setSeconds] = useState("30");
	const ready = eligibility.mediaVersions.filter(
		(media) =>
			media.state === "READY" && media.sourceId === eligibility.sourceId,
	);
	const selectedMedia =
		ready.find((media) => media.id === mediaId) ??
		(explicitMedia ? undefined : ready[0]);
	const selectedAnalysis =
		eligibility.analyses.find((analysis) => analysis.id === analysisId) ??
		eligibility.analyses[0];
	const frames = wholeFrames(seconds);
	const { busy, error, uncertain, generate, clearError } =
		usePortraitGeneration(
			selectedMedia && selectedAnalysis && frames !== null
				? {
						contentId,
						mediaVersionId: selectedMedia.id,
						analysisRevisionId: selectedAnalysis.id,
						targetDurationFrames: frames,
					}
				: null,
			disabled || advancedBusy || prepareBusy,
		);
	const blocked = disabled || busy || advancedBusy || prepareBusy;
	return (
		<>
			<form
				aria-labelledby={`${id}-title`}
				aria-busy={busy}
				noValidate
				onSubmit={(event) => {
					event.preventDefault();
					void generate();
				}}
				className="min-w-0 space-y-4 rounded-lg border border-zinc-800 bg-zinc-950 p-4 sm:p-6"
			>
				<header className="space-y-2">
					<h2 id={`${id}-title`} className="font-semibold text-lg">
						{t("editing.autoPortrait.title")}
					</h2>
					<p className="max-w-prose text-sm text-zinc-400">
						{t("editing.autoPortrait.help")}
					</p>
				</header>
				{disabled && (
					<p className="text-sm text-zinc-400">{t("editing.readOnly")}</p>
				)}
				{!ready.length && (
					<p role="status" className="text-amber-300 text-sm">
						{t("editing.autoPortrait.noReadyMedia")}
					</p>
				)}
				{!eligibility.analyses.length && (
					<p role="status" className="text-amber-300 text-sm">
						{t("editing.autoPortrait.noAnalyses")}
					</p>
				)}
				<PortraitInputs
					id={id}
					initialTitle={initialTitle}
					ready={ready}
					analyses={eligibility.analyses}
					mediaId={selectedMedia?.id ?? ""}
					analysisId={selectedAnalysis?.id ?? ""}
					seconds={seconds}
					disabled={blocked}
					onMediaChange={(value) => {
						clearError();
						setMediaId(value);
						setExplicitMedia(false);
					}}
					onAnalysisChange={(value) => {
						clearError();
						setAnalysisId(value);
					}}
					onSecondsChange={(value) => {
						clearError();
						setSeconds(value);
					}}
				/>
				{error && (
					<div
						role="alert"
						className="space-y-1 break-words text-amber-300 text-sm"
					>
						<p>{error}</p>
						{uncertain && <p>{t("editing.autoPortrait.unknownRetry")}</p>}
					</div>
				)}
				<p className="text-sm text-zinc-400">
					{t("editing.autoPortrait.limitations")}
				</p>
				<Button
					type="submit"
					className="w-full whitespace-normal"
					disabled={
						blocked || !selectedMedia || !selectedAnalysis || frames === null
					}
				>
					<span aria-live="polite">
						{t(
							busy
								? "editing.autoPortrait.generating"
								: "editing.autoPortrait.generate",
						)}
					</span>
				</Button>
			</form>
			{eligibility.files.length > 0 && (
				<>
					<Button
						variant="secondary"
						aria-expanded={prepareOpen}
						aria-controls={`${id}-prepare`}
						disabled={blocked}
						onClick={() => setPrepareOpen((value) => !value)}
					>
						{copy.prepareGenerateTitle}
					</Button>
					<div id={`${id}-prepare`}>
						{prepareOpen && (
							<PrepareGenerationControls
								contentId={contentId}
								eligibility={eligibility}
								analysisRevisionId={selectedAnalysis?.id ?? ""}
								targetDurationFrames={frames}
								disabled={disabled || busy || advancedBusy}
								onBusyChange={setPrepareBusy}
								onReturn={() => {
									setPrepareOpen(false);
									setMediaId("");
									setExplicitMedia(true);
									setAdvanced(false);
								}}
							/>
						)}
					</div>
				</>
			)}
			<Button
				variant="secondary"
				aria-expanded={advanced}
				aria-controls={`${id}-advanced`}
				disabled={blocked || !selectedMedia || !selectedAnalysis}
				onClick={() => setAdvanced((value) => !value)}
			>
				{advanced ? copy.close : copy.advanced}
			</Button>
			<div id={`${id}-advanced`}>
				{advanced && selectedMedia && selectedAnalysis && (
					<GenerationControls
						key={`${selectedMedia.id}:${selectedAnalysis.id}`}
						contentId={contentId}
						mediaVersionId={selectedMedia.id}
						analysisRevisionId={selectedAnalysis.id}
						targetDurationFrames={frames}
						disabled={disabled || busy || prepareBusy}
						onBusyChange={setAdvancedBusy}
					/>
				)}
			</div>
		</>
	);
}

function PortraitInputs({
	id,
	initialTitle,
	ready,
	analyses,
	mediaId,
	analysisId,
	seconds,
	disabled,
	onMediaChange,
	onAnalysisChange,
	onSecondsChange,
}: {
	id: string;
	initialTitle: string;
	ready: EditingEligibility["mediaVersions"];
	analyses: EditingEligibility["analyses"];
	mediaId: string;
	analysisId: string;
	seconds: string;
	disabled: boolean;
	onMediaChange: (value: string) => void;
	onAnalysisChange: (value: string) => void;
	onSecondsChange: (value: string) => void;
}) {
	const { t } = useT();
	const frames = wholeFrames(seconds);
	return (
		<>
			<Field label={t("editing.autoPortrait.media")} htmlFor={`${id}-media`}>
				<SelectNative
					id={`${id}-media`}
					value={mediaId}
					disabled={disabled || !ready.length}
					onChange={(event) => {
						onMediaChange(event.target.value);
					}}
				>
					{!mediaId && (
						<option value="">
							{ready.length
								? t("editing.mediaVersions")
								: t("editing.autoPortrait.noReadyMedia")}
						</option>
					)}
					{ready.map((media, index) => (
						<option key={media.id} value={media.id}>
							{index + 1}: {initialTitle} ·{" "}
							{((media.durationUs ?? 0) / 1_000_000).toFixed(1)}s ·{" "}
							{media.width}×{media.height}
						</option>
					))}
				</SelectNative>
			</Field>
			<Field
				label={t("editing.autoPortrait.analysis")}
				htmlFor={`${id}-analysis`}
				hint={t("editing.autoPortrait.analysisHelp")}
			>
				<SelectNative
					id={`${id}-analysis`}
					value={analysisId}
					disabled={disabled || !analyses.length}
					onChange={(event) => {
						onAnalysisChange(event.target.value);
					}}
				>
					{!analyses.length && (
						<option value="">{t("editing.autoPortrait.noAnalyses")}</option>
					)}
					{analyses.map((analysis) => (
						<option key={analysis.id} value={analysis.id}>
							{analysis.locale}: {analysis.title}
						</option>
					))}
				</SelectNative>
			</Field>
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
					type="number"
					inputMode="decimal"
					min={1}
					max={180}
					step="any"
					required
					value={seconds}
					disabled={disabled}
					aria-invalid={frames === null}
					onChange={(event) => {
						onSecondsChange(event.target.value);
					}}
				/>
			</Field>
			<div className="flex flex-wrap gap-2">
				{[15, 30, 60].map((value) => (
					<Button
						key={value}
						size="sm"
						variant="secondary"
						disabled={disabled}
						aria-pressed={frames === value * 30}
						onClick={() => {
							onSecondsChange(String(value));
						}}
					>
						{t("editing.autoPortrait.presetSeconds", { seconds: value })}
					</Button>
				))}
			</div>
		</>
	);
}

type GenerationInput = {
	contentId: string;
	mediaVersionId: string;
	analysisRevisionId: string;
	targetDurationFrames: number;
};
function usePortraitGeneration(
	input: GenerationInput | null,
	disabled: boolean,
) {
	const { t } = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [uncertain, setUncertain] = useState(false);
	const submitting = useRef(false);
	const mounted = useRef(true);
	const request = useRef<{ identity: string; key: string } | null>(null);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	async function generate() {
		if (disabled || submitting.current || !input) return;
		submitting.current = true;
		setBusy(true);
		setError("");
		setUncertain(false);
		const identity = JSON.stringify(input);
		if (request.current?.identity !== identity)
			request.current = { identity, key: crypto.randomUUID() };
		let navigating = false;
		try {
			const response = generationResponse.parse(
				await apiFetch<unknown>("/api/library/portrait-generations", {
					method: "POST",
					body: JSON.stringify({ ...input, requestKey: request.current.key }),
				}),
			);
			if (mounted.current) {
				router.push(`/library/edits/${response.projectId}/result`);
				navigating = true;
			}
		} catch (failure) {
			const unknown = !(failure instanceof ApiError) || failure.status >= 500;
			if (!unknown) request.current = null;
			if (mounted.current) {
				setError(editingErrorMessage(failure, t));
				setUncertain(unknown);
			}
		} finally {
			if (!navigating) {
				submitting.current = false;
				if (mounted.current) setBusy(false);
			}
		}
	}

	return {
		busy,
		error,
		uncertain,
		generate,
		clearError: () => {
			setError("");
			setUncertain(false);
		},
	};
}
