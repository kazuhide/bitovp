"use client";

import {
	cfrTimeMapSchema,
	mediaTaskCreateSchema,
	mediaTaskReceiptSchema,
} from "@bitovp/core";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { z } from "zod";
import { useDocumentOrganization } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { ApiError, apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useSession } from "@/lib/auth/use-session";
import { useT } from "@/lib/i18n/context";
import { editingErrorMessage } from "../../edits/editing-errors";
import { AssociationReview } from "./association-review";
import { type EditingEligibility, MediaPreparation } from "./editing-forms";
import {
	GenerationSettings,
	type GenerationSettingsValue,
} from "./generation-settings";
import { productionFailure, useProductionCopy } from "./production-copy";

const mediaIdentity = z.object({
	id: z.uuid(),
	sourceId: z.uuid(),
	state: z.enum(["PENDING", "PREPARING", "RUNNING", "READY", "ERROR"]),
	error: z.string().nullable().optional(),
});
const readyMedia = mediaIdentity.extend({
	state: z.literal("READY"),
	durationUs: z.number().int().positive(),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	timeMap: cfrTimeMapSchema,
	url: z.string(),
});
const associationResponse = z.object({
	association: z.string(),
	media: readyMedia,
	analysis: z.object({ id: z.uuid() }),
});
const verifiedAssociation = new Set([
	"CAPTURED_INPUT",
	"FIXTURE_AUTHORED",
	"EDITOR_ATTESTED",
]);
const aborted = () => new DOMException("Reservation stopped", "AbortError");
function delay(signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const stop = () => {
			clearTimeout(timer);
			reject(aborted());
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", stop);
			resolve();
		}, 3000);
		signal.addEventListener("abort", stop, { once: true });
		if (signal.aborted) stop();
	});
}
const unknownOutcome = (error: unknown) =>
	!(error instanceof ApiError) || error.status >= 500;
type Intent = {
	epoch: number;
	identity: string;
	contentId: string;
	sourceId: string;
	fileKey: string;
	fileLabel: string;
	output: { credentialId: string; bucket: string; prefix: string };
	analysisRevisionId: string;
	analysisLabel: string;
	frames: number;
	settings: GenerationSettingsValue;
	renderMode?: "DRAFT" | "EXPORT";
	draftPolicyVersion?: "duration-review-v2";
	requestKey: string;
	controller: AbortController;
	mediaVersionId?: string;
	generationBody?: string;
};
type GenerationReceipt = {
	intent: Intent;
	controller: AbortController;
	navigationCancelled: boolean;
};
type Phase =
	| "draft"
	| "preparing"
	| "checking"
	| "review"
	| "generating"
	| "generationUnknown"
	| "preparationUnknown"
	| "stopped"
	| "done";
type View = { phase: Phase; intent?: Intent; error?: string };

