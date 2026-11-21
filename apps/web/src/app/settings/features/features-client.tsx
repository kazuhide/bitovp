"use client";

import type { FeatureFlags } from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { InfoHint } from "@/components/ui/info-hint";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";

const featureRows = [
	{
		flag: "qcVmaf",
		id: "feat-qc-vmaf",
		label: "settingsX.featureQcVmaf",
		hint: "settingsX.featureQcVmafHint",
	},
	{
		flag: "operationAnalytics",
		id: "feat-operation-analytics",
		label: "settingsX.featureOperationAnalytics",
		hint: "settingsX.featureOperationAnalyticsHint",
	},
] as const;

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
		onSuccess: (next, patch) => {
			queryClient.setQueryData(["feature-flags"], next);
			if (patch.operationAnalytics !== undefined) {
				void queryClient.invalidateQueries({
					queryKey: ["operation-analytics"],
				});
			}
		},
	});

	return (
		<section>
			<div className="flex items-center gap-2">
				<h1 className="font-semibold text-xl text-zinc-50">
					{t("settingsCatalog.quality")}
				</h1>
				<InfoHint
					labelFor={t("settingsCatalog.quality")}
					text={t("settingsCatalog.qualityCaption")}
				/>
			</div>
			<h2 className="mt-6 font-medium text-base text-zinc-100">
				{t("settingsCatalog.enablement")}
			</h2>

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
					{featureRows.map(({ flag, id, label, hint }) => {
						const enabled = flags.data?.[flag] ?? false;
						return (
							<div
								key={flag}
								className="flex items-start justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
							>
								<div className="flex items-start gap-3">
									{canAdmin ? (
										<input
											id={id}
											type="checkbox"
											className="mt-1"
											checked={enabled}
											disabled={save.isPending}
											onChange={(e) =>
												save.mutate({ [flag]: e.target.checked })
											}
										/>
									) : null}
									<div className="flex items-center gap-1">
										{canAdmin ? (
											<label
												htmlFor={id}
												className="font-medium text-sm text-zinc-100"
											>
												{t(label)}
											</label>
										) : (
											<span className="font-medium text-sm text-zinc-100">
												{t(label)}
											</span>
										)}
										<HelpOverlay labelFor={t(label)}>{t(hint)}</HelpOverlay>
									</div>
								</div>
								{canAdmin ? null : (
									<span className="text-xs text-zinc-400">
										{t(enabled ? "notif.enabled" : "notif.disabled")}
									</span>
								)}
							</div>
						);
					})}
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
