"use client";

import {
	type EditDocument,
	editingDocumentSchema,
	type HighlightCandidate,
	MAX_EDIT_DURATION_FRAMES,
	MAX_EDIT_FRAMING_SEGMENTS,
} from "@bitovp/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import type {
	AnyEditingProjectView,
	EditingProjectView,
	EditingRenderView,
} from "@/lib/library-editing";
import { reflowClips } from "../edit-model";
import { editingErrorMessage } from "../editing-errors";
import { EditorWorkbench } from "./editor-workbench";
import { RenderPanel } from "./render-panel";

export type LegacyEditingSession = {
	draft: EditDocument | null;
	pending: boolean;
	busy: boolean;
};

export function EditorClient({
	id,
	onUnsavedChange,
	projectOverride,
	historyOnly = false,
}: {
	id: string;
	onUnsavedChange?: (unsafe: boolean, session: LegacyEditingSession) => void;
	projectOverride?: EditingProjectView;
	historyOnly?: boolean;
}) {
	return (
		<EditorView
			key={id}
			id={id}
			onUnsavedChange={onUnsavedChange}
			projectOverride={projectOverride}
			historyOnly={historyOnly}
		/>
	);
}

function EditorView({
	id,
	onUnsavedChange,
	projectOverride,
	historyOnly = false,
}: {
	id: string;
	onUnsavedChange?: (unsafe: boolean, session: LegacyEditingSession) => void;
	projectOverride?: EditingProjectView;
	historyOnly?: boolean;
}) {
	const { t } = useT();
	const canMutate = useMutationAccess("library.edits.edit");
	const client = useQueryClient();
	const queryKey = ["library-edit", id];
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) =>
			apiFetch<AnyEditingProjectView>(`/api/library/edits/${id}`, { signal }),
		refetchInterval: 3000,
	});
	const [draft, setDraft] = useState<EditDocument | null>(null);
	const [baseRevision, setBaseRevision] = useState(0);
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [pendingRanges, setPendingRanges] = useState<string[]>([]);
	const [confirmSuggestions, setConfirmSuggestions] = useState(false);
	const [past, setPast] = useState<EditDocument[]>([]);
	const [future, setFuture] = useState<EditDocument[]>([]);
	const requests = useRef(new Map<string, string>());
	useEffect(() => {
		onUnsavedChange?.(
			draft === null || dirty || busy || pendingRanges.length > 0,
			{ draft, pending: pendingRanges.length > 0, busy },
		);
	}, [draft, dirty, busy, pendingRanges.length, onUnsavedChange]);
	useEffect(() => {
		const incoming = projectOverride ?? query.data;
		if (incoming?.draft.schemaVersion === 1 && draft === null) {
			setDraft(incoming.draft);
			setBaseRevision(incoming.draftRevision);
		}
	}, [projectOverride, query.data, draft]);
	const project = projectOverride ?? query.data;
	const valid = draft ? editingDocumentSchema.safeParse(draft).success : false;
	const hasSuggestions =
		draft?.clips.some((clip) =>
			clip.framing.some((part) => part.origin === "AISA_PROPOSAL"),
		) ?? false;
	const blocked = !canMutate || busy;
	const pending = pendingRanges.length > 0;
	const numericRangePending = pendingRanges.some((id) =>
		draft?.clips.some((clip) => clip.id === id),
	);
	const change = (next: EditDocument) => {
		if (!blocked) {
			if (
				next.clips.reduce((sum, clip) => sum + clip.framing.length, 0) >
				MAX_EDIT_FRAMING_SEGMENTS
			) {
				setError(
					t("editing.framingLimit", { limit: MAX_EDIT_FRAMING_SEGMENTS }),
				);
				return;
			}
			setError("");
			if (draft) setPast((current) => [...current.slice(-19), draft]);
			setFuture([]);
			setDraft(next);
			setDirty(true);
			setConfirmSuggestions(false);
			setPendingRanges((current) =>
				current.filter((id) => next.clips.some((clip) => clip.id === id)),
			);
		}
	};
	function history(direction: "UNDO" | "REDO") {
		if (blocked || pending || !draft) return;
		const list = direction === "UNDO" ? past : future;
		const next = list.at(-1);
		if (!next) return;
		if (direction === "UNDO") {
			setPast(list.slice(0, -1));
			setFuture((current) => [...current, draft]);
		} else {
			setFuture(list.slice(0, -1));
			setPast((current) => [...current, draft]);
		}
		setDraft(next);
		setDirty(true);
		setConfirmSuggestions(false);
	}
	const pendingRange = (clipId: string, value: boolean) =>
		setPendingRanges((current) =>
			value
				? [...new Set([...current, clipId])]
				: current.filter((item) => item !== clipId),
		);
	function accept(next: EditingProjectView) {
		client.setQueryData(queryKey, next);
		setDraft(next.draft);
		setBaseRevision(next.draftRevision);
		setDirty(false);
		setPendingRanges([]);
	}
	async function run(action: () => Promise<void>) {
		if (blocked) return;
		setBusy(true);
		setError("");
		try {
			await client.cancelQueries({ queryKey });
			await action();
		} catch (failure) {
			setError(editingErrorMessage(failure, t));
		} finally {
			setBusy(false);
		}
	}
	const cancelRun = canMutate
		? (renderId: string) =>
				void run(async () => {
					await apiFetch(`/api/library/renders/${renderId}/cancel`, {
						method: "POST",
						body: "{}",
					});
					await query.refetch();
				})
		: () => {};
	async function persistDraft() {
		if (!draft || !valid || pending)
			throw new Error(t("editing.invalidDocument"));
		const next = await apiFetch<EditingProjectView>(
			`/api/library/edits/${id}/draft`,
			{
				method: "PUT",
				body: JSON.stringify({
					expectedRevision: baseRevision,
					document: draft,
				}),
			},
		);
		accept(next);
		return next;
	}
	async function saveRevision() {
		if (
			!project ||
			!draft ||
			!valid ||
			pending ||
			(hasSuggestions && !confirmSuggestions)
		)
			return;
		const expectedRevision = dirty
			? (await persistDraft()).draftRevision
			: baseRevision;
		accept(
			await apiFetch<EditingProjectView>(`/api/library/edits/${id}/revisions`, {
				method: "POST",
				body: JSON.stringify({ expectedRevision, confirmSuggestions }),
			}),
		);
		setConfirmSuggestions(false);
	}
	async function generate(kind: "PREVIEW" | "EXPORT") {
		if (
			!project?.currentRevisionId ||
			!project.currentRevisionMatchesDraft ||
			project.draftRevision !== baseRevision ||
			dirty ||
			pending
		)
			return;
		const intent = `${project.currentRevisionId}:${kind}`;
		const requestKey = requests.current.get(intent) ?? crypto.randomUUID();
		requests.current.set(intent, requestKey);
		const render = await apiFetch<EditingRenderView>(
			`/api/library/edits/${id}/renders`,
			{
				method: "POST",
				body: JSON.stringify({
					revisionId: project.currentRevisionId,
					kind,
					requestKey,
				}),
			},
		);
		client.setQueryData(queryKey, {
			...project,
			renders: [
				render,
				...project.renders.filter((item) => item.id !== render.id),
			],
		});
		requests.current.delete(intent);
	}
	async function candidates(
		queryText: string,
		sceneId: string,
		targetDurationFrames: number,
	): Promise<HighlightCandidate[]> {
		const result = await apiFetch<{ candidates: HighlightCandidate[] }>(
			`/api/library/edits/${id}/suggestions`,
			{
				method: "POST",
				body: JSON.stringify({
					query: queryText,
					...(sceneId ? { sceneIds: [sceneId] } : {}),
					targetDurationFrames,
				}),
			},
		);
		return result.candidates;
	}
	function addCandidate(candidate: HighlightCandidate) {
		if (!draft || draft.clips.length >= 20) return;
		const frames = draft.clips.reduce(
			(sum, clip) => sum + clip.durationFrames,
			0,
		);
		if (frames + candidate.durationFrames > MAX_EDIT_DURATION_FRAMES) {
			setError(t("editing.budget"));
			return;
		}
		change(
			reflowClips(draft, [
				...draft.clips,
				{
					id: crypto.randomUUID(),
					sourceInUs: candidate.sourceInUs,
					durationFrames: candidate.durationFrames,
					timelineStartFrame: 0,
					framing: [
						{
							fromFrame: 0,
							toFrame: candidate.durationFrames,
							mode: "FIT",
							origin: "AISA_PROPOSAL",
						},
					],
					audio: { mode: "SOURCE" },
					evidence: { sceneId: candidate.sceneId },
				},
			]),
		);
	}
	if (
		query.error &&
		(!query.data ||
			(query.error instanceof ApiError &&
				query.error.status >= 400 &&
				query.error.status < 500))
	)
		return (
			<div role="alert" className="space-y-3">
				<p>{editingErrorMessage(query.error, t)}</p>
				<Button onClick={() => void query.refetch()}>
					{t("editing.refresh")}
				</Button>
			</div>
		);
	if (historyOnly) {
		if (!project) return <p role="status">{t("editing.loading")}</p>;
		return (
			<div className="mx-auto max-w-screen-2xl space-y-4">
				<Link
					href={`/library/${project.contentId}/edits`}
					className="text-emerald-400 text-sm underline"
				>
					{t("editing.backProjects")}
				</Link>
				<h1 className="font-semibold text-2xl">{project.title}</h1>
				<p role="status" className="text-sm text-zinc-400">
					{t("editing.readOnly")}
				</p>
				{error && (
					<p role="alert" className="text-amber-300">
						{error}
					</p>
				)}
				{canMutate ? (
					<RenderPanel
						project={project}
						disabled={!canMutate || busy}
						generationDisabled
						showGeneration={false}
						onGenerate={() => {}}
						onCancel={cancelRun}
					/>
				) : (
					<RenderPanel
						project={project}
						disabled
						generationDisabled
						showGeneration={false}
						onGenerate={() => {}}
						onCancel={() => {}}
					/>
				)}
			</div>
		);
	}
	const legacyProject =
		project?.draft.schemaVersion === 1
			? { ...project, draft: project.draft }
			: null;
	if (!project || !draft || !legacyProject)
		return <p role="status">{t("editing.loading")}</p>;
	return (
		<div className="mx-auto max-w-screen-2xl space-y-4">
			{query.error && !onUnsavedChange && (
				<div role="alert" className="flex flex-wrap items-center gap-3">
					<p>{editingErrorMessage(query.error, t)}</p>
					<Button onClick={() => void query.refetch()}>
						{t("editing.refresh")}
					</Button>
				</div>
			)}
			<Link
				href={`/library/${project.contentId}/edits`}
				className="text-emerald-400 text-sm underline"
			>
				{t("editing.backProjects")}
			</Link>
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="font-semibold text-2xl">{project.title}</h1>
					<p className="mt-1 text-sm text-zinc-400">{t("editing.maximum")}</p>
				</div>
				<p role="status" className="text-sm text-zinc-400">
					{t(dirty ? "editing.unsaved" : "editing.saved")}
				</p>
			</header>
			{!canMutate && (
				<p className="text-sm text-zinc-400">{t("editing.readOnly")}</p>
			)}
			{error && (
				<div role="alert" className="space-y-2 text-amber-300 text-sm">
					<p>{error}</p>
					<Button
						variant="secondary"
						onClick={() =>
							void run(async () => {
								accept(
									await apiFetch<EditingProjectView>(
										`/api/library/edits/${id}`,
									),
								);
								setPast([]);
								setFuture([]);
							})
						}
					>
						{t("editing.reload")}
					</Button>
				</div>
			)}
			{pending && (
				<p role="status" className="text-amber-300 text-sm">
					{t("editing.rangePending")}
				</p>
			)}
			{!valid && (
				<p role="alert" className="text-amber-300 text-sm">
					{t("editing.invalidDocument")}
				</p>
			)}
			{canMutate ? (
				<EditorWorkbench
					project={legacyProject}
					document={draft}
					disabled={blocked}
					rangePending={numericRangePending}
					onChange={change}
					onRangePending={pendingRange}
					onCandidates={candidates}
					onAddCandidate={addCandidate}
					onGenerate={(kind) => void run(() => generate(kind))}
					onCancel={cancelRun}
					generationDisabled={
						blocked ||
						dirty ||
						pending ||
						!valid ||
						!project.currentRevisionId ||
						!project.currentRevisionMatchesDraft ||
						project.draftRevision !== baseRevision
					}
				/>
			) : (
				<EditorWorkbench
					project={legacyProject}
					document={draft}
					disabled
					rangePending={numericRangePending}
					onChange={() => {}}
					onRangePending={pendingRange}
					onCandidates={async () => []}
					onAddCandidate={() => {}}
					onGenerate={() => {}}
					onCancel={() => {}}
					generationDisabled
				/>
			)}
			<div className="sticky bottom-0 z-30 flex flex-wrap items-center gap-3 border-zinc-800 border-t bg-zinc-950/95 py-3">
				<Button
					variant="secondary"
					disabled={blocked || pending || !past.length}
					onClick={() => history("UNDO")}
				>
					{t("editing.undo")}
				</Button>
				<Button
					variant="secondary"
					disabled={blocked || pending || !future.length}
					onClick={() => history("REDO")}
				>
					{t("editing.redo")}
				</Button>
				{canMutate ? (
					<Button
						variant="secondary"
						disabled={blocked || !dirty || !valid || pending}
						onClick={() =>
							void run(async () => {
								await persistDraft();
							})
						}
					>
						{t("editing.saveDraft")}
					</Button>
				) : (
					<Button variant="secondary" disabled>
						{t("editing.saveDraft")}
					</Button>
				)}
				{canMutate ? (
					<Button
						disabled={
							blocked ||
							!valid ||
							pending ||
							(hasSuggestions && !confirmSuggestions)
						}
						onClick={() => void run(saveRevision)}
					>
						{t("editing.saveRevision")}
					</Button>
				) : (
					<Button disabled>{t("editing.saveRevision")}</Button>
				)}
				{hasSuggestions && (
					<label className="flex items-start gap-2 text-sm">
						<input
							type="checkbox"
							checked={confirmSuggestions}
							disabled={blocked}
							onChange={(event) => setConfirmSuggestions(event.target.checked)}
						/>
						{t("editing.confirmProposals")}
					</label>
				)}
			</div>
		</div>
	);
}
