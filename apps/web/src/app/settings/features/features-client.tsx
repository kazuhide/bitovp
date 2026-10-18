"use client";

import type { FeatureFlags } from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { InfoHint } from "@/components/ui/info-hint";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";

/**
 * : the switch itself. One row per flag, each with the sentence
 * that says what turning it off actually does — a toggle whose consequences
 * are invisible is how an operator turns something off and then files the
 * absence as a bug.
 *
 * The saved value takes effect on the NEXT page load (the flags are resolved
 * server-side in the root layout), so the confirmation says so rather than
 * leaving the operator wondering why the nav has not moved yet.
 */
export function FeaturesClient() {
	const { t } = useT();
	const canAdmin = useMutationAccess("settings.features");
	const queryClient = useQueryClient();
	const flags = useQuery({
		queryKey: ["feature-flags"],
		queryFn: () => apiFetch<FeatureFlags>("/api/settings/features"),
	});
	const save = useMutation({
		mutationFn: (patch: Partial<FeatureFlags>) =>
			apiFetch<FeatureFlags>("/api/settings/features", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(patch),
			}),
		onSuccess: (next) => {
			queryClient.setQueryData(["feature-flags"], next);
		},
	});

	return (
		<section>
			<div className="flex items-center gap-2">
				<h1 className="font-semibold text-xl text-zinc-50">
					{t("settingsX.features")}
				</h1>
				<InfoHint
					labelFor={t("settingsX.features")}
					text={t("settingsX.featuresCaption")}
				/>
			</div>

			{flags.isPending ? (
				<p className="mt-6 text-sm text-zinc-500">{t("common.loading")}</p>
			) : flags.error || !flags.data ? (
				<p role="alert" className="mt-6 text-amber-400 text-sm">
					{t("settingsX.featuresLoadFailed")}{" "}
					<Button
						variant="secondary"
						size="sm"
						disabled={flags.isFetching}
						onClick={() => flags.refetch()}
					>
						{t("settingsForms.retry")}
					</Button>
				</p>
			) : (
				<div className="mt-6 space-y-3">
					<div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
						{canAdmin ? (
							<div className="flex items-start gap-3">
								<input
									id="feat-qc-vmaf"
									type="checkbox"
									className="mt-1"
									checked={flags.data.qcVmaf}
									disabled={save.isPending}
									onChange={(e) => save.mutate({ qcVmaf: e.target.checked })}
								/>
								<div className="flex items-center gap-1">
									<label
										htmlFor="feat-qc-vmaf"
										className="font-medium text-sm text-zinc-100"
									>
										{t("settingsX.featureQcVmaf")}
									</label>
									<HelpOverlay labelFor={t("settingsX.featureQcVmaf")}>
										{t("settingsX.featureQcVmafHint")}
									</HelpOverlay>
								</div>
							</div>
						) : (
							<div className="flex items-start justify-between gap-3">
								<div className="flex items-center gap-1">
									<span className="font-medium text-sm text-zinc-100">
										{t("settingsX.featureQcVmaf")}
									</span>
									<HelpOverlay labelFor={t("settingsX.featureQcVmaf")}>
										{t("settingsX.featureQcVmafHint")}
									</HelpOverlay>
								</div>
								<span className="text-xs text-zinc-400">
									{t(flags.data.qcVmaf ? "notif.enabled" : "notif.disabled")}
								</span>
							</div>
						)}
					</div>
					{save.isSuccess ? (
						<p className="text-emerald-400 text-xs">
							{t("settingsX.featuresSavedReloadHint")}
						</p>
					) : null}
					{save.isError ? (
						<p role="alert" className="text-red-400 text-xs">
							{save.error instanceof Error
								? save.error.message
								: t("common.unknownError")}
						</p>
					) : null}
					<Button
						variant="secondary"
						size="sm"
						onClick={() => window.location.reload()}
					>
						{t("settingsX.featuresReload")}
					</Button>
				</div>
			)}
		</section>
	);
}
