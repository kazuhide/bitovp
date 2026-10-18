"use client";

import type { LiveChannelPlan, StepLogEntry } from "@bitovp/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CustomLiveNotice } from "@/app/live/custom-live-notice";
import {
	ACTION_LABEL_KEYS,
	actionFailureMessage,
	isActiveChannelStatus,
	type LiveChannelAction,
	type LiveChannelStatus,
} from "@/app/live/live-shared";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { RoleAccess, useMutationAccess } from "@/lib/auth/use-role-access";
import { localizedCustomerError } from "@/lib/customer-error";
import { useT } from "@/lib/i18n/context";
import { useAnnounce } from "./live-announcer";

/**
 * The channel's mutation controls, split by task.
 *
 * They used to be one `ChannelActions` block: Start / Stop / Restart shared a
 * button row with Duplicate and Delete, and the SCTE-35 cue form hung off the
 * same always-open section.
 * A row where the second-most-likely click
 * beside "Stop the broadcast" is "Delete the channel" is a mis-click waiting
 * for a bad night.
 *
 * So each control now renders in exactly the layer that owns it, and in ONLY
 * one place — §5.7's rule is "move the existing single owner, never duplicate
 * it", because a second Start button is the second source of truth this whole
 * redesign exists to remove:
 *
 * - `ChannelLifecycleActions` → the operational header (`sec-actions`, still
 * the id `liveNextAction` points at).
 * - `ChannelCueForm` → Programme, beside the other ad-signalling insertions.
 * - `DuplicateChannelButton` → Diagnostics / Advanced.
 * - `ChannelDangerZone` → the Danger zone, last on the page.
 *
 * Each holds only the mutation it fires, so no state is shared across the
 * split and nothing had to become a context.
 */

/**
 * Start / Stop / Restart, with their confirm dialogs. Button availability
 * mirrors the route's claimable sets; a lost race still 409s server-side and
 * the message is surfaced verbatim (`actionFailureMessage`).
 */
