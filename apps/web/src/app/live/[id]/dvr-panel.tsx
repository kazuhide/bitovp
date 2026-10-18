"use client";

import type { LiveChannelPlan, StepLogEntry } from "@bitovp/core";
import { selectLiveManifestMuxings } from "@bitovp/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { actionFailureMessage } from "@/app/live/live-shared";
import { DvrGauge } from "@/app/live/new/dvr-gauge";
import { Button } from "@/components/ui/button";
import { DetailPopover } from "@/components/ui/detail-popover";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";

/**
 * DVR panel: per-manifest timeshift with the C8 calculation on demand (same per-leg math
 * as validateLiveChannel via selectLiveManifestMuxings) plus the
 * reset-timeshift action form (residualPeriodInSeconds / offsetInSeconds /
 * manifest selection). Manifest ids come from the DONE step-log entries —
 * absent selection means "all manifests" (SDK semantics).
 */
export function DvrPanel({
	channelId,
	status,
	plan,
	stepEntries,
}: {
	channelId: string;
	status: string;
	plan: LiveChannelPlan;
	stepEntries: StepLogEntry[];
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const [residual, setResidual] = useState("");
	const [offset, setOffset] = useState("");
	const [selectedManifests, setSelectedManifests] = useState<string[]>([]);

	const manifestResources = stepEntries.filter(
		(entry) =>
			(entry.kind === "CREATE_MANIFEST_HLS" ||
				entry.kind === "CREATE_MANIFEST_DASH") &&
			entry.status === "DONE" &&
			entry.resourceId,
	);

	const reset = useMutation({
		mutationFn: () =>
			apiFetch(`/api/live-channels/${channelId}/actions`, {
				method: "POST",
				body: JSON.stringify({
					action: "reset-timeshift",
					...(residual !== ""
						? { residualPeriodInSeconds: Number(residual) }
						: {}),
					...(offset !== "" ? { offsetInSeconds: Number(offset) } : {}),
					...(selectedManifests.length > 0
						? { manifestIds: selectedManifests }
						: {}),
				}),
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["live-channel", channelId] }),
	});

	return (
		<div className="mt-2 space-y-3">
			<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
				{plan.liveManifests.map((manifest) => {
					const label = `${manifest.kind} “${manifest.key}” — timeshift ${
						manifest.timeshift !== undefined
							? `${manifest.timeshift}s`
							: t("ui.default")
					}`;
					return (
						<DetailPopover
							key={manifest.key}
							summary={label}
							label={t("uiX.dvrPerLegLabel")}
						>
							<DvrGauge
								label={label}
								timeshiftSec={manifest.timeshift}
								legs={selectLiveManifestMuxings(plan, manifest).map(
									({ muxing }) => ({ segmentLengthSec: muxing.segmentLength }),
								)}
							/>
						</DetailPopover>
					);
				})}
			</div>

			<RoleAccess control="live.channel.dvr-reset">
				<details className="rounded-md border border-zinc-800 bg-zinc-900/40">
					<summary className="cursor-pointer select-none px-3 py-2 font-medium text-xs text-zinc-300 hover:text-zinc-100">
						{t("dvr.resetTitle")}
					</summary>
					<div className="space-y-3 border-zinc-800 border-t p-3">
						<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
							<Field
								label={t("dvr.residualPeriod")}
								htmlFor="dvr-residual"
								help={t("ui.howMuchOfTheExistingDvrWindow")}
							>
								<Input
									id="dvr-residual"
									type="number"
									value={residual}
									onChange={(e) => setResidual(e.target.value)}
								/>
							</Field>
							<Field
								label={t("dvr.offsetSeconds")}
								htmlFor="dvr-offset"
								help={t("ui.shiftAppliedToTheWindowStart")}
							>
								<Input
									id="dvr-offset"
									type="number"
									value={offset}
									onChange={(e) => setOffset(e.target.value)}
								/>
							</Field>
						</div>
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
													checked={selectedManifests.includes(id)}
													onChange={(e) =>
														setSelectedManifests((prev) =>
															e.target.checked
																? [...prev, id]
																: prev.filter((m) => m !== id),
														)
													}
												/>
												<span className="shrink-0 font-mono">{entry.step}</span>
												<span
													title={id}
													className="min-w-0 truncate text-zinc-600"
												>
													{id}
												</span>
											</label>
										);
									})}
								</div>
							) : (
								<p className="mt-1 text-xs text-zinc-500">
									{t("prose.dvrNoManifestIds")}
								</p>
							)}
						</fieldset>
						{reset.isError ? (
							<p role="alert" className="text-red-400 text-xs">
								{actionFailureMessage(t, "reset-timeshift", reset.error)}
							</p>
						) : null}
						{reset.isSuccess ? (
							<p className="text-emerald-400 text-xs">
								{t("dvr.resetEnqueued")}
							</p>
						) : null}
						<Button
							variant="secondary"
							size="sm"
							disabled={status !== "RUNNING" || reset.isPending}
							onClick={() => reset.mutate()}
						>
							{reset.isPending ? t("dvr.resetting") : t("dvr.reset")}
						</Button>
						{status !== "RUNNING" ? (
							<p className="text-[11px] text-zinc-500">
								{t("uiX.timeshiftResetRunningOnly", { status })}
							</p>
						) : null}
					</div>
				</details>
			</RoleAccess>
		</div>
	);
}
