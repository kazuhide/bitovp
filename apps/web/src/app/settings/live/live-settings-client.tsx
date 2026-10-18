"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import type { BitmovinAccountDto } from "@/app/settings/bitmovin/types";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { SelectNative } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import { AlertsPanel } from "./alerts-panel";
import { DnsMappingsSettingsPanel } from "./dns-mappings-settings-panel";
import { HeartbeatWebhookPanel } from "./heartbeat-webhook-panel";
import { StandbyPoolsPanel } from "./standby-pools-panel";
import { StartupProfilesPanel } from "./startup-profiles-panel";
import { StreamKeysPanel } from "./stream-keys-panel";

/**
 * Settings → Live. The account-level live runtime surface: reserved stream keys,
 * DNS ingest mappings and standby pools. Same shape as Settings →
 * Infrastructure: a thin proxy over the Bitmovin API scoped to ONE stored
 * Bitmovin account.
 */
export function LiveSettingsClient() {
	const { t } = useT();
	const [accountId, setAccountId] = useState<string | null>(null);

	const accounts = useQuery({
		queryKey: ["bitmovin-accounts"],
		queryFn: () => apiFetch<BitmovinAccountDto[]>("/api/bitmovin-accounts"),
	});

	const effectiveAccountId = accountId ?? accounts.data?.[0]?.id ?? null;

	return (
		<section>
			<header>
				<div className="flex items-center gap-2">
					<h1 className="font-semibold text-xl text-zinc-50">
						{t("settingsForms.live")}
					</h1>
					<HelpOverlay labelFor={t("settingsForms.live")}>
						{t("settings.reservedStreamKeysDnsIngestHostnames")}
					</HelpOverlay>
				</div>
			</header>

			<div className="mt-6 max-w-sm">
				{accounts.isLoading ? (
					<div
						role="status"
						aria-busy="true"
						aria-label={t("settings.loadingBitmovinAccounts")}
						className="h-16 animate-pulse rounded-md bg-zinc-900"
					/>
				) : accounts.isError ? (
					<div
						role="alert"
						className="rounded-md border border-red-900 bg-red-950/30 p-4 text-red-300 text-sm"
					>
						{t("settings.failedToLoadBitmovinAccounts")}
						{accounts.error instanceof ApiError
							? `: ${accounts.error.message}`
							: ""}
						{t("common.sentenceEnd")}{" "}
						<button
							type="button"
							className="underline"
							onClick={() => accounts.refetch()}
						>
							{t("settingsForms.retry")}
						</button>
					</div>
				) : accounts.data && accounts.data.length > 0 ? (
					<Field
						label={t("settings.bitmovinAccount")}
						htmlFor="live-account"
						help={t("settingsForms.allLiveResourcesBelowLiveInThis")}
					>
						<SelectNative
							id="live-account"
							value={effectiveAccountId ?? ""}
							onChange={(e) => setAccountId(e.target.value)}
						>
							{accounts.data.map((account) => (
								<option key={account.id} value={account.id}>
									{account.label}
								</option>
							))}
						</SelectNative>
					</Field>
				) : (
					<div
						role="status"
						className="rounded-lg border border-zinc-800 border-dashed bg-zinc-900/40 p-6"
					>
						<h3 className="font-medium text-sm text-zinc-200">
							{t("settings.noBitmovinAccountsYet")}
						</h3>
						<p className="mt-1 text-sm text-zinc-500">
							{t("settingsX.liveResourcesManagedPerAccount")}
							<Link href="/settings/bitmovin" className="underline">
								{t("settings.addOneFirst")}
							</Link>
							{t("common.sentenceEnd")}
						</p>
					</div>
				)}
			</div>

			{effectiveAccountId ? (
				<Tabs defaultValue="stream-keys" className="mt-8">
					<TabsList>
						<TabsTrigger value="stream-keys">
							{t("settings.streamKeys")}
						</TabsTrigger>
						<TabsTrigger value="dns-mappings">
							{t("settings.dnsMappings")}
						</TabsTrigger>
						<TabsTrigger value="standby-pools">
							{t("settings.standbyPools")}
						</TabsTrigger>
					</TabsList>
					<TabsContent value="stream-keys">
						<StreamKeysPanel bitmovinAccountId={effectiveAccountId} />
					</TabsContent>
					<TabsContent value="dns-mappings">
						<DnsMappingsSettingsPanel bitmovinAccountId={effectiveAccountId} />
					</TabsContent>
					<TabsContent value="standby-pools">
						<StandbyPoolsPanel bitmovinAccountId={effectiveAccountId} />
					</TabsContent>
				</Tabs>
			) : null}

			{/* Alert rules are account-INDEPENDENT (they evaluate our own
			    heartbeat rows), so they live outside the account picker. */}
			<div className="mt-10">
				<AlertsPanel />
			</div>

			{/* Startup profiles aggregate OUR samples  — also
			    account-independent. */}
			<div className="mt-10">
				<StartupProfilesPanel />
			</div>

			{/* The heartbeat hook is registered per account with a live run, but
			    its cadence is one app-wide setting (C37) — account-independent. */}
			<div className="mt-10">
				<HeartbeatWebhookPanel />
			</div>
		</section>
	);
}
