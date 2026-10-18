"use client";

import type { PlayerSettings } from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input, SelectNative } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";

/**
 *  . The licence keys are PUBLIC CLIENT
 * keys (C26): domain-locked at the vendor and designed to reach the browser
 * — so unlike every vault credential, they are readable and VISIBLE here.
 * Stored keys stay in the settings row when the operator switches modes, but
 * are shown only for Bitmovin Player: open-source previews neither need them
 * nor send data to Bitmovin Analytics.
 */
export function PlayerSettingsClient() {
	const { t } = useT();
	const canAdmin = useMutationAccess("settings.player");
	const queryClient = useQueryClient();
	const settings = useQuery({
		queryKey: ["player-settings"],
		queryFn: () => apiFetch<PlayerSettings>("/api/settings/player"),
	});
	const [draft, setDraft] = useState<PlayerSettings | null>(null);
	const value = draft ?? settings.data;
	const save = useMutation({
		mutationFn: (patch: Partial<PlayerSettings>) =>
			apiFetch<PlayerSettings>("/api/settings/player", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(patch),
			}),
		onSuccess: (next) => {
			queryClient.setQueryData(["player-settings"], next);
			setDraft(null);
		},
	});

	return (
		<section>
			<div className="flex items-center gap-2">
				<h1 className="font-semibold text-xl text-zinc-50">
					{t("settingsX.player")}
				</h1>
				<HelpOverlay labelFor={t("settingsX.player")}>
					{t("settingsX.playerCaption")}
				</HelpOverlay>
			</div>

			{settings.isPending ? (
				<p className="mt-6 text-sm text-zinc-500">{t("common.loading")}</p>
			) : settings.error || !value ? (
				<p role="alert" className="mt-6 text-amber-400 text-sm">
					{t("settingsX.playerLoadFailed")}{" "}
					<Button
						variant="secondary"
						size="sm"
						onClick={() => settings.refetch()}
						disabled={settings.isFetching}
					>
						{t("settingsForms.retry")}
					</Button>
				</p>
			) : canAdmin ? (
				<form
					className="mt-6 max-w-xl space-y-4"
					onSubmit={(e) => {
						e.preventDefault();
						save.mutate(value);
					}}
				>
					<Field
						label={t("settingsX.playerProvider")}
						htmlFor="player-provider"
						help={[
							t("settingsX.playerProviderHint"),
							value.provider === "native"
								? t("settingsX.playerOpenSourceHint")
								: "",
						]
							.filter(Boolean)
							.join(" ")}
					>
						<SelectNative
							id="player-provider"
							disabled={save.isPending}
							value={value.provider}
							onChange={(e) =>
								setDraft({
									...value,
									provider: e.target.value as PlayerSettings["provider"],
								})
							}
						>
							<option value="native">
								{t("settingsX.playerProviderNative")}
							</option>
							<option value="bitmovin">
								{t("settingsX.playerProviderBitmovin")}
							</option>
						</SelectNative>
					</Field>
					{value.provider === "bitmovin" ? (
						<>
							<Field
								label={t("settingsX.playerLicenseKey")}
								htmlFor="player-license"
								hint={t("settingsX.publicClientKeyHint")}
							>
								<Input
									id="player-license"
									disabled={save.isPending}
									value={value.playerLicenseKey}
									autoComplete="off"
									onChange={(e) =>
										setDraft({ ...value, playerLicenseKey: e.target.value })
									}
								/>
							</Field>
							<Field
								label={t("settingsX.analyticsLicenseKey")}
								htmlFor="analytics-license"
								hint={t("settingsX.analyticsKeyHint")}
							>
								<Input
									id="analytics-license"
									disabled={save.isPending}
									value={value.analyticsLicenseKey}
									autoComplete="off"
									onChange={(e) =>
										setDraft({ ...value, analyticsLicenseKey: e.target.value })
									}
								/>
							</Field>
						</>
					) : null}
					{save.isError ? (
						<p role="alert" className="text-red-400 text-sm">
							{t("settingsX.playerSaveFailed")}
						</p>
					) : null}
					{save.isSuccess && draft === null ? (
						<p className="text-emerald-400 text-sm">
							{t("settingsX.playerSaved")}
						</p>
					) : null}
					<Button type="submit" disabled={save.isPending || draft === null}>
						{save.isPending ? t("common.saving") : t("common.save")}
					</Button>
				</form>
			) : (
				<dl className="mt-6 max-w-xl space-y-3 rounded-md border border-zinc-800 p-4 text-sm">
					<div>
						<dt className="text-xs text-zinc-500">
							{t("settingsX.playerProvider")}
						</dt>
						<dd className="mt-1 text-zinc-200">
							{value.provider === "bitmovin"
								? t("settingsX.playerProviderBitmovin")
								: t("settingsX.playerProviderNative")}
						</dd>
					</div>
					{value.provider === "bitmovin" ? (
						<>
							<div>
								<dt className="text-xs text-zinc-500">
									{t("settingsX.playerLicenseKey")}
								</dt>
								<dd className="mt-1 break-all font-mono text-zinc-300">
									{value.playerLicenseKey || t("common.none")}
								</dd>
							</div>
							<div>
								<dt className="text-xs text-zinc-500">
									{t("settingsX.analyticsLicenseKey")}
								</dt>
								<dd className="mt-1 break-all font-mono text-zinc-300">
									{value.analyticsLicenseKey || t("common.none")}
								</dd>
							</div>
						</>
					) : null}
				</dl>
			)}
		</section>
	);
}