export function PrepareGenerationControls({
	contentId,
	eligibility,
	analysisRevisionId,
	targetDurationFrames,
	disabled,
	onBusyChange,
	onReturn,
	renderMode,
	preparationTarget,
	hasAudio,
	children,
}: {
	contentId: string;
	eligibility: EditingEligibility;
	analysisRevisionId: string;
	targetDurationFrames: number | null;
	disabled: boolean;
	onBusyChange(busy: boolean): void;
	onReturn(): void;
	renderMode?: "DRAFT" | "EXPORT";
	preparationTarget?: {
		fileKey: string;
		output: { credentialId: string; bucket: string; prefix: string };
	};
	hasAudio?: boolean;
	children?: ReactNode | ((formId: string) => ReactNode);
}) {
	const c = useProductionCopy(),
		{ t } = useT(),
		id = useId(),
		router = useRouter(),
		client = useQueryClient();
	const organizationId = useDocumentOrganization();
	const canPrepare = useMutationAccess("library.edits.prepare"),
		canEdit = useMutationAccess("library.edits.edit");
	const mayContinue =
		renderMode === "DRAFT" ? c.projectMayContinue : c.generationMayContinue;
	const waitStopped =
		renderMode === "DRAFT" ? c.projectWaitStopped : c.preparationContinues;
	const preparationUnknown =
		renderMode === "DRAFT"
			? c.projectPreparationUnknown
			: c.preparationOutcomeUnknown;
	const cancelLabel =
		renderMode === "DRAFT" ? c.stopProjectWait : c.cancelGenerationReservation;
	const continueLabel =
		renderMode === "DRAFT"
			? c.continueProjectCreation
			: c.continueReservedGeneration;
	const retryLabel =
		renderMode === "DRAFT" ? c.retrySameProject : c.retrySameGeneration;
	const progressLabel =
		renderMode === "DRAFT" ? c.projectProgress : c.progressTitle;
	const startingLabel = renderMode === "DRAFT" ? c.projectProgress : c.starting;
	const [settings, setSettings] = useState<GenerationSettingsValue>({
		policy:
			renderMode === "DRAFT"
				? eligibility.localStoryAvailable
					? "LOCAL_STORY"
					: "AUTO"
				: "COHESION",
		...(renderMode === "DRAFT" && eligibility.localStoryAvailable
			? { storyMode: "AUTO" as const }
			: {}),
		templateId: "portrait-clean",
		variants: 1,
		captions: renderMode === "DRAFT" && hasAudio !== false ? "AUTO" : "OFF",
		tracking: renderMode === "DRAFT",
		language: "auto",
		...(renderMode === "DRAFT"
			? {
					presentation: {
						version: "portrait-layout-v1" as const,
						videoFit: "AUTO" as const,
						fallbackFraming: "PRESERVE_SOURCE_V1" as const,
						captionPlacement: "OVERLAY" as const,
					},
				}
			: {}),
	});
	const [view, setView] = useState<View>({ phase: "draft" }),
		[reviewVerified, setReviewVerified] = useState(false),
		[reviewVersion, setReviewVersion] = useState(0),
		[acknowledgedTask, setAcknowledgedTask] = useState<string | null>(null);
	const generationReceipt = useRef<GenerationReceipt | null>(null);
	const active = useRef<Intent | null>(null),
		epoch = useRef(0),
		mounted = useRef(true);
	const session = useSession();
	const currentSession =
		session.status === "success" ? session.data : undefined;
	const actorIdentity =
		currentSession?.configured &&
		currentSession.authenticated &&
		!currentSession.organizationUnavailable &&
		!currentSession.isImpersonating &&
		(currentSession.mode !== "users" ||
			(z.uuid().safeParse(currentSession.actorUserId).success &&
				z.uuid().safeParse(currentSession.effectiveUserId).success &&
				(!organizationId || currentSession.organizationId === organizationId)))
			? JSON.stringify([
					currentSession.mode,
					currentSession.mode === "users" ? currentSession.actorUserId : null,
					currentSession.mode === "users"
						? currentSession.effectiveUserId
						: null,
					currentSession.organizationId ?? organizationId,
				])
			: null;
	const identity = JSON.stringify({
		contentId,
		sourceId: eligibility.sourceId,
		analysisRevisionId,
		targetDurationFrames,
		organizationId,
		actorIdentity,
		renderMode,
		preparationTarget,
		hasAudio,
	});
	const latest = useRef({
		identity,
		allowed: canPrepare && canEdit && !disabled && actorIdentity !== null,
	});
	latest.current = {
		identity,
		allowed: canPrepare && canEdit && !disabled && actorIdentity !== null,
	};
	const isActive = useCallback(
		(intent: Intent) =>
			mounted.current &&
			active.current === intent &&
			!intent.controller.signal.aborted &&
			latest.current.identity === intent.identity &&
			latest.current.allowed,
		[],
	);
	const isCurrentReceipt = useCallback(
		(receipt: GenerationReceipt) =>
			mounted.current &&
			generationReceipt.current === receipt &&
			active.current === receipt.intent &&
			latest.current.identity === receipt.intent.identity &&
			latest.current.allowed,
		[],
	);
	const stop = useCallback(
		(message: string) => {
			generationReceipt.current?.controller.abort();
			generationReceipt.current = null;
			active.current?.controller.abort();
			active.current = null;
			setReviewVerified(false);
			setView((old) => ({ ...old, phase: "stopped", error: message }));
			onBusyChange(false);
		},
		[onBusyChange],
	);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			generationReceipt.current?.controller.abort();
			generationReceipt.current = null;
			active.current?.controller.abort();
			active.current = null;
			onBusyChange(false);
		};
	}, [onBusyChange]);
	useEffect(() => {
		if (
			active.current &&
			(active.current.identity !== identity ||
				disabled ||
				!canPrepare ||
				!canEdit)
		)
			stop(generationReceipt.current ? mayContinue : waitStopped);
	}, [identity, disabled, canPrepare, canEdit, stop, waitStopped, mayContinue]);
	const reviewEpoch = view.intent?.epoch;
	const onVerified = useCallback(
		(value: boolean) => {
			if (active.current?.epoch === reviewEpoch) setReviewVerified(value);
		},
		[reviewEpoch],
	);
	const reserved = !["draft", "stopped"].includes(view.phase);
	const blocked =
		disabled || !canPrepare || !canEdit || actorIdentity === null || reserved;
	const selectable =
		eligibility.analyses.some((a) => a.id === analysisRevisionId) &&
		targetDurationFrames !== null;
	const requestSignal = (intent: Intent) =>
		AbortSignal.any([intent.controller.signal, AbortSignal.timeout(20_000)]);
	function requireActive(intent: Intent) {
		if (!isActive(intent)) throw aborted();
	}
	function checkedReady(value: unknown, intent: Intent) {
		const parsed = readyMedia.parse(value);
		if (
			parsed.id !== intent.mediaVersionId ||
			parsed.sourceId !== intent.sourceId ||
			parsed.timeMap.mediaVersionId !== parsed.id ||
			(!parsed.url.startsWith(
				`/api/library/media-versions/${parsed.id}/media?`,
			) &&
				parsed.url !== `/api/library/media-versions/${parsed.id}/media`)
		)
			throw new Error("PREPARED_SOURCE_MISMATCH");
		return parsed;
	}
	async function generate(intent: Intent, recovery?: GenerationReceipt) {
		if (recovery) {
			if (!isCurrentReceipt(recovery) || recovery.intent !== intent) return;
		} else requireActive(intent);
		intent.generationBody ??= JSON.stringify(
			mediaTaskCreateSchema.parse({
				kind: "GENERATE",
				mediaVersionId: intent.mediaVersionId,
				analysisRevisionId: intent.analysisRevisionId,
				requestKey: intent.requestKey,
				parameters: {
					...intent.settings,
					...(intent.renderMode ? { renderMode: intent.renderMode } : {}),
					...(intent.draftPolicyVersion
						? { draftPolicyVersion: intent.draftPolicyVersion }
						: {}),
					...(intent.settings.policy !== "COHESION"
						? { query: undefined }
						: {}),
					contentId: intent.contentId,
					targetDurationFrames: intent.frames,
				},
			}),
		);
		// Canceling the reservation cannot cancel an already accepted server task.
		// Keep its receipt bounded independently, until it is known or explicitly retried.
		const submission: GenerationReceipt = {
			intent,
			controller: new AbortController(),
			navigationCancelled: recovery?.navigationCancelled ?? false,
		};
		generationReceipt.current = submission;
		recovery?.controller.abort();
		setView({
			phase: "generating",
			intent,
			...(submission.navigationCancelled ? { error: mayContinue } : {}),
		});
		try {
			const receipt = mediaTaskReceiptSchema.parse(
				await apiFetch<unknown>("/api/library/media-tasks", {
					method: "POST",
					body: intent.generationBody,
					signal: AbortSignal.any([
						submission.controller.signal,
						AbortSignal.timeout(20_000),
					]),
				}),
			);
			if (!isCurrentReceipt(submission)) return;
			setAcknowledgedTask(receipt.taskId);
			if (!submission.navigationCancelled) {
				setView({ phase: "done", intent });
				router.push(`/library/generations/${receipt.taskId}`);
			} else {
				generationReceipt.current = null;
				active.current = null;
				setView({ phase: "stopped", intent, error: mayContinue });
				onBusyChange(false);
			}
		} catch (failure) {
			if (!isCurrentReceipt(submission)) return;
			if (unknownOutcome(failure))
				setView({
					phase: "generationUnknown",
					intent,
					error: submission.navigationCancelled
						? mayContinue
						: failure instanceof ApiError &&
								failure.message.startsWith("STORY_")
							? productionFailure(failure.message, c)
							: c.unknown,
				});
			else stop(editingErrorMessage(failure, t));
		}
	}
	async function inspect(intent: Intent) {
		requireActive(intent);
		setReviewVerified(false);
		setView({ phase: "checking", intent });
		const query = new URLSearchParams({
			mediaVersionId: intent.mediaVersionId ?? "",
			analysisRevisionId: intent.analysisRevisionId,
		});
		const result = associationResponse.parse(
			await apiFetch<unknown>(`/api/library/analysis-associations?${query}`, {
				signal: requestSignal(intent),
			}),
		);
		requireActive(intent);
		checkedReady(result.media, intent);
		if (result.analysis.id !== intent.analysisRevisionId)
			throw new Error("ANALYSIS_RESPONSE_MISMATCH");
		if (verifiedAssociation.has(result.association)) await generate(intent);
		else {
			setReviewVersion((value) => value + 1);
			setView({ phase: "review", intent });
		}
	}
	async function poll(intent: Intent) {
		const deadline = Date.now() + 15 * 60_000;
		let readFailures = 0;
		while (Date.now() < deadline) {
			requireActive(intent);
			let value: unknown;
			try {
				value = await apiFetch<unknown>(
					`/api/library/media-versions/${intent.mediaVersionId}`,
					{ signal: requestSignal(intent) },
				);
				readFailures = 0;
			} catch (failure) {
				requireActive(intent);
				if (!unknownOutcome(failure)) throw failure;
				if (++readFailures >= 3) throw new Error("PREPARATION_READ_STOPPED");
				await delay(intent.controller.signal);
				continue;
			}
			requireActive(intent);
			if (Date.now() >= deadline) throw new Error("PREPARATION_READ_STOPPED");
			const current = mediaIdentity.parse(value);
			if (
				current.id !== intent.mediaVersionId ||
				current.sourceId !== intent.sourceId
			)
				throw new Error("PREPARED_SOURCE_MISMATCH");
			if (current.state === "READY") {
				checkedReady(value, intent);
				return;
			}
			if (current.state === "ERROR")
				throw new ApiError(422, current.error ?? "PREPARATION_FAILED");
			await delay(intent.controller.signal);
		}
		throw new Error("PREPARATION_READ_STOPPED");
	}
	async function start(fileKey: string, output: Intent["output"]) {
		if (
			active.current ||
			blocked ||
			!selectable ||
			targetDurationFrames === null
		)
			return;
		const file = eligibility.files.find((item) => item.key === fileKey),
			analysis = eligibility.analyses.find(
				(item) => item.id === analysisRevisionId,
			);
		if (!file || !analysis) return;
		const intent: Intent = {
			epoch: ++epoch.current,
			identity,
			contentId,
			sourceId: eligibility.sourceId,
			fileKey,
			fileLabel: file.label,
			output: { ...output },
			analysisRevisionId,
			analysisLabel: analysis.title,
			frames: targetDurationFrames,
			settings: structuredClone({
				...settings,
				...(hasAudio === false ? { captions: "OFF" as const } : {}),
			}),
			...(renderMode ? { renderMode } : {}),
			...(renderMode === "DRAFT"
				? { draftPolicyVersion: "duration-review-v2" as const }
				: {}),
			requestKey: crypto.randomUUID(),
			controller: new AbortController(),
		};
		active.current = intent;
		setAcknowledgedTask(null);
		setView({ phase: "preparing", intent });
		onBusyChange(true);
		try {
			requireActive(intent);
			let response: unknown;
			try {
				response = await apiFetch<unknown>(
					`/api/library/sources/${intent.sourceId}/media-versions`,
					{
						method: "POST",
						body: JSON.stringify({
							fileKey: intent.fileKey,
							output: intent.output,
						}),
						signal: requestSignal(intent),
					},
				);
			} catch (failure) {
				if (!isActive(intent)) return;
				if (unknownOutcome(failure)) {
					intent.controller.abort();
					active.current = null;
					setView({
						phase: "preparationUnknown",
						intent,
						error: preparationUnknown,
					});
					return;
				}
				throw failure;
			}
			requireActive(intent);
			let prepared: z.infer<typeof mediaIdentity>;
			try {
				prepared = mediaIdentity.parse(response);
			} catch {
				intent.controller.abort();
				active.current = null;
				setView({
					phase: "preparationUnknown",
					intent,
					error: preparationUnknown,
				});
				return;
			}
			if (prepared.sourceId !== intent.sourceId)
				throw new Error("PREPARED_SOURCE_MISMATCH");
			if (prepared.state === "ERROR")
				throw new ApiError(422, prepared.error ?? "PREPARATION_FAILED");
			intent.mediaVersionId = prepared.id;
			await poll(intent);
			requireActive(intent);
			await inspect(intent);
		} catch (failure) {
			if (isActive(intent))
				stop(
					failure instanceof Error &&
						failure.message === "PREPARATION_READ_STOPPED"
						? c.preparationReadStopped
						: editingErrorMessage(failure, t),
				);
		}
	}
	async function continueGeneration() {
		const intent = active.current;
		if (
			!intent ||
			!isActive(intent) ||
			!reviewVerified ||
			view.phase !== "review"
		)
			return;
		try {
			await inspect(intent);
		} catch (failure) {
			if (isActive(intent)) stop(editingErrorMessage(failure, t));
		}
	}
	function retryGeneration() {
		const receipt = generationReceipt.current;
		if (
			receipt &&
			isCurrentReceipt(receipt) &&
			view.phase === "generationUnknown"
		)
			void generate(receipt.intent, receipt);
	}
	function cancelReservation() {
		const receipt = generationReceipt.current;
		if (receipt && isCurrentReceipt(receipt)) {
			receipt.navigationCancelled = true;
			receipt.intent.controller.abort();
			setReviewVerified(false);
			setView((old) => ({ ...old, error: mayContinue }));
			// Keep controls locked until the accepted receipt is known or recovered.
			return;
		}
		stop(waitStopped);
	}
	function returnToSources() {
		stop(waitStopped);
		void client.invalidateQueries({
			queryKey: ["library-edit-eligibility", eligibility.sourceId],
		});
		onReturn();
	}
	const phaseLabel =
		view.phase === "preparing"
			? c.preparingMaterial
			: view.phase === "checking"
				? c.checkingPreparedAssociation
				: view.phase === "generating" || view.phase === "done"
					? startingLabel
					: null;
	return (
		<section
			aria-labelledby={`${id}-title`}
			className="min-w-0 space-y-4 rounded-lg border border-zinc-800 p-4 sm:p-6"
		>
			<header className="space-y-2">
				<h2 id={`${id}-title`} className="font-semibold text-lg">
					{renderMode === "DRAFT" ? c.projectCreate : c.prepareGenerateTitle}
				</h2>
				<p className="max-w-prose text-sm text-zinc-400">
					{renderMode === "DRAFT" ? c.projectCreateHelp : c.prepareGenerateHelp}
				</p>
			</header>
			{(!canPrepare || !canEdit) && (
				<p className="text-sm text-zinc-400">{c.readOnly}</p>
			)}
			{typeof children === "function" ? children(`${id}-create`) : children}
			{view.intent && (
				<dl className="space-y-1 break-words text-sm text-zinc-300">
					<div>
						<dt className="text-zinc-400">{t("editing.file")}</dt>
						<dd>{view.intent.fileLabel}</dd>
					</div>
					<div>
						<dt className="text-zinc-400">{t("editing.output")}</dt>
						<dd>
							{view.intent.output.bucket}/{view.intent.output.prefix}
						</dd>
					</div>
					<div>
						<dt className="text-zinc-400">
							{t("editing.autoPortrait.analysis")}
						</dt>
						<dd>{view.intent.analysisLabel}</dd>
					</div>
					<div>
						<dt className="text-zinc-400">
							{t("editing.autoPortrait.duration")}
						</dt>
						<dd>
							{view.intent.frames / 30}s ·{" "}
							{view.intent.settings.templateId === "portrait-clean"
								? c.portrait
								: view.intent.settings.templateId === "landscape-clean"
									? c.landscape
									: c.square}{" "}
							· {view.intent.settings.variants}
						</dd>
					</div>
					{view.intent.mediaVersionId && (
						<dd className="break-all text-xs">{view.intent.mediaVersionId}</dd>
					)}
				</dl>
			)}
			{phaseLabel && (
				<p role="status" aria-live="polite" className="text-sm">
					{phaseLabel}
				</p>
			)}
			{view.error && (
				<p role="alert" className="break-words text-amber-300 text-sm">
					{view.error}
				</p>
			)}
			{view.phase === "generationUnknown" && view.error !== mayContinue && (
				<p className="text-amber-300 text-sm">{mayContinue}</p>
			)}
			{canEdit ? (
				<>
					{renderMode === "DRAFT" && preparationTarget ? (
						<>
							<details className="space-y-4">
								<summary className="cursor-pointer text-sm text-zinc-300">
									{c.projectSettings}
								</summary>
								<GenerationSettings
									allowPresentation={renderMode === "DRAFT"}
									allowLocalStory={eligibility.localStoryAvailable === true}
									allowJapaneseCaptions={
										eligibility.captionTranslationAvailable === true
									}
									value={
										hasAudio === false
											? { ...settings, captions: "OFF" }
											: settings
									}
									hasAudio={hasAudio}
									disabled={blocked}
									onChange={setSettings}
								/>
							</details>
							<form
								id={`${id}-create`}
								aria-label={c.projectCreate}
								noValidate
								onSubmit={(event) => {
									event.preventDefault();
									void start(
										preparationTarget.fileKey,
										preparationTarget.output,
									);
								}}
							>
								<Button
									type="submit"
									className="w-full whitespace-normal"
									disabled={blocked || !selectable}
								>
									{c.projectCreate}
								</Button>
							</form>
						</>
					) : (
						<MediaPreparation
							eligibility={eligibility}
							disabled={blocked || !selectable}
							fileInputId={`${id}-file`}
							actionLabel={c.prepareGenerateAction}
							onPrepare={(file, output) => {
								void start(file, output);
							}}
						>
							<GenerationSettings
								allowPresentation={renderMode === "DRAFT"}
								allowLocalStory={eligibility.localStoryAvailable === true}
								allowJapaneseCaptions={
									eligibility.captionTranslationAvailable === true
								}
								value={settings}
								disabled={blocked}
								onChange={setSettings}
							/>
						</MediaPreparation>
					)}
					{view.phase === "review" && view.intent?.mediaVersionId && (
						<>
							<AssociationReview
								key={`${view.intent.epoch}:${reviewVersion}`}
								mediaVersionId={view.intent.mediaVersionId}
								analysisRevisionId={view.intent.analysisRevisionId}
								disabled={disabled || !canPrepare || !canEdit}
								onVerified={onVerified}
							/>
							<Button
								disabled={
									!reviewVerified || disabled || !canPrepare || !canEdit
								}
								onClick={() => {
									void continueGeneration();
								}}
							>
								{continueLabel}
							</Button>
						</>
					)}
					{view.phase === "generationUnknown" && (
						<Button
							disabled={disabled || !canPrepare || !canEdit}
							onClick={retryGeneration}
						>
							{retryLabel}
						</Button>
					)}
				</>
			) : (
				<MediaPreparation
					eligibility={eligibility}
					disabled
					fileInputId={`${id}-file`}
					actionLabel={c.prepareGenerateAction}
					onPrepare={() => {}}
				>
					<GenerationSettings
						value={settings}
						disabled
						allowPresentation={renderMode === "DRAFT"}
						allowLocalStory={eligibility.localStoryAvailable === true}
						allowJapaneseCaptions={
							eligibility.captionTranslationAvailable === true
						}
						onChange={() => {}}
					/>
				</MediaPreparation>
			)}
			{["preparationUnknown", "stopped"].includes(view.phase) && (
				<Button variant="secondary" onClick={returnToSources}>
					{c.selectPreparedExplicitly}
				</Button>
			)}
			{reserved &&
				view.phase !== "done" &&
				!generationReceipt.current?.navigationCancelled && (
					<Button variant="secondary" onClick={cancelReservation}>
						{cancelLabel}
					</Button>
				)}
			{acknowledgedTask &&
				view.intent?.identity === identity &&
				canPrepare &&
				canEdit && (
					<Link
						href={`/library/generations/${acknowledgedTask}`}
						className="break-all text-emerald-400 text-sm underline"
					>
						{progressLabel}
					</Link>
				)}
		</section>
	);
}
