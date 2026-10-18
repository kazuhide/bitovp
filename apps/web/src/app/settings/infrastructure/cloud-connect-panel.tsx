"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { SelectNative } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import {
	CLOUD_PROVIDER_LABELS,
	CLOUD_PROVIDERS,
	type CloudAccountDto,
	type CloudProviderId,
} from "@/lib/infrastructure/schemas";
import { CloudAccountForm } from "./cloud-account-form";
import { CLOUD_ACCOUNT_SUMMARY } from "./infrastructure-fields";
import { RegionSettingsEditor } from "./region-settings-editor";
import { shownOfTotal, useOffsetList } from "./use-offset-list";

/**
 * Cloud Connect (bring-your-own cloud) accounts per provider. The Bitmovin
 * API has NO update here: edits are delete + re-create (surfaced in copy).
 */
export function CloudConnectPanel({
	bitmovinAccountId,
}: {
	bitmovinAccountId: string;
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const [provider, setProvider] = useState<CloudProviderId>("aws");
	const [createOpen, setCreateOpen] = useState(false);
	const [regionsFor, setRegionsFor] = useState<CloudAccountDto | null>(null);

	const queryKey = ["infra-cloud-accounts", bitmovinAccountId, provider];
	const base = `/api/infrastructure/cloud-connect/${provider}`;

	const list = useOffsetList<CloudAccountDto>(
		queryKey,
		`${base}?bitmovinAccountId=${bitmovinAccountId}`,
	);

	const invalidate = () => queryClient.invalidateQueries({ queryKey });

	const create = useMutation({
		mutationFn: (account: unknown) =>
			apiFetch<CloudAccountDto>(base, {
				method: "POST",
				body: JSON.stringify({ bitmovinAccountId, account }),
			}),
		onSuccess: () => {
			setCreateOpen(false);
			invalidate();
		},
	});

	const remove = useMutation({
		mutationFn: (infrastructureId: string) =>
			apiFetch<CloudAccountDto>(
				`${base}/${infrastructureId}?bitmovinAccountId=${bitmovinAccountId}`,
				{ method: "DELETE" },
			),
		onSuccess: invalidate,
	});

	const mutationError = remove.error;

	return (
		<div>
			{/* : was a `flex items-end justify-between` spread row —
			    the hint under the select dropped the button a hint-line low.
			    The button acts on the SELECTED provider, so it sits beside it. */}
			<div className="max-w-md">
				<Field
					label={t("settingsForms.provider")}
					htmlFor="cc-provider"
					help={[
						t("settingsForms.cloudConnectRunsBitmovinEncodersInsideYour"),
						t("settings.cloudConnectAccountsCannotBeEdited"),
					].join(" ")}
					trailing={
						<RoleAccess control="settings.infrastructure.cloud-connect">
							<Button onClick={() => setCreateOpen(true)}>
								<Plus aria-hidden className="h-4 w-4" />{" "}
								{t("settingsX.addProviderAccount", {
									provider: CLOUD_PROVIDER_LABELS[provider],
								})}
							</Button>
						</RoleAccess>
					}
				>
					<SelectNative
						id="cc-provider"
						value={provider}
						onChange={(e) => setProvider(e.target.value as CloudProviderId)}
					>
						{CLOUD_PROVIDERS.map((p) => (
							<option key={p} value={p}>
								{CLOUD_PROVIDER_LABELS[p]}
							</option>
						))}
					</SelectNative>
				</Field>
			</div>

			{mutationError ? (
				<p role="alert" className="mt-4 text-red-400 text-sm">
					{mutationError instanceof ApiError
						? mutationError.message
						: t("settings.requestFailed")}
				</p>
			) : null}

			<div className="mt-4">
				{list.isLoading ? (
					<div
						role="status"
						aria-busy="true"
						aria-label={t("settings.loadingCloudConnectAccounts")}
						className="space-y-2"
					>
						{[0, 1].map((i) => (
							<div
								key={i}
								className="h-14 animate-pulse rounded-md bg-zinc-900"
							/>
						))}
					</div>
				) : list.isError ? (
					<div
						role="alert"
						className="rounded-md border border-red-900 bg-red-950/30 p-4 text-red-300 text-sm"
					>
						{t("settings.failedToLoadAccounts")}
						{list.error instanceof ApiError ? `: ${list.error.message}` : ""}
						{t("common.sentenceEnd")}{" "}
						<button
							type="button"
							className="underline"
							onClick={() => list.refetch()}
						>
							{t("settingsForms.retry")}
						</button>
					</div>
				) : list.items.length > 0 ? (
					<ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
						{list.items.map((account) => (
							<li
								key={account.id}
								className="flex items-center gap-4 px-4 py-3"
							>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="truncate font-medium text-sm text-zinc-100">
											{account.name || account.id}
										</span>
										<Badge>{CLOUD_PROVIDER_LABELS[provider]}</Badge>
									</div>
									<p className="mt-0.5 truncate text-xs text-zinc-500">
										{CLOUD_ACCOUNT_SUMMARY[provider](account, t)}
									</p>
								</div>
								<div className="flex shrink-0 gap-1">
									<Button
										variant="secondary"
										size="sm"
										onClick={() => setRegionsFor(account)}
									>
										{t("settings.regionSettings")}
									</Button>
									<RoleAccess control="settings.infrastructure.cloud-connect">
										<Button
											variant="destructive"
											size="sm"
											disabled={remove.isPending}
											onClick={() => {
												if (
													window.confirm(
														t("settingsX.deleteProviderAccountNamed", {
															provider: CLOUD_PROVIDER_LABELS[provider],
															name: account.name || account.id,
														}),
													)
												) {
													remove.mutate(account.id);
												}
											}}
										>
											{t("settingsForms.delete")}
										</Button>
									</RoleAccess>
								</div>
							</li>
						))}
					</ul>
				) : (
					<div
						role="status"
						className="rounded-lg border border-zinc-800 border-dashed bg-zinc-900/40 p-10 text-center"
					>
						<h3 className="font-medium text-sm text-zinc-200">
							{t("settingsX.noProviderAccounts", {
								provider: CLOUD_PROVIDER_LABELS[provider],
							})}
						</h3>
					</div>
				)}
				{!list.isLoading && !list.isError && list.items.length > 0 ? (
					<div className="mt-2 flex items-center justify-between gap-4">
						<p className="text-xs text-zinc-500">
							{t("settingsX.showingAccounts", {
								shown: shownOfTotal(list.items.length, list.totalCount, t),
							})}
						</p>
						{list.hasNextPage ? (
							<Button
								variant="secondary"
								size="sm"
								disabled={list.isFetchingNextPage}
								onClick={() => list.fetchNextPage()}
							>
								{list.isFetchingNextPage
									? t("settings.loading")
									: t("settings.loadMore")}
							</Button>
						) : null}
					</div>
				) : null}
			</div>

			<RoleAccess control="settings.infrastructure.cloud-connect">
				<Dialog
					open={createOpen}
					onOpenChange={(open) => {
						if (!open && !create.isPending) {
							setCreateOpen(false);
							create.reset();
						}
					}}
					title={t("settingsX.addProviderCloudConnect", {
						provider: CLOUD_PROVIDER_LABELS[provider],
					})}
				>
					{create.isError ? (
						<p role="alert" className="mb-3 text-red-400 text-sm">
							{create.error instanceof ApiError
								? create.error.message
								: t("settings.requestFailed")}
						</p>
					) : null}
					{createOpen ? (
						<CloudAccountForm
							provider={provider}
							submitting={create.isPending}
							onSubmit={(account) => create.mutate(account)}
						/>
					) : null}
				</Dialog>
			</RoleAccess>

			<Dialog
				open={regionsFor !== null}
				onOpenChange={(open) => {
					if (!open) {
						setRegionsFor(null);
					}
				}}
				title={t("settingsX.regionSettingsFor", {
					name: regionsFor?.name || regionsFor?.id || "",
				})}
			>
				{regionsFor ? (
					<RegionSettingsEditor
						provider={provider}
						infrastructureId={regionsFor.id}
						bitmovinAccountId={bitmovinAccountId}
					/>
				) : null}
			</Dialog>
		</div>
	);
}
