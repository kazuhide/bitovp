"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input, SelectNative } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import {
	type CloudProviderId,
	LIST_LIMIT_MAX,
	type PageDto,
	PROVIDER_REGIONS,
	REGION_SETTINGS_SCHEMAS,
	type RegionSettingsDto,
} from "@/lib/infrastructure/schemas";
import { REGION_SETTINGS_FIELDS } from "./infrastructure-fields";

type FormValues = { region: string } & Record<string, string>;

/**
 * Region settings sub-CRUD for one Cloud Connect account. There is NO
 * update API — changing a value means delete + re-create (surfaced in the
 * copy). Akamai ids are numbers on the wire; the number inputs coerce.
 */
export function RegionSettingsEditor({
	provider,
	infrastructureId,
	bitmovinAccountId,
}: {
	provider: CloudProviderId;
	infrastructureId: string;
	bitmovinAccountId: string;
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const fields = REGION_SETTINGS_FIELDS[provider];
	const base = `/api/infrastructure/cloud-connect/${provider}/${infrastructureId}/regions`;
	const queryKey = [
		"infra-region-settings",
		bitmovinAccountId,
		provider,
		infrastructureId,
	];

	const list = useQuery({
		queryKey,
		queryFn: () =>
			apiFetch<PageDto<RegionSettingsDto>>(
				`${base}?bitmovinAccountId=${bitmovinAccountId}&limit=${LIST_LIMIT_MAX}`,
			),
	});

	const invalidate = () => queryClient.invalidateQueries({ queryKey });

	const { register, handleSubmit, setError, reset, formState } =
		useForm<FormValues>({
			defaultValues: { region: PROVIDER_REGIONS[provider][0] ?? "" },
		});

	const create = useMutation({
		mutationFn: (payload: unknown) =>
			apiFetch<RegionSettingsDto>(base, {
				method: "POST",
				body: JSON.stringify(payload),
			}),
		onSuccess: () => {
			reset({ region: PROVIDER_REGIONS[provider][0] ?? "" });
			invalidate();
		},
	});

	const remove = useMutation({
		mutationFn: (region: string) =>
			apiFetch<RegionSettingsDto>(
				`${base}/${region}?bitmovinAccountId=${bitmovinAccountId}`,
				{ method: "DELETE" },
			),
		onSuccess: invalidate,
	});

	const submit = handleSubmit((values) => {
		const settings: Record<string, unknown> = {};
		for (const def of fields) {
			const raw = values[def.name] ?? "";
			if (raw === "") {
				if (!def.optional) {
					// Keep "" so the friendly min(1) message fires (string fields);
					// number fields fall through to NaN handling below.
					if (def.type !== "number") {
						settings[def.name] = "";
					}
				}
				continue;
			}
			settings[def.name] = def.type === "number" ? Number(raw) : raw;
		}
		const parsed = REGION_SETTINGS_SCHEMAS[provider].safeParse(settings);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				const path = issue.path.join(".");
				setError((path || "root") as "root", {
					message: zodIssueMessage(issue, t),
				});
			}
			return;
		}
		create.mutate({
			bitmovinAccountId,
			region: values.region,
			settings: parsed.data,
		});
	});

	const mutationError = create.error ?? remove.error;

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<h3 className="font-medium text-sm text-zinc-200">
					{t("settings.regionSettings")}
				</h3>
				<HelpOverlay labelFor={t("settings.regionSettings")}>
					{t("settings.regionSettingsHaveNoUpdateApi")}
				</HelpOverlay>
			</div>

			{mutationError ? (
				<p role="alert" className="text-red-400 text-sm">
					{mutationError instanceof ApiError
						? mutationError.message
						: t("settings.requestFailed")}
				</p>
			) : null}

			{list.isLoading ? (
				<div
					role="status"
					aria-busy="true"
					aria-label={t("settings.loadingRegionSettings")}
					className="h-10 animate-pulse rounded-md bg-zinc-900"
				/>
			) : list.isError ? (
				<p role="alert" className="text-red-400 text-sm">
					{t("settings.failedToLoadRegionSettings")}
					{list.error instanceof ApiError ? `: ${list.error.message}` : ""}
					{t("common.sentenceEnd")}
				</p>
			) : list.data && list.data.items.length > 0 ? (
				<ul className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
					{list.data.items.map((settings) => (
						<li
							key={settings.region}
							className="flex items-center gap-3 px-3 py-2"
						>
							<div className="min-w-0 flex-1">
								<Badge>{settings.region}</Badge>
								<p className="mt-1 truncate text-xs text-zinc-500">
									{fields
										.map((def) => {
											const value = (
												settings as unknown as Record<string, unknown>
											)[def.name];
											return value === undefined
												? null
												: `${t(def.labelKey).replace(/\s*[((](?:optional|任意)[))]$/, "")}: ${String(value)}`;
										})
										.filter(Boolean)
										.join(" · ")}
								</p>
							</div>
							<RoleAccess control="settings.infrastructure.regions">
								<Button
									variant="destructive"
									size="sm"
									disabled={remove.isPending}
									onClick={() => {
										if (
											settings.region &&
											window.confirm(
												t("settingsX.deleteRegionSettings", {
													provider,
													region: settings.region,
												}),
											)
										) {
											remove.mutate(settings.region);
										}
									}}
								>
									{t("settingsForms.delete")}
								</Button>
							</RoleAccess>
						</li>
					))}
				</ul>
			) : (
				<p role="status" className="text-sm text-zinc-500">
					{t("settings.noRegionSettingsYet")}
				</p>
			)}

			<RoleAccess control="settings.infrastructure.regions">
				<form
					onSubmit={submit}
					noValidate
					className="space-y-4 rounded-md border border-zinc-800 p-3"
				>
					<h4 className="font-medium text-xs text-zinc-300">
						{t("settings.addRegionSettings")}
					</h4>
					{formState.errors.root?.message ? (
						<p role="alert" className="text-red-400 text-xs">
							{formState.errors.root.message}
						</p>
					) : null}
					<Field label={t("settingsForms.region")} htmlFor="rs-region">
						<SelectNative id="rs-region" {...register("region")}>
							{PROVIDER_REGIONS[provider].map((region) => (
								<option key={region} value={region}>
									{region}
								</option>
							))}
						</SelectNative>
					</Field>
					{fields.map((def) => (
						<Field
							key={def.name}
							label={t(def.labelKey)}
							htmlFor={`rs-${def.name}`}
							error={
								(formState.errors as Record<string, { message?: string }>)[
									def.name
								]?.message
							}
							{...(def.hintKey ? { hint: t(def.hintKey) } : {})}
						>
							<Input
								id={`rs-${def.name}`}
								type={def.type === "number" ? "number" : "text"}
								autoComplete="off"
								{...register(def.name)}
							/>
						</Field>
					))}
					<div className="flex justify-end">
						<Button type="submit" size="sm" disabled={create.isPending}>
							{create.isPending
								? t("settings.adding")
								: t("settings.addRegionSettings")}
						</Button>
					</div>
				</form>
			</RoleAccess>
		</div>
	);
}
