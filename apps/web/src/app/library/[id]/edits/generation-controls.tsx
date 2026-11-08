"use client";
import { mediaTaskCreateSchema, mediaTaskReceiptSchema } from "@bitovp/core";
import { useRouter } from "next/navigation";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { ApiError, apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { AssociationReview } from "./association-review";
import {
	GenerationSettings,
	type GenerationSettingsValue,
} from "./generation-settings";
import { productionFailure, useProductionCopy } from "./production-copy";
import { useEditingActor } from "./use-editing-actor";

export type GenerationIntent = {
	identity: string;
	key: string;
	boundary: string;
	body: string;
	uncertain?: boolean;
};
type Props = {
	contentId: string;
	mediaVersionId: string;
	analysisRevisionId: string;
	targetDurationFrames: number | null;
	disabled: boolean;
	onBusyChange?(busy: boolean): void;
	renderMode?: "DRAFT" | "EXPORT";
	hasAudio?: boolean;
	localStoryAvailable?: boolean;
	captionTranslationAvailable?: boolean;
	initialSettings?: GenerationSettingsValue;
	labels?: { title: string; help: string; submit: string };
	beforeStart?(signal: AbortSignal): Promise<void>;
	/** Retain an uncertain intent when an auxiliary dialog is closed and reopened. */
	requestStore?: { current: GenerationIntent | null };
	children?: ReactNode | ((formId: string) => ReactNode);
};
export function GenerationControls(props: Props) {
	return props.renderMode === "DRAFT" ? (
		<DraftGenerationControls {...props} />
	) : (
		<GenerationControlsView {...props} />
	);
}
function DraftGenerationControls(props: Props) {
	const actorIdentity = useEditingActor();
	return <GenerationControlsView {...props} actorIdentity={actorIdentity} />;
}
function GenerationControlsView({
	contentId,
	mediaVersionId,
	analysisRevisionId,
	targetDurationFrames,
	disabled,
	onBusyChange,
	renderMode,
	hasAudio,
	localStoryAvailable = false,
	captionTranslationAvailable = false,
	initialSettings,
	labels,
	beforeStart,
	requestStore,
	actorIdentity,
	children,
}: Props & { actorIdentity?: string | null }) {
	const c = useProductionCopy(),
		id = useId(),
		router = useRouter();
	const canMutate = useMutationAccess("library.edits.edit");
	const [settings, setSettings] = useState<GenerationSettingsValue>(
		initialSettings ?? {
			policy:
				renderMode === "DRAFT"
					? localStoryAvailable
						? "LOCAL_STORY"
						: "AUTO"
					: "COHESION",
			...(renderMode === "DRAFT" && localStoryAvailable
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
		},
	);
	const tuple = `${mediaVersionId}:${analysisRevisionId}`;
	const [verifiedTuple, setVerifiedTuple] = useState("");
	const [busy, setBusy] = useState(false),
		[error, setError] = useState(""),
		[uncertain, setUncertain] = useState(
			requestStore?.current?.uncertain === true,
		);
	const submitting = useRef(false),
		mounted = useRef(true),
		localRequest = useRef<GenerationIntent | null>(null);
	const request = requestStore ?? localRequest;
	const onVerified = useCallback(
		(verified: boolean) => setVerifiedTuple(verified ? tuple : ""),
		[tuple],
	);
	const boundary = JSON.stringify({
		contentId,
		mediaVersionId,
		analysisRevisionId,
		targetDurationFrames,
		renderMode,
		hasAudio,
		actorIdentity,
	});
	// Capability discovery does not change ownership of an already submitted intent.
	// Unknown outcomes must keep the original body/key when availability changes.
	const current = useRef({ boundary, canMutate, disabled });
	current.current = { boundary, canMutate, disabled };
	const controller = useRef<AbortController | null>(null);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			controller.current?.abort();
		};
	}, []);
	const blocked =
		disabled ||
		busy ||
		!canMutate ||
		(renderMode === "DRAFT" && !actorIdentity);
	const settingsForm = (
		<GenerationSettings
			allowPresentation={renderMode === "DRAFT"}
			allowLocalStory={localStoryAvailable}
			allowJapaneseCaptions={captionTranslationAvailable}
			value={hasAudio === false ? { ...settings, captions: "OFF" } : settings}
			hasAudio={hasAudio}
			disabled={blocked || (renderMode === "DRAFT" && uncertain)}
			onChange={(value) => {
				setSettings(value);
				setError("");
				setUncertain(false);
			}}
		/>
	);
	async function start() {
		if (
			blocked ||
			submitting.current ||
			verifiedTuple !== tuple ||
			targetDurationFrames === null
		)
			return;
		submitting.current = true;
		setBusy(true);
		setError("");
		setUncertain(false);
		onBusyChange?.(true);
		const submittedBoundary = boundary;
		const isCurrent = () =>
			mounted.current &&
			current.current.boundary === submittedBoundary &&
			current.current.canMutate &&
			!current.current.disabled;
		let navigating = false;
		let keepReservation = false;
		let posted = false;
		const pending = new AbortController();
		controller.current = pending;
		try {
			if (!(uncertain && request.current?.boundary === boundary)) {
				const parameters = {
					...settings,
					contentId,
					targetDurationFrames,
					...(renderMode ? { renderMode } : {}),
					...(renderMode === "DRAFT"
						? { draftPolicyVersion: "duration-review-v2" as const }
						: {}),
					...(hasAudio === false ? { captions: "OFF" as const } : {}),
					...(settings.policy !== "COHESION" ? { query: undefined } : {}),
				};
				const value = mediaTaskCreateSchema.parse({
					kind: "GENERATE",
					mediaVersionId,
					analysisRevisionId,
					requestKey: "00000000-0000-4000-8000-000000000000",
					parameters,
				});
				const identity = JSON.stringify({
					...value,
					requestKey: undefined,
					...(renderMode === "DRAFT" ? { actorIdentity } : {}),
				});
				if (
					request.current?.identity !== identity ||
					request.current.boundary !== boundary
				) {
					const key = crypto.randomUUID();
					request.current = {
						identity,
						key,
						boundary,
						body: JSON.stringify({ ...value, requestKey: key }),
					};
				}
			}
			if (!request.current) throw new Error("Missing generation request");
			await beforeStart?.(pending.signal);
			if (!isCurrent() || pending.signal.aborted) return;
			posted = true;
			const response = mediaTaskReceiptSchema.parse(
				await apiFetch<unknown>("/api/library/media-tasks", {
					method: "POST",
					body: request.current.body,
					signal: AbortSignal.any([
						pending.signal,
						AbortSignal.timeout(20_000),
					]),
				}),
			);
			if (isCurrent()) {
				router.push(`/library/generations/${response.taskId}`);
				navigating = true;
			}
		} catch (failure) {
			const unknown =
				posted && (!(failure instanceof ApiError) || failure.status >= 500);
			if (!unknown) request.current = null;
			else if (request.current) request.current.uncertain = true;
			if (isCurrent()) {
				setError(
					failure instanceof ApiError && failure.message.startsWith("STORY_")
						? productionFailure(failure.message, c)
						: c.error,
				);
				setUncertain(unknown);
				keepReservation = renderMode === "DRAFT" && unknown;
			}
		} finally {
			if (controller.current === pending) controller.current = null;
			if (!navigating) {
				submitting.current = false;
				onBusyChange?.(keepReservation);
				if (mounted.current) setBusy(false);
			}
		}
	}
	return (
		<section
			aria-labelledby={`${id}-title`}
			aria-busy={busy}
			className="min-w-0 space-y-4 rounded-lg border border-zinc-800 p-4 sm:p-6"
		>
			<header className="space-y-2">
				<h2 id={`${id}-title`} className="font-semibold text-lg">
					{labels?.title ??
						(renderMode === "DRAFT" ? c.projectCreate : c.configuredTitle)}
				</h2>
				<p className="max-w-prose text-sm text-zinc-400">
					{labels?.help ??
						(renderMode === "DRAFT" ? c.projectCreateHelp : c.configuredHelp)}
				</p>
			</header>
			{!canMutate && <p className="text-sm text-zinc-400">{c.readOnly}</p>}
			{typeof children === "function" ? children(`${id}-create`) : children}
			{renderMode === "DRAFT" ? (
				<details className="space-y-4">
					<summary className="cursor-pointer text-sm text-zinc-300">
						{c.projectSettings}
					</summary>
					{settingsForm}
				</details>
			) : (
				settingsForm
			)}
			{hasAudio === false && (
				<p className="text-sm text-zinc-400">{c.noAudio}</p>
			)}
			<AssociationReview
				key={tuple}
				mediaVersionId={mediaVersionId}
				analysisRevisionId={analysisRevisionId}
				disabled={blocked}
				onVerified={onVerified}
			/>
			{error && (
				<div role="alert" className="space-y-1 text-amber-300 text-sm">
					<p>{error}</p>
					{uncertain && <p>{c.unknown}</p>}
				</div>
			)}
			{canMutate &&
				(renderMode === "DRAFT" ? (
					<form
						id={`${id}-create`}
						aria-label={labels?.submit ?? c.projectCreate}
						noValidate
						onSubmit={(event) => {
							event.preventDefault();
							void start();
						}}
					>
						<Button
							type="submit"
							className="w-full whitespace-normal"
							disabled={
								blocked ||
								verifiedTuple !== tuple ||
								targetDurationFrames === null
							}
						>
							{busy
								? c.starting
								: labels && uncertain
									? c.retrySameProject
									: (labels?.submit ?? c.projectCreate)}
						</Button>
					</form>
				) : (
					<Button
						className="w-full whitespace-normal"
						disabled={
							blocked ||
							verifiedTuple !== tuple ||
							targetDurationFrames === null
						}
						onClick={() => {
							void start();
						}}
					>
						{busy ? c.starting : c.start}
					</Button>
				))}
		</section>
	);
}