export function ChannelLifecycleActions({
	channelId,
	status,
	hasEncoding,
	plan,
	runId,
	generation = 0,
	cancelRequested = false,
}: {
	channelId: string;
	status: LiveChannelStatus;
	hasEncoding: boolean;
	plan?: LiveChannelPlan;
	runId?: string;
	generation?: number;
	cancelRequested?: boolean;
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState<"stop" | "restart" | null>(null);
	const [lastError, setLastError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const announce = useAnnounce();
	const startingGeneration = useRef<number | null>(null);
	const localCancelRequested = useRef(false);
	type CancelTarget = {
		generation: number;
		runId?: string;
		waitForGeneration?: boolean;
	};
	const [cancelAccepted, setCancelAccepted] = useState<CancelTarget | null>(
		null,
	);
	const projection = useRef({ generation, runId });
	projection.current = { generation, runId };
	const matchesProjection = (target: CancelTarget | null | undefined) => {
		if (!target) return false;
		const current = projection.current;
		const pendingStart =
			startingGeneration.current !== null &&
			current.generation < startingGeneration.current;
		return (
			(target.generation === current.generation &&
				(!target.runId || !current.runId || target.runId === current.runId)) ||
			(pendingStart && target.generation === startingGeneration.current)
		);
	};
	useEffect(() => {
		if (
			cancelAccepted &&
			(generation > cancelAccepted.generation ||
				(generation === cancelAccepted.generation &&
					runId &&
					cancelAccepted.runId &&
					runId !== cancelAccepted.runId))
		) {
			setCancelAccepted(null);
			localCancelRequested.current = false;
			setNotice(null);
		}
		if (
			startingGeneration.current !== null &&
			generation > startingGeneration.current
		)
			startingGeneration.current = null;
	}, [generation, runId, cancelAccepted]);
	const startFailed = useRef(false);
	const [, refreshStartProjection] = useState(0);
	const recoverUnclaimedStart = async () => {
		if (!startFailed.current || startingGeneration.current === null) return;
		try {
			const current = await apiFetch<{ liveEffectFenceVersion: number }>(
				`/api/live-channels/${channelId}`,
			);
			if (current.liveEffectFenceVersion < startingGeneration.current) {
				startingGeneration.current = null;
				refreshStartProjection((version) => version + 1);
			}
		} catch {
			/* Unknown response-loss outcome: retain the exact target for retry. */
		}
	};

	const act = useMutation({
		mutationFn: ({ action }: { action: LiveChannelAction }) =>
			apiFetch(`/api/live-channels/${channelId}/actions`, {
				method: "POST",
				body: JSON.stringify({ action }),
			}),
		onMutate: () => {
			setLastError(null);
			setNotice(null);
		},
		onSuccess: (_data, vars) => {
			if (vars.action === "start" && localCancelRequested.current) {
				queryClient.invalidateQueries({
					queryKey: ["live-channel", channelId],
				});
				return;
			}
			setConfirming(null);
			// : was `${vars.action} accepted.` — a raw slug in an
			// English frame, on an otherwise-localized screen.
			const accepted = t("live.actionAccepted", {
				label: t(ACTION_LABEL_KEYS[vars.action]),
			});
			setNotice(accepted);
			//  (audit §5.6): the same sentence, into the page's ONE
			// polite region. The `<p>` below is deliberately NOT a live region
			// of its own — two would read it twice — and it is rendered
			// conditionally, which is the shape assistive technology most
			// reliably misses.
			announce(accepted);
			queryClient.invalidateQueries({ queryKey: ["live-channel", channelId] });
		},
		onError: async (err, vars) => {
			if (vars.action === "start") startFailed.current = true;
			if (vars.action === "start" && localCancelRequested.current) {
				await recoverUnclaimedStart();
				queryClient.invalidateQueries({
					queryKey: ["live-channel", channelId],
				});
				return;
			}
			if (vars.action === "start") {
				startingGeneration.current = null;
				queryClient.invalidateQueries({
					queryKey: ["live-channel", channelId],
				});
			}
			setConfirming(null);
			setLastError(actionFailureMessage(t, vars.action, err));
		},
	});

	const cancel = useMutation({
		mutationFn: async (target: CancelTarget) => {
			const locallyStarting = target.waitForGeneration === true;
			// START may still be waiting for its transaction/queue response. Wait only
			// for its exact generation; a later airing must never receive this click.
			if (locallyStarting) {
				for (let attempt = 0; attempt < 20; attempt++) {
					const current = await apiFetch<{ liveEffectFenceVersion: number }>(
						`/api/live-channels/${channelId}`,
					);
					if (current.liveEffectFenceVersion === target.generation) break;
					if (
						current.liveEffectFenceVersion > target.generation ||
						attempt === 19
					)
						throw new Error(t("live.cancelStartFailed"));
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
			}
			const result = await apiFetch<{ runId?: string }>(
				`/api/live-channels/${channelId}/actions`,
				{
					method: "POST",
					body: JSON.stringify({
						action: "cancel-start",
						generation: target.generation,
						...(target.runId ? { runId: target.runId } : {}),
					}),
				},
			);
			return {
				generation: target.generation,
				runId: result.runId ?? target.runId,
			};
		},
		onMutate: () => {
			localCancelRequested.current = true;
			setLastError(null);
		},
		onSuccess: (target) => {
			if (!matchesProjection(target)) return;
			setCancelAccepted(target);
			setNotice(t("live.cancelStartAccepted"));
			announce(t("live.cancelStartAccepted"));
			queryClient.invalidateQueries({ queryKey: ["live-channel", channelId] });
		},
		onError: async (error, target) => {
			if (!matchesProjection(target)) return;
			await recoverUnclaimedStart();
			setLastError(localizedCustomerError(t, error, "live.cancelStartFailed"));
		},
	});
	const awaitingStartProjection =
		startingGeneration.current !== null &&
		generation < startingGeneration.current;
	const cancellationPending =
		(cancel.isPending && matchesProjection(cancel.variables)) ||
		matchesProjection(cancelAccepted) ||
		(cancelRequested && !awaitingStartProjection);
	const canCancelStart =
		status === "CREATED" ||
		status === "PROVISIONING" ||
		awaitingStartProjection ||
		cancellationPending;

	//  PR3: STOPPED joined the startable set — the button reads
	// Start a new broadcast there (a NEW run with a fresh encoding; the finished
	// one is unrecoverable by the vendor's model, C30).
	const canStart =
		!awaitingStartProjection &&
		!(cancelRequested && status !== "STOPPED") &&
		(status === "CREATED" || status === "ERROR" || status === "STOPPED");
	const isNewRun = status === "STOPPED";
	const canStop =
		!cancellationPending &&
		hasEncoding &&
		(status === "RUNNING" || status === "ERROR");
	/**
	 * Restart is for an encoding that is STILL UP. A stopped channel's
	 * encoding is FINISHED (stopChannel calls stopLiveEncoding), and Bitmovin
	 * refuses a terminal encoding with 409 code 2028 — so offering the button
	 * there was a false affordance that could only ever produce an error
	 * . The recovery for a
	 * stopped channel is Start new run, with a fresh encoding.
	 */
	const canRestart =
		!cancellationPending &&
		hasEncoding &&
		(status === "RUNNING" || status === "ERROR");

	return (
		<div className="space-y-2">
			{canStart && plan ? <CustomLiveNotice plan={plan} compact /> : null}
			<div className="flex flex-wrap items-center gap-2">
				{canStart ? (
					<Button
						size="sm"
						disabled={act.isPending}
						onClick={() => {
							startingGeneration.current = generation + 1;
							startFailed.current = false;
							localCancelRequested.current = false;
							setCancelAccepted(null);
							act.mutate({ action: "start" });
						}}
					>
						{isNewRun
							? t("live.startNewRun")
							: status === "ERROR"
								? t("live.startResume")
								: t("live.start")}
					</Button>
				) : null}
				{canCancelStart && (status !== "STOPPED" || awaitingStartProjection) ? (
					<Button
						variant="secondary"
						size="sm"
						disabled={cancellationPending}
						onClick={() =>
							cancel.mutate({
								generation: awaitingStartProjection
									? (startingGeneration.current ?? generation)
									: generation,
								waitForGeneration: awaitingStartProjection,
								...(!awaitingStartProjection && runId ? { runId } : {}),
							})
						}
					>
						{cancellationPending
							? t("live.cancelStartPending")
							: t("live.cancelStart")}
					</Button>
				) : null}
				{canStop ? (
					<Button
						variant="destructive"
						size="sm"
						disabled={act.isPending}
						onClick={() => setConfirming("stop")}
					>
						{t("live.stop")}
					</Button>
				) : null}
				{canRestart ? (
					<Button
						variant="secondary"
						size="sm"
						disabled={act.isPending}
						onClick={() => setConfirming("restart")}
					>
						{t("live.restart")}
					</Button>
				) : null}
			</div>
			{lastError ? (
				<p role="alert" className="text-red-400 text-sm">
					{lastError}
				</p>
			) : null}
			{notice ? <p className="text-emerald-400 text-sm">{notice}</p> : null}
			{status === "RUNNING" &&
			runId &&
			plan?.liveInput.kind === "REDUNDANT_RTMP" &&
			plan.liveInput.ingestPoints &&
			plan.liveInput.ingestPoints.length <= 16 ? (
				<RtmpIngestControl
					key={runId}
					channelId={channelId}
					runId={runId}
					points={plan.liveInput.ingestPoints.map(
						({ applicationName }) => applicationName,
					)}
				/>
			) : null}

			<Dialog
				open={confirming !== null}
				onOpenChange={(open) => {
					if (!open) {
						setConfirming(null);
					}
				}}
				title={
					confirming === "stop"
						? t("live.stopChannelTitle")
						: t("live.restartChannelTitle")
				}
				description={
					confirming === "stop"
						? t("live.stopChannelBody")
						: t("live.restartChannelBody")
				}
			>
				<div className="flex justify-end gap-2">
					<Button
						variant="secondary"
						size="sm"
						onClick={() => setConfirming(null)}
					>
						{t("common.cancel")}
					</Button>
					<Button
						variant="destructive"
						size="sm"
						disabled={act.isPending}
						onClick={() => {
							if (confirming) {
								act.mutate({ action: confirming });
							}
						}}
					>
						{confirming === "stop"
							? t("live.stopChannel")
							: t("live.restartChannel")}
					</Button>
				</div>
			</Dialog>
		</div>
	);
}

function RtmpIngestControl({
	channelId,
	runId,
	points,
}: {
	channelId: string;
	runId: string;
	points: string[];
}) {
	const { t } = useT();
	const canUpdate = useMutationAccess("live.channel.rtmp-ingest");
	const [selected, setSelected] = useState(points.map((_, index) => index));
	const request = useRef<{ fingerprint: string; id: string } | null>(null);
	const update = useMutation({
		mutationFn: () => {
			const fingerprint = JSON.stringify(selected);
			if (request.current?.fingerprint !== fingerprint)
				request.current = { fingerprint, id: crypto.randomUUID() };
			return apiFetch(`/api/live-channels/${channelId}/actions`, {
				method: "POST",
				body: JSON.stringify({
					action: "update-rtmp-ingest",
					runId,
					requestId: request.current.id,
					pointIndexes: selected,
				}),
			});
		},
		onSuccess: () => {
			request.current = null;
		},
	});
	return canUpdate ? (
		<details className="text-xs text-zinc-400">
			<summary className="cursor-pointer">{t("rtmpUpdate.title")}</summary>
			<div className="mt-2 space-y-2">
				<fieldset disabled={update.isPending} className="flex flex-wrap gap-2">
					<legend className="sr-only">{t("rtmpUpdate.title")}</legend>
					{points.map((name, index) => (
						<label key={`${name}:${index}`} className="flex items-center gap-1">
							<input
								type="checkbox"
								checked={selected.includes(index)}
								onChange={(event) =>
									setSelected((prev) =>
										event.target.checked
											? [...prev, index].sort((a, b) => a - b)
											: prev.filter((value) => value !== index),
									)
								}
							/>
							{name}
						</label>
					))}
				</fieldset>
				<div className="flex items-center gap-2">
					<Button
						size="sm"
						variant="secondary"
						disabled={update.isPending || selected.length === 0}
						onClick={() => update.mutate()}
					>
						{t("rtmpUpdate.apply")}
					</Button>
					<InfoHint
						text={t("rtmpUpdate.hint")}
						labelFor={t("rtmpUpdate.title")}
					/>
				</div>
				{update.isSuccess ? (
					<p role="status">{t("rtmpUpdate.queued")}</p>
				) : null}
				{update.isError ? (
					<p role="alert">
						{localizedCustomerError(t, update.error, "rtmpUpdate.failed")}
					</p>
				) : null}
			</div>
		</details>
	) : null;
}

/**
 * The SCTE-35 cue insertion (RUNNING only) — an ad-signalling insertion into
 * the running encoder, so it belongs in Programme beside ESAM, not in the
 * lifecycle row it used to hang off.
 */
export function ChannelCueForm({
	channelId,
	status,
	stepEntries,
}: {
	channelId: string;
	status: LiveChannelStatus;
	stepEntries: StepLogEntry[];
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const [cueDuration, setCueDuration] = useState("30");
	const [cueManifests, setCueManifests] = useState<string[]>([]);
	const [lastError, setLastError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const announce = useAnnounce();
	const cueRequest = useRef<{
		fingerprint: string;
		requestId: string;
	} | null>(null);

	const manifestResources = stepEntries.filter(
		(entry) =>
			(entry.kind === "CREATE_MANIFEST_HLS" ||
				entry.kind === "CREATE_MANIFEST_DASH") &&
			entry.status === "DONE" &&
			entry.resourceId,
	);

	// Last inserted SCTE-35 cue (C14): the worker appends a SCTE35_CUE entry per
	// fired cue, so the most recent one confirms the action took effect.
	const lastCue = stepEntries
		.filter((entry) => entry.kind === "SCTE35_CUE")
		.at(-1);
	const lastCuePayload = (lastCue?.payload ?? {}) as {
		at?: unknown;
		cueDuration?: unknown;
	};
	const lastCueAt =
		typeof lastCuePayload.at === "string" ? lastCuePayload.at : undefined;
	const lastCueDuration =
		typeof lastCuePayload.cueDuration === "number"
			? lastCuePayload.cueDuration
			: undefined;

	const act = useMutation({
		mutationFn: (params: Record<string, unknown>) => {
			const fingerprint = JSON.stringify(params);
			if (cueRequest.current?.fingerprint !== fingerprint) {
				cueRequest.current = {
					fingerprint,
					requestId: crypto.randomUUID(),
				};
			}
			return apiFetch(`/api/live-channels/${channelId}/actions`, {
				method: "POST",
				body: JSON.stringify({
					action: "scte35",
					requestId: cueRequest.current.requestId,
					...params,
				}),
			});
		},
		onMutate: () => {
			setLastError(null);
			setNotice(null);
		},
		onSuccess: () => {
			cueRequest.current = null;
			const enqueued = t("live.cueEnqueued");
			setNotice(enqueued);
			announce(enqueued);
			queryClient.invalidateQueries({ queryKey: ["live-channel", channelId] });
		},
		onError: (err) => {
			setLastError(actionFailureMessage(t, "scte35", err));
		},
	});

	if (status !== "RUNNING") {
		return (
			<p className="mt-2 text-sm text-zinc-500">{t("live.cueNeedsRunning")}</p>
		);
	}

	return (
		<div className="mt-2 space-y-3">
			<Field
				label={t("live.cueDuration")}
				htmlFor="scte-duration"
				help={t("ui.adBreakLengthSignalledToDownstreamSystems")}
			>
				<Input
					id="scte-duration"
					type="number"
					className="w-32"
					value={cueDuration}
					onChange={(e) => setCueDuration(e.target.value)}
				/>
			</Field>
			<fieldset>
				<legend className="font-medium text-xs text-zinc-300">
					{t("live.manifestsAllHint")}
				</legend>
				{manifestResources.length > 0 ? (
					<div className="mt-1 space-y-1">
						{manifestResources.map((entry) => {
							const id = entry.resourceId as string;
							return (
								<label
									key={entry.step}
									className="flex items-center gap-2 text-xs text-zinc-300"
								>
									<input
										type="checkbox"
										className="h-3.5 w-3.5 accent-emerald-600"
										checked={cueManifests.includes(id)}
										onChange={(e) =>
											setCueManifests((prev) =>
												e.target.checked
													? [...prev, id]
													: prev.filter((m) => m !== id),
											)
										}
									/>
									<span className="shrink-0 font-mono">{entry.step}</span>
									<span title={id} className="min-w-0 truncate text-zinc-600">
										{id}
									</span>
								</label>
							);
						})}
					</div>
				) : (
					<p className="mt-1 text-xs text-zinc-500">
						{t("prose.cueNoManifestIds")}
					</p>
				)}
			</fieldset>
			<Button
				variant="secondary"
				size="sm"
				disabled={
					act.isPending || cueDuration === "" || Number(cueDuration) <= 0
				}
				onClick={() =>
					act.mutate({
						cueDuration: Number(cueDuration),
						...(cueManifests.length > 0 ? { manifestIds: cueManifests } : {}),
					})
				}
			>
				{act.isPending ? t("live.sending") : t("live.insertCueShort")}
			</Button>
			{lastError ? (
				<p role="alert" className="text-red-400 text-sm">
					{lastError}
				</p>
			) : null}
			{notice ? <p className="text-emerald-400 text-sm">{notice}</p> : null}
			{lastCueAt ? (
				<p className="text-xs text-zinc-400">
					{t("uiX.lastCueInsertedAt")}{" "}
					<span className="font-mono">
						{new Date(lastCueAt).toLocaleTimeString()}
					</span>
					{lastCueDuration !== undefined ? ` (${lastCueDuration}s)` : ""}
				</p>
			) : null}
		</div>
	);
}

/**
 * Recreate a fresh channel from this one's config — the clean recovery for a
 * failed start (no stale ids). An authoring verb, so it sits in Advanced.
 */
export function DuplicateChannelButton({ channelId }: { channelId: string }) {
	const { t } = useT();
	const router = useRouter();
	return (
		<RoleAccess control="live.channel.duplicate">
			<Button
				variant="secondary"
				size="sm"
				onClick={() => router.push(`/live/new?from=${channelId}`)}
			>
				{t("live.duplicate")}
			</Button>
		</RoleAccess>
	);
}

/**
 * Delete (terminal-only): removes the channel + its feeders/heartbeats/live
 * VMAF reports (LOCAL records only — no Bitmovin/storage call). Disabled while
 * active (mirrors the route's 409 guard); on success leave for /live.
 *
 * Its own layer at the very end of the page, per §5.7: the one irreversible
 * control on this screen does not share a row with the ones an operator uses
 * every day.
 */
export function ChannelDangerZone({
	channelId,
	status,
}: {
	channelId: string;
	status: LiveChannelStatus;
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const router = useRouter();
	const remove = useMutation({
		mutationFn: () =>
			apiFetch(`/api/live-channels/${channelId}`, { method: "DELETE" }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["live-channels"] });
			router.push("/live");
		},
	});
	return (
		<div className="mt-2 space-y-2">
			<p className="text-xs text-zinc-400">{t("live.dangerZoneLead")}</p>
			<DeleteResourceButton
				resourceLabel={t("live.channelWord")}
				disabled={isActiveChannelStatus(status)}
				disabledReason={t("live.stopBeforeDeleting")}
				confirmTitle={t("live.deleteTitle")}
				confirmDescription={t("live.deleteConfirm")}
				pending={remove.isPending}
				error={
					remove.isError
						? localizedCustomerError(t, remove.error, "live.deleteFailed")
						: null
				}
				onConfirm={() => remove.mutate()}
			/>
		</div>
	);
}
