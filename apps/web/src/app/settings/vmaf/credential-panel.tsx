"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input, SelectNative, Textarea } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import type { CredentialRow } from "./types";

const fields = {
	AWS: ["accessKeyId", "secretAccessKey"],
	GCP: ["clientEmail", "privateKey", "projectId"],
	AZURE: ["tenantId", "clientId", "clientSecret"],
	AKAMAI: ["token"],
} as const;
export const credentialQuery = {
	queryKey: ["vmaf-credentials"],
	queryFn: () =>
		apiFetch<{ items: CredentialRow[] }>("/api/settings/vmaf-credentials"),
};

function CredentialForm({
	pending,
	onSave,
}: {
	pending: boolean;
	onSave: (body: unknown) => void;
}) {
	const { t } = useT();
	const id = useId();
	const [provider, setProvider] = useState<CredentialRow["provider"]>("AWS");
	const [label, setLabel] = useState("");
	const [values, setValues] = useState<Record<string, string>>({});
	return (
		<form
			className="space-y-3"
			onSubmit={(e) => {
				e.preventDefault();
				onSave({
					label,
					secret: {
						provider,
						...Object.fromEntries(
							fields[provider]
								.filter((key) => values[key])
								.map((key) => [key, values[key]]),
						),
					},
				});
			}}
		>
			<fieldset disabled={pending} className="space-y-3">
				<Field label={t("vmafSettings.label")} htmlFor={`${id}-label`}>
					<Input
						id={`${id}-label`}
						value={label}
						required
						maxLength={100}
						onChange={(e) => setLabel(e.target.value)}
					/>
				</Field>
				<Field label={t("vmafSettings.provider")} htmlFor={`${id}-provider`}>
					<SelectNative
						id={`${id}-provider`}
						value={provider}
						onChange={(e) => {
							setProvider(e.target.value as typeof provider);
							setValues({});
						}}
					>
						{Object.keys(fields).map((key) => (
							<option key={key}>{key}</option>
						))}
					</SelectNative>
				</Field>
				{fields[provider].map((key) => (
					<Field
						key={key}
						label={t(`vmafSettings.${key}`)}
						htmlFor={`${id}-${key}`}
					>
						{key === "privateKey" ? (
							<Textarea
								id={`${id}-${key}`}
								value={values[key] ?? ""}
								onChange={(e) =>
									setValues((v) => ({ ...v, [key]: e.target.value }))
								}
								required
								autoComplete="off"
								spellCheck={false}
							/>
						) : (
							<Input
								id={`${id}-${key}`}
								value={values[key] ?? ""}
								onChange={(e) =>
									setValues((v) => ({ ...v, [key]: e.target.value }))
								}
								type={
									["secretAccessKey", "clientSecret", "token"].includes(key)
										? "password"
										: "text"
								}
								autoComplete="off"
								required={key !== "projectId"}
							/>
						)}
					</Field>
				))}
				<Button type="submit" disabled={pending}>
					{t("vmafSettings.save")}
				</Button>
			</fieldset>
		</form>
	);
}

export function ComputeCredentialsPanel() {
	const { t } = useT();
	const query = useQuery(credentialQuery);
	const client = useQueryClient();
	const [open, setOpen] = useState(false);
	const invalidate = () =>
		client.invalidateQueries({ queryKey: credentialQuery.queryKey });
	const create = useMutation({
		mutationFn: (body: unknown) =>
			apiFetch("/api/settings/vmaf-credentials", {
				method: "POST",
				body: JSON.stringify(body),
			}),
		onSuccess: () => {
			setOpen(false);
			invalidate();
		},
	});
	const disable = useMutation({
		mutationFn: (id: string) =>
			apiFetch(`/api/settings/vmaf-credentials/${id}`, { method: "DELETE" }),
		onSuccess: invalidate,
	});
	return (
		<section className="space-y-3" id="cloud-credentials">
			<header className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<h2 className="font-medium text-base">
						{t("vmafSettings.credentials")}
					</h2>
					<HelpOverlay labelFor={t("vmafSettings.credentials")}>
						{t("vmafSettings.secretHelp")}
					</HelpOverlay>
				</div>
				<Button
					size="sm"
					variant="secondary"
					onClick={() => {
						create.reset();
						setOpen(true);
					}}
				>
					{t("vmafSettings.addCredential")}
				</Button>
			</header>
			{disable.isError && (
				<p role="alert" className="text-red-400 text-sm">
					{t("vmafSettings.error")}
				</p>
			)}
			{query.isLoading ? (
				<p role="status">{t("common.loading")}</p>
			) : query.isError ? (
				<p role="alert" className="text-red-400 text-sm">
					{t("vmafSettings.error")}{" "}
					<Button
						variant="secondary"
						size="sm"
						disabled={query.isFetching}
						onClick={() => query.refetch()}
					>
						{t("settingsForms.retry")}
					</Button>
				</p>
			) : !query.data?.items.length ? (
				<p className="text-sm text-zinc-500">
					{t("vmafSettings.emptyCredentials")}
				</p>
			) : (
				<ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
					{query.data.items.map((c) => (
						<li
							key={c.id}
							className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
						>
							<span className="min-w-0 break-words">
								{c.label}{" "}
								<span className="text-zinc-500">
									{c.provider}
									{c.disabledAt ? ` · ${t("vmafSettings.disabled")}` : ""}
								</span>
							</span>
							{!c.disabledAt && (
								<Button
									size="sm"
									variant="ghost"
									disabled={disable.isPending}
									onClick={() => disable.mutate(c.id)}
								>
									{t("vmafSettings.disable")}
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!create.isPending) setOpen(next);
				}}
				title={t("vmafSettings.addCredential")}
			>
				{create.isError && (
					<p role="alert" className="mb-3 text-red-400 text-sm">
						{t("vmafSettings.error")}
					</p>
				)}
				{open && (
					<CredentialForm
						pending={create.isPending}
						onSave={(body) => create.mutate(body)}
					/>
				)}
			</Dialog>
		</section>
	);
}
