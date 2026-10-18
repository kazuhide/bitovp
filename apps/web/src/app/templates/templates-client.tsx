"use client";

import type { PlanPresetSummaryWire } from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { ApiError, apiFetch } from "@/lib/api";
import { RoleAccess, useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import { LaunchDialog } from "./launch-dialog";
import { LiveLaunchDialog } from "./live-launch-dialog";

/* List template name, description, revision, update time, and a derived usage count. Rows support launch, wizard editing, and confirmed deletion. Referencing watch rules block deletion through the restrictive foreign key. */
export function TemplatesClient() {
	const { t } = useT();
	const canOperate = useMutationAccess("templates.manage");
	const queryClient = useQueryClient();
	const [confirmId, setConfirmId] = useState<string | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [launching, setLaunching] = useState<{
		id: string;
		name: string;
		kind: "FULL_PLAN" | "LIVE_PLAN";
	} | null>(null);
	const [kindFilter, setKindFilter] = useState<
		"all" | "FULL_PLAN" | "LIVE_PLAN"
	>("all");

	const templates = useQuery({
		queryKey: ["plan-presets"],
		queryFn: () => apiFetch<PlanPresetSummaryWire[]>("/api/presets"),
	});
	// Two queries, not a kind=all param: the FULL_PLAN default is a
	// pre-#109-PR4 contract shared by the wizard panel and the watch-rule
	// picker — this page composes rather than widening it.
	const liveTemplates = useQuery({
		queryKey: ["live-presets"],
		queryFn: () =>
			apiFetch<PlanPresetSummaryWire[]>("/api/presets?kind=LIVE_PLAN"),
	});

	const del = useMutation({
		mutationFn: (id: string) =>
			apiFetch<void>(`/api/presets/${id}`, { method: "DELETE" }),
		onSuccess: () => {
			setConfirmId(null);
			setDeleteError(null);
			queryClient.invalidateQueries({ queryKey: ["plan-presets"] });
			queryClient.invalidateQueries({ queryKey: ["live-presets"] });
		},
		onError: (err) => {
			setDeleteError(
				err instanceof ApiError && err.status === 409
					? t("templates.deleteBlockedByRules")
					: t("templates.deleteFailed"),
			);
		},
	});

	const items = [
		// review-109pr1 P2: delivery presets  are FULL_PLAN rows
		// WITH a category: this is a delivery preset,
		// managed on /presets. Without this filter this page listed, edited
		// and even DELETED them as templates.
		...(templates.data ?? [])
			.filter((p) => !p.category)
			.map((p) => ({
				...p,
				kind: "FULL_PLAN" as const,
			})),
		...(liveTemplates.data ?? []).map((p) => ({
			...p,
			kind: "LIVE_PLAN" as const,
		})),
	]
		.filter((p) => kindFilter === "all" || p.kind === kindFilter)
		.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

	return (
		<div className="space-y-4">
			<div className="flex items-baseline gap-2">
				<div className="flex items-center gap-2">
					<h2 className="font-semibold text-lg text-zinc-100">
						{t("templates.heading")}
					</h2>
					<HelpOverlay labelFor={t("templates.heading")}>
						{t("templates.intro")}
					</HelpOverlay>
				</div>
				{items.length > 0 ? <Badge>{items.length}</Badge> : null}
			</div>

			<div className="flex gap-1">
				{(
					[
						["all", t("templates.filterAll")],
						["FULL_PLAN", t("templates.filterJobs")],
						["LIVE_PLAN", t("templates.filterChannels")],
					] as const
				).map(([value, label]) => (
					<button
						key={value}
						type="button"
						aria-pressed={kindFilter === value}
						onClick={() => setKindFilter(value)}
						className={`h-7 rounded-full border px-3 text-xs transition-colors ${
							kindFilter === value
								? "border-emerald-600 bg-emerald-600/15 text-emerald-300"
								: "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
						}`}
					>
						{label}
					</button>
				))}
			</div>
			{(
				[
					{ query: templates, message: "templates.loadVodFailed" },
					{ query: liveTemplates, message: "templates.loadLiveFailed" },
				] as const
			).map(
				({ query, message }) =>
					query.isError && (
						<div
							key={message}
							role="alert"
							className="flex flex-wrap items-center gap-2 text-sm text-rose-400"
						>
							<span>{t(message)}</span>
							<Button
								size="sm"
								variant="secondary"
								disabled={query.isFetching}
								onClick={() => void query.refetch()}
							>
								{t("templates.retry")}
							</Button>
						</div>
					),
			)}
			{(templates.isPending || liveTemplates.isPending) && (
				<p role="status" className="text-xs text-zinc-500">
					{t("templates.loading")}
				</p>
			)}
			{items.length === 0 ? (
				!templates.isPending &&
				!liveTemplates.isPending &&
				!templates.isError &&
				!liveTemplates.isError && (
					<div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6 text-sm text-zinc-400">
						<p>{t("templates.empty")}</p>
						<p className="mt-2 text-xs text-zinc-500">
							{t("templates.emptyHint")}
						</p>
					</div>
				)
			) : (
				<ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
					{items.map((p) => {
						const uses = p._count
							? p._count.encodingJobs +
								p._count.liveChannels +
								p._count.watchRules
							: 0;
						const blocked = (p._count?.watchRules ?? 0) > 0;
						return (
							<li
								key={p.id}
								className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-4"
							>
								<div className="flex items-start justify-between gap-2">
									<div className="flex items-center gap-2">
										<h3 className="font-medium text-sm text-zinc-100">
											{p.name}
										</h3>
										<Badge>
											{p.kind === "LIVE_PLAN"
												? t("templates.kindChannel")
												: t("templates.kindJob")}
										</Badge>
									</div>
									<span className="shrink-0 text-xs text-zinc-500">
										{t("templates.revision", { n: p.revision })}
									</span>
								</div>
								{p.description ? (
									<p className="text-xs text-zinc-400">{p.description}</p>
								) : null}
								<p className="text-xs text-zinc-500">
									{t("templates.usesAndUpdated", {
										uses,
										date: p.updatedAt.slice(0, 10),
									})}
								</p>
								{canOperate ? (
									<div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
										<Button
											size="sm"
											onClick={() =>
												setLaunching({ id: p.id, name: p.name, kind: p.kind })
											}
										>
											{t(
												p.kind === "LIVE_PLAN"
													? "templates.createLiveChannel"
													: "templates.createVodJob",
											)}
										</Button>
										{p.kind === "FULL_PLAN" ? (
											<Link
												href={`/vod/new?editPreset=${encodeURIComponent(p.id)}`}
												className="inline-flex h-8 items-center rounded-md border border-zinc-700 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-800"
											>
												{t("templates.edit")}
											</Link>
										) : null}
										{confirmId === p.id ? (
											<Button
												size="sm"
												variant="destructive"
												disabled={del.isPending}
												onClick={() => del.mutate(p.id)}
											>
												{t("templates.confirmDelete")}
											</Button>
										) : (
											<Button
												size="sm"
												variant="ghost"
												title={
													blocked
														? t("templates.deleteBlockedByRules")
														: undefined
												}
												onClick={() => {
													setDeleteError(null);
													setConfirmId(p.id);
												}}
											>
												{t("templates.delete")}
											</Button>
										)}
									</div>
								) : null}
							</li>
						);
					})}
				</ul>
			)}
			{deleteError ? (
				<p role="alert" className="text-rose-400 text-xs">
					{deleteError}
				</p>
			) : null}
			<RoleAccess control="templates.manage">
				<LaunchDialog
					presetId={launching?.kind === "FULL_PLAN" ? launching.id : null}
					onClose={() => setLaunching(null)}
				/>
			</RoleAccess>
			<RoleAccess control="templates.manage">
				<LiveLaunchDialog
					presetId={launching?.kind === "LIVE_PLAN" ? launching.id : null}
					onClose={() => setLaunching(null)}
				/>
			</RoleAccess>
		</div>
	);
}
