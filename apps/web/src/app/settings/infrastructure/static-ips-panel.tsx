"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input, SelectNative } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import {
	CLOUD_REGIONS,
	type StaticIpDto,
	type StaticIpStatus,
	staticIpCreateSchema,
} from "@/lib/infrastructure/schemas";
import { shownOfTotal, useOffsetList } from "./use-offset-list";

const STATUS_TONE: Record<StaticIpStatus, "neutral" | "ok" | "error"> = {
	CREATING: "neutral",
	UNUSED: "ok",
	USED: "neutral",
	ERROR: "error",
};

type FormValues = { region: string; infrastructureId: string };

/**
 * Static IP lifecycle. The IP itself is consumed at ENCODING create
 * (Encoding.staticIpId — live encodings only); this panel only requests,
 * inspects and releases addresses. "Used by" is conveyed via status.
 */
export function StaticIpsPanel({
	bitmovinAccountId,
}: {
	bitmovinAccountId: string;
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const [createOpen, setCreateOpen] = useState(false);

	const queryKey = ["infra-static-ips", bitmovinAccountId];
	const base = "/api/infrastructure/static-ips";

	const list = useOffsetList<StaticIpDto>(
		queryKey,
		`${base}?bitmovinAccountId=${bitmovinAccountId}`,
	);

	const invalidate = () => queryClient.invalidateQueries({ queryKey });

	const create = useMutation({
		mutationFn: (staticIp: unknown) =>
			apiFetch<StaticIpDto>(base, {
				method: "POST",
				body: JSON.stringify({ bitmovinAccountId, staticIp }),
			}),
		onSuccess: () => {
			setCreateOpen(false);
			invalidate();
		},
	});

	const remove = useMutation({
		mutationFn: (id: string) =>
			apiFetch<{ id: string }>(
				`${base}/${id}?bitmovinAccountId=${bitmovinAccountId}`,
				{ method: "DELETE" },
			),
		onSuccess: invalidate,
	});

	const { register, handleSubmit, setError, reset, formState } =
		useForm<FormValues>({
			defaultValues: { region: "AWS_EU_WEST_1", infrastructureId: "" },
		});

	const submit = handleSubmit((values) => {
		const parsed = staticIpCreateSchema.safeParse({
			region: values.region,
			...(values.infrastructureId !== ""
				? { infrastructureId: values.infrastructureId }
				: {}),
		});
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				const path = issue.path.join(".");
				setError((path || "root") as keyof FormValues | "root", {
					message: zodIssueMessage(issue, t),
				});
			}
			return;
		}
		create.mutate(parsed.data);
	});

	const mutationError = remove.error;

	return (
		<div>
			<div className="flex items-start justify-between gap-4">
				<div className="flex items-center gap-2">
					<h2 className="font-medium text-sm text-zinc-200">
						{t("settings.staticIps")}
					</h2>
					<HelpOverlay labelFor={t("settings.staticIps")}>
						{t("settingsX.staticIpIntro")}
						<p className="mt-2">
							{t("settingsForms.eachIpServesOneEncodingAtA")}
						</p>
					</HelpOverlay>
				</div>
				<RoleAccess control="settings.infrastructure.static-ips">
					<Button onClick={() => setCreateOpen(true)}>
						<Plus aria-hidden className="h-4 w-4" />{" "}
						{t("settings.requestStaticIp")}
					</Button>
				</RoleAccess>
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
						aria-label={t("settings.loadingStaticIps")}
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
						{t("settings.failedToLoadStaticIps")}
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
						{list.items.map((ip) => (
							<li key={ip.id} className="flex items-center gap-4 px-4 py-3">
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="font-medium font-mono text-sm text-zinc-100">
											{ip.ipAddress ?? "(allocating…)"}
										</span>
										{ip.status ? (
											<Badge tone={STATUS_TONE[ip.status]}>{ip.status}</Badge>
										) : null}
									</div>
									<p className="mt-0.5 truncate text-xs text-zinc-500">
										{ip.region}
										{ip.infrastructureId
											? t("settingsX.awsInfrastructureSuffix", {
													id: ip.infrastructureId,
												})
											: t("settingsX.managedCloudSuffix")}
									</p>
								</div>
								<RoleAccess control="settings.infrastructure.static-ips">
									<Button
										variant="destructive"
										size="sm"
										disabled={remove.isPending}
										onClick={() => {
											if (
												window.confirm(
													t("settingsX.releaseStaticIp", {
														name: ip.ipAddress ?? ip.id,
													}) +
														(ip.status === "USED"
															? t("settingsX.releaseStaticIpUsedTail")
															: ""),
												)
											) {
												remove.mutate(ip.id);
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
					<div
						role="status"
						className="rounded-lg border border-zinc-800 border-dashed bg-zinc-900/40 p-10 text-center"
					>
						<h3 className="font-medium text-sm text-zinc-200">
							{t("settings.noStaticIpsYet")}
						</h3>
					</div>
				)}
				{!list.isLoading && !list.isError && list.items.length > 0 ? (
					<div className="mt-2 flex items-center justify-between gap-4">
						<p className="text-xs text-zinc-500">
							{t("settingsX.showingStaticIps", {
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

			<RoleAccess control="settings.infrastructure.static-ips">
				<Dialog
					open={createOpen}
					onOpenChange={(open) => {
						if (!open && !create.isPending) {
							setCreateOpen(false);
							create.reset();
							reset();
						}
					}}
					title={t("settings.requestStaticIp")}
					description={t(
						"settings.bitmovinAllocatesTheAddressAsynchronouslyIt",
					)}
				>
					{create.isError ? (
						<p role="alert" className="mb-3 text-red-400 text-sm">
							{create.error instanceof ApiError
								? create.error.message
								: t("settings.requestFailed")}
						</p>
					) : null}
					<form onSubmit={submit} className="space-y-4" noValidate>
						{formState.errors.root?.message ? (
							<p role="alert" className="text-red-400 text-xs">
								{formState.errors.root.message}
							</p>
						) : null}
						<Field
							label={t("settingsForms.region")}
							htmlFor="sip-region"
							error={formState.errors.region?.message}
						>
							<SelectNative id="sip-region" {...register("region")}>
								{CLOUD_REGIONS.map((region) => (
									<option key={region} value={region}>
										{region}
									</option>
								))}
							</SelectNative>
						</Field>
						<Field
							label={t("settingsForms.awsInfrastructureIdOptional")}
							htmlFor="sip-infra"
							error={formState.errors.infrastructureId?.message}
							help={t(
								"settingsForms.onlyForAwsCloudConnectInfrastructuresLeave",
							)}
						>
							<Input
								id="sip-infra"
								autoComplete="off"
								{...register("infrastructureId")}
							/>
						</Field>
						<div className="flex justify-end pt-2">
							<Button type="submit" disabled={create.isPending}>
								{create.isPending
									? t("settings.requesting")
									: t("settings.requestIp")}
							</Button>
						</div>
					</form>
				</Dialog>
			</RoleAccess>
		</div>
	);
}
