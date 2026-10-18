"use client";

import type {
	LiveToVodErrorCode,
	LiveToVodFamilyStatus,
	LiveToVodStatus,
} from "@bitovp/core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import type {
	LiveChannelStatus,
	LiveToVodFamiliesWire,
	LiveToVodRecord,
} from "@/app/live/live-shared";
import { CopyableId } from "@/components/copyable-id";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { type Translator, useT } from "@/lib/i18n/context";

function rollStatusLabel(t: Translator, status: LiveToVodStatus): string {
	switch (status) {
		case "RUNNING":
			return t("liveToVod.statusRunning");
		case "FINISHED":
			return t("liveToVod.statusFinished");
		case "PARTIAL":
			return t("liveToVod.statusPartial");
		case "ERROR":
			return t("liveToVod.statusError");
	}
}

function familyStatusLabel(
	t: Translator,
	status: LiveToVodFamilyStatus,
): string {
	switch (status) {
		case "PENDING":
			return t("liveToVod.familyStatusPending");
		case "CREATED":
			return t("liveToVod.familyStatusCreated");
		case "RUNNING":
			return t("liveToVod.familyStatusRunning");
		case "FINISHED":
			return t("liveToVod.familyStatusFinished");
		case "ERROR":
			return t("liveToVod.familyStatusError");
		case "SKIPPED_UNSUPPORTED":
			return t("liveToVod.familyStatusUnsupported");
	}
}

function customerErrorLabel(
	t: Translator,
	code: LiveToVodErrorCode | undefined,
): string {
	switch (code) {
		case "L2V_ENQUEUE_FAILED":
			return t("liveToVod.errorEnqueue");
		case "L2V_QUEUE_STATE_UNKNOWN":
			return t("liveToVod.errorQueueUnknown");
		case "L2V_PROVIDER_DELETE_UNCONFIRMED":
			return t("liveToVod.errorCleanup");
		case "L2V_RECORD_INVALID":
			return t("liveToVod.errorInvalidRecord");
		default:
			return t("liveToVod.errorProvider");
	}
}

function startErrorLabel(t: Translator, error: unknown): string {
	const details =
		error instanceof ApiError &&
		typeof error.details === "object" &&
		error.details !== null
			? (error.details as { code?: unknown })
			: undefined;
	switch (details?.code) {
		case "L2V_UNSUPPORTED_FAMILY":
			return t("liveToVod.startUnsupportedFamily");
		case "L2V_INVALID_PATH":
			return t("liveToVod.startInvalidPath");
		case "L2V_ALREADY_RUNNING":
			return t("liveToVod.startAlreadyRunning");
		case "L2V_NOT_STOPPED":
			return t("liveToVod.startNotStopped");
		case "L2V_QUEUE_STATE_UNKNOWN":
			return t("liveToVod.errorQueueUnknown");
		case "L2V_ENQUEUE_FAILED":
			return t("liveToVod.errorEnqueue");
		case "L2V_RECORD_INVALID":
			return t("liveToVod.errorInvalidRecord");
		default:
			return t("liveToVod.startFailed");
	}
}

/**
 * live-to-VOD: publish a finished recording as VOD manifests.
 *
 * Bitmovin has no live-to-VOD API — the worker generates DEFAULT HLS/DASH
 * manifests over this channel's own encoding with `manifestGenerator: LEGACY`
 * (the one documented exception to the app's always-V2 rule, because V2
 * refuses a live encoding's muxings). The manifests land beside the recording
 * they describe: the destination reuses the Bitmovin output this channel
 * already provisioned.
 *
 * STOPPED-only, and the button stays disabled while a run is in flight —
 * a channel that is still recording would yield a truncated manifest.
 */
