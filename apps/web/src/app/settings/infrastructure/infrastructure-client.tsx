"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { SelectNative } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import type { BitmovinAccountDto } from "../bitmovin/types";
import { CloudConnectPanel } from "./cloud-connect-panel";
import { PrewarmedPoolsPanel } from "./prewarmed-pools-panel";
import { StaticIpsPanel } from "./static-ips-panel";

/**
 * Settings → Infrastructure. Everything here is a thin proxy over the
 * Bitmovin API scoped to ONE stored Bitmovin account (the picker below):
 * Cloud Connect accounts + region settings, Static IPs, prewarmed pools.
 */
export function InfrastructureClient() {
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
						{t("settingsForms.infrastructure")}
					</h1>
					<HelpOverlay labelFor={t("settingsForms.infrastructure")}>
						{t("settings.cloudConnectBringYourOwnCloud")}
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
						htmlFor="infra-account"
						help={t("settingsForms.allInfrastructureBelowLivesInThisAccount")}
					>
						<SelectNative
							id="infra-account"
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
							{t("settingsX.infrastructureManagedPerAccount")}
							<Link href="/settings/bitmovin" className="underline">
								{t("settings.addOneFirst")}
							</Link>
							{t("common.sentenceEnd")}
						</p>
					</div>
				)}
			</div>

			{effectiveAccountId ? (
				<Tabs defaultValue="cloud-connect" className="mt-8">
					<TabsList>
						<TabsTrigger value="cloud-connect">
							{t("settings.cloudConnect")}
						</TabsTrigger>
						<TabsTrigger value="static-ips">
							{t("settings.staticIps")}
						</TabsTrigger>
						<TabsTrigger value="prewarmed-pools">
							{t("settings.prewarmedPools")}
						</TabsTrigger>
					</TabsList>
					<TabsContent value="cloud-connect">
						<CloudConnectPanel bitmovinAccountId={effectiveAccountId} />
					</TabsContent>
					<TabsContent value="static-ips">
						<StaticIpsPanel bitmovinAccountId={effectiveAccountId} />
					</TabsContent>
					<TabsContent value="prewarmed-pools">
						<PrewarmedPoolsPanel bitmovinAccountId={effectiveAccountId} />
					</TabsContent>
				</Tabs>
			) : null}
		</section>
	);
}
