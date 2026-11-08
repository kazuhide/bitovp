"use client";
import {
	generationTaskResultSchema,
	LOCAL_STORY_MAX_CHUNKS,
	type MediaTaskView,
	mediaTaskReceiptSchema,
	mediaTaskViewSchema,
} from "@bitovp/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { ApiError, apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import {
	productionFailure,
	productionPhase,
	productionWarning,
	useProductionCopy,
} from "../../[id]/edits/production-copy";

const terminal = (task: MediaTaskView | undefined) =>
	!!task && ["SUCCEEDED", "ERROR", "CANCELED"].includes(task.state);

function phaseSegmentCounts(task: MediaTaskView | undefined) {
	if (
		task?.state !== "RUNNING" ||
		!task.progress ||
		typeof task.progress !== "object" ||
		Array.isArray(task.progress)
	)
		return null;
	const fields =
		task.phase === "TRANSCRIBING_STORY" || task.phase === "TRANSCRIBING"
			? (["completedWindows", "totalWindows", "transcribingSections"] as const)
			: task.phase === "ANALYZING_LOCAL_STORY"
				? (["completedChunks", "totalChunks", "analyzingSections"] as const)
				: null;
	if (!fields) return null;
	const progress = task.progress as Record<string, unknown>,
		completed = progress[fields[0]],
		total = progress[fields[1]];
	// The chunk ceiling also covers the source's bounded ASR windows.
	if (
		typeof completed !== "number" ||
		typeof total !== "number" ||
		!Number.isSafeInteger(completed) ||
		!Number.isSafeInteger(total) ||
		completed < 0 ||
		total < 1 ||
		total > LOCAL_STORY_MAX_CHUNKS ||
		completed > total
	)
		return null;
	return { completed, total, copyKey: fields[2] };
}

