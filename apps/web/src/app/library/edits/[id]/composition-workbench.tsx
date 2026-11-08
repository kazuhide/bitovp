"use client";
import {
	type CompositionDocument,
	type CompositionSourceFacts,
	canonicalEditingJson,
	compileComposition,
	compositionDocumentSchema,
	compositionHasUnconfirmedCenterCrop,
	compositionHasUnconfirmedFraming,
	confirmCompositionFraming,
	evaluateCompositionFrame,
	type NormalizedCropRect,
} from "@bitovp/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import type {
	AnyEditingProjectView,
	EditingMediaView,
	EditingRenderView,
} from "@/lib/library-editing";
import { useProductionCopy } from "../../[id]/edits/production-copy";
import { useEditingActor } from "../../[id]/edits/use-editing-actor";
import { EditingDetails } from "../../editing-help";
import { editingErrorMessage } from "../editing-errors";
import { useCompositionCopy } from "./composition-copy";
import { CompositionPendingInputs } from "./composition-inputs";
import {
	type CompositionCatalogMedia,
	CompositionInspector,
} from "./composition-inspector";
import { CompositionPreview } from "./composition-preview";
import type { CompositionSourceFrameReader } from "./composition-source-frame";
import { CompositionTimeline } from "./composition-timeline";
import { CompositionTranscriptionControls } from "./composition-transcription-controls";
import { applyDirectCrop } from "./direct-crop-model";
import { LocalStoryRationale } from "./local-story-rationale";
import { CurrentExportStatus, RenderPanel } from "./render-panel";
import { ReproposalDialog } from "./reproposal-dialog";
import {
	expectedReproposalSave,
	reframeCurrentComposition,
} from "./reproposal-settings";
import { SemanticSelectionRationale } from "./semantic-selection-rationale";
import { StorySelectionRationale } from "./story-selection-rationale";
import { useDirectCropGesture } from "./use-direct-crop-gesture";

