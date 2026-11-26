"use client";

import type { ContentDetail } from "@bitovp/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import type {
	EditingMediaView,
	EditingProjectView,
} from "@/lib/library-editing";
import { ClipProjects } from "../../clip-projects";
import { editingStateLabel } from "../../edits/[id]/render-panel";
import { editingErrorMessage } from "../../edits/editing-errors";
import { AutoPortraitForm } from "./auto-portrait-form";
import { AutomaticProjectForm } from "./automatic-project-form";
import {
	type EditingEligibility,
	MediaPreparation,
	type NewEditingProject,
	ProjectCreation,
} from "./editing-forms";
import { useProductionCopy } from "./production-copy";

export function EditingLibraryClient({
	contentId,
	clipEditingAvailable = false,
}: {
	contentId: string;
	clipEditingAvailable?: boolean;
}) {
	const { t } = useT();
	return clipEditingAvailable ? (
		<EditingLibraryView key={contentId} contentId={contentId} />
	) : (
		<div className="space-y-4">
			<p className="text-sm text-zinc-400">
				{t("clipDiagnostics.unavailable")}
			</p>
			<ClipProjects contentId={contentId} readOnly showCreate={false} />
		</div>
	);
}
function EditingLibraryView({ contentId }: { contentId: string }) {
	const { t } = useT();
	const c = useProductionCopy();
	const router = useRouter();
	const queryClient = useQueryClient();
	const canMutate = useMutationAccess("library.edits.prepare");
	const [busy, setBusy] = useState(false);
	const [proposalBusy, setProposalBusy] = useState(false);
	const [error, setError] = useState("");
	const submitting = useRef(false);
	const mounted = useRef(true);
	const mutationAccess = useRef(canMutate);
	mutationAccess.current = canMutate;
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const isCurrent = () => mounted.current && mutationAccess.current;
	const content = useQuery({
		queryKey: ["library-edit-content", contentId],
		queryFn: ({ signal }) =>
			apiFetch<ContentDetail>(`/api/library/${contentId}`, { signal }),
	});
	const sourceId = content.data?.source.id;
	const eligibility = useQuery({
		queryKey: ["library-edit-eligibility", sourceId],
		enabled: !!sourceId,
		queryFn: ({ signal }) =>
			apiFetch<EditingEligibility>(
				`/api/library/sources/${sourceId}/editing-eligibility`,
				{ signal },
			),
		refetchInterval: (query) =>
			query.state.data?.mediaVersions.some((media) =>
				["PENDING", "PREPARING", "RUNNING"].includes(media.state),
			)
				? 3000
				: false,
	});
	async function run(action: () => Promise<void>) {
		if (!canMutate || submitting.current || proposalBusy) return;
		submitting.current = true;
		setBusy(true);
		setError("");
		try {
			await action();
		} catch (failure) {
			if (isCurrent()) setError(editingErrorMessage(failure, t));
		} finally {
			submitting.current = false;
			if (mounted.current) setBusy(false);
		}
	}
	async function prepare(
		fileKey: string,
		output: { credentialId: string; bucket: string; prefix: string },
	) {
		await apiFetch<EditingMediaView>(
			`/api/library/sources/${sourceId}/media-versions`,
			{ method: "POST", body: JSON.stringify({ fileKey, output }) },
		);
		if (isCurrent()) await eligibility.refetch();
	}
	async function create(input: NewEditingProject) {
		const project = await apiFetch<EditingProjectView>("/api/library/edits", {
			method: "POST",
			body: JSON.stringify({ contentId, ...input }),
		});
		if (isCurrent()) router.push(`/library/edits/${project.id}`);
	}
	const readError = content.error ?? eligibility.error;
	const automatic = eligibility.data?.automatic;
	return (
		<div className="mx-auto max-w-6xl space-y-5">
			<Link
				href={`/library/${contentId}`}
				className="text-emerald-400 text-sm underline"
			>
				{t("editing.backContent")}
			</Link>
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="font-semibold text-2xl">
						{content.data?.title ?? t("editing.projects")}
					</h1>
					<p className="mt-1 max-w-3xl text-sm text-zinc-400">
						{t("editing.support")}
					</p>
				</div>
				<Button
					variant="secondary"
					disabled={content.isFetching || eligibility.isFetching}
					onClick={() => {
						void content.refetch();
						void eligibility.refetch();
						void queryClient.invalidateQueries({
							queryKey: ["library-edit-projects", contentId],
						});
					}}
				>
					{t("editing.refresh")}
				</Button>
			</header>
			{!canMutate && (
				<p className="text-sm text-zinc-400">{t("editing.readOnly")}</p>
			)}
			{(error || readError) && (
				<p role="alert" className="text-sm text-red-400">
					{error || editingErrorMessage(readError, t)}
				</p>
			)}
			{(content.isPending || eligibility.isPending) && (
				<p role="status">{t("editing.loading")}</p>
			)}
			{eligibility.data && !readError && (
				<>
					{automatic
						? automatic.reason !== "NO_ENCODING_SOURCE" && (
								<AutomaticProjectForm
									key={`${contentId}:${eligibility.data.sourceId}:${automatic.encodingId}`}
									contentId={contentId}
									initialTitle={content.data?.title ?? ""}
									eligibility={eligibility.data}
									context={automatic}
									disabled={busy || !canMutate}
									onBusyChange={setProposalBusy}
								/>
							)
						: canMutate && (
								<AutoPortraitForm
									contentId={contentId}
									initialTitle={content.data?.title ?? ""}
									eligibility={eligibility.data}
									disabled={busy || !canMutate}
									onBusyChange={setProposalBusy}
								/>
							)}
					{automatic?.reason === "NO_ENCODING_SOURCE" && (
						<p className="text-sm text-zinc-400">{c.manualSourceHelp}</p>
					)}
					<ManualSourceTools enabled={!!automatic} label={c.manualSourceTools}>
						{canMutate ? (
							<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
								<MediaPreparation
									eligibility={eligibility.data}
									disabled={busy || proposalBusy}
									onPrepare={(file, output) =>
										void run(() => prepare(file, output))
									}
								/>
								<ProjectCreation
									eligibility={eligibility.data}
									initialTitle={content.data?.title ?? ""}
									disabled={busy || proposalBusy}
									onCreate={(input) => void run(() => create(input))}
								/>
							</div>
						) : (
							<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
								<MediaPreparation
									eligibility={eligibility.data}
									disabled
									onPrepare={() => {}}
								/>
								<ProjectCreation
									eligibility={eligibility.data}
									initialTitle={content.data?.title ?? ""}
									disabled
									onCreate={() => {}}
								/>
							</div>
						)}
					</ManualSourceTools>
					{eligibility.data.mediaVersions.length > 0 && (
						<section className="space-y-3">
							<h2 className="font-semibold">{t("editing.mediaVersions")}</h2>
							<ol className="space-y-2">
								{eligibility.data.mediaVersions.map((media, index) => (
									<li
										key={media.id}
										className="rounded-md border border-zinc-800 p-3 text-sm"
									>
										{index + 1} · {editingStateLabel(media.state, t)}
										{media.durationUs !== null &&
											` · ${(media.durationUs / 1_000_000).toFixed(1)}s`}
										{media.error && (
											<p className="mt-1 break-words text-red-400">
												{editingErrorMessage(media.error, t)}
											</p>
										)}
									</li>
								))}
							</ol>
						</section>
					)}
				</>
			)}
			<ClipProjects
				contentId={contentId}
				showCreate={false}
				clipEditingAvailable
			/>
		</div>
	);
}

function ManualSourceTools({
	enabled,
	label,
	children,
}: {
	enabled: boolean;
	label: string;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	if (!enabled) return children;
	return (
		<details
			className="space-y-4"
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary className="cursor-pointer text-sm text-zinc-300">
				{label}
			</summary>
			<div hidden={!open}>{children}</div>
		</details>
	);
}
