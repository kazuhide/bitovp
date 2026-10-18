"use client";

import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { localizedCustomerError } from "@/lib/customer-error";
import { useT } from "@/lib/i18n/context";
import {
	RESET_DELETE_CATEGORY_MESSAGE_KEYS,
	RESET_LIVE_STATUS_MESSAGE_KEYS,
	RESET_RESOURCE_TYPE_MESSAGE_KEYS,
	RESET_VOD_STATUS_MESSAGE_KEYS,
	type ResetProviderResource,
	resetPostResponseSchema,
	resetPreviewResponseSchema,
	resetRequestSchema,
} from "@/lib/reset-customer-contract";
import {
	DEFAULT_RESET_CATEGORIES,
	RESET_CATEGORIES,
	type ResetCategory,
	requiredResetCategories,
} from "@/lib/reset-selection";

export function ResetClient() {
	const { t } = useT();
	const queryClient = useQueryClient();
	const [confirm, setConfirm] = useState("");
	const [categories, setCategories] = useState<ResetCategory[]>(
		DEFAULT_RESET_CATEGORIES,
	);
	const [selectionNotice, setSelectionNotice] = useState("");
	const preview = useQuery({
		queryKey: ["admin-reset-preview", categories],
		placeholderData: keepPreviousData,
		refetchOnMount: "always",
		queryFn: async () =>
			resetPreviewResponseSchema.parse(
				await apiFetch<unknown>(
					`/api/admin/reset?categories=${encodeURIComponent(categories.join(","))}`,
				),
			),
	});
	const reset = useMutation({
		mutationFn: async () => {
			const response = await apiFetch<unknown>("/api/admin/reset", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(resetRequestSchema.parse({ confirm, categories })),
			});
			const parsed = resetPostResponseSchema.safeParse(response);
			return parsed.success
				? parsed.data
				: resetPostResponseSchema.parse({ reportStatus: "unconfirmed" });
		},
		onSuccess: () => {
			setConfirm("");
			preview.refetch();
			// , owner report: the reset emptied the database and the
			// dashboard kept drawing the deleted world, so it read as "the
			// reset did nothing". The charts are the slowest surface — 5-minute
			// refetchInterval AND staleTime, with refetchOnWindowFocus off
			// globally — so the stale window is up to five minutes on the one
			// screen an operator checks first.
			//
			// Invalidating EVERYTHING is the honest scope, not a list of keys:
			// this operation deleted every operational row, so every cached
			// query in the app is stale by construction. A curated list would
			// need updating with each new screen and would be wrong the moment
			// someone forgot — the same named-slot drift this feature has been
			// finding all day.
			queryClient.invalidateQueries();
		},
	});
	const changeSelection = (next: ResetCategory[], notice = "") => {
		setCategories(
			RESET_CATEGORIES.filter((category) => next.includes(category)),
		);
		setConfirm("");
		setSelectionNotice(notice);
	};
	const toggleCategory = (category: ResetCategory, checked: boolean) => {
		if (checked) {
			const next = requiredResetCategories([...categories, category]);
			const added = next.filter(
				(item) => item !== category && !categories.includes(item),
			);
			changeSelection(
				next,
				added.length
					? t("settingsX.resetDependenciesAdded", {
							categories: added
								.map((item) => t(RESET_DELETE_CATEGORY_MESSAGE_KEYS[item]))
								.join(", "),
						})
					: "",
			);
		} else {
			const removed = categories.filter((item) =>
				requiredResetCategories([item]).includes(category),
			);
			changeSelection(
				categories.filter((item) => !removed.includes(item)),
				removed.length > 1
					? t("settingsX.resetDependenciesRemoved", {
							categories: removed
								.filter((item) => item !== category)
								.map((item) => t(RESET_DELETE_CATEGORY_MESSAGE_KEYS[item]))
								.join(", "),
						})
					: "",
			);
		}
	};

	const data = preview.data;
	const providerResourceText = (row: ResetProviderResource) => {
		const status =
			row.resourceType === "vodJob"
				? t(RESET_VOD_STATUS_MESSAGE_KEYS[row.status])
				: t(RESET_LIVE_STATUS_MESSAGE_KEYS[row.status]);
		return `${t(RESET_RESOURCE_TYPE_MESSAGE_KEYS[row.resourceType])}: ${row.name ?? row.bitmovinEncodingId} (${status}) — ${row.bitmovinEncodingId}`;
	};
	const categoryCounts = new Map(
		data?.deleteCounts.map((item) => [item.category, item.count]),
	);
	const totalRows = categories.reduce(
		(sum, category) => sum + (categoryCounts.get(category) ?? 0),
		0,
	);

	return (
		<section>
			<h1 className="font-semibold text-xl text-zinc-50">
				{t("settingsX.reset")}
			</h1>
			<p className="mt-1 text-sm text-zinc-400">
				{t("settingsX.resetCaption")}
			</p>
			<p className="mt-2 text-sm text-zinc-400">
				{t("settingsX.resetOrganizationOnly")}
			</p>

			{preview.isPending ? (
				<p className="mt-6 text-sm text-zinc-500">{t("common.loading")}</p>
			) : preview.error || !data ? (
				<p role="alert" className="mt-6 text-amber-400 text-sm">
					{t("settingsX.resetLoadFailed")}{" "}
					<Button
						variant="secondary"
						size="sm"
						disabled={preview.isFetching}
						onClick={() => preview.refetch()}
					>
						{t("settingsForms.retry")}
					</Button>
				</p>
			) : (
				<div className="mt-6 space-y-4">
					<div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
						<h2 className="font-medium text-sm text-zinc-100">
							{t("settingsX.resetDeletes", { count: totalRows })}
						</h2>
						<div className="mt-3 flex gap-2">
							<Button
								variant="secondary"
								size="sm"
								disabled={reset.isPending}
								onClick={() => changeSelection([...RESET_CATEGORIES])}
							>
								{t("settingsX.resetSelectAll")}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								disabled={reset.isPending}
								onClick={() => changeSelection([])}
							>
								{t("settingsX.resetSelectNone")}
							</Button>
						</div>
						<div
							className="mt-3 grid gap-2 text-sm text-zinc-300 sm:grid-cols-2"
							aria-busy={preview.isFetching}
						>
							{RESET_CATEGORIES.map((category) => (
								<label
									key={category}
									className="flex items-start gap-2 rounded border border-zinc-800 p-2"
								>
									<input
										type="checkbox"
										className="mt-1 accent-emerald-600"
										aria-label={t(RESET_DELETE_CATEGORY_MESSAGE_KEYS[category])}
										checked={categories.includes(category)}
										disabled={reset.isPending}
										onChange={(event) =>
											toggleCategory(category, event.target.checked)
										}
									/>
									<span className="flex-1">
										{t(RESET_DELETE_CATEGORY_MESSAGE_KEYS[category])}
									</span>
									<span className="tabular-nums text-zinc-500">
										{categoryCounts.get(category) ?? 0}
									</span>
								</label>
							))}
						</div>
						{selectionNotice ? (
							<p role="status" className="mt-3 text-amber-300 text-xs">
								{selectionNotice}
							</p>
						) : null}
						<p className="mt-3 text-xs text-zinc-400">
							{t("settingsX.resetSelectionKept")}
						</p>
						{categories.includes("auditHistory") ? (
							<p className="mt-1 text-xs text-zinc-400">
								{t("settingsX.resetAuditReceiptNote")}
							</p>
						) : null}
						{/* review-2 C1: the loudest line on the screen, because it
						    is the one that would otherwise spend money. */}
						{data.watchFoldersToDisable > 0 ? (
							<p className="mt-2 font-medium text-amber-300 text-xs">
								{t("settingsX.resetDisarmNote", {
									count: data.watchFoldersToDisable,
								})}
							</p>
						) : null}
					</div>

					<div className="rounded-lg border border-red-900 bg-red-950/20 p-4">
						<label
							htmlFor="reset-confirm"
							className="block font-medium text-red-300 text-xs"
						>
							{t("settingsX.resetConfirmLabel", {
								word: data.confirmation,
							})}
						</label>
						<div className="mt-2 flex items-center gap-3">
							<Input
								id="reset-confirm"
								className="w-40"
								value={confirm}
								onChange={(e) => setConfirm(e.target.value)}
								placeholder={data.confirmation}
							/>
							<Button
								variant="destructive"
								size="sm"
								disabled={
									confirm !== data.confirmation ||
									reset.isPending ||
									categories.length === 0 ||
									preview.isFetching ||
									(reset.isSuccess && reset.data.reportStatus === "unconfirmed")
								}
								onClick={() => reset.mutate()}
							>
								{reset.isPending
									? t("common.saving")
									: t("settingsX.resetAction")}
							</Button>
						</div>
					</div>

					{reset.isSuccess && reset.data.reportStatus === "unconfirmed" ? (
						<p role="alert" className="text-amber-300 text-xs">
							{t("settingsX.resetResultReportUnconfirmed")}
						</p>
					) : null}
					{reset.isSuccess && reset.data.reportStatus === "available" ? (
						<div className="space-y-2 text-xs">
							<p className="text-emerald-400">{t("settingsX.resetDone")}</p>
							{reset.data.deletedCounts ? (
								<div>
									<h2 className="font-medium">
										{t("settingsX.resetDeletedCounts")}
									</h2>
									<ul className="mt-1 space-y-1">
										{reset.data.deletedCounts.map(({ category, count }) => (
											<li key={category}>
												{t(RESET_DELETE_CATEGORY_MESSAGE_KEYS[category])}:{" "}
												{count}
											</li>
										))}
									</ul>
								</div>
							) : null}
							{/* A failed or unconfirmed audit means THIS response is the
							    only customer-readable copy of the provider pointers. */}
							{reset.data.auditRecorded !== true ? (
								<p className="text-amber-300">
									{reset.data.auditRecorded === "unknown"
										? t("settingsX.resetAuditUnknown")
										: t("settingsX.resetAuditMissing")}
								</p>
							) : null}
							{reset.data.disabledWatchFolders.length > 0 ? (
								<p className="text-amber-300">
									{t("settingsX.resetDisarmedList", {
										rules: reset.data.disabledWatchFolders
											.map((row) => row.name)
											.join(", "),
									})}
								</p>
							) : null}
							{reset.data.auditRecorded === true &&
							reset.data.providerResources.total > 0 &&
							!reset.data.providerResources.truncated ? (
								<p className="text-zinc-400">
									{t("settingsX.resetEncodersRecorded", {
										count: reset.data.providerResources.total,
									})}
								</p>
							) : null}
							{reset.data.auditRecorded === true &&
							reset.data.providerResources.truncated ? (
								<p role="alert" className="text-amber-300">
									{t("settingsX.resetEncodersRecordedTruncated", {
										shown: reset.data.providerResources.pointers.length,
										total: reset.data.providerResources.total,
										omitted:
											reset.data.providerResources.total -
											reset.data.providerResources.pointers.length,
									})}
								</p>
							) : null}
							{reset.data.auditRecorded !== true &&
							reset.data.providerResources.total > 0 ? (
								<div
									role="alert"
									className="rounded-md border border-amber-900/70 bg-amber-950/20 p-3 text-amber-200"
								>
									<p className="font-medium">
										{t("settingsX.resetProviderPointersHeading")}
									</p>
									<ul className="mt-2 space-y-1">
										{reset.data.providerResources.pointers.map((row) => (
											<li key={`${row.resourceType}-${row.bitmovinEncodingId}`}>
												{providerResourceText(row)}
											</li>
										))}
									</ul>
									{reset.data.providerResources.truncated ||
									reset.data.providerResources.total >
										reset.data.providerResources.pointers.length ? (
										<p className="mt-2 text-amber-300">
											{t("settingsX.resetProviderPointersTruncated", {
												shown: reset.data.providerResources.pointers.length,
												total: reset.data.providerResources.total,
											})}
										</p>
									) : null}
								</div>
							) : null}
							{/* Cleanup uncertainty remains visible without exposing worker
							    queues or raw stream-key cleanup counters. */}
							{reset.data.queueCleanupIncomplete ? (
								<p role="alert" className="text-amber-400">
									{t("settingsX.resetQueuesUnreachable")}
								</p>
							) : null}
							{reset.data.temporaryStreamKeyCleanupUnconfirmed ? (
								<p role="alert" className="text-amber-400">
									{t("settingsX.resetTemporaryStreamKeysUnconfirmed")}
								</p>
							) : null}
						</div>
					) : null}
					{reset.isError ? (
						<p role="alert" className="text-red-400 text-xs">
							{localizedCustomerError(t, reset.error, "common.requestFailed")}
						</p>
					) : null}
				</div>
			)}
		</section>
	);
}
