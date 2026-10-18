"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { apiFetch } from "@/lib/api";
import { useRoleAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import { ComputeCredentialsPanel, credentialQuery } from "./credential-panel";
import { ProfileForm } from "./profile-form";
import { CLOUD_NAMES, type ProfileRow } from "./types";

function ProfileSettings() {
	const { t } = useT();
	const client = useQueryClient();
	const profiles = useQuery({
		queryKey: ["vmaf-settings-profiles"],
		queryFn: () =>
			apiFetch<{ items: ProfileRow[] }>("/api/settings/vmaf-profiles"),
	});
	const credentials = useQuery(credentialQuery);
	const [dialog, setDialog] = useState<{ row?: ProfileRow } | null>(null);
	const invalidate = () =>
		Promise.all([
			client.invalidateQueries({ queryKey: ["vmaf-settings-profiles"] }),
			client.invalidateQueries({ queryKey: ["vmaf-compute-profiles"] }),
		]);
	const save = useMutation({
		mutationFn: (body: unknown) =>
			apiFetch("/api/settings/vmaf-profiles", {
				method: "POST",
				body: JSON.stringify(body),
			}),
		onSuccess: () => {
			setDialog(null);
			invalidate();
		},
	});
	const disable = useMutation({
		mutationFn: (id: string) =>
			apiFetch(`/api/settings/vmaf-profiles/${encodeURIComponent(id)}`, {
				method: "DELETE",
			}),
		onSuccess: invalidate,
	});
	return (
		<section className="space-y-7">
			<header>
				<div className="flex items-center gap-2">
					<h1 className="font-semibold text-xl text-zinc-50">
						{t("vmafSettings.title")}
					</h1>
					<HelpOverlay labelFor={t("vmafSettings.title")}>
						{t("vmafSettings.intro")}
					</HelpOverlay>
				</div>
			</header>
			<section className="space-y-3">
				<header className="flex flex-wrap items-center justify-between gap-2">
					<h2 className="font-medium text-base">
						{t("vmafSettings.profiles")}
					</h2>
					<Button
						size="sm"
						onClick={() => {
							save.reset();
							setDialog({});
						}}
						disabled={credentials.isLoading || credentials.isError}
					>
						{t("vmafSettings.addProfile")}
					</Button>
				</header>
				{(profiles.isError || credentials.isError || disable.isError) && (
					<p role="alert" className="text-red-400 text-sm">
						{t("vmafSettings.error")}
						{(profiles.isError || credentials.isError) && (
							<Button
								variant="secondary"
								size="sm"
								disabled={profiles.isFetching || credentials.isFetching}
								onClick={() => {
									if (profiles.isError) profiles.refetch();
									if (credentials.isError) credentials.refetch();
								}}
							>
								{t("settingsForms.retry")}
							</Button>
						)}
					</p>
				)}
				{profiles.isLoading ? (
					<p role="status">{t("common.loading")}</p>
				) : profiles.data?.items.length ? (
					<ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
						{profiles.data.items.map((row) => (
							<li
								key={row.id}
								className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
							>
								<div className="min-w-0">
									<p className="break-words text-sm">{row.label}</p>
									<p className="text-xs text-zinc-500">
										{CLOUD_NAMES[row.config.provider]} · {row.config.region} ·{" "}
										{t("vmafSettings.version", { version: row.version })}
										{!row.enabled ? ` · ${t("vmafSettings.disabled")}` : ""}
									</p>
								</div>
								<div className="flex gap-1">
									<Button
										size="sm"
										variant="ghost"
										disabled={credentials.isLoading || credentials.isError}
										onClick={() => {
											save.reset();
											setDialog({ row });
										}}
									>
										{t("vmafSettings.edit")}
									</Button>
									{row.enabled && (
										<Button
											size="sm"
											variant="ghost"
											disabled={disable.isPending}
											onClick={() => disable.mutate(row.id)}
										>
											{t("vmafSettings.disable")}
										</Button>
									)}
								</div>
							</li>
						))}
					</ul>
				) : (
					!profiles.isError && (
						<p className="text-sm text-zinc-500">{t("vmafSettings.empty")}</p>
					)
				)}
			</section>
			<ComputeCredentialsPanel />
			<Dialog
				wide
				open={dialog !== null}
				onOpenChange={(open) => {
					if (!open && !save.isPending) setDialog(null);
				}}
				title={
					dialog?.row ? t("vmafSettings.edit") : t("vmafSettings.addProfile")
				}
			>
				{save.isError && (
					<p role="alert" className="mb-3 text-red-400 text-sm">
						{t("vmafSettings.error")}
						{(profiles.isError || credentials.isError) && (
							<Button
								variant="secondary"
								size="sm"
								disabled={profiles.isFetching || credentials.isFetching}
								onClick={() => {
									if (profiles.isError) profiles.refetch();
									if (credentials.isError) credentials.refetch();
								}}
							>
								{t("settingsForms.retry")}
							</Button>
						)}
					</p>
				)}
				{dialog && (
					<ProfileForm
						row={dialog.row}
						credentials={credentials.data?.items ?? []}
						pending={save.isPending}
						onSave={(body) => save.mutate(body)}
					/>
				)}
			</Dialog>
		</section>
	);
}
export function VmafProfilesClient() {
	const allowed = useRoleAccess("ADMIN");
	return allowed ? <ProfileSettings /> : null;
}