export function CompositionWorkbench({
	project,
	initialUndoDraft,
}: {
	project: AnyEditingProjectView & { draft: CompositionDocument };
	initialUndoDraft?: CompositionDocument;
}) {
	const c = useCompositionCopy(),
		productionCopy = useProductionCopy(),
		actorIdentity = useEditingActor(),
		{ t } = useT(),
		client = useQueryClient(),
		canMutate = useMutationAccess("library.edits.edit");
	const [draft, setDraft] = useState(project.draft),
		[baseRevision, setBaseRevision] = useState(project.draftRevision),
		[dirty, setDirty] = useState(false),
		[busy, setBusy] = useState(false),
		[proposing, setProposing] = useState(false),
		[error, setError] = useState(""),
		[frame, setFrame] = useState(0),
		[selectedId, setSelectedId] = useState(project.draft.clips[0]?.id ?? ""),
		[past, setPast] = useState<CompositionDocument[]>(
			initialUndoDraft ? [initialUndoDraft] : [],
		),
		[future, setFuture] = useState<CompositionDocument[]>([]);
	const sourceFrameReader = useRef<CompositionSourceFrameReader | null>(null);
	const [sourceFrameRevision, setSourceFrameRevision] = useState(0);
	const receiveSourceFrameReader = useCallback(
		(reader: CompositionSourceFrameReader | null) => {
			if (sourceFrameReader.current !== reader) {
				sourceFrameReader.current = reader;
				setSourceFrameRevision((value) => value + 1);
			}
		},
		[],
	);
	const sourceFrameAvailabilityChanged = useCallback(
		() => setSourceFrameRevision((value) => value + 1),
		[],
	);
	const [pendingInputs, setPendingInputs] = useState<string[]>([]);
	const pendingInput = useCallback(
		(id: string, pending: boolean) =>
			setPendingInputs((items) =>
				pending
					? items.includes(id)
						? items
						: [...items, id]
					: items.includes(id)
						? items.filter((item) => item !== id)
						: items,
			),
		[],
	);
	const selectClip = (id: string) => {
		if (pendingInputs.length) setError(c.pending);
		else setSelectedId(id);
	};
	const requestKeys = useRef(new Map<string, string>()),
		blocked = !canMutate || busy || proposing,
		remoteChanged = project.draftRevision !== baseRevision,
		key = ["library-edit", project.id];
	const action = useRef<AbortController | null>(null),
		mounted = useRef(true),
		latest = useRef({ project, actorIdentity, canMutate, pendingInputs });
	latest.current = { project, actorIdentity, canMutate, pendingInputs };
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			action.current?.abort();
		};
	}, []);
	const catalogQuery = useQuery({
		queryKey: ["library-editing-media"],
		queryFn: ({ signal }) =>
			apiFetch<{ media: CompositionCatalogMedia[] }>(
				"/api/library/editing-media",
				{ signal },
			),
	});
	const catalog = catalogQuery.data?.media ?? [];
	const heldDocuments = useMemo(
		() => [draft, ...past, ...future, project.draft],
		[draft, past, future, project.draft],
	);
	const heldMediaIds = useMemo(
		() =>
			new Set(
				heldDocuments.flatMap((document) => [
					document.mediaVersionId,
					...(document.sources ?? []).map((source) => source.mediaVersionId),
				]),
			),
		[heldDocuments],
	);
	const heldImageIds = useMemo(
		() =>
			new Set(
				heldDocuments.flatMap((document) =>
					(document.imageAssets ?? []).map((image) => image.id),
				),
			),
		[heldDocuments],
	);
	const sourceCache = useRef(new Map<string, CompositionSourceFacts>());
	const mediaCache = useRef(new Map<string, EditingMediaView>());
	const imageCache = useRef(
		new Map<
			string,
			NonNullable<AnyEditingProjectView["imageAssets"]>[number]
		>(),
	);
	const availableSources = useMemo(() => {
		const facts = new Map(sourceCache.current);
		for (const source of project.compositionSources ?? [])
			facts.set(source.mediaVersionId, source);
		for (const media of catalog) facts.set(media.id, media.facts);
		sourceCache.current = new Map(
			[...facts].filter(([id]) => heldMediaIds.has(id)),
		);
		return [...facts.values()];
	}, [project.compositionSources, catalog, heldMediaIds]);
	const sourceFactsFor = (document: CompositionDocument) =>
		[
			document.mediaVersionId,
			...(document.sources ?? []).map((item) => item.mediaVersionId),
		]
			.map((id) =>
				availableSources.find((source) => source.mediaVersionId === id),
			)
			.filter((source) => source !== undefined);
	const sources = useMemo(
		() =>
			[
				draft.mediaVersionId,
				...(draft.sources ?? []).map((item) => item.mediaVersionId),
			]
				.map((id) =>
					availableSources.find((source) => source.mediaVersionId === id),
				)
				.filter((source) => source !== undefined),
		[draft, availableSources],
	);
	const cropContextKey = useMemo(
		() =>
			JSON.stringify([
				project.id,
				project.draftRevision,
				actorIdentity,
				selectedId,
				frame,
				canonicalEditingJson(draft),
			]),
		[
			project.id,
			project.draftRevision,
			actorIdentity,
			selectedId,
			frame,
			draft,
		],
	);
	const otherPending = pendingInputs.some((id) => id !== "direct-crop");
	const cropGesture = useDirectCropGesture<NormalizedCropRect>({
		document: draft,
		contextKey: cropContextKey,
		disabled: blocked || remoteChanged || otherPending,
		apply: (base, rect) =>
			applyDirectCrop(base, sources, selectedId, frame, rect),
		onCommit: change,
		onPending: (pending) => pendingInput("direct-crop", pending),
		onInvalid: () => setError(c.invalid),
	});
	const plan = useMemo(
		() =>
			compileComposition(cropGesture.document, sources, {
				allowUnconfirmed: true,
			}),
		[cropGesture.document, sources],
	);
	const seekFrame = useCallback(
		(next: number) => {
			cropGesture.cancel();
			const at = Math.max(0, Math.min(next, plan.durationFrames - 1));
			setFrame(at);
			if (otherPending) return;
			const layers = evaluateCompositionFrame(plan, at).layers;
			const active = [...layers].sort(
				(left, right) =>
					left.trackOrder - right.trackOrder || right.opacity - left.opacity,
			)[0];
			setSelectedId((current) =>
				layers.some((layer) => layer.clipId === current)
					? current
					: (active?.clipId ?? current),
			);
		},
		[cropGesture.cancel, plan, otherPending],
	);
	useEffect(() => {
		if (frame >= plan.durationFrames) setFrame(plan.durationFrames - 1);
	}, [frame, plan.durationFrames]);
	useEffect(() => {
		const stop = (event: BeforeUnloadEvent) => {
			if (dirty || pendingInputs.length) event.preventDefault();
		};
		window.addEventListener("beforeunload", stop);
		return () => window.removeEventListener("beforeunload", stop);
	}, [dirty, pendingInputs.length]);
	function change(next: CompositionDocument) {
		if (blocked) return;
		try {
			const checked = compositionDocumentSchema.parse(next);
			compileComposition(checked, sourceFactsFor(checked), {
				allowUnconfirmed: true,
			});
			setPast((items) => [...items.slice(-19), draft]);
			setFuture([]);
			setDraft(checked);
			setDirty(true);
			setError("");
		} catch {
			setError(c.invalid);
		}
	}
	function history(direction: "UNDO" | "REDO") {
		if (blocked || pendingInputs.length) return;
		const list = direction === "UNDO" ? past : future,
			next = list.at(-1);
		if (!next) return;
		if (direction === "UNDO") {
			setPast(list.slice(0, -1));
			setFuture((items) => [...items, draft]);
		} else {
			setFuture(list.slice(0, -1));
			setPast((items) => [...items, draft]);
		}
		setDraft(next);
		setDirty(true);
		setError("");
	}
	function accept(next: AnyEditingProjectView) {
		if (next.draft.schemaVersion !== 2)
			throw new Error("INVALID_EDIT_DOCUMENT");
		client.setQueryData(key, next);
		setDraft(next.draft);
		setBaseRevision(next.draftRevision);
		setDirty(false);
	}
	function loadSavedDraft() {
		if (blocked || pendingInputs.length || !remoteChanged) return;
		setPast((items) => [...items.slice(-19), draft]);
		setFuture([]);
		setDraft(project.draft);
		setBaseRevision(project.draftRevision);
		setDirty(false);
		setError("");
	}
	async function run(execute: (signal: AbortSignal) => Promise<void>) {
		if (blocked || action.current) return;
		const controller = new AbortController();
		action.current = controller;
		setBusy(true);
		setError("");
		try {
			await client.cancelQueries({ queryKey: key });
			if (!mounted.current || controller.signal.aborted) return;
			await execute(controller.signal);
		} catch (failure) {
			if (mounted.current) {
				setError(editingErrorMessage(failure, t));
				await client.invalidateQueries({ queryKey: key });
			}
		} finally {
			if (action.current === controller) action.current = null;
			if (mounted.current) setBusy(false);
		}
	}
	async function saveDraft(
		beforeAccept?: (next: AnyEditingProjectView) => void,
		signal?: AbortSignal,
	) {
		if (pendingInputs.length) throw new Error(c.pending);
		const next = await apiFetch<AnyEditingProjectView>(
			`/api/library/edits/${project.id}/draft`,
			{
				method: "PUT",
				signal,
				body: JSON.stringify({
					expectedRevision: baseRevision,
					document: draft,
				}),
			},
		);
		beforeAccept?.(next);
		accept(next);
		return next;
	}
	async function saveBeforeReproposal(signal: AbortSignal) {
		if (!canMutate || !actorIdentity || pendingInputs.length || remoteChanged)
			throw new Error(c.generationStopped);
		const expected = canonicalEditingJson(
				expectedReproposalSave(draft, project.draft),
			),
			actor = actorIdentity;
		const requireCurrent = () => {
			if (
				signal.aborted ||
				!mounted.current ||
				latest.current.actorIdentity !== actor ||
				!latest.current.canMutate ||
				latest.current.pendingInputs.length ||
				latest.current.project.id !== project.id ||
				latest.current.project.media.id !== project.media.id
			)
				throw new Error(c.generationStopped);
		};
		await client.cancelQueries({ queryKey: key });
		requireCurrent();
		if (dirty)
			await saveDraft((next) => {
				requireCurrent();
				if (
					next.id !== project.id ||
					next.contentId !== project.contentId ||
					next.media.id !== project.media.id ||
					next.draftRevision !== baseRevision + 1 ||
					canonicalEditingJson(compositionDocumentSchema.parse(next.draft)) !==
						expected
				)
					throw new Error(c.generationStopped);
			}, signal);
		requireCurrent();
	}
	async function saveRevision() {
		const expectedRevision = dirty
			? (await saveDraft()).draftRevision
			: baseRevision;
		await createRevision(expectedRevision);
	}
	async function createRevision(
		expectedRevision: number,
		beforeAccept?: (next: AnyEditingProjectView) => void,
		signal?: AbortSignal,
	) {
		const next = await apiFetch<AnyEditingProjectView>(
			`/api/library/edits/${project.id}/revisions`,
			{
				method: "POST",
				signal,
				body: JSON.stringify({
					expectedRevision,
					confirmSuggestions: hasSuggestions,
				}),
			},
		);
		beforeAccept?.(next);
		accept(next);
		return next;
	}
	async function generate(kind: "PREVIEW" | "EXPORT") {
		if (
			!project.currentRevisionId ||
			dirty ||
			project.draftRevision !== baseRevision ||
			!project.currentRevisionMatchesDraft
		)
			return;
		await queueRender(project, kind);
	}
	async function queueRender(
		saved: AnyEditingProjectView,
		kind: "PREVIEW" | "EXPORT",
		signal?: AbortSignal,
		beforeAccept?: (render: EditingRenderView) => void,
	) {
		const intent = `${saved.currentRevisionId}:${kind}`,
			requestKey = requestKeys.current.get(intent) ?? crypto.randomUUID();
		requestKeys.current.set(intent, requestKey);
		const render = await apiFetch<EditingRenderView>(
			`/api/library/edits/${project.id}/renders`,
			{
				method: "POST",
				signal,
				body: JSON.stringify({
					revisionId: saved.currentRevisionId,
					kind,
					requestKey,
				}),
			},
		);
		beforeAccept?.(render);
		client.setQueryData(key, {
			...saved,
			renders: [
				render,
				...saved.renders.filter((item) => item.id !== render.id),
			],
		});
		requestKeys.current.delete(intent);
	}
	async function generateCurrent(signal: AbortSignal) {
		if (!actorIdentity || remoteChanged || pendingInputs.length) return;
		const capturedActor = actorIdentity;
		const knownDrafts = new Map([
			[project.draftRevision, canonicalEditingJson(project.draft)],
		]);
		const expected = dirty
			? expectedReproposalSave(draft, project.draft)
			: structuredClone(draft);
		const expectedDocument = canonicalEditingJson(expected);
		const confirmedDocument = hasSuggestions
			? confirmCompositionFraming(expected)
			: structuredClone(expected);
		const expectedConfirmedDocument = canonicalEditingJson(confirmedDocument);
		const requireCurrent = () => {
			const current = latest.current;
			if (
				!mounted.current ||
				signal.aborted ||
				!current.canMutate ||
				current.actorIdentity !== capturedActor ||
				current.pendingInputs.length ||
				current.project.id !== project.id ||
				current.project.contentId !== project.contentId ||
				knownDrafts.get(current.project.draftRevision) !==
					canonicalEditingJson(current.project.draft)
			)
				throw new Error(c.generationStopped);
		};
		const checkSaved =
			(revision: number, confirmed = false) =>
			(next: AnyEditingProjectView) => {
				requireCurrent();
				const expectedSnapshot = confirmed
					? expectedConfirmedDocument
					: expectedDocument;
				if (
					next.id !== project.id ||
					next.contentId !== project.contentId ||
					next.media.id !== project.media.id ||
					next.draftRevision !== revision ||
					canonicalEditingJson(compositionDocumentSchema.parse(next.draft)) !==
						expectedSnapshot ||
					(confirmed &&
						(!next.currentRevisionId || !next.currentRevisionMatchesDraft))
				)
					throw new Error(c.generationStopped);
				knownDrafts.set(next.draftRevision, expectedSnapshot);
			};
		requireCurrent();
		let saved: AnyEditingProjectView = project;
		if (dirty) saved = await saveDraft(checkSaved(baseRevision + 1), signal);
		requireCurrent();
		if (
			dirty ||
			hasSuggestions ||
			!saved.currentRevisionId ||
			!saved.currentRevisionMatchesDraft
		)
			saved = await createRevision(
				saved.draftRevision,
				checkSaved(saved.draftRevision + 1, true),
				signal,
			);
		requireCurrent();
		await queueRender(saved, "EXPORT", signal, (render) => {
			requireCurrent();
			if (
				render.revisionId !== saved.currentRevisionId ||
				render.kind !== "EXPORT"
			)
				throw new Error(c.generationStopped);
		});
	}
	async function upload(file: File) {
		await run(async () => {
			if (file.size > 8 * 1024 * 1024) throw new Error("IMAGE_TOO_LARGE");
			const pngBase64 = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () =>
					resolve(String(reader.result).split(",")[1] ?? "");
				reader.onerror = () => reject(new Error("INVALID_EDITING_PNG"));
				reader.readAsDataURL(file);
			});
			const asset = await apiFetch<{
				id: string;
				width: number;
				height: number;
				url: string;
			}>(`/api/library/edits/${project.id}/images`, {
				method: "POST",
				body: JSON.stringify({ pngBase64 }),
			});
			const next: CompositionDocument = {
				...draft,
				imageAssets: [...(draft.imageAssets ?? []), { id: asset.id }],
				overlays: [
					...(draft.overlays ?? []),
					{
						id: crypto.randomUUID(),
						kind: "IMAGE",
						assetId: asset.id,
						fromFrame: frame,
						toFrame: Math.min(plan.durationFrames, frame + 90),
						rect: {
							x: 0.72,
							y: 0.05,
							w: 0.22,
							h: Math.min(
								0.4,
								(((0.22 * asset.height) / asset.width) * draft.canvas.width) /
									draft.canvas.height,
							),
						},
						opacity: 1,
						zIndex: 5,
					},
				],
			};
			compositionDocumentSchema.parse(next);
			imageCache.current.set(asset.id, asset);
			setPast((items) => [...items.slice(-19), draft]);
			setFuture([]);
			setDraft(next);
			setDirty(true);
		});
	}
	const hasSuggestions = compositionHasUnconfirmedFraming(draft);
	const media = useMemo(() => {
		const items = new Map(mediaCache.current);
		for (const item of [
			project.media,
			...(project.additionalMedia ?? []),
			...catalog,
		])
			items.set(item.id, item);
		mediaCache.current = new Map(
			[...items].filter(([id]) => heldMediaIds.has(id)),
		);
		return [...items.values()];
	}, [project.media, project.additionalMedia, catalog, heldMediaIds]);
	const images = useMemo(() => {
		const items = new Map(imageCache.current);
		for (const item of project.imageAssets ?? []) items.set(item.id, item);
		imageCache.current = new Map(
			[...items].filter(([id]) => heldImageIds.has(id)),
		);
		const active = new Set((draft.imageAssets ?? []).map((image) => image.id));
		return [...items.values()].filter((item) => active.has(item.id));
	}, [project.imageAssets, heldImageIds, draft.imageAssets]);
	const selectedPreviewClip = plan.clips.find(
		(item) =>
			item.clip.id === selectedId &&
			frame >= item.outputFromFrame &&
			frame < item.outputToFrame,
	);
	const reviewCropCandidates =
		draft.presentation?.fallbackFraming === "AISA_STATIC_V1" ||
		draft.clips.some((clip) => clip.fallbackCrop !== undefined);
	const hasFixedFramingNote = compositionHasUnconfirmedCenterCrop(draft);
	const hasSpeechSearchLimitNote =
		draft.autoGeneration?.reasonCodes.includes(
			"SPEECH_SEARCH_LIMIT_REVIEW_REQUIRED",
		) ?? false;
	const hasSpeechDurationNote =
		draft.autoGeneration?.reasonCodes.includes(
			"SPEECH_DURATION_REVIEW_REQUIRED",
		) ?? false;
	const hasSpeechNote =
		hasSpeechDurationNote ||
		(draft.autoGeneration?.reasonCodes.includes("SPEECH_REVIEW_REQUIRED") ??
			false);
	return (
		<CompositionPendingInputs.Provider value={pendingInput}>
			<main className="mx-auto max-w-[1600px] space-y-5 p-4 sm:p-6">
				<header className="flex flex-wrap items-start justify-between gap-4">
					<div className="space-y-2">
						<Link
							href={`/library/${project.contentId}/edits`}
							className="text-xs text-emerald-400"
						>
							← {project.title}
						</Link>
						<h1 className="font-semibold text-2xl">
							{c.title}{" "}
							<span className="font-normal text-sm text-zinc-500">
								{draft.canvas.width}×{draft.canvas.height}
							</span>
						</h1>
						<EditingDetails summary={c.editorHelpTitle}>
							<p>{c.helpSelection}</p>
							<p>{c.helpDrag}</p>
							<p>{c.helpAfterExport}</p>
							<p>{c.generateHelp}</p>
							{(hasFixedFramingNote ||
								hasSpeechNote ||
								hasSpeechSearchLimitNote) && (
								<>
									<h3 className="font-medium">{c.autoEditNotesTitle}</h3>
									{hasFixedFramingNote && (
										<p>
											{reviewCropCandidates
												? c.cropReviewReason
												: c.centerCropReviewReason}
										</p>
									)}
									{hasSpeechSearchLimitNote && (
										<p>{productionCopy.speechSearchLimitReviewReason}</p>
									)}
									{hasSpeechNote && (
										<p>
											{hasSpeechDurationNote
												? productionCopy.speechDurationReviewReason
												: productionCopy.speechReviewReason}
										</p>
									)}
								</>
							)}
						</EditingDetails>
						<SemanticSelectionRationale
							evidence={draft.autoGeneration?.semanticEvidence}
						/>
						<StorySelectionRationale
							evidence={draft.autoGeneration?.storyEvidence}
						/>
						<LocalStoryRationale
							evidence={draft.autoGeneration?.localStoryEvidence}
						/>
					</div>
					{canMutate && (
						<div className="flex flex-wrap items-center gap-2">
							<ReproposalDialog
								project={project}
								document={draft}
								actorIdentity={actorIdentity}
								dirty={dirty}
								disabled={
									!canMutate ||
									busy ||
									remoteChanged ||
									Boolean(pendingInputs.length)
								}
								onReframe={(mode) =>
									change(reframeCurrentComposition(draft, mode))
								}
								beforeStart={saveBeforeReproposal}
								onBusyChange={setProposing}
							/>
							<Button
								variant="ghost"
								disabled={
									blocked || Boolean(pendingInputs.length) || !past.length
								}
								onClick={() => history("UNDO")}
							>
								{c.undo}
							</Button>
							<Button
								variant="ghost"
								disabled={
									blocked || Boolean(pendingInputs.length) || !future.length
								}
								onClick={() => history("REDO")}
							>
								{c.redo}
							</Button>
							<Button
								variant="secondary"
								disabled={
									blocked ||
									remoteChanged ||
									Boolean(pendingInputs.length) ||
									!dirty
								}
								onClick={() =>
									void run(async () => {
										await saveDraft();
									})
								}
							>
								{c.save}
							</Button>
							<Button
								variant="secondary"
								disabled={
									blocked || remoteChanged || Boolean(pendingInputs.length)
								}
								onClick={() => void run(saveRevision)}
							>
								{c.confirm}
							</Button>
							<Button
								disabled={
									blocked ||
									!actorIdentity ||
									remoteChanged ||
									Boolean(pendingInputs.length) ||
									(!dirty &&
										project.renders.some(
											(render) =>
												render.kind === "EXPORT" &&
												render.revisionId === project.currentRevisionId &&
												!["SUCCEEDED", "ERROR", "FAILED", "CANCELED"].includes(
													render.state,
												),
										))
								}
								onClick={() => void run(generateCurrent)}
							>
								{c.generate}
							</Button>
						</div>
					)}
				</header>
				<div className="flex flex-wrap gap-4 text-xs">
					<p role="status" className="text-zinc-500">
						{dirty ? c.unsaved : c.saved}
					</p>
					{!canMutate && <p>{c.readonly}</p>}
					{otherPending && <p className="text-amber-300">{c.pending}</p>}
				</div>
				{remoteChanged && (
					<section
						role="status"
						className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-900 p-3 text-amber-200 text-sm"
					>
						<p>{c.remoteChanged}</p>
						{canMutate && (
							<Button
								variant="secondary"
								disabled={blocked || Boolean(pendingInputs.length)}
								onClick={loadSavedDraft}
							>
								{c.reloadSaved}
							</Button>
						)}
					</section>
				)}
				{error && (
					<p
						role="alert"
						className="rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-amber-200 text-sm"
					>
						{error}
					</p>
				)}
				<div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
					<div className="min-w-0 space-y-5">
						<CompositionPreview
							plan={plan}
							media={media}
							imageAssets={images}
							frame={Math.min(frame, plan.durationFrames - 1)}
							onFrame={seekFrame}
							onSourceFrameReader={receiveSourceFrameReader}
							onSourceFrameAvailabilityChange={sourceFrameAvailabilityChanged}
							sourceCrop={{
								clipId: selectedId,
								contextKey: cropContextKey,
								disabled: blocked || remoteChanged || otherPending,
								active: cropGesture.active,
								onStart: cropGesture.begin,
								onPreview: cropGesture.preview,
								onCommit: cropGesture.commit,
								onCancel: cropGesture.cancel,
							}}
						/>
						<CompositionTimeline
							document={cropGesture.document}
							sources={sources}
							duration={plan.durationFrames}
							selectedId={selectedId}
							frame={frame}
							disabled={blocked || Boolean(pendingInputs.length)}
							onSelect={selectClip}
							onFrame={seekFrame}
							onChange={change}
							onError={() => setError(c.invalid)}
						/>
						<EditingDetails summary={c.generateHelpTitle}>
							<p>{c.previewHelp}</p>
							<p>{c.generateHelp}</p>
						</EditingDetails>
						<CurrentExportStatus
							project={project}
							outdated={
								dirty ||
								cropGesture.active ||
								!project.currentRevisionMatchesDraft ||
								remoteChanged
							}
						/>
						<CompositionTranscriptionControls
							projectId={project.id}
							plan={plan}
							media={media}
							actorIdentity={actorIdentity}
							disabled={
								blocked || Boolean(pendingInputs.length) || cropGesture.active
							}
						/>
						<details className="min-w-0">
							<summary className="mb-3 cursor-pointer text-sm text-zinc-400">
								{c.previousOutputs}
							</summary>
							{canMutate ? (
								<RenderPanel
									project={project}
									disabled={blocked || cropGesture.active}
									generationDisabled={
										blocked ||
										Boolean(pendingInputs.length) ||
										dirty ||
										!project.currentRevisionId ||
										!project.currentRevisionMatchesDraft ||
										project.draftRevision !== baseRevision
									}
									onGenerate={(kind) => void run(() => generate(kind))}
									onCancel={(id) =>
										void run(async () => {
											await apiFetch(`/api/library/renders/${id}/cancel`, {
												method: "POST",
											});
											await client.invalidateQueries({ queryKey: key });
										})
									}
									previewOutdated={dirty}
								/>
							) : (
								<RenderPanel
									project={project}
									disabled
									generationDisabled
									onGenerate={() => {}}
									onCancel={() => {}}
								/>
							)}
						</details>
					</div>
					{canMutate ? (
						<CompositionInspector
							document={cropGesture.document}
							sources={sources}
							catalog={catalog}
							selectedId={selectedId}
							frame={Math.min(frame, plan.durationFrames - 1)}
							disabled={blocked || cropGesture.active}
							presentationDisabled={Boolean(pendingInputs.length)}
							candidateContext={{
								media: project.media,
								analysis: project.analysis,
							}}
							sourceFrameReader={sourceFrameReader.current}
							sourceFrameRevision={sourceFrameRevision}
							expectedSourceFrame={
								selectedPreviewClip
									? selectedPreviewClip.sourceFromFrame +
										frame -
										selectedPreviewClip.outputFromFrame
									: undefined
							}
							onChange={change}
							onSelect={selectClip}
							onError={() => setError(c.invalid)}
							onUpload={upload}
						/>
					) : (
						<aside className="rounded-xl border border-zinc-800 p-4 text-zinc-400 text-sm">
							{c.readonly}
						</aside>
					)}
				</div>
			</main>
		</CompositionPendingInputs.Provider>
	);
}
