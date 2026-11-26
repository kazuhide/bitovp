"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { useDocumentOrganization } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import type { StoredEditingExport } from "@/lib/library-editing";
import {
	createdEditShape,
	REEDIT_STORAGE_PREFIX,
	retainPendingEdit,
} from "@/lib/reedit-navigation";
import { storedEditingSettingsSchema } from "@/lib/stored-editing-settings";
import { boundExportLinks, ClipExportVideo } from "../../../clip-export-video";
import { editingErrorMessage } from "../../editing-errors";
import { portraitRenderShape } from "./portrait-result-schema";
import { StoredClipSettings } from "./stored-clip-settings";

const storedExportShape = z.object({
	projectId: z.uuid(),
	contentId: z.uuid(),
	title: z.string(),
	earlierVersion: z.boolean(),
	purpose: z.enum(["CLIP", "HIGHLIGHT", "TRAILER"]),
	settings: storedEditingSettingsSchema.optional(),
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
	const router = useRouter();
	const roleAllowsEdit = useMutationAccess("library.edits.edit");
	const canEdit = roleAllowsEdit && clipEditingAvailable;
	const unavailableDescription = useId();
	const [videoAttempt, setVideoAttempt] = useState(0);
	const [reediting, setReediting] = useState(false);
	const [reeditError, setReeditError] = useState("");
	const pendingReedit = useRef<AbortController | null>(null);
	const createdWithoutStorage = useRef<string | null>(null);
	useEffect(() => () => pendingReedit.current?.abort(), []);
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
	const settings = links ? result.settings : undefined;
	async function reedit() {
		if (!organizationId || !canEdit || !settings || pendingReedit.current)
			return;
		const controller = new AbortController();
		pendingReedit.current = controller;
		setReediting(true);
		setReeditError("");
		const storageKey = `${REEDIT_STORAGE_PREFIX}${organizationId}:${id}:${exportId}`;
		try {
			if (createdWithoutStorage.current) {
				router.push(`/library/edits/${createdWithoutStorage.current}`);
				return;
			}
			const title =
				result.title + t("editing.exportSettings.reeditTitleSuffix");
			let pending: ReturnType<typeof retainPendingEdit>;
			try {
				pending = retainPendingEdit(
					storageKey,
					title.length <= 500 ? title : result.title,
				);
			} catch {
				setReeditError(t("editing.exportSettings.reeditStorageUnavailable"));
				return;
			}
			const created =
				pending.created ??
				createdEditShape.parse(
					await apiFetch("/api/library/edits", {
						method: "POST",
						body: JSON.stringify({
							title: pending.title,
							fromExport: {
								projectId: id,
								exportId,
								expectedOrganizationId: organizationId,
								requestKey: pending.requestKey,
							},
						}),
						signal: controller.signal,
					}),
				);
			if (created.id === id || created.contentId !== result.contentId)
				throw new Error("INVALID_REEDIT_RESPONSE");
			if (controller.signal.aborted) return;
			if (!pending.created) {
				try {
					window.sessionStorage.setItem(
						storageKey,
						JSON.stringify({ ...pending, created }),
					);
				} catch {
					// The original request can still replay this edit after a reload.
					createdWithoutStorage.current = created.id;
				}
			}
			router.push(`/library/edits/${created.id}`);
		} catch (failure) {
			if (!controller.signal.aborted)
				setReeditError(editingErrorMessage(failure, t));
		} finally {
			pendingReedit.current = null;
			if (!controller.signal.aborted) setReediting(false);
		}
	}
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
			<header className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
					<h1 className="break-words font-semibold text-2xl [overflow-wrap:anywhere]">
						{result.title}
					</h1>
					{result.earlierVersion && (
						<span className="text-sm text-zinc-400">
							{t("editing.earlierExport")}
						</span>
					)}
				</div>
				{roleAllowsEdit && settings && (
					<div className="space-y-1">
						<Button
							disabled={!canEdit || reediting}
							aria-describedby={canEdit ? undefined : unavailableDescription}
							onClick={() => void reedit()}
						>
							{t(
								reediting
									? "editing.exportSettings.preparing"
									: "editing.exportSettings.reedit",
							)}
						</Button>
						{!canEdit && (
							<p id={unavailableDescription} className="text-xs text-zinc-400">
								{t("editing.exportSettings.reeditUnavailable")}
							</p>
						)}
					</div>
				)}
			</header>
			{reeditError && (
				<p role="alert" className="text-amber-300 text-sm">
					{reeditError}
				</p>
			)}
			<div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
				<div className="min-w-0 space-y-3">
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
							{t(
								canEdit
									? "editing.exportSettings.originalEdit"
									: "editing.renders",
							)}
						</Link>
						<Button
							variant="ghost"
							disabled={query.isFetching}
							onClick={refresh}
						>
							{t("editing.refresh")}
						</Button>
					</div>
				</div>
				{links && <StoredClipSettings settings={settings} />}
			</div>
		</div>
	);
}