export function LiveToVodPanel({
	channelId,
	status,
	record,
	families = null,
	technicalDetailsAllowed = false,
	onStarted,
}: {
	channelId: string;
	status: LiveChannelStatus;
	record: LiveToVodRecord | null;
	/**
	 * : which families THIS recording can carry, from the detail GET.
	 * Null (an unreadable step log, or a caller without it) keeps the legacy
	 * "both" preselection and lets the POST route answer.
	 */
	families?: LiveToVodFamiliesWire | null;
	technicalDetailsAllowed?: boolean;
	onStarted: () => void;
}) {
	const { t } = useT();
	const canOperate = useMutationAccess("live.channel.live-to-vod");
	const [path, setPath] = useState("");
	// The operator's explicit unchecks only; the DEFAULT is derived from the
	// recording each render, so a poll that refreshes `families` neither
	// clobbers a choice nor needs an effect to resync it .
	const [unchecked, setUnchecked] = useState<{ hls?: boolean; dash?: boolean }>(
		{},
	);
	const supported = (wire: "HLS" | "DASH") =>
		families === null || families.supported.includes(wire);
	const chosen = {
		hls: supported("HLS") && !unchecked.hls,
		dash: supported("DASH") && !unchecked.dash,
	};
	const [error, setError] = useState<string | null>(null);
	const hasTechnicalDetail = Boolean(
		record?.technicalDetail ||
			record?.error ||
			(record?.families ?? []).some(
				(family) =>
					("technicalDetail" in family && family.technicalDetail) ||
					("error" in family && family.error) ||
					("reason" in family && family.reason),
			),
	);

	const publish = useMutation({
		mutationFn: () => {
			const manifests = [
				...(chosen.hls ? (["HLS"] as const) : []),
				...(chosen.dash ? (["DASH"] as const) : []),
			];
			return apiFetch<{ status: string }>(
				`/api/live-channels/${channelId}/live-to-vod`,
				{
					method: "POST",
					body: JSON.stringify({
						...(path.trim() === "" ? {} : { path: path.trim() }),
						// The UI always sends the operator's checked choice. Omitting
						// both silently changed an explicit HLS+DASH request into the
						// server's compatibility-derived automatic mode.
						manifests,
					}),
				},
			);
		},
		onMutate: () => setError(null),
		onSuccess: () => onStarted(),
		onError: (mutationError) => setError(startErrorLabel(t, mutationError)),
	});

	const running = record?.status === "RUNNING";
	const noFamily = !chosen.hls && !chosen.dash;
	const nothingSupported = families !== null && families.supported.length === 0;

	return (
		<div className="mt-2 space-y-3 rounded-md border border-zinc-800 p-3">
			{status !== "STOPPED" && canOperate ? (
				<p className="text-sm text-zinc-500">
					{/* Keep language-specific spacing inside translated values so a localized noun phrase remains intact. */}
					{t("liveToVod.stopFirst")}
					<em>{t("liveToVod.complete")}</em>
					{t("uiX.liveToVodTail", { status })}
				</p>
			) : status === "STOPPED" && canOperate ? (
				<>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<Field
							label={t("liveToVod.manifestPath")}
							htmlFor="l2v-path"
							help={`${t("ui.generatesDefaultVodManifestsOverThisChannel")} ${t("ui.relativeToTheChannelSOutputEmpty")}`}
						>
							<Input
								id="l2v-path"
								placeholder={t("liveToVod.manifestPathPlaceholder")}
								value={path}
								onChange={(e) => setPath(e.target.value)}
							/>
						</Field>
						<fieldset className="space-y-1">
							<legend className="text-xs text-zinc-400">
								{t("liveToVod.manifests")}
							</legend>
							{(["hls", "dash"] as const).map((family) => {
								const wire = family === "hls" ? "HLS" : "DASH";
								const blocked = families?.unsupported.find(
									(entry) => entry.family === wire,
								);
								return (
									<div key={family} className="space-y-0.5">
										<label
											className={`flex items-center gap-2 text-sm ${
												blocked ? "text-zinc-500" : "text-zinc-300"
											}`}
										>
											<input
												type="checkbox"
												className="h-4 w-4 accent-emerald-600"
												checked={chosen[family]}
												disabled={blocked !== undefined}
												onChange={(e) =>
													setUnchecked({
														...unchecked,
														[family]: !e.target.checked,
													})
												}
											/>
											{wire}
										</label>
										{blocked ? (
											<p className="pl-6 text-xs text-zinc-500">
												{t("liveToVod.unsupportedFamily", { family: wire })}
												{blocked.technicalDetail ? (
													<span className="block text-zinc-600">
														{blocked.technicalDetail}
													</span>
												) : null}
											</p>
										) : null}
									</div>
								);
							})}
						</fieldset>
					</div>
					<Button
						onClick={() => publish.mutate()}
						disabled={publish.isPending || running || noFamily}
					>
						{running ? t("liveToVod.generating") : t("liveToVod.publish")}
					</Button>
					{noFamily ? (
						<p className="text-xs text-amber-400">
							{nothingSupported
								? t("liveToVod.noSupportedFamily")
								: t("liveToVod.needManifest")}
						</p>
					) : null}
					{error ? <p className="text-xs text-red-400">{error}</p> : null}
				</>
			) : null}

			{record ? (
				<div className="space-y-2 border-zinc-800 border-t pt-3">
					<p className="text-xs text-zinc-400">
						{t("liveToVod.lastRun")}{" "}
						<span className="text-zinc-200">
							{rollStatusLabel(t, record.status)}
						</span>
						{record.finishedAt
							? t("liveToVod.finishedAtSuffix", { at: record.finishedAt })
							: null}
						{record.status === "RUNNING" ? t("liveToVod.refreshSuffix") : null}
					</p>
					{record.errorCode || record.error || record.technicalDetail ? (
						<p className="text-xs text-red-400">
							{customerErrorLabel(t, record.errorCode)}
						</p>
					) : null}
					{/* : one family can finish while another fails, and the
					    default leaves out a family the recording cannot carry (TS → no
					    DASH). Each family's own state is shown, so a PARTIAL roll reads
					    as "HLS delivered, DASH failed" rather than as nothing. */}
					{record.status === "PARTIAL" ? (
						<p className="text-xs text-amber-400">
							{t("liveToVod.partialHint")}
						</p>
					) : null}
					{(record.families ?? []).length > 0 ? (
						<ul className="space-y-1" aria-label={t("liveToVod.families")}>
							{(record.families ?? []).map((family) => {
								const detail =
									family.status === "SKIPPED_UNSUPPORTED"
										? t("liveToVod.unsupportedFamily", {
												family: family.type,
											})
										: family.status === "ERROR"
											? customerErrorLabel(t, family.errorCode)
											: undefined;
								return (
									<li
										key={family.type}
										className="flex flex-wrap items-baseline gap-2 text-xs text-zinc-300"
									>
										<span className="shrink-0 text-zinc-500">
											{family.type}
										</span>
										<span
											className={
												family.status === "ERROR"
													? "text-red-400"
													: family.status === "FINISHED"
														? "text-emerald-400"
														: "text-zinc-400"
											}
										>
											{familyStatusLabel(t, family.status)}
										</span>
										{detail ? (
											<span className="min-w-0 flex-1 break-words text-zinc-500">
												{detail}
											</span>
										) : null}
									</li>
								);
							})}
						</ul>
					) : null}
					{technicalDetailsAllowed && hasTechnicalDetail ? (
						<details className="text-xs text-zinc-500">
							<summary className="cursor-pointer">
								{t("liveToVod.technicalDetails")}
							</summary>
							<pre className="mt-1 whitespace-pre-wrap break-words font-mono">
								{[
									record.technicalDetail ?? record.error,
									...(record.families ?? []).flatMap((family) => {
										const detail =
											("technicalDetail" in family
												? family.technicalDetail
												: undefined) ??
											("error" in family ? family.error : undefined) ??
											("reason" in family ? family.reason : undefined);
										return detail ? [`${family.type}: ${detail}`] : [];
									}),
								]
									.filter(Boolean)
									.join("\n")}
							</pre>
						</details>
					) : null}
					{/* WHERE the VOD copy landed — with an empty manifests[] (an ERROR
					    after the output was created) the operator previously got no
					    location at all (ux inventory #8). */}
					{record.path ? (
						<p className="text-xs text-zinc-500">
							{t("liveToVod.destination")}{" "}
							<span className="select-all break-all font-mono text-zinc-300">
								{record.path}
							</span>
						</p>
					) : null}
					{record.manifests.length > 0 ? (
						<ul className="space-y-1">
							{record.manifests.map((manifest) => (
								<li
									key={manifest.manifestId}
									className="flex flex-wrap items-center gap-2 text-xs text-zinc-300"
								>
									<span className="shrink-0 text-zinc-500">
										{manifest.type}
									</span>
									{/* min-w-0 flex-1 truncate: without the bound the
									    URL folds mid-path and crushes the id chip to a
									    sliver. At narrow widths the copy chip can wrap
									    onto its own line and shrink within that line. */}
									<span
										title={manifest.url}
										className="min-w-0 flex-1 truncate"
									>
										{manifest.url}
									</span>
									<CopyableId className="min-w-0" value={manifest.manifestId} />
								</li>
							))}
						</ul>
					) : null}
				</div>
			) : null}
		</div>
	);
}
