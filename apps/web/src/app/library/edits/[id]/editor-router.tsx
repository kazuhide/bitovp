"use client";
import {
	type CompositionDocument,
	type EditDocument,
	toCompositionDocument,
} from "@bitovp/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import type {
	AnyEditingProjectView,
	EditingProjectView,
} from "@/lib/library-editing";
import { editingErrorMessage } from "../editing-errors";
import { useCompositionCopy } from "./composition-copy";
import { CompositionWorkbench } from "./composition-workbench";
import { EditorClient, type LegacyEditingSession } from "./editor-client";
export function EditorRouter({ id }: { id: string }) {
	return <EditorRouterView key={id} id={id} />;
}
function EditorRouterView({ id }: { id: string }) {
	const c = useCompositionCopy(),
		{ t } = useT(),
		canMutate = useMutationAccess("library.edits.edit"),
		client = useQueryClient(),
		[busy, setBusy] = useState(false),
		[error, setError] = useState("");
	const [legacyUnsafe, setLegacyUnsafe] = useState(true);
	const legacyProject = useRef<EditingProjectView | null>(null),
		localLegacyDraft = useRef<EditDocument | null>(null);
	const [canLoadLegacy, setCanLoadLegacy] = useState(false),
		[loadedRemote, setLoadedRemote] = useState(false),
		[initialUndoDraft, setInitialUndoDraft] = useState<CompositionDocument>();
	const onLegacyChange = useCallback(
		(unsafe: boolean, session: LegacyEditingSession) => {
			setLegacyUnsafe(unsafe);
			localLegacyDraft.current = session.draft;
			setCanLoadLegacy(
				!session.pending && !session.busy && session.draft !== null,
			);
		},
		[],
	);
	const queryKey = ["library-edit", id],
		query = useQuery({
			queryKey,
			queryFn: ({ signal }) =>
				apiFetch<AnyEditingProjectView>(`/api/library/edits/${id}`, { signal }),
			refetchInterval: 3000,
		});
	async function upgrade() {
		if (
			!canMutate ||
			legacyUnsafe ||
			busy ||
			!query.data ||
			query.data.draft.schemaVersion !== 1
		)
			return;
		setBusy(true);
		setError("");
		try {
			const next = await apiFetch<AnyEditingProjectView>(
				`/api/library/edits/${id}/draft`,
				{
					method: "PUT",
					body: JSON.stringify({
						expectedRevision: query.data.draftRevision,
						document: toCompositionDocument(query.data.draft),
					}),
				},
			);
			client.setQueryData(queryKey, next);
		} catch (failure) {
			setError(editingErrorMessage(failure, t));
		} finally {
			setBusy(false);
		}
	}
	if (
		query.error &&
		(!query.data ||
			(query.error instanceof ApiError &&
				query.error.status >= 400 &&
				query.error.status < 500))
	)
		return (
			<p role="alert" className="p-6 text-amber-300">
				{editingErrorMessage(query.error, t)}
			</p>
		);
	if (!query.data)
		return (
			<p role="status" className="p-6 text-zinc-400">
				{c.loading}
			</p>
		);
	if (query.data.draft.schemaVersion === 1)
		legacyProject.current = { ...query.data, draft: query.data.draft };
	const holdLegacy =
		query.data.draft.schemaVersion === 2 &&
		legacyProject.current !== null &&
		legacyUnsafe &&
		!loadedRemote;
	return (
		<>
			{query.error && (
				<section className="mx-4 mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-900 p-3">
					<p role="alert">{editingErrorMessage(query.error, t)}</p>
					<Button variant="secondary" onClick={() => void query.refetch()}>
						{c.retry}
					</Button>
				</section>
			)}
			{query.data.draft.schemaVersion === 2 && !holdLegacy ? (
				<CompositionWorkbench
					key={id}
					project={{ ...query.data, draft: query.data.draft }}
					initialUndoDraft={initialUndoDraft}
				/>
			) : (
				<>
					<section className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 p-4">
						<p className="max-w-xl text-xs text-zinc-400">
							{holdLegacy ? c.remoteUpgrade : c.upgradeHelp}
						</p>
						{canMutate && (
							<Button
								disabled={
									!canMutate ||
									busy ||
									(holdLegacy ? !canLoadLegacy : legacyUnsafe)
								}
								onClick={() => {
									if (holdLegacy) {
										if (!canLoadLegacy || !localLegacyDraft.current) return;
										setInitialUndoDraft(
											toCompositionDocument(localLegacyDraft.current),
										);
										setLoadedRemote(true);
									} else void upgrade();
								}}
							>
								{holdLegacy ? c.reloadSaved : c.upgrade}
							</Button>
						)}
						{error && <p role="alert">{error}</p>}
					</section>
					<EditorClient
						id={id}
						onUnsavedChange={onLegacyChange}
						projectOverride={
							holdLegacy ? (legacyProject.current ?? undefined) : undefined
						}
					/>
				</>
			)}
		</>
	);
}
