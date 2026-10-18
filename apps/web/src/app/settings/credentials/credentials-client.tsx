"use client";

import {
	CREDENTIAL_GROUPS,
	CREDENTIAL_PROVIDER_GROUP,
	CREDENTIAL_PROVIDER_LABELS,
} from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { localizedCustomerError } from "@/lib/customer-error";
import { useT } from "@/lib/i18n/context";
import { CredentialForm } from "./credential-form";
import { GROUP_HEADING } from "./groups";
import { PROVIDER_CONFIG_SUMMARY } from "./provider-fields";
import type { CredentialDto } from "./types";

export function CredentialsClient() {
	const { t } = useT();
	const queryClient = useQueryClient();
	/**
	 * `?new=1` opens the add dialog straight away.
	 *
	 * The wizards link here when an operator needs a credential they have not
	 * registered yet (owner request 2026-08-19): the alternative is landing on
	 * a list and hunting for the button, one step after already deciding to
	 * create one. `useSearchParams` rather than a route so the deep link is a
	 * query on the page that already exists.
	 */
	const params = useSearchParams();
	const [dialog, setDialog] = useState<
		{ mode: "create" } | { mode: "edit"; credential: CredentialDto } | null
	>(params.get("new") === "1" ? { mode: "create" } : null);

	const list = useQuery({
		queryKey: ["credentials"],
		queryFn: () => apiFetch<CredentialDto[]>("/api/credentials"),
	});

	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: ["credentials"] });

	const create = useMutation({
		mutationFn: (payload: unknown) =>
			apiFetch<CredentialDto>("/api/credentials", {
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
			apiFetch<CredentialDto>(`/api/credentials/${id}`, {
				method: "PATCH",
				body: JSON.stringify(payload),
			}),
		onSuccess: () => {
			setDialog(null);
			invalidate();
		},
	});

	const remove = useMutation({
		mutationFn: (id: string) =>
			apiFetch<void>(`/api/credentials/${id}`, { method: "DELETE" }),
		onSuccess: invalidate,
	});

	const formError = create.error ?? update.error;
	const mutationError = remove.error;

	return (
		<section>
			<header className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<div className="flex items-center gap-2">
						<h1 className="font-semibold text-xl text-zinc-50">
							{t("settings.storageCredentials")}
						</h1>
						<HelpOverlay labelFor={t("settings.storageCredentials")}>
							{t("settings.encryptedAtRestAes256Gcm")}
						</HelpOverlay>
					</div>
				</div>
				<RoleAccess control="settings.credentials">
					<Button onClick={() => setDialog({ mode: "create" })}>
						<Plus aria-hidden className="h-4 w-4" />{" "}
						{t("settings.addCredential")}
					</Button>
				</RoleAccess>
			</header>

			<RoleAccess control="settings.credentials">
				<Link
					href="/settings/vmaf#cloud-credentials"
					className="mt-3 inline-block text-xs text-zinc-400 underline hover:text-zinc-200"
				>
					{t("vmafSettings.credentials")}
				</Link>
			</RoleAccess>

			{mutationError ? (
				<p role="alert" className="mt-4 text-red-400 text-sm">
					{localizedCustomerError(t, mutationError, "settings.requestFailed")}
				</p>
			) : null}

			<div className="mt-6">
				{list.isLoading ? (
					<div
						role="status"
						aria-busy="true"
						aria-label={t("settings.loadingCredentials")}
						className="space-y-2"
					>
						{[0, 1, 2].map((i) => (
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
						{localizedCustomerError(
							t,
							list.error,
							"settings.failedToLoadCredentials",
						)}
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
					/**
					 * Grouped BY PURPOSE .
					 *
					 * This screen was titled "Storage credentials" and listed a DRM
					 * content key, two live-ingest secrets and four integration
					 * endpoints. The owner raised the DRM one twice — a title that
					 * contradicts its contents teaches operators to distrust every
					 * label on the page.
					 *
					 * A group with no credentials renders nothing, so a fresh
					 * install still shows one list rather than four empty headings.
					 */
					CREDENTIAL_GROUPS.filter((group) =>
						(list.data ?? []).some(
							(c) => CREDENTIAL_PROVIDER_GROUP[c.provider] === group,
						),
					).map((group) => (
						<section key={group} className="mt-6 first:mt-0">
							<h2 className="mb-2 font-medium text-sm text-zinc-400">
								{t(GROUP_HEADING[group])}
							</h2>
							<ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
								{(list.data ?? [])
									.filter(
										(c) => CREDENTIAL_PROVIDER_GROUP[c.provider] === group,
									)
									.map((cred) => (
										<li
											key={cred.id}
											className="flex flex-wrap items-center gap-4 px-4 py-3"
										>
											<div className="min-w-0 flex-1">
												<div className="flex items-center gap-2">
													<span className="truncate font-medium text-sm text-zinc-100">
														{cred.label}
													</span>
													<Badge>
														{CREDENTIAL_PROVIDER_LABELS[cred.provider]}
													</Badge>
												</div>
												<p className="mt-0.5 truncate text-xs text-zinc-500">
													{PROVIDER_CONFIG_SUMMARY[cred.provider](cred.config)}
												</p>
											</div>
											{/* Keyed on the ROW, which is the whole of . Two earlier revisions of this badge were
											    wrong in two different ways: the first rendered it
											    unconditionally, so the two providers with an
											    empty `secret` array advertised a secret they
											    cannot hold (security F13); the second keyed on
											    `PROVIDER_FIELDS[provider].secret.length > 0`,
											    which is a claim about the PROVIDER TYPE under
											    text that claims something about the INSTANCE.

											    That second one was correct for all 18 providers
											    on the day it shipped and would have become a lie
											    in the very next PR: the moment `AKAMAI_MSL.secret`
											    gains MSL5's Digest pair — which it does, in this
											    same commit — every AKAMAI_MSL row lights up,
											    including MSL4 credentials that cannot carry a
											    pair and MSL5 credentials that legitimately omit
											    one.

											    `hasSecret` is the server's answer for THIS row,
											    derived by looking rather than by inferring from
											    the provider. It also subsumes the F13 fix:
											    AWS_S3_ROLE_BASED has no secret, so it reports
											    false and shows nothing — same outcome, honest
											    reason. */}
											{cred.hasSecret ? (
												<Badge tone="ok">
													{t("settingsForms.secretConfigured")}
												</Badge>
											) : null}
											<RoleAccess control="settings.credentials">
												<div className="flex shrink-0 gap-1">
													<Button
														variant="ghost"
														size="sm"
														onClick={() =>
															setDialog({ mode: "edit", credential: cred })
														}
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
																	t("settingsX.deleteCredentialNamed", {
																		name: cred.label,
																	}),
																)
															) {
																remove.mutate(cred.id);
															}
														}}
													>
														{t("settingsForms.delete")}
													</Button>
												</div>
											</RoleAccess>
										</li>
									))}
							</ul>
						</section>
					))
				) : (
					<div
						role="status"
						className="rounded-lg border border-zinc-800 border-dashed bg-zinc-900/40 p-10 text-center"
					>
						<h3 className="font-medium text-sm text-zinc-200">
							{t("settings.noCredentialsYet")}
						</h3>
						<RoleAccess control="settings.credentials">
							<Button
								className="mt-4"
								onClick={() => setDialog({ mode: "create" })}
							>
								{t("settings.addYourFirstCredential")}
							</Button>
						</RoleAccess>
					</div>
				)}
			</div>

			<RoleAccess control="settings.credentials">
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
							? t("settings.editCredential")
							: t("settings.addCredential")
					}
				>
					{formError ? (
						<p role="alert" className="mb-4 text-red-400 text-sm">
							{localizedCustomerError(t, formError, "settings.requestFailed")}
						</p>
					) : null}
					{dialog ? (
						<CredentialForm
							credential={
								dialog.mode === "edit" ? dialog.credential : undefined
							}
							submitting={create.isPending || update.isPending}
							onSubmit={(payload) => {
								if (dialog.mode === "edit") {
									update.mutate({ id: dialog.credential.id, payload });
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
