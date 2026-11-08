"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import type {
	AnyEditingProjectView,
	EditingRenderView,
} from "@/lib/library-editing";
import { editingErrorMessage } from "../../editing-errors";
import {
	latestPortraitExport,
	renderIsActive,
} from "./portrait-result-content";
import { portraitRenderShape } from "./portrait-result-schema";

type RetryRequest = { revisionId: string; key: string; acknowledged: boolean };
/** Its parent renders this delegated mutation surface only for the declared role gate. */
export function PortraitResultActions({
	project,
	disabled,
	onRun,
	allowNewRender = true,
}: {
	project: AnyEditingProjectView;
	disabled: boolean;
	onRun: (run: EditingRenderView) => void;
	allowNewRender?: boolean;
}) {
	const { t } = useT();
	const latest = latestPortraitExport(project);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [uncertain, setUncertain] = useState(false);
	const running = useRef(false);
	const mounted = useRef(true);
	const request = useRef<RetryRequest | null>(null);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		const pending = request.current;
		if (!pending || pending.acknowledged) return;
		if (
			project.renders.some(
				(run) =>
					run.kind === "EXPORT" &&
					run.revisionId === pending.revisionId &&
					run.requestKey === pending.key,
			)
		) {
			pending.acknowledged = true;
			setError("");
			setUncertain(false);
		}
	}, [project.renders]);
	async function execute(action: "RETRY" | "CANCEL", renderId?: string) {
		if (action === "RETRY" && !allowNewRender) return;
		if (disabled || running.current) return;
		const revisionId = project.currentRevisionId;
		if (
			action === "RETRY" &&
			(!revisionId ||
				!project.currentRevisionMatchesDraft ||
				renderIsActive(latest))
		)
			return;
		if (
			action === "CANCEL" &&
			(!latest ||
				latest.id !== renderId ||
				!renderIsActive(latest) ||
				latest.state === "CANCEL_REQUESTED")
		)
			return;
		running.current = true;
		setBusy(true);
		setError("");
		setUncertain(false);
		let attempt: RetryRequest | null = null;
		try {
			let run: EditingRenderView;
			if (action === "RETRY" && revisionId) {
				if (
					!request.current ||
					request.current.revisionId !== revisionId ||
					request.current.acknowledged
				)
					request.current = {
						revisionId,
						key: crypto.randomUUID(),
						acknowledged: false,
					};
				attempt = request.current;
				run = await apiFetch<EditingRenderView>(
					`/api/library/edits/${project.id}/renders`,
					{
						method: "POST",
						body: JSON.stringify({
							revisionId,
							kind: "EXPORT",
							requestKey: attempt.key,
						}),
					},
				);
			} else {
				run = await apiFetch<EditingRenderView>(
					`/api/library/renders/${renderId}/cancel`,
					{ method: "POST", body: "{}" },
				);
			}
			run = portraitRenderShape.parse(run);
			if (
				run.kind !== "EXPORT" ||
				(action === "RETRY" &&
					run.requestKey !== undefined &&
					run.requestKey !== attempt?.key) ||
				(action === "RETRY"
					? run.revisionId !== revisionId
					: run.id !== renderId)
			)
				throw new Error("INVALID_RENDER_RESPONSE");
			if (attempt) attempt.acknowledged = true;
			onRun(run);
		} catch (failure) {
			// A matching GET can acknowledge the write before its response is lost.
			if (action === "RETRY" && attempt?.acknowledged) return;
			const unknown = !(failure instanceof ApiError) || failure.status >= 500;
			if (action === "RETRY" && !unknown) request.current = null;
			if (mounted.current) {
				setError(editingErrorMessage(failure, t));
				setUncertain(action === "RETRY" && unknown);
			}
		} finally {
			running.current = false;
			if (mounted.current) setBusy(false);
		}
	}
	return (
		<div className="space-y-3">
			{error && (
				<div role="alert" className="space-y-1 text-amber-300 text-sm">
					<p>{error}</p>
					{uncertain && <p>{t("editing.autoPortrait.unknownRetry")}</p>}
				</div>
			)}
			<div className="flex flex-wrap gap-3">
				<Button
					variant="secondary"
					disabled={
						!allowNewRender ||
						disabled ||
						busy ||
						renderIsActive(latest) ||
						!project.currentRevisionId ||
						!project.currentRevisionMatchesDraft
					}
					onClick={() => void execute("RETRY")}
				>
					{t("editing.autoPortrait.retry")}
				</Button>
				{latest && renderIsActive(latest) && (
					<Button
						variant="secondary"
						disabled={disabled || busy || latest.state === "CANCEL_REQUESTED"}
						onClick={() => void execute("CANCEL", latest.id)}
					>
						{t("editing.cancel")}
					</Button>
				)}
			</div>
			{(!project.currentRevisionId || !project.currentRevisionMatchesDraft) && (
				<p className="text-sm text-zinc-400">{t("editing.revisionNeeded")}</p>
			)}
		</div>
	);
}