export function GenerationProgress({
	id,
	clipEditingAvailable = true,
}: {
	id: string;
	clipEditingAvailable?: boolean;
}) {
	return (
		<GenerationProgressView
			key={id}
			id={id}
			clipEditingAvailable={clipEditingAvailable}
		/>
	);
}
function GenerationProgressView({
	id,
	clipEditingAvailable,
}: {
	id: string;
	clipEditingAvailable: boolean;
}) {
	const c = useProductionCopy(),
		router = useRouter(),
		client = useQueryClient();
	const canMutate = useMutationAccess("library.edits.edit"),
		queryKey = ["library-media-task", id];
	const query = useQuery({
		queryKey,
		staleTime: 0,
		enabled: z.uuid().safeParse(id).success,
		queryFn: async ({ signal }) => {
			const value = mediaTaskViewSchema.parse(
				await apiFetch<unknown>(`/api/library/media-tasks/${id}`, { signal }),
			);
			if (value.taskId !== id || value.kind !== "GENERATE")
				throw new Error("TASK_RESPONSE_INVALID");
			const observed = client.getQueryData<MediaTaskView>(queryKey);
			return observed && ["SUCCEEDED", "CANCELED"].includes(observed.state)
				? observed
				: value;
		},
		refetchInterval: (value) => (terminal(value.state.data) ? false : 3000),
	});
	const task = query.data,
		latest = useRef(task);
	latest.current = task;
	const [busy, setBusy] = useState<"cancel" | "retry" | null>(null),
		[error, setError] = useState(""),
		[uncertain, setUncertain] = useState(false),
		[cancelRequested, setCancelRequested] = useState(false);
	const submitting = useRef(false),
		retryKey = useRef<string | null>(null),
		mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	async function cancel() {
		if (!canMutate || submitting.current || terminal(latest.current)) return;
		submitting.current = true;
		setBusy("cancel");
		setError("");
		setUncertain(false);
		try {
			const response = mediaTaskViewSchema.parse(
				await apiFetch<unknown>(`/api/library/media-tasks/${id}/cancel`, {
					method: "POST",
				}),
			);
			if (response.taskId !== id || response.kind !== "GENERATE")
				throw new Error("TASK_RESPONSE_INVALID");
			if (mounted.current) {
				client.setQueryData<MediaTaskView>(queryKey, (current) =>
					terminal(current) ? current : response,
				);
				setCancelRequested(!terminal(response));
				if (!terminal(response)) void query.refetch();
			}
		} catch (failure) {
			if (mounted.current && !terminal(latest.current)) {
				setError(c.error);
				setUncertain(!(failure instanceof ApiError) || failure.status >= 500);
			}
		} finally {
			submitting.current = false;
			if (mounted.current) setBusy(null);
		}
	}
	async function retry() {
		if (!clipEditingAvailable) return;
		if (
			!canMutate ||
			submitting.current ||
			!latest.current ||
			!["ERROR", "CANCELED"].includes(latest.current.state)
		)
			return;
		submitting.current = true;
		setBusy("retry");
		setError("");
		setUncertain(false);
		retryKey.current ??= crypto.randomUUID();
		let navigating = false;
		try {
			const response = mediaTaskReceiptSchema.parse(
				await apiFetch<unknown>(`/api/library/media-tasks/${id}/retry`, {
					method: "POST",
					body: JSON.stringify({ requestKey: retryKey.current }),
				}),
			);
			if (response.taskId === id) throw new Error("TASK_RETRY_INVALID");
			if (mounted.current) {
				router.push(`/library/generations/${response.taskId}`);
				navigating = true;
			}
		} catch (failure) {
			const unknown = !(failure instanceof ApiError) || failure.status >= 500;
			if (!unknown) retryKey.current = null;
			if (mounted.current) {
				setError(c.error);
				setUncertain(unknown);
			}
		} finally {
			if (!navigating) {
				submitting.current = false;
				if (mounted.current) setBusy(null);
			}
		}
	}
	const result =
		task?.state === "SUCCEEDED"
			? generationTaskResultSchema.safeParse(task.result)
			: null;
	const draftResult = result?.success && result.data.renderMode === "DRAFT";
	const draftMode = task?.renderMode === "DRAFT" || draftResult;
	const openedProject = useRef<string | null>(null);
	useEffect(() => {
		if (
			!clipEditingAvailable ||
			!mounted.current ||
			!result?.success ||
			result.data.renderMode !== "DRAFT" ||
			result.data.projectIds.length !== 1 ||
			openedProject.current === result.data.projectId
		)
			return;
		openedProject.current = result.data.projectId;
		router.replace(`/library/edits/${result.data.projectId}`);
	}, [result, router, clipEditingAvailable]);
	const phase =
		task?.state === "ERROR"
			? draftMode
				? c.projectFailed
				: c.failed
			: task?.state === "CANCELED"
				? draftMode
					? c.projectCanceled
					: c.canceled
				: task?.state === "SUCCEEDED"
					? c.complete
					: task
						? draftMode && task.phase === "PUBLISHING"
							? c.savingProject
							: productionPhase(task.phase, c)
						: c.loading;
	const counts = query.isError ? null : phaseSegmentCounts(task);
	const countText = counts
		? c[counts.copyKey]
				.replace("{completed}", String(counts.completed))
				.replace("{total}", String(counts.total))
		: "";
	return (
		<div className="mx-auto max-w-3xl space-y-6">
			<h1 className="font-semibold text-2xl">
				{draftMode ? c.projectProgress : c.progressTitle}
			</h1>
			{!canMutate && <p className="text-sm text-zinc-400">{c.readOnly}</p>}
			{(query.error || !z.uuid().safeParse(id).success) && (
				<p role="alert" className="text-amber-300 text-sm">
					{c.error}
				</p>
			)}
			<div className="space-y-1">
				<p role="status" aria-live="polite" className="text-sm">
					{phase}
				</p>
				{counts && (
					<p
						role="progressbar"
						aria-label={phase}
						aria-valuemin={0}
						aria-valuenow={counts.completed}
						aria-valuemax={counts.total}
						aria-valuetext={countText}
						aria-live="off"
						className="text-sm text-zinc-400"
					>
						{countText}
					</p>
				)}
			</div>
			{task?.state === "ERROR" && (
				<p className="text-sm text-zinc-400">
					{productionFailure(task.error, c)}
				</p>
			)}
			{result && !result.success && (
				<p role="alert" className="text-amber-300 text-sm">
					{c.invalidResult}
				</p>
			)}
			{result?.success && (
				<section className="space-y-4 rounded-lg border border-zinc-800 p-4 sm:p-6">
					<p className="text-sm text-zinc-400">
						{draftResult ? c.projectReady : c.resultHelp}
					</p>
					<dl className="text-sm">
						<dt className="text-zinc-400">{c.durationLabel}</dt>
						<dd>
							{(result.data.actualFrames / 30).toFixed(2)}s /{" "}
							{(result.data.requestedFrames / 30).toFixed(2)}s
						</dd>
					</dl>
					<ul className="space-y-2">
						{result.data.projectIds.map((projectId, index) => (
							<li key={projectId}>
								<Link
									className="inline-flex rounded font-medium text-emerald-400 text-sm underline focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2"
									href={
										draftResult && clipEditingAvailable
											? `/library/edits/${projectId}`
											: `/library/edits/${projectId}/result`
									}
								>
									{draftResult && clipEditingAvailable
										? c.openEditor
										: c.result}{" "}
									·{" "}
									{result.data.presetIds[index] === "landscape-clean"
										? c.landscape
										: result.data.presetIds[index] === "square-clean"
											? c.square
											: c.portrait}
								</Link>
							</li>
						))}
					</ul>
					{result.data.warnings.length > 0 && (
						<div className="space-y-2">
							<h2 className="font-medium text-sm">{c.warningTitle}</h2>
							<ul className="list-disc space-y-1 pl-5 text-sm text-zinc-400">
								{[
									...new Set(
										result.data.warnings.map((code) =>
											productionWarning(code, c),
										),
									),
								].map((message) => (
									<li key={message}>{message}</li>
								))}
							</ul>
						</div>
					)}
				</section>
			)}
			{cancelRequested && !terminal(task) && (
				<p role="status" className="text-sm text-zinc-400">
					{c.cancelRequested}
				</p>
			)}
			{error && (
				<div role="alert" className="space-y-1 text-amber-300 text-sm">
					<p>{error}</p>
					{uncertain && <p>{c.unknown}</p>}
				</div>
			)}
			<div className="flex flex-wrap gap-3">
				{canMutate && task && !terminal(task) && (
					<Button
						variant="secondary"
						disabled={!!busy || cancelRequested || query.isError}
						onClick={() => {
							void cancel();
						}}
					>
						{busy === "cancel"
							? c.canceling
							: draftMode
								? c.cancelProject
								: c.cancel}
					</Button>
				)}
				{canMutate &&
					clipEditingAvailable &&
					task &&
					["ERROR", "CANCELED"].includes(task.state) && (
						<Button
							disabled={!!busy || query.isError}
							onClick={() => {
								void retry();
							}}
						>
							{busy === "retry" ? c.retrying : c.retry}
						</Button>
					)}
				<Button
					variant="ghost"
					disabled={query.isFetching}
					onClick={() => {
						void query.refetch();
					}}
				>
					{c.reload}
				</Button>
			</div>
		</div>
	);
}
