"use client";

import {
	type VodInputPreviewSubmission,
	type VodInputPreviewTask,
	vodInputPreviewTaskSchema,
} from "@bitovp/core/vod-input-timeline";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

const endpoint = "/api/vod/input-previews";
export const taskRunning = (task: VodInputPreviewTask) =>
	task.status === "PENDING" || task.status === "RUNNING";

function cancel(task: VodInputPreviewTask | null) {
	if (task && taskRunning(task))
		void apiFetch(`${endpoint}/${task.id}`, { method: "DELETE" }).catch(
			() => {},
		);
}

function delay(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal.addEventListener("abort", abort, { once: true });
	});
}

function readTask(value: unknown, request: VodInputPreviewSubmission) {
	const task = vodInputPreviewTaskSchema.safeParse(
		(value as { task?: unknown } | null)?.task,
	);
	if (!task.success || task.data.kind !== request.kind)
		throw new Error("invalidResponse");
	if (Date.parse(task.data.expiresAt) <= Date.now()) throw new Error("expired");
	if (
		task.data.status === "SUCCEEDED" &&
		!(request.kind === "PROBE"
			? task.data.result?.sources
			: request.kind === "IMAGE_PREPARE"
				? task.data.result?.prepared
				: task.data.result?.preview)
	)
		throw new Error("invalidResponse");
	const preview = task.data.result?.preview;
	if (
		task.data.status === "SUCCEEDED" &&
		request.kind === "PREVIEW" &&
		(preview?.startMs !== request.range.startMs ||
			preview.durationMs !== request.range.durationMs)
	)
		throw new Error("invalidResponse");
	if (task.data.status === "SUCCEEDED" && request.kind === "IMAGE_PREPARE") {
		const prepared = task.data.result?.prepared;
		if (
			prepared?.requestedDurationMs !== request.durationMs ||
			prepared.source.credentialId !== request.output.credentialId ||
			prepared.source.bucket !== request.output.bucket
		)
			throw new Error("invalidResponse");
	}
	return task.data;
}

/** Only a task belonging to this exact request generation may become current. */
export function usePreviewTask(
	request: VodInputPreviewSubmission | null,
	{ debounceMs = 350, pollMs = 1000 } = {},
) {
	const requestKey = request ? JSON.stringify(request) : null;
	const [attempt, setAttempt] = useState(0);
	const executionKey = requestKey
		? JSON.stringify([attempt, requestKey])
		: null;
	const [state, setState] = useState<{
		key: string | null;
		task: VodInputPreviewTask | null;
		error: string | null;
	}>({ key: null, task: null, error: null });
	const [previous, setPrevious] = useState<VodInputPreviewTask | null>(null);
	const retry = useCallback(() => setAttempt((value) => value + 1), []);
	useEffect(() => {
		if (!executionKey) return;
		const [, body] = JSON.parse(executionKey) as [number, string];
		const current = JSON.parse(body) as VodInputPreviewSubmission;
		const controller = new AbortController();
		let active = true;
		let task: VodInputPreviewTask | null = null;
		setState({ key: executionKey, task: null, error: null });
		async function run() {
			try {
				task = readTask(
					await apiFetch(endpoint, {
						method: "POST",
						body,
						signal: controller.signal,
					}),
					current,
				);
				if (!active) return cancel(task);
				setState({ key: executionKey, task, error: null });
				while (taskRunning(task)) {
					await delay(pollMs, controller.signal);
					const next = readTask(
						await apiFetch(`${endpoint}/${task.id}`, {
							signal: controller.signal,
						}),
						current,
					);
					if (next.id !== task.id || next.requestHash !== task.requestHash)
						throw new Error("invalidResponse");
					task = next;
					if (!active) return;
					setState({ key: executionKey, task, error: null });
				}
				if (task.status === "SUCCEEDED") setPrevious(task);
				else
					setState({
						key: executionKey,
						task,
						error:
							task.error?.message ??
							(task.status === "CANCELED" ? "canceled" : "failed"),
					});
			} catch (error) {
				if (active)
					setState({
						key: executionKey,
						task,
						error: error instanceof Error ? error.message : "failed",
					});
			}
		}
		const timer = setTimeout(() => void run(), debounceMs);
		return () => {
			active = false;
			clearTimeout(timer);
			controller.abort();
			cancel(task);
		};
	}, [executionKey, debounceMs, pollMs]);
	useEffect(() => {
		if (!previous) return;
		const timer = setTimeout(
			() => {
				setPrevious(null);
				setState((current) =>
					current.task?.id === previous.id
						? { ...current, error: "expired" }
						: current,
				);
			},
			Math.min(
				2_147_483_647,
				Math.max(0, Date.parse(previous.expiresAt) - Date.now()),
			),
		);
		return () => clearTimeout(timer);
	}, [previous]);
	const current = executionKey !== null && state.key === executionKey;
	const task = current ? state.task : null;
	const error = current ? state.error : null;
	const ready = task?.status === "SUCCEEDED" && !error ? task : null;
	return {
		task,
		ready,
		previous,
		error,
		stale: !!previous && !ready,
		pending: !!requestKey && !ready && !error,
		retry,
	};
}
