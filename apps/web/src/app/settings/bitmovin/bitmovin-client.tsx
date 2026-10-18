"use client";

import type { TestConnectionResult } from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { ApiError, apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import { BitmovinForm } from "./bitmovin-form";
import type { BitmovinAccountDto } from "./types";

export function BitmovinClient() {
	const { t } = useT();
	const queryClient = useQueryClient();
	const [dialog, setDialog] = useState<
		{ mode: "create" } | { mode: "edit"; account: BitmovinAccountDto } | null
	>(null);
	const [testResults, setTestResults] = useState<
		Record<string, TestConnectionResult>
	>({});

	const list = useQuery({
		queryKey: ["bitmovin-accounts"],
		queryFn: () => apiFetch<BitmovinAccountDto[]>("/api/bitmovin-accounts"),
	});

	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: ["bitmovin-accounts"] });

	const create = useMutation({
		mutationFn: (payload: unknown) =>
			apiFetch<BitmovinAccountDto>("/api/bitmovin-accounts", {
				method: "POST",
				body: JSON.stringify(payload),
			}),
		onSuccess: () => {
			setDialog(null);
			invalidate();
		},
	});

	const update = useMutation({
		mutationFn: ({ id, payload }: { id: string; payload: unknown }) =>
			apiFetch<BitmovinAccountDto>(`/api/bitmovin-accounts/${id}`, {
				method: "PATCH",
				body: JSON.stringify(payload),
			}),
		onSuccess: (_data, { id }) => {
			setDialog(null);
			// A stale "connected" badge must not survive a key rotation.
			setTestResults((prev) => {
				const { [id]: _dropped, ...rest } = prev;
				return rest;
			});
			invalidate();
		},
	});

	const remove = useMutation({
		mutationFn: (id: string) =>
			apiFetch<void>(`/api/bitmovin-accounts/${id}`, { method: "DELETE" }),
		onSuccess: invalidate,
	});

	const test = useMutation({
		mutationFn: (id: string) =>
			apiFetch<TestConnectionResult>(`/api/bitmovin-accounts/${id}/test`, {
				method: "POST",
			}),
		onSuccess: (result, id) =>
			setTestResults((prev) => ({ ...prev, [id]: result })),
	});

	const formError = create.error ?? update.error;
	const mutationError = remove.error ?? test.error;

	return (
		<section>
			<header className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<div className="flex items-center gap-2">
						<h1 className="font-semibold text-xl text-zinc-50">
							{t("settings.bitmovinAccounts")}
						</h1>
						<HelpOverlay labelFor={t("settings.bitmovinAccounts")}>
							{t("settings.apiKeysAreEncryptedAtRest")}
						</HelpOverlay>
					</div>
				</div>
				<RoleAccess control="settings.bitmovin">
					<Button onClick={() => setDialog({ mode: "create" })}>
						<Plus aria-hidden className="h-4 w-4" /> {t("settings.addAccount")}
					</Button>
				</RoleAccess>
			</header>

			{mutationError ? (
				<p role="alert" className="mt-4 text-red-400 text-sm">
					{mutationError instanceof ApiError
						? mutationError.message
						: t("settings.requestFailed")}
				</p>
			) : null}

			<div className="mt-6">
				{list.isLoading ? (
					<div
						role="status"
						aria-busy="true"
						aria-label={t("settings.loadingAccounts")}
						className="space-y-2"
					>
						{[0, 1].map((i) => (
							<div
								key={i}
								className="h-20 animate-pulse rounded-md bg-zinc-900"
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
				) : list.data && list.data.length > 0 ? (
					<ul className="space-y-3">
						{list.data.map((account) => {
							const result = testResults[account.id];
							return (
								<li
									key={account.id}
									className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
								>
									<div className="flex flex-wrap items-center gap-3">
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span className="font-medium text-sm text-zinc-100">
													{account.label}
												</span>
												{account.tenantOrgId ? (
													<Badge>
														{t("settingsX.orgLabel", {
															id: account.tenantOrgId,
														})}
													</Badge>
												) : null}
											</div>
										</div>
										<RoleAccess control="settings.bitmovin">
											<Button
												variant="secondary"
												size="sm"
												disabled={
													test.isPending && test.variables === account.id
												}
												onClick={() => test.mutate(account.id)}
											>
												{test.isPending && test.variables === account.id
													? t("settings.testing")
													: t("settings.testConnection")}
											</Button>
											<Button
												variant="ghost"
												size="sm"
												onClick={() => setDialog({ mode: "edit", account })}
											>
												{t("settingsForms.edit")}
											</Button>
											<Button
												variant="destructive"
												size="sm"
												disabled={remove.isPending}
												onClick={() => {
													if (
														window.confirm(
															t("settingsX.deleteAccountNamed", {
																name: account.label,
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
									{result ? (
										<div
											className="mt-3 border-zinc-800 border-t pt-3"
											role="status"
										>
											{result.ok ? (
												<Badge tone="ok">
													{t("settingsX.connectedLatency", {
														ms: result.latencyMs ?? 0,
													})}
													{result.accountEmail
														? ` · ${result.accountEmail}`
														: ""}
												</Badge>
											) : (
												<Badge tone="error">
													{t("settingsX.failed")}
													{result.message ? ` · ${result.message}` : ""}
												</Badge>
											)}
										</div>
									) : null}
								</li>
							);
						})}
					</ul>
				) : (
					<div
						role="status"
						className="rounded-lg border border-zinc-800 border-dashed bg-zinc-900/40 p-10 text-center"
					>
						<h3 className="font-medium text-sm text-zinc-200">
							{t("settings.noBitmovinAccountsYet")}
						</h3>
						<RoleAccess control="settings.bitmovin">
							<Button
								className="mt-4"
								onClick={() => setDialog({ mode: "create" })}
							>
								{t("settings.addYourFirstAccount")}
							</Button>
						</RoleAccess>
					</div>
				)}
			</div>

			<RoleAccess control="settings.bitmovin">
				<Dialog
					open={dialog !== null}
					onOpenChange={(open) => {
						if (!open && !create.isPending && !update.isPending) {
							setDialog(null);
							create.reset();
							update.reset();
						}
					}}
					title={
						dialog?.mode === "edit"
							? t("settings.editBitmovinAccount")
							: t("settings.addBitmovinAccount")
					}
				>
					{formError ? (
						<p role="alert" className="mb-4 text-red-400 text-sm">
							{formError instanceof ApiError
								? formError.message
								: t("settings.requestFailed")}
						</p>
					) : null}
					{dialog ? (
						<BitmovinForm
							account={dialog.mode === "edit" ? dialog.account : undefined}
							submitting={create.isPending || update.isPending}
							onSubmit={(payload) => {
								if (dialog.mode === "edit") {
									update.mutate({ id: dialog.account.id, payload });
								} else {
									create.mutate(payload);
								}
							}}
						/>
					) : null}
				</Dialog>
			</RoleAccess>
		</section>
	);
}
