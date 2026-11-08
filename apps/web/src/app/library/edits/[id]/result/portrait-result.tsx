"use client";

import { anyEditingDocumentSchema } from "@bitovp/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import type {
	AnyEditingProjectView,
	EditingRenderView,
} from "@/lib/library-editing";
import { editingErrorMessage } from "../../editing-errors";
import { useCompositionCopy } from "../composition-copy";
import { PortraitResultActions } from "./portrait-result-actions";
import {
	latestPortraitExport,
	PortraitResultContent,
} from "./portrait-result-content";
import { portraitRenderShape } from "./portrait-result-schema";

const projectShape = z.object({
	id: z.uuid(),
	contentId: z.uuid(),
	title: z.string(),
	currentRevisionId: z.uuid().nullable(),
	currentRevisionMatchesDraft: z.boolean(),
	draft: anyEditingDocumentSchema,
	renders: z.array(portraitRenderShape),
});
export function PortraitResult({
	id,
	clipEditingAvailable = true,
}: {
	id: string;
	clipEditingAvailable?: boolean;
}) {
	return (
		<PortraitResultView
			key={id}
			id={id}
			clipEditingAvailable={clipEditingAvailable}
		/>
	);
}
function PortraitResultView({
	id,
	clipEditingAvailable,
}: {
	id: string;
	clipEditingAvailable: boolean;
}) {
	const { t } = useT();
	const c = useCompositionCopy();
	const canMutate = useMutationAccess("library.edits.result");
	const client = useQueryClient();
	const queryKey = ["library-edit", id];
	const query = useQuery({
		queryKey,
		staleTime: 0,
		queryFn: async ({ signal }) => {
			const value = await apiFetch<AnyEditingProjectView>(
				`/api/library/edits/${id}`,
				{ signal },
			);
			const parsed = projectShape.parse(value);
			if (parsed.id !== id) throw new Error("INVALID_PROJECT_RESPONSE");
			return { ...value, draft: parsed.draft, renders: parsed.renders };
		},
		// An unacknowledged POST may have committed after the last terminal run.
		refetchInterval: 3000,
	});
	const project = query.data;
	const latest = project && latestPortraitExport(project);
	const [videoAttempt, setVideoAttempt] = useState(0);
	function acceptRun(run: EditingRenderView) {
		client.setQueryData<AnyEditingProjectView>(
			queryKey,
			(value) =>
				value && {
					...value,
					renders: [
						run,
						...value.renders.filter((prior) => prior.id !== run.id),
					],
				},
		);
		void client.invalidateQueries({ queryKey });
	}
	function refresh() {
		setVideoAttempt((value) => value + 1);
		void query.refetch();
	}
	if (query.error)
		return (
			<div role="alert" className="space-y-3 text-sm">
				<p>{editingErrorMessage(query.error, t)}</p>
				<Button variant="secondary" onClick={refresh}>
					{t("editing.refresh")}
				</Button>
			</div>
		);
	if (!project)
		return (
			<p role="status" aria-live="polite">
				{t("editing.loading")}
			</p>
		);
	return (
		<div className="mx-auto max-w-5xl space-y-6">
			<Link
				href={`/library/${project.contentId}`}
				className="rounded text-emerald-400 text-sm underline focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2"
			>
				{t("editing.backContent")}
			</Link>
			<header className="space-y-2">
				<h1 className="font-semibold text-2xl">
					{project.draft.schemaVersion === 2
						? c.resultTitle
						: t("editing.autoPortrait.resultTitle")}
				</h1>
				<p className="break-words text-sm text-zinc-400">{project.title}</p>
			</header>
			{!canMutate && (
				<p className="text-sm text-zinc-400">{t("editing.readOnly")}</p>
			)}
			<PortraitResultContent
				project={project}
				run={latest}
				videoAttempt={videoAttempt}
				allowEditing={clipEditingAvailable}
			/>
			<div className="space-y-3 border-zinc-800 border-t pt-4">
				{canMutate && (
					<PortraitResultActions
						project={project}
						allowNewRender={clipEditingAvailable}
						onRun={acceptRun}
						disabled={query.isError}
					/>
				)}
				<Button variant="ghost" disabled={query.isFetching} onClick={refresh}>
					{t("editing.refresh")}
				</Button>
			</div>
		</div>
	);
}
