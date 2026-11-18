"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { z } from "zod";
import { useDocumentOrganization } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import type { StoredEditingExport } from "@/lib/library-editing";
import { boundExportLinks, ClipExportVideo } from "../../../clip-export-video";
import { editingErrorMessage } from "../../editing-errors";
import { portraitRenderShape } from "./portrait-result-schema";

const storedExportShape = z.object({
	projectId: z.uuid(),
	contentId: z.uuid(),
	title: z.string(),
	earlierVersion: z.boolean(),
	purpose: z.enum(["CLIP", "HIGHLIGHT", "TRAILER"]),
	render: portraitRenderShape.extend({
		kind: z.literal("EXPORT"),
		state: z.literal("SUCCEEDED"),
		generation: z.number().int().positive(),
		artifact: portraitRenderShape.shape.artifact.unwrap(),
	}),
});

export function StoredClipResult(props: {
	id: string;
	exportId: string;
	clipEditingAvailable: boolean;
}) {
	const organizationId = useDocumentOrganization();
	return (
		<StoredClipResultView
			key={`${organizationId}:${props.id}:${props.exportId}`}
			organizationId={organizationId}
			{...props}
		/>
	);
}

function StoredClipResultView({
	id,
	exportId,
	clipEditingAvailable,
	organizationId,
}: {
	id: string;
	exportId: string;
	clipEditingAvailable: boolean;
	organizationId: string | undefined;
}) {
	const { t } = useT();
	const canEdit =
		useMutationAccess("library.edits.edit") && clipEditingAvailable;
	const [videoAttempt, setVideoAttempt] = useState(0);
	const query = useQuery({
		queryKey: ["library-export", organizationId, id, exportId],
		queryFn: async ({ signal }) => {
			const value = await apiFetch<StoredEditingExport>(
				`/api/library/edits/${id}?${new URLSearchParams({ exportId })}`,
				{ signal },
			);
			const result = storedExportShape.parse(value);
			if (result.projectId !== id || result.render.id !== exportId)
				throw new Error("INVALID_EXPORT_RESPONSE");
			return result;
		},
		refetchOnMount: "always",
	});
	function refresh() {
		setVideoAttempt((attempt) => attempt + 1);
		void query.refetch();
	}
	if (query.isError)
		return (
			<div role="alert" className="space-y-3 text-sm">
				<p>{editingErrorMessage(query.error, t)}</p>
				<Button variant="secondary" onClick={refresh}>
					{t("editing.refresh")}
				</Button>
			</div>
		);
	if (!query.data) return <p role="status">{t("editing.loading")}</p>;
	const result = query.data;
	const links = boundExportLinks(result.render.artifact, organizationId);
	const linkClass =
		"rounded text-emerald-400 text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-emerald-500";
	return (
		<div className="mx-auto max-w-5xl space-y-4">
			<Link
				href={`/library/${result.contentId}#finished-clips`}
				className={linkClass}
			>
				{t("editing.backContent")}
			</Link>
			<header className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<h1 className="break-words font-semibold text-2xl [overflow-wrap:anywhere]">
					{result.title}
				</h1>
				{result.earlierVersion && (
					<span className="text-sm text-zinc-400">
						{t("editing.earlierExport")}
					</span>
				)}
			</header>
			{links ? (
				<ClipExportVideo
					key={videoAttempt}
					src={links.media}
					title={result.title}
				/>
			) : (
				<p role="alert" className="text-amber-300 text-sm">
					{t("editing.autoPortrait.missingArtifact")}
				</p>
			)}
			<div className="flex flex-wrap items-center gap-4">
				{links && (
					<a href={links.download} className={linkClass}>
						{t("editing.downloadClip")}
					</a>
				)}
				<Link href={`/library/edits/${id}`} className={linkClass}>
					{t(canEdit ? "editing.open" : "editing.renders")}
				</Link>
				<Button variant="ghost" disabled={query.isFetching} onClick={refresh}>
					{t("editing.refresh")}
				</Button>
			</div>
		</div>
	);
}
