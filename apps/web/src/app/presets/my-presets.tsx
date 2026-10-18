"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiError, apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";

type PlanPresetSummary = {
	id: string;
	name: string;
	description: string | null;
	/** Delivery-preset grouping ; null for plain plan presets. */
	category?: string | null;
	createdAt: string;
};

/**
 * Saved delivery presets (categorized FULL_PLAN rows). Here you Load one into the wizard
 * (`/vod/new?userPreset=<id>`, same import path as the samples) or Delete it.
 * Delete uses a two-click inline confirm (no blocking window.confirm).
 */
export function MyPresets() {
	const { t } = useT();
	const canOperate = useMutationAccess("presets.user");
	const queryClient = useQueryClient();
	const [confirmId, setConfirmId] = useState<string | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);

	const presets = useQuery({
		queryKey: ["plan-presets"],
		queryFn: () => apiFetch<PlanPresetSummary[]>("/api/presets"),
	});

	const del = useMutation({
		mutationFn: (id: string) =>
			apiFetch<void>(`/api/presets/${id}`, { method: "DELETE" }),
		onSuccess: () => {
			setConfirmId(null);
			setDeleteError(null);
			queryClient.invalidateQueries({ queryKey: ["plan-presets"] });
		},
		onError: (error) =>
			setDeleteError(
				error instanceof ApiError && error.status === 409
					? t("templates.deliveryDeleteBlockedByRules")
					: t("templates.deliveryDeleteFailed"),
			),
	});

	const items = (presets.data ?? []).filter((preset) =>
		Boolean(preset.category),
	);

	return (
		<section
			aria-label={t("templates.savedDeliveryHeading")}
			className="space-y-2"
		>
			<div className="flex items-baseline gap-2">
				<h2 className="font-medium text-sm text-zinc-200">
					{t("templates.savedDeliveryHeading")}
				</h2>
				{items.length > 0 ? (
					<Badge>{t("uiX.savedCount", { count: items.length })}</Badge>
				) : null}
			</div>
			{presets.isError && (
				<div
					role="alert"
					className="flex flex-wrap items-center gap-2 text-sm text-rose-400"
				>
					<span>{t("templates.loadDeliveryFailed")}</span>
					<Button
						size="sm"
						variant="secondary"
						disabled={presets.isFetching}
						onClick={() => void presets.refetch()}
					>
						{t("templates.retry")}
					</Button>
				</div>
			)}
			{presets.isPending ? (
				<p className="text-xs text-zinc-500">{t("ui.loadingYourPresets")}</p>
			) : items.length === 0 ? (
				!presets.isError && (
					<p className="text-sm text-zinc-500">
						{t("templates.emptyDelivery")}
					</p>
				)
			) : (
				<ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
					{items.map((p) => (
						<li
							key={p.id}
							className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-4"
						>
							<div className="flex items-start justify-between gap-2">
								<h3 className="font-medium text-sm text-zinc-100">{p.name}</h3>
								{p.category ? <Badge>{p.category}</Badge> : null}
							</div>
							{p.description ? (
								<p className="text-xs text-zinc-400">{p.description}</p>
							) : null}
							{canOperate ? (
								<div className="mt-auto flex items-center justify-between gap-2 pt-1">
									<Link
										href={`/vod/new?userPreset=${encodeURIComponent(p.id)}`}
										className="inline-flex h-8 shrink-0 items-center rounded-md bg-emerald-600 px-3 font-medium text-white text-xs transition-colors hover:bg-emerald-500 focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2"
									>
										{t("ui.loadInWizard")}
									</Link>
									{confirmId === p.id ? (
										<span className="flex items-center gap-1">
											<Button
												variant="destructive"
												size="sm"
												disabled={del.isPending}
												onClick={() => del.mutate(p.id)}
											>
												{del.isPending ? t("ui.deleting") : t("ui.confirm")}
											</Button>
											<Button
												variant="secondary"
												size="sm"
												onClick={() => {
													setConfirmId(null);
													setDeleteError(null);
												}}
											>
												{t("ui.cancel")}
											</Button>
										</span>
									) : (
										<Button
											variant="secondary"
											size="sm"
											onClick={() => {
												setConfirmId(p.id);
												setDeleteError(null);
											}}
										>
											{t("ui.delete")}
										</Button>
									)}
								</div>
							) : null}
						</li>
					))}
				</ul>
			)}
			{deleteError && (
				<p role="alert" className="text-rose-400 text-xs">
					{deleteError}
				</p>
			)}
		</section>
	);
}
